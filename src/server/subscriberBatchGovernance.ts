/**
 * Subscriber Batch Create Governance — Node Production Authority
 *
 * Shared executor for:
 *   - Node super_admin/root direct route
 *   - Node SUBSCRIBER_BATCH_CREATE Approval executor
 *
 * Invariant: DIRECT business algorithm == Approval business algorithm
 *
 * Uses create-only insertOne. Never replaceOne+upsert.
 */

import { createHash } from 'node:crypto';
import { stable } from '@/lib/subscriberContract';
import {
  generateImsiRange,
  findProfile,
  profileOcs,
  existingImsiSet,
  createSubscribersBatchCreateOnly,
  profileExecutionHash,
  assertTariffPlanAssignable,
} from '@/server/repositories/subscriberRepository';
import { provisionOcsSubscriber } from '@/server/repositories/ocsBillingRepository';

// ─── Types ───────────────────────────────────────────────────────────────────

export class SubscriberBatchGovernanceError extends Error {
  code: string;
  details?: Record<string, unknown>;
  constructor(code: string, details?: Record<string, unknown>) {
    super(code);
    this.code = code;
    this.details = details;
  }
}

export type EffectiveOcsConfig = {
  planId: string;
  trafficTotal: number;
  trafficAvailable: number;
  smsTotal: number;
  smsAvailable: number;
};

export type ProfileState = {
  requestedName: string;
  dataHash: string;
  ocsDefaults: Record<string, unknown> | null;
};

export type FrozenBatchCreateV2 = {
  version: 'subscriber-batch-create-v2';
  startImsi: string;
  count: number;
  expectedAbsentImsis: string[];
  effectiveOcs: EffectiveOcsConfig;
  profile: ProfileState;
  strategy: 'create-only';
  operationFingerprint: string;
};

export type BatchCreateExecutionResult = {
  requested: number;
  createdImsis: string[];
  failedImsis: string[];
  conflictImsis: string[];
  createdCount: number;
  failedCount: number;
  partialMutation: boolean;
  metrics: { totalTraffic: number; batchSize: number };
  operationFingerprint: string;
};

// ─── Constants ───────────────────────────────────────────────────────────────

const BATCH_DEFAULT_TRAFFIC_TOTAL = 5368709120; // 5 GiB
const BATCH_DEFAULT_SMS_TOTAL = 100;

// ─── OCS Resolution ──────────────────────────────────────────────────────────

function resolveEffectiveOcs(
  payload: {
    trafficTotal?: number;
    trafficBalance?: number;
    smsTotal?: number;
    smsBalance?: number;
    planId?: string;
  },
  profileData: { ocsDefaults?: Record<string, unknown>; ocs_defaults?: Record<string, unknown> } | null,
): EffectiveOcsConfig {
  const ocs = profileOcs(profileData);

  const trafficTotal = payload.trafficTotal ?? (ocs.trafficTotal as number) ?? (ocs.traffic_total as number)
    ?? payload.trafficBalance ?? (ocs.trafficBalance as number) ?? (ocs.traffic_balance as number)
    ?? BATCH_DEFAULT_TRAFFIC_TOTAL;
  const trafficBalance = payload.trafficBalance ?? (ocs.trafficBalance as number) ?? (ocs.traffic_balance as number)
    ?? trafficTotal;
  const smsTotal = payload.smsTotal ?? (ocs.smsTotal as number) ?? (ocs.sms_total as number)
    ?? payload.smsBalance ?? (ocs.smsBalance as number) ?? (ocs.sms_balance as number)
    ?? BATCH_DEFAULT_SMS_TOTAL;
  const smsBalance = payload.smsBalance ?? (ocs.smsBalance as number) ?? (ocs.sms_balance as number)
    ?? smsTotal;
  const planId = payload.planId ?? (ocs.planId as string) ?? (ocs.plan_id as string) ?? '';

  return { planId, trafficTotal, trafficAvailable: trafficBalance, smsTotal, smsAvailable: smsBalance };
}

// ─── Fingerprint ─────────────────────────────────────────────────────────────

function computeBatchFingerprint(
  startImsi: string,
  count: number,
  effectiveOcs: EffectiveOcsConfig,
  profileState: ProfileState,
): string {
  const targets = Array.from({ length: count }, (_, i) => (BigInt(startImsi) + BigInt(i)).toString());
  const canonical = stable({
    operation: 'SUBSCRIBER_BATCH_CREATE',
    targets,
    effectiveOcs: {
      planId: effectiveOcs.planId,
      trafficTotal: effectiveOcs.trafficTotal,
      smsTotal: effectiveOcs.smsTotal,
    },
    profilePrecondition: profileState.dataHash,
    strategy: 'create-only',
  });
  return createHash('sha256').update(canonical).digest('hex');
}

// ─── Prepare ─────────────────────────────────────────────────────────────────

export async function prepareFrozenBatchCreateV2(payload: {
  startImsi: string;
  count: number;
  trafficTotal?: number;
  trafficBalance?: number;
  smsTotal?: number;
  smsBalance?: number;
  profileName?: string;
  planId?: string;
}): Promise<FrozenBatchCreateV2> {
  // Validate IMSI range
  const imsis = generateImsiRange(payload.startImsi, payload.count);
  const invalid = imsis.find((imsi) => !/^\d{15}$/.test(imsi));
  if (invalid) throw new SubscriberBatchGovernanceError('IMSI_RANGE_OVERFLOW');

  // Load profile
  const profileData = await findProfile(payload.profileName);

  // Resolve OCS
  const effectiveOcs = resolveEffectiveOcs(payload, profileData);
  await assertTariffPlanAssignable(effectiveOcs.planId);

  // Build profile state
  const profile: ProfileState = {
    requestedName: payload.profileName || '',
    dataHash: profileExecutionHash(profileData),
    ocsDefaults: profileData ? (profileData.ocsDefaults || profileData.ocs_defaults || null) : null,
  };

  // Build expected absent IMSIs
  const expectedAbsentImsis = imsis;

  // Compute fingerprint
  const operationFingerprint = computeBatchFingerprint(payload.startImsi, payload.count, effectiveOcs, profile);

  return {
    version: 'subscriber-batch-create-v2',
    startImsi: payload.startImsi,
    count: payload.count,
    expectedAbsentImsis,
    effectiveOcs,
    profile,
    strategy: 'create-only',
    operationFingerprint,
  };
}

// ─── Assertions ──────────────────────────────────────────────────────────────

function assertFrozenV2(frozen: FrozenBatchCreateV2): void {
  if (!frozen || frozen.version !== 'subscriber-batch-create-v2') {
    throw new SubscriberBatchGovernanceError('INVALID_SUBSCRIBER_BATCH_CREATE_PAYLOAD');
  }
  if (typeof frozen.startImsi !== 'string' || !/^\d{15}$/.test(frozen.startImsi)) {
    throw new SubscriberBatchGovernanceError('INVALID_SUBSCRIBER_BATCH_CREATE_PAYLOAD');
  }
  if (typeof frozen.count !== 'number' || frozen.count < 1 || frozen.count > 1000) {
    throw new SubscriberBatchGovernanceError('INVALID_SUBSCRIBER_BATCH_CREATE_PAYLOAD');
  }
  if (!Array.isArray(frozen.expectedAbsentImsis) || frozen.expectedAbsentImsis.length !== frozen.count) {
    throw new SubscriberBatchGovernanceError('INVALID_SUBSCRIBER_BATCH_CREATE_PAYLOAD');
  }
  if (!frozen.effectiveOcs || typeof frozen.effectiveOcs.planId !== 'string') {
    throw new SubscriberBatchGovernanceError('INVALID_SUBSCRIBER_BATCH_CREATE_PAYLOAD');
  }
  if (!frozen.profile || typeof frozen.profile.dataHash !== 'string') {
    throw new SubscriberBatchGovernanceError('INVALID_SUBSCRIBER_BATCH_CREATE_PAYLOAD');
  }
  if (typeof frozen.operationFingerprint !== 'string' || frozen.operationFingerprint.length === 0) {
    throw new SubscriberBatchGovernanceError('INVALID_SUBSCRIBER_BATCH_CREATE_PAYLOAD');
  }
  // Re-verify fingerprint integrity
  const expectedFp = computeBatchFingerprint(frozen.startImsi, frozen.count, frozen.effectiveOcs, frozen.profile);
  if (expectedFp !== frozen.operationFingerprint) {
    throw new SubscriberBatchGovernanceError('INVALID_SUBSCRIBER_BATCH_CREATE_PAYLOAD');
  }
}

async function assertProfilePrecondition(frozen: FrozenBatchCreateV2): Promise<void> {
  if (!frozen.profile.requestedName) {
    // No profile requested — profile must still be absent
    const current = await findProfile(frozen.profile.requestedName || undefined);
    if (current) {
      throw new SubscriberBatchGovernanceError('SUBSCRIBER_BATCH_PROFILE_PRECONDITION_CHANGED');
    }
    return;
  }

  const current = await findProfile(frozen.profile.requestedName);
  if (!current) {
    throw new SubscriberBatchGovernanceError('SUBSCRIBER_BATCH_PROFILE_PRECONDITION_CHANGED');
  }

  const currentHash = profileExecutionHash(current);
  if (currentHash !== frozen.profile.dataHash) {
    throw new SubscriberBatchGovernanceError('SUBSCRIBER_BATCH_PROFILE_PRECONDITION_CHANGED');
  }
}

async function assertExpectedAbsence(frozen: FrozenBatchCreateV2): Promise<void> {
  const existing = await existingImsiSet(frozen.expectedAbsentImsis);
  if (existing.size > 0) {
    const conflictImsis = [...existing].slice(0, 20);
    throw new SubscriberBatchGovernanceError('SUBSCRIBER_CREATE_PRECONDITION_CHANGED', {
      conflictCount: existing.size,
      conflictImsis,
    });
  }
}

// ─── Execute ─────────────────────────────────────────────────────────────────

/**
 * Reusable business executor for batch create.
 * Used by both direct route and approval executor.
 *
 * Steps:
 *   1. Assert frozen payload integrity
 *   2. Profile precondition check
 *   3. Expected-absence precheck
 *   4. Load profile for document building
 *   5. Create-only inserts (insertOne per target)
 *   6. OCS provisioning
 *   7. Classify result
 */
export async function executeFrozenBatchCreate(
  frozen: FrozenBatchCreateV2,
): Promise<BatchCreateExecutionResult> {
  // 1. Assert frozen payload integrity
  assertFrozenV2(frozen);

  // 2. Profile precondition check
  await assertProfilePrecondition(frozen);

  // 3. Expected-absence precheck
  await assertExpectedAbsence(frozen);

  // 4. Load profile for document building
  const profileData = await findProfile(frozen.profile.requestedName || undefined);

  // 5. Create-only inserts
  const { createdImsis, failedImsis, conflictImsis } = await createSubscribersBatchCreateOnly({
    imsis: frozen.expectedAbsentImsis,
    profileData,
  });

  // 6. OCS provisioning
  const ocsProvisioned: string[] = [];
  const ocsFailed: string[] = [];
  for (const imsi of createdImsis) {
    try {
      await provisionOcsSubscriber({
        imsi,
        planId: frozen.effectiveOcs.planId,
        total: frozen.effectiveOcs.trafficTotal,
        available: frozen.effectiveOcs.trafficAvailable,
        smsTotal: frozen.effectiveOcs.smsTotal,
        smsAvailable: frozen.effectiveOcs.smsAvailable,
      });
      ocsProvisioned.push(imsi);
    } catch {
      ocsFailed.push(imsi);
    }
  }

  // 7. Classify result
  const allFailed = [...failedImsis, ...conflictImsis, ...ocsFailed];
  const partialMutation = createdImsis.length > 0 && allFailed.length > 0;

  return {
    requested: frozen.count,
    createdImsis,
    failedImsis: allFailed,
    conflictImsis,
    createdCount: createdImsis.length,
    failedCount: allFailed.length,
    partialMutation,
    metrics: {
      totalTraffic: frozen.effectiveOcs.trafficTotal * createdImsis.length,
      batchSize: createdImsis.length,
    },
    operationFingerprint: frozen.operationFingerprint,
  };
}

// ─── v1 Compatibility ────────────────────────────────────────────────────────

/**
 * Translate v1 approval payload to v2 execution intent.
 * v1 documents must still execute through create-only path.
 */
export function translateV1ToFrozenV2(v1Payload: Record<string, unknown>): FrozenBatchCreateV2 {
  const startImsi = String(v1Payload.startImsi || '');
  const count = Number(v1Payload.count || 0);
  const expectedAbsentImsis = Array.isArray(v1Payload.expectedAbsentImsis)
    ? v1Payload.expectedAbsentImsis.map(String)
    : generateImsiRange(startImsi, count);

  const effectiveOcs: EffectiveOcsConfig = {
    planId: String(v1Payload.planId || ''),
    trafficTotal: Number(v1Payload.trafficTotal ?? BATCH_DEFAULT_TRAFFIC_TOTAL),
    trafficAvailable: Number(v1Payload.trafficBalance ?? v1Payload.trafficTotal ?? BATCH_DEFAULT_TRAFFIC_TOTAL),
    smsTotal: Number(v1Payload.smsTotal ?? BATCH_DEFAULT_SMS_TOTAL),
    smsAvailable: Number(v1Payload.smsBalance ?? v1Payload.smsTotal ?? BATCH_DEFAULT_SMS_TOTAL),
  };

  const profile: ProfileState = {
    requestedName: String(v1Payload.profileName || ''),
    dataHash: '', // v1 has no hash; profile check will load fresh
    ocsDefaults: null,
  };

  const operationFingerprint = computeBatchFingerprint(startImsi, count, effectiveOcs, profile);

  return {
    version: 'subscriber-batch-create-v2',
    startImsi,
    count,
    expectedAbsentImsis,
    effectiveOcs,
    profile,
    strategy: 'create-only',
    operationFingerprint,
  };
}
