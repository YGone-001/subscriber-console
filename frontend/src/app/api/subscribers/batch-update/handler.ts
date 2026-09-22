import { NextResponse } from 'next/server';
import { writeAuditLog } from '@/lib/audit';
import { auditRequestContext } from '@/lib/audit/record';
import { validateCurrentAccount, AccountSessionError } from '@/lib/accountSession';
import { requireCapability } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import {
  prepareFrozenSubscriberBatchUpdateV2,
  executeFrozenSubscriberBatchUpdate,
  classifyBatchUpdateResult,
  SubscriberBatchGovernanceError,
  validateSubscriberBatchChangeRequest,
} from '@/server/subscriberOperationPolicy';
import { evaluateSubscriberOperationForActor, SUBSCRIBER_OPERATIONS } from '@/server/subscriberGovernanceRegistry';

export const dynamic = 'force-dynamic';

export interface BatchUpdateRouteDeps {
  requireCapability: typeof requireCapability;
  enforceRateLimit: typeof enforceRateLimit;
  validateCurrentAccount: typeof validateCurrentAccount;
  evaluateSubscriberOperationForActor: typeof evaluateSubscriberOperationForActor;
  prepareFrozenSubscriberBatchUpdateV2: typeof prepareFrozenSubscriberBatchUpdateV2;
  executeFrozenSubscriberBatchUpdate: typeof executeFrozenSubscriberBatchUpdate;
  writeAuditLog: typeof writeAuditLog;
}

const defaultDeps: BatchUpdateRouteDeps = {
  requireCapability,
  enforceRateLimit,
  validateCurrentAccount,
  evaluateSubscriberOperationForActor,
  prepareFrozenSubscriberBatchUpdateV2,
  executeFrozenSubscriberBatchUpdate,
  writeAuditLog,
};

export function createBatchUpdateHandler(deps: BatchUpdateRouteDeps = defaultDeps) {
  return async function POST(request: Request) {
    const auth = deps.requireCapability(request, 'subscriber_write');
    if (!auth.ok) return auth.response;

    const rate = await deps.enforceRateLimit(`batch-update:${auth.auth.user}`, 30, 60);
    if (!rate.ok) return rate.response;
    try {
      const input = validateSubscriberBatchChangeRequest(await request.json());

      // Fresh actor validation — fail closed
      const freshAccount = await deps.validateCurrentAccount(auth.auth);

      // Actor-aware governance from central registry
      const policy = deps.evaluateSubscriberOperationForActor(SUBSCRIBER_OPERATIONS.BATCH_UPDATE, freshAccount.normalizedRole);
      if (!policy.executable) {
        return NextResponse.json({ error: 'OPERATION_NOT_EXECUTABLE', code: 'OPERATION_NOT_EXECUTABLE' }, { status: 409 });
      }

      // Prepare frozen v2
      const frozen = await deps.prepareFrozenSubscriberBatchUpdateV2(input);

      // Actor object for audit
      const actor = { type: 'user' as const, userId: freshAccount.userId, username: freshAccount.username, role: freshAccount.normalizedRole };

      // Maintenance window check
      if (input.maintenanceWindow) {
        const now = Date.now();
        const start = Date.parse(input.maintenanceWindow.start);
        const end = Date.parse(input.maintenanceWindow.end);
        if (now < start || now > end) {
          return NextResponse.json({ error: 'OUTSIDE_MAINTENANCE_WINDOW', code: 'OUTSIDE_MAINTENANCE_WINDOW' }, { status: 409 });
        }
      }

      const result = await deps.executeFrozenSubscriberBatchUpdate(frozen);
      const classification = classifyBatchUpdateResult(result.modifiedCount, result.requested, result.conflictImsis.length, result.failedImsis.length);
      const auditResult = classification === 'SUCCESS' ? 'success' : 'failed';

      // Non-gating audit log
      try {
        await deps.writeAuditLog({
          actor, module: 'subscribers', action: 'subscriber.batch.update',
          resource: { type: 'subscriber_batch', id: frozen.operationFingerprint },
          targetId: `subscriber-batch:${frozen.operationFingerprint}`,
          before: { targetCount: frozen.targetCount, fields: frozen.fieldNames },
          after: { targetCount: frozen.targetCount, fields: frozen.fieldNames, modifiedCount: result.modifiedCount, classification },
          result: auditResult,
          metadata: {
            governanceMode: 'DIRECT_GOVERNED',
            operation: 'SUBSCRIBER_BATCH_UPDATE', actorRole: freshAccount.normalizedRole,
            targetCount: frozen.targetCount, fieldNames: frozen.fieldNames,
            modifiedCount: result.modifiedCount, conflictCount: result.conflictImsis.length,
            failedCount: result.failedImsis.length, classification, partialMutation: result.partialMutation,
            operationFingerprint: frozen.operationFingerprint,
          },
          ...auditRequestContext(request),
        }, { failureMode: 'best-effort' });
      } catch (auditErr) {
        console.warn('Audit log failed (non-gating):', auditErr);
      }

      if (classification === 'FAILED_NO_MUTATION') {
        if (result.conflictImsis.length > 0) {
          return NextResponse.json({ error: 'SUBSCRIBER_BATCH_PRECONDITION_CHANGED', code: 'SUBSCRIBER_BATCH_PRECONDITION_CHANGED', partialMutation: false }, { status: 409 });
        }
        return NextResponse.json({ error: 'SUBSCRIBER_BATCH_UPDATE_FAILED', code: 'SUBSCRIBER_BATCH_UPDATE_FAILED', partialMutation: false }, { status: 500 });
      }

      if (classification === 'PARTIAL_WRITE') {
        return NextResponse.json({ error: 'SUBSCRIBER_BATCH_PARTIAL_WRITE', code: 'SUBSCRIBER_BATCH_PARTIAL_WRITE', partialMutation: true, result: { modifiedImsis: result.modifiedImsis, conflictImsis: result.conflictImsis, failedImsis: result.failedImsis } }, { status: 409 });
      }

      return NextResponse.json({ outcome: 'executed', message: 'Subscribers updated successfully', result: { requested: result.requested, modified: result.modifiedCount, fieldNames: result.fieldNames } }, { status: 200 });
    } catch (error) {
      if (error instanceof SubscriberBatchGovernanceError) {
        const statusMap: Record<string, number> = {
          SUBSCRIBER_NOT_FOUND: 404, ACTIVE_CHANGE_CONFLICT: 409, SUBSCRIBER_BATCH_PRECONDITION_CHANGED: 409,
          SUBSCRIBER_BATCH_NO_EFFECT: 400, INVALID_SUBSCRIBER_BATCH_UPDATE_PAYLOAD: 400,
          BATCH_SIZE_EXCEEDED: 400, APPROVAL_SNAPSHOT_TOO_LARGE: 400,
        };
        return NextResponse.json({ error: error.code, code: error.code, details: error.details }, { status: statusMap[error.code] || 400 });
      }
      if (error instanceof AccountSessionError) {
        const statusMap: Record<string, number> = { AUTH_INVALID_TOKEN: 401, ACCOUNT_NOT_FOUND: 401, ACCOUNT_DISABLED: 403, ACCOUNT_LOCKED: 403, SESSION_REVOKED: 403 };
        return NextResponse.json({ error: error.code }, { status: statusMap[error.code] || 500 });
      }
      if (error && typeof error === 'object' && (error as { code?: number }).code === 11000) {
        return NextResponse.json({ error: 'ACTIVE_CHANGE_CONFLICT', code: 'ACTIVE_CHANGE_CONFLICT' }, { status: 409 });
      }
      console.error('SUBSCRIBER_BATCH_UPDATE_FAILED', { code: error instanceof Error ? error.message : 'UNKNOWN' });
      return NextResponse.json({ error: 'BATCH_UPDATE_FAILED', code: 'BATCH_UPDATE_FAILED' }, { status: 500 });
    }
  };
}

export const POST = createBatchUpdateHandler();
