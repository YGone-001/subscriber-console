import { NextResponse } from 'next/server';
import { requireCapability } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { validateImsiList } from '@/lib/subscriberValidation';
import { createGovernedApproval } from '@/server/approvalCreator';
import { evaluateSubscriberOperationForActor, SUBSCRIBER_OPERATIONS } from '@/server/subscriberGovernanceRegistry';
import { prepareFrozenSubscriberBulkDelete, executeFrozenSubscriberBulkDelete, classifyBulkDeleteResult, SubscriberGovernanceError } from '@/server/subscriberSingleGovernance';
import { validateCurrentAccount } from '@/lib/accountSession';
import { listActiveSubscriberApprovals } from '@/server/repositories/approvalRepository';
import { writeAuditLog } from '@/lib/audit';
import type { GovernanceActor } from '@/types/governance';

export const dynamic = 'force-dynamic';

type ActiveApprovalMatch = { type: 'duplicate'; approval: { id: string; [key: string]: unknown } } | { type: 'conflict'; approval: { id: string; [key: string]: unknown } };

/** Action-aware target extraction (Section 5). */
function extractSubscriberApprovalTargets(approval: { action: string; payload?: Record<string, unknown>; targetId?: string }): string[] {
  const payload = approval.payload || {};

  // SUBSCRIBER_UPDATE / SUBSCRIBER_DELETE: payload.imsi
  if (approval.action === 'SUBSCRIBER_UPDATE' || approval.action === 'SUBSCRIBER_DELETE') {
    const imsi = payload.imsi;
    if (typeof imsi === 'string') return [imsi];
  }

  // SUBSCRIBER_BATCH_UPDATE / SUBSCRIBER_BULK_DELETE: payload.targets[].imsi
  if (approval.action === 'SUBSCRIBER_BATCH_UPDATE' || approval.action === 'SUBSCRIBER_BULK_DELETE') {
    const targets = Array.isArray(payload.targets) ? payload.targets : [];
    return targets.map((t: { imsi?: string }) => t.imsi).filter((imsi): imsi is string => Boolean(imsi));
  }

  // Legacy fallback: targetId might contain IMSI
  if (approval.targetId && approval.targetId.startsWith('subscriber:') && !approval.targetId.includes('bulk-delete')) {
    const maybeImsi = approval.targetId.replace('subscriber:', '');
    if (/^\d{15}$/.test(maybeImsi)) return [maybeImsi];
  }

  return [];
}

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

      // Overlap check: action-aware target extraction
      const existingImsis = extractSubscriberApprovalTargets(approval);
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
    if (!validation.ok) return NextResponse.json({ error: validation.error, code: 'INVALID_BULK_DELETE_REQUEST' }, { status: 400 });
    if (validation.value.length === 0) return NextResponse.json({ error: 'imsiList cannot be empty', code: 'INVALID_BULK_DELETE_REQUEST' }, { status: 400 });

    // Section 20: Duplicate IMSI request validation
    if (new Set(validation.value).size !== validation.value.length) {
      return NextResponse.json({ error: 'INVALID_BULK_DELETE_REQUEST', code: 'INVALID_BULK_DELETE_REQUEST' }, { status: 400 });
    }

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

    // Evaluate governance with actor-aware policy
    const result = evaluateSubscriberOperationForActor(SUBSCRIBER_OPERATIONS.BULK_DELETE, actorRole);

    if (!result.executable) {
      return NextResponse.json({ error: 'OPERATION_NOT_EXECUTABLE' }, { status: 409 });
    }

    // Active change protection (Section 3: before governance decision)
    const activeMatch = await findActiveApprovalMatch(frozen.operationFingerprint, validation.value);

    // DIRECT path (super_admin/root)
    if (result.governanceMode === 'DIRECT_GOVERNED') {
      // ANY active conflict including exact duplicate → 409
      if (activeMatch) {
        return NextResponse.json({
          error: 'ACTIVE_CHANGE_CONFLICT',
          code: 'ACTIVE_CHANGE_CONFLICT',
          approval: activeMatch.approval,
        }, { status: 409 });
      }

      // Execute directly
      return executeDirectBulkDelete(frozen, actor, request);
    }

    // APPROVAL path (operator/ops_admin)
    if (activeMatch) {
      if (activeMatch.type === 'duplicate') {
        // Exact duplicate → 202 idempotent
        return NextResponse.json({
          approval: activeMatch.approval,
          requiresApproval: true,
          idempotent: true,
        }, { status: 202 });
      }
      // Overlap → 409
      return NextResponse.json({
        error: 'ACTIVE_CHANGE_CONFLICT',
        code: 'ACTIVE_CHANGE_CONFLICT',
        approval: activeMatch.approval,
      }, { status: 409 });
    }

    // Create approval (Section 4: remove duplicate logAudit)
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

/** Direct execution for super_admin/root (Sections 13-15). */
async function executeDirectBulkDelete(
  frozen: ReturnType<typeof prepareFrozenSubscriberBulkDelete> extends Promise<infer T> ? T : never,
  actor: GovernanceActor,
  request: Request,
) {
  // Use v2 executor directly
  const { assertFrozenBulkDeleteV2, executeFrozenSubscriberBulkDeleteV2 } = await import('@/server/subscriberSingleGovernance');

  let result: {
    requested: number;
    deletedImsis: string[];
    conflictImsis: string[];
    failedImsis: string[];
    ocsCleanedImsis: string[];
    ocsCleanupFailedImsis: string[];
    deletedCount: number;
    partialMutation: boolean;
    mutationCommitted: boolean;
    operationFingerprint: string;
  };

  try {
    result = await executeFrozenSubscriberBulkDeleteV2(frozen);
  } catch (error) {
    // Section 3-4: Capture error evidence for audit before returning HTTP
    if (error instanceof SubscriberGovernanceError && error.code === 'SUBSCRIBER_BULK_DELETE_PRECONDITION_CHANGED') {
      // Preflight conflict - build zero-write result for audit
      result = {
        requested: frozen.targetCount,
        deletedImsis: [],
        conflictImsis: (error.details as { conflictImsis?: string[] })?.conflictImsis || frozen.targets.map((t) => t.imsi),
        failedImsis: [],
        ocsCleanedImsis: [],
        ocsCleanupFailedImsis: [],
        deletedCount: 0,
        partialMutation: false,
        mutationCommitted: false,
        operationFingerprint: frozen.operationFingerprint,
      };
    } else {
      // Section 5: Storage failure - build zero-write result for audit
      result = {
        requested: frozen.targetCount,
        deletedImsis: [],
        conflictImsis: [],
        failedImsis: frozen.targets.map((t) => t.imsi),
        ocsCleanedImsis: [],
        ocsCleanupFailedImsis: [],
        deletedCount: 0,
        partialMutation: false,
        mutationCommitted: false,
        operationFingerprint: frozen.operationFingerprint,
      };
    }
    // Fall through to classification and audit below
  }

  // Classify
  const classification = classifyBulkDeleteResult(
    result.deletedCount,
    result.requested,
    result.conflictImsis.length,
    result.failedImsis.length,
    result.ocsCleanupFailedImsis.length,
  );

  // Strict audit (Section 14)
  try {
    await writeAuditLog({
      actor,
      module: 'subscribers',
      action: 'subscriber.batch.delete',
      resource: { type: 'subscriber_batch', id: 'bulk-delete' },
      targetId: 'subscriber:bulk-delete',
      riskLevel: 'critical',
      result: classification === 'SUCCESS' ? 'success' : 'failed',
      reason: `Bulk delete ${result.deletedCount}/${result.requested}`,
      before: { targetCount: frozen.targetCount },
      after: result,
      metadata: {
        governanceMode: 'DIRECT_GOVERNED',
        approvalRequired: false,
        actorRole: actor.role,
        targetCount: frozen.targetCount,
        deletedCount: result.deletedCount,
        conflictCount: result.conflictImsis.length,
        failedCount: result.failedImsis.length,
        ocsCleanupFailureCount: result.ocsCleanupFailedImsis.length,
        operationFingerprint: frozen.operationFingerprint,
        classification,
        partialMutation: result.partialMutation,
        mutationCommitted: result.mutationCommitted,
      },
    }, { failureMode: 'strict' });
  } catch {
    // Audit failure (Section 15)
    return NextResponse.json({
      error: 'AUDIT_UNAVAILABLE',
      code: 'AUDIT_UNAVAILABLE',
      committed: result.mutationCommitted,
      partialMutation: result.partialMutation,
    }, { status: 503 });
  }

  // HTTP mapping (Section 11-12: exact canonical response)
  if (classification === 'SUCCESS') {
    return NextResponse.json({
      outcome: 'executed',
      message: 'Subscribers deleted successfully',
      result: {
        requested: result.requested,
        deleted: result.deletedCount,
        deletedImsis: result.deletedImsis,
        ocsCleanupFailedImsis: result.ocsCleanupFailedImsis,
      },
      requiresApproval: false,
    }, { status: 200 });
  }

  if (classification === 'PARTIAL_WRITE') {
    return NextResponse.json({
      error: 'SUBSCRIBER_BULK_DELETE_PARTIAL_WRITE',
      code: 'SUBSCRIBER_BULK_DELETE_PARTIAL_WRITE',
      committed: true,
      partialMutation: true,
      result,
    }, { status: 409 });
  }

  // FAILED_NO_MUTATION
  const hasConflict = result.conflictImsis.length > 0;
  return NextResponse.json({
    error: hasConflict ? 'SUBSCRIBER_BULK_DELETE_PRECONDITION_CHANGED' : 'SUBSCRIBER_BULK_DELETE_FAILED',
    code: hasConflict ? 'SUBSCRIBER_BULK_DELETE_PRECONDITION_CHANGED' : 'SUBSCRIBER_BULK_DELETE_FAILED',
    committed: false,
    partialMutation: false,
    result,
  }, { status: hasConflict ? 409 : 500 });
}
