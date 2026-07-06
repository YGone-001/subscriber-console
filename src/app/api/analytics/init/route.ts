import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';
import { requireAnyRole } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const auth = requireAnyRole(request, ['root', 'operator']);
  if (!auth.ok) return auth.response;
  const rateLimit = await enforceRateLimit(`analytics:init:${auth.auth.user}`, 3, 300);
  if (!rateLimit.ok) return rateLimit.response;

  // Fire and forget script immediately prevents request timeout and avoids blocking main thread
  setTimeout(async () => {
    try {
      console.log("[Analytics Init] Starting background backfill scan...");

      let cursor = '0';
      let totalTraffic = 0;
      const plmnMap: Record<string, number> = {};
      const rateMap: Record<string, number> = {};
      const leaderboard: { score: number, member: string }[] = [];

      do {
        // NON-BLOCKING Iterate over all TRAFFIC table records globally (1000 per block)
        const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', 'OCS:TRAFFIC:TRAFFIC_*', 'COUNT', 1000);
        cursor = nextCursor;

        if (keys.length > 0) {
          const pipeline = redis.pipeline();
          keys.forEach(k => pipeline.get(k));
          const results = await pipeline.exec();

          if (results) {
            results.forEach(([err, val]) => {
              if (!err && val) {
                 try {
                   const tObj = JSON.parse(val as string);
                   const balance = Number(tObj.traffic_balance || 0);
                   const plmn = tObj.plmn || '45400';
                   const imsi = tObj.imsi;

                   if (balance > 0) {
                     totalTraffic += balance;
                     plmnMap[plmn] = (plmnMap[plmn] || 0) + balance;

                     if (imsi) {
                       leaderboard.push({ score: balance, member: imsi });
                     }
                   }
                 } catch (e) {
                   // Parse drop
                 }
              }
            });
          }
        }
      } while (cursor !== '0');

      console.log(`[Analytics Init] TRAFFIC SCAN Complete. Starting IMSI_SET SCAN...`);

      // SECOND SCAN: OCS:IMSI_SET For Rating Distribution Coverage
      let setCursor = '0';
      do {
        const [nextCursor, keys] = await redis.scan(setCursor, 'MATCH', 'OCS:IMSI:IMSI_SET_*', 'COUNT', 1000);
        setCursor = nextCursor;

        if (keys.length > 0) {
          const pipeline = redis.pipeline();
          keys.forEach(k => pipeline.get(k));
          const results = await pipeline.exec();

          if (results) {
            results.forEach(([err, val]) => {
              if (!err && val) {
                 try {
                   const sObj = JSON.parse(val as string);
                   if (sObj.rates_map) {
                     const rateId = Object.values(sObj.rates_map)[0];
                     if (rateId !== undefined && rateId !== null) {
                       rateMap[String(rateId)] = (rateMap[String(rateId)] || 0) + 1;
                     }
                   }
                 } catch (e) {
                   // Parse drop
                 }
              }
            });
          }
        }
      } while (setCursor !== '0');

      console.log(`[Analytics Init] SCANS Complete. Committing Aggregates to Redis...`);

      // Flush to Redis via atomic multi
      const flushPipe = redis.pipeline();
      flushPipe.del('STATS:GLOBAL:TOTAL_TRAFFIC');
      flushPipe.del('STATS:PLMN_TRAFFIC');
      flushPipe.del('STATS:RATES_COUNT');
      flushPipe.del('STATS:TRAFFIC:LEADERBOARD');

      flushPipe.set('STATS:GLOBAL:TOTAL_TRAFFIC', totalTraffic);

      for (const [k, v] of Object.entries(plmnMap)) {
        flushPipe.hset('STATS:PLMN_TRAFFIC', k, v);
      }

      for (const [k, v] of Object.entries(rateMap)) {
        flushPipe.hset('STATS:RATES_COUNT', k, v);
      }

      // Sort and slice top 5 to write to leaderboard natively
      leaderboard.sort((a, b) => b.score - a.score);
      const top5 = leaderboard.slice(0, 5);
      top5.forEach(entry => {
         flushPipe.zadd('STATS:TRAFFIC:LEADERBOARD', entry.score, entry.member);
      });

      await flushPipe.exec();
      console.log("[Analytics Init] Successfully Initialized Real-time Analytics Engine.");
    } catch (e) {
      console.error("[Analytics Init] Catastrophic failure during background sync:", e);
    }
  }, 0);

  return NextResponse.json({
    message: "Init script dispatched to background correctly. Proceed to monitor dashboard. Do NOT run recurrently."
  });
}
