import { NextResponse } from 'next/server';
import { logAudit } from '@/lib/audit';
import { requirePermission } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { normalizeImportedPlan } from '@/lib/tariffPlanOperations';
import { OCS_OPERATIONS, evaluateOcsOperation } from '@/server/ocsGovernanceRegistry';
import { createTariffPlan, getTariffPlan, updateTariffPlan } from '@/server/repositories/ocsBillingRepository';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const definition = evaluateOcsOperation(OCS_OPERATIONS.TARIFF_PLAN_CREATE);
  const auth = requirePermission(request, definition.permission);
  if (!auth.ok) return auth.response;
  if (!definition.executable) return NextResponse.json({ error: definition.disabledCode || 'OCS_TARIFF_CREATE_NOT_SUPPORTED', code: definition.disabledCode || 'OCS_TARIFF_CREATE_NOT_SUPPORTED' }, { status: 409 });
  const rateLimit = await enforceRateLimit(`tariff-plans:import:${auth.auth.user}`, 15, 60);
  if (!rateLimit.ok) return rateLimit.response;
  try {
    const normalized = normalizeImportedPlan(await request.json());
    if (!normalized.isValid || !normalized.plan) return NextResponse.json({ error: 'Import validation failed', details: normalized.errors }, { status: 400 });
    const plan = normalized.plan;
    const before = await getTariffPlan(plan.plan_id);
    const result = before
      ? await updateTariffPlan(plan.plan_id, plan)
      : await createTariffPlan(plan);
    try {
      logAudit(before ? 'UPDATE' : 'CREATE', `tariff-plan:${plan.plan_id}`, before || null, result, request);
    } catch (auditErr) {
      console.warn('Non-gating audit log failed:', auditErr);
    }
    return NextResponse.json({ outcome: 'completed', plan: result, warnings: normalized.warnings }, { status: 200 });
  } catch (error) {
    console.error('Error importing tariff plan approval:', error);
    return NextResponse.json({ error: 'Failed to create tariff plan import approval' }, { status: 500 });
  }
}
