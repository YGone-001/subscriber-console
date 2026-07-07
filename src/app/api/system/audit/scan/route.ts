import { NextResponse } from 'next/server';
import { requireAnyRole } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { scanSubscriberDocuments } from '@/server/repositories/systemAuditRepository';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const auth = requireAnyRole(request, ['root', 'operator']);
    if (!auth.ok) return auth.response;
    const rateLimit = await enforceRateLimit(`system:audit-scan:${auth.auth.user}`, 30, 60);
    if (!rateLimit.ok) return rateLimit.response;

    const { cursor = '0', phase = 'sub' } = await request.json();
    return NextResponse.json(await scanSubscriberDocuments(cursor, phase));
  } catch (error) {
    console.error('Audit engine API failed:', error);
    return NextResponse.json({ error: 'Audit scan failed' }, { status: 500 });
  }
}
