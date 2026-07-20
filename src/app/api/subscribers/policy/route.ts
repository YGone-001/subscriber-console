import { NextResponse } from 'next/server';
import { logAudit } from '@/lib/audit';
import { requireCapability } from '@/lib/authz';
import { capabilityDecision } from '@/lib/permissions';
import { enforceRateLimit } from '@/lib/rateLimit';
import { validatePolicyChangePayload } from '@/lib/subscriberValidation';
import { createApprovalRequest } from '@/server/repositories/approvalRepository';
import { changeOcsPolicyForSubscribers } from '@/server/repositories/ocsBillingRepository';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const auth = requireCapability(request, 'policy_approve', { allowApproval: true });
  if (!auth.ok) return auth.response;

  const rateLimit = await enforceRateLimit(`subscribers:policy:${auth.auth.user}`, 20, 60);
  if (!rateLimit.ok) return rateLimit.response;

  try {
    const body = await request.json();
    const validation = validatePolicyChangePayload(body);
    if (!validation.ok) return NextResponse.json({ error: validation.error }, { status: 400 });

    if (capabilityDecision(auth.auth.role, 'policy_approve') === 'approval') {
      const uniqueImsis = Array.from(new Set(validation.value.imsiList));
      const approval = await createApprovalRequest({
        action: 'POLICY_CHANGE',
        requester: auth.auth.user,
        targetId: `policy:${validation.value.planId}`,
        summary: `${uniqueImsis.length} subscriber(s) -> ${validation.value.planId} (${validation.value.status})`,
        payload: validation.value,
      });

      logAudit('UPDATE', `approval:${approval.id}`, null, approval, request);
      return NextResponse.json(
        { message: 'Approval required before policy update', approval },
        { status: 202 }
      );
    }

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
