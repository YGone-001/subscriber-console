export const REPORT_GROUP_KEYS = ['networkKey', 'siteResourceId', 'hostResourceId', 'operatorName', 'plmn', 'scopeFingerprint'] as const;
export type ReportQuery = { from: string; to: string; resourceId?: string; domain?: string; severity?: string; networkKey?: string; siteResourceId?: string; hostResourceId?: string; operatorName?: string; plmn?: string; scopeFingerprint?: string; includeRetired?: string | boolean };
export type ReportRequest = Partial<ReportQuery> & { period?: string };
export type ReportSection = { completeness: string; scope: string; reason: string; data: Record<string, unknown> | null };
export type OperationsReport = { generatedAt: string; query: ReportQuery; consistency: string; alerts: ReportSection; metrics: ReportSection; config: ReportSection; agents: ReportSection };
export type ReportPage = { generatedAt: string; items: Record<string, unknown>[]; nextCursor: string | null; hasMore: boolean; completeness: string; reason: string };

export function reportQuery(params: URLSearchParams, _defaultTo?: string): ReportRequest {
  const window: ReportRequest = params.has('from') || params.has('to') ? { ...(params.has('from') ? {from:params.get('from')!} : {}), ...(params.has('to') ? {to:params.get('to')!} : {}) } : {period:params.get('period') || '24h'};
  const groups: ReportRequest = {};
  for (const key of REPORT_GROUP_KEYS) if (params.has(key)) groups[key] = params.get(key)!;
  if (params.has('includeRetired')) groups.includeRetired = params.get('includeRetired')!;
  return { ...window, ...groups, ...(params.get('resourceId') ? { resourceId: params.get('resourceId')! } : {}), ...(params.get('domain') ? { domain: params.get('domain')! } : {}), ...(params.get('severity') ? { severity: params.get('severity')! } : {}) };
}
export function reportSearch(query: ReportRequest) { return new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined && value !== '' && value !== false).map(([key, value]) => [key, value === true ? '1' : String(value)])).toString(); }
export function finiteMeasurement(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
export function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
