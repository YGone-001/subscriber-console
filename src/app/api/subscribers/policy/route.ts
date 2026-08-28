import { NextResponse } from 'next/server';
import { logAudit } from '@/lib/audit';
import { requirePermission } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { validatePolicyChangePayload } from '@/lib/subscriberValidation';
import { createApprovalRequest } from '@/server/repositories/approvalRepository';
import { getTariffPlan } from '@/server/repositories/ocsBillingRepository';
import { OCS_OPERATIONS, evaluateOcsOperation } from '@/server/ocsGovernanceRegistry';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const definition = evaluateOcsOperation(OCS_OPERATIONS.PLAN_ASSIGN);
  const auth = requirePermission(request, definition.permission);
  if (!auth.ok) return auth.response;
  if (!definition.executable) return NextResponse.json({ error: definition.disabledCode || 'OCS_PLAN_ASSIGN_NOT_SUPPORTED', code: definition.disabledCode || 'OCS_PLAN_ASSIGN_NOT_SUPPORTED' }, { status: 409 });

  const rateLimit = await enforceRateLimit(`subscribers:policy:${auth.auth.user}`, 20, 60);
  if (!rateLimit.ok) return rateLimit.response;

  try {
    const body = await request.json();
    const validation = validatePolicyChangePayload(body);
    if (!validation.ok) return NextResponse.json({ error: validation.error }, { status: 400 });
    if (validation.value.resetBalances) return NextResponse.json({ error: 'Balance reset through policy assignment is disabled', code: 'OCS_BALANCE_RESET_DISABLED' }, { status: 409 });
    const plan = await getTariffPlan(validation.value.planId);
    if (!plan) return NextResponse.json({ error: 'Tariff plan not found' }, { status: 404 });
    if (plan.status === 'disabled') return NextResponse.json({ error: 'Tariff plan is disabled' }, { status: 409 });

    const uniqueImsis = Array.from(new Set(validation.value.imsiList));
    const approval = await createApprovalRequest({
      action: 'POLICY_CHANGE',
      requester: auth.auth.user,
      targetId: `policy:${validation.value.planId}`,
      summary: `${uniqueImsis.length} subscriber(s) -> ${validation.value.planId} (${validation.value.status})`,
      operation: { resourceType: 'ocs_plan_assignment', resourceId: validation.value.planId },
      payload: validation.value,
    });
    logAudit('UPDATE', `approval:${approval.id}`, null, approval, request);
    return NextResponse.json(
      { outcome: 'approval_required', message: 'Approval required before policy update', approval },
      { status: 202 }
    );

  } catch (error) {
    if (error instanceof Error && error.message === 'OCS_PLAN_NOT_FOUND') {
      return NextResponse.json({ error: 'Tariff plan not found' }, { status: 404 });
    }
    if (error instanceof Error && error.message === 'OCS_PLAN_DISABLED') {
      return NextResponse.json({ error: 'Tariff plan is disabled' }, { status: 409 });
    }

    console.error('Error changing subscriber policy:', error);
    return NextResponse.json({ error: 'Failed to change subscriber policy' }, { status: 500 });
  }
}
