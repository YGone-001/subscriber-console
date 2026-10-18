import type { LayerSet } from '../nf-health/nf-health-types';

// Alert lifecycle states mirror backend nfalert.AlertState*.
export type AlertState = 'active' | 'acknowledged' | 'resolved';

// Operator-authored severities carried from the triggering rule.
export type AlertSeverity = 'critical' | 'warning' | 'info';

// Condition types evaluate explicit NF Health measurement evidence.
export type ConditionType = 'state' | 'run_failed';

// Scopes for state conditions.
export type ConditionScope = 'overall' | 'process' | 'interface' | 'service';

// Layer states selectable by a state condition. not_configured and stale are
// excluded on the backend: one is target configuration, the other is a
// freshness projection the engine never derives from an accepted sample.
export type StateConditionValue = 'unhealthy' | 'degraded' | 'unknown';

// Resolve reasons recorded on closed alerts.
export type ResolveReason = 'recovery' | 'manual' | 'rule_deleted';

// Run outcomes reported by NF Health collection runs.
export type RunStatus = 'success' | 'partial' | 'failed';

export interface RuleCondition {
  scope: ConditionScope;
  state: StateConditionValue;
}

// AlertRule is an operator-authored configuration. A rule is a pure observer
// over NF Health evidence and never modifies the network.
export interface AlertRule {
  ruleId: string;
  schemaVersion: number;
  name: string;
  description?: string;
  enabled: boolean;
  targetId?: string;
  resourceId?: string;
  conditionType: ConditionType;
  condition?: RuleCondition;
  severity: AlertSeverity;
  cooldownSeconds: number;
  revision: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

// AlertEvidence is the immutable measurement snapshot that opened or re-armed
// the alert: exactly what was observed, never a derived summary.
export interface AlertEvidence {
  runStatus: RunStatus;
  sampleId?: string;
  collectedAt?: string;
  layers?: LayerSet;
  overallState?: StateConditionValue;
}

// Alert is one open, acknowledged or resolved alert instance for a
// (rule, target) pair.
export interface Alert {
  alertId: string;
  schemaVersion: number;
  ruleId: string;
  ruleName: string;
  targetId: string;
  resourceId?: string;
  targetName: string;
  severity: AlertSeverity;
  state: AlertState;
  conditionType: ConditionType;
  condition?: RuleCondition;
  triggerCount: number;
  firstTriggeredAt: string;
  lastTriggeredAt: string;
  evidence: AlertEvidence;
  acknowledgedAt?: string;
  acknowledgedBy?: string;
  resolvedAt?: string;
  resolvedReason?: ResolveReason;
  updatedAt: string;
}

// NfAlertsMeta mirrors the GET /api/nf-alerts/meta vocabulary payload.
export interface NfAlertsMeta {
  schemaVersion: number;
  alertStates: AlertState[];
  severities: AlertSeverity[];
  conditionTypes: ConditionType[];
  conditionScopes: ConditionScope[];
  stateConditionValues: StateConditionValue[];
  resolveReasons: ResolveReason[];
  minCooldownSeconds: number;
  maxCooldownSeconds: number;
  defaultCooldownSeconds: number;
  runStatuses: RunStatus[];
}

export interface PageInfo {
  limit: number;
  nextCursor?: string | null;
  hasMore: boolean;
}

export interface ListRulesResponse {
  rules: AlertRule[];
  page: PageInfo;
}

export interface ListAlertsResponse {
  alerts: Alert[];
  page: PageInfo;
}

export interface DeleteRuleResponse {
  deleted: boolean;
  ruleId: string;
  resolvedAlerts: number;
}

// CreateRuleRequest is the body for POST /api/nf-alerts/rules. Exactly one of
// targetId / resourceId may be set; both empty applies to all targets.
export interface CreateRuleRequest {
  name: string;
  description?: string;
  enabled?: boolean;
  targetId?: string;
  resourceId?: string;
  conditionType: ConditionType;
  condition?: RuleCondition;
  severity: AlertSeverity;
  cooldownSeconds: number;
}

// UpdateRuleRequest is the body for PUT /api/nf-alerts/rules/{ruleId}.
// Identity fields (targetId, resourceId) are immutable on update.
export interface UpdateRuleRequest {
  expectedRevision: number;
  rule: {
    name: string;
    description?: string;
    enabled: boolean;
    conditionType: ConditionType;
    condition?: RuleCondition;
    severity: AlertSeverity;
    cooldownSeconds: number;
  };
}

export interface RuleListQueryParams {
  q?: string;
  enabled?: string;
  cursor?: string;
  limit?: number;
}

export interface AlertListQueryParams {
  state?: string;
  severity?: string;
  q?: string;
  cursor?: string;
  limit?: number;
}
