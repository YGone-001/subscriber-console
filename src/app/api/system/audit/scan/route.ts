import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';
import { requireAnyRole } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const auth = requireAnyRole(request, ['root', 'operator']);
    if (!auth.ok) return auth.response;
    const rateLimit = await enforceRateLimit(`system:audit-scan:${auth.auth.user}`, 30, 60);
    if (!rateLimit.ok) return rateLimit.response;

    const { cursor = '0', phase = 'sub' } = await request.json();
    let nextCursor = '0';
    let matchedKeys: string[] = [];
    interface Anomaly {
      imsi: string;
      type: string;
      details: string;
    }
    const anomalies: Anomaly[] = [];
    let scannedCount = 0;

    if (phase === 'sub') {
      // 阶段一: 扫描全量 SUB_4G, 验证是否缺漏 OCS 或者有余额异常
      const scanResult = await redis.scan(cursor, 'MATCH', 'SUB_4G:*', 'COUNT', 1000);
      nextCursor = scanResult[0];
      matchedKeys = scanResult[1];
      scannedCount = matchedKeys.length;

      if (matchedKeys.length > 0) {
        const pipeline = redis.pipeline();
        matchedKeys.forEach(k => {
          const imsi = k.split(':')[1];
          // 并发验证 4 个 OCS 相关表的独立存在性
          pipeline.exists(`OCS:TRAFFIC:TRAFFIC_${imsi}`);
          pipeline.exists(`OCS:IMSI:IMSI_${imsi}`);
          pipeline.exists(`OCS:ACCOUNT:ACCOUNT_${imsi}`);
          pipeline.exists(`OCS:IMSI:IMSI_SET_${imsi}`);
          // 同时提取 Account 备用余额校验
          pipeline.get(`OCS:ACCOUNT:ACCOUNT_${imsi}`);
        });

        const results = await pipeline.exec();
        if (results) {
          for (let i = 0; i < matchedKeys.length; i++) {
            const imsi = matchedKeys[i].split(':')[1];
            const startIdx = i * 5;

            let missingCount = 0;
            if (Number(results[startIdx][1]) === 0) missingCount++;
            if (Number(results[startIdx + 1][1]) === 0) missingCount++;
            if (Number(results[startIdx + 2][1]) === 0) missingCount++;
            if (Number(results[startIdx + 3][1]) === 0) missingCount++;

            // 异常 A: 配置缺失 (Missing Config)
            if (missingCount > 0) {
              anomalies.push({
                imsi,
                type: 'missing_config',
                details: `Missing ${missingCount}/4 OCS tables`
              });
              continue; // Do not check balance if config is explicitly missing
            }

            // 异常 C: 余额异常 (Balance Mismatch)
            const [errGet, accountVal] = results[startIdx + 4];
            if (!errGet && accountVal) {
               try {
                 const accObj = JSON.parse(accountVal as string);
                 if (accObj.balance === undefined || accObj.balance === null) {
                   anomalies.push({ imsi, type: 'balance_mismatch', details: 'Balance field is null or undefined' });
                 } else if (isNaN(Number(accObj.balance))) {
                   anomalies.push({ imsi, type: 'balance_mismatch', details: 'Balance format evaluates to NaN' });
                 }
               } catch (e) {
                 anomalies.push({ imsi, type: 'balance_mismatch', details: 'Critical: Invalid JSON payload in Account table' });
               }
            }
          }
        }
      }
    } else if (phase === 'ocs') {
      // 阶段二: 扫描全量 OCS_TRAFFIC, 验证是否缺漏基础核心网注册 (孤儿数据)
      const scanResult = await redis.scan(cursor, 'MATCH', 'OCS:TRAFFIC:TRAFFIC_*', 'COUNT', 1000);
      nextCursor = scanResult[0];
      matchedKeys = scanResult[1];
      scannedCount = matchedKeys.length;

      if (matchedKeys.length > 0) {
        const pipeline = redis.pipeline();
        matchedKeys.forEach(k => {
          const imsi = k.substring('OCS:TRAFFIC:TRAFFIC_'.length);
          pipeline.exists(`SUB_4G:${imsi}`);
        });

        const results = await pipeline.exec();
        if (results) {
          for (let i = 0; i < matchedKeys.length; i++) {
            const imsi = matchedKeys[i].substring('OCS:TRAFFIC:TRAFFIC_'.length);
            const [errExists, existsCount] = results[i];

            // 异常 B: 孤立计费数据 (Orphan OCS)
            if (Number(existsCount) === 0) {
              anomalies.push({ imsi, type: 'orphan_ocs', details: 'Found Active OCS but missing core SUB_4G definition' });
            }
          }
        }
      }
    }

    return NextResponse.json({
      nextCursor,
      scannedCount,
      anomalies
    });

  } catch (error) {
    console.error('Audit Engine API Failed:', error);
    return NextResponse.json({ error: 'Audit scan failed' }, { status: 500 });
  }
}
