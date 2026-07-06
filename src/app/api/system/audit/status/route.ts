import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';
import { requireAuth } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const auth = requireAuth(request);
    if (!auth.ok) return auth.response;
    const rateLimit = await enforceRateLimit(`system:audit-status:${auth.auth.user}`, 60, 60);
    if (!rateLimit.ok) return rateLimit.response;

    const rawInfo = await redis.info('persistence');

    // Parse the multi-line redis system string specific to persistence metrics
    let lastSaveTime = 0;

    const lines = rawInfo.split('\n');
    for (const line of lines) {
      if (line.trim().startsWith('rdb_last_save_time:')) {
        const timeStr = line.split(':')[1].trim();
        lastSaveTime = parseInt(timeStr, 10);
        break;
      }
    }

    return NextResponse.json({
      lastSaveTime: lastSaveTime
    }, { status: 200 });

  } catch (error) {
    console.error('Failed to get persistence info:', error);
    return NextResponse.json({ error: 'Failed to retrieve system status' }, { status: 500 });
  }
}
