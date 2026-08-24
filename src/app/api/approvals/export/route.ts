import { NextResponse } from 'next/server';
import { requireCapability } from '@/lib/authz';
import { toCsvRow } from '@/lib/csv';
import { enforceRateLimit } from '@/lib/rateLimit';
import { listAuditLogsForApproval, type AuditLogRecord } from '@/server/repositories/auditRepository';
import { getApproval, isApprovalStatus, listApprovals, type ApprovalDocument } from '@/server/repositories/approvalRepository';

export const dynamic = 'force-dynamic';

function parseDateParam(value: string | null, endOfDay = false): number | null {
  if (!value) return null;
  const normalized = value.length === 10
    ? `${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}`
    : value;
  const time = new Date(normalized).getTime();
  return Number.isFinite(time) ? time : null;
}

function hasApprovalId(value: unknown, approvalId: string) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && (value as Record<string, unknown>).approvalId === approvalId);
}

function safeJson(value: unknown) {
  if (value === undefined || value === null || value === '') return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function auditSummary(approvalId: string, logs: AuditLogRecord[]) {
  return {
    total: logs.length,
    lifecycle: logs.filter((log) => log.targetId === `approval:${approvalId}`).length,
    execution: logs.filter((log) => hasApprovalId(log.oldData, approvalId) || hasApprovalId(log.newData, approvalId)).length,
  };
}

function csvResponse(evidence: Array<{ approval: ApprovalDocument; auditLogs: AuditLogRecord[] }>, filename: string) {
  const header = toCsvRow([
    'Approval ID',
    'Status',
    'Action',
    'Requester',
    'Reviewer',
    'Target',
    'Summary',
    'Created At',
    'Reviewed At',
    'Executed At',
    'Audit Logs',
    'Lifecycle Logs',
    'Execution Logs',
    'Note',
    'Error',
    'Payload',
    'Result',
  ]);
  const rows = evidence.map(({ approval, auditLogs }) => {
    const summary = auditSummary(approval.id, auditLogs);
    return toCsvRow([
      approval.id,
      approval.status,
      approval.action,
      approval.requester,
      approval.reviewer || '',
      approval.targetId,
      approval.summary,
      approval.createdAt,
      approval.reviewedAt || '',
      approval.executedAt || '',
      summary.total,
      summary.lifecycle,
      summary.execution,
      approval.note || '',
      approval.error || '',
      safeJson(approval.payload),
      safeJson(approval.result),
    ]);
  });

  return new NextResponse([header, ...rows].join('\n'), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}.csv"`,
    },
  });
}

export async function GET(request: Request) {
  const auth = requireCapability(request, 'audit_export', { allowExport: true });
  if (!auth.ok) return auth.response;

  const rateLimit = await enforceRateLimit(`approvals:export:${auth.auth.user}`, 20, 60);
  if (!rateLimit.ok) return rateLimit.response;

  const { searchParams } = new URL(request.url);
  const format = searchParams.get('format') === 'csv' ? 'csv' : 'json';
  const approvalId = (searchParams.get('approvalId') || '').trim();
  const rawStatus = searchParams.get('status') || 'all';
  const status = rawStatus === 'all' || isApprovalStatus(rawStatus) ? rawStatus : 'all';
  const requester = (searchParams.get('requester') || '').trim();
  const fromTime = parseDateParam(searchParams.get('from'));
  const toTime = parseDateParam(searchParams.get('to'), true);
  const requestedLimit = parseInt(searchParams.get('limit') || '500', 10);
  const limit = Math.min(Math.max(Number.isFinite(requestedLimit) ? requestedLimit : 500, 1), 500);

  try {
    const approvals = approvalId
      ? [await getApproval(approvalId)].filter(Boolean) as ApprovalDocument[]
      : (await listApprovals({ status, requester: requester || undefined, fromTime, toTime, limit, maxLimit: 500 })).approvals;

    if (approvalId && approvals.length === 0) {
      return NextResponse.json({ error: 'Approval request not found' }, { status: 404 });
    }

    const auditChains = await Promise.all(approvals.map((approval) => listAuditLogsForApproval(approval.id)));
    const evidence = approvals.map((approval, index) => ({ approval, auditLogs: auditChains[index] }));
    const generatedAt = new Date().toISOString();
    const basename = approvalId
      ? `xcloud_approval_${approvalId}_${generatedAt.slice(0, 10)}`
      : `xcloud_approvals_${status}_${generatedAt.slice(0, 10)}`;

    if (format === 'csv') return csvResponse(evidence, basename);

    return NextResponse.json({
      generatedAt,
      filters: {
        approvalId: approvalId || undefined,
        status,
        requester: requester || undefined,
        from: searchParams.get('from') || undefined,
        to: searchParams.get('to') || undefined,
        limit,
      },
      summary: {
        approvals: evidence.length,
        auditLogs: evidence.reduce((sum, item) => sum + item.auditLogs.length, 0),
      },
      evidence: evidence.map((item) => ({
        approval: item.approval,
        auditSummary: auditSummary(item.approval.id, item.auditLogs),
        auditLogs: item.auditLogs,
      })),
    }, {
      headers: {
        'Content-Disposition': `attachment; filename="${basename}.json"`,
      },
    });
  } catch (error) {
    console.error('Error exporting approval evidence:', error);
    return NextResponse.json({ error: 'Failed to export approval evidence' }, { status: 500 });
  }
}
