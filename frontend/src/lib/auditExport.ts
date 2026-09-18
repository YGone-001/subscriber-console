import { toCsvRow } from '@/lib/csv';
import type { AuditQuery } from '@/lib/auditQuery';
import type { AuditLogRecord } from '@/types/audit';

export const DEFAULT_AUDIT_EXPORT_MAX_ROWS = 50_000;

export function auditExportMaxRows(raw = process.env.AUDIT_EXPORT_MAX_ROWS): number {
  if (raw === undefined || raw === '') return DEFAULT_AUDIT_EXPORT_MAX_ROWS;
  if (!/^\d+$/.test(raw)) throw new Error('AUDIT_EXPORT_MAX_ROWS must be a positive integer');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('AUDIT_EXPORT_MAX_ROWS must be a positive integer');
  return value;
}

/** Prevent spreadsheet applications from executing exported cells as formulas. */
export function safeAuditCsvCell(value: unknown): string {
  const text = value === undefined || value === null ? '' : String(value);
  return /^\s*[=+\-@]/.test(text) ? `'${text}` : text;
}

function safeJson(value: unknown): string {
  if (value === undefined || value === null) return '';
  try { return JSON.stringify(value); } catch { return '[UNSERIALIZABLE]'; }
}

function actor(log: AuditLogRecord) {
  return log.actorContext?.username || log.actor || '';
}

export function auditFilterSummary(query: AuditQuery): Record<string, string> {
  const summary: Record<string, string> = {};
  for (const key of [
    'q', 'action', 'module', 'result', 'risk', 'actor', 'resourceType', 'resourceId',
    'requestId', 'correlationId', 'approvalId', 'sourceIp', 'level', 'from', 'to',
  ] as const) {
    const value = query[key];
    if (typeof value === 'string' && value) summary[key] = value;
  }
  return summary;
}

export function serializeAuditCsv(logs: AuditLogRecord[]): string {
  const headers = [
    'Timestamp', 'Event ID', 'Result', 'Risk', 'Module', 'Action', 'Actor', 'Role',
    'Resource Type', 'Resource ID', 'Source IP', 'Request ID', 'Correlation ID',
    'Approval ID', 'Reason', 'Before', 'After', 'Error Code', 'Error Message',
  ];
  const rows = logs.map((log) => [
    log.timestamp, log.eventId || log.id, log.result || '', log.riskLevel || '', log.module || '', log.action,
    actor(log), log.actorContext?.role || '', log.resource?.type || '', log.resource?.id || log.resource?.name || log.targetId,
    log.source?.ip || log.operatorIp, log.request?.requestId || '', log.request?.correlationId || log.correlationId || '',
    log.approvalId || '', log.reason || '', safeJson(log.oldData), safeJson(log.newData), log.error?.code || '', log.error?.message || '',
  ].map(safeAuditCsvCell));
  return `\uFEFF${[toCsvRow(headers), ...rows.map((row) => toCsvRow(row))].join('\r\n')}`;
}

export function serializeAuditJson(logs: AuditLogRecord[], query: AuditQuery, generatedAt: string) {
  return JSON.stringify({
    generatedAt,
    filters: auditFilterSummary(query),
    summary: { matched: logs.length, exported: logs.length },
    logs,
  }, null, 2);
}
