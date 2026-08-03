import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/rateLimit';
import { requireAuth } from '@/lib/authz';
import { listOcsBalances } from '@/server/repositories/ocsOperationsRepository';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const auth = requireAuth(request);
    if (!auth.ok) return auth.response;

    const rateLimit = await enforceRateLimit(`ocs:balances:${auth.auth.user}`, 120, 60);
    if (!rateLimit.ok) return rateLimit.response;

    const { searchParams } = new URL(request.url);
    const page = parseInt(searchParams.get('page') || '1', 10);
    const limit = parseInt(searchParams.get('limit') || '20', 10);
    const imsi = searchParams.get('imsi') || searchParams.get('q') || '';
    const planId = searchParams.get('planId') || '';
    const status = searchParams.get('status') || '';
    const invariant = searchParams.get('invariant') as 'all' | 'valid' | 'broken' || 'all';
    const sortField = searchParams.get('sortField') || searchParams.get('sort') || 'updated_at';
    const sortOrder = (searchParams.get('sortOrder') || searchParams.get('order') || 'desc') === 'asc' ? 'asc' : 'desc';

    const result = await listOcsBalances({
      page,
      limit,
      imsi,
      planId,
      status,
      invariantStatus: invariant,
      sortField,
      sortOrder,
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error('Error fetching OCS balances:', error);
    return NextResponse.json({ ok: false, error: 'Failed to fetch OCS balances' }, { status: 500 });
  }
}
