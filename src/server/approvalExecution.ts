import { writeAuditLog } from '@/lib/audit';
import { auditRequestContext } from '@/lib/audit/record';
import { validateCurrentAccount } from '@/lib/accountSession';
import { executeApproval } from '@/server/approvalExecutors';
import { approvalActionEligibility, ApprovalWorkflowError } from '@/server/approvalWorkflow';
import { getApproval, transitionApproval, type ApprovalDocument } from '@/server/repositories/approvalRepository';
import { getUser } from '@/server/repositories/userRepository';
import type { AuthContext } from '@/lib/authz';
import type { GovernanceActor } from '@/types/governance';

export interface GovernedApprovalExecutor {
  execute(approval: ApprovalDocument, request: Request): Promise<unknown>;
}

export class ApprovalExecutionError extends Error {
  constructor(public readonly code: string, public readonly status = 409, public readonly approval?: ApprovalDocument, public readonly committed = false) {
    super(code);
  }
}

const defaultExecutor: GovernedApprovalExecutor = {
  async execute(approval, request) {
    // Phase 4 deliberately governs only the safe access-request path. Production
    // Subscriber/OCS/NF executors remain outside this rollout until Phase 5.
    if (approval.action !== 'ACCESS_REQUEST') throw new ApprovalExecutionError('APPROVAL_EXECUTOR_NOT_ENABLED', 409);
    return executeApproval(approval, request);
  },
};

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
  const next = await transitionApproval({
    id: input.approval.id, expectedStatus: 'executing', expectedExecutionId: input.executionId,
    nextStatus: failed ? 'failed' : 'completed', actor: input.actor.username || 'system',
    eventType: failed ? 'execution_failed' : 'execution_completed',
    eventMessage: failed ? `Execution failed: ${code}` : 'Execution completed',
    patch: {
      result: input.result,
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
    const result = await executor.execute(claimed.approval, request);
    return await finishExecution({ request, approval: claimed.approval, actor, executionId, result });
  } catch (error) {
    if (error instanceof ApprovalExecutionError && error.code === 'AUDIT_UNAVAILABLE' && error.committed) throw error;
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
