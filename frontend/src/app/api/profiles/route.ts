import { NextResponse } from 'next/server';
import { writeAuditLog } from '@/lib/audit';
import { enforceRateLimit } from '@/lib/rateLimit';
import { requireAuth, requirePermission } from '@/lib/authz';
import { safeProfileSnapshot } from '@/lib/profileAudit';
import {
  createProfile,
  listProfiles,
  summarizeProfiles,
} from '@/server/repositories/profileRepository';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const auth = requireAuth(request);
    if (!auth.ok) return auth.response;

    const rateLimit = await enforceRateLimit(`profiles:list:${auth.auth.user}`, 90, 60);
    if (!rateLimit.ok) return rateLimit.response;

    // listProfiles already includes the subscriber aggregation used by the
    // summary. Derive both response sections from that single result so a page
    // visit does not repeat the same MongoDB work.
    const profiles = await listProfiles();
    const summary = summarizeProfiles(profiles);

    return NextResponse.json({ profiles, summary });
  } catch (error) {
    console.error('Error fetching profiles:', error);
    return NextResponse.json({ error: 'Failed to fetch profiles' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  // Authorization - available to all paths including catch
  const auth = requirePermission(request, 'profiles.write');
  if (!auth.ok) return auth.response;

  const rateLimit = await enforceRateLimit(`profiles:create:${auth.auth.user}`, 20, 60);
  if (!rateLimit.ok) return rateLimit.response;

  // Parse and validate name - available to all paths including catch
  const data = await request.json();
  const { name } = data;

  if (!name) {
    return NextResponse.json({ error: 'Profile name is required' }, { status: 400 });
  }
  if (!/^[a-zA-Z0-9_\s-]+$/.test(name)) {
    return NextResponse.json({ error: 'Invalid profile name format' }, { status: 400 });
  }

  try {
    const profile = await createProfile(name, auth.auth.user);

    // Audit is append-only and never gates the committed mutation.
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
          actorRole: auth.auth.role,
          mutationCommitted: true,
        },
      });

    return NextResponse.json({ message: 'Profile created successfully', name }, { status: 201 });
  } catch (error) {
    const code = (error as unknown as { code?: string }).code;

    if (code === 'PROFILE_CREATE_PARTIAL_WRITE') {
      // Version write failed after insert - mutation committed
      await writeAuditLog({
          actor: { type: 'user', username: auth.auth.user, role: auth.auth.role },
          module: 'profiles',
          action: 'PROFILE_CREATE',
          targetId: name,
          resource: { type: 'profile', id: name },
          result: 'failed',
          metadata: {
            governanceMode: 'DIRECT_GOVERNED',
            actorRole: auth.auth.role,
            mutationCommitted: true,
            classification: 'PARTIAL_WRITE',
          },
        });
      return NextResponse.json({
        code: 'PROFILE_CREATE_PARTIAL_WRITE',
        message: 'Profile created but version write failed',
        committed: true,
      }, { status: 500 });
    }

    if (code === 'PROFILE_CREATE_FAILED') {
      // Storage failure - no mutation
      await writeAuditLog({
          actor: { type: 'user', username: auth.auth.user, role: auth.auth.role },
          module: 'profiles',
          action: 'PROFILE_CREATE',
          targetId: name,
          resource: { type: 'profile', id: name },
          result: 'failed',
          metadata: {
            governanceMode: 'DIRECT_GOVERNED',
            actorRole: auth.auth.role,
            mutationCommitted: false,
            classification: 'FAILED_NO_MUTATION',
          },
        });
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
