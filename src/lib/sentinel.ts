import { redis } from '@/lib/redis';
import { emitSyslog, SyslogLevel } from './syslog';
import { AuditAction } from './audit';

/**
 * 内网隔离环境下的哨兵策略评估器 (Air-gapped Sentinel)
 * 评估流量增减，判定异常并产生具备状态机能力的独立预警实体。
 */
export async function evaluateSecurityPolicies(action: AuditAction, oldTrafficObj: any, newTrafficObj: any) {
  try {
    if (!newTrafficObj) return;

    const oldBalance = Number(oldTrafficObj?.traffic_balance || 0);
    const newBalance = Number(newTrafficObj.traffic_balance || 0);
    const imsi = newTrafficObj.imsi;

    if (!imsi) return;

    let alertLevel: SyslogLevel | null = null;
    let reason = '';

    // 1. 耗尽判定 (Traffic Exhausted)
    if (oldBalance > 0 && newBalance <= 0) {
      alertLevel = 'WARNING';
      reason = 'Traffic completely exhausted. Subscriber may experience service cut-off.';
    }

    // 2. 异常断崖式下跌 (DDoS / Volumetric Flood Detection - 骤降 500MB)
    const drop = oldBalance - newBalance;
    if (drop > 524288000) {
      alertLevel = 'CRITICAL';
      reason = `Massive traffic discharge detected (${(drop / 1048576).toFixed(0)} MB drop). Potential DDoS or abnormal leak!`;
    }

    if (alertLevel) {
      const alertPayload = {
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        level: alertLevel,
        imsi: imsi,
        reason: reason,
        is_acknowledged: false // <--- 状态机闭环核心
      };

      // 落库并执行环形流裁剪
      const pipeline = redis.pipeline();
      pipeline.lpush('LOG:ALERTS:LOCAL', JSON.stringify(alertPayload));
      pipeline.ltrim('LOG:ALERTS:LOCAL', 0, 9999); // 保留最新 10000 条告警记录

      // [自动化策略]: 触发极速隔离切片
      if (alertLevel === 'CRITICAL') {
         // 获取 SUB_4G 将 access_restriction_data 制为 2 强制断网防损
         const subStr = await redis.get(`SUB_4G:${imsi}`);
         if (subStr) {
           const sub4G = JSON.parse(subStr);
           sub4G.access_restriction_data = 2; // Suspend core network attachment
           pipeline.set(`SUB_4G:${imsi}`, JSON.stringify(sub4G));
           emitSyslog('CRITICAL', imsi, `[AUTO-DEFENSE] Subscriber ${imsi} suspended gracefully due to DDoS pattern.`);
         }
      }

      await pipeline.exec();

      // 向外部广播标准协议
      await emitSyslog(alertLevel, imsi, reason);
    }
  } catch (e) {
    console.error('Sentinel Engine Evaluation Failure:', e);
  }
}
