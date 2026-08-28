import { NextResponse } from 'next/server';
import { logAudit } from '@/lib/audit';
import { requireAuth, requirePermission } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { createApprovalRequest } from '@/server/repositories/approvalRepository';
import {
  dryRunMigrateTariffPlanSubscribers,
  getTariffPlan,
} from '@/server/repositories/ocsBillingRepository';
import { OCS_OPERATIONS, evaluateOcsOperation } from '@/server/ocsGovernanceRegistry';

export const dynamic = 'force-dynamic';

type RouteContext = {
  params: Promise<{ planId: string }>;
};

function errorResponse(error: unknown) {
  if (error instanceof Error && error.message === 'INVALID_PLAN_ID') {
    return NextResponse.json({ error: 'Invalid plan_id format' }, { status: 400 });
  }
  if (
    error instanceof Error &&
    (error.message === 'OCS_PLAN_NOT_FOUND' ||
      error.message === 'SOURCE_PLAN_NOT_FOUND' ||
      error.message === 'TARGET_PLAN_NOT_FOUND')
  ) {
    return NextResponse.json({ error: 'Tariff plan not found' }, { status: 404 });
  }
  if (
    error instanceof Error &&
    (error.message === 'OCS_PLAN_DISABLED' || error.message === 'TARGET_PLAN_DISABLED')
  ) {
    return NextResponse.json({ error: 'Tariff plan is disabled' }, { status: 409 });
  }
  if (error instanceof Error && error.message === 'TARIFF_PLAN_MIGRATE_SAME') {
    return NextResponse.json({ error: 'Source and target tariff plan must be different' }, { status: 400 });
  }
  return null;
}

export async function GET(request: Request, { params }: RouteContext) {
  const { planId } = await params;
  const auth = requireAuth(request);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const targetPlanId = url.searchParams.get('targetPlanId') || url.searchParams.get('target_plan_id');
  if (!targetPlanId) {
    return NextResponse.json({ error: 'targetPlanId query parameter is required' }, { status: 400 });
  }

  try {
    const preview = await dryRunMigrateTariffPlanSubscribers(planId, targetPlanId);
    return NextResponse.json({ preview });
  } catch (error) {
    const response = errorResponse(error);
    if (response) return response;

    console.error('Error in migration dry-run:', error);
    return NextResponse.json({ error: 'Failed to preview migration' }, { status: 500 });
  }
}

export async function POST(request: Request, { params }: RouteContext) {
  const { planId } = await params;
  const definition = evaluateOcsOperation(OCS_OPERATIONS.PLAN_MIGRATE);
  const auth = requirePermission(request, definition.permission);
  if (!auth.ok) return auth.response;

  const rateLimit = await enforceRateLimit(`tariff-plans:migrate:${auth.auth.user}`, 12, 60);
  if (!rateLimit.ok) return rateLimit.response;

  try {
    const body = await request.json();
    const targetPlanId = body?.targetPlanId || body?.target_plan_id;
    const resetBalances = body?.resetBalances === true;
    if (resetBalances) return NextResponse.json({ error: 'Balance reset during tariff migration is disabled', code: 'OCS_BALANCE_RESET_DISABLED' }, { status: 409 });
    const [sourcePlan, targetPlan] = await Promise.all([
      getTariffPlan(planId),
      getTariffPlan(targetPlanId),
    ]);

    if (!sourcePlan || !targetPlan) return NextResponse.json({ error: 'Tariff plan not found' }, { status: 404 });
    if (sourcePlan.plan_id === targetPlan.plan_id) {
      return NextResponse.json({ error: 'Source and target tariff plan must be different' }, { status: 400 });
    }
    if (targetPlan.status === 'disabled') {
      return NextResponse.json({ error: 'Tariff plan is disabled' }, { status: 409 });
    }

    const payload = {
      sourcePlanId: sourcePlan.plan_id,
      targetPlanId: targetPlan.plan_id,
      resetBalances,
    };

    const approval = await createApprovalRequest({
      action: 'TARIFF_PLAN_MIGRATE', requester: auth.auth.user,
      targetId: `tariff-plan:${sourcePlan.plan_id}->${targetPlan.plan_id}`,
      summary: `Migrate subscribers from ${sourcePlan.plan_id} to ${targetPlan.plan_id}`,
      operation: { resourceType: 'ocs_tariff_plan_migration', resourceId: `${sourcePlan.plan_id}->${targetPlan.plan_id}` },
      before: { sourcePlan, targetPlan }, payload,
    });
    logAudit('UPDATE', `approval:${approval.id}`, null, approval, request);
    return NextResponse.json({ outcome: 'approval_required', message: 'Approval required before tariff plan migration', approval }, { status: 202 });
  } catch (error) {
    const response = errorResponse(error);
    if (response) return response;

    console.error('Error migrating tariff plan subscribers:', error);
    return NextResponse.json({ error: 'Failed to migrate tariff plan subscribers' }, { status: 500 });
  }
}
