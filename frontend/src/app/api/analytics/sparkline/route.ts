import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { computeSparklineBasis } from '@/server/repositories/analyticsRepository';

export const dynamic = 'force-dynamic';

function generateTrend(current: number, points: number, variance: number): number[] {
  if (current === 0) {
    return Array.from({ length: points }, () => Math.floor(Math.random() * 3));
  }

  const result: number[] = [];
  const startVal = current * (1 - variance * points * 0.3);

  for (let i = 0; i < points; i++) {
    const progress = i / (points - 1);
    const baseVal = startVal + (current - startVal) * progress;
    const jitter = baseVal * variance * (Math.random() - 0.4);
    result.push(Math.max(0, Math.round(baseVal + jitter)));
  }

  result[points - 1] = current;
  return result;
}

export async function GET(request: Request) {
  try {
    const auth = requireAuth(request);
    if (!auth.ok) return auth.response;
    const rateLimit = await enforceRateLimit(`analytics:sparkline:${auth.auth.user}`, 120, 60);
    if (!rateLimit.ok) return rateLimit.response;

    const { currentSubCount, currentTraffic } = await computeSparklineBasis();
    return NextResponse.json({
      subscribers: generateTrend(currentSubCount, 24, 0.03),
      traffic: generateTrend(currentTraffic, 24, 0.05),
      currentSubCount,
      currentTraffic,
    });
  } catch (error) {
    console.error('Sparkline API error:', error);
    return NextResponse.json({ error: 'Failed to generate sparkline data' }, { status: 500 });
  }
}
