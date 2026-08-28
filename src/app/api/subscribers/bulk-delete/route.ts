import { NextResponse } from 'next/server';
import { logAudit } from '@/lib/audit';
import { requireCapability } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { validateImsiList } from '@/lib/subscriberValidation';
import { createApprovalRequest } from '@/server/repositories/approvalRepository';
import { evaluateSubscriberOperation, SUBSCRIBER_OPERATIONS } from '@/server/subscriberGovernanceRegistry';
import { prepareFrozenSubscriberBulkDelete, SubscriberGovernanceError } from '@/server/subscriberSingleGovernance';

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
    const frozen = await prepareFrozenSubscriberBulkDelete(validation.value);
    const approval = await createApprovalRequest({
      action: 'SUBSCRIBER_BULK_DELETE', requester: auth.auth.user, targetId: 'subscriber:bulk-delete',
      summary: `Delete ${validation.value.length} subscriber(s)`,
      operation: { resourceType: 'subscriber_batch', resourceId: 'bulk-delete' },
      operationFingerprint: frozen.operationFingerprint, before: { targetCount: frozen.targetCount, targets: frozen.targets },
      payload: frozen as unknown as Record<string, unknown>,
    });
    logAudit('UPDATE', `approval:${approval.id}`, null, approval, request);
    return NextResponse.json({ outcome: 'approval_required', message: 'Approval required before bulk subscriber deletion', approval }, { status: 202 });
  } catch (error) {
    if (error instanceof SubscriberGovernanceError && error.code === 'SUBSCRIBER_NOT_FOUND') return NextResponse.json({ error: 'Subscriber not found', details: error.details }, { status: 404 });
    console.error('Error bulk deleting subscribers:', error);
    return NextResponse.json({ error: 'Bulk subscriber delete failed' }, { status: 500 });
  }
}
