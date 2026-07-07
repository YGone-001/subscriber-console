import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { listAuditLogs } from '@/server/repositories/auditRepository';

export const dynamic = 'force-dynamic';

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
    const requestedLimit = parseInt(searchParams.get('limit') || '500', 10);
    const limit = Math.min(Math.max(Number.isFinite(requestedLimit) ? requestedLimit : 500, 1), 5000);
    const result = await listAuditLogs({
      action: searchParams.get('action') || '',
      target: searchParams.get('target') || '',
      operator: (searchParams.get('operator') || '').trim(),
      level: (searchParams.get('level') || '').trim(),
      query: (searchParams.get('q') || '').trim(),
      fromTime: parseDateParam(searchParams.get('from')),
      toTime: parseDateParam(searchParams.get('to'), true),
      limit,
    });

    return NextResponse.json(result);
  } catch (error) {
    console.error('Error fetching audit logs:', error);
    return NextResponse.json({ error: 'Failed to retrieve logs' }, { status: 500 });
  }
}
