import { NextResponse } from 'next/server';
import { logAudit } from '@/lib/audit';
import { requireCapability } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { validateTariffRule } from '@/lib/tariffPlanOperations';
import {
  deleteTariffPlanRule,
  getTariffPlan,
  toggleTariffPlanRuleStatus,
  updateTariffPlanRule,
} from '@/server/repositories/ocsBillingRepository';

export const dynamic = 'force-dynamic';

type RouteContext = {
  params: Promise<{ planId: string; ruleId: string }>;
};

export async function PUT(request: Request, { params }: RouteContext) {
  const { planId, ruleId } = await params;
  const auth = requireCapability(request, 'rating_publish');
  if (!auth.ok) return auth.response;

  const rateLimit = await enforceRateLimit(`tariff-plans:rules:update:${auth.auth.user}`, 30, 60);
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

    const rule = await updateTariffPlanRule(planId, ruleId, body);
    const after = await getTariffPlan(planId);

    logAudit('UPDATE', `tariff-plan:${planId}:rule:${ruleId}`, { before: before.rules?.find(r => r.rule_id === ruleId) }, rule, request);

    return NextResponse.json({ message: 'Rule updated successfully', rule, plan: after });
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === 'RULE_NOT_FOUND') {
        return NextResponse.json({ error: 'Rule not found' }, { status: 404 });
      }
      if (error.message === 'OCS_PLAN_NOT_FOUND') {
        return NextResponse.json({ error: 'Tariff plan not found' }, { status: 404 });
      }
    }

    console.error('Error updating tariff plan rule:', error);
    return NextResponse.json({ error: 'Failed to update tariff plan rule' }, { status: 500 });
  }
}

export async function PATCH(request: Request, { params }: RouteContext) {
  const { planId, ruleId } = await params;
  const auth = requireCapability(request, 'rating_publish');
  if (!auth.ok) return auth.response;

  const rateLimit = await enforceRateLimit(`tariff-plans:rules:toggle:${auth.auth.user}`, 30, 60);
  if (!rateLimit.ok) return rateLimit.response;

  try {
    const before = await getTariffPlan(planId);
    if (!before) {
      return NextResponse.json({ error: 'Tariff plan not found' }, { status: 404 });
    }

    const result = await toggleTariffPlanRuleStatus(planId, ruleId);
    const after = await getTariffPlan(planId);

    logAudit('UPDATE', `tariff-plan:${planId}:rule:${ruleId}:status`, { rule_id: ruleId }, result, request);

    return NextResponse.json({ message: `Rule status updated to ${result.status}`, result, plan: after });
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === 'RULE_NOT_FOUND') {
        return NextResponse.json({ error: 'Rule not found' }, { status: 404 });
      }
      if (error.message === 'OCS_PLAN_NOT_FOUND') {
        return NextResponse.json({ error: 'Tariff plan not found' }, { status: 404 });
      }
    }

    console.error('Error toggling tariff plan rule status:', error);
    return NextResponse.json({ error: 'Failed to toggle rule status' }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: RouteContext) {
  const { planId, ruleId } = await params;
  const auth = requireCapability(request, 'rating_publish');
  if (!auth.ok) return auth.response;

  const rateLimit = await enforceRateLimit(`tariff-plans:rules:delete:${auth.auth.user}`, 20, 60);
  if (!rateLimit.ok) return rateLimit.response;

  try {
    const before = await getTariffPlan(planId);
    if (!before) {
      return NextResponse.json({ error: 'Tariff plan not found' }, { status: 404 });
    }

    const existingRule = before.rules?.find(r => r.rule_id === ruleId);
    const result = await deleteTariffPlanRule(planId, ruleId);
    const after = await getTariffPlan(planId);

    logAudit('DELETE', `tariff-plan:${planId}:rule:${ruleId}`, existingRule, null, request);

    return NextResponse.json({ message: 'Rule deleted successfully', result, plan: after });
  } catch (error) {
    if (error instanceof Error && error.message === 'OCS_PLAN_NOT_FOUND') {
      return NextResponse.json({ error: 'Tariff plan not found' }, { status: 404 });
    }

    console.error('Error deleting tariff plan rule:', error);
    return NextResponse.json({ error: 'Failed to delete tariff plan rule' }, { status: 500 });
  }
}
