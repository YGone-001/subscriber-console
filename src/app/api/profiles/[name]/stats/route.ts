import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { getProfile, getProfileStats } from '@/server/repositories/profileRepository';

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

  const rateLimit = await enforceRateLimit(`profiles:stats:${auth.auth.user}`, 120, 60);
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
    return NextResponse.json({ stats });
  } catch (error) {
    console.error('Error fetching profile stats:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
