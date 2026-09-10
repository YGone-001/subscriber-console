import { buildXcloudSubscriberFromLegacy } from '@/lib/xcloudSubscriber';
import {
  stable,
  hash,
  subscriberSafeSnapshot,
  type SafeSnapshot,
} from '@/lib/subscriberContract';
import type { XcloudSubscriberDocument } from '@/types/xcloud';
import {
  deleteSubscriber,
  conditionalDeleteSubscriber,
  deleteSubscriberOcsProvisioning,
  findSubscriberDocument,
  updateSubscriberFromLegacy,
  insertSubscriberImportCreateOnly,
  provisionImportedSubscriberOcs,
  type LegacySubscriberUpdatePayload,
} from '@/server/repositories/subscriberRepository';

// Re-export for backward compatibility
// Never include security, K, OP/OPc, AMF or SQN in a governed snapshot.
export { subscriberSafeSnapshot };
export type { SafeSnapshot };

export class SubscriberGovernanceError extends Error {
  code: string;
  details?: Record<string, unknown>;
  constructor(code: string, details?: Record<string, unknown>) {
    super(code);
    this.code = code;
    this.details = details;
  }
}

export type FrozenSubscriberUpdate = {
  version: 'subscriber-update-v1';
  imsi: string;
  before: SafeSnapshot;
  after: SafeSnapshot;
  payload: LegacySubscriberUpdatePayload;
  operationFingerprint: string;
};

export type FrozenSubscriberDelete = {
  version: 'subscriber-delete-v1';
  imsi: string;
  before: SafeSnapshot;
  operationFingerprint: string;
};

export type FrozenSubscriberBulkDelete = {
  version: 'subscriber-bulk-delete-v1';
  targets: Array<{ imsi: string; before: SafeSnapshot }>;
  targetCount: number;
  operationFingerprint: string;
};

export type FrozenSubscriberBulkDeleteV2 = {
  version: 'subscriber-bulk-delete-v2';
  targets: Array<{ imsi: string; before: SafeSnapshot; preconditionHash: string }>;
  targetCount: number;
  snapshotBytes: number;
  strategy: 'delete-only';
  operationFingerprint: string;
};

// Constants matching Go implementation
const MAX_BULK_DELETE_TARGETS = 5000;
const MAX_BULK_DELETE_SNAPSHOT_BYTES = 512 * 1024;

function nonBlank(value: unknown) { return value !== undefined && value !== null && String(value).trim() !== ''; }

function assertNoAuthenticationMaterialChange(existing: XcloudSubscriberDocument, payload: LegacySubscriberUpdatePayload) {
  const auth = payload.auth4G && typeof payload.auth4G === 'object' ? payload.auth4G as Record<string, unknown> : null;
  if (!auth) return;
  const current = existing.security || {};
  const changed = ['k', 'op', 'opc', 'amf', 'sqn'].some((key) => nonBlank(auth[key]) && String(auth[key]) !== String(current[key as keyof typeof current] ?? ''));
  if (changed) throw new SubscriberGovernanceError('SENSITIVE_SUBSCRIBER_CHANGE_NOT_SUPPORTED');
}

function cleanPayload(payload: LegacySubscriberUpdatePayload): LegacySubscriberUpdatePayload {
  // The authenticated material is intentionally never stored in a CHG.  The
  // execution path rebuilds only the governed non-secret configuration.
  return { sub4G: payload.sub4G, ocsTraffic: payload.ocsTraffic };
}

export async function prepareFrozenSubscriberUpdate(imsi: string, payload: LegacySubscriberUpdatePayload): Promise<FrozenSubscriberUpdate> {
  const existing = await findSubscriberDocument(imsi);
  if (!existing) throw new SubscriberGovernanceError('SUBSCRIBER_NOT_FOUND');
  assertNoAuthenticationMaterialChange(existing, payload);
  const governedPayload = cleanPayload(payload);
  const next = buildXcloudSubscriberFromLegacy(imsi, governedPayload, existing);
  const before = subscriberSafeSnapshot(existing);
  const after = subscriberSafeSnapshot(next);
  if (stable(before) === stable(after)) throw new SubscriberGovernanceError('SUBSCRIBER_UPDATE_NO_EFFECT');
  return { version: 'subscriber-update-v1', imsi, before, after, payload: governedPayload, operationFingerprint: hash({ operation: 'SUBSCRIBER_UPDATE', imsi, before, after }) };
}

export async function executeFrozenSubscriberUpdate(payload: unknown) {
  const frozen = payload as FrozenSubscriberUpdate;
  if (!frozen || frozen.version !== 'subscriber-update-v1' || typeof frozen.imsi !== 'string' || !frozen.before || !frozen.payload) throw new SubscriberGovernanceError('INVALID_SUBSCRIBER_UPDATE_PAYLOAD');
  const current = await findSubscriberDocument(frozen.imsi);
  if (!current || stable(subscriberSafeSnapshot(current)) !== stable(frozen.before)) throw new SubscriberGovernanceError('SUBSCRIBER_UPDATE_PRECONDITION_CHANGED');
  try {
    const updated = await updateSubscriberFromLegacy(frozen.imsi, frozen.payload, current);
    return { imsi: frozen.imsi, before: frozen.before, after: subscriberSafeSnapshot(updated), operationFingerprint: frozen.operationFingerprint };
  } catch (error) {
    if (error instanceof Error && error.message === 'SUBSCRIBER_UPDATE_PRECONDITION_CHANGED') throw new SubscriberGovernanceError(error.message);
    throw error;
  }
}

export async function prepareFrozenSubscriberDelete(imsi: string): Promise<FrozenSubscriberDelete> {
  const existing = await findSubscriberDocument(imsi);
  if (!existing) throw new SubscriberGovernanceError('SUBSCRIBER_NOT_FOUND');
  const before = subscriberSafeSnapshot(existing);
  return { version: 'subscriber-delete-v1', imsi, before, operationFingerprint: hash({ operation: 'SUBSCRIBER_DELETE', imsi, before }) };
}

export async function executeFrozenSubscriberDelete(payload: unknown) {
  const frozen = payload as FrozenSubscriberDelete;
  if (!frozen || frozen.version !== 'subscriber-delete-v1' || typeof frozen.imsi !== 'string' || !frozen.before) throw new SubscriberGovernanceError('INVALID_SUBSCRIBER_DELETE_PAYLOAD');
  const current = await findSubscriberDocument(frozen.imsi);
  if (!current || stable(subscriberSafeSnapshot(current)) !== stable(frozen.before)) throw new SubscriberGovernanceError('SUBSCRIBER_DELETE_PRECONDITION_CHANGED');
  const deleted = await deleteSubscriber(frozen.imsi, current);
  if (!deleted) throw new SubscriberGovernanceError('SUBSCRIBER_DELETE_PRECONDITION_CHANGED');
  return { imsi: frozen.imsi, deleted: true, before: frozen.before, operationFingerprint: frozen.operationFingerprint };
}

export async function prepareFrozenSubscriberBulkDelete(imsis: string[]): Promise<FrozenSubscriberBulkDeleteV2> {
  // Section 7: Reject duplicate IMSIs
  const unique = [...new Set(imsis)].sort();
  if (unique.length !== imsis.length) {
    throw new SubscriberGovernanceError('INVALID_SUBSCRIBER_BULK_DELETE_PAYLOAD');
  }

  // Validate max targets
  if (unique.length > MAX_BULK_DELETE_TARGETS) {
    throw new SubscriberGovernanceError('INVALID_SUBSCRIBER_BULK_DELETE_PAYLOAD');
  }

  const targets = await Promise.all(unique.map(async (imsi) => {
    const existing = await findSubscriberDocument(imsi);
    if (!existing) throw new SubscriberGovernanceError('SUBSCRIBER_NOT_FOUND', { imsi });
    const before = subscriberSafeSnapshot(existing);
    const preconditionHash = hash(before);
    return { imsi, before, preconditionHash };
  }));

  // Compute operation fingerprint (matches Go computeBulkDeleteFingerprint)
  const fingerprint = hash({
    operation: 'SUBSCRIBER_BULK_DELETE',
    targets: targets.map(t => ({ imsi: t.imsi, preconditionHash: t.preconditionHash })),
    strategy: 'delete-only',
  });

  // Compute snapshot bytes (matches Go computeBulkDeleteSnapshotBytes)
  const snapshotBytes = stable({ targets, strategy: 'delete-only', operationFingerprint: fingerprint }).length;

  // Section 8: Enforce snapshot cap at prepare time
  if (snapshotBytes > MAX_BULK_DELETE_SNAPSHOT_BYTES) {
    throw new SubscriberGovernanceError('APPROVAL_SNAPSHOT_TOO_LARGE');
  }

  return {
    version: 'subscriber-bulk-delete-v2',
    targets,
    targetCount: targets.length,
    snapshotBytes,
    strategy: 'delete-only',
    operationFingerprint: fingerprint,
  };
}

// Section 27: assertFrozenBulkDeleteV2 validates a v2 payload (BSON-safe).
export function assertFrozenBulkDeleteV2(payload: unknown): FrozenSubscriberBulkDeleteV2 {
  const p = payload as Record<string, unknown>;
  if (!p || p.version !== 'subscriber-bulk-delete-v2' || !Array.isArray(p.targets) || p.targets.length === 0) {
    throw new SubscriberGovernanceError('INVALID_SUBSCRIBER_BULK_DELETE_PAYLOAD');
  }
  if (typeof p.targetCount !== 'number' || p.targetCount < 1 || p.targetCount > MAX_BULK_DELETE_TARGETS) {
    throw new SubscriberGovernanceError('INVALID_SUBSCRIBER_BULK_DELETE_PAYLOAD');
  }
  if (p.strategy !== 'delete-only') {
    throw new SubscriberGovernanceError('INVALID_SUBSCRIBER_BULK_DELETE_PAYLOAD');
  }
  if (p.targetCount !== (p.targets as unknown[]).length) {
    throw new SubscriberGovernanceError('INVALID_SUBSCRIBER_BULK_DELETE_PAYLOAD');
  }

  const targets = (p.targets as Array<Record<string, unknown>>).map((t) => {
    if (typeof t.imsi !== 'string' || t.imsi.length !== 15 || !/^\d{15}$/.test(t.imsi)) {
      throw new SubscriberGovernanceError('INVALID_SUBSCRIBER_BULK_DELETE_PAYLOAD');
    }
    if (!t.before || typeof t.before !== 'object') {
      throw new SubscriberGovernanceError('INVALID_SUBSCRIBER_BULK_DELETE_PAYLOAD');
    }
    // Verify no sensitive fields in before
    const before = t.before as Record<string, unknown>;
    const sensitiveFields = ['k', 'op', 'opc', 'amf', 'sqn', 'security'];
    for (const field of sensitiveFields) {
      if (field in before) {
        throw new SubscriberGovernanceError('INVALID_SUBSCRIBER_BULK_DELETE_PAYLOAD');
      }
    }
    // Verify preconditionHash
    const expectedHash = hash(before);
    if (t.preconditionHash !== expectedHash) {
      throw new SubscriberGovernanceError('INVALID_SUBSCRIBER_BULK_DELETE_PAYLOAD');
    }
    return { imsi: t.imsi, before: before as unknown as SafeSnapshot, preconditionHash: t.preconditionHash as string };
  });

  // Verify sorted ascending
  for (let i = 1; i < targets.length; i++) {
    if (targets[i].imsi <= targets[i - 1].imsi) {
      throw new SubscriberGovernanceError('INVALID_SUBSCRIBER_BULK_DELETE_PAYLOAD');
    }
  }

  // Verify operationFingerprint
  const expectedFingerprint = hash({
    operation: 'SUBSCRIBER_BULK_DELETE',
    targets: targets.map(t => ({ imsi: t.imsi, preconditionHash: t.preconditionHash })),
    strategy: 'delete-only',
  });
  if (p.operationFingerprint !== expectedFingerprint) {
    throw new SubscriberGovernanceError('INVALID_SUBSCRIBER_BULK_DELETE_PAYLOAD');
  }

  // Verify snapshotBytes
  const expectedSnapshotBytes = stable({ targets, strategy: 'delete-only', operationFingerprint: expectedFingerprint }).length;
  if (p.snapshotBytes !== expectedSnapshotBytes) {
    throw new SubscriberGovernanceError('INVALID_SUBSCRIBER_BULK_DELETE_PAYLOAD');
  }

  // Check snapshot size limit
  if (expectedSnapshotBytes > MAX_BULK_DELETE_SNAPSHOT_BYTES) {
    throw new SubscriberGovernanceError('APPROVAL_SNAPSHOT_TOO_LARGE');
  }

  return {
    version: 'subscriber-bulk-delete-v2',
    targets,
    targetCount: p.targetCount as number,
    snapshotBytes: p.snapshotBytes as number,
    strategy: 'delete-only',
    operationFingerprint: p.operationFingerprint as string,
  };
}

// Section 17: classifyBulkDeleteResult matches Go ClassifyBulkDeleteResult.
export function classifyBulkDeleteResult(deletedCount: number, requested: number, conflictCount: number, failedCount: number, ocsCleanupFailureCount: number): 'SUCCESS' | 'PARTIAL_WRITE' | 'FAILED_NO_MUTATION' {
  if (deletedCount === requested && conflictCount === 0 && failedCount === 0 && ocsCleanupFailureCount === 0) return 'SUCCESS';
  if (deletedCount > 0) return 'PARTIAL_WRITE';
  return 'FAILED_NO_MUTATION';
}

export async function executeFrozenSubscriberBulkDelete(payload: unknown) {
  // v1/v2 branching
  const p = payload as Record<string, unknown>;
  const version = p?.version;

  if (version === 'subscriber-bulk-delete-v2') {
    return executeFrozenSubscriberBulkDeleteV2(assertFrozenBulkDeleteV2(payload));
  }

  // v1 legacy path
  const frozen = payload as FrozenSubscriberBulkDelete;
  if (!frozen || frozen.version !== 'subscriber-bulk-delete-v1' || !Array.isArray(frozen.targets) || frozen.targets.length === 0) throw new SubscriberGovernanceError('INVALID_SUBSCRIBER_BULK_DELETE_PAYLOAD');
  const loaded = await Promise.all(frozen.targets.map(async (target) => ({ target, current: await findSubscriberDocument(target.imsi) })));
  if (loaded.some(({ target, current }) => !current || stable(subscriberSafeSnapshot(current)) !== stable(target.before))) {
    throw new SubscriberGovernanceError('SUBSCRIBER_DELETE_PRECONDITION_CHANGED');
  }
  let deleted = 0;
  for (const { target, current } of loaded) {
    const ok = await deleteSubscriber(target.imsi, current as XcloudSubscriberDocument);
    if (!ok) throw new SubscriberGovernanceError('SUBSCRIBER_BULK_DELETE_PARTIAL_WRITE', { deleted, expected: frozen.targetCount, partialMutation: deleted > 0 });
    deleted += 1;
  }
  return { requested: frozen.targetCount, deleted, targets: frozen.targets.map((target) => target.imsi), operationFingerprint: frozen.operationFingerprint };
}

// Section 14: v2 execution with OCS cleanup separation
export async function executeFrozenSubscriberBulkDeleteV2(frozen: FrozenSubscriberBulkDeleteV2) {
  const result = {
    requested: frozen.targetCount,
    deletedImsis: [] as string[],
    conflictImsis: [] as string[],
    failedImsis: [] as string[],
    ocsCleanedImsis: [] as string[],
    ocsCleanupFailedImsis: [] as string[],
    deletedCount: 0,
    partialMutation: false,
    mutationCommitted: false,
    operationFingerprint: frozen.operationFingerprint,
  };

  // Load all targets first (all-target precondition barrier)
  const loaded = await Promise.all(frozen.targets.map(async (target) => ({
    target,
    current: await findSubscriberDocument(target.imsi),
  })));

  // Check for conflicts before any deletion
  for (const { target, current } of loaded) {
    if (!current) {
      result.conflictImsis.push(target.imsi);
      continue;
    }
    const currentSnapshot = subscriberSafeSnapshot(current);
    const currentHash = hash(currentSnapshot);
    if (currentHash !== target.preconditionHash) {
      result.conflictImsis.push(target.imsi);
    }
  }

  // If any conflicts, fail before any deletion
  if (result.conflictImsis.length > 0) {
    throw new SubscriberGovernanceError('SUBSCRIBER_BULK_DELETE_PRECONDITION_CHANGED', {
      conflictImsis: result.conflictImsis,
      committed: false,
    });
  }

  // Execute per-target CAS deletion
  for (const { target, current } of loaded) {
    if (!current) {
      result.conflictImsis.push(target.imsi);
      const classification = classifyBulkDeleteResult(result.deletedCount, result.requested, result.conflictImsis.length, result.failedImsis.length, result.ocsCleanupFailedImsis.length);
      result.partialMutation = classification === 'PARTIAL_WRITE';
      result.mutationCommitted = result.deletedCount > 0;
      continue;
    }

    // Final CAS check
    const currentSnapshot = subscriberSafeSnapshot(current);
    const currentHash = hash(currentSnapshot);
    if (currentHash !== target.preconditionHash) {
      result.conflictImsis.push(target.imsi);
      const classification = classifyBulkDeleteResult(result.deletedCount, result.requested, result.conflictImsis.length, result.failedImsis.length, result.ocsCleanupFailedImsis.length);
      result.partialMutation = classification === 'PARTIAL_WRITE';
      result.mutationCommitted = result.deletedCount > 0;
      continue;
    }

    // CAS delete (subscriber only, no OCS cleanup)
    try {
      const ok = await conditionalDeleteSubscriber(target.imsi, current);
      if (!ok) {
        result.conflictImsis.push(target.imsi);
        const classification = classifyBulkDeleteResult(result.deletedCount, result.requested, result.conflictImsis.length, result.failedImsis.length, result.ocsCleanupFailedImsis.length);
        result.partialMutation = classification === 'PARTIAL_WRITE';
        result.mutationCommitted = result.deletedCount > 0;
        continue;
      }
    } catch {
      result.failedImsis.push(target.imsi);
      const classification = classifyBulkDeleteResult(result.deletedCount, result.requested, result.conflictImsis.length, result.failedImsis.length, result.ocsCleanupFailedImsis.length);
      result.partialMutation = classification === 'PARTIAL_WRITE';
      result.mutationCommitted = result.deletedCount > 0;
      continue;
    }

    // Subscriber deleted successfully
    result.deletedImsis.push(target.imsi);
    result.deletedCount++;
    result.mutationCommitted = true;

    // OCS cleanup - separate from subscriber deletion
    try {
      await deleteSubscriberOcsProvisioning(target.imsi);
      result.ocsCleanedImsis.push(target.imsi);
    } catch {
      result.ocsCleanupFailedImsis.push(target.imsi);
    }
  }

  // Final classification
  const classification = classifyBulkDeleteResult(result.deletedCount, result.requested, result.conflictImsis.length, result.failedImsis.length, result.ocsCleanupFailedImsis.length);
  result.partialMutation = classification === 'PARTIAL_WRITE';

  return result;
}

// --- Import v2 ---

export interface FrozenSubscriberImportV2 {
  version: string;
  records: Array<{
    imsi: string;
    access_restriction_data: number;
    traffic_total: number;
    traffic_balance: number;
    sms_total: number;
    sms_balance: number;
    plan_id: string;
  }>;
  targets: Array<{
    imsi: string;
    state: 'present' | 'absent';
    recordIntentHash: string;
  }>;
  targetCount: number;
  summary: {
    rowCount: number;
    createCount: number;
    skipCount: number;
    fieldNames: string[];
    fileHash: string;
  };
  strategy: string;
  snapshotBytes: number;
  operationFingerprint: string;
}

const SENSITIVE_IMPORT_KEYS = ['k', 'op', 'opc', 'amf', 'sqn'];
const MAX_IMPORT_ROWS = 5000;
const MAX_IMPORT_SNAPSHOT_BYTES = 512 * 1024;

export async function prepareFrozenSubscriberImport(records: Record<string, unknown>[]): Promise<FrozenSubscriberImportV2> {
  if (!Array.isArray(records) || records.length === 0 || records.length > MAX_IMPORT_ROWS) {
    throw new SubscriberGovernanceError('INVALID_SUBSCRIBER_IMPORT_REQUEST');
  }

  // Normalize records
  const normalized = records.map((rec) => ({
    imsi: String(rec.imsi || '').trim(),
    access_restriction_data: Number(rec.access_restriction_data ?? 32),
    traffic_total: Number(rec.traffic_total ?? 10737418240),
    traffic_balance: Number(rec.traffic_balance ?? 10737418240),
    sms_total: Number(rec.sms_total ?? 100),
    sms_balance: Number(rec.sms_balance ?? 100),
    plan_id: String(rec.plan_id || 'plan_default_10gb').trim() || 'plan_default_10gb',
  }));

  // Sort by IMSI
  normalized.sort((a, b) => a.imsi.localeCompare(b.imsi));

  // Load existence states
  const targets = await Promise.all(normalized.map(async (rec) => {
    const existing = await findSubscriberDocument(rec.imsi);
    const recordIntentHash = hash(rec);
    return {
      imsi: rec.imsi,
      state: existing ? 'present' as const : 'absent' as const,
      recordIntentHash,
    };
  }));

  const createCount = targets.filter((t) => t.state === 'absent').length;
  const skipCount = targets.filter((t) => t.state === 'present').length;

  // Compute field names
  const fieldNameSet = new Set<string>();
  for (const rec of records) {
    for (const key of Object.keys(rec)) {
      if (key !== 'imsi') fieldNameSet.add(key);
    }
  }
  const fieldNames = Array.from(fieldNameSet).sort();

  // Compute hashes
  const fileHash = hash(normalized);
  const fingerprintSource = {
    operation: 'SUBSCRIBER_IMPORT',
    targets,
    strategy: 'skip-existing-create-only',
    fileHash,
  };
  const operationFingerprint = hash(fingerprintSource);

  // Compute snapshotBytes
  const snapshotSource = {
    version: 'subscriber-import-v2',
    records: normalized,
    targets,
    targetCount: targets.length,
    summary: { rowCount: normalized.length, createCount, skipCount, fieldNames, fileHash },
    strategy: 'skip-existing-create-only',
    operationFingerprint,
  };
  const snapshotBytes = stable(snapshotSource).length;

  if (snapshotBytes > MAX_IMPORT_SNAPSHOT_BYTES) {
    throw new SubscriberGovernanceError('APPROVAL_SNAPSHOT_TOO_LARGE');
  }

  return {
    version: 'subscriber-import-v2',
    records: normalized,
    targets,
    targetCount: targets.length,
    summary: { rowCount: normalized.length, createCount, skipCount, fieldNames, fileHash },
    strategy: 'skip-existing-create-only',
    snapshotBytes,
    operationFingerprint,
  };
}

export function assertFrozenSubscriberImportV2(payload: unknown): FrozenSubscriberImportV2 {
  const p = payload as Record<string, unknown>;
  if (!p || p.version !== 'subscriber-import-v2' || !Array.isArray(p.records) || !Array.isArray(p.targets)) {
    throw new SubscriberGovernanceError('INVALID_SUBSCRIBER_IMPORT_PAYLOAD');
  }
  if (p.records.length === 0 || p.targets.length === 0 || p.records.length !== p.targets.length) {
    throw new SubscriberGovernanceError('INVALID_SUBSCRIBER_IMPORT_PAYLOAD');
  }
  if (typeof p.targetCount !== 'number' || p.targetCount !== p.targets.length) {
    throw new SubscriberGovernanceError('INVALID_SUBSCRIBER_IMPORT_PAYLOAD');
  }
  if (p.strategy !== 'skip-existing-create-only') {
    throw new SubscriberGovernanceError('INVALID_SUBSCRIBER_IMPORT_PAYLOAD');
  }

  // Verify sorted by IMSI
  const records = p.records as Array<Record<string, unknown>>;
  const targets = p.targets as Array<Record<string, unknown>>;
  for (let i = 1; i < records.length; i++) {
    if ((records[i].imsi as string) <= (records[i - 1].imsi as string)) {
      throw new SubscriberGovernanceError('INVALID_SUBSCRIBER_IMPORT_PAYLOAD');
    }
  }
  for (let i = 1; i < targets.length; i++) {
    if ((targets[i].imsi as string) <= (targets[i - 1].imsi as string)) {
      throw new SubscriberGovernanceError('INVALID_SUBSCRIBER_IMPORT_PAYLOAD');
    }
  }

  // Verify 1:1 correlation
  for (let i = 0; i < records.length; i++) {
    if (records[i].imsi !== targets[i].imsi) {
      throw new SubscriberGovernanceError('INVALID_SUBSCRIBER_IMPORT_PAYLOAD');
    }
  }

  // Verify target states
  for (const t of targets) {
    if (t.state !== 'present' && t.state !== 'absent') {
      throw new SubscriberGovernanceError('INVALID_SUBSCRIBER_IMPORT_PAYLOAD');
    }
  }

  // Verify no sensitive fields in records
  for (const rec of records) {
    for (const key of SENSITIVE_IMPORT_KEYS) {
      if (key in rec) {
        throw new SubscriberGovernanceError('INVALID_SUBSCRIBER_IMPORT_PAYLOAD');
      }
    }
  }

  return payload as FrozenSubscriberImportV2;
}

export async function executeFrozenSubscriberImportV2(frozen: FrozenSubscriberImportV2) {
  assertFrozenSubscriberImportV2(frozen);

  const result = {
    requested: frozen.targetCount,
    intendedCreateCount: frozen.summary.createCount,
    createdImsis: [] as string[],
    skippedImsis: [] as string[],
    conflictImsis: [] as string[],
    failedImsis: [] as string[],
    ocsProvisionedImsis: [] as string[],
    ocsProvisioningFailedImsis: [] as string[],
    createdCount: 0,
    partialMutation: false,
    mutationCommitted: false,
    operationFingerprint: frozen.operationFingerprint,
  };

  // Phase 1: ALL-TARGET STATE BARRIER
  const existenceChecks = await Promise.all(
    frozen.targets.map(async (t) => ({
      target: t,
      exists: !!(await findSubscriberDocument(t.imsi)),
    }))
  );

  for (const { target, exists } of existenceChecks) {
    if (target.state === 'present' && !exists) {
      return result; // Zero writes on state drift
    }
    if (target.state === 'absent' && exists) {
      return result; // Zero writes on state drift
    }
  }

  // Phase 2: Execute — skip present, insert absent
  const recordByImsi = new Map(frozen.records.map((r) => [r.imsi, r]));

  for (const target of frozen.targets) {
    if (target.state === 'present') {
      result.skippedImsis.push(target.imsi);
      continue;
    }

    // Insert new subscriber
    const rec = recordByImsi.get(target.imsi)!;
    try {
      await insertSubscriberImportCreateOnly(rec);
      result.createdImsis.push(target.imsi);
    } catch (error) {
      if (error instanceof Error && error.message.includes('duplicate key')) {
        result.conflictImsis.push(target.imsi);
      } else {
        result.failedImsis.push(target.imsi);
      }
    }
  }

  // Phase 3: OCS provisioning for created subscribers
  for (const imsi of result.createdImsis) {
    const rec = recordByImsi.get(imsi)!;
    try {
      await provisionImportedSubscriberOcs({
        imsi,
        planId: rec.plan_id,
        trafficTotal: rec.traffic_total,
        trafficBalance: rec.traffic_balance,
        smsTotal: rec.sms_total,
        smsBalance: rec.sms_balance,
      });
      result.ocsProvisionedImsis.push(imsi);
    } catch {
      result.ocsProvisioningFailedImsis.push(imsi);
    }
  }

  // Classify
  result.createdCount = result.createdImsis.length;
  const classification = classifyImportResult(result);
  result.partialMutation = classification === 'PARTIAL_WRITE';
  result.mutationCommitted = result.createdCount > 0;

  return result;
}

export function classifyImportResult(result: {
  createdCount: number;
  intendedCreateCount: number;
  conflictImsis: string[];
  failedImsis: string[];
  ocsProvisioningFailedImsis: string[];
}): 'SUCCESS' | 'PARTIAL_WRITE' | 'FAILED_NO_MUTATION' {
  if (
    result.createdCount === result.intendedCreateCount &&
    result.conflictImsis.length === 0 &&
    result.failedImsis.length === 0 &&
    result.ocsProvisioningFailedImsis.length === 0
  ) {
    return 'SUCCESS';
  }
  if (result.createdCount > 0) return 'PARTIAL_WRITE';
  return 'FAILED_NO_MUTATION';
}
