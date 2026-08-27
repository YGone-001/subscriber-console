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

/** Snapshot safe request context. Never record headers wholesale or URL queries. */
export function auditRequestContext(request?: Request): Pick<WriteAuditInput, 'source' | 'request' | 'reason'> {
  if (!request) return {};
  const rawIp = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip') || 'unknown';
  // Retain existing IP masking. Trusted proxy IP handling is a deployment concern.
  const ip = rawIp.includes(':') ? `${rawIp.split(':').slice(0, 3).join(':')}:***`
    : rawIp.replace(/\.\d+$/, '.***');
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
