import { NextResponse } from 'next/server';
import { logAudit } from '@/lib/audit';
import { requirePermission } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { freezeOcsBalanceAdjustment, OcsBalanceGovernanceError } from '@/server/ocsBalanceGovernance';
import { OCS_OPERATIONS, evaluateOcsOperation } from '@/server/ocsGovernanceRegistry';
import { createApprovalRequest } from '@/server/repositories/approvalRepository';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ imsi: string }> };

function errorResponse(error: unknown) {
  if (error instanceof OcsBalanceGovernanceError) {
    const status = error.code === 'OCS_BALANCE_NOT_FOUND' ? 404
      : error.code === 'OCS_BALANCE_RESERVATION_CONFLICT' ? 409
        : 400;
    return NextResponse.json({ error: error.code, code: error.code, details: error.details }, { status });
  }
  console.error('Error creating governed traffic adjustment:', error);
  return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
}

/** Administrative credit/debit only. Runtime reservations and consumption have
 * no HTTP approval route and continue to belong to the charging runtime. */
export async function POST(request: Request, { params }: RouteContext) {
  const { imsi } = await params;
  const definition = evaluateOcsOperation(OCS_OPERATIONS.BALANCE_ADJUST);
  const auth = requirePermission(request, definition.permission);
  if (!auth.ok) return auth.response;

  const rateLimit = await enforceRateLimit(`traffic-adjustments:${auth.auth.user}`, 30, 60);
  if (!rateLimit.ok) return rateLimit.response;

  try {
    const frozen = await freezeOcsBalanceAdjustment(imsi, await request.json());
    if (!definition.executable || !definition.requiresApproval || definition.approvalAction !== 'TRAFFIC_ADJUSTMENT') {
      return NextResponse.json({ error: 'OCS balance adjustment is disabled', code: 'OCS_OPERATION_DISABLED' }, { status: 409 });
    }
    const approval = await createApprovalRequest({
      action: definition.approvalAction,
      requester: auth.auth.user,
      targetId: frozen.imsi,
      summary: `${frozen.intent.operation} ${frozen.intent.bucket} balance for subscriber ${frozen.imsi}`,
      reason: frozen.intent.reason,
      ticketId: frozen.intent.ticketId,
      maintenanceWindow: frozen.intent.maintenanceWindow,
      operation: { resourceType: 'ocs_balance', resourceId: `${frozen.imsi}:${frozen.intent.bucket}` },
      before: frozen.before,
      after: frozen.expectedAfter,
      payload: frozen,
    });
    logAudit('UPDATE', `approval:${approval.id}`, null, approval, request);
    return NextResponse.json(
      { outcome: 'approval_required', message: 'Approval required before traffic adjustment', approval },
      { status: 202 }
    );
  } catch (error) {
    return errorResponse(error);
  }
}
