import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/rateLimit';
import { requireAuth } from '@/lib/authz';
import { listOcsUsageRecords } from '@/server/repositories/ocsOperationsRepository';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const auth = requireAuth(request);
    if (!auth.ok) return auth.response;

    const rateLimit = await enforceRateLimit(`ocs:usage:${auth.auth.user}`, 120, 60);
    if (!rateLimit.ok) return rateLimit.response;

    const { searchParams } = new URL(request.url);
    const page = parseInt(searchParams.get('page') || '1', 10);
    const limit = parseInt(searchParams.get('limit') || '20', 10);
    const imsi = searchParams.get('imsi') || searchParams.get('q') || '';
    const sessionId = searchParams.get('sessionId') || '';
    const apn = searchParams.get('apn') || '';
    const ccRequestType = searchParams.get('ccRequestType') || 'all';
    const chargedParam = searchParams.get('charged');
    const charged = chargedParam === 'true' ? true : chargedParam === 'false' ? false : undefined;
    const sortField = searchParams.get('sortField') || searchParams.get('sort') || 'created_at';
    const sortOrder = (searchParams.get('sortOrder') || searchParams.get('order') || 'desc') === 'asc' ? 'asc' : 'desc';

    const result = await listOcsUsageRecords({
      page,
      limit,
      imsi,
      sessionId,
      apn,
      ccRequestType,
      charged,
      sortField,
      sortOrder,
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error('Error fetching OCS usage records:', error);
    return NextResponse.json({ ok: false, error: 'Failed to fetch OCS usage records' }, { status: 500 });
  }
}
