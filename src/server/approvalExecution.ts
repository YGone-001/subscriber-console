import { writeAuditLog } from '@/lib/audit';
import { auditRequestContext } from '@/lib/audit/record';
import { validateCurrentAccount } from '@/lib/accountSession';
import { executeApproval } from '@/server/approvalExecutors';
import { executeFrozenSubscriberBatchChange, SubscriberBatchGovernanceError } from '@/server/subscriberOperationPolicy';
import { executeFrozenSubscriberBulkDelete, executeFrozenSubscriberDelete, executeFrozenSubscriberUpdate } from '@/server/subscriberSingleGovernance';
import { assertGovernedOperationCoverage } from '@/server/subscriberGovernanceRegistry';
import { executeFrozenOcsBalanceAdjustment, OcsBalanceGovernanceError } from '@/server/ocsBalanceGovernance';
import { assertOcsGovernedOperationCoverage } from '@/server/ocsGovernanceRegistry';
import { approvalActionEligibility, ApprovalWorkflowError } from '@/server/approvalWorkflow';
import { getApproval, transitionApproval, type ApprovalDocument } from '@/server/repositories/approvalRepository';
import { getUser } from '@/server/repositories/userRepository';
import { getTariffPlan } from '@/server/repositories/ocsBillingRepository';
import { getRating } from '@/server/repositories/ratingRepository';
import type { AuthContext } from '@/lib/authz';
import type { GovernanceActor } from '@/types/governance';

export interface GovernedApprovalExecutor {
  execute(approval: ApprovalDocument, request: Request, actor?: GovernanceActor): Promise<unknown>;
}

export class ApprovalExecutionError extends Error {
  constructor(public readonly code: string, public readonly status = 409, public readonly approval?: ApprovalDocument, public readonly committed = false, public readonly details?: unknown) {
    super(code);
  }
}

const defaultExecutor: GovernedApprovalExecutor = {
  async execute(approval, request, actor) {
    if (approval.action === 'ACCESS_REQUEST') return executeApproval(approval, request);
    if (approval.action === 'TRAFFIC_ADJUSTMENT' && approval.payload.schema === 'ocs-balance-adjustment-v1') {
      let result: Awaited<ReturnType<typeof executeFrozenOcsBalanceAdjustment>>;
      try {
        result = await executeFrozenOcsBalanceAdjustment(approval.payload, {
          approvalId: approval.id,
          executionId: approval.execution?.id || 'missing-execution-id',
          actor: actor?.username || 'system',
        });
      } catch (error) {
        if (error instanceof OcsBalanceGovernanceError) {
          throw new ApprovalExecutionError(error.code, error.committed ? 503 : 409, approval, error.committed, error.details);
        }
        throw error;
      }
      try {
        await writeAuditLog({
          actor: actor || { type: 'system', userId: 'system', username: 'system' }, module: 'ocs', action: 'ocs.balance.adjust',
          resource: { type: 'ocs_balance', id: `${approval.targetId}:${approval.payload.intent && typeof approval.payload.intent === 'object' && 'bucket' in approval.payload.intent ? approval.payload.intent.bucket : 'unknown'}` },
          targetId: approval.targetId, approvalId: approval.id, riskLevel: approval.riskLevel, result: 'success', reason: approval.reason,
          before: result.before, after: result.after,
          metadata: { adjustmentId: result.adjustmentId, executionId: approval.execution?.id, operationFingerprint: approval.operationFingerprint, idempotent: result.idempotent },
          ...auditRequestContext(request),
        }, { failureMode: 'strict' });
      } catch {
        throw new ApprovalExecutionError('AUDIT_UNAVAILABLE', 503, approval, true, { ...result, mutationCommitted: true });
      }
      return result;
    }
    if (approval.action === 'SUBSCRIBER_BATCH_UPDATE') {
      const result = await executeFrozenSubscriberBatchChange(approval.payload);
      try {
        await writeAuditLog({
          actor: actor || { type: 'system', userId: 'system', username: 'system' }, module: 'subscribers', action: 'subscriber.batch.update',
          resource: { type: 'subscriber_batch', id: approval.operation.resourceId, name: approval.changeId || approval.id },
          targetId: `subscriber-batch:${approval.operation.resourceId}`, approvalId: approval.id, riskLevel: approval.riskLevel,
          result: 'success', reason: approval.reason, before: approval.before, after: approval.after,
          metadata: { executionId: approval.execution?.id, operationFingerprint: approval.operationFingerprint, requested: result.requested, matched: result.matched, modified: result.modified, fieldNames: result.fieldNames },
          ...auditRequestContext(request),
        }, { failureMode: 'strict' });
      } catch {
        console.error('SUBSCRIBER_BATCH_AUDIT_PERSISTENCE_ALERT', { approvalId: approval.id, executionId: approval.execution?.id });
        throw new ApprovalExecutionError('AUDIT_UNAVAILABLE', 503, approval, false, { ...result, mutationCommitted: true });
      }
      return result;
    }
    if (approval.action === 'SUBSCRIBER_UPDATE' || approval.action === 'SUBSCRIBER_DELETE' || approval.action === 'SUBSCRIBER_BULK_DELETE') {
      const result = approval.action === 'SUBSCRIBER_UPDATE'
        ? await executeFrozenSubscriberUpdate(approval.payload)
        : approval.action === 'SUBSCRIBER_DELETE'
          ? await executeFrozenSubscriberDelete(approval.payload)
          : await executeFrozenSubscriberBulkDelete(approval.payload);
      const action = approval.action === 'SUBSCRIBER_UPDATE' ? 'subscriber.update' : approval.action === 'SUBSCRIBER_DELETE' ? 'subscriber.delete' : 'subscriber.batch.delete';
      try {
        await writeAuditLog({
          actor: actor || { type: 'system', userId: 'system', username: 'system' }, module: 'subscribers', action,
          resource: { type: 'subscriber', id: approval.targetId, name: approval.targetId }, targetId: approval.targetId,
          approvalId: approval.id, riskLevel: approval.riskLevel, result: 'success', reason: approval.reason,
          before: approval.before, after: approval.action === 'SUBSCRIBER_UPDATE' ? approval.after : null,
          metadata: { executionId: approval.execution?.id, operationFingerprint: approval.operationFingerprint }, ...auditRequestContext(request),
        }, { failureMode: 'strict' });
      } catch {
        throw new ApprovalExecutionError('AUDIT_UNAVAILABLE', 503, approval, false, { mutationCommitted: true });
      }
      return result;
    }
    // Legacy subscriber provisioning, import and bulk-delete actions remain
    // executable while their routes are migrated to frozen payloads.  A CHG
    // must never be creatable merely because this switch forgot its executor.
    return executeApproval(approval, request);
  },
};

/** Exported for architecture tests and invoked at module load: every automatic
 * subscriber approval action is backed by this production executor. */
export const automaticSubscriberExecutorActions = [
  'SUBSCRIBER_UPDATE', 'SUBSCRIBER_DELETE', 'SUBSCRIBER_BATCH_CREATE',
  'SUBSCRIBER_BATCH_UPDATE', 'SUBSCRIBER_IMPORT',
  'SUBSCRIBER_BULK_DELETE',
] as const;

export function assertSubscriberApprovalExecutorCoverage() {
  assertGovernedOperationCoverage(automaticSubscriberExecutorActions);
}
assertSubscriberApprovalExecutorCoverage();

/** OCS administrative actions use the same default executor. The legacy
 * compatibility executor remains only for approvals created before Phase 7. */
export const automaticOcsExecutorActions = ['TRAFFIC_ADJUSTMENT'] as const;
export function assertOcsExecutorCoverage() { assertOcsGovernedOperationCoverage(automaticOcsExecutorActions); }
assertOcsExecutorCoverage();

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Execution-time seam. Checks live state immediately after the execution CAS claim. */
export async function validateExecutionPrecondition(approval: ApprovalDocument, now = new Date()): Promise<void> {
  if (approval.maintenanceWindow) {
    const start = Date.parse(approval.maintenanceWindow.start);
    const end = Date.parse(approval.maintenanceWindow.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || now.getTime() < start || now.getTime() > end) {
      throw new ApprovalExecutionError('OUTSIDE_MAINTENANCE_WINDOW', 409, approval);
    }
  }
  if (approval.action === 'ACCESS_REQUEST') {
    const payload = asRecord(approval.payload);
    const before = asRecord(approval.before);
    const expectedRole = String(before.role || payload.currentRole || 'viewer');
    const account = await getUser(approval.targetId);
    if (!account || account.role !== expectedRole || account.status !== 'active') {
      throw new ApprovalExecutionError('APPROVAL_PRECONDITION_CHANGED', 409, approval);
    }
  }
  // These configuration resources have no database version field. Compare the
  // normalized resource snapshot immediately after the execution claim so an
  // approved change cannot overwrite an intervening operator/runtime update.
  if (approval.before && ['TARIFF_PLAN_UPDATE', 'TARIFF_PLAN_DELETE', 'TARIFF_PLAN_RULE_CREATE', 'TARIFF_PLAN_RULE_UPDATE', 'TARIFF_PLAN_RULE_DELETE', 'TARIFF_PLAN_RULE_TOGGLE'].includes(approval.action)) {
    const payload = asRecord(approval.payload);
    const live = await getTariffPlan(String(payload.planId || ''));
    if (!live || JSON.stringify(live) !== JSON.stringify(approval.before)) throw new ApprovalExecutionError('OCS_RESOURCE_PRECONDITION_CHANGED', 409, approval);
  }
  if (approval.before && ['RATING_UPDATE', 'RATING_DELETE'].includes(approval.action)) {
    const payload = asRecord(approval.payload);
    const live = await getRating(String(payload.id || ''), payload.planId || undefined);
    if (!live || JSON.stringify(live) !== JSON.stringify(approval.before)) throw new ApprovalExecutionError('OCS_RESOURCE_PRECONDITION_CHANGED', 409, approval);
  }
}

async function actorFor(auth: AuthContext): Promise<GovernanceActor> {
  const account = await validateCurrentAccount({ username: auth.user, role: auth.role, sv: auth.sessionVersion });
  return { type: 'user', userId: account.userId, username: account.username, role: account.role };
}

async function writeExecutionAudit(request: Request, action: 'approval.execute.start' | 'approval.execute.completed' | 'approval.execute.failed', approval: ApprovalDocument, actor: GovernanceActor, result: 'success' | 'failed', error?: { code: string; message: string }) {
  try {
    await writeAuditLog({
      actor, module: 'approvals', action,
      resource: { type: 'approval', id: approval.id, name: approval.changeId || approval.id },
      targetId: `approval:${approval.id}`, approvalId: approval.id, riskLevel: approval.riskLevel,
      result, before: null, after: { status: approval.status, execution: approval.execution, event: approval.events.at(-1) },
      metadata: { executionId: approval.execution?.id }, error,
      ...auditRequestContext(request),
    }, { failureMode: 'strict' });
  } catch {
    console.error('APPROVAL_AUDIT_PERSISTENCE_ALERT', { approvalId: approval.id, action, executionId: approval.execution?.id });
    throw new ApprovalExecutionError('AUDIT_UNAVAILABLE', 503, approval, true);
  }
}

async function finishExecution(input: {
  request: Request;
  approval: ApprovalDocument;
  actor: GovernanceActor;
  executionId: string;
  result?: unknown;
  error?: ApprovalExecutionError | Error;
}) {
  const completedAt = new Date().toISOString();
  const failed = Boolean(input.error);
  const code = input.error instanceof ApprovalExecutionError ? input.error.code : input.error instanceof Error ? input.error.message : 'APPROVAL_EXECUTION_FAILED';
  const failureDetails = input.error instanceof ApprovalExecutionError
    ? input.error.details
    : input.error && typeof input.error === 'object' && 'details' in input.error
      ? (input.error as { details?: unknown }).details
      : undefined;
  const next = await transitionApproval({
    id: input.approval.id, expectedStatus: 'executing', expectedExecutionId: input.executionId,
    nextStatus: failed ? 'failed' : 'completed', actor: input.actor.username || 'system',
    eventType: failed ? 'execution_failed' : 'execution_completed',
    eventMessage: failed ? `Execution failed: ${code}` : 'Execution completed',
    patch: {
      result: input.result ?? failureDetails,
      error: failed ? code : undefined,
      executedAt: completedAt,
      execution: {
        ...input.approval.execution,
        id: input.executionId,
        completedAt,
        success: !failed,
        error: failed ? { code, message: code } : undefined,
      },
    },
  });
  if (!next.ok) {
    if (next.reason === 'not_found') throw new ApprovalExecutionError('APPROVAL_NOT_FOUND', 404);
    throw new ApprovalExecutionError('APPROVAL_STATE_CONFLICT', 409, next.approval);
  }
  await writeExecutionAudit(input.request, failed ? 'approval.execute.failed' : 'approval.execute.completed', next.approval, input.actor, failed ? 'failed' : 'success', failed ? { code, message: code } : undefined);
  return next.approval;
}

export async function executeApprovedChange(request: Request, id: string, auth: AuthContext, executor: GovernedApprovalExecutor = defaultExecutor): Promise<ApprovalDocument> {
  const approval = await getApproval(id);
  if (!approval) throw new ApprovalExecutionError('APPROVAL_NOT_FOUND', 404);
  const eligibility = approvalActionEligibility(approval, auth);
  if (!eligibility.canExecute) throw new ApprovalExecutionError('APPROVAL_STATE_CONFLICT', approval.status === 'approved' ? 403 : 409, approval);
  const actor = await actorFor(auth);
  const executionId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const claimed = await transitionApproval({
    id, expectedStatus: 'approved', nextStatus: 'executing', actor: auth.user,
    eventType: 'execution_started', eventMessage: `Execution started (${executionId})`,
    patch: { execution: { id: executionId, startedAt } },
  });
  if (!claimed.ok) {
    if (claimed.reason === 'not_found') throw new ApprovalExecutionError('APPROVAL_NOT_FOUND', 404);
    throw new ApprovalExecutionError('APPROVAL_STATE_CONFLICT', 409, claimed.approval);
  }
  await writeExecutionAudit(request, 'approval.execute.start', claimed.approval, actor, 'success');
  try {
    await validateExecutionPrecondition(claimed.approval);
    const result = await executor.execute(claimed.approval, request, actor);
    return await finishExecution({ request, approval: claimed.approval, actor, executionId, result });
  } catch (error) {
    if (error instanceof SubscriberBatchGovernanceError) {
      return finishExecution({ request, approval: claimed.approval, actor, executionId, error });
    }
    // A post-mutation evidence failure must not be converted into a retryable
    // failed approval. The balance CAS already committed, so keep execution
    // evidence in the claimed state for operator investigation.
    if (error instanceof ApprovalExecutionError && error.committed) throw error;
    return finishExecution({ request, approval: claimed.approval, actor, executionId, error: error instanceof Error ? error : new Error('APPROVAL_EXECUTION_FAILED') });
  }
}

export function executionErrorResponse(error: unknown) {
  if (error instanceof ApprovalExecutionError || error instanceof ApprovalWorkflowError) {
    return Response.json({ error: error.code, code: error.code, approval: error.approval, committed: error.committed || undefined }, { status: error.status });
  }
  const code = error instanceof Error && /^(?:ACCOUNT_|SESSION_)/.test(error.message) ? error.message : 'APPROVAL_EXECUTION_FAILED';
  return Response.json({ error: code, code }, { status: code === 'APPROVAL_EXECUTION_FAILED' ? 500 : 401 });
}
