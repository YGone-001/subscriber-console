import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';
import { requireAuth } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const auth = requireAuth(request);
    if (!auth.ok) return auth.response;
    const rateLimit = await enforceRateLimit(`analytics:metrics:${auth.auth.user}`, 120, 60);
    if (!rateLimit.ok) return rateLimit.response;

    const pipeline = redis.pipeline();
    pipeline.get('STATS:GLOBAL:TOTAL_TRAFFIC');
    pipeline.hgetall('STATS:PLMN_TRAFFIC');
    pipeline.hgetall('STATS:RATES_COUNT');
    pipeline.zrevrange('STATS:TRAFFIC:LEADERBOARD', 0, 4, 'WITHSCORES');

    // Calculate global thresholds / consumption
    // If not using actual timeseries logic, we use a simple heuristic to populate metrics

    const results = await pipeline.exec();

    if (!results) {
       return NextResponse.json({ error: 'Metrics fetch failed' }, { status: 500 });
    }

    const totalTrafficRaw = results[0][1];
    const totalTraffic = Number(totalTrafficRaw || 0);

    const plmnRaw = results[1][1] as Record<string, string>;
    const plmnDist = Object.keys(plmnRaw || {}).map(k => ({ name: k, value: Number(plmnRaw[k]) }));

    const ratesRaw = results[2][1] as Record<string, string>;
    const ratesDist = Object.keys(ratesRaw || {}).map(k => ({ name: `Group #${k}`, value: Number(ratesRaw[k]) }));

    const top5Raw = results[3][1] as string[];
    const top5 = [];
    if (top5Raw) {
      for (let i = 0; i < top5Raw.length; i += 2) {
         top5.push({ imsi: top5Raw[i], balance: Number(top5Raw[i + 1]) });
      }
    }

    return NextResponse.json({
      totalTraffic,
      plmnDist,
      ratesDist,
      top5,
      timestamp: Date.now()
    });

  } catch (error) {
    console.error('Analytics Fetch Error:', error);
    return NextResponse.json({ error: 'Internal fetch failed' }, { status: 500 });
  }
}
