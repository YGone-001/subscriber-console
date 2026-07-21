import { NextResponse } from 'next/server';
import { logAudit } from '@/lib/audit';
import { requireAuth, requireCapability } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import {
  deleteSubscriber,
  findSubscriberLegacyState,
  updateSubscriberFromLegacy,
} from '@/server/repositories/subscriberRepository';
import { open5gsToLegacyState } from '@/lib/open5gsSubscriber';
import { validateImsi, validateSubscriberUpdatePayload } from '@/lib/subscriberValidation';

export const dynamic = 'force-dynamic';

type RouteContext = {
  params: Promise<{ imsi: string }>;
};

export async function GET(request: Request, { params }: RouteContext) {
  const { imsi } = await params;
  const auth = requireAuth(request);
  if (!auth.ok) return auth.response;

  const rateLimit = await enforceRateLimit(`subscribers:detail:${auth.auth.user}`, 180, 60);
  if (!rateLimit.ok) return rateLimit.response;

  const imsiResult = validateImsi(imsi);
  if (!imsiResult.ok) return NextResponse.json({ error: imsiResult.error }, { status: 400 });

  try {
    const state = await findSubscriberLegacyState(imsi);
    if (!state) {
      return NextResponse.json({ error: 'Subscriber not found' }, { status: 404 });
    }

    return NextResponse.json(state);
  } catch (error) {
    console.error('Error fetching subscriber:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: RouteContext) {
  const { imsi } = await params;
  const auth = requireCapability(request, 'subscriber_write');
  if (!auth.ok) return auth.response;

  const rateLimit = await enforceRateLimit(`subscribers:delete:${auth.auth.user}`, 30, 60);
  if (!rateLimit.ok) return rateLimit.response;

  const imsiResult = validateImsi(imsi);
  if (!imsiResult.ok) return NextResponse.json({ error: imsiResult.error }, { status: 400 });

  try {
    const oldState = await findSubscriberLegacyState(imsi);
    const deleted = await deleteSubscriber(imsi);

    if (!deleted) {
      return NextResponse.json({ error: 'Subscriber not found' }, { status: 404 });
    }

    logAudit('DELETE', imsi, oldState, null, request);

    return NextResponse.json({ message: 'Subscriber deleted successfully' });
  } catch (error) {
    console.error('Error deleting subscriber:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function PUT(request: Request, { params }: RouteContext) {
  const { imsi } = await params;
  const auth = requireCapability(request, 'subscriber_write');
  if (!auth.ok) return auth.response;

  const rateLimit = await enforceRateLimit(`subscribers:update:${auth.auth.user}`, 60, 60);
  if (!rateLimit.ok) return rateLimit.response;

  const imsiResult = validateImsi(imsi);
  if (!imsiResult.ok) return NextResponse.json({ error: imsiResult.error }, { status: 400 });

  try {
    const body = await request.json();
    const validation = validateSubscriberUpdatePayload(body);
    if (!validation.ok) return NextResponse.json({ error: validation.error }, { status: 400 });
    const oldState = await findSubscriberLegacyState(imsi);
    if (!oldState) {
      return NextResponse.json({ error: 'Subscriber not found' }, { status: 404 });
    }
    const updated = await updateSubscriberFromLegacy(imsi, {
      sub4G: body.sub4G,
      auth4G: body.auth4G,
      ocsTraffic: body.ocsTraffic,
    });
    const newState = open5gsToLegacyState(updated);

    logAudit('UPDATE', imsi, oldState, newState, request);

    return NextResponse.json({ message: 'Subscriber updated successfully' });
  } catch (error) {
    console.error('Error updating subscriber:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
