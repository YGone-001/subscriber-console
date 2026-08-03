import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { getComprehensiveSystemHealth } from '@/server/repositories/systemHealthRepository';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  const auth = requireAuth(request);
  if (!auth.ok) return auth.response;

  const rateLimit = await enforceRateLimit(`system:health:${auth.auth.user}`, 30, 60);
  if (!rateLimit.ok) return rateLimit.response;

  try {
    const health = await getComprehensiveSystemHealth();
    return NextResponse.json(health, { status: 200 });
  } catch (error) {
    console.error('System health check failed:', error);
    return NextResponse.json(
      {
        status: 'critical',
        score: 0,
        checkedAt: new Date().toISOString(),
        error: 'Comprehensive system health check failed',
      },
      { status: 500 }
    );
  }
}
