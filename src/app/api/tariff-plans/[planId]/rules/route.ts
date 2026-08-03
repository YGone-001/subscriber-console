import { NextResponse } from 'next/server';
import { logAudit } from '@/lib/audit';
import { requireAuth, requireCapability } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import {
  detectRuleConflicts,
  validateTariffRule,
} from '@/lib/tariffPlanOperations';
import {
  addTariffPlanRule,
  getTariffPlan,
} from '@/server/repositories/ocsBillingRepository';

export const dynamic = 'force-dynamic';

type RouteContext = {
  params: Promise<{ planId: string }>;
};

export async function GET(request: Request, { params }: RouteContext) {
  const { planId } = await params;
  const auth = requireAuth(request);
  if (!auth.ok) return auth.response;

  const rateLimit = await enforceRateLimit(`tariff-plans:rules:list:${auth.auth.user}`, 120, 60);
  if (!rateLimit.ok) return rateLimit.response;

  try {
    const plan = await getTariffPlan(planId);
    if (!plan) {
      return NextResponse.json({ error: 'Tariff plan not found' }, { status: 404 });
    }

    const rules = plan.rules || [];
    const conflicts = detectRuleConflicts(rules);

    return NextResponse.json({
      plan_id: plan.plan_id,
      rules,
      conflicts,
      count: rules.length,
    });
  } catch (error) {
    console.error('Error fetching tariff plan rules:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(request: Request, { params }: RouteContext) {
  const { planId } = await params;
  const auth = requireCapability(request, 'rating_publish');
  if (!auth.ok) return auth.response;

  const rateLimit = await enforceRateLimit(`tariff-plans:rules:create:${auth.auth.user}`, 30, 60);
  if (!rateLimit.ok) return rateLimit.response;

  try {
    const body = await request.json();
    const validation = validateTariffRule(body);
    if (!validation.isValid) {
      return NextResponse.json({ error: validation.errors.join('; ') }, { status: 400 });
    }

    const before = await getTariffPlan(planId);
    if (!before) {
      return NextResponse.json({ error: 'Tariff plan not found' }, { status: 404 });
    }

    const rule = await addTariffPlanRule(planId, body);
    const after = await getTariffPlan(planId);

    logAudit('CREATE', `tariff-plan:${planId}:rule:${rule.rule_id}`, null, rule, request);

    return NextResponse.json(
      { message: 'Rule added successfully', rule, plan: after },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === 'RULE_ID_EXISTS') {
        return NextResponse.json({ error: 'A rule with this ID or matching signature already exists' }, { status: 409 });
      }
      if (error.message === 'OCS_PLAN_NOT_FOUND') {
        return NextResponse.json({ error: 'Tariff plan not found' }, { status: 404 });
      }
    }

    console.error('Error creating tariff plan rule:', error);
    return NextResponse.json({ error: 'Failed to create tariff plan rule' }, { status: 500 });
  }
}
