import { NextResponse } from 'next/server';
import { logAudit } from '@/lib/audit';
import { requirePermission } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { validateTariffRule } from '@/lib/tariffPlanOperations';
import {
  deleteTariffPlanRule,
  getTariffPlan,
  toggleTariffPlanRuleStatus,
  updateTariffPlanRule,
} from '@/server/repositories/ocsBillingRepository';
import { OCS_OPERATIONS, evaluateOcsOperation } from '@/server/ocsGovernanceRegistry';

export const dynamic = 'force-dynamic';

type RouteContext = {
  params: Promise<{ planId: string; ruleId: string }>;
};

export async function PUT(request: Request, { params }: RouteContext) {
  const { planId, ruleId } = await params;
  const definition = evaluateOcsOperation(OCS_OPERATIONS.TARIFF_RULE_UPDATE);
  const auth = requirePermission(request, definition.permission);
  if (!auth.ok) return auth.response;
  if (!definition.executable) return NextResponse.json({ error: definition.disabledCode || 'OCS_OPERATION_NOT_SUPPORTED', code: definition.disabledCode || 'OCS_OPERATION_NOT_SUPPORTED' }, { status: 409 });

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

    const result = await updateTariffPlanRule(planId, ruleId, body);
    try {
      logAudit('UPDATE', `tariff-plan:${planId}:rule:${ruleId}`, before, result, request);
    } catch (auditErr) {
      console.warn('Non-gating audit log failed:', auditErr);
    }
    return NextResponse.json({ success: true, rule: result });
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
  const definition = evaluateOcsOperation(OCS_OPERATIONS.TARIFF_RULE_TOGGLE);
  const auth = requirePermission(request, definition.permission);
  if (!auth.ok) return auth.response;
  if (!definition.executable) return NextResponse.json({ error: definition.disabledCode || 'OCS_OPERATION_NOT_SUPPORTED', code: definition.disabledCode || 'OCS_OPERATION_NOT_SUPPORTED' }, { status: 409 });

  const rateLimit = await enforceRateLimit(`tariff-plans:rules:toggle:${auth.auth.user}`, 30, 60);
  if (!rateLimit.ok) return rateLimit.response;

  try {
    const before = await getTariffPlan(planId);
    if (!before) {
      return NextResponse.json({ error: 'Tariff plan not found' }, { status: 404 });
    }

    const result = await toggleTariffPlanRuleStatus(planId, ruleId);
    try {
      logAudit('UPDATE', `tariff-plan:${planId}:rule:${ruleId}`, before, result, request);
    } catch (auditErr) {
      console.warn('Non-gating audit log failed:', auditErr);
    }
    return NextResponse.json({ success: true, rule: result });
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
  const definition = evaluateOcsOperation(OCS_OPERATIONS.TARIFF_RULE_DELETE);
  const auth = requirePermission(request, definition.permission);
  if (!auth.ok) return auth.response;
  if (!definition.executable) return NextResponse.json({ error: definition.disabledCode || 'OCS_OPERATION_NOT_SUPPORTED', code: definition.disabledCode || 'OCS_OPERATION_NOT_SUPPORTED' }, { status: 409 });

  const rateLimit = await enforceRateLimit(`tariff-plans:rules:delete:${auth.auth.user}`, 20, 60);
  if (!rateLimit.ok) return rateLimit.response;

  try {
    const before = await getTariffPlan(planId);
    if (!before) {
      return NextResponse.json({ error: 'Tariff plan not found' }, { status: 404 });
    }

    const result = await deleteTariffPlanRule(planId, ruleId);
    try {
      logAudit('DELETE', `tariff-plan:${planId}:rule:${ruleId}`, before, result, request);
    } catch (auditErr) {
      console.warn('Non-gating audit log failed:', auditErr);
    }
    return NextResponse.json({ success: true, rule: result });
  } catch (error) {
    if (error instanceof Error && error.message === 'OCS_PLAN_NOT_FOUND') {
      return NextResponse.json({ error: 'Tariff plan not found' }, { status: 404 });
    }

    console.error('Error deleting tariff plan rule:', error);
    return NextResponse.json({ error: 'Failed to delete tariff plan rule' }, { status: 500 });
  }
}
