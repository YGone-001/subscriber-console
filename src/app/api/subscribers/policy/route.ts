import { NextResponse } from 'next/server';
import { logAudit } from '@/lib/audit';
import { requireAnyRole } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { validatePolicyChangePayload } from '@/lib/subscriberValidation';
import { changeOcsPolicyForSubscribers } from '@/server/repositories/ocsBillingRepository';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const auth = requireAnyRole(request, ['root', 'operator']);
  if (!auth.ok) return auth.response;

  const rateLimit = await enforceRateLimit(`subscribers:policy:${auth.auth.user}`, 20, 60);
  if (!rateLimit.ok) return rateLimit.response;

  try {
    const body = await request.json();
    const validation = validatePolicyChangePayload(body);
    if (!validation.ok) return NextResponse.json({ error: validation.error }, { status: 400 });

    const result = await changeOcsPolicyForSubscribers(validation.value);
    logAudit(
      'UPDATE',
      `policy:${result.planId}`,
      null,
      {
        imsiList: validation.value.imsiList,
        requested: result.requested,
        subscriberModified: result.subscriberModified,
        balanceModified: result.balanceModified,
        status: result.status,
        resetBalances: result.resetBalances,
      },
      request
    );

    return NextResponse.json({ message: 'Policy updated successfully', result });
  } catch (error) {
    if (error instanceof Error && error.message === 'OCS_PLAN_NOT_FOUND') {
      return NextResponse.json({ error: 'Tariff plan not found' }, { status: 404 });
    }

    console.error('Error changing subscriber policy:', error);
    return NextResponse.json({ error: 'Failed to change subscriber policy' }, { status: 500 });
  }
}
