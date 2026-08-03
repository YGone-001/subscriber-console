import { NextResponse } from 'next/server';
import { logAudit } from '@/lib/audit';
import { requireCapability } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { cloneTariffPlan, getTariffPlan } from '@/server/repositories/ocsBillingRepository';

export const dynamic = 'force-dynamic';

type RouteContext = {
  params: Promise<{ planId: string }>;
};

export async function POST(request: Request, { params }: RouteContext) {
  const { planId } = await params;
  const auth = requireCapability(request, 'rating_publish');
  if (!auth.ok) return auth.response;

  const rateLimit = await enforceRateLimit(`tariff-plans:clone:${auth.auth.user}`, 20, 60);
  if (!rateLimit.ok) return rateLimit.response;

  try {
    const body = await request.json();
    const targetPlanId = body.targetPlanId || body.target_plan_id || body.newPlanId || body.plan_id;
    if (!targetPlanId) {
      return NextResponse.json({ error: 'Target plan_id is required' }, { status: 400 });
    }

    const sourcePlan = await getTariffPlan(planId);
    if (!sourcePlan) {
      return NextResponse.json({ error: 'Source tariff plan not found' }, { status: 404 });
    }

    const plan = await cloneTariffPlan(planId, targetPlanId, body.name, body.description);
    logAudit('CREATE', `tariff-plan:${plan.plan_id}`, { clonedFrom: planId }, plan, request);

    return NextResponse.json(
      { message: `Tariff plan cloned successfully as ${plan.plan_id}`, plan },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === 'TARIFF_PLAN_EXISTS') {
        return NextResponse.json({ error: 'Target tariff plan ID already exists' }, { status: 409 });
      }
      if (error.message === 'INVALID_PLAN_ID') {
        return NextResponse.json({ error: 'Invalid plan_id format (alphanumeric, -, _)' }, { status: 400 });
      }
      if (error.message === 'SOURCE_AND_TARGET_SAME') {
        return NextResponse.json({ error: 'Target plan ID must be different from source' }, { status: 400 });
      }
      if (error.message === 'SOURCE_TARIFF_PLAN_NOT_FOUND') {
        return NextResponse.json({ error: 'Source tariff plan not found' }, { status: 404 });
      }
    }

    console.error('Error cloning tariff plan:', error);
    return NextResponse.json({ error: 'Failed to clone tariff plan' }, { status: 500 });
  }
}
