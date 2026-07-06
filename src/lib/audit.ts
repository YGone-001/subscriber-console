import { redis } from '@/lib/redis';
import { updateAnalytics } from './analytics';

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

/**
 * IP 脱敏处理 (IP Masking for privacy compliance)
 * Example: 192.168.1.100 -> 192.168.1.***
 */
function maskIp(ip: string): string {
  if (!ip || ip.includes('::1') || ip === '127.0.0.1') return '127.0.0.***';
  return ip.replace(/(\d+)$/, '***');
}

/**
 * 轻量级 Diff 提取器 (Lightweight delta extraction)
 * 仅保留被修改前后的那几个字段参数，避免存储整个巨大的 JSON 树
 */
function extractDeltas(oldObj: any, newObj: any) {
  if (!oldObj) return { oldData: null, newData: newObj };
  if (!newObj) return { oldData: oldObj, newData: null };

  if (typeof oldObj !== 'object' || typeof newObj !== 'object') {
    return oldObj !== newObj ? { oldData: oldObj, newData: newObj } : { oldData: null, newData: null };
  }

  const oldDelta: any = {};
  const newDelta: any = {};

  const keys = new Set([...Object.keys(oldObj || {}), ...Object.keys(newObj || {})]);
  keys.forEach(k => {
    const oStr = JSON.stringify(oldObj[k]);
    const nStr = JSON.stringify(newObj[k]);
    if (oStr !== nStr) {
      oldDelta[k] = oldObj[k];
      newDelta[k] = newObj[k];
    }
  });

  return { oldData: oldDelta, newData: newDelta };
}

/**
 * 全量操作审计拦截钩子 (Fire-and-forget Audit Logger)
 * @param action 动作类型
 * @param targetId 目标 IMSI/Profile 标识或集合范围
 * @param oldVal 操作前的数据引用
 * @param newVal 操作后的数据引用
 * @param req 拦截到的 Request 对象用于抽取 IP 等操作员痕迹
 */
export function logAudit(action: AuditAction, targetId: string, oldVal: any, newVal: any, req?: Request) {
  // Fire and forget, 绝不阻塞主业务执行栈
  setTimeout(async () => {
    try {
      let rawIp = '127.0.0.1';
      if (req) {
        rawIp = req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || '127.0.0.1';
      }
      const operatorIp = maskIp(rawIp);

      const timestamp = new Date().toISOString();
      const level = (action.includes('DELETE') || action === 'HEAL') ? 'warning' : 'info';

      const { oldData, newData } = extractDeltas(oldVal, newVal);

      // 同步触发极其轻量的全局增量指标分析器 (O(1) 更新)
      await updateAnalytics(action, oldVal, newVal);

      // 如果完全没有 diff，则无需浪费硬盘空间写审计
      if (!oldData && !newData && action !== 'HEAL' && !action.includes('DELETE')) {
        return;
      }

      const logPayload = {
        id: crypto.randomUUID(),
        timestamp,
        level,
        action,
        targetId,
        operatorIp,
        oldData,
        newData
      };

      const pipeline = redis.pipeline();
      pipeline.lpush('LOG:AUDIT', JSON.stringify(logPayload));
      // 强制 Capped Collection (限流 50000 记录防 OOM)
      pipeline.ltrim('LOG:AUDIT', 0, 49999);

      await pipeline.exec();
    } catch (e) {
      // 静默消化审计过程可能产生的极低概率失败，不要污染应用
      console.error('Audit Logging Exception Silent Eaten:', e);
    }
  }, 0);
}
