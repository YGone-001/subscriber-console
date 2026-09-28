import { NextResponse } from 'next/server';
import { requireAnyRole } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { acknowledgeAlerts } from '@/server/repositories/alertRepository';
import { writeAuditLog } from '@/lib/audit';
import { auditRequestContext } from '@/lib/audit/record';

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
    const targetId = alertIds.length === 1 ? alertIds[0] : `batch:${alertIds.length}`;
    await writeAuditLog({
      actor: { type: 'user', username: auth.auth.user, role: auth.auth.role },
      module: 'alerts',
      action: 'alert.acknowledge',
      targetId,
      resource: { type: 'alert', id: targetId },
      result: 'success',
      metadata: {
        requested: alertIds.length,
        acknowledged,
        skipped: alertIds.length - acknowledged,
        ids: alertIds,
      },
      ...auditRequestContext(request),
    }, { failureMode: 'best-effort' });

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
