import { NextResponse } from 'next/server';
import { logAudit } from '@/lib/audit';
import { requireCapability } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { validateImsiList } from '@/lib/subscriberValidation';
import { createGovernedApproval } from '@/server/approvalCreator';
import { evaluateSubscriberOperationForActor, SUBSCRIBER_OPERATIONS } from '@/server/subscriberGovernanceRegistry';
import { prepareFrozenSubscriberBulkDelete, SubscriberGovernanceError } from '@/server/subscriberSingleGovernance';
import { validateCurrentAccount } from '@/lib/accountSession';
import { listActiveSubscriberApprovals } from '@/server/repositories/approvalRepository';
import type { GovernanceActor } from '@/types/governance';

export const dynamic = 'force-dynamic';

type ActiveApprovalMatch = { type: 'duplicate'; approval: { id: string; [key: string]: unknown } } | { type: 'conflict'; approval: { id: string; [key: string]: unknown } };

async function findActiveApprovalMatch(fingerprint: string, imsis: string[]): Promise<ActiveApprovalMatch | null> {
  const actions = ['SUBSCRIBER_UPDATE', 'SUBSCRIBER_DELETE', 'SUBSCRIBER_BATCH_UPDATE', 'SUBSCRIBER_BULK_DELETE'];
  const requestedImsis = new Set(imsis);

  for (const action of actions) {
    const active = await listActiveSubscriberApprovals(action);
    for (const approval of active) {
      // Duplicate check: same fingerprint for BULK_DELETE
      if (action === 'SUBSCRIBER_BULK_DELETE' && approval.operationFingerprint === fingerprint) {
        return { type: 'duplicate', approval };
      }

      // Overlap check: any active change targeting same IMSIs
      const targets = Array.isArray(approval.payload?.targets) ? approval.payload.targets : [];
      const existingImsis = targets.map((t: { imsi?: string }) => t.imsi).filter((imsi): imsi is string => Boolean(imsi));
      const hasOverlap = existingImsis.some((imsi) => requestedImsis.has(imsi));
      if (hasOverlap) {
        return { type: 'conflict', approval };
      }
    }
  }
  return null;
}

export async function POST(request: Request) {
  const auth = requireCapability(request, 'subscriber_write');
  if (!auth.ok) return auth.response;

  const rateLimit = await enforceRateLimit(`subscribers:bulk-delete:${auth.auth.user}`, 10, 60);
  if (!rateLimit.ok) return rateLimit.response;

  try {
    const body = await request.json();
    const validation = validateImsiList(body?.imsiList);
    if (!validation.ok) return NextResponse.json({ error: validation.error }, { status: 400 });
    if (validation.value.length === 0) return NextResponse.json({ error: 'imsiList cannot be empty' }, { status: 400 });

    // Fresh actor validation
    const account = await validateCurrentAccount({ username: auth.auth.user, role: auth.auth.role, sv: auth.auth.sessionVersion });
    const actorRole = account.normalizedRole || account.role || 'viewer';
    const actor: GovernanceActor = { type: 'user', userId: account.userId, username: account.username || auth.auth.user, role: actorRole };

    // Prepare frozen v2
    const frozen = await prepareFrozenSubscriberBulkDelete(validation.value);

    // Snapshot size check
    if (frozen.snapshotBytes > 512 * 1024) {
      return NextResponse.json({ error: 'APPROVAL_SNAPSHOT_TOO_LARGE', code: 'APPROVAL_SNAPSHOT_TOO_LARGE' }, { status: 400 });
    }

    // Active change protection
    const activeMatch = await findActiveApprovalMatch(frozen.operationFingerprint, validation.value);
    if (activeMatch) {
      if (activeMatch.type === 'duplicate') {
        return NextResponse.json({
          approval: activeMatch.approval,
          requiresApproval: true,
          idempotent: true,
        }, { status: 202 });
      }
      return NextResponse.json({
        error: 'ACTIVE_CHANGE_CONFLICT',
        code: 'ACTIVE_CHANGE_CONFLICT',
        approval: activeMatch.approval,
      }, { status: 409 });
    }

    // Evaluate governance with actor-aware policy
    const result = evaluateSubscriberOperationForActor(SUBSCRIBER_OPERATIONS.BULK_DELETE, actorRole);

    if (!result.executable) {
      return NextResponse.json({ error: 'OPERATION_NOT_EXECUTABLE' }, { status: 409 });
    }

    // Create approval with governed approval creator
    const approval = await createGovernedApproval({
      action: 'SUBSCRIBER_BULK_DELETE',
      requester: actor.username || auth.auth.user,
      requesterContext: actor,
      targetId: 'subscriber:bulk-delete',
      summary: `Delete ${frozen.targetCount} subscriber(s)`,
      operation: { resourceType: 'subscriber_batch', resourceId: 'bulk-delete' },
      operationFingerprint: frozen.operationFingerprint,
      before: { targetCount: frozen.targetCount, targets: frozen.targets },
      payload: frozen as unknown as Record<string, unknown>,
    }, actor);

    logAudit('UPDATE', `approval:${approval.id}`, null, approval, request);
    return NextResponse.json({
      approval,
      requiresApproval: true,
    }, { status: 202 });
  } catch (error) {
    if (error instanceof SubscriberGovernanceError) {
      if (error.code === 'SUBSCRIBER_NOT_FOUND') {
        return NextResponse.json({ error: 'Subscriber not found', details: error.details }, { status: 404 });
      }
      return NextResponse.json({ error: error.code, code: error.code }, { status: 400 });
    }
    console.error('Error bulk deleting subscribers:', error);
    return NextResponse.json({ error: 'Bulk subscriber delete failed' }, { status: 500 });
  }
}
