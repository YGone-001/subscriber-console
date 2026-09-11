import { NextResponse } from 'next/server';
import { writeAuditLog } from '@/lib/audit';
import { requireAuth, requirePermission } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
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

function safeProfileSnapshot(profile: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!profile) return null;
  const { k, op, opc, amf, sqn, ...safeAuth } = (profile.auth as Record<string, unknown>) || {};
  return {
    name: profile.name,
    title: profile.title,
    description: profile.description,
    access_restriction_data: profile.access_restriction_data,
    ambr: profile.ambr,
    sliceList: profile.sliceList,
    ocsDefaults: profile.ocsDefaults,
    createdAt: profile.createdAt,
    createdBy: profile.createdBy,
    updatedAt: profile.updatedAt,
    updatedBy: profile.updatedBy,
    authConfigured: !!(k || op || opc || amf),
  };
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
      // Audit the conflict
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
        // Audit failure before mutation
      }
      return NextResponse.json({
        code: 'PROFILE_UPDATE_PRECONDITION_CHANGED',
        message: 'Profile was modified by another request',
        committed: false,
      }, { status: 409 });
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
      // Audit the conflict
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
        // Audit failure before mutation
      }
      return NextResponse.json({
        code: 'PROFILE_DELETE_PRECONDITION_CHANGED',
        message: 'Profile was modified by another request',
        committed: false,
      }, { status: 409 });
    }

    console.error('Error deleting profile:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
