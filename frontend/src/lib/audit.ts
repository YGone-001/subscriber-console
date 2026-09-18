import { after } from 'next/server';
import { updateAnalytics } from './analytics';
import { appendAuditLog } from '@/server/repositories/auditRepository';
import { auditRequestContext, createAuditRecord } from './audit/record';
import type { AuditLogRecord, LegacyAuditAction, WriteAuditInput } from '@/types/audit';

export type { WriteAuditInput } from '@/types/audit';
// Keep the established import narrow for existing analytics and business routes.
export type AuditAction = LegacyAuditAction;

export type AuditWriteOptions = { failureMode?: 'best-effort' | 'strict' };

export class AuditWriteError extends Error {
  constructor(public readonly eventId: string) {
    super('Audit evidence could not be persisted');
    this.name = 'AuditWriteError';
  }
}

async function persistAuditRecord(record: AuditLogRecord, options: AuditWriteOptions = {}): Promise<boolean> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await appendAuditLog(record);
      return true;
    } catch {
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 100));
    }
  }
  // Driver errors can embed credentials or rejected documents. Log safe context only.
  console.error('Audit logging failed after retries', { eventId: record.eventId, action: record.action });
  if (options.failureMode === 'strict') throw new AuditWriteError(record.eventId || record.id);
  return false;
}

/** Await this for security gates; a strict failure is explicit, not a silent success. */
export async function writeAuditLog(input: WriteAuditInput, options: AuditWriteOptions = {}): Promise<boolean> {
  return persistAuditRecord(createAuditRecord(input), options);
}

/** Request-scoped best effort. after() is not a durable queue across process crashes. */
export function scheduleAuditLog(input: WriteAuditInput): void {
  const record = createAuditRecord(input);
  try {
    after(async () => { await persistAuditRecord(record); });
  } catch {
    console.error('Audit scheduling failed', { eventId: record.eventId, action: record.action });
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function extractDeltas(oldValue: unknown, newValue: unknown) {
  const before = asObject(oldValue);
  const next = asObject(newValue);
  if (!before || !next) return { oldData: oldValue ?? null, newData: newValue ?? null };
  const oldData: Record<string, unknown> = {};
  const newData: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(next)])) {
    if (JSON.stringify(before[key]) !== JSON.stringify(next[key])) {
      oldData[key] = before[key] ?? null;
      newData[key] = next[key] ?? null;
    }
  }
  return { oldData, newData };
}

/** Compatibility adapter for existing routes. New integrations use writeAuditLog. */
export function logAudit(action: LegacyAuditAction, targetId: string, oldVal: unknown, newVal: unknown, req?: Request): void {
  const actor = req?.headers.get('x-user')?.trim();
  const source = auditRequestContext(req);
  const oldObject = asObject(oldVal);
  const newObject = asObject(newVal);
  const approvalId = [newObject?.approvalId, oldObject?.approvalId, targetId.startsWith('approval:') ? targetId.slice(9) : undefined]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
  const auditModule = targetId.startsWith('SYS_USER:') ? 'users'
    : targetId.startsWith('approval:') ? 'approvals'
    : action.startsWith('PROFILE_') ? 'profiles'
    : action.startsWith('TRAFFIC_') ? 'ocs'
    : action === 'HEAL' ? 'system' : 'legacy';
  const record = createAuditRecord({
    actor: { type: actor ? 'user' : 'system', username: actor || 'system', role: req?.headers.get('x-user-role') || undefined },
    module: auditModule,
    action,
    targetId,
    resource: { type: auditModule, id: targetId },
    result: newObject?.status === 'failed' || newObject?.success === false ? 'failed' : 'success',
    approvalId,
    before: oldVal,
    after: newVal,
    level: action.includes('DELETE') || action === 'HEAL' ? 'warning' : 'info',
    ...source,
  });
  // Compute deltas only after sanitizing; passwords and cyclic values never reach JSON.stringify.
  const delta = extractDeltas(record.oldData, record.newData);
  record.oldData = delta.oldData;
  record.newData = delta.newData;
  try {
    after(async () => {
      // Analytics must not prevent evidence persistence (or vice versa).
      await persistAuditRecord(record);
      try { await updateAnalytics(action, oldVal, newVal); }
      catch { console.error('Audit analytics hook failed', { eventId: record.eventId }); }
    });
  } catch {
    console.error('Audit scheduling failed', { eventId: record.eventId, action });
  }
}
