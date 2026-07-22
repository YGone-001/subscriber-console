import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { listAuditLogsForTariffPlan } from '@/server/repositories/auditRepository';
import { getTariffPlan, listTariffPlans } from '@/server/repositories/ocsBillingRepository';

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

    const activePlans = plans.filter((item) => (item.status || 'active') === 'active').length;
    const disabledPlans = plans.filter((item) => item.status === 'disabled').length;
    const totalLinkedSubscribers = plans.reduce((sum, item) => sum + (item.subscriberCount || 0), 0);
    const selectedSharePct = totalLinkedSubscribers > 0
      ? Math.round((plan.subscriberCount / totalLinkedSubscribers) * 1000) / 10
      : 0;

    return NextResponse.json({
      summary: {
        totalPlans: plans.length,
        activePlans,
        disabledPlans,
        totalLinkedSubscribers,
        selectedLinkedSubscribers: plan.subscriberCount,
        selectedSharePct,
        recentActivityCount: history.length,
        lastChangedAt: plan.updated_at || history[0]?.timestamp || null,
      },
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
