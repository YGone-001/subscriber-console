import { NextResponse } from 'next/server';
import { logAudit } from '@/lib/audit';
import { requireCapability } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { validateImsiList } from '@/lib/subscriberValidation';
import { createApprovalRequest } from '@/server/repositories/approvalRepository';
import { evaluateSubscriberOperation, SUBSCRIBER_OPERATIONS } from '@/server/subscriberGovernanceRegistry';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const auth = requireCapability(request, 'subscriber_write');
  if (!auth.ok) return auth.response;

  const rateLimit = await enforceRateLimit(`subscribers:bulk-delete:${auth.auth.user}`, 10, 60);
  if (!rateLimit.ok) return rateLimit.response;

  try {
    const body = await request.json();
    const validation = validateImsiList(body?.imsiList);
    if (!validation.ok) return NextResponse.json({ error: validation.error }, { status: 400 });
    if (validation.value.length === 0) return NextResponse.json({ error: 'imsiList cannot be empty' }, { status: 400 });

    const policy = evaluateSubscriberOperation(SUBSCRIBER_OPERATIONS.BULK_DELETE);
    if (!policy.executable) return NextResponse.json({ error: 'OPERATION_NOT_EXECUTABLE' }, { status: 409 });
    const approval = await createApprovalRequest({
      action: 'SUBSCRIBER_BULK_DELETE', requester: auth.auth.user, targetId: 'subscriber:bulk-delete',
      summary: `Delete ${validation.value.length} subscriber(s)`,
      operation: { resourceType: 'subscriber_batch', resourceId: 'bulk-delete' },
      payload: { version: 'subscriber-bulk-delete-v1', imsiList: validation.value, targetCount: validation.value.length },
    });
    logAudit('UPDATE', `approval:${approval.id}`, null, approval, request);
    return NextResponse.json({ outcome: 'approval_required', message: 'Approval required before bulk subscriber deletion', approval }, { status: 202 });
  } catch (error) {
    console.error('Error bulk deleting subscribers:', error);
    return NextResponse.json({ error: 'Bulk subscriber delete failed' }, { status: 500 });
  }
}
