import { NextResponse } from 'next/server';
import { requireAnyRole } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { computeAnalyticsMetrics } from '@/server/repositories/analyticsRepository';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const auth = requireAnyRole(request, ['root', 'operator']);
  if (!auth.ok) return auth.response;
  const rateLimit = await enforceRateLimit(`analytics:init:${auth.auth.user}`, 3, 300);
  if (!rateLimit.ok) return rateLimit.response;

  const metrics = await computeAnalyticsMetrics();
  return NextResponse.json({
    message: 'MongoDB analytics are computed from subscriber documents on demand.',
    metrics,
  });
}
