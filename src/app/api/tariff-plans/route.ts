import { NextResponse } from 'next/server';
import { logAudit } from '@/lib/audit';
import { requireAuth, requirePermission } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { OCS_OPERATIONS, evaluateOcsOperation } from '@/server/ocsGovernanceRegistry';
import { createApprovalRequest } from '@/server/repositories/approvalRepository';
import { listTariffPlans } from '@/server/repositories/ocsBillingRepository';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const auth = requireAuth(request);
    if (!auth.ok) return auth.response;
    const rateLimit = await enforceRateLimit(`tariff-plans:list:${auth.auth.user}`, 90, 60);
    if (!rateLimit.ok) return rateLimit.response;
    return NextResponse.json({ plans: await listTariffPlans() });
  } catch (error) {
    console.error('Error fetching tariff plans:', error);
    return NextResponse.json({ error: 'Failed to fetch tariff plans' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const definition = evaluateOcsOperation(OCS_OPERATIONS.TARIFF_PLAN_CREATE);
  const auth = requirePermission(request, definition.permission);
  if (!auth.ok) return auth.response;
  if (!definition.executable) return NextResponse.json({ error: definition.disabledCode || 'OCS_OPERATION_NOT_SUPPORTED', code: definition.disabledCode || 'OCS_OPERATION_NOT_SUPPORTED' }, { status: 409 });
  const rateLimit = await enforceRateLimit(`tariff-plans:create:${auth.auth.user}`, 20, 60);
  if (!rateLimit.ok) return rateLimit.response;
  try {
    const plan = await request.json();
    const planId = typeof plan?.plan_id === 'string' ? plan.plan_id.trim() : '';
    if (!/^[a-zA-Z0-9_-]{3,80}$/.test(planId)) return NextResponse.json({ error: 'Invalid plan_id format' }, { status: 400 });
    const approval = await createApprovalRequest({
      action: 'TARIFF_PLAN_CREATE', requester: auth.auth.user, targetId: `tariff-plan:${planId}`,
      summary: `Create tariff plan ${planId}`, operation: { resourceType: 'ocs_tariff_plan', resourceId: planId },
      payload: { schema: 'ocs-tariff-plan-v1', plan },
    });
    logAudit('UPDATE', `approval:${approval.id}`, null, approval, request);
    return NextResponse.json({ outcome: 'approval_required', message: 'Approval required before tariff plan creation', approval }, { status: 202 });
  } catch (error) {
    console.error('Error creating tariff plan approval:', error);
    return NextResponse.json({ error: 'Failed to create tariff plan approval' }, { status: 500 });
  }
}
