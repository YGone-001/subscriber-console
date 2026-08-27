import { requirePermission } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { approveChange, rejectChange, workflowErrorResponse } from '@/server/approvalWorkflow';

export const dynamic = 'force-dynamic';
type RouteContext = { params: Promise<{ id: string }> };

/** Compatibility wrapper. New clients use the explicit approve/reject endpoints. */
export async function POST(request: Request, { params }: RouteContext) {
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  if (body.decision !== 'approve' && body.decision !== 'reject') {
    return Response.json({ error: 'INVALID_DECISION', code: 'INVALID_DECISION' }, { status: 400 });
  }
  const required = body.decision === 'approve' ? 'approvals.approve' : 'approvals.reject';
  const auth = requirePermission(request, required);
  if (!auth.ok) return auth.response;
  const rate = await enforceRateLimit(`approvals:legacy-review:${auth.auth.user}`, 40, 60);
  if (!rate.ok) return rate.response;
  const { id } = await params;
  try {
    if (body.decision === 'approve') return Response.json({ message: 'Approval recorded; execution has not started', approval: await approveChange(request, id, auth.auth, { comment: body.comment ?? body.note }) });
    return Response.json({ message: 'Approval rejected', approval: await rejectChange(request, id, auth.auth, { reason: body.reason ?? body.note }) });
  } catch (error) { return workflowErrorResponse(error); }
}
