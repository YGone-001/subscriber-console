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
  | 'CSV_IMPORT';

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
  setTimeout(async () => {
    try {
      const rawIp = req
        ? req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || '127.0.0.1'
        : '127.0.0.1';
      const operatorIp = maskIp(rawIp);
      const timestamp = new Date().toISOString();
      const level = (action.includes('DELETE') || action === 'HEAL') ? 'warning' : 'info';
      const { oldData, newData } = extractDeltas(oldVal, newVal);

      await updateAnalytics(action, oldVal, newVal);

      if (!oldData && !newData && action !== 'HEAL' && !action.includes('DELETE')) {
        return;
      }

      await appendAuditLog({
        id: crypto.randomUUID(),
        timestamp,
        level,
        action,
        targetId,
        operatorIp,
        oldData,
        newData,
      });
    } catch (error) {
      console.error('Audit logging failed:', error);
    }
  }, 0);
}
