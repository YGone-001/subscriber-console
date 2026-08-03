import { NextResponse } from 'next/server';
import { logAudit } from '@/lib/audit';
import { requireAuth, requireRole } from '@/lib/authz';
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
  const auth = requireRole(request, 'root');
  if (!auth.ok) return auth.response;

  const rateLimit = await enforceRateLimit(`profiles:update:${auth.auth.user}`, 30, 60);
  if (!rateLimit.ok) return rateLimit.response;

  if (!isValidProfileName(name)) {
    return NextResponse.json({ error: 'Invalid profile name format' }, { status: 400 });
  }

  try {
    const body = await request.json();
    const { existing, updated } = await updateProfile(name, body, auth.auth.user);

    logAudit('PROFILE_UPDATE', name, existing, updated, request);

    return NextResponse.json({ message: 'Profile updated successfully' });
  } catch (error) {
    console.error('Error updating profile:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: RouteContext) {
  const { name } = await params;
  const auth = requireRole(request, 'root');
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

    logAudit('PROFILE_DELETE', name, existing, null, request);

    return NextResponse.json({ message: 'Profile deleted successfully' });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('PROFILE_IN_USE')) {
      const subscriberCount = (error as unknown as { subscriberCount?: number }).subscriberCount || 0;
      return NextResponse.json({
        error: 'PROFILE_IN_USE',
        message: `Cannot delete profile in use by ${subscriberCount} subscriber(s). Provide force=true to proceed.`,
        subscriberCount,
      }, { status: 409 });
    }

    console.error('Error deleting profile:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
