import { NextResponse } from 'next/server';
import { requireCapability, type AuthContext } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { createApprovalRequest, type CreateApprovalInput } from '@/server/repositories/approvalRepository';
import { writeAuditLog, type WriteAuditInput, type AuditWriteOptions } from '@/lib/audit';
import { validateCurrentAccount } from '@/lib/accountSession';
import { evaluateSubscriberOperationForActor, SUBSCRIBER_OPERATIONS } from '@/server/subscriberGovernanceRegistry';
import {
  prepareFrozenSubscriberProfileApply,
  assertFrozenSubscriberProfileApply,
  executeFrozenSubscriberProfileApply,
  SubscriberProfileApplyError,
} from '@/server/subscriberProfileApplyGovernance';
import type { FrozenSubscriberProfileApplyV1, ProfileApplyAssertion } from '@/server/subscriberProfileApplyGovernance';
import type { XcloudSubscriberDocument } from '@/types/xcloud';
import type { GovernanceActor } from '@/types/governance';

export const dynamic = 'force-dynamic';

/**
 * Map requireCapability AuthContext to validateCurrentAccount SessionClaims.
 *
 * requireCapability returns: { user, role, sessionVersion }
 * validateCurrentAccount expects: { username, role, sv }
 *
 * This adapter makes the field-shape translation explicit and prevents
 * silent validation failures from mismatched field names.
 */
export function toCurrentAccountClaims(auth: AuthContext): { username: string; role: string; sv: number } {
  return {
    username: auth.user,
    role: auth.role,
    sv: auth.sessionVersion,
  };
}

// ─── Testable Seam ───

export interface SubscriberProfileApplyDeps {
  prepareFrozen: typeof prepareFrozenSubscriberProfileApply;
  assertFrozen: typeof assertFrozenSubscriberProfileApply;
  executeFrozen: (assertion: ProfileApplyAssertion, actor: string, replaceCAS: (expected: XcloudSubscriberDocument, replacement: XcloudSubscriberDocument) => Promise<boolean>) => Promise<{ restored: XcloudSubscriberDocument; classification: string; committed: boolean; securityChanged: boolean }>;
  writeAudit: (input: WriteAuditInput, options?: AuditWriteOptions) => Promise<boolean>;
  createApproval: (input: CreateApprovalInput) => Promise<{ id: string }>;
  enforceRateLimit: typeof enforceRateLimit;
  requireCapability: typeof requireCapability;
  validateAccount: typeof validateCurrentAccount;
  replaceSubscriberCAS: (expected: XcloudSubscriberDocument, replacement: XcloudSubscriberDocument) => Promise<boolean>;
}

const productionDeps: SubscriberProfileApplyDeps = {
  prepareFrozen: prepareFrozenSubscriberProfileApply,
  assertFrozen: assertFrozenSubscriberProfileApply,
  executeFrozen: executeFrozenSubscriberProfileApply,
  writeAudit: writeAuditLog,
  createApproval: createApprovalRequest,
  enforceRateLimit,
  requireCapability,
  validateAccount: validateCurrentAccount,
  replaceSubscriberCAS: async (expected, replacement) => {
    const { replaceSubscriberCAS } = await import('@/server/repositories/subscriberRepository');
    return replaceSubscriberCAS(expected, replacement);
  },
};

export async function handleSubscriberProfileApplyPost(
  request: Request,
  params: { imsi: string },
  deps: SubscriberProfileApplyDeps = productionDeps,
): Promise<Response> {
  const { imsi } = params;

  // Auth + capability
  const auth = deps.requireCapability(request, 'subscriber_write');
  if (!auth.ok) return auth.response;

  // Rate limit
  const rateLimit = await deps.enforceRateLimit(`subscribers:profile-apply:${auth.auth.user}`, 30, 60);
  if (!rateLimit.ok) return rateLimit.response;

  // Parse body
  let body: { profileName?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body', code: 'INVALID_REQUEST' }, { status: 400 });
  }

  const profileName = body?.profileName;
  if (!profileName || typeof profileName !== 'string' || !profileName.trim()) {
    return NextResponse.json({ error: 'profileName is required', code: 'INVALID_PROFILE_NAME' }, { status: 400 });
  }

  // Fresh actor validation — fail closed
  let fresh: { username: string; normalizedRole: string };
  try {
    fresh = await deps.validateAccount(toCurrentAccountClaims(auth.auth));
  } catch {
    return NextResponse.json({ error: 'Session invalid', code: 'AUTH_INVALID_SESSION' }, { status: 401 });
  }

  const actor: GovernanceActor = { type: 'user', username: fresh.username, role: fresh.normalizedRole };

  try {
    // Prepare frozen intent
    const intent = await deps.prepareFrozen(imsi, profileName.trim());

    // Governance decision using registry
    const policy = evaluateSubscriberOperationForActor(SUBSCRIBER_OPERATIONS.PROFILE_APPLY, fresh.normalizedRole);
    if (!policy.executable) {
      return NextResponse.json({ error: 'OPERATION_NOT_EXECUTABLE' }, { status: 409 });
    }

    if (policy.governanceMode === 'DIRECT_GOVERNED') {
      // Super Admin/root: DIRECT_GOVERNED — execute immediately
      // Re-assert current state
      const assertion = await deps.assertFrozen(intent);
      if (!assertion) {
        // Drift detected
        await writeTerminalAudit(deps, intent, null, null, actor, 'failed', 'PRECONDITION_CHANGED', false);
        return NextResponse.json({
          error: 'Subscriber or Profile changed since preparation',
          code: 'SUBSCRIBER_PROFILE_APPLY_PRECONDITION_CHANGED',
          committed: false,
        }, { status: 409 });
      }

      // Execute CAS
      const result = await deps.executeFrozen(assertion, fresh.username, deps.replaceSubscriberCAS);

      // Strict audit — committed=true on failure
      try {
        await deps.writeAudit({
          module: 'subscribers',
          action: 'SUBSCRIBER_PROFILE_APPLY' as WriteAuditInput['action'],
          targetId: imsi,
          actor,
          before: intent.before,
          after: intent.afterPreview,
          result: 'success',
          metadata: {
            governanceMode: 'DIRECT_GOVERNED',
            approvalRequired: false,
            profileName: profileName.trim(),
            subscriberPreconditionHash: intent.subscriberPreconditionHash,
            profilePreconditionHash: intent.profilePreconditionHash,
            operationFingerprint: intent.operationFingerprint,
            classification: result.classification,
            mutationCommitted: result.committed,
            securityChanged: result.securityChanged,
            actorRole: fresh.normalizedRole,
          },
        }, { failureMode: 'strict' });
      } catch {
        return NextResponse.json({
          error: 'Audit unavailable',
          code: 'AUDIT_UNAVAILABLE',
          committed: true,
        }, { status: 503 });
      }

      return NextResponse.json({
        outcome: 'executed',
        message: 'Profile applied successfully',
        imsi,
        profileName: profileName.trim(),
      });
    }

    // APPROVAL_GOVERNED — create approval
    const approval = await deps.createApproval({
      action: 'SUBSCRIBER_PROFILE_APPLY',
      requester: fresh.username,
      targetId: `subscriber:${imsi}`,
      summary: `Apply profile ${profileName} to subscriber ${imsi}`,
      operation: {
        resourceType: 'subscriber',
        resourceId: imsi,
      },
      payload: {
        version: 'subscriber-profile-apply-v1',
        imsi,
        profileName: profileName.trim(),
        subscriberPreconditionHash: intent.subscriberPreconditionHash,
        profilePreconditionHash: intent.profilePreconditionHash,
        before: intent.before,
        afterPreview: intent.afterPreview,
        operationFingerprint: intent.operationFingerprint,
      },
    } as CreateApprovalInput);

    return NextResponse.json({
      outcome: 'approval_required',
      message: 'Approval required before profile apply',
      approval: { id: approval.id },
    }, { status: 202 });
  } catch (error) {
    if (error instanceof SubscriberProfileApplyError) {
      const committed = error.committed;
      try {
        await writeTerminalAudit(deps, null, null, null, actor, 'failed', error.code, committed);
      } catch {
        return NextResponse.json({
          error: 'Audit unavailable',
          code: 'AUDIT_UNAVAILABLE',
          committed,
        }, { status: 503 });
      }

      const status = error.status || 409;
      return NextResponse.json({
        error: error.code,
        code: error.code,
        committed,
      }, { status });
    }

    console.error('Profile apply error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

async function writeTerminalAudit(
  deps: SubscriberProfileApplyDeps,
  intent: FrozenSubscriberProfileApplyV1 | null,
  before: unknown,
  after: unknown,
  actor: GovernanceActor,
  result: 'success' | 'failed' | 'denied',
  classification: string,
  committed: boolean,
) {
  await deps.writeAudit({
    module: 'subscribers',
    action: 'SUBSCRIBER_PROFILE_APPLY' as WriteAuditInput['action'],
    targetId: intent?.imsi || 'unknown',
    actor,
    before: before || undefined,
    after: after || undefined,
    result,
    metadata: {
      governanceMode: 'DIRECT_GOVERNED',
      approvalRequired: false,
      profileName: intent?.profileName || 'unknown',
      subscriberPreconditionHash: intent?.subscriberPreconditionHash,
      profilePreconditionHash: intent?.profilePreconditionHash,
      operationFingerprint: intent?.operationFingerprint,
      classification,
      mutationCommitted: committed,
    },
  }, { failureMode: 'strict' });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ imsi: string }> },
) {
  const resolved = await params;
  return handleSubscriberProfileApplyPost(request, resolved);
}
