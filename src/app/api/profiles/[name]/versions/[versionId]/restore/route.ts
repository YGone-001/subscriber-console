import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';
import { logAudit } from '@/lib/audit';
import { requireRole } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { getProfileVersion, saveProfileVersion } from '@/lib/profileVersions';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ name: string; versionId: string }> }
) {
  const { name, versionId } = await params;
  const auth = requireRole(request, 'root');
  if (!auth.ok) return auth.response;

  const rateLimit = await enforceRateLimit(`profiles:restore:${auth.auth.user}`, 10, 60);
  if (!rateLimit.ok) return rateLimit.response;

  if (!/^[a-zA-Z0-9_\s-]+$/.test(name)) {
    return NextResponse.json({ error: 'Invalid profile name format' }, { status: 400 });
  }

  try {
    const version = await getProfileVersion(name, versionId);
    if (!version) return NextResponse.json({ error: 'Version not found' }, { status: 404 });

    const currentRaw = await redis.get(`PROFILE:${name}`);
    const current = currentRaw ? JSON.parse(currentRaw) : null;
    if (current) {
      await saveProfileVersion(name, current, auth.auth.user, 'RESTORE');
    }

    const restored = {
      ...version.profile,
      title: version.profile?.title || name,
      createdAt: version.profile?.createdAt || current?.createdAt || new Date().toISOString(),
      createdBy: version.profile?.createdBy || current?.createdBy || auth.auth.user,
      updatedAt: new Date().toISOString(),
      updatedBy: auth.auth.user,
      restoredFromVersionId: version.versionId,
      restoredFromSavedAt: version.savedAt,
    };

    await redis.set(`PROFILE:${name}`, JSON.stringify(restored));
    logAudit('PROFILE_UPDATE', name, current, restored, request);

    return NextResponse.json({ message: 'Profile restored successfully', profile: restored });
  } catch (error) {
    console.error('Error restoring profile version:', error);
    return NextResponse.json({ error: 'Failed to restore profile version' }, { status: 500 });
  }
}
