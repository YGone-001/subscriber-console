import { NextResponse } from 'next/server';
import { requireCapability } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { validateImsiList } from '@/lib/subscriberValidation';
import { evaluateSubscriberOperationForActor, SUBSCRIBER_OPERATIONS } from '@/server/subscriberGovernanceRegistry';
import { prepareFrozenSubscriberBulkDelete, executeFrozenSubscriberBulkDeleteV2 as executeBulkDeleteV2, classifyBulkDeleteResult, SubscriberGovernanceError } from '@/server/subscriberSingleGovernance';
import { validateCurrentAccount } from '@/lib/accountSession';
import { writeAuditLog } from '@/lib/audit';
import type { GovernanceActor } from '@/types/governance';

export const dynamic = 'force-dynamic';

export interface BulkDeleteDeps {
  requireCapability: typeof requireCapability;
  enforceRateLimit: typeof enforceRateLimit;
  validateImsiList: typeof validateImsiList;
  validateCurrentAccount: typeof validateCurrentAccount;
  prepareFrozenSubscriberBulkDelete: typeof prepareFrozenSubscriberBulkDelete;
  evaluateSubscriberOperationForActor: typeof evaluateSubscriberOperationForActor;
  writeAuditLog: typeof writeAuditLog;
  executeFrozenSubscriberBulkDeleteV2?: (frozen: ReturnType<typeof prepareFrozenSubscriberBulkDelete> extends Promise<infer T> ? T : never) => Promise<{
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
  }>;
}

const defaultDeps: BulkDeleteDeps = {
  requireCapability,
  enforceRateLimit,
  validateImsiList,
  validateCurrentAccount,
  prepareFrozenSubscriberBulkDelete,
  evaluateSubscriberOperationForActor,
  writeAuditLog,
};

export async function executeFrozenSubscriberBulkDeleteV2(
  frozen: Awaited<ReturnType<typeof prepareFrozenSubscriberBulkDelete>>,
): Promise<{
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
}> {
  return executeBulkDeleteV2(frozen);
}

export function createBulkDeleteHandler(deps: BulkDeleteDeps = defaultDeps) {
  return async function POST(request: Request) {
    const auth = deps.requireCapability(request, 'subscriber_write');
    if (!auth.ok) return auth.response;

    const rate = await deps.enforceRateLimit(`bulk-delete:${auth.auth.user}`, 30, 60);
    if (!rate.ok) return rate.response;

    try {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return NextResponse.json({ error: 'INVALID_JSON_BODY', code: 'INVALID_JSON_BODY' }, { status: 400 });
      }

      const imsiListRaw = (body as { imsiList?: unknown })?.imsiList;
      const validation = deps.validateImsiList(imsiListRaw);
      if (!validation.ok) {
        return NextResponse.json({ error: validation.error, code: validation.error }, { status: 400 });
      }

      let freshAccount: { userId?: string; username: string; normalizedRole: string };
      try {
        freshAccount = await deps.validateCurrentAccount({
          username: auth.auth.user,
          role: auth.auth.role,
          sv: auth.auth.sessionVersion,
        });
      } catch (err) {
        const code = (err as { code?: string })?.code || 'AUTH_INVALID_TOKEN';
        return NextResponse.json({ error: code, code }, { status: 401 });
      }

      const actorRole = freshAccount.normalizedRole;
      const actor: GovernanceActor = {
        type: 'user',
        userId: freshAccount.userId,
        username: freshAccount.username,
        role: actorRole,
      };

      const frozen = await deps.prepareFrozenSubscriberBulkDelete(validation.value);

      if (frozen.snapshotBytes > 512 * 1024) {
        return NextResponse.json({ error: 'APPROVAL_SNAPSHOT_TOO_LARGE', code: 'APPROVAL_SNAPSHOT_TOO_LARGE' }, { status: 400 });
      }

      const result = deps.evaluateSubscriberOperationForActor(SUBSCRIBER_OPERATIONS.BULK_DELETE, actorRole);
      if (!result.executable) {
        return NextResponse.json({ error: 'OPERATION_NOT_EXECUTABLE' }, { status: 409 });
      }

      return executeDirectBulkDelete(frozen, actor, request, deps);
    } catch (error) {
      if (error instanceof SubscriberGovernanceError) {
        if (error.code === 'SUBSCRIBER_BULK_DELETE_PRECONDITION_CHANGED') {
          return NextResponse.json({
            error: error.code,
            code: error.code,
            details: error.details,
          }, { status: 409 });
        }
        return NextResponse.json({
          error: error.code,
          code: error.code,
          details: error.details,
        }, { status: 400 });
      }
      return NextResponse.json({ error: 'INTERNAL_ERROR', code: 'INTERNAL_ERROR' }, { status: 500 });
    }
  };
}

async function executeDirectBulkDelete(
  frozen: Awaited<ReturnType<typeof prepareFrozenSubscriberBulkDelete>>,
  actor: GovernanceActor,
  _request: Request,
  deps: BulkDeleteDeps,
) {
  const executor = deps.executeFrozenSubscriberBulkDeleteV2 || executeFrozenSubscriberBulkDeleteV2;

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
    result = await executor(frozen);
  } catch (error) {
    if (error instanceof SubscriberGovernanceError && error.code === 'SUBSCRIBER_BULK_DELETE_PRECONDITION_CHANGED') {
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
  }

  const classification = classifyBulkDeleteResult(
    result.deletedCount,
    result.requested,
    result.conflictImsis.length,
    result.failedImsis.length,
    result.ocsCleanupFailedImsis.length,
  );

  // Non-gating audit
  try {
    await deps.writeAuditLog({
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
    }, { failureMode: 'best-effort' });
  } catch (auditErr) {
    console.warn('Bulk delete audit failed (non-gating):', auditErr);
  }

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

  const hasConflict = result.conflictImsis.length > 0;
  return NextResponse.json({
    error: hasConflict ? 'SUBSCRIBER_BULK_DELETE_PRECONDITION_CHANGED' : 'SUBSCRIBER_BULK_DELETE_FAILED',
    code: hasConflict ? 'SUBSCRIBER_BULK_DELETE_PRECONDITION_CHANGED' : 'SUBSCRIBER_BULK_DELETE_FAILED',
    committed: false,
    partialMutation: false,
    result,
  }, { status: hasConflict ? 409 : 500 });
}

export const POST = createBulkDeleteHandler();
