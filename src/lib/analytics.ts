import { redis } from '@/lib/redis';
import { AuditAction } from './audit';
import { evaluateSecurityPolicies } from './sentinel';

/**
 * 实时增量分析引擎 (Real-time Incremental Aggregator)
 * 通过事件驱动挂载在审计流水线上，使用 O(1) 原子操作更新统计指标。
 */
export async function updateAnalytics(action: AuditAction, oldVal: any, newVal: any) {
  try {
    const pipeline = redis.pipeline();
    let trafficDelta = 0;

    // 1. 处理普通单体会话 (CREATE, UPDATE, DELETE)
    if (action === 'CREATE' || action === 'UPDATE' || action === 'DELETE') {
      const oldTrafficObj = oldVal?.ocsTraffic || oldVal?.traffic;
      const newTrafficObj = newVal?.ocsTraffic || newVal?.traffic;

      const oldBalance = oldTrafficObj ? Number(oldTrafficObj.traffic_balance || 0) : 0;
      const newBalance = newTrafficObj ? Number(newTrafficObj.traffic_balance || 0) : 0;

      // 如果发生了修改，或者创建/删除
      if (oldBalance !== newBalance) {
        trafficDelta = newBalance - oldBalance;
        const plmn = newTrafficObj?.plmn || oldTrafficObj?.plmn || '45400';

        // 分离出来的哨兵探测与自动断网 (非阻塞)
        evaluateSecurityPolicies(action, oldTrafficObj, newTrafficObj);

        // 累加总流量水位
        pipeline.incrby('STATS:GLOBAL:TOTAL_TRAFFIC', trafficDelta);
        // 累加 PLMN 占比
        pipeline.hincrby('STATS:PLMN_TRAFFIC', plmn, trafficDelta);
      }

      // 排行榜更新 (ZSET Leaderboard)
      if (action === 'DELETE' && oldVal?.ocsImsi?.imsi) {
        pipeline.zrem('STATS:TRAFFIC:LEADERBOARD', oldVal.ocsImsi.imsi);
      } else if ((action === 'CREATE' || action === 'UPDATE') && newVal?.ocsTraffic) {
        const imsi = newVal.ocsTraffic.imsi;
        if (imsi) {
          pipeline.zadd('STATS:TRAFFIC:LEADERBOARD', newBalance, imsi);
        }
      }

      // 累加 Rating Group 活跃覆盖人数
      const oldRates = oldVal?.ocsImsiSet?.rates_map;
      const newRates = newVal?.ocsImsiSet?.rates_map;
      const oldRateId = oldRates ? Object.values(oldRates)[0] : null;
      const newRateId = newRates ? Object.values(newRates)[0] : null;

      if (oldRateId !== newRateId) {
        if (oldRateId !== null) pipeline.hincrby('STATS:RATES_COUNT', String(oldRateId), -1);
        if (newRateId !== null) pipeline.hincrby('STATS:RATES_COUNT', String(newRateId), 1);
      }
    }

    // 2. 处理大批量开户 (BATCH_CREATE)
    else if (action === 'BATCH_CREATE' && newVal?.batchMetrics) {
      // 批量创建时，直接从 batchMetrics 参数中提取算好的汇总量
      const { totalTraffic, batchSize, plmn, ratingGroupId } = newVal.batchMetrics;

      if (totalTraffic && batchSize) {
        pipeline.incrby('STATS:GLOBAL:TOTAL_TRAFFIC', totalTraffic);
        pipeline.hincrby('STATS:PLMN_TRAFFIC', plmn || '45400', totalTraffic);

        if (ratingGroupId !== undefined && ratingGroupId !== null) {
          pipeline.hincrby('STATS:RATES_COUNT', String(ratingGroupId), batchSize);
        }
      }
    }

    if (pipeline.length > 0) {
      await pipeline.exec();
    }
  } catch (e) {
    console.error('Analytics Aggregation Failed:', e);
  }
}
