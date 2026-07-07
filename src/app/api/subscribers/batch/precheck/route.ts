import { NextResponse } from 'next/server';
import { requireAnyRole } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { precheckSubscriberRange } from '@/server/repositories/subscriberRepository';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const auth = requireAnyRole(request, ['root', 'operator']);
    if (!auth.ok) return auth.response;

    const rateLimit = await enforceRateLimit(`subscribers:batch-precheck:${auth.auth.user}`, 30, 60);
    if (!rateLimit.ok) return rateLimit.response;

    const body = await request.json();
    const { startImsi, count } = body;

    if (!startImsi || !count) {
      return NextResponse.json({ error: 'startImsi and count are required' }, { status: 400 });
    }
    if (!/^\d{15}$/.test(startImsi)) {
      return NextResponse.json({ error: 'startImsi must be strictly 15 digits' }, { status: 400 });
    }

    const numCount = Number(count);
    if (numCount <= 0 || numCount > 1000) {
      return NextResponse.json({ error: 'Count must be between 1 and 1000' }, { status: 400 });
    }

    const result = await precheckSubscriberRange(startImsi, numCount);
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    console.error('Error in batch precheck:', error);
    return NextResponse.json({ error: 'Pre-flight check failed' }, { status: 500 });
  }
}
