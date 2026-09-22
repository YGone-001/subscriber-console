import { NextResponse } from 'next/server';
import { requireCapability } from '@/lib/authz';
import { capabilityDecision } from '@/lib/permissions';
import { enforceRateLimit } from '@/lib/rateLimit';
import {
  prepareFrozenRestoreV2,
  assertFrozenRestoreV2,
  executeFrozenRestoreV2,
  writeRestoreAudit,
} from '@/server/profileRestoreGovernance';

export const dynamic = 'force-dynamic';

/**
 * Dependencies for profile restore route — injectable for testing.
 * All fields default to production implementations.
 */
export interface ProfileRestoreRouteDeps {
  prepareFrozenRestoreV2: typeof prepareFrozenRestoreV2;
  assertFrozenRestoreV2: typeof assertFrozenRestoreV2;
  executeFrozenRestoreV2: typeof executeFrozenRestoreV2;
  writeRestoreAudit: typeof writeRestoreAudit;
  enforceRateLimit: typeof enforceRateLimit;
  requireCapability: typeof requireCapability;
  capabilityDecision: typeof capabilityDecision;
}

const productionDeps: ProfileRestoreRouteDeps = {
  prepareFrozenRestoreV2,
  assertFrozenRestoreV2,
  executeFrozenRestoreV2,
  writeRestoreAudit,
  enforceRateLimit,
  requireCapability,
  capabilityDecision,
};

/**
 * Core handler logic — called by both POST() and tests.
 * All external dependencies are injected via `deps`.
 */
export async function handleProfileRestorePost(
  request: Request,
  params: { name: string; versionId: string },
  deps: ProfileRestoreRouteDeps = productionDeps
): Promise<Response> {
  const { name, versionId } = params;
  const auth = deps.requireCapability(request, 'profile_rollback');
  if (!auth.ok) return auth.response;

  const rateLimit = await deps.enforceRateLimit(`profiles:restore:${auth.auth.user}`, 10, 60);
  if (!rateLimit.ok) return rateLimit.response;

  if (!/^[a-zA-Z0-9_\s-]+$/.test(name)) {
    return NextResponse.json({ error: 'Invalid profile name format' }, { status: 400 });
  }

  try {
    // Prepare frozen v2 intent
    const intent = await deps.prepareFrozenRestoreV2(name, versionId, auth.auth.user);
    if (!intent) {
      return NextResponse.json({ error: 'Version not found' }, { status: 404 });
    }

    // Direct execution for all authorized roles
    const assertion = await deps.assertFrozenRestoreV2(intent);
    if (!assertion) {
      // Source version or current profile drifted
      try {
        await deps.writeRestoreAudit(
          intent,
          null,
          null,
          { username: auth.auth.user, role: auth.auth.role },
          'failed',
          'PRECONDITION_CHANGED',
          false,
          'DIRECT_GOVERNED'
        );
      } catch (err) {
        console.warn('Audit write failed (non-gating):', err);
      }
      return NextResponse.json(
        { error: 'Profile was modified since loaded', code: 'PROFILE_RESTORE_PRECONDITION_CHANGED' },
        { status: 409 }
      );
    }

    // Execute frozen restore v2
    let result;
    try {
      result = await deps.executeFrozenRestoreV2(assertion, auth.auth.user);
    } catch (error: unknown) {
      const err = error as { code?: string; message?: string };

      if (err.code === 'PROFILE_RESTORE_PRECONDITION_CHANGED') {
        try {
          await deps.writeRestoreAudit(
            intent,
            assertion.currentProfile,
            null,
            { username: auth.auth.user, role: auth.auth.role },
            'failed',
            'PRECONDITION_CHANGED',
            false,
            'DIRECT_GOVERNED'
          );
        } catch (auditErr) {
          console.warn('Audit write failed (non-gating):', auditErr);
        }
        return NextResponse.json(
          { error: 'Profile was modified since loaded', code: 'PROFILE_RESTORE_PRECONDITION_CHANGED' },
          { status: 409 }
        );
      }

      if (err.code === 'PROFILE_RESTORE_PARTIAL_WRITE') {
        try {
          await deps.writeRestoreAudit(
            intent,
            assertion.currentProfile,
            null,
            { username: auth.auth.user, role: auth.auth.role },
            'failed',
            'PARTIAL_WRITE',
            true,
            'DIRECT_GOVERNED'
          );
        } catch (auditErr) {
          console.warn('Audit write failed (non-gating):', auditErr);
        }
        return NextResponse.json(
          { error: 'Profile restored but version save failed', code: 'PROFILE_RESTORE_PARTIAL_WRITE', committed: true },
          { status: 500 }
        );
      }

      // Storage failure
      try {
        await deps.writeRestoreAudit(
          intent,
          assertion.currentProfile,
          null,
          { username: auth.auth.user, role: auth.auth.role },
          'failed',
          'FAILED_NO_MUTATION',
          false,
          'DIRECT_GOVERNED'
        );
      } catch (auditErr) {
        console.warn('Audit write failed (non-gating):', auditErr);
      }
      return NextResponse.json(
        { error: 'Profile restore failed', code: 'PROFILE_RESTORE_FAILED', committed: false },
        { status: 500 }
      );
    }

    // Success - non-gating audit
    try {
      await deps.writeRestoreAudit(
        intent,
        assertion.currentProfile,
        result.restored as Record<string, unknown>,
        { username: auth.auth.user, role: auth.auth.role },
        'success',
        result.classification,
        result.committed,
        'DIRECT_GOVERNED'
      );
    } catch (auditErr) {
      console.warn('Audit write failed (non-gating):', auditErr);
    }

    return NextResponse.json({ message: 'Profile restored successfully', profile: result.restored });
  } catch (error: unknown) {
    console.error('Error restoring profile version:', error);
    return NextResponse.json(
      { error: 'Profile restore failed', code: 'PROFILE_RESTORE_FAILED', committed: false },
      { status: 500 }
    );
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ name: string; versionId: string }> }
) {
  const resolved = await params;
  return handleProfileRestorePost(request, resolved);
}
