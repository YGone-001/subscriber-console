import { requirePermission } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { executeApprovedChange, executionErrorResponse } from '@/server/approvalExecution';

export const dynamic = 'force-dynamic';
type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: RouteContext) {
  const auth = requirePermission(request, 'approvals.execute');
  if (!auth.ok) return auth.response;
  const rate = await enforceRateLimit(`approvals:execute:${auth.auth.user}`, 20, 60);
  if (!rate.ok) return rate.response;
  try {
    const { id } = await params;
    const approval = await executeApprovedChange(request, id, auth.auth);
    return Response.json({ message: approval.status === 'completed' ? 'Execution completed' : 'Execution failed', approval }, { status: approval.status === 'completed' ? 200 : 409 });
  } catch (error) { return executionErrorResponse(error); }
}
