import { NextResponse } from 'next/server';
import { logAudit } from '@/lib/audit';
import { requireCapability } from '@/lib/authz';
import { capabilityDecision } from '@/lib/permissions';
import { enforceRateLimit } from '@/lib/rateLimit';
import { createApprovalRequest } from '@/server/repositories/approvalRepository';
import { healSubscriberDocument } from '@/server/repositories/systemAuditRepository';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const auth = requireCapability(request, 'system_heal', { allowApproval: true });
    if (!auth.ok) return auth.response;
    const rateLimit = await enforceRateLimit(`system:audit-heal:${auth.auth.user}`, 20, 60);
    if (!rateLimit.ok) return rateLimit.response;

    const { imsi, type, profileName } = await request.json();
    if (!imsi || !type) {
      return NextResponse.json({ error: 'imsi and type are required' }, { status: 400 });
    }
    if (!/^\d{15}$/.test(String(imsi))) {
      return NextResponse.json({ error: 'IMSI must be exactly 15 digits' }, { status: 400 });
    }

    if (capabilityDecision(auth.auth.role, 'system_heal') === 'approval') {
      const approval = await createApprovalRequest({
        action: 'SYSTEM_HEAL',
        requester: auth.auth.user,
        targetId: String(imsi),
        summary: `Self-heal ${imsi} (${type})`,
        payload: {
          imsi: String(imsi),
          type: String(type),
          profileName: profileName ? String(profileName) : undefined,
        },
      });

      logAudit('UPDATE', `approval:${approval.id}`, null, approval, request);
      return NextResponse.json(
        { message: `Approval required before self-healing ${imsi}`, approval },
        { status: 202 }
      );
    }

    await healSubscriberDocument(String(imsi), String(type), profileName ? String(profileName) : undefined);
    logAudit('HEAL', String(imsi), null, { type, profileName }, request);

    return NextResponse.json({
      message: `Successfully applied targeted self-healing for ${imsi}`,
    }, { status: 200 });
  } catch (error) {
    console.error('Self-healing API failed:', error);
    return NextResponse.json({ error: 'Self-healing execution failed' }, { status: 500 });
  }
}
