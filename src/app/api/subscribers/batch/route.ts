import { NextResponse } from 'next/server';
import { logAudit } from '@/lib/audit';
import { requireCapability } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { createApprovalRequest } from '@/server/repositories/approvalRepository';
import { getTariffPlan } from '@/server/repositories/ocsBillingRepository';
import { validateBatchCreatePayload } from '@/lib/subscriberValidation';

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

    // High-risk batch writes never have a root/super-admin direct-execution path.
    const approval = await createApprovalRequest({
      action: 'SUBSCRIBER_BATCH_CREATE',
      requester: auth.auth.user,
      targetId: `subscriber:batch:${payload.startImsi}`,
      summary: `Batch create ${payload.count} subscriber(s) from ${payload.startImsi}`,
      payload,
    });

    logAudit('UPDATE', `approval:${approval.id}`, null, approval, request);
    return NextResponse.json(
      { message: 'Approval required before batch subscriber creation', approval, requiresApproval: true },
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
