import { NextResponse } from 'next/server';
import { requireAuth, requirePermission } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import {
  dryRunMigrateTariffPlanSubscribers,
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

  const rateLimit = await enforceRateLimit(`tariff-plans:migrate-dry-run:${auth.auth.user}`, 60, 60);
  if (!rateLimit.ok) return rateLimit.response;

  try {
    const { searchParams } = new URL(request.url);
    const targetPlanId = searchParams.get('targetPlanId') || searchParams.get('target_plan_id') || '';
    if (!targetPlanId) {
      return NextResponse.json({ error: 'targetPlanId query parameter is required' }, { status: 400 });
    }

    const dryRun = await dryRunMigrateTariffPlanSubscribers(planId, targetPlanId);
    return NextResponse.json({ dryRun });
  } catch (error) {
    const response = errorResponse(error);
    if (response) return response;

    console.error('Error running tariff plan migration dry-run:', error);
    return NextResponse.json({ error: 'Failed to preview tariff plan migration' }, { status: 500 });
  }
}

export async function POST(request: Request, { params }: RouteContext) {
  const { planId } = await params;
  const definition = evaluateOcsOperation(OCS_OPERATIONS.PLAN_MIGRATE);
  const auth = requirePermission(request, definition.permission);
  if (!auth.ok) return auth.response;
  if (!definition.executable) return NextResponse.json({ error: definition.disabledCode || 'OCS_OPERATION_NOT_SUPPORTED', code: definition.disabledCode || 'OCS_OPERATION_NOT_SUPPORTED' }, { status: 409 });

  const rateLimit = await enforceRateLimit(`tariff-plans:migrate:${auth.auth.user}`, 10, 60);
  if (!rateLimit.ok) return rateLimit.response;

  return NextResponse.json({ error: 'Routed to Go backend', planId }, { status: 409 });
}
