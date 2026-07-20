import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/rateLimit';
import { logAudit } from '@/lib/audit';
import { requireAuth, requireCapability } from '@/lib/authz';
import {
  createDefaultSubscriber,
  listSubscriberImsis,
  listSubscriberRows,
} from '@/server/repositories/subscriberRepository';
import { open5gsToLegacyState } from '@/lib/open5gsSubscriber';
import { validateImsi } from '@/lib/subscriberValidation';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const auth = requireAuth(request);
    if (!auth.ok) return auth.response;

    const rateLimit = await enforceRateLimit(`subscribers:list:${auth.auth.user}`, 120, 60);
    if (!rateLimit.ok) return rateLimit.response;

    const { searchParams } = new URL(request.url);
    const detail = searchParams.get('detail') === 'true';
    const page = parseInt(searchParams.get('page') || '1', 10);
    const limit = parseInt(searchParams.get('limit') || '50', 10);
    const query = searchParams.get('q') || '';

    const result = detail
      ? await listSubscriberRows(page, limit, query)
      : await listSubscriberImsis(page, limit, query);

    return NextResponse.json(result);
  } catch (error) {
    console.error('Error fetching subscribers:', error);
    return NextResponse.json({ error: 'Failed to fetch subscribers' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const auth = requireCapability(request, 'subscriber_write');
    if (!auth.ok) return auth.response;

    const rateLimit = await enforceRateLimit(`subscribers:create:${auth.auth.user}`, 30, 60);
    if (!rateLimit.ok) return rateLimit.response;

    const data = await request.json();
    const imsiResult = validateImsi(data?.imsi);
    if (!imsiResult.ok) return NextResponse.json({ error: imsiResult.error }, { status: 400 });
    const imsi = imsiResult.value;

    const created = await createDefaultSubscriber(imsi);
    const legacyState = open5gsToLegacyState(created);

    logAudit('CREATE', imsi, null, legacyState, request);

    return NextResponse.json({ message: 'Subscriber created successfully', imsi }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === 'SUBSCRIBER_EXISTS') {
      return NextResponse.json({ error: 'Subscriber already exists' }, { status: 409 });
    }

    console.error('Error creating subscriber:', error);
    return NextResponse.json({ error: 'Failed to create subscriber' }, { status: 500 });
  }
}
