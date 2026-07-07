import { NextResponse } from 'next/server';
import { requireAnyRole } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { acknowledgeAlerts } from '@/server/repositories/alertRepository';

export const dynamic = 'force-dynamic';

const MAX_ACK_IDS = 200;

export async function POST(request: Request) {
  const auth = requireAnyRole(request, ['root', 'operator']);
  if (!auth.ok) return auth.response;
  const rateLimit = await enforceRateLimit(`alerts:acknowledge:${auth.auth.user}`, 60, 60);
  if (!rateLimit.ok) return rateLimit.response;

  try {
    const body = await request.json() as { id?: unknown; ids?: unknown };
    const rawIds = Array.isArray(body.ids) ? body.ids : [body.id];
    const alertIds = Array.from(
      new Set(
        rawIds
          .filter((value): value is string => typeof value === 'string')
          .map((value) => value.trim())
          .filter(Boolean)
      )
    );

    if (alertIds.length === 0) {
      return NextResponse.json({ error: 'Alert ID(s) required' }, { status: 400 });
    }

    if (alertIds.length > MAX_ACK_IDS) {
      return NextResponse.json({ error: `At most ${MAX_ACK_IDS} alerts can be acknowledged at once` }, { status: 400 });
    }

    const acknowledged = await acknowledgeAlerts(alertIds);
    return NextResponse.json({
      success: true,
      acknowledged,
      requested: alertIds.length,
      skipped: alertIds.length - acknowledged,
    });
  } catch (error) {
    console.error('Alert acknowledge error:', error);
    return NextResponse.json({ error: 'Failed to acknowledge alert' }, { status: 500 });
  }
}
