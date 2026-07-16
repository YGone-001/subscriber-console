import { NextResponse } from 'next/server';
import { logAudit, type AuditAction } from '@/lib/audit';
import { requireAnyRole } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { validateImsi, validateTrafficAdjustmentPayload } from '@/lib/subscriberValidation';
import { adjustOcsTrafficBalance } from '@/server/repositories/ocsBillingRepository';

export const dynamic = 'force-dynamic';

type RouteContext = {
  params: Promise<{ imsi: string }>;
};

function auditActionForMode(mode: string): AuditAction {
  if (mode === 'recharge') return 'TRAFFIC_RECHARGE';
  if (mode === 'reset') return 'TRAFFIC_RESET';
  return 'TRAFFIC_ADJUST';
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  if (message === 'OCS_BALANCE_NOT_FOUND') {
    return NextResponse.json({ error: 'OCS balance not found' }, { status: 404 });
  }
  if (message === 'OCS_BALANCE_CONFLICT') {
    return NextResponse.json({ error: 'Traffic balance changed, please refresh and retry' }, { status: 409 });
  }
  if (message === 'OCS_TOTAL_BELOW_COMMITTED') {
    return NextResponse.json({ error: 'Total quota cannot be lower than used plus reserved traffic' }, { status: 400 });
  }
  console.error('Error adjusting traffic balance:', error);
  return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
}

export async function POST(request: Request, { params }: RouteContext) {
  const { imsi } = await params;
  const auth = requireAnyRole(request, ['root', 'operator']);
  if (!auth.ok) return auth.response;

  const rateLimit = await enforceRateLimit(`traffic-adjustments:${auth.auth.user}`, 30, 60);
  if (!rateLimit.ok) return rateLimit.response;

  const imsiResult = validateImsi(imsi);
  if (!imsiResult.ok) return NextResponse.json({ error: imsiResult.error }, { status: 400 });

  try {
    const body = await request.json();
    const validation = validateTrafficAdjustmentPayload(body);
    if (!validation.ok) return NextResponse.json({ error: validation.error }, { status: 400 });

    const result = await adjustOcsTrafficBalance(imsi, validation.value);
    logAudit(
      auditActionForMode(result.mode),
      imsi,
      result.before,
      {
        ...result.after,
        mode: result.mode,
        reason: result.reason,
      },
      request
    );

    return NextResponse.json({
      message: 'Traffic balance adjusted successfully',
      adjustment: result,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
