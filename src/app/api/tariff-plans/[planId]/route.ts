import { NextResponse } from 'next/server';
import { logAudit } from '@/lib/audit';
import { requireAuth, requirePermission } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import {
  getTariffPlan,
} from '@/server/repositories/ocsBillingRepository';
import { OCS_OPERATIONS, evaluateOcsOperation } from '@/server/ocsGovernanceRegistry';
import { createApprovalRequest } from '@/server/repositories/approvalRepository';

export const dynamic = 'force-dynamic';

type RouteContext = {
  params: Promise<{ planId: string }>;
};

export async function GET(request: Request, { params }: RouteContext) {
  const { planId } = await params;
  const auth = requireAuth(request);
  if (!auth.ok) return auth.response;

  const rateLimit = await enforceRateLimit(`tariff-plans:detail:${auth.auth.user}`, 120, 60);
  if (!rateLimit.ok) return rateLimit.response;

  try {
    const plan = await getTariffPlan(planId);
    if (!plan) return NextResponse.json({ error: 'Tariff plan not found' }, { status: 404 });
    return NextResponse.json({ plan });
  } catch (error) {
    if (error instanceof Error && error.message === 'INVALID_PLAN_ID') {
      return NextResponse.json({ error: 'Invalid plan_id format' }, { status: 400 });
    }

    console.error('Error fetching tariff plan:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function PUT(request: Request, { params }: RouteContext) {
  const { planId } = await params;
  const definition = evaluateOcsOperation(OCS_OPERATIONS.TARIFF_PLAN_UPDATE);
  const auth = requirePermission(request, definition.permission);
  if (!auth.ok) return auth.response;

  const rateLimit = await enforceRateLimit(`tariff-plans:update:${auth.auth.user}`, 30, 60);
  if (!rateLimit.ok) return rateLimit.response;

  try {
    const changes = await request.json();
    const before = await getTariffPlan(planId);
    if (!before) return NextResponse.json({ error: 'Tariff plan not found' }, { status: 404 });
    const approval = await createApprovalRequest({
      action: 'TARIFF_PLAN_UPDATE', requester: auth.auth.user, targetId: `tariff-plan:${planId}`,
      summary: `Update tariff plan ${planId}`, operation: { resourceType: 'ocs_tariff_plan', resourceId: planId }, before,
      payload: { schema: 'ocs-tariff-plan-v1', planId, changes },
    });
    logAudit('UPDATE', `approval:${approval.id}`, null, approval, request);
    return NextResponse.json({ outcome: 'approval_required', message: 'Approval required before tariff plan update', approval }, { status: 202 });
  } catch (error) {
    if (error instanceof Error && error.message === 'INVALID_PLAN_ID') {
      return NextResponse.json({ error: 'Invalid plan_id format' }, { status: 400 });
    }
    if (error instanceof Error && error.message === 'TARIFF_PLAN_DISABLE_IN_USE') {
      return NextResponse.json(
        { error: 'Cannot disable: tariff plan is currently used by subscribers' },
        { status: 409 }
      );
    }

    console.error('Error updating tariff plan:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: RouteContext) {
  const { planId } = await params;
  const definition = evaluateOcsOperation(OCS_OPERATIONS.TARIFF_PLAN_DELETE);
  const auth = requirePermission(request, definition.permission);
  if (!auth.ok) return auth.response;

  const rateLimit = await enforceRateLimit(`tariff-plans:delete:${auth.auth.user}`, 20, 60);
  if (!rateLimit.ok) return rateLimit.response;

  try {
    const before = await getTariffPlan(planId);
    if (!before) return NextResponse.json({ error: 'Tariff plan not found' }, { status: 404 });

    const approval = await createApprovalRequest({
      action: 'TARIFF_PLAN_DELETE', requester: auth.auth.user, targetId: `tariff-plan:${planId}`,
      summary: `Delete tariff plan ${planId}`, operation: { resourceType: 'ocs_tariff_plan', resourceId: planId }, before,
      payload: { schema: 'ocs-tariff-plan-v1', planId },
    });
    logAudit('UPDATE', `approval:${approval.id}`, null, approval, request);
    return NextResponse.json({ outcome: 'approval_required', message: 'Approval required before tariff plan deletion', approval }, { status: 202 });
  } catch (error) {
    if (error instanceof Error && error.message === 'INVALID_PLAN_ID') {
      return NextResponse.json({ error: 'Invalid plan_id format' }, { status: 400 });
    }
    if (error instanceof Error && error.message === 'DEFAULT_TARIFF_PLAN_PROTECTED') {
      return NextResponse.json({ error: 'Default tariff plan cannot be deleted' }, { status: 409 });
    }

    console.error('Error deleting tariff plan:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
