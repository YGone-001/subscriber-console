import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { listAuditLogsForTariffPlan } from '@/server/repositories/auditRepository';
import { buildTariffPlanOperationsSummary, getTariffPlan, listTariffPlans } from '@/server/repositories/ocsBillingRepository';

export const dynamic = 'force-dynamic';

type RouteContext = {
  params: Promise<{ planId: string }>;
};

export async function GET(request: Request, { params }: RouteContext) {
  const { planId } = await params;
  const auth = requireAuth(request);
  if (!auth.ok) return auth.response;

  const rateLimit = await enforceRateLimit(`tariff-plans:operations:${auth.auth.user}`, 90, 60);
  if (!rateLimit.ok) return rateLimit.response;

  try {
    const { searchParams } = new URL(request.url);
    const limit = Number(searchParams.get('limit') || '12');
    const [plan, plans, history] = await Promise.all([
      getTariffPlan(planId),
      listTariffPlans(),
      listAuditLogsForTariffPlan(planId, limit),
    ]);
    if (!plan) return NextResponse.json({ error: 'Tariff plan not found' }, { status: 404 });

    return NextResponse.json({
      summary: buildTariffPlanOperationsSummary(plans, plan, history),
      history,
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'INVALID_PLAN_ID') {
      return NextResponse.json({ error: 'Invalid plan_id format' }, { status: 400 });
    }

    console.error('Error fetching tariff plan operations:', error);
    return NextResponse.json({ error: 'Failed to fetch tariff plan operations' }, { status: 500 });
  }
}
