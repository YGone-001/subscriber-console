/**
 * Governed Approval Creation Application Service
 *
 * Owns exactly:
 *   1 Approval insert (via repository)
 *   1 strict approval.create audit evidence
 *
 * Mirrors Go ApprovalCreator architecture.
 */

import { writeAuditLog } from '@/lib/audit';
import {
  createApprovalRequest,
  type CreateApprovalInput,
  type ApprovalDocument,
} from '@/server/repositories/approvalRepository';
import type { GovernanceActor } from '@/types/governance';

export class ApprovalCreationError extends Error {
  code: string;
  approval?: ApprovalDocument;
  constructor(code: string, approval?: ApprovalDocument) {
    super(code);
    this.code = code;
    this.approval = approval;
  }
}

/**
 * Create a governed Approval with strict audit evidence.
 *
 * Flow:
 *   1. persist Approval via repository
 *   2. write strict approval.create audit
 *   3. return Approval
 *
 * If audit fails after Approval insert:
 *   → throw AUDIT_UNAVAILABLE with committed=true and approval
 *   → Approval is NOT rolled back
 */
export async function createGovernedApproval(
  input: CreateApprovalInput,
  actor: GovernanceActor,
): Promise<ApprovalDocument> {
  // 1. Persist Approval
  const approval = await createApprovalRequest(input);

  // 2. Strict approval.create audit evidence
  try {
    await writeAuditLog({
      module: 'approvals',
      action: 'approval.create',
      targetId: `approval:${approval.id}`,
      actor,
      approvalId: approval.id,
      before: null,
      after: {
        id: approval.id,
        action: input.action,
        requester: input.requester,
        targetId: input.targetId,
        summary: input.summary,
        operationFingerprint: input.operationFingerprint,
      },
      result: 'success',
      metadata: {
        operation: input.action,
        operationFingerprint: input.operationFingerprint,
      },
    }, { failureMode: 'strict' });
  } catch {
    throw new ApprovalCreationError('AUDIT_UNAVAILABLE', approval);
  }

  return approval;
}
