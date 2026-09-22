import { NextResponse } from 'next/server';
import { requireAuth, requirePermission } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { OCS_OPERATIONS, evaluateOcsOperation } from '@/server/ocsGovernanceRegistry';
import { listTariffPlans } from '@/server/repositories/ocsBillingRepository';

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
  const definition = evaluateOcsOperation(OCS_OPERATIONS.TARIFF_PLAN_CREATE);
  const auth = requirePermission(request, definition.permission);
  if (!auth.ok) return auth.response;
  if (!definition.executable) return NextResponse.json({ error: definition.disabledCode || 'OCS_OPERATION_NOT_SUPPORTED', code: definition.disabledCode || 'OCS_OPERATION_NOT_SUPPORTED' }, { status: 409 });
  const rateLimit = await enforceRateLimit(`tariff-plans:create:${auth.auth.user}`, 20, 60);
  if (!rateLimit.ok) return rateLimit.response;
  return NextResponse.json({ error: 'Routed to Go backend' }, { status: 409 });
}
