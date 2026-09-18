import { NextResponse } from 'next/server';
import { logAudit } from '@/lib/audit';
import { requireCapability } from '@/lib/authz';
import { capabilityDecision } from '@/lib/permissions';
import { enforceRateLimit } from '@/lib/rateLimit';
import { createApprovalRequest } from '@/server/repositories/approvalRepository';
import { batchHealSubscriberDocuments } from '@/server/repositories/systemAuditRepository';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const auth = requireCapability(request, 'system_heal', { allowApproval: true });
    if (!auth.ok) return auth.response;

    const rateLimit = await enforceRateLimit(`system:audit-batch-heal:${auth.auth.user}`, 10, 60);
    if (!rateLimit.ok) return rateLimit.response;

    const { anomalies, profileName } = await request.json();
    if (!Array.isArray(anomalies) || anomalies.length === 0) {
      return NextResponse.json({ error: 'anomalies list is required and cannot be empty' }, { status: 400 });
    }

    if (capabilityDecision(auth.auth.role, 'system_heal') === 'approval') {
      const approval = await createApprovalRequest({
        action: 'SYSTEM_HEAL',
        requester: auth.auth.user,
        targetId: `batch:${anomalies.length}`,
        summary: `Batch self-heal ${anomalies.length} detected system anomalies`,
        payload: {
          anomalies,
          profileName: profileName ? String(profileName) : undefined,
        },
      });

      logAudit('UPDATE', `approval:${approval.id}`, null, approval, request);
      return NextResponse.json(
        { message: `Approval required before batch healing ${anomalies.length} items`, approval },
        { status: 202 }
      );
    }

    const result = await batchHealSubscriberDocuments(anomalies, profileName ? String(profileName) : undefined);
    logAudit('HEAL', `batch:${anomalies.length}`, null, { count: anomalies.length, result, profileName }, request);

    return NextResponse.json({
      message: `Successfully healed ${result.successCount} of ${anomalies.length} anomalies`,
      ...result,
    }, { status: 200 });
  } catch (error) {
    console.error('Batch self-healing API failed:', error);
    return NextResponse.json({ error: 'Batch self-healing execution failed' }, { status: 500 });
  }
}
