import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { listAuditLogsForApproval } from '@/server/repositories/auditRepository';
import { getApproval } from '@/server/repositories/approvalRepository';
import { hasPermission } from '@/lib/permissions';

export const dynamic = 'force-dynamic';

type RouteContext = {
  params: Promise<{ id: string }>;
};

function hasApprovalId(value: unknown, approvalId: string) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && (value as Record<string, unknown>).approvalId === approvalId);
}

export async function GET(request: Request, { params }: RouteContext) {
  const auth = requirePermission(request, 'approvals.read');
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const approval = await getApproval(id);
  if (!approval) return NextResponse.json({ error: 'Approval request not found' }, { status: 404 });
  const rateLimit = await enforceRateLimit(`approvals:audit:${auth.auth.user}:${id}`, 80, 60);
  if (!rateLimit.ok) return rateLimit.response;

  try {
    const logs = await listAuditLogsForApproval(id, {
      revealSourceIp: hasPermission({ role: auth.auth.role }, 'audit.source-ip.read-full'),
    });
    const lifecycle = logs.filter((log) => log.targetId === `approval:${id}`).length;
    const execution = logs.filter((log) => hasApprovalId(log.oldData, id) || hasApprovalId(log.newData, id)).length;

    return NextResponse.json({
      approvalId: id,
      logs,
      summary: {
        total: logs.length,
        lifecycle,
        execution,
      },
    });
  } catch (error) {
    console.error('Error fetching approval audit trail:', error);
    return NextResponse.json({ error: 'Failed to fetch approval audit trail' }, { status: 500 });
  }
}
