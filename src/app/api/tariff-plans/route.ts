import { NextResponse } from 'next/server';
import { logAudit } from '@/lib/audit';
import { enforceRateLimit } from '@/lib/rateLimit';
import { requireAuth, requireCapability } from '@/lib/authz';
import {
  createTariffPlan,
  listTariffPlans,
} from '@/server/repositories/ocsBillingRepository';

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
  try {
    const auth = requireCapability(request, 'rating_publish');
    if (!auth.ok) return auth.response;

    const rateLimit = await enforceRateLimit(`tariff-plans:create:${auth.auth.user}`, 20, 60);
    if (!rateLimit.ok) return rateLimit.response;

    const body = await request.json();
    const plan = await createTariffPlan(body);

    logAudit('CREATE', `tariff-plan:${plan.plan_id}`, null, plan, request);
    return NextResponse.json({ message: 'Tariff plan created successfully', plan }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === 'TARIFF_PLAN_EXISTS') {
      return NextResponse.json({ error: 'Tariff plan already exists' }, { status: 409 });
    }
    if (error instanceof Error && error.message === 'INVALID_PLAN_ID') {
      return NextResponse.json({ error: 'Invalid plan_id format' }, { status: 400 });
    }
    if (error instanceof Error && error.message === 'SOURCE_TARIFF_PLAN_NOT_FOUND') {
      return NextResponse.json({ error: 'Source tariff plan not found' }, { status: 404 });
    }

    console.error('Error creating tariff plan:', error);
    return NextResponse.json({ error: 'Failed to create tariff plan' }, { status: 500 });
  }
}
