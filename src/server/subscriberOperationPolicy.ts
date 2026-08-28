import { createHash } from 'node:crypto';
import { hasPermission } from '@/lib/permissions';
import { validateImsi } from '@/lib/subscriberValidation';
import type { Permission } from '@/lib/permissions';
import type { AuthContext } from '@/lib/authz';
import type { Open5gsSubscriberDocument } from '@/types/xcloud';
import { applyGovernedSubscriberConditionalUpdates, findSubscriberDocuments, type GovernedSubscriberConditionalUpdate } from '@/server/repositories/subscriberRepository';

export const SUBSCRIBER_BATCH_OPERATION = 'SUBSCRIBER_BATCH_UPDATE' as const;
export const SUBSCRIBER_BATCH_POLICY_ID = 'subscriber-batch-governance-v1';
export const MAX_SUBSCRIBER_BATCH_TARGETS = 100;
export const MAX_SUBSCRIBER_BATCH_SNAPSHOT_BYTES = 512 * 1024;

type BitratePatch = { value: number; unit: number };
export type GovernedSubscriberPatch = {
  accessRestrictionData?: number;
  ambr?: { downlink?: BitratePatch; uplink?: BitratePatch };
};

export type SubscriberBatchChangeRequest = {
  imsis: string[];
  patch: GovernedSubscriberPatch;
  reason: string;
  ticketId?: string;
  maintenanceWindow?: { start: string; end: string; timeZone?: string };
};

export type SubscriberChangeTarget = {
  imsi: string;
  before: Record<string, number>;
  after: Record<string, number>;
  preconditionHash: string;
};

export type FrozenSubscriberBatchChange = {
  version: 'subscriber-batch-update-v1';
  targets: SubscriberChangeTarget[];
  patch: GovernedSubscriberPatch;
  fieldNames: string[];
  targetCount: number;
  snapshotBytes: number;
  operationFingerprint: string;
};

export class SubscriberBatchGovernanceError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, details?: Record<string, unknown>) {
    super(code);
    this.code = code;
    this.details = details;
  }
}

const ALLOWED_TOP_LEVEL = new Set(['imsis', 'patch', 'reason', 'ticketId', 'maintenanceWindow']);
const ALLOWED_PATCH = new Set(['accessRestrictionData', 'ambr']);
const ALLOWED_AMBR = new Set(['downlink', 'uplink']);
const ALLOWED_BITRATE = new Set(['value', 'unit']);
const SENSITIVE_FIELD_NAMES = new Set(['security', 'k', 'op', 'opc', 'amf', 'rand', 'sqn', 'imsi', 'msisdn', 'slice']);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: Set<string>, code: string) {
  const unknown = Object.keys(value).find((key) => !allowed.has(key) || key.startsWith('$') || key.includes('.'));
  if (unknown) throw new SubscriberBatchGovernanceError(code, { field: unknown });
}

function positiveInt(value: unknown, code: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new SubscriberBatchGovernanceError(code);
  return Number(value);
}

function parseBitrate(value: unknown): BitratePatch {
  const item = record(value);
  if (!item) throw new SubscriberBatchGovernanceError('INVALID_BATCH_REQUEST');
  rejectUnknownKeys(item, ALLOWED_BITRATE, 'UNSUPPORTED_SUBSCRIBER_FIELD');
  return { value: positiveInt(item.value, 'INVALID_BATCH_REQUEST', 1, 10_000_000), unit: positiveInt(item.unit, 'INVALID_BATCH_REQUEST', 0, 9) };
}

function normalizePatch(value: unknown): GovernedSubscriberPatch {
  const patch = record(value);
  if (!patch) throw new SubscriberBatchGovernanceError('INVALID_BATCH_REQUEST');
  rejectUnknownKeys(patch, ALLOWED_PATCH, 'UNSUPPORTED_SUBSCRIBER_FIELD');
  const output: GovernedSubscriberPatch = {};
  if (patch.accessRestrictionData !== undefined) output.accessRestrictionData = positiveInt(patch.accessRestrictionData, 'INVALID_BATCH_REQUEST', 0, 255);
  if (patch.ambr !== undefined) {
    const ambr = record(patch.ambr);
    if (!ambr) throw new SubscriberBatchGovernanceError('INVALID_BATCH_REQUEST');
    rejectUnknownKeys(ambr, ALLOWED_AMBR, 'UNSUPPORTED_SUBSCRIBER_FIELD');
    const next: NonNullable<GovernedSubscriberPatch['ambr']> = {};
    if (ambr.downlink !== undefined) next.downlink = parseBitrate(ambr.downlink);
    if (ambr.uplink !== undefined) next.uplink = parseBitrate(ambr.uplink);
    if (Object.keys(next).length === 0) throw new SubscriberBatchGovernanceError('INVALID_BATCH_REQUEST');
    output.ambr = next;
  }
  if (Object.keys(output).length === 0) throw new SubscriberBatchGovernanceError('INVALID_BATCH_REQUEST');
  return output;
}

function normalizeMaintenanceWindow(value: unknown): SubscriberBatchChangeRequest['maintenanceWindow'] | undefined {
  if (value === undefined) return undefined;
  const window = record(value);
  if (!window) throw new SubscriberBatchGovernanceError('INVALID_BATCH_REQUEST');
  rejectUnknownKeys(window, new Set(['start', 'end', 'timeZone']), 'INVALID_BATCH_REQUEST');
  const start = typeof window.start === 'string' ? window.start : '';
  const end = typeof window.end === 'string' ? window.end : '';
  if (!Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) || Date.parse(start) >= Date.parse(end)) throw new SubscriberBatchGovernanceError('INVALID_BATCH_REQUEST');
  const timeZone = typeof window.timeZone === 'string' && window.timeZone.trim() ? window.timeZone.trim().slice(0, 100) : undefined;
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString(), timeZone };
}

export function validateSubscriberBatchChangeRequest(value: unknown): SubscriberBatchChangeRequest {
  const body = record(value);
  if (!body) throw new SubscriberBatchGovernanceError('INVALID_BATCH_REQUEST');
  rejectUnknownKeys(body, ALLOWED_TOP_LEVEL, 'INVALID_BATCH_REQUEST');
  if (!Array.isArray(body.imsis) || body.imsis.length === 0) throw new SubscriberBatchGovernanceError('INVALID_BATCH_REQUEST');
  if (body.imsis.length > MAX_SUBSCRIBER_BATCH_TARGETS) throw new SubscriberBatchGovernanceError('BATCH_SIZE_EXCEEDED', { max: MAX_SUBSCRIBER_BATCH_TARGETS });
  const imsis = body.imsis.map((item) => typeof item === 'string' ? item.trim() : '');
  if (imsis.some((imsi) => !validateImsi(imsi).ok)) throw new SubscriberBatchGovernanceError('INVALID_BATCH_REQUEST');
  if (new Set(imsis).size !== imsis.length) throw new SubscriberBatchGovernanceError('INVALID_BATCH_REQUEST', { reason: 'DUPLICATE_IMSI' });
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (reason.length < 3 || reason.length > 1000) throw new SubscriberBatchGovernanceError('INVALID_BATCH_REQUEST', { reason: 'REASON_REQUIRED' });
  const ticketId = typeof body.ticketId === 'string' && body.ticketId.trim() ? body.ticketId.trim().slice(0, 200) : undefined;
  return { imsis, patch: normalizePatch(body.patch), reason, ticketId, maintenanceWindow: normalizeMaintenanceWindow(body.maintenanceWindow) };
}

export function evaluateSubscriberOperationPolicy(auth: Pick<AuthContext, 'role'>, input: Pick<SubscriberBatchChangeRequest, 'patch'>) {
  const permission: Permission = 'subscribers.write';
  const fieldNames = changedFieldNames(input.patch);
  const sensitiveAttempt = fieldNames.some((field) => SENSITIVE_FIELD_NAMES.has(field.split('.')[0] || field));
  return {
    operation: SUBSCRIBER_BATCH_OPERATION,
    policyId: SUBSCRIBER_BATCH_POLICY_ID,
    allowed: hasPermission({ role: auth.role }, permission),
    permission,
    riskLevel: sensitiveAttempt ? 'critical' as const : 'high' as const,
    requiresApproval: true,
    requiresIndependentReviewer: true,
    reasons: sensitiveAttempt ? ['Sensitive authentication field requested'] : ['Bulk core subscriber state change requires independent approval'],
  };
}

export function changedFieldNames(patch: GovernedSubscriberPatch): string[] {
  const fields: string[] = [];
  if (patch.accessRestrictionData !== undefined) fields.push('access_restriction_data');
  if (patch.ambr?.downlink) fields.push('ambr.downlink');
  if (patch.ambr?.uplink) fields.push('ambr.uplink');
  return fields;
}

function valuesFor(doc: Open5gsSubscriberDocument, patch: GovernedSubscriberPatch): { before: Record<string, number>; after: Record<string, number> } {
  const before: Record<string, number> = {};
  const after: Record<string, number> = {};
  if (patch.accessRestrictionData !== undefined) {
    before.access_restriction_data = Number(doc.access_restriction_data);
    after.access_restriction_data = patch.accessRestrictionData;
  }
  for (const direction of ['downlink', 'uplink'] as const) {
    const bitrate = patch.ambr?.[direction];
    if (!bitrate) continue;
    before[`ambr.${direction}.value`] = Number(doc.ambr?.[direction]?.value);
    before[`ambr.${direction}.unit`] = Number(doc.ambr?.[direction]?.unit);
    after[`ambr.${direction}.value`] = bitrate.value;
    after[`ambr.${direction}.unit`] = bitrate.unit;
  }
  return { before, after };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

export async function prepareFrozenSubscriberBatchChange(input: SubscriberBatchChangeRequest): Promise<FrozenSubscriberBatchChange> {
  const docs = await findSubscriberDocuments(input.imsis);
  const byImsi = new Map(docs.map((doc) => [doc.imsi, doc]));
  const missing = input.imsis.filter((imsi) => !byImsi.has(imsi));
  if (missing.length > 0) throw new SubscriberBatchGovernanceError('SUBSCRIBER_NOT_FOUND', { imsis: missing.slice(0, 20), count: missing.length });
  const targets = input.imsis.slice().sort().map((imsi) => {
    const values = valuesFor(byImsi.get(imsi) as Open5gsSubscriberDocument, input.patch);
    if (stableJson(values.before) === stableJson(values.after)) throw new SubscriberBatchGovernanceError('SUBSCRIBER_BATCH_NO_EFFECT', { imsi });
    return { imsi, ...values, preconditionHash: fingerprint(values.before) };
  });
  const fieldNames = changedFieldNames(input.patch);
  const operationFingerprint = fingerprint({ imsis: targets.map((target) => target.imsi), patch: input.patch, fieldNames });
  const snapshotBytes = Buffer.byteLength(stableJson({ targets, patch: input.patch, fieldNames, operationFingerprint }), 'utf8');
  if (snapshotBytes > MAX_SUBSCRIBER_BATCH_SNAPSHOT_BYTES) throw new SubscriberBatchGovernanceError('APPROVAL_SNAPSHOT_TOO_LARGE', { snapshotBytes, max: MAX_SUBSCRIBER_BATCH_SNAPSHOT_BYTES });
  return { version: 'subscriber-batch-update-v1', targets, patch: input.patch, fieldNames, targetCount: targets.length, snapshotBytes, operationFingerprint };
}

export function assertFrozenSubscriberBatchPayload(value: unknown): FrozenSubscriberBatchChange {
  const payload = record(value);
  if (!payload || payload.version !== 'subscriber-batch-update-v1' || !Array.isArray(payload.targets)) throw new SubscriberBatchGovernanceError('INVALID_BATCH_REQUEST');
  const request = validateSubscriberBatchChangeRequest({ imsis: payload.targets.map((target) => record(target)?.imsi), patch: payload.patch, reason: 'frozen-payload' });
  const fieldNames = changedFieldNames(request.patch);
  const targets = payload.targets.map((item) => {
    const target = record(item);
    if (!target || typeof target.imsi !== 'string' || !record(target.before) || !record(target.after) || typeof target.preconditionHash !== 'string') throw new SubscriberBatchGovernanceError('INVALID_BATCH_REQUEST');
    const before = record(target.before) as Record<string, number>;
    const after = record(target.after) as Record<string, number>;
    if (fingerprint(before) !== target.preconditionHash || Object.keys(before).some((key) => !fieldNames.some((field) => key === field || key.startsWith(`${field}.`)))) throw new SubscriberBatchGovernanceError('INVALID_BATCH_REQUEST');
    return { imsi: target.imsi, before, after, preconditionHash: target.preconditionHash };
  });
  return { version: 'subscriber-batch-update-v1', targets, patch: request.patch, fieldNames, targetCount: targets.length, snapshotBytes: Number(payload.snapshotBytes) || 0, operationFingerprint: typeof payload.operationFingerprint === 'string' ? payload.operationFingerprint : fingerprint({ imsis: targets.map((target) => target.imsi), patch: request.patch, fieldNames }) };
}

export async function executeFrozenSubscriberBatchChange(payload: unknown) {
  const frozen = assertFrozenSubscriberBatchPayload(payload);
  const docs = await findSubscriberDocuments(frozen.targets.map((target) => target.imsi));
  const current = new Map(docs.map((doc) => [doc.imsi, doc]));
  const drifted = frozen.targets.filter((target) => {
    const doc = current.get(target.imsi);
    return !doc || fingerprint(valuesFor(doc, frozen.patch).before) !== target.preconditionHash;
  });
  if (drifted.length > 0) throw new SubscriberBatchGovernanceError('SUBSCRIBER_BATCH_PRECONDITION_CHANGED', { drifted: drifted.map((target) => target.imsi).slice(0, 20), count: drifted.length, expected: frozen.targetCount });
  const updates: GovernedSubscriberConditionalUpdate[] = frozen.targets.map((target) => ({ imsi: target.imsi, expected: target.before, next: target.after }));
  const result = await applyGovernedSubscriberConditionalUpdates(updates);
  if (result.matchedCount !== frozen.targetCount || result.modifiedCount !== frozen.targetCount) {
    throw new SubscriberBatchGovernanceError('SUBSCRIBER_BATCH_PARTIAL_WRITE', { ...result, expected: frozen.targetCount, partialMutation: result.modifiedCount > 0 });
  }
  return { requested: frozen.targetCount, matched: result.matchedCount, modified: result.modifiedCount, fieldNames: frozen.fieldNames, operationFingerprint: frozen.operationFingerprint };
}
