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
  trafficBalance: number;
  smsTotal: number;
  smsBalance: number;
};

export type ProfileState = {
  requestedName: string;
  state: 'present' | 'absent';
  preconditionHash: string;
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
  subscriberFailedImsis: string[];
  conflictImsis: string[];
  ocsProvisionedImsis: string[];
  ocsFailedImsis: string[];
  failedImsis: string[]; // flattened: subscriberFailed + conflict + ocsFailed
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

  return { planId, trafficTotal, trafficBalance, smsTotal, smsBalance };
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
      trafficBalance: effectiveOcs.trafficBalance,
      smsTotal: effectiveOcs.smsTotal,
      smsBalance: effectiveOcs.smsBalance,
    },
    profile: {
      requestedName: profileState.requestedName,
      state: profileState.state,
      preconditionHash: profileState.preconditionHash,
    },
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
    state: profileData ? 'present' : 'absent',
    preconditionHash: profileExecutionHash(profileData),
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
  if (!frozen.profile || typeof frozen.profile.preconditionHash !== 'string') {
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
  // v1 compatibility: preconditionHash is empty — skip hash comparison
  // v1 does NOT provide profile immutability guarantee.
  // The current profile is loaded at execution time and used as-is.
  if (frozen.profile.preconditionHash === '') {
    return;
  }

  if (frozen.profile.state === 'absent') {
    // Profile was absent at freeze time — must still be absent
    const current = await findProfile(frozen.profile.requestedName || undefined);
    if (current) {
      throw new SubscriberBatchGovernanceError('SUBSCRIBER_BATCH_PROFILE_PRECONDITION_CHANGED');
    }
    return;
  }

  // Profile was present at freeze time — must still match
  const current = await findProfile(frozen.profile.requestedName);
  if (!current) {
    throw new SubscriberBatchGovernanceError('SUBSCRIBER_BATCH_PROFILE_PRECONDITION_CHANGED');
  }

  const currentHash = profileExecutionHash(current);
  if (currentHash !== frozen.profile.preconditionHash) {
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

// ─── Result Classification ───────────────────────────────────────────────────

export type BatchResultClassification = 'SUCCESS' | 'PARTIAL_WRITE' | 'FAILED_NO_MUTATION';

/**
 * Centralized result classification shared by direct route and approval executor.
 *
 * SUCCESS:            createdCount == requested, failedCount == 0
 * PARTIAL_WRITE:      createdCount > 0 && failedCount > 0
 * FAILED_NO_MUTATION: createdCount == 0 && failedCount > 0
 */
export function classifyBatchResult(createdCount: number, failedCount: number): BatchResultClassification {
  if (failedCount === 0) return 'SUCCESS';
  if (createdCount > 0) return 'PARTIAL_WRITE';
  return 'FAILED_NO_MUTATION';
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
        available: frozen.effectiveOcs.trafficBalance,
        smsTotal: frozen.effectiveOcs.smsTotal,
        smsAvailable: frozen.effectiveOcs.smsBalance,
      });
      ocsProvisioned.push(imsi);
    } catch {
      ocsFailed.push(imsi);
    }
  }

  // 7. Classify result
  const allFailed = [...failedImsis, ...conflictImsis, ...ocsFailed];
  const resultClassification = classifyBatchResult(createdImsis.length, allFailed.length);
  const partialMutation = resultClassification === 'PARTIAL_WRITE';

  return {
    requested: frozen.count,
    createdImsis,
    subscriberFailedImsis: failedImsis,
    conflictImsis,
    ocsProvisionedImsis: ocsProvisioned,
    ocsFailedImsis: ocsFailed,
    failedImsis: allFailed,
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
 *
 * IMPORTANT: v1 does NOT provide profile immutability guarantee.
 * Historical v1 approvals did not freeze profile content.
 * At execution time, the current profile is loaded and used.
 * The preconditionHash is empty because v1 never computed one.
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
    trafficBalance: Number(v1Payload.trafficBalance ?? v1Payload.trafficTotal ?? BATCH_DEFAULT_TRAFFIC_TOTAL),
    smsTotal: Number(v1Payload.smsTotal ?? BATCH_DEFAULT_SMS_TOTAL),
    smsBalance: Number(v1Payload.smsBalance ?? v1Payload.smsTotal ?? BATCH_DEFAULT_SMS_TOTAL),
  };

  const hasProfile = Boolean(v1Payload.profileName);
  const profile: ProfileState = {
    requestedName: String(v1Payload.profileName || ''),
    // v1 with profile: state='present', loads current profile at execution
    // v1 without profile: state='absent', uses defaults
    state: hasProfile ? 'present' : 'absent',
    // v1 never froze profile content — empty hash signals legacy-unfrozen mode
    preconditionHash: '',
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
