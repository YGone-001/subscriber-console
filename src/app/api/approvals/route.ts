import { NextResponse } from 'next/server';
import { logAudit } from '@/lib/audit';
import { requireAuth } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { isSuperAdmin } from '@/lib/permissions';
import { getUser } from '@/server/repositories/userRepository';
import { createApprovalRequest, getPendingAccessRequest, isApprovalStatus, listApprovals } from '@/server/repositories/approvalRepository';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const auth = requireAuth(request);
  if (!auth.ok) return auth.response;

  const rateLimit = await enforceRateLimit(`approvals:list:${auth.auth.user}`, 60, 60);
  if (!rateLimit.ok) return rateLimit.response;

  const { searchParams } = new URL(request.url);
  const rawStatus = searchParams.get('status') || 'all';
  const status = rawStatus === 'all' || isApprovalStatus(rawStatus) ? rawStatus : 'all';
  const limit = Number(searchParams.get('limit') || 100);
  const requester = isSuperAdmin(auth.auth.role) ? searchParams.get('requester') || undefined : auth.auth.user;

  try {
    return NextResponse.json(await listApprovals({ status, limit, requester }));
  } catch (error) {
    console.error('Error fetching approvals:', error);
    return NextResponse.json({ error: 'Failed to fetch approval requests' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const auth = requireAuth(request);
  if (!auth.ok) return auth.response;

  const rateLimit = await enforceRateLimit(`approvals:access-request:${auth.auth.user}`, 6, 60);
  if (!rateLimit.ok) return rateLimit.response;

  const body = await request.json().catch(() => ({}));
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 300) : '';
  if (reason.length < 8) {
    return NextResponse.json({ error: 'Please provide an access justification of at least 8 characters' }, { status: 400 });
  }

  const user = await getUser(auth.auth.user);
  if (!user || user.status !== 'active') {
    return NextResponse.json({ error: 'Your account is not eligible for an access request' }, { status: 403 });
  }
  if (user.role !== 'viewer') {
    return NextResponse.json({ error: 'Your account already has operator-level or higher access' }, { status: 409 });
  }

  const existing = await getPendingAccessRequest(user.username);
  if (existing) {
    return NextResponse.json({ error: 'An access request is already pending', approval: existing }, { status: 409 });
  }

  try {
    const approval = await createApprovalRequest({
      action: 'ACCESS_REQUEST',
      requester: user.username,
      targetId: user.username,
      summary: 'Request viewer to operator access',
      payload: {
        currentRole: 'viewer',
        requestedRole: 'operator',
        reason,
      },
    });
    logAudit('CREATE', `ACCESS_REQUEST:${user.username}`, null, { approvalId: approval.id, requestedRole: 'operator' }, request);
    return NextResponse.json({ approval }, { status: 201 });
  } catch (error) {
    console.error('Failed to create access request:', error);
    return NextResponse.json({ error: 'Failed to submit access request' }, { status: 500 });
  }
}
