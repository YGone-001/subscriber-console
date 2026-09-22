import { NextResponse } from 'next/server';
import { requireCapability, type AuthContext } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
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
  enforceRateLimit: typeof enforceRateLimit;
  requireCapability: typeof requireCapability;
  validateAccount: typeof validateCurrentAccount;
  replaceSubscriberCAS: (expected: XcloudSubscriberDocument, replacement: XcloudSubscriberDocument) => Promise<boolean>;
  evaluateSubscriberOperationForActor: typeof evaluateSubscriberOperationForActor;
}

const productionDeps: SubscriberProfileApplyDeps = {
  prepareFrozen: prepareFrozenSubscriberProfileApply,
  assertFrozen: assertFrozenSubscriberProfileApply,
  executeFrozen: executeFrozenSubscriberProfileApply,
  writeAudit: writeAuditLog,
  enforceRateLimit,
  requireCapability,
  validateAccount: validateCurrentAccount,
  evaluateSubscriberOperationForActor,
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

  // Rate limit
  const rate = await deps.enforceRateLimit(`subscriber:profile-apply:${imsi}`, 30, 60);
  if (!rate.ok) return rate.response;

  // Auth: subscriber_write capability required
  const auth = deps.requireCapability(request, 'subscriber_write');
  if (!auth.ok) return auth.response;

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
    const policy = deps.evaluateSubscriberOperationForActor(SUBSCRIBER_OPERATIONS.PROFILE_APPLY, fresh.normalizedRole);
    if (!policy.executable) {
      return NextResponse.json({ error: 'OPERATION_NOT_EXECUTABLE' }, { status: 409 });
    }

    // Direct execution
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

    // Non-gating audit
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
          profileName: profileName.trim(),
          subscriberPreconditionHash: intent.subscriberPreconditionHash,
          profilePreconditionHash: intent.profilePreconditionHash,
          operationFingerprint: intent.operationFingerprint,
          classification: result.classification,
          mutationCommitted: result.committed,
          securityChanged: result.securityChanged,
          actorRole: fresh.normalizedRole,
        },
      }, { failureMode: 'best-effort' });
    } catch (auditErr) {
      console.warn('Audit write failed (non-gating):', auditErr);
    }

    return NextResponse.json({
      outcome: 'executed',
      message: 'Profile applied successfully',
      imsi,
      profileName: profileName.trim(),
    });
  } catch (error) {
    if (error instanceof SubscriberProfileApplyError) {
      const committed = error.committed;
      try {
        await writeTerminalAudit(deps, null, null, null, actor, 'failed', error.code, committed);
      } catch (auditErr) {
        console.warn('Audit write failed (non-gating):', auditErr);
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

export async function POST(request: Request, context: { params: Promise<{ imsi: string }> }) {
  return handleSubscriberProfileApplyPost(request, await context.params);
}

async function writeTerminalAudit(
  deps: SubscriberProfileApplyDeps,
  intent: FrozenSubscriberProfileApplyV1 | null,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  actor: GovernanceActor,
  result: 'success' | 'failed',
  classification: string,
  committed: boolean,
) {
  try {
    await deps.writeAudit({
      module: 'subscribers',
      action: 'SUBSCRIBER_PROFILE_APPLY' as WriteAuditInput['action'],
      targetId: intent?.imsi || 'unknown',
      actor,
      before: before || intent?.before || undefined,
      after: after || undefined,
      result,
      metadata: {
        governanceMode: 'DIRECT_GOVERNED',
        classification,
        mutationCommitted: committed,
        operationFingerprint: intent?.operationFingerprint,
      },
    }, { failureMode: 'best-effort' });
  } catch (err) {
    console.warn('Audit write failed (non-gating):', err);
  }
}
