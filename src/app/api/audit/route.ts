import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';
import { requireAuth } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';

type AuditLogRecord = {
  timestamp?: string;
  level?: string;
  action?: string;
  targetId?: string;
  operatorIp?: string;
  [key: string]: unknown;
};

function parseDateParam(value: string | null, endOfDay = false): number | null {
  if (!value) return null;
  const normalized = value.length === 10
    ? `${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}`
    : value;
  const time = new Date(normalized).getTime();
  return Number.isFinite(time) ? time : null;
}

export async function GET(request: Request) {
  try {
    const auth = requireAuth(request);
    if (!auth.ok) return auth.response;
    const rateLimit = await enforceRateLimit(`audit:list:${auth.auth.user}`, 60, 60);
    if (!rateLimit.ok) return rateLimit.response;

    const { searchParams } = new URL(request.url);
    const filterAction = searchParams.get('action') || '';
    const filterTarget = searchParams.get('target') || '';
    const filterOperator = (searchParams.get('operator') || '').trim();
    const filterLevel = (searchParams.get('level') || '').trim();
    const query = (searchParams.get('q') || '').trim().toLowerCase();
    const fromTime = parseDateParam(searchParams.get('from'));
    const toTime = parseDateParam(searchParams.get('to'), true);
    const requestedLimit = parseInt(searchParams.get('limit') || '500', 10);
    const limit = Math.min(Math.max(Number.isFinite(requestedLimit) ? requestedLimit : 500, 1), 5000);

    // Safety cap pulling 5000 elements max into memory for filtering to prevent OOM
    const rawLogs = await redis.lrange('LOG:AUDIT', 0, 4999);

    let parsedLogs: AuditLogRecord[] = rawLogs.map(r => {
      try { return JSON.parse(r); } catch { return null; }
    }).filter((l): l is AuditLogRecord => l !== null);

    if (filterAction && filterAction !== 'ALL') {
      parsedLogs = parsedLogs.filter(l => l.action === filterAction);
    }

    if (filterTarget) {
      parsedLogs = parsedLogs.filter(l => Boolean(l.targetId && l.targetId.includes(filterTarget)));
    }

    if (filterOperator) {
      parsedLogs = parsedLogs.filter(l => Boolean(l.operatorIp && l.operatorIp.includes(filterOperator)));
    }

    if (filterLevel && filterLevel !== 'ALL') {
      parsedLogs = parsedLogs.filter(l => l.level === filterLevel);
    }

    if (fromTime !== null) {
      parsedLogs = parsedLogs.filter(l => {
        const time = new Date(l.timestamp || '').getTime();
        return Number.isFinite(time) && time >= fromTime;
      });
    }

    if (toTime !== null) {
      parsedLogs = parsedLogs.filter(l => {
        const time = new Date(l.timestamp || '').getTime();
        return Number.isFinite(time) && time <= toTime;
      });
    }

    if (query) {
      parsedLogs = parsedLogs.filter(l => {
        const haystack = [
          l.id,
          l.action,
          l.level,
          l.targetId,
          l.operatorIp,
          l.timestamp,
        ].map(v => String(v || '').toLowerCase()).join(' ');
        return haystack.includes(query);
      });
    }

    // Return only requested limit
    const filteredTotal = parsedLogs.length;
    parsedLogs = parsedLogs.slice(0, limit);

    return NextResponse.json({ logs: parsedLogs, totalScanned: rawLogs.length, filteredTotal });
  } catch (error) {
    console.error('Error fetching audit logs:', error);
    return NextResponse.json({ error: 'Failed to retrieve logs' }, { status: 500 });
  }
}
