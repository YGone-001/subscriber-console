import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/rateLimit';
import { logAudit } from '@/lib/audit';
import { requireAuth, requireCapability } from '@/lib/authz';
import {
  createDefaultSubscriber,
  findSubscriberByMsisdn,
  listSubscriberImsis,
  listSubscriberRows,
  type SubscriberStatusFilter,
} from '@/server/repositories/subscriberRepository';
import { xcloudToLegacyState } from '@/lib/xcloudSubscriber';
import { validateImsi } from '@/lib/subscriberValidation';
import { evaluateSubscriberOperation, SUBSCRIBER_OPERATIONS } from '@/server/subscriberGovernanceRegistry';

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
    const status = searchParams.get('status') || 'all';
    const sortField = searchParams.get('sortField') || searchParams.get('sort') || 'imsi';
    const sortDirection = (searchParams.get('sortDirection') || searchParams.get('sortDir') || searchParams.get('order') || 'asc') === 'desc' ? 'desc' : 'asc';
    const msisdn = searchParams.get('msisdn') || '';
    const excludeImsi = searchParams.get('excludeImsi') || undefined;
    const statusFilter: SubscriberStatusFilter = (
      status === 'active' ||
      status === 'restricted' ||
      status === 'lowTraffic'
    ) ? status : 'all';

    if (msisdn) {
      if (!/^\d+$/.test(msisdn)) {
        return NextResponse.json({ error: 'MSISDN must contain digits only' }, { status: 400 });
      }
      const existing = await findSubscriberByMsisdn(msisdn, excludeImsi);
      return NextResponse.json({
        exists: !!existing,
        imsi: existing?.imsi || null,
        source: existing?.source || null,
      });
    }

    const result = detail
      ? await listSubscriberRows(page, limit, query, statusFilter, sortField, sortDirection)
      : await listSubscriberImsis(page, limit, query, sortDirection);

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
    const policy = evaluateSubscriberOperation(SUBSCRIBER_OPERATIONS.CREATE);
    if (!policy.allowed || policy.requiresApproval || !policy.executable) {
      return NextResponse.json({ error: 'OPERATION_NOT_EXECUTABLE' }, { status: 409 });
    }
    const imsiResult = validateImsi(data?.imsi);
    if (!imsiResult.ok) return NextResponse.json({ error: imsiResult.error }, { status: 400 });
    const imsi = imsiResult.value;

    const msisdn = data?.msisdn === undefined || data?.msisdn === null ? '' : String(data.msisdn).trim();
    if (msisdn && !/^\d+$/.test(msisdn)) {
      return NextResponse.json({ error: 'MSISDN must contain digits only' }, { status: 400 });
    }

    const created = await createDefaultSubscriber(imsi, data?.planId || data?.plan_id, msisdn);
    const legacyState = xcloudToLegacyState(created);

    logAudit('CREATE', imsi, null, legacyState, request);

    return NextResponse.json({ outcome: 'executed', message: 'Subscriber created successfully', imsi }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === 'SUBSCRIBER_EXISTS') {
      return NextResponse.json({ error: 'Subscriber already exists' }, { status: 409 });
    }
    if (error instanceof Error && error.message === 'MSISDN_EXISTS') {
      return NextResponse.json({ error: 'MSISDN already exists' }, { status: 409 });
    }
    if (error instanceof Error && error.message === 'INVALID_PLAN_ID') {
      return NextResponse.json({ error: 'Invalid plan_id format' }, { status: 400 });
    }
    if (error instanceof Error && error.message === 'OCS_PLAN_NOT_FOUND') {
      return NextResponse.json({ error: 'Tariff plan not found' }, { status: 404 });
    }
    if (error instanceof Error && error.message === 'OCS_PLAN_DISABLED') {
      return NextResponse.json({ error: 'Tariff plan is disabled' }, { status: 409 });
    }

    console.error('Error creating subscriber:', error);
    return NextResponse.json({ error: 'Failed to create subscriber' }, { status: 500 });
  }
}
