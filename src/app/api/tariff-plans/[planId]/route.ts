import { NextResponse } from 'next/server';
import { logAudit } from '@/lib/audit';
import { requireAuth, requireCapability } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import {
  deleteTariffPlan,
  getTariffPlan,
  updateTariffPlan,
} from '@/server/repositories/ocsBillingRepository';

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
  const auth = requireCapability(request, 'rating_publish');
  if (!auth.ok) return auth.response;

  const rateLimit = await enforceRateLimit(`tariff-plans:update:${auth.auth.user}`, 30, 60);
  if (!rateLimit.ok) return rateLimit.response;

  try {
    const body = await request.json();
    const before = await getTariffPlan(planId);
    const plan = await updateTariffPlan(planId, body);
    if (!plan) return NextResponse.json({ error: 'Tariff plan not found' }, { status: 404 });

    logAudit('UPDATE', `tariff-plan:${plan.plan_id}`, before, plan, request);
    return NextResponse.json({ message: 'Tariff plan updated successfully', plan });
  } catch (error) {
    if (error instanceof Error && error.message === 'INVALID_PLAN_ID') {
      return NextResponse.json({ error: 'Invalid plan_id format' }, { status: 400 });
    }

    console.error('Error updating tariff plan:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: RouteContext) {
  const { planId } = await params;
  const auth = requireCapability(request, 'rating_publish');
  if (!auth.ok) return auth.response;

  const rateLimit = await enforceRateLimit(`tariff-plans:delete:${auth.auth.user}`, 20, 60);
  if (!rateLimit.ok) return rateLimit.response;

  try {
    const before = await getTariffPlan(planId);
    if (!before) return NextResponse.json({ error: 'Tariff plan not found' }, { status: 404 });

    const result = await deleteTariffPlan(planId);
    if (!result.deleted) {
      return NextResponse.json(
        {
          error: `Cannot delete: tariff plan is currently used by ${result.references.count} subscribers`,
          examples: result.references.examples,
        },
        { status: 409 }
      );
    }

    logAudit('DELETE', `tariff-plan:${planId}`, before || { plan_id: planId }, null, request);
    return NextResponse.json({ message: 'Tariff plan deleted successfully' });
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
