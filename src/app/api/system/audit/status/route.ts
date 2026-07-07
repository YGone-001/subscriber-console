import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const auth = requireAuth(request);
    if (!auth.ok) return auth.response;
    const rateLimit = await enforceRateLimit(`system:audit-status:${auth.auth.user}`, 60, 60);
    if (!rateLimit.ok) return rateLimit.response;

    return NextResponse.json({ lastSaveTime: Math.floor(Date.now() / 1000) }, { status: 200 });
  } catch (error) {
    console.error('Failed to get system status:', error);
    return NextResponse.json({ error: 'Failed to retrieve system status' }, { status: 500 });
  }
}
