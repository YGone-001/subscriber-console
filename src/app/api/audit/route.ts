import { NextResponse } from 'next/server';
import { requireCapability, requirePermission } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { listAuditLogs } from '@/server/repositories/auditRepository';
import { AuditQueryError, parseAuditQuery } from '@/lib/auditQuery';
import { hasPermission } from '@/lib/permissions';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const auth = requireCapability(request, 'audit_view');
    if (!auth.ok) return auth.response;
    const permission = requirePermission(request, 'audit.read');
    if (!permission.ok) return permission.response;
    const rateLimit = await enforceRateLimit(`audit:list:${auth.auth.user}`, 60, 60);
    if (!rateLimit.ok) return rateLimit.response;

    const query = parseAuditQuery(new URL(request.url).searchParams);
    const revealSourceIp = hasPermission({ role: permission.auth.role }, 'audit.source-ip.read-full');
    if (query.sourceIp && !revealSourceIp) {
      const sourceIpPermission = requirePermission(request, 'audit.source-ip.read-full');
      if (!sourceIpPermission.ok) return sourceIpPermission.response;
    }
    const result = await listAuditLogs(query, { revealSourceIp });

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof AuditQueryError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
    }
    console.error('Error fetching audit logs:', error);
    return NextResponse.json({ error: 'Failed to retrieve logs' }, { status: 500 });
  }
}
