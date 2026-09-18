import { NextResponse } from 'next/server';
import { requireCapability, requirePermission } from '@/lib/authz';
import { AuditQueryError, parseAuditId } from '@/lib/auditQuery';
import { enforceRateLimit } from '@/lib/rateLimit';
import { getAuditLog } from '@/server/repositories/auditRepository';
import { hasPermission } from '@/lib/permissions';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: RouteContext) {
  const legacy = requireCapability(request, 'audit_view');
  if (!legacy.ok) return legacy.response;
  const permission = requirePermission(request, 'audit.read');
  if (!permission.ok) return permission.response;
  const rateLimit = await enforceRateLimit(`audit:detail:${legacy.auth.user}`, 120, 60);
  if (!rateLimit.ok) return rateLimit.response;

  try {
    const id = parseAuditId((await params).id);
    const log = await getAuditLog(id, {
      revealSourceIp: hasPermission({ role: permission.auth.role }, 'audit.source-ip.read-full'),
    });
    return log
      ? NextResponse.json({ log })
      : NextResponse.json({ error: 'Audit event not found', code: 'AUDIT_NOT_FOUND' }, { status: 404 });
  } catch (error) {
    if (error instanceof AuditQueryError) {
      return NextResponse.json({ error: error.message, code: 'INVALID_AUDIT_ID' }, { status: 400 });
    }
    console.error('Error fetching audit event:', error);
    return NextResponse.json({ error: 'Failed to retrieve audit event' }, { status: 500 });
  }
}
