import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { OCS_OPERATIONS, evaluateOcsOperation } from '@/server/ocsGovernanceRegistry';

export const dynamic = 'force-dynamic';
type RouteContext = { params: Promise<{ planId: string }> };

export async function POST(request: Request, { params }: RouteContext) {
  const { planId } = await params;
  const definition = evaluateOcsOperation(OCS_OPERATIONS.TARIFF_PLAN_CREATE);
  const auth = requirePermission(request, definition.permission);
  if (!auth.ok) return auth.response;
  if (!definition.executable) return NextResponse.json({ error: definition.disabledCode || 'OCS_TARIFF_CREATE_NOT_SUPPORTED', code: definition.disabledCode || 'OCS_TARIFF_CREATE_NOT_SUPPORTED' }, { status: 409 });
  const rateLimit = await enforceRateLimit(`tariff-plans:clone:${auth.auth.user}`, 20, 60);
  if (!rateLimit.ok) return rateLimit.response;
  return NextResponse.json({ error: 'Routed to Go backend', planId }, { status: 409 });
}
