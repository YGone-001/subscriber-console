import { NextResponse } from 'next/server';
import { logAudit } from '@/lib/audit';
import { requireCapability } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { restoreProfileVersion } from '@/server/repositories/profileRepository';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ name: string; versionId: string }> }
) {
  const { name, versionId } = await params;
  const auth = requireCapability(request, 'profile_rollback');
  if (!auth.ok) return auth.response;

  const rateLimit = await enforceRateLimit(`profiles:restore:${auth.auth.user}`, 10, 60);
  if (!rateLimit.ok) return rateLimit.response;

  if (!/^[a-zA-Z0-9_\s-]+$/.test(name)) {
    return NextResponse.json({ error: 'Invalid profile name format' }, { status: 400 });
  }

  try {
    const result = await restoreProfileVersion(name, versionId, auth.auth.user);
    if (!result) return NextResponse.json({ error: 'Version not found' }, { status: 404 });

    logAudit('PROFILE_UPDATE', name, result.current, result.restored, request);

    return NextResponse.json({ message: 'Profile restored successfully', profile: result.restored });
  } catch (error) {
    console.error('Error restoring profile version:', error);
    return NextResponse.json({ error: 'Failed to restore profile version' }, { status: 500 });
  }
}
