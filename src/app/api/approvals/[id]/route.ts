import { NextResponse } from 'next/server';
import { logAudit } from '@/lib/audit';
import { requireCapability } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { executeApproval } from '@/server/approvalExecutors';
import { getApproval, transitionApproval } from '@/server/repositories/approvalRepository';

export const dynamic = 'force-dynamic';

type RouteContext = {
  params: Promise<{ id: string }>;
};

function approvalErrorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  if (message === 'OCS_PLAN_NOT_FOUND') {
    return NextResponse.json({ error: 'Tariff plan not found' }, { status: 404 });
  }
  if (message === 'OCS_BALANCE_NOT_FOUND') {
    return NextResponse.json({ error: 'OCS balance not found' }, { status: 404 });
  }
  if (message === 'OCS_BALANCE_CONFLICT') {
    return NextResponse.json({ error: 'Traffic balance changed, please refresh and retry' }, { status: 409 });
  }
  if (message === 'OCS_TOTAL_BELOW_COMMITTED') {
    return NextResponse.json({ error: 'Total quota cannot be lower than used plus reserved traffic' }, { status: 400 });
  }
  if (message === 'RATING_EXISTS') {
    return NextResponse.json({ error: 'Rating Group ID already exists' }, { status: 409 });
  }
  if (message.startsWith('Cannot delete: Rating group')) {
    return NextResponse.json({ error: message }, { status: 409 });
  }
  if (message) {
    return NextResponse.json({ error: message }, { status: 400 });
  }
  return NextResponse.json({ error: 'Failed to execute approval request' }, { status: 500 });
}

export async function POST(request: Request, { params }: RouteContext) {
  const auth = requireCapability(request, 'approval_review');
  if (!auth.ok) return auth.response;

  const rateLimit = await enforceRateLimit(`approvals:review:${auth.auth.user}`, 40, 60);
  if (!rateLimit.ok) return rateLimit.response;

  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const decision = body?.decision === 'reject' ? 'reject' : 'approve';
  const note = typeof body?.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 300) : undefined;

  const approval = await getApproval(id);
  if (!approval) return NextResponse.json({ error: 'Approval request not found' }, { status: 404 });
  if (approval.requester === auth.auth.user) {
    return NextResponse.json({ error: 'Requester cannot review their own change' }, { status: 403 });
  }
  if (approval.status !== 'pending') {
    return NextResponse.json({ error: 'Approval request is no longer pending', approval }, { status: 409 });
  }

  if (decision === 'reject') {
    const rejected = await transitionApproval(id, 'rejected', auth.auth.user, { note });
    logAudit('UPDATE', `approval:${id}`, approval, rejected, request);
    return NextResponse.json({ message: 'Approval request rejected', approval: rejected });
  }

  const executionAuth = requireCapability(request, 'approval_execute');
  if (!executionAuth.ok) return executionAuth.response;

  const approved = await transitionApproval(id, 'approved', auth.auth.user, { note });
  if (!approved) return NextResponse.json({ error: 'Approval request not found' }, { status: 404 });
  logAudit('UPDATE', `approval:${id}`, approval, approved, request);

  try {
    const result = await executeApproval(approved, request);
    const executed = await transitionApproval(id, 'executed', auth.auth.user, { result });
    logAudit('UPDATE', `approval:${id}`, approved, executed, request);
    return NextResponse.json({ message: 'Approval request executed', approval: executed, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to execute approval request';
    const failed = await transitionApproval(id, 'failed', auth.auth.user, { error: message });
    logAudit('UPDATE', `approval:${id}`, approved, failed, request);
    return approvalErrorResponse(error);
  }
}
