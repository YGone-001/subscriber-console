import { randomUUID } from 'node:crypto';
import { Long, type Document } from 'mongodb';
import { getAppCollection, getXcloudCollection, mongoCollections } from '@/lib/mongo';

export type OcsBalanceBucket = 'data' | 'voice';
export type OcsBalanceOperation = 'credit' | 'debit';

export type OcsBalanceIntent = {
  bucket: OcsBalanceBucket;
  operation: OcsBalanceOperation;
  amount: number;
  reason: string;
  ticketId?: string;
  maintenanceWindow?: { start: string; end: string; timeZone?: string };
};

type BalanceSnapshot = {
  imsi: string;
  bucket: OcsBalanceBucket;
  total: number;
  used: number;
  reserved: number;
  available: number;
  version: number;
  versionPresent: boolean;
};

export type FrozenOcsBalanceAdjustment = {
  schema: 'ocs-balance-adjustment-v1';
  adjustmentId: string;
  imsi: string;
  intent: OcsBalanceIntent;
  before: BalanceSnapshot;
  expectedAfter: Omit<BalanceSnapshot, 'version' | 'versionPresent'>;
};

type OcsBalanceDocument = Document & {
  imsi: string;
  data_total?: Long | number;
  data_used?: Long | number;
  data_reserved?: Long | number;
  data_available?: Long | number;
  voice_total?: Long | number;
  voice_used?: Long | number;
  voice_reserved?: Long | number;
  voice_available?: Long | number;
  version?: Long | number;
};

type OcsBalanceAdjustmentLedger = Document & {
  adjustmentId: string;
  executionId: string;
  status: 'claimed' | 'completed' | 'failed';
  imsi: string;
  bucket: OcsBalanceBucket;
  before?: BalanceSnapshot;
  after?: BalanceSnapshot;
};

export class OcsBalanceGovernanceError extends Error {
  public readonly code: string;
  public readonly committed: boolean;
  public readonly details?: unknown;

  constructor(code: string, committed = false, details?: unknown) {
    super(code);
    this.code = code;
    this.committed = committed;
    this.details = details;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function safeInteger(value: unknown, field: string, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  const numberValue = Long.isLong(value) ? value.toNumber() : typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(numberValue) || numberValue < 0) throw new OcsBalanceGovernanceError('OCS_BALANCE_VALUE_OUT_OF_RANGE', false, { field });
  return numberValue;
}

function versionFrom(value: unknown): number {
  const version = safeInteger(value, 'version', 0);
  return version;
}

function snapshotFromDocument(imsi: string, bucket: OcsBalanceBucket, document: OcsBalanceDocument): BalanceSnapshot {
  const prefix = bucket === 'data' ? 'data' : 'voice';
  const total = safeInteger(document[`${prefix}_total`] as unknown, `${prefix}_total`, 0);
  const used = safeInteger(document[`${prefix}_used`] as unknown, `${prefix}_used`, 0);
  const reserved = safeInteger(document[`${prefix}_reserved`] as unknown, `${prefix}_reserved`, 0);
  const available = safeInteger(document[`${prefix}_available`] as unknown, `${prefix}_available`, 0);
  if (total !== used + reserved + available) {
    throw new OcsBalanceGovernanceError('OCS_BALANCE_INVARIANT_VIOLATION', false, { imsi, bucket, total, used, reserved, available });
  }
  return { imsi, bucket, total, used, reserved, available, version: versionFrom(document.version), versionPresent: document.version !== undefined };
}

function validateImsi(value: unknown): string {
  const imsi = typeof value === 'string' ? value.trim() : '';
  if (!/^\d{15}$/.test(imsi)) throw new OcsBalanceGovernanceError('INVALID_IMSI');
  return imsi;
}

export function validateOcsBalanceIntent(value: unknown): OcsBalanceIntent {
  const input = record(value);
  if (!input) throw new OcsBalanceGovernanceError('INVALID_OCS_BALANCE_ADJUSTMENT');
  const keys = Object.keys(input);
  if (keys.some((key) => !['bucket', 'operation', 'amount', 'reason', 'ticketId', 'maintenanceWindow'].includes(key) || key.includes('$') || key.includes('.'))) {
    throw new OcsBalanceGovernanceError('INVALID_OCS_BALANCE_ADJUSTMENT');
  }
  const bucket = input.bucket;
  const operation = input.operation;
  if (bucket !== 'data' && bucket !== 'voice') throw new OcsBalanceGovernanceError('INVALID_OCS_BALANCE_BUCKET');
  if (operation !== 'credit' && operation !== 'debit') throw new OcsBalanceGovernanceError('INVALID_OCS_BALANCE_OPERATION');
  const amount = safeInteger(input.amount, 'amount');
  if (amount <= 0) throw new OcsBalanceGovernanceError('INVALID_OCS_BALANCE_AMOUNT');
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (!reason || reason.length > 200) throw new OcsBalanceGovernanceError('OCS_BALANCE_REASON_REQUIRED');
  const ticketId = typeof input.ticketId === 'string' && input.ticketId.trim() ? input.ticketId.trim().slice(0, 100) : undefined;
  const maintenanceWindow = record(input.maintenanceWindow);
  const window = maintenanceWindow && typeof maintenanceWindow.start === 'string' && typeof maintenanceWindow.end === 'string'
    ? { start: maintenanceWindow.start, end: maintenanceWindow.end, ...(typeof maintenanceWindow.timeZone === 'string' ? { timeZone: maintenanceWindow.timeZone } : {}) }
    : undefined;
  if (input.maintenanceWindow !== undefined && !window) throw new OcsBalanceGovernanceError('INVALID_MAINTENANCE_WINDOW');
  return { bucket, operation, amount, reason, ...(ticketId ? { ticketId } : {}), ...(window ? { maintenanceWindow: window } : {}) };
}

function expectedAfter(before: BalanceSnapshot, intent: OcsBalanceIntent): FrozenOcsBalanceAdjustment['expectedAfter'] {
  const delta = intent.operation === 'credit' ? intent.amount : -intent.amount;
  const total = before.total + delta;
  if (!Number.isSafeInteger(total) || total < before.used + before.reserved) {
    throw new OcsBalanceGovernanceError('OCS_BALANCE_RESERVATION_CONFLICT', false, { minimumTotal: before.used + before.reserved });
  }
  const available = total - before.used - before.reserved;
  return { imsi: before.imsi, bucket: before.bucket, total, used: before.used, reserved: before.reserved, available };
}

export async function freezeOcsBalanceAdjustment(imsiInput: unknown, intentInput: unknown): Promise<FrozenOcsBalanceAdjustment> {
  const imsi = validateImsi(imsiInput);
  const intent = validateOcsBalanceIntent(intentInput);
  const balances = await getXcloudCollection<OcsBalanceDocument>(mongoCollections.ocsBalances);
  const current = await balances.findOne({ imsi });
  if (!current) throw new OcsBalanceGovernanceError('OCS_BALANCE_NOT_FOUND');
  const before = snapshotFromDocument(imsi, intent.bucket, current);
  return { schema: 'ocs-balance-adjustment-v1', adjustmentId: randomUUID(), imsi, intent, before, expectedAfter: expectedAfter(before, intent) };
}

function frozenPayload(value: unknown): FrozenOcsBalanceAdjustment {
  const input = record(value);
  if (!input || input.schema !== 'ocs-balance-adjustment-v1' || typeof input.adjustmentId !== 'string') throw new OcsBalanceGovernanceError('INVALID_OCS_BALANCE_FROZEN_PAYLOAD');
  const imsi = validateImsi(input.imsi);
  const intent = validateOcsBalanceIntent(input.intent);
  const beforeInput = record(input.before);
  const expectedInput = record(input.expectedAfter);
  if (!beforeInput || !expectedInput) throw new OcsBalanceGovernanceError('INVALID_OCS_BALANCE_FROZEN_PAYLOAD');
  const bucket = intent.bucket;
  const before: BalanceSnapshot = {
    imsi, bucket,
    total: safeInteger(beforeInput.total, 'before.total'), used: safeInteger(beforeInput.used, 'before.used'), reserved: safeInteger(beforeInput.reserved, 'before.reserved'), available: safeInteger(beforeInput.available, 'before.available'),
    version: safeInteger(beforeInput.version, 'before.version'), versionPresent: beforeInput.versionPresent === true,
  };
  if (before.total !== before.used + before.reserved + before.available) throw new OcsBalanceGovernanceError('OCS_BALANCE_INVARIANT_VIOLATION');
  const expected = expectedAfter(before, intent);
  if (safeInteger(expectedInput.total, 'expectedAfter.total') !== expected.total || safeInteger(expectedInput.available, 'expectedAfter.available') !== expected.available) throw new OcsBalanceGovernanceError('INVALID_OCS_BALANCE_FROZEN_PAYLOAD');
  return { schema: 'ocs-balance-adjustment-v1', adjustmentId: input.adjustmentId, imsi, intent, before, expectedAfter: expected };
}

export async function executeFrozenOcsBalanceAdjustment(input: unknown, context: { approvalId: string; executionId: string; actor: string }) {
  const frozen = frozenPayload(input);
  const ledger = await getAppCollection<OcsBalanceAdjustmentLedger>(mongoCollections.ocsBalanceAdjustments);
  const now = new Date().toISOString();
  try {
    await ledger.insertOne({ adjustmentId: frozen.adjustmentId, executionId: context.executionId, status: 'claimed', imsi: frozen.imsi, bucket: frozen.intent.bucket, approvalId: context.approvalId, actor: context.actor, intent: frozen.intent, before: frozen.before, expectedAfter: frozen.expectedAfter, claimedAt: now });
  } catch {
    const existing = await ledger.findOne({ adjustmentId: frozen.adjustmentId });
    if (existing?.status === 'completed') return { adjustmentId: frozen.adjustmentId, before: existing.before, after: existing.after, idempotent: true };
    throw new OcsBalanceGovernanceError('OCS_BALANCE_ADJUSTMENT_IN_PROGRESS', false, { adjustmentId: frozen.adjustmentId });
  }

  const balances = await getXcloudCollection<OcsBalanceDocument>(mongoCollections.ocsBalances);
  const prefix = frozen.intent.bucket === 'data' ? 'data' : 'voice';
  const after: BalanceSnapshot = { ...frozen.expectedAfter, version: frozen.before.version + 1, versionPresent: true };
  const versionFilter = frozen.before.versionPresent ? Long.fromNumber(frozen.before.version) : { $exists: false };
  const update = await balances.updateOne(
    { imsi: frozen.imsi, version: versionFilter },
    { $set: { [`${prefix}_total`]: Long.fromNumber(after.total), [`${prefix}_available`]: Long.fromNumber(after.available), version: Long.fromNumber(after.version), updated_at: new Date(), last_admin_adjustment_id: frozen.adjustmentId } }
  );
  if (update.matchedCount !== 1) {
    await ledger.updateOne({ adjustmentId: frozen.adjustmentId }, { $set: { status: 'failed', failedAt: new Date().toISOString(), error: 'OCS_BALANCE_PRECONDITION_CHANGED' } });
    throw new OcsBalanceGovernanceError('OCS_BALANCE_PRECONDITION_CHANGED', false, { imsi: frozen.imsi, expectedVersion: frozen.before.version });
  }

  try {
    const evidence = await ledger.updateOne({ adjustmentId: frozen.adjustmentId, status: 'claimed' }, { $set: { status: 'completed', completedAt: new Date().toISOString(), after } });
    if (evidence.matchedCount !== 1 || evidence.modifiedCount !== 1) {
      throw new Error('OCS_BALANCE_LEDGER_COMPLETION_CONFLICT');
    }
  } catch {
    throw new OcsBalanceGovernanceError('OCS_BALANCE_EVIDENCE_PERSISTENCE_FAILURE', true, { adjustmentId: frozen.adjustmentId, before: frozen.before, after });
  }
  return { adjustmentId: frozen.adjustmentId, before: frozen.before, after, idempotent: false };
}
