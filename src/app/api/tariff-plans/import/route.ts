import { NextResponse } from 'next/server';
import { logAudit } from '@/lib/audit';
import { requireCapability } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { normalizeImportedPlan } from '@/lib/tariffPlanOperations';
import {
  createTariffPlan,
  getTariffPlan,
  updateTariffPlan,
} from '@/server/repositories/ocsBillingRepository';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const auth = requireCapability(request, 'rating_publish');
  if (!auth.ok) return auth.response;

  const rateLimit = await enforceRateLimit(`tariff-plans:import:${auth.auth.user}`, 15, 60);
  if (!rateLimit.ok) return rateLimit.response;

  try {
    const rawData = await request.json();
    const normalized = normalizeImportedPlan(rawData);

    if (!normalized.isValid || !normalized.plan) {
      return NextResponse.json(
        { error: 'Import validation failed', details: normalized.errors },
        { status: 400 }
      );
    }

    const { plan: planData, warnings } = normalized;
    const existing = await getTariffPlan(planData.plan_id);

    let plan;
    let action: 'CREATE' | 'UPDATE';

    if (existing) {
      // Update existing plan
      action = 'UPDATE';
      plan = await updateTariffPlan(planData.plan_id, {
        name: planData.name,
        description: planData.description,
        status: planData.status,
        quota_per_grant: planData.quota_per_grant,
        validity_time: planData.validity_time,
        volume_threshold: planData.volume_threshold,
        rules: planData.rules,
      });
      logAudit('UPDATE', `tariff-plan:${planData.plan_id}`, existing, plan, request);
    } else {
      // Create new plan
      action = 'CREATE';
      plan = await createTariffPlan({
        plan_id: planData.plan_id,
        name: planData.name,
        description: planData.description,
        status: planData.status,
        quota_per_grant: planData.quota_per_grant,
        validity_time: planData.validity_time,
        volume_threshold: planData.volume_threshold,
        rules: planData.rules,
      });
      logAudit('CREATE', `tariff-plan:${planData.plan_id}`, null, plan, request);
    }

    return NextResponse.json({
      message: `Tariff plan ${action === 'CREATE' ? 'imported' : 'updated from import'} successfully`,
      action,
      plan,
      warnings,
    }, { status: action === 'CREATE' ? 201 : 200 });
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === 'INVALID_PLAN_ID') {
        return NextResponse.json({ error: 'Invalid plan_id in imported data' }, { status: 400 });
      }
      if (error.message === 'TARIFF_PLAN_DISABLE_IN_USE') {
        return NextResponse.json({ error: 'Cannot disable plan: in use by active subscribers' }, { status: 409 });
      }
    }

    console.error('Error importing tariff plan:', error);
    return NextResponse.json({ error: 'Failed to import tariff plan' }, { status: 500 });
  }
}
