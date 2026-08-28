import { NextResponse } from 'next/server';
import { writeAuditLog, AuditWriteError } from '@/lib/audit';
import { auditRequestContext } from '@/lib/audit/record';
import { auditExportMaxRows, auditFilterSummary, serializeAuditCsv, serializeAuditJson } from '@/lib/auditExport';
import { AuditQueryError, parseAuditQuery, type AuditQuery } from '@/lib/auditQuery';
import { requireCapability, requirePermission, type AuthContext } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { AuditExportTooLargeError, exportAuditLogs } from '@/server/repositories/auditRepository';
import { hasPermission } from '@/lib/permissions';

export const dynamic = 'force-dynamic';

type ExportFormat = 'csv' | 'json';

function formatParam(value: string | null): ExportFormat {
  if (value === 'csv' || value === 'json') return value;
  throw new AuditQueryError('format must be csv or json');
}

async function recordExport(request: Request, auth: AuthContext, format: string, query: AuditQuery | undefined, result: 'success' | 'failed', metadata: Record<string, unknown>, error?: { code: string; message: string }) {
  await writeAuditLog({
    actor: { type: 'user', username: auth.user, role: auth.role },
    module: 'audit',
    action: 'audit.export',
    resource: { type: 'audit_logs', id: 'app_audit_logs' },
    result,
    riskLevel: 'high',
    metadata: { format, filters: query ? auditFilterSummary(query) : undefined, ...metadata },
    error,
    ...auditRequestContext(request),
  }, { failureMode: 'strict' });
}

function evidenceUnavailable() {
  return NextResponse.json({ error: 'Export blocked because audit evidence could not be persisted', code: 'AUDIT_EVIDENCE_UNAVAILABLE' }, { status: 503 });
}

export async function GET(request: Request) {
  // The first failed guard records exactly one authorization.denied event.
  const legacy = requireCapability(request, 'audit_export', { allowExport: true });
  if (!legacy.ok) return legacy.response;
  const permission = requirePermission(request, 'audit.export');
  if (!permission.ok) return permission.response;
  const rateLimit = await enforceRateLimit(`audit:export:${legacy.auth.user}`, 10, 60);
  if (!rateLimit.ok) return rateLimit.response;

  const searchParams = new URL(request.url).searchParams;
  let format = searchParams.get('format') || '';
  let query: AuditQuery | undefined;
  try {
    format = formatParam(format);
    query = parseAuditQuery(searchParams);
    const revealSourceIp = hasPermission({ role: permission.auth.role }, 'audit.source-ip.read-full');
    if (query.sourceIp && !revealSourceIp) {
      const sourceIpPermission = requirePermission(request, 'audit.source-ip.read-full');
      if (!sourceIpPermission.ok) return sourceIpPermission.response;
    }
    const maxRows = auditExportMaxRows();
    const exported = await exportAuditLogs(query, maxRows, { revealSourceIp });
    const generatedAt = new Date().toISOString();
    await recordExport(request, legacy.auth, format, query, 'success', {
      matchedCount: exported.matched,
      exportedCount: exported.logs.length,
      maxRows,
    });
    const filename = `xcloud_audit_${generatedAt.slice(0, 10)}.${format}`;
    const body = format === 'csv'
      ? serializeAuditCsv(exported.logs)
      : serializeAuditJson(exported.logs, query, generatedAt);
    return new NextResponse(body, { headers: {
      'Content-Type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    } });
  } catch (error) {
    if (error instanceof AuditWriteError) return evidenceUnavailable();
    const code = error instanceof AuditExportTooLargeError ? 'AUDIT_EXPORT_TOO_LARGE'
      : error instanceof AuditQueryError ? 'INVALID_QUERY' : 'AUDIT_EXPORT_FAILED';
    const message = error instanceof AuditExportTooLargeError
      ? `Export matched ${error.matched} rows; narrow the time range or filters below the ${error.limit} row limit.`
      : error instanceof AuditQueryError ? error.message : 'Failed to export audit logs';
    try {
      await recordExport(request, legacy.auth, format, query, 'failed',
        error instanceof AuditExportTooLargeError ? { matchedCount: error.matched, maxRows: error.limit } : {},
        { code, message });
    } catch {
      return evidenceUnavailable();
    }
    if (error instanceof AuditExportTooLargeError) return NextResponse.json({ error: message, code, matched: error.matched, limit: error.limit }, { status: 422 });
    if (error instanceof AuditQueryError) return NextResponse.json({ error: message, code }, { status: 400 });
    console.error('Audit export failed', { code });
    return NextResponse.json({ error: message, code }, { status: 500 });
  }
}
