import { NextResponse } from 'next/server';
import { requireAnyRole } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { precheckSubscriberRange } from '@/server/repositories/subscriberRepository';
import { validateBatchCount, validateImsi } from '@/lib/subscriberValidation';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const auth = requireAnyRole(request, ['root', 'operator']);
    if (!auth.ok) return auth.response;

    const rateLimit = await enforceRateLimit(`subscribers:batch-precheck:${auth.auth.user}`, 30, 60);
    if (!rateLimit.ok) return rateLimit.response;

    const body = await request.json();
    const { startImsi, count } = body;

    const imsiResult = validateImsi(startImsi, 'startImsi');
    if (!imsiResult.ok) return NextResponse.json({ error: imsiResult.error }, { status: 400 });
    const countResult = validateBatchCount(count);
    if (!countResult.ok) return NextResponse.json({ error: countResult.error }, { status: 400 });

    const result = await precheckSubscriberRange(imsiResult.value, countResult.value);
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    console.error('Error in batch precheck:', error);
    return NextResponse.json({ error: 'Pre-flight check failed' }, { status: 500 });
  }
}
