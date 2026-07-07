import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/rateLimit';
import { requireAuth } from '@/lib/authz';
import { listAlerts } from '@/server/repositories/alertRepository';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const auth = requireAuth(request);
    if (!auth.ok) return auth.response;

    const rateLimit = await enforceRateLimit(`alerts:list:${auth.auth.user}`, 120, 60);
    if (!rateLimit.ok) return rateLimit.response;

    return NextResponse.json(await listAlerts(101));
  } catch (error) {
    console.error('Alert fetch failed:', error);
    return NextResponse.json({ error: 'Alert fetch failed' }, { status: 500 });
  }
}
