import { NextResponse } from 'next/server';
import { requireCapability } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { isApprovalStatus, listApprovals } from '@/server/repositories/approvalRepository';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const auth = requireCapability(request, 'user_admin');
  if (!auth.ok) return auth.response;

  const rateLimit = await enforceRateLimit(`approvals:list:${auth.auth.user}`, 60, 60);
  if (!rateLimit.ok) return rateLimit.response;

  const { searchParams } = new URL(request.url);
  const rawStatus = searchParams.get('status') || 'all';
  const status = rawStatus === 'all' || isApprovalStatus(rawStatus) ? rawStatus : 'all';
  const limit = Number(searchParams.get('limit') || 100);

  try {
    return NextResponse.json(await listApprovals({ status, limit }));
  } catch (error) {
    console.error('Error fetching approvals:', error);
    return NextResponse.json({ error: 'Failed to fetch approval requests' }, { status: 500 });
  }
}
