import { NextResponse } from 'next/server';
import { logAudit } from '@/lib/audit';
import { enforceRateLimit } from '@/lib/rateLimit';
import { requireAuth, requireRole } from '@/lib/authz';
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
    const auth = requireRole(request, 'root');
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

    logAudit('PROFILE_CREATE', name, null, profile, request);

    return NextResponse.json({ message: 'Profile created successfully', name }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === 'PROFILE_EXISTS') {
      return NextResponse.json({ error: 'Profile with this name already exists' }, { status: 409 });
    }

    console.error('Error creating profile:', error);
    return NextResponse.json({ error: 'Failed to create profile' }, { status: 500 });
  }
}
