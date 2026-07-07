import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { computeAnalyticsMetrics } from '@/server/repositories/analyticsRepository';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const auth = requireAuth(request);
    if (!auth.ok) return auth.response;
    const rateLimit = await enforceRateLimit(`analytics:metrics:${auth.auth.user}`, 120, 60);
    if (!rateLimit.ok) return rateLimit.response;

    return NextResponse.json(await computeAnalyticsMetrics());
  } catch (error) {
    console.error('Analytics fetch error:', error);
    return NextResponse.json({ error: 'Internal fetch failed' }, { status: 500 });
  }
}
