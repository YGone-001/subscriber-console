import { NextResponse } from 'next/server';
import { writeAuditLog } from '@/lib/audit';
import { requireAuth, requirePermission } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { safeProfileSnapshot } from '@/lib/profileAudit';
import {
  deleteProfile,
  getProfile,
  getProfileStats,
  updateProfile,
} from '@/server/repositories/profileRepository';

export const dynamic = 'force-dynamic';

type RouteContext = {
  params: Promise<{ name: string }>;
};

function isValidProfileName(name: string): boolean {
  return /^[a-zA-Z0-9_\s-]+$/.test(name);
}

export async function GET(request: Request, { params }: RouteContext) {
  const { name } = await params;
  const auth = requireAuth(request);
  if (!auth.ok) return auth.response;

  const rateLimit = await enforceRateLimit(`profiles:detail:${auth.auth.user}`, 120, 60);
  if (!rateLimit.ok) return rateLimit.response;

  if (!isValidProfileName(name)) {
    return NextResponse.json({ error: 'Invalid profile name format' }, { status: 400 });
  }

  try {
    const profile = await getProfile(name);
    if (!profile) {
      return NextResponse.json({ error: 'Profile not found' }, { status: 404 });
    }

    const stats = await getProfileStats(name);
    return NextResponse.json({ profile, stats });
  } catch (error) {
    console.error('Error fetching profile:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function PUT(request: Request, { params }: RouteContext) {
  const { name } = await params;
  const auth = requirePermission(request, 'profiles.write');
  if (!auth.ok) return auth.response;

  const rateLimit = await enforceRateLimit(`profiles:update:${auth.auth.user}`, 30, 60);
  if (!rateLimit.ok) return rateLimit.response;

  if (!isValidProfileName(name)) {
    return NextResponse.json({ error: 'Invalid profile name format' }, { status: 400 });
  }

  try {
    const body = await request.json();
    const { existing, updated } = await updateProfile(name, body, auth.auth.user);

    // Strict audit AFTER mutation
    try {
      await writeAuditLog({
        actor: { type: 'user', username: auth.auth.user, role: auth.auth.role },
        module: 'profiles',
        action: 'PROFILE_UPDATE',
        targetId: name,
        resource: { type: 'profile', id: name },
        result: 'success',
        before: safeProfileSnapshot(existing as Record<string, unknown>),
        after: safeProfileSnapshot(updated as Record<string, unknown>),
        metadata: {
          governanceMode: 'DIRECT_GOVERNED',
          approvalRequired: false,
          actorRole: auth.auth.role,
          mutationCommitted: true,
        },
      }, { failureMode: 'strict' });
    } catch {
      return NextResponse.json({
        code: 'AUDIT_UNAVAILABLE',
        message: 'Audit evidence could not be persisted',
        committed: true,
      }, { status: 503 });
    }

    return NextResponse.json({ message: 'Profile updated successfully' });
  } catch (error) {
    const code = (error as unknown as { code?: string }).code;

    if (code === 'INVALID_PROFILE_UPDATE') {
      return NextResponse.json({
        code: 'INVALID_PROFILE_UPDATE',
        message: error instanceof Error ? error.message : 'Invalid profile update',
        committed: false,
      }, { status: 400 });
    }

    if (code === 'PROFILE_UPDATE_PRECONDITION_CHANGED') {
      // Audit the conflict - strict audit failure returns 503
      try {
        await writeAuditLog({
          actor: { type: 'user', username: auth.auth.user, role: auth.auth.role },
          module: 'profiles',
          action: 'PROFILE_UPDATE',
          targetId: name,
          resource: { type: 'profile', id: name },
          result: 'failed',
          metadata: {
            governanceMode: 'DIRECT_GOVERNED',
            approvalRequired: false,
            actorRole: auth.auth.role,
            mutationCommitted: false,
            classification: 'PRECONDITION_CHANGED',
          },
        }, { failureMode: 'strict' });
      } catch {
        return NextResponse.json({
          code: 'AUDIT_UNAVAILABLE',
          message: 'Audit evidence could not be persisted',
          committed: false,
        }, { status: 503 });
      }
      return NextResponse.json({
        code: 'PROFILE_UPDATE_PRECONDITION_CHANGED',
        message: 'Profile was modified by another request',
        committed: false,
      }, { status: 409 });
    }

    if (code === 'PROFILE_UPDATE_PARTIAL_WRITE') {
      // CAS succeeded but version write failed - mutation committed
      try {
        await writeAuditLog({
          actor: { type: 'user', username: auth.auth.user, role: auth.auth.role },
          module: 'profiles',
          action: 'PROFILE_UPDATE',
          targetId: name,
          resource: { type: 'profile', id: name },
          result: 'failed',
          metadata: {
            governanceMode: 'DIRECT_GOVERNED',
            approvalRequired: false,
            actorRole: auth.auth.role,
            mutationCommitted: true,
            classification: 'PARTIAL_WRITE',
          },
        }, { failureMode: 'strict' });
      } catch {
        return NextResponse.json({
          code: 'AUDIT_UNAVAILABLE',
          message: 'Audit evidence could not be persisted',
          committed: true,
        }, { status: 503 });
      }
      return NextResponse.json({
        code: 'PROFILE_UPDATE_PARTIAL_WRITE',
        message: 'Profile updated but version write failed',
        committed: true,
      }, { status: 500 });
    }

    if (code === 'PROFILE_UPDATE_FAILED') {
      // Storage failure - no mutation
      try {
        await writeAuditLog({
          actor: { type: 'user', username: auth.auth.user, role: auth.auth.role },
          module: 'profiles',
          action: 'PROFILE_UPDATE',
          targetId: name,
          resource: { type: 'profile', id: name },
          result: 'failed',
          metadata: {
            governanceMode: 'DIRECT_GOVERNED',
            approvalRequired: false,
            actorRole: auth.auth.role,
            mutationCommitted: false,
            classification: 'FAILED_NO_MUTATION',
          },
        }, { failureMode: 'strict' });
      } catch {
        return NextResponse.json({
          code: 'AUDIT_UNAVAILABLE',
          message: 'Audit evidence could not be persisted',
          committed: false,
        }, { status: 503 });
      }
      return NextResponse.json({
        code: 'PROFILE_UPDATE_FAILED',
        message: 'Failed to update profile',
        committed: false,
      }, { status: 500 });
    }

    console.error('Error updating profile:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: RouteContext) {
  const { name } = await params;
  const auth = requirePermission(request, 'profiles.write');
  if (!auth.ok) return auth.response;

  const rateLimit = await enforceRateLimit(`profiles:delete:${auth.auth.user}`, 20, 60);
  if (!rateLimit.ok) return rateLimit.response;

  if (!isValidProfileName(name)) {
    return NextResponse.json({ error: 'Invalid profile name format' }, { status: 400 });
  }

  const { searchParams } = new URL(request.url);
  const force = searchParams.get('force') === 'true';

  try {
    const existing = await deleteProfile(name, auth.auth.user, force);

    if (!existing) {
      // Missing profile - NO_OP
      try {
        await writeAuditLog({
          actor: { type: 'user', username: auth.auth.user, role: auth.auth.role },
          module: 'profiles',
          action: 'PROFILE_DELETE',
          targetId: name,
          resource: { type: 'profile', id: name },
          result: 'success',
          metadata: {
            governanceMode: 'DIRECT_GOVERNED',
            approvalRequired: false,
            actorRole: auth.auth.role,
            mutationCommitted: false,
            classification: 'NO_OP',
          },
        }, { failureMode: 'strict' });
      } catch {
        return NextResponse.json({
          code: 'AUDIT_UNAVAILABLE',
          message: 'Audit evidence could not be persisted',
          committed: false,
        }, { status: 503 });
      }
      return NextResponse.json({ message: 'Profile deleted successfully' });
    }

    // Strict audit AFTER mutation
    try {
      await writeAuditLog({
        actor: { type: 'user', username: auth.auth.user, role: auth.auth.role },
        module: 'profiles',
        action: 'PROFILE_DELETE',
        targetId: name,
        resource: { type: 'profile', id: name },
        result: 'success',
        before: safeProfileSnapshot(existing as Record<string, unknown>),
        after: null,
        metadata: {
          governanceMode: 'DIRECT_GOVERNED',
          approvalRequired: false,
          actorRole: auth.auth.role,
          mutationCommitted: true,
        },
      }, { failureMode: 'strict' });
    } catch {
      return NextResponse.json({
        code: 'AUDIT_UNAVAILABLE',
        message: 'Audit evidence could not be persisted',
        committed: true,
      }, { status: 503 });
    }

    return NextResponse.json({ message: 'Profile deleted successfully' });
  } catch (error) {
    const code = (error as unknown as { code?: string }).code;

    if (code === 'PROFILE_IN_USE') {
      const subscriberCount = (error as unknown as { subscriberCount?: number }).subscriberCount || 0;
      return NextResponse.json({
        code: 'PROFILE_IN_USE',
        message: `Cannot delete profile in use by ${subscriberCount} subscriber(s). Provide force=true to proceed.`,
        subscriberCount,
      }, { status: 409 });
    }

    if (code === 'PROFILE_DELETE_PRECONDITION_CHANGED') {
      // Audit the conflict - strict audit failure returns 503
      try {
        await writeAuditLog({
          actor: { type: 'user', username: auth.auth.user, role: auth.auth.role },
          module: 'profiles',
          action: 'PROFILE_DELETE',
          targetId: name,
          resource: { type: 'profile', id: name },
          result: 'failed',
          metadata: {
            governanceMode: 'DIRECT_GOVERNED',
            approvalRequired: false,
            actorRole: auth.auth.role,
            mutationCommitted: false,
            classification: 'PRECONDITION_CHANGED',
          },
        }, { failureMode: 'strict' });
      } catch {
        return NextResponse.json({
          code: 'AUDIT_UNAVAILABLE',
          message: 'Audit evidence could not be persisted',
          committed: false,
        }, { status: 503 });
      }
      return NextResponse.json({
        code: 'PROFILE_DELETE_PRECONDITION_CHANGED',
        message: 'Profile was modified by another request',
        committed: false,
      }, { status: 409 });
    }

    if (code === 'PROFILE_DELETE_PARTIAL_WRITE') {
      // Delete succeeded but version write failed - mutation committed
      try {
        await writeAuditLog({
          actor: { type: 'user', username: auth.auth.user, role: auth.auth.role },
          module: 'profiles',
          action: 'PROFILE_DELETE',
          targetId: name,
          resource: { type: 'profile', id: name },
          result: 'failed',
          metadata: {
            governanceMode: 'DIRECT_GOVERNED',
            approvalRequired: false,
            actorRole: auth.auth.role,
            mutationCommitted: true,
            classification: 'PARTIAL_WRITE',
          },
        }, { failureMode: 'strict' });
      } catch {
        return NextResponse.json({
          code: 'AUDIT_UNAVAILABLE',
          message: 'Audit evidence could not be persisted',
          committed: true,
        }, { status: 503 });
      }
      return NextResponse.json({
        code: 'PROFILE_DELETE_PARTIAL_WRITE',
        message: 'Profile deleted but version write failed',
        committed: true,
      }, { status: 500 });
    }

    if (code === 'PROFILE_DELETE_FAILED') {
      // Storage failure - no mutation
      try {
        await writeAuditLog({
          actor: { type: 'user', username: auth.auth.user, role: auth.auth.role },
          module: 'profiles',
          action: 'PROFILE_DELETE',
          targetId: name,
          resource: { type: 'profile', id: name },
          result: 'failed',
          metadata: {
            governanceMode: 'DIRECT_GOVERNED',
            approvalRequired: false,
            actorRole: auth.auth.role,
            mutationCommitted: false,
            classification: 'FAILED_NO_MUTATION',
          },
        }, { failureMode: 'strict' });
      } catch {
        return NextResponse.json({
          code: 'AUDIT_UNAVAILABLE',
          message: 'Audit evidence could not be persisted',
          committed: false,
        }, { status: 503 });
      }
      return NextResponse.json({
        code: 'PROFILE_DELETE_FAILED',
        message: 'Failed to delete profile',
        committed: false,
      }, { status: 500 });
    }

    console.error('Error deleting profile:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
