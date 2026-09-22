import { NextResponse } from 'next/server';
import { logAudit } from '@/lib/audit';
import { requireAuth, requirePermission } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import {
  detectRuleConflicts,
  validateTariffRule,
} from '@/lib/tariffPlanOperations';
import { addTariffPlanRule, getTariffPlan } from '@/server/repositories/ocsBillingRepository';
import { OCS_OPERATIONS, evaluateOcsOperation } from '@/server/ocsGovernanceRegistry';

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
  const definition = evaluateOcsOperation(OCS_OPERATIONS.TARIFF_RULE_CREATE);
  const auth = requirePermission(request, definition.permission);
  if (!auth.ok) return auth.response;
  if (!definition.executable) return NextResponse.json({ error: definition.disabledCode || 'OCS_OPERATION_NOT_SUPPORTED', code: definition.disabledCode || 'OCS_OPERATION_NOT_SUPPORTED' }, { status: 409 });

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

    const result = await addTariffPlanRule(planId, body);
    try {
      logAudit('CREATE', `tariff-plan:${planId}:rule:${result.rule_id}`, before, result, request);
    } catch (auditErr) {
      console.warn('Non-gating audit log failed:', auditErr);
    }
    return NextResponse.json({ success: true, rule: result }, { status: 201 });
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
