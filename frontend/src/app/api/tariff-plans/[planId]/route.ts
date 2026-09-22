import { NextResponse } from 'next/server';
import { requireAuth, requirePermission } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import {
  getTariffPlan,
} from '@/server/repositories/ocsBillingRepository';
import { OCS_OPERATIONS, evaluateOcsOperation } from '@/server/ocsGovernanceRegistry';

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
  if (!definition.executable) return NextResponse.json({ error: definition.disabledCode || 'OCS_OPERATION_NOT_SUPPORTED', code: definition.disabledCode || 'OCS_OPERATION_NOT_SUPPORTED' }, { status: 409 });

  const rateLimit = await enforceRateLimit(`tariff-plans:update:${auth.auth.user}`, 30, 60);
  if (!rateLimit.ok) return rateLimit.response;

  return NextResponse.json({ error: 'Routed to Go backend', planId }, { status: 409 });
}

export async function DELETE(request: Request, { params }: RouteContext) {
  const { planId } = await params;
  const definition = evaluateOcsOperation(OCS_OPERATIONS.TARIFF_PLAN_DELETE);
  const auth = requirePermission(request, definition.permission);
  if (!auth.ok) return auth.response;
  if (!definition.executable) return NextResponse.json({ error: definition.disabledCode || 'OCS_OPERATION_NOT_SUPPORTED', code: definition.disabledCode || 'OCS_OPERATION_NOT_SUPPORTED' }, { status: 409 });

  const rateLimit = await enforceRateLimit(`tariff-plans:delete:${auth.auth.user}`, 20, 60);
  if (!rateLimit.ok) return rateLimit.response;

  return NextResponse.json({ error: 'Routed to Go backend', planId }, { status: 409 });
}
