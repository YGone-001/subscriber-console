import { NextResponse } from 'next/server';
import { logAudit } from '@/lib/audit';
import { requirePermission } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { validateTariffRule } from '@/lib/tariffPlanOperations';
import {
  getTariffPlan,
} from '@/server/repositories/ocsBillingRepository';
import { OCS_OPERATIONS, evaluateOcsOperation } from '@/server/ocsGovernanceRegistry';
import { createApprovalRequest } from '@/server/repositories/approvalRepository';

export const dynamic = 'force-dynamic';

type RouteContext = {
  params: Promise<{ planId: string; ruleId: string }>;
};

export async function PUT(request: Request, { params }: RouteContext) {
  const { planId, ruleId } = await params;
  const definition = evaluateOcsOperation(OCS_OPERATIONS.TARIFF_RULE_UPDATE);
  const auth = requirePermission(request, definition.permission);
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

    const approval = await createApprovalRequest({ action: 'TARIFF_PLAN_RULE_UPDATE', requester: auth.auth.user, targetId: `tariff-plan:${planId}:rule:${ruleId}`, summary: `Update tariff rule ${ruleId}`, operation: { resourceType: 'ocs_tariff_plan', resourceId: planId }, before, payload: { schema: 'ocs-tariff-rule-v1', planId, ruleId, rule: body } });
    logAudit('UPDATE', `approval:${approval.id}`, null, approval, request);
    return NextResponse.json({ outcome: 'approval_required', message: 'Approval required before tariff rule update', approval }, { status: 202 });
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

  const rateLimit = await enforceRateLimit(`tariff-plans:rules:toggle:${auth.auth.user}`, 30, 60);
  if (!rateLimit.ok) return rateLimit.response;

  try {
    const before = await getTariffPlan(planId);
    if (!before) {
      return NextResponse.json({ error: 'Tariff plan not found' }, { status: 404 });
    }

    const approval = await createApprovalRequest({ action: 'TARIFF_PLAN_RULE_TOGGLE', requester: auth.auth.user, targetId: `tariff-plan:${planId}:rule:${ruleId}`, summary: `Toggle tariff rule ${ruleId}`, operation: { resourceType: 'ocs_tariff_plan', resourceId: planId }, before, payload: { schema: 'ocs-tariff-rule-v1', planId, ruleId } });
    logAudit('UPDATE', `approval:${approval.id}`, null, approval, request);
    return NextResponse.json({ outcome: 'approval_required', message: 'Approval required before tariff rule state change', approval }, { status: 202 });
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

  const rateLimit = await enforceRateLimit(`tariff-plans:rules:delete:${auth.auth.user}`, 20, 60);
  if (!rateLimit.ok) return rateLimit.response;

  try {
    const before = await getTariffPlan(planId);
    if (!before) {
      return NextResponse.json({ error: 'Tariff plan not found' }, { status: 404 });
    }

    const approval = await createApprovalRequest({ action: 'TARIFF_PLAN_RULE_DELETE', requester: auth.auth.user, targetId: `tariff-plan:${planId}:rule:${ruleId}`, summary: `Delete tariff rule ${ruleId}`, operation: { resourceType: 'ocs_tariff_plan', resourceId: planId }, before, payload: { schema: 'ocs-tariff-rule-v1', planId, ruleId } });
    logAudit('UPDATE', `approval:${approval.id}`, null, approval, request);
    return NextResponse.json({ outcome: 'approval_required', message: 'Approval required before tariff rule deletion', approval }, { status: 202 });
  } catch (error) {
    if (error instanceof Error && error.message === 'OCS_PLAN_NOT_FOUND') {
      return NextResponse.json({ error: 'Tariff plan not found' }, { status: 404 });
    }

    console.error('Error deleting tariff plan rule:', error);
    return NextResponse.json({ error: 'Failed to delete tariff plan rule' }, { status: 500 });
  }
}
