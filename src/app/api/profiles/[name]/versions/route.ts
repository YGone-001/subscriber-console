import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';
import { requireAuth } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { getProfileVersion, listProfileVersions, summarizeProfileVersion } from '@/lib/profileVersions';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const auth = requireAuth(request);
  if (!auth.ok) return auth.response;

  const rateLimit = await enforceRateLimit(`profiles:versions:${auth.auth.user}`, 120, 60);
  if (!rateLimit.ok) return rateLimit.response;

  if (!/^[a-zA-Z0-9_\s-]+$/.test(name)) {
    return NextResponse.json({ error: 'Invalid profile name format' }, { status: 400 });
  }

  const { searchParams } = new URL(request.url);
  const versionId = searchParams.get('versionId');
  const limit = parseInt(searchParams.get('limit') || '20', 10);

  try {
    const currentRaw = await redis.get(`PROFILE:${name}`);
    const current = currentRaw ? JSON.parse(currentRaw) : null;

    if (versionId) {
      const version = await getProfileVersion(name, versionId);
      if (!version) return NextResponse.json({ error: 'Version not found' }, { status: 404 });
      return NextResponse.json({ version, current });
    }

    const versions = await listProfileVersions(name, Number.isFinite(limit) ? limit : 20);
    return NextResponse.json({
      versions: versions.map(summarizeProfileVersion),
      current: current ? {
        title: current.title || name,
        updatedAt: current.updatedAt || current.createdAt || null,
        updatedBy: current.updatedBy || current.createdBy || null,
        sliceCount: Array.isArray(current.sliceList) ? current.sliceList.length : 0,
      } : null,
    });
  } catch (error) {
    console.error('Error fetching profile versions:', error);
    return NextResponse.json({ error: 'Failed to fetch profile versions' }, { status: 500 });
  }
}
