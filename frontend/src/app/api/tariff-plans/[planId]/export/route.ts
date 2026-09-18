import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { exportTariffPlanJson } from '@/lib/tariffPlanOperations';
import { getTariffPlan } from '@/server/repositories/ocsBillingRepository';

export const dynamic = 'force-dynamic';

type RouteContext = {
  params: Promise<{ planId: string }>;
};

export async function GET(request: Request, { params }: RouteContext) {
  const { planId } = await params;
  const auth = requireAuth(request);
  if (!auth.ok) return auth.response;

  const rateLimit = await enforceRateLimit(`tariff-plans:export:${auth.auth.user}`, 30, 60);
  if (!rateLimit.ok) return rateLimit.response;

  try {
    const plan = await getTariffPlan(planId);
    if (!plan) {
      return NextResponse.json({ error: 'Tariff plan not found' }, { status: 404 });
    }

    const exportData = exportTariffPlanJson(plan);
    const jsonString = JSON.stringify(exportData, null, 2);

    return new NextResponse(jsonString, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="tariff-plan-${plan.plan_id}.json"`,
      },
    });
  } catch (error) {
    console.error('Error exporting tariff plan:', error);
    return NextResponse.json({ error: 'Failed to export tariff plan' }, { status: 500 });
  }
}
