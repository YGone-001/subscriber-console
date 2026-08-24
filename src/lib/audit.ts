import { after } from 'next/server';
import { updateAnalytics } from './analytics';
import { appendAuditLog } from '@/server/repositories/auditRepository';

export type AuditAction =
  | 'CREATE'
  | 'UPDATE'
  | 'DELETE'
  | 'BATCH_CREATE'
  | 'BATCH_DELETE'
  | 'HEAL'
  | 'PROFILE_CREATE'
  | 'PROFILE_UPDATE'
  | 'PROFILE_DELETE'
  | 'CSV_IMPORT'
  | 'TRAFFIC_RECHARGE'
  | 'TRAFFIC_ADJUST'
  | 'TRAFFIC_RESET';

function maskIp(ip: string): string {
  if (!ip || ip.includes('::1') || ip === '127.0.0.1') return '127.0.0.***';
  return ip.replace(/(\d+)$/, '***');
}

function extractDeltas(oldObj: any, newObj: any) {
  if (!oldObj) return { oldData: null, newData: newObj };
  if (!newObj) return { oldData: oldObj, newData: null };

  if (typeof oldObj !== 'object' || typeof newObj !== 'object') {
    return oldObj !== newObj ? { oldData: oldObj, newData: newObj } : { oldData: null, newData: null };
  }

  const oldDelta: any = {};
  const newDelta: any = {};

  const keys = new Set([...Object.keys(oldObj || {}), ...Object.keys(newObj || {})]);
  keys.forEach((key) => {
    const oldValue = JSON.stringify(oldObj[key]);
    const newValue = JSON.stringify(newObj[key]);
    if (oldValue !== newValue) {
      oldDelta[key] = oldObj[key];
      newDelta[key] = newObj[key];
    }
  });

  return { oldData: oldDelta, newData: newDelta };
}

export function logAudit(action: AuditAction, targetId: string, oldVal: any, newVal: any, req?: Request) {
  const rawIp = req
    ? req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || '127.0.0.1'
    : '127.0.0.1';
  const operatorIp = maskIp(rawIp.split(',')[0]?.trim() || rawIp);
  const actor = req?.headers.get('x-user')?.trim() || 'system';
  const correlationId = req?.headers.get('x-request-id')?.trim() || crypto.randomUUID();
  const reason = req?.headers.get('x-operation-reason')?.trim() || undefined;
  const timestamp = new Date().toISOString();
  const level = (action.includes('DELETE') || action === 'HEAL') ? 'warning' : 'info';
  const { oldData, newData } = extractDeltas(oldVal, newVal);
  const approvalId = [newVal?.approvalId, oldVal?.approvalId, targetId.startsWith('approval:') ? targetId.slice(9) : undefined]
    .find((value) => typeof value === 'string' && value.trim()) as string | undefined;

  if (!oldData && !newData && action !== 'HEAL' && !action.includes('DELETE')) return;

  after(async () => {
    await updateAnalytics(action, oldVal, newVal);
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await appendAuditLog({
          id: crypto.randomUUID(),
          timestamp,
          level,
          action,
          targetId,
          actor,
          operatorIp,
          correlationId,
          approvalId,
          reason,
          oldData,
          newData,
        });
        return;
      } catch (error) {
        lastError = error;
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 100));
      }
    }
    console.error('Audit logging failed after retries:', lastError);
  });
}
