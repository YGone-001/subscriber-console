import { writeAuditLog } from '@/lib/audit';
import { auditRequestContext } from '@/lib/audit/record';
import { validateCurrentAccount } from '@/lib/accountSession';
import { hasPermission, type Permission } from '@/lib/permissions';
import { requiresIndependentReviewer } from '@/server/approvalRiskPolicy';
import {
  getApproval,
  transitionApproval,
  type ApprovalDocument,
} from '@/server/repositories/approvalRepository';
import type { AuthContext } from '@/lib/authz';
import type { GovernanceActor } from '@/types/governance';

export type ApprovalActionEligibility = {
  canApprove: boolean;
  approveReason?: string;
  canReject: boolean;
  rejectReason?: string;
  canCancel: boolean;
  cancelReason?: string;
  canExecute: boolean;
  executeReason?: string;
};

export class ApprovalWorkflowError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    public readonly approval?: ApprovalDocument,
    public readonly committed = false
  ) { super(code); }
}

function permission(role: string, required: Permission): boolean {
  return hasPermission({ role }, required);
}

export function approvalActionEligibility(approval: ApprovalDocument, actor: { user: string; role: string }): ApprovalActionEligibility {
  const pending = approval.status === 'pending';
  const independent = requiresIndependentReviewer(approval.riskLevel);
  const selfReviewBlocked = independent && approval.requester === actor.user;
  const canApprove = pending && permission(actor.role, 'approvals.approve') && !selfReviewBlocked;
  const canReject = pending && permission(actor.role, 'approvals.reject') && !selfReviewBlocked;
  const canCancel = pending && permission(actor.role, 'approvals.cancel') && approval.requester === actor.user;
  const canExecute = approval.status === 'approved' && permission(actor.role, 'approvals.execute');
  return {
    canApprove,
    approveReason: canApprove ? undefined : !pending ? 'Approval is not pending' : !permission(actor.role, 'approvals.approve') ? 'Missing approvals.approve permission' : 'Independent reviewer required',
    canReject,
    rejectReason: canReject ? undefined : !pending ? 'Approval is not pending' : !permission(actor.role, 'approvals.reject') ? 'Missing approvals.reject permission' : 'Independent reviewer required',
    canCancel,
    cancelReason: canCancel ? undefined : !pending ? 'Only pending requests can be cancelled' : approval.requester !== actor.user ? 'Only the requester can cancel this request' : 'Missing approvals.cancel permission',
    canExecute,
    executeReason: canExecute ? undefined : approval.status !== 'approved' ? 'Only approved changes can be executed' : 'Missing approvals.execute permission',
  };
}

function cleanOptionalText(value: unknown, max = 1000): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length > max) throw new ApprovalWorkflowError('APPROVAL_TEXT_TOO_LONG', 400);
  return text || undefined;
}

async function currentActor(auth: AuthContext): Promise<GovernanceActor> {
  const account = await validateCurrentAccount({ username: auth.user, role: auth.role, sv: auth.sessionVersion });
  return { type: 'user', userId: account.userId, username: account.username, role: account.role };
}

async function auditTransition(request: Request, action: string, before: ApprovalDocument, after: ApprovalDocument, actor: GovernanceActor, reason?: string) {
  const context = auditRequestContext(request);
  try {
    await writeAuditLog({
      actor,
      module: 'approvals',
      action: action as `${string}.${string}`,
      resource: { type: 'approval', id: after.id, name: after.changeId || after.id },
      targetId: `approval:${after.id}`,
      approvalId: after.id,
      riskLevel: after.riskLevel,
      result: 'success',
      before: { status: before.status },
      after: { status: after.status, event: after.events.at(-1) },
      ...context,
      reason: reason || context.reason,
    }, { failureMode: 'strict' });
  } catch {
    // The in-document event is already durable. Never attempt an unsafe cross-collection rollback.
    console.error('APPROVAL_AUDIT_PERSISTENCE_ALERT', { approvalId: after.id, action });
    throw new ApprovalWorkflowError('AUDIT_UNAVAILABLE', 503, after, true);
  }
}

async function loadPending(id: string): Promise<ApprovalDocument> {
  const approval = await getApproval(id);
  if (!approval) throw new ApprovalWorkflowError('APPROVAL_NOT_FOUND', 404);
  if (approval.status === 'pending' && approval.expiresAt && Date.parse(approval.expiresAt) <= Date.now()) {
    const expired = await transitionApproval({
      id, expectedStatus: 'pending', nextStatus: 'expired', actor: 'system',
      eventType: 'expired', eventMessage: 'Approval expired before a decision',
    });
    if (expired.ok) throw new ApprovalWorkflowError('APPROVAL_EXPIRED', 409, expired.approval);
  }
  return approval;
}

async function casOrThrow(input: Parameters<typeof transitionApproval>[0]): Promise<ApprovalDocument> {
  const result = await transitionApproval(input);
  if (result.ok) return result.approval;
  if (result.reason === 'not_found') throw new ApprovalWorkflowError('APPROVAL_NOT_FOUND', 404);
  throw new ApprovalWorkflowError('APPROVAL_STATE_CONFLICT', 409, result.approval);
}

export async function approveChange(request: Request, id: string, auth: AuthContext, body: unknown) {
  const approval = await loadPending(id);
  const eligibility = approvalActionEligibility(approval, auth);
  if (!eligibility.canApprove) throw new ApprovalWorkflowError(approval.status === 'pending' ? 'MAKER_CHECKER_VIOLATION' : 'APPROVAL_STATE_CONFLICT', approval.status === 'pending' ? 403 : 409, approval);
  const actor = await currentActor(auth);
  const comment = cleanOptionalText((body as Record<string, unknown> | null)?.comment);
  const now = new Date().toISOString();
  const next = await casOrThrow({
    id, expectedStatus: 'pending', nextStatus: 'approved', actor: auth.user,
    eventType: 'approved', eventMessage: comment ? `Change approved: ${comment}` : 'Change approved',
    patch: { reviewer: auth.user, reviewerContext: actor, reviewedAt: now, note: comment, decision: { outcome: 'approved', comment, decidedAt: now } },
  });
  await auditTransition(request, 'approval.approve', approval, next, actor, comment);
  return next;
}

export async function rejectChange(request: Request, id: string, auth: AuthContext, body: unknown) {
  const reason = cleanOptionalText((body as Record<string, unknown> | null)?.reason);
  if (!reason || reason.length < 3) throw new ApprovalWorkflowError('REJECTION_REASON_REQUIRED', 400);
  const approval = await loadPending(id);
  const eligibility = approvalActionEligibility(approval, auth);
  if (!eligibility.canReject) throw new ApprovalWorkflowError(approval.status === 'pending' ? 'MAKER_CHECKER_VIOLATION' : 'APPROVAL_STATE_CONFLICT', approval.status === 'pending' ? 403 : 409, approval);
  const actor = await currentActor(auth);
  const now = new Date().toISOString();
  const next = await casOrThrow({
    id, expectedStatus: 'pending', nextStatus: 'rejected', actor: auth.user,
    eventType: 'rejected', eventMessage: `Change rejected: ${reason}`,
    patch: { reviewer: auth.user, reviewerContext: actor, reviewedAt: now, note: reason, decision: { outcome: 'rejected', comment: reason, decidedAt: now } },
  });
  await auditTransition(request, 'approval.reject', approval, next, actor, reason);
  return next;
}

export async function cancelChange(request: Request, id: string, auth: AuthContext, body: unknown) {
  const approval = await loadPending(id);
  const eligibility = approvalActionEligibility(approval, auth);
  if (!eligibility.canCancel) throw new ApprovalWorkflowError(approval.status === 'pending' ? 'APPROVAL_CANCEL_FORBIDDEN' : 'APPROVAL_STATE_CONFLICT', approval.status === 'pending' ? 403 : 409, approval);
  const actor = await currentActor(auth);
  const reason = cleanOptionalText((body as Record<string, unknown> | null)?.reason);
  const next = await casOrThrow({
    id, expectedStatus: 'pending', nextStatus: 'cancelled', actor: auth.user,
    eventType: 'cancelled', eventMessage: reason ? `Change cancelled: ${reason}` : 'Change cancelled by requester',
    patch: { note: reason },
  });
  await auditTransition(request, 'approval.cancel', approval, next, actor, reason);
  return next;
}

export function workflowErrorResponse(error: unknown) {
  if (error instanceof ApprovalWorkflowError) {
    return Response.json({ error: error.code, code: error.code, approval: error.approval, committed: error.committed || undefined }, { status: error.status });
  }
  const code = error instanceof Error && error.message.startsWith('ACCOUNT_') ? error.message : 'APPROVAL_OPERATION_FAILED';
  return Response.json({ error: code, code }, { status: code === 'APPROVAL_OPERATION_FAILED' ? 500 : 401 });
}
