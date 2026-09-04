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
  findSubscriberDocument,
  updateSubscriberFromLegacy,
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

export async function prepareFrozenSubscriberBulkDelete(imsis: string[]): Promise<FrozenSubscriberBulkDelete> {
  const unique = [...new Set(imsis)].sort();
  const targets = await Promise.all(unique.map(async (imsi) => {
    const existing = await findSubscriberDocument(imsi);
    if (!existing) throw new SubscriberGovernanceError('SUBSCRIBER_NOT_FOUND', { imsi });
    return { imsi, before: subscriberSafeSnapshot(existing) };
  }));
  return { version: 'subscriber-bulk-delete-v1', targets, targetCount: targets.length, operationFingerprint: hash({ operation: 'SUBSCRIBER_BULK_DELETE', targets }) };
}

export async function executeFrozenSubscriberBulkDelete(payload: unknown) {
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
