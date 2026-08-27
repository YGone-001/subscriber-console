import type { AuditLogRecord } from '@/types/audit';

export const AUDIT_PAGE_SIZES = [20, 50, 100] as const;
export const AUDIT_MODULES = [
  'audit', 'users', 'subscribers', 'profiles', 'approvals', 'ocs', 'rating',
  'system', 'security', 'legacy',
] as const;
export const AUDIT_RESULTS = ['success', 'failed', 'denied'] as const;
export const AUDIT_RISKS = ['low', 'medium', 'high', 'critical'] as const;
export const AUDIT_LEVELS = ['info', 'warning'] as const;

export type AuditQuery = {
  page: number;
  pageSize: number;
  q?: string;
  action?: string;
  module?: string;
  result?: string;
  risk?: string;
  actor?: string;
  resourceType?: string;
  resourceId?: string;
  requestId?: string;
  correlationId?: string;
  approvalId?: string;
  sourceIp?: string;
  level?: string;
  from?: string;
  to?: string;
};

export type AuditMongoFilter = Record<string, unknown>;

export class AuditQueryError extends Error {
  readonly code = 'INVALID_QUERY';

  constructor(message: string) {
    super(message);
    this.name = 'AuditQueryError';
  }
}

export function escapeAuditRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function trimmed(params: URLSearchParams, key: string, maxLength: number): string | undefined {
  const value = params.get(key)?.trim();
  if (!value || value.toLowerCase() === 'all') return undefined;
  if (value.length > maxLength) throw new AuditQueryError(`${key} exceeds ${maxLength} characters`);
  return value;
}

function positiveInteger(value: string | null, fallback: number, name: string): number {
  if (value === null || value === '') return fallback;
  if (!/^\d+$/.test(value)) throw new AuditQueryError(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new AuditQueryError(`${name} must be a positive integer`);
  return parsed;
}

function enumValue(value: string | undefined, allowed: readonly string[], name: string): string | undefined {
  if (value === undefined) return undefined;
  if (!allowed.includes(value)) throw new AuditQueryError(`${name} has an unsupported value`);
  return value;
}

function dateBoundary(value: string | undefined, name: string, endOfDay: boolean): string | undefined {
  if (value === undefined) return undefined;
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}`
    : value;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) throw new AuditQueryError(`${name} must be a valid ISO date`);
  return date.toISOString();
}

export function parseAuditQuery(params: URLSearchParams): AuditQuery {
  const page = positiveInteger(params.get('page'), 1, 'page');
  const canonicalPageSize = params.get('pageSize');
  const legacyLimit = canonicalPageSize === null ? params.get('limit') : null;
  const pageSize = positiveInteger(canonicalPageSize ?? legacyLimit, 20, canonicalPageSize === null && legacyLimit !== null ? 'limit' : 'pageSize');
  if (canonicalPageSize !== null && !AUDIT_PAGE_SIZES.includes(pageSize as (typeof AUDIT_PAGE_SIZES)[number])) {
    throw new AuditQueryError('pageSize must be one of 20, 50, or 100');
  }
  if (legacyLimit !== null && pageSize > 100) throw new AuditQueryError('limit cannot exceed 100');

  const action = trimmed(params, 'action', 64);
  if (action && !/^[A-Za-z][A-Za-z0-9_.:-]*$/.test(action)) throw new AuditQueryError('action has an invalid format');
  const from = dateBoundary(trimmed(params, 'from', 40), 'from', false);
  const to = dateBoundary(trimmed(params, 'to', 40), 'to', true);
  if (from && to && from > to) throw new AuditQueryError('from must be earlier than or equal to to');

  return {
    page,
    pageSize,
    q: trimmed(params, 'q', 256),
    action,
    module: enumValue(trimmed(params, 'module', 64), AUDIT_MODULES, 'module'),
    result: enumValue(trimmed(params, 'result', 32), AUDIT_RESULTS, 'result'),
    risk: enumValue(trimmed(params, 'risk', 32), AUDIT_RISKS, 'risk'),
    actor: trimmed(params, 'actor', 128) ?? trimmed(params, 'operator', 128),
    resourceType: trimmed(params, 'resourceType', 64),
    resourceId: trimmed(params, 'resourceId', 128) ?? trimmed(params, 'target', 128),
    requestId: trimmed(params, 'requestId', 128),
    correlationId: trimmed(params, 'correlationId', 128),
    approvalId: trimmed(params, 'approvalId', 128),
    sourceIp: trimmed(params, 'sourceIp', 64),
    level: enumValue(trimmed(params, 'level', 32), AUDIT_LEVELS, 'level'),
    from,
    to,
  };
}

function contains(value: string) {
  return { $regex: escapeAuditRegex(value), $options: 'i' };
}

/** Build only whitelisted predicates; callers never pass a Mongo filter from the client. */
export function buildAuditFilter(query: AuditQuery): AuditMongoFilter {
  const clauses: AuditMongoFilter[] = [];
  if (query.action) clauses.push({ action: query.action as AuditLogRecord['action'] });
  if (query.module) clauses.push({ module: query.module });
  if (query.result) clauses.push({ result: query.result as AuditLogRecord['result'] });
  if (query.risk) clauses.push({ riskLevel: query.risk as AuditLogRecord['riskLevel'] });
  if (query.level) clauses.push({ level: query.level as AuditLogRecord['level'] });
  if (query.actor) {
    const match = contains(query.actor);
    clauses.push({ $or: [{ actor: match }, { 'actorContext.username': match }, { 'actorContext.displayName': match }, { 'actorContext.userId': query.actor }] });
  }
  if (query.resourceType) clauses.push({ 'resource.type': query.resourceType });
  if (query.resourceId) {
    const match = contains(query.resourceId);
    clauses.push({ $or: [{ targetId: match }, { 'resource.id': match }, { 'resource.name': match }] });
  }
  if (query.requestId) clauses.push({ 'request.requestId': query.requestId });
  if (query.correlationId) clauses.push({ $or: [{ correlationId: query.correlationId }, { 'request.correlationId': query.correlationId }] });
  if (query.approvalId) clauses.push({ approvalId: query.approvalId });
  if (query.sourceIp) clauses.push({ $or: [{ operatorIp: query.sourceIp }, { 'source.ip': query.sourceIp }] });
  if (query.from || query.to) {
    const timestamp: { $gte?: string; $lte?: string } = {};
    if (query.from) timestamp.$gte = query.from;
    if (query.to) timestamp.$lte = query.to;
    clauses.push({ timestamp });
  }
  if (query.q) {
    const match = contains(query.q);
    clauses.push({ $or: [
      { id: match }, { eventId: match }, { action: match }, { actor: match },
      { targetId: match }, { 'resource.id': match }, { 'request.requestId': match },
      { 'request.correlationId': match }, { correlationId: match }, { approvalId: match },
    ] });
  }
  if (clauses.length === 0) return {};
  return clauses.length === 1 ? clauses[0] : { $and: clauses };
}
