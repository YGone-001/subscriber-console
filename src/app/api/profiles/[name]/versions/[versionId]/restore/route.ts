import { NextResponse } from 'next/server';
import { requireCapability } from '@/lib/authz';
import { capabilityDecision } from '@/lib/permissions';
import { enforceRateLimit } from '@/lib/rateLimit';
import { createApprovalRequest } from '@/server/repositories/approvalRepository';
import {
  prepareFrozenRestoreV2,
  assertFrozenRestoreV2,
  executeFrozenRestoreV2,
  writeRestoreAudit,
} from '@/server/profileRestoreGovernance';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ name: string; versionId: string }> }
) {
  const { name, versionId } = await params;
  const auth = requireCapability(request, 'profile_rollback', { allowApproval: true });
  if (!auth.ok) return auth.response;

  const rateLimit = await enforceRateLimit(`profiles:restore:${auth.auth.user}`, 10, 60);
  if (!rateLimit.ok) return rateLimit.response;

  if (!/^[a-zA-Z0-9_\s-]+$/.test(name)) {
    return NextResponse.json({ error: 'Invalid profile name format' }, { status: 400 });
  }

  try {
    // Prepare frozen v2 intent
    const intent = await prepareFrozenRestoreV2(name, versionId, auth.auth.user);
    if (!intent) {
      return NextResponse.json({ error: 'Version not found' }, { status: 404 });
    }

    // Check if approval required (operator)
    if (capabilityDecision(auth.auth.role, 'profile_rollback') === 'approval') {
      const approval = await createApprovalRequest({
        action: 'PROFILE_RESTORE',
        requester: auth.auth.user,
        targetId: `profile:${name}`,
        summary: `Restore profile ${name} from version ${versionId}`,
        payload: {
          version: 'profile-restore-v2',
          name,
          versionId,
          requester: auth.auth.user,
          sourceVersionHash: intent.sourceVersionHash,
          currentState: intent.currentState,
          currentProfileHash: intent.currentProfileHash,
          effectiveRestoredHash: intent.effectiveRestoredHash,
          operationFingerprint: intent.operationFingerprint,
        },
      });

      // Audit approval creation
      await writeRestoreAudit(
        intent,
        null,
        null,
        { username: auth.auth.user, role: auth.auth.role },
        'success',
        'APPROVAL_GOVERNED',
        false,
        'APPROVAL_GOVERNED'
      );

      return NextResponse.json(
        { message: 'Approval required before profile restore', approval },
        { status: 202 }
      );
    }

    // Direct execution for super_admin/root/ops_admin
    const assertion = await assertFrozenRestoreV2(intent);
    if (!assertion) {
      await writeRestoreAudit(
        intent,
        null,
        null,
        { username: auth.auth.user, role: auth.auth.role },
        'failed',
        'PRECONDITION_CHANGED',
        false,
        'DIRECT_GOVERNED'
      );
      return NextResponse.json(
        { error: 'Profile was modified since loaded', code: 'PROFILE_RESTORE_PRECONDITION_CHANGED' },
        { status: 409 }
      );
    }

    // Execute frozen restore v2
    const result = await executeFrozenRestoreV2(assertion, auth.auth.user);

    // Success - strict audit
    await writeRestoreAudit(
      intent,
      assertion.currentProfile,
      result.restored as Record<string, unknown>,
      { username: auth.auth.user, role: auth.auth.role },
      'success',
      result.classification,
      result.committed,
      'DIRECT_GOVERNED'
    );

    return NextResponse.json({ message: 'Profile restored successfully', profile: result.restored });
  } catch (error: unknown) {
    const err = error as { code?: string; message?: string };

    // Handle specific error codes
    if (err.code === 'PROFILE_RESTORE_PRECONDITION_CHANGED') {
      return NextResponse.json(
        { error: 'Profile was modified since loaded', code: 'PROFILE_RESTORE_PRECONDITION_CHANGED' },
        { status: 409 }
      );
    }

    if (err.code === 'PROFILE_RESTORE_PARTIAL_WRITE') {
      return NextResponse.json(
        { error: 'Profile restored but version save failed', code: 'PROFILE_RESTORE_PARTIAL_WRITE', committed: true },
        { status: 500 }
      );
    }

    console.error('Error restoring profile version:', error);
    return NextResponse.json(
      { error: 'Profile restore failed', code: 'PROFILE_RESTORE_FAILED', committed: false },
      { status: 500 }
    );
  }
}
