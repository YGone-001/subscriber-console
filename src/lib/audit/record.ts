import type { AuditLogRecord, WriteAuditInput } from '@/types/audit';
import { sanitizeAuditPayload, sanitizeAuditText } from './sanitize';

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' ? sanitizeAuditText(value) : undefined;
}

function safeObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Preserve old columns while scrubbing both new writes and historical reads. */
export function sanitizeAuditRecord(record: AuditLogRecord): AuditLogRecord {
  const payload = safeObject(sanitizeAuditPayload({
    before: record.oldData, after: record.newData, metadata: record.metadata,
  })) || {};
  return {
    id: sanitizeAuditText(record.id),
    timestamp: record.timestamp,
    level: record.level,
    action: sanitizeAuditText(record.action) as AuditLogRecord['action'],
    targetId: sanitizeAuditText(record.targetId),
    actor: optionalText(record.actor),
    operatorIp: sanitizeAuditText(record.operatorIp),
    correlationId: optionalText(record.correlationId),
    approvalId: optionalText(record.approvalId),
    reason: optionalText(record.reason),
    oldData: payload.before ?? (record.oldData == null ? null : '[TRUNCATED]'),
    newData: payload.after ?? (record.newData == null ? null : '[TRUNCATED]'),
    eventId: optionalText(record.eventId),
    actorContext: record.actorContext ? {
      type: record.actorContext.type,
      userId: optionalText(record.actorContext.userId),
      username: optionalText(record.actorContext.username),
      displayName: optionalText(record.actorContext.displayName),
      role: optionalText(record.actorContext.role),
    } : undefined,
    module: optionalText(record.module),
    resource: record.resource ? {
      type: sanitizeAuditText(record.resource.type),
      id: optionalText(record.resource.id),
      name: optionalText(record.resource.name),
    } : undefined,
    riskLevel: record.riskLevel,
    result: record.result,
    source: record.source ? {
      ip: optionalText(record.source.ip),
      userAgent: optionalText(record.source.userAgent),
    } : undefined,
    request: record.request ? {
      method: optionalText(record.request.method),
      path: optionalText(record.request.path),
      requestId: optionalText(record.request.requestId),
      correlationId: optionalText(record.request.correlationId),
    } : undefined,
    metadata: safeObject(payload.metadata),
    error: record.error ? {
      code: optionalText(record.error.code), message: optionalText(record.error.message),
    } : undefined,
  };
}

export function createAuditRecord(input: WriteAuditInput): AuditLogRecord {
  const id = crypto.randomUUID();
  return sanitizeAuditRecord({
    id,
    eventId: `EVT-${id}`,
    timestamp: new Date().toISOString(),
    level: input.level ?? (input.result !== 'success' || input.riskLevel === 'high' || input.riskLevel === 'critical' ? 'warning' : 'info'),
    action: input.action,
    module: input.module,
    actor: input.actor.username || (input.actor.type === 'system' ? 'system' : input.actor.userId),
    actorContext: input.actor,
    targetId: input.targetId ?? input.resource?.id ?? input.resource?.name ?? input.module,
    resource: input.resource,
    operatorIp: input.source?.ip || 'unknown',
    source: input.source,
    request: input.request,
    correlationId: input.request?.correlationId ?? input.request?.requestId,
    approvalId: input.approvalId,
    reason: input.reason,
    oldData: input.before ?? null,
    newData: input.after ?? null,
    riskLevel: input.riskLevel,
    result: input.result,
    metadata: input.metadata,
    error: input.error,
  });
}

/** Accept only a syntactically valid address from the trusted proxy boundary. */
function ipVersion(value: string): 0 | 4 | 6 {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)
    && value.split('.').every((part) => Number(part) <= 255)) return 4;
  if (!value.includes(':')) return 0;
  try {
    const hostname = new URL(`http://[${value}]/`).hostname;
    return hostname.startsWith('[') && hostname.endsWith(']') ? 6 : 0;
  } catch {
    return 0;
  }
}

export function normalizeAuditSourceIp(value: unknown): string {
  if (typeof value !== 'string') return 'unknown';
  let candidate = value.trim().slice(0, 128);
  if (!candidate) return 'unknown';
  if (candidate.startsWith('[')) {
    const close = candidate.indexOf(']');
    if (close > 1) candidate = candidate.slice(1, close);
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(candidate)) {
    candidate = candidate.slice(0, candidate.lastIndexOf(':'));
  }
  candidate = candidate.split('%', 1)[0];
  return ipVersion(candidate) ? candidate.toLowerCase() : 'unknown';
}

function expandedIpv6(value: string): string[] | null {
  let candidate = value;
  const embeddedV4 = candidate.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1];
  if (embeddedV4) {
    const octets = embeddedV4.split('.').map(Number);
    candidate = `${candidate.slice(0, -embeddedV4.length)}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = candidate.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  return [...head, ...Array.from({ length: missing }, () => '0'), ...tail]
    .map((part) => Number.parseInt(part || '0', 16).toString(16));
}

/** Preserve enough network context for investigation without exposing the host address. */
export function maskAuditSourceIp(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return 'unknown';
  const legacy = sanitizeAuditText(value.trim());
  if (legacy.includes('*') || legacy === 'unknown') return legacy;
  const normalized = normalizeAuditSourceIp(legacy);
  const version = ipVersion(normalized);
  if (version === 4) return normalized.replace(/\.\d+$/, '.***');
  if (version === 6) {
    const parts = expandedIpv6(normalized);
    if (parts) return `${parts.slice(0, 4).join(':')}:****:****:****:****`;
  }
  return 'unknown';
}

/** Repository reads are masked by default; callers must explicitly opt into full IP access. */
export function applyAuditSourceIpAccess(record: AuditLogRecord, revealSourceIp = false): AuditLogRecord {
  const clean = sanitizeAuditRecord(record);
  if (revealSourceIp) return clean;
  return {
    ...clean,
    operatorIp: maskAuditSourceIp(clean.operatorIp),
    source: clean.source ? { ...clean.source, ip: maskAuditSourceIp(clean.source.ip) } : undefined,
  };
}

/** Snapshot safe request context. Never record headers wholesale or URL queries. */
export function auditRequestContext(request?: Request): Pick<WriteAuditInput, 'source' | 'request' | 'reason'> {
  if (!request) return {};
  const rawIp = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip') || 'unknown';
  const ip = normalizeAuditSourceIp(rawIp);
  const requestId = request.headers.get('x-request-id')?.trim().slice(0, 128) || crypto.randomUUID();
  return {
    source: { ip, userAgent: request.headers.get('user-agent')?.slice(0, 512) || undefined },
    request: {
      method: request.method,
      path: new URL(request.url).pathname,
      requestId,
      correlationId: request.headers.get('x-correlation-id')?.trim().slice(0, 128) || requestId,
    },
    reason: request.headers.get('x-operation-reason')?.trim().slice(0, 1000) || undefined,
  };
}
