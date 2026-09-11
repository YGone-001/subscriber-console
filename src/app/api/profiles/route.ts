import { NextResponse } from 'next/server';
import { writeAuditLog } from '@/lib/audit';
import { enforceRateLimit } from '@/lib/rateLimit';
import { requireAuth, requirePermission } from '@/lib/authz';
import { safeProfileSnapshot } from '@/lib/profileAudit';
import {
  createProfile,
  getProfilesGlobalSummary,
  listProfiles,
} from '@/server/repositories/profileRepository';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const auth = requireAuth(request);
    if (!auth.ok) return auth.response;

    const rateLimit = await enforceRateLimit(`profiles:list:${auth.auth.user}`, 90, 60);
    if (!rateLimit.ok) return rateLimit.response;

    const [profiles, summary] = await Promise.all([
      listProfiles(),
      getProfilesGlobalSummary(),
    ]);

    return NextResponse.json({ profiles, summary });
  } catch (error) {
    console.error('Error fetching profiles:', error);
    return NextResponse.json({ error: 'Failed to fetch profiles' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const auth = requirePermission(request, 'profiles.write');
    if (!auth.ok) return auth.response;

    const rateLimit = await enforceRateLimit(`profiles:create:${auth.auth.user}`, 20, 60);
    if (!rateLimit.ok) return rateLimit.response;

    const data = await request.json();
    const { name } = data;

    if (!name) {
      return NextResponse.json({ error: 'Profile name is required' }, { status: 400 });
    }
    if (!/^[a-zA-Z0-9_\s-]+$/.test(name)) {
      return NextResponse.json({ error: 'Invalid profile name format' }, { status: 400 });
    }

    const profile = await createProfile(name, auth.auth.user);

    // Strict audit AFTER mutation with safe snapshot
    try {
      await writeAuditLog({
        actor: { type: 'user', username: auth.auth.user, role: auth.auth.role },
        module: 'profiles',
        action: 'PROFILE_CREATE',
        targetId: name,
        resource: { type: 'profile', id: name },
        result: 'success',
        before: null,
        after: safeProfileSnapshot(profile as Record<string, unknown>),
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

    return NextResponse.json({ message: 'Profile created successfully', name }, { status: 201 });
  } catch (error) {
    const code = (error as unknown as { code?: string }).code;

    if (code === 'PROFILE_CREATE_PARTIAL_WRITE') {
      // Version write failed after insert - mutation committed
      try {
        await writeAuditLog({
          actor: { type: 'user', username: '', role: '' },
          module: 'profiles',
          action: 'PROFILE_CREATE',
          targetId: '',
          resource: { type: 'profile', id: '' },
          result: 'failed',
          metadata: {
            governanceMode: 'DIRECT_GOVERNED',
            approvalRequired: false,
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
        code: 'PROFILE_CREATE_PARTIAL_WRITE',
        message: 'Profile created but version write failed',
        committed: true,
      }, { status: 500 });
    }

    if (code === 'PROFILE_CREATE_FAILED') {
      // Storage failure - no mutation
      try {
        await writeAuditLog({
          actor: { type: 'user', username: '', role: '' },
          module: 'profiles',
          action: 'PROFILE_CREATE',
          targetId: '',
          resource: { type: 'profile', id: '' },
          result: 'failed',
          metadata: {
            governanceMode: 'DIRECT_GOVERNED',
            approvalRequired: false,
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
        code: 'PROFILE_CREATE_FAILED',
        message: 'Failed to create profile',
        committed: false,
      }, { status: 500 });
    }

    if (error instanceof Error && error.message === 'PROFILE_EXISTS') {
      return NextResponse.json({ error: 'Profile with this name already exists' }, { status: 409 });
    }

    console.error('Error creating profile:', error);
    return NextResponse.json({ error: 'Failed to create profile' }, { status: 500 });
  }
}
