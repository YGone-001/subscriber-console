import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/rateLimit';
import { requireAuth } from '@/lib/authz';
import { listOcsReservations } from '@/server/repositories/ocsOperationsRepository';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const auth = requireAuth(request);
    if (!auth.ok) return auth.response;

    const rateLimit = await enforceRateLimit(`ocs:reservations:${auth.auth.user}`, 120, 60);
    if (!rateLimit.ok) return rateLimit.response;

    const { searchParams } = new URL(request.url);
    const page = parseInt(searchParams.get('page') || '1', 10);
    const limit = parseInt(searchParams.get('limit') || '20', 10);
    const imsi = searchParams.get('imsi') || searchParams.get('q') || '';
    const sessionId = searchParams.get('sessionId') || '';
    const state = searchParams.get('state') || 'all';
    const chargingType = searchParams.get('chargingType') || 'all';
    const sortField = searchParams.get('sortField') || searchParams.get('sort') || 'created_at';
    const sortOrder = (searchParams.get('sortOrder') || searchParams.get('order') || 'desc') === 'asc' ? 'asc' : 'desc';

    const result = await listOcsReservations({
      page,
      limit,
      imsi,
      sessionId,
      state,
      chargingType,
      sortField,
      sortOrder,
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error('Error fetching OCS reservations:', error);
    return NextResponse.json({ ok: false, error: 'Failed to fetch OCS reservations' }, { status: 500 });
  }
}
