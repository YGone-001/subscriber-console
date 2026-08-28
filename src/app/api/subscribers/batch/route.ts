import { NextResponse } from 'next/server';
import { logAudit } from '@/lib/audit';
import { requireCapability } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { createApprovalRequest } from '@/server/repositories/approvalRepository';
import { getTariffPlan } from '@/server/repositories/ocsBillingRepository';
import { validateBatchCreatePayload } from '@/lib/subscriberValidation';
import { precheckSubscriberRange } from '@/server/repositories/subscriberRepository';
import { createHash } from 'node:crypto';
import { evaluateSubscriberOperation, SUBSCRIBER_OPERATIONS } from '@/server/subscriberGovernanceRegistry';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const auth = requireCapability(request, 'subscriber_write');
  if (!auth.ok) return auth.response;

  const rateLimit = await enforceRateLimit(`subscribers:batch:${auth.auth.user}`, 10, 60);
  if (!rateLimit.ok) return rateLimit.response;

  try {
    const body = await request.json();
    const validation = validateBatchCreatePayload(body);
    if (!validation.ok) return NextResponse.json({ error: validation.error }, { status: 400 });
    const payload = validation.value;
    const plan = await getTariffPlan(payload.planId);
    if (!plan) return NextResponse.json({ error: 'Tariff plan not found' }, { status: 404 });
    if (plan.status === 'disabled') return NextResponse.json({ error: 'Tariff plan is disabled' }, { status: 409 });

    const policy = evaluateSubscriberOperation(SUBSCRIBER_OPERATIONS.BATCH_CREATE);
    if (!policy.executable) return NextResponse.json({ error: 'OPERATION_NOT_EXECUTABLE' }, { status: 409 });
    const precheck = await precheckSubscriberRange(payload.startImsi, payload.count);
    if (precheck.conflictCount > 0) {
      return NextResponse.json({ error: 'SUBSCRIBER_CREATE_PRECONDITION_CHANGED', conflictCount: precheck.conflictCount, conflictImsis: precheck.conflictImsis.slice(0, 20) }, { status: 409 });
    }
    const frozenPayload = {
      version: 'subscriber-batch-create-v1' as const,
      ...payload,
      // Approval execution is create-only regardless of a legacy UI's
      // overwrite selection. Existing subscriptions are never replaced.
      strategy: 'skip' as const,
      expectedAbsentImsis: Array.from({ length: payload.count }, (_, index) => (BigInt(payload.startImsi) + BigInt(index)).toString()),
    };
    const operationFingerprint = createHash('sha256').update(JSON.stringify({ action: 'SUBSCRIBER_BATCH_CREATE', targets: frozenPayload.expectedAbsentImsis, payload: { ...payload, strategy: 'create-only' } })).digest('hex');

    // High-risk batch writes never have a root/super-admin direct-execution path.
    const approval = await createApprovalRequest({
      action: 'SUBSCRIBER_BATCH_CREATE',
      requester: auth.auth.user,
      targetId: `subscriber:batch:${payload.startImsi}`,
      summary: `Batch create ${payload.count} subscriber(s) from ${payload.startImsi}`,
      payload: frozenPayload,
      operation: { resourceType: 'subscriber_batch', resourceId: payload.startImsi },
      operationFingerprint,
    });

    logAudit('UPDATE', `approval:${approval.id}`, null, approval, request);
    return NextResponse.json(
      { outcome: 'approval_required', message: 'Approval required before batch subscriber creation', approval, requiresApproval: true },
      { status: 202 }
    );
  } catch (error) {
    if (error instanceof Error && error.message === 'IMSI_RANGE_OVERFLOW') {
      return NextResponse.json({ error: 'Generated IMSI range exceeds 15 digits' }, { status: 400 });
    }
    if (error instanceof Error && error.message === 'INVALID_PLAN_ID') {
      return NextResponse.json({ error: 'Invalid plan_id format' }, { status: 400 });
    }
    if (error instanceof Error && error.message === 'OCS_PLAN_NOT_FOUND') {
      return NextResponse.json({ error: 'Tariff plan not found' }, { status: 404 });
    }
    if (error instanceof Error && error.message === 'OCS_PLAN_DISABLED') {
      return NextResponse.json({ error: 'Tariff plan is disabled' }, { status: 409 });
    }

    console.error('Error in batch creation:', error);
    return NextResponse.json({ error: 'Batch creation failed' }, { status: 500 });
  }
}
