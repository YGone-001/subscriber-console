import { NextResponse } from 'next/server';
import { logAudit } from '@/lib/audit';
import { requirePermission } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { OCS_OPERATIONS, evaluateOcsOperation } from '@/server/ocsGovernanceRegistry';
import { createApprovalRequest } from '@/server/repositories/approvalRepository';
import { getTariffPlan } from '@/server/repositories/ocsBillingRepository';

export const dynamic = 'force-dynamic';
type RouteContext = { params: Promise<{ planId: string }> };

export async function POST(request: Request, { params }: RouteContext) {
  const { planId } = await params;
  const definition = evaluateOcsOperation(OCS_OPERATIONS.TARIFF_PLAN_CREATE);
  const auth = requirePermission(request, definition.permission);
  if (!auth.ok) return auth.response;
  if (!definition.executable) return NextResponse.json({ error: definition.disabledCode || 'OCS_TARIFF_CREATE_NOT_SUPPORTED', code: definition.disabledCode || 'OCS_TARIFF_CREATE_NOT_SUPPORTED' }, { status: 409 });
  const rateLimit = await enforceRateLimit(`tariff-plans:clone:${auth.auth.user}`, 20, 60);
  if (!rateLimit.ok) return rateLimit.response;
  try {
    const body = await request.json();
    const targetPlanId = body.targetPlanId || body.target_plan_id || body.newPlanId || body.plan_id;
    if (typeof targetPlanId !== 'string' || !/^[a-zA-Z0-9_-]{3,80}$/.test(targetPlanId)) return NextResponse.json({ error: 'Invalid target plan_id format' }, { status: 400 });
    const sourcePlan = await getTariffPlan(planId);
    if (!sourcePlan) return NextResponse.json({ error: 'Source tariff plan not found' }, { status: 404 });
    const approval = await createApprovalRequest({
      action: 'TARIFF_PLAN_CREATE', requester: auth.auth.user, targetId: `tariff-plan:${targetPlanId}`,
      summary: `Clone tariff plan ${planId} as ${targetPlanId}`, operation: { resourceType: 'ocs_tariff_plan', resourceId: targetPlanId },
      before: { sourcePlan }, payload: { schema: 'ocs-tariff-plan-v1', plan: { plan_id: targetPlanId, name: body.name, description: body.description, cloneFromPlanId: planId } },
    });
    logAudit('UPDATE', `approval:${approval.id}`, null, approval, request);
    return NextResponse.json({ outcome: 'approval_required', message: 'Approval required before tariff plan clone', approval }, { status: 202 });
  } catch (error) {
    console.error('Error creating tariff plan clone approval:', error);
    return NextResponse.json({ error: 'Failed to create tariff plan clone approval' }, { status: 500 });
  }
}
