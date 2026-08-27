import { requirePermission } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { rejectChange, workflowErrorResponse } from '@/server/approvalWorkflow';

export const dynamic = 'force-dynamic';
type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: RouteContext) {
  const auth = requirePermission(request, 'approvals.reject');
  if (!auth.ok) return auth.response;
  const rate = await enforceRateLimit(`approvals:reject:${auth.auth.user}`, 40, 60);
  if (!rate.ok) return rate.response;
  try {
    const { id } = await params;
    return Response.json({ message: 'Approval rejected', approval: await rejectChange(request, id, auth.auth, await request.json().catch(() => ({}))) });
  } catch (error) { return workflowErrorResponse(error); }
}
