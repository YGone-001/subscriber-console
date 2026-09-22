import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { OCS_OPERATIONS, evaluateOcsOperation } from '@/server/ocsGovernanceRegistry';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ imsi: string }> };

/** Administrative credit/debit only. Runtime reservations and consumption have
 * no HTTP approval route and continue to belong to the charging runtime. */
export async function POST(request: Request, { params }: RouteContext) {
  const { imsi } = await params;
  const definition = evaluateOcsOperation(OCS_OPERATIONS.BALANCE_ADJUST);
  const auth = requirePermission(request, definition.permission);
  if (!auth.ok) return auth.response;

  const rateLimit = await enforceRateLimit(`traffic-adjustments:${auth.auth.user}`, 30, 60);
  if (!rateLimit.ok) return rateLimit.response;

  if (!definition.executable) {
    return NextResponse.json({ error: 'OCS balance adjustment is disabled', code: 'OCS_OPERATION_DISABLED' }, { status: 409 });
  }

  return NextResponse.json({ error: 'Routed to Go backend', imsi }, { status: 200 });
}
