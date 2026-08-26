import type { AuditResult, GovernanceActor, GovernanceResource, RiskLevel } from './governance';

export type LegacyAuditAction =
  | 'CREATE' | 'UPDATE' | 'DELETE' | 'BATCH_CREATE' | 'BATCH_DELETE' | 'HEAL'
  | 'PROFILE_CREATE' | 'PROFILE_UPDATE' | 'PROFILE_DELETE' | 'CSV_IMPORT'
  | 'TRAFFIC_RECHARGE' | 'TRAFFIC_ADJUST' | 'TRAFFIC_RESET';

export type AuditAction = LegacyAuditAction | `${string}.${string}`;

export interface AuditSource {
  ip?: string;
  userAgent?: string;
}

export interface AuditRequestContext {
  method?: string;
  path?: string;
  requestId?: string;
  correlationId?: string;
}

/** Additive extension of app_audit_logs; actor stays a string for old consumers. */
export interface AuditLogRecord {
  id: string;
  timestamp: string;
  level: 'info' | 'warning';
  action: AuditAction;
  targetId: string;
  actor?: string;
  operatorIp: string;
  correlationId?: string;
  approvalId?: string;
  reason?: string;
  oldData: unknown;
  newData: unknown;
  eventId?: string;
  actorContext?: GovernanceActor;
  module?: string;
  resource?: GovernanceResource;
  riskLevel?: RiskLevel;
  result?: AuditResult;
  source?: AuditSource;
  request?: AuditRequestContext;
  metadata?: Record<string, unknown>;
  error?: { code?: string; message?: string };
}

export interface WriteAuditInput {
  actor: GovernanceActor;
  module: string;
  action: AuditAction;
  resource?: GovernanceResource;
  riskLevel?: RiskLevel;
  result: AuditResult;
  source?: AuditSource;
  request?: AuditRequestContext;
  approvalId?: string;
  reason?: string;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
  error?: { code?: string; message?: string };
  /** Preserve legacy target keys such as SYS_USER:name and approval:uuid. */
  targetId?: string;
  level?: 'info' | 'warning';
}
