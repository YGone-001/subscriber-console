import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';
import { enforceRateLimit } from '@/lib/rateLimit';
import { requireAuth } from '@/lib/authz';

export const dynamic = 'force-dynamic';

type AlertItem = {
  is_acknowledged?: boolean;
  level?: string;
};

export async function GET(request: Request) {
  try {
    const auth = requireAuth(request);
    if (!auth.ok) return auth.response;

    const rateLimit = await enforceRateLimit(`alerts:list:${auth.auth.user}`, 120, 60);
    if (!rateLimit.ok) return rateLimit.response;

    const rawAlerts = await redis.lrange('LOG:ALERTS:LOCAL', 0, 100);
    const parsedAlerts = rawAlerts.map((a): AlertItem | null => {
      try { return JSON.parse(a); } catch { return null; }
    }).filter((v): v is AlertItem => v !== null);

    const activeCritical = parsedAlerts.filter(a => !a.is_acknowledged && a.level === 'CRITICAL');
    const activeWarning = parsedAlerts.filter(a => !a.is_acknowledged && a.level === 'WARNING');
    const allActive = parsedAlerts.filter(a => !a.is_acknowledged);

    return NextResponse.json({
      alerts: parsedAlerts,
      activeCriticalCount: activeCritical.length,
      activeWarningCount: activeWarning.length,
      activeCount: allActive.length
    });
  } catch (error) {
    return NextResponse.json({ error: 'Alert fetch failed' }, { status: 500 });
  }
}
