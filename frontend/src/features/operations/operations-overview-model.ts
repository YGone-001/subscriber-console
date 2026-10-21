/*
 * Operations overview projection.
 *
 * Pure mapping from the platform-wide operations summary and the local runtime
 * snapshot to the dashboard posture. Every value is nullable so an unavailable
 * section is rendered as unavailable instead of a fabricated zero.
 */
import type { RuntimeCategory, RuntimeComponent, RuntimeCounts } from '../runtime/runtime-types';
import type { OperationsSummaryResponse } from './operations-summary';

export type OperationsPosture = {
  runtime: {
    running: number | null;
    total: number | null;
    expected: number | null;
    stopped: number | null;
    attention: number | null;
    notDetected: number | null;
  };
  monitored: {
    enabled: number | null;
    configured: number | null;
    failed: number | null;
    healthy: number | null;
    degraded: number | null;
    unhealthy: number | null;
    stale: number | null;
  };
  fresh: {
    fresh: number | null;
    enabled: number | null;
    staleUnknown: number | null;
    failed: number | null;
  };
  alerts: {
    active: number | null;
    acknowledged: number | null;
    open: number | null;
    critical: number | null;
  };
};

export type StatusDistributionItem = {
  key: string;
  value: number;
};

export function buildOperationsPosture(
  summary: OperationsSummaryResponse | undefined,
  counts: RuntimeCounts | undefined,
): OperationsPosture {
  const health = summary?.health?.completeness === 'complete' ? summary.health.targets : undefined;
  const alerts = summary?.alerts?.completeness === 'complete' ? summary.alerts.alerts : undefined;
  const overall = health?.overallByState;

  const enabled = health ? health.enabled : null;
  const fresh = health ? (health.freshnessByState?.fresh ?? 0) : null;
  const failed = health ? health.failed : null;
  const staleUnknown = health ? Math.max(health.enabled - (health.freshnessByState?.fresh ?? 0) - health.failed, 0) : null;

  const active = alerts ? (alerts.alertsByState?.active ?? 0) : null;
  const acknowledged = alerts ? (alerts.alertsByState?.acknowledged ?? 0) : null;
  const open = alerts
    ? alerts.openBySeverity
      ? Object.values(alerts.openBySeverity).reduce((sum, value) => sum + value, 0)
      : (active ?? 0) + (acknowledged ?? 0)
    : null;

  return {
    runtime: {
      running: counts ? counts.running : null,
      total: counts ? counts.total : null,
      expected: counts ? counts.expected : null,
      stopped: counts ? counts.stopped : null,
      attention: counts ? counts.unverified + counts.permissionDenied + counts.unknown + counts.stale : null,
      notDetected: counts ? counts.notDetected : null,
    },
    monitored: {
      enabled,
      configured: health ? health.configured : null,
      failed,
      healthy: health ? (overall?.healthy ?? 0) : null,
      degraded: health ? (overall?.degraded ?? 0) : null,
      unhealthy: health ? (overall?.unhealthy ?? 0) : null,
      stale: health ? (overall?.stale ?? 0) : null,
    },
    fresh: {
      fresh,
      enabled,
      staleUnknown,
      failed,
    },
    alerts: {
      active,
      acknowledged,
      open,
      critical: alerts ? (alerts.openBySeverity?.critical ?? 0) : null,
    },
  };
}

const ATTENTION_STATUS_ORDER: Partial<Record<RuntimeComponent['runtimeStatus'], number>> = {
  stopped: 0,
  unverified: 1,
  permission_denied: 2,
  unknown: 3,
  stale: 4,
};

export type RuntimeAttentionItem = {
  componentId: string;
  displayName: string;
  processName: string;
  category: RuntimeCategory;
  status: RuntimeComponent['runtimeStatus'];
  statusReason: string;
};

export type RuntimeAttentionProjection = {
  items: RuntimeAttentionItem[];
  total: number;
};

/**
 * Runtime attention queue projection.
 *
 * Only runtime components that carry a negative or indeterminate observation
 * enter the queue. `not_detected` stays out: under the scanner contract it means
 * "never observed and not expected", which is not an incident. Expected-but-absent
 * components are already reported as `stopped`, so they never need a second rule.
 */
export function runtimeAttentionItems(
  components: RuntimeComponent[] | undefined,
  limit = 5,
): RuntimeAttentionProjection {
  if (!components || components.length === 0) return { items: [], total: 0 };
  const boundedLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 5;
  const attention = components
    .filter((component) => ATTENTION_STATUS_ORDER[component.runtimeStatus] !== undefined)
    .sort((left, right) => {
      const rankDiff = (ATTENTION_STATUS_ORDER[left.runtimeStatus] ?? 99)
        - (ATTENTION_STATUS_ORDER[right.runtimeStatus] ?? 99);
      return rankDiff !== 0 ? rankDiff : left.displayName.localeCompare(right.displayName);
    });

  return {
    total: attention.length,
    items: attention.slice(0, boundedLimit).map((component) => ({
      componentId: component.componentId,
      displayName: component.displayName,
      processName: component.processName,
      category: component.category,
      status: component.runtimeStatus,
      statusReason: component.statusReason,
    })),
  };
}

/**
 * Runtime status distribution. `expected` is a registry expectation, not a
 * runtime status, so it never appears as a mutually exclusive bucket.
 */
export function runtimeStatusDistribution(
  counts: RuntimeCounts | undefined,
): StatusDistributionItem[] | null {
  if (!counts) return null;
  return [
    { key: 'running', value: counts.running },
    { key: 'stopped', value: counts.stopped },
    {
      key: 'attention',
      value: counts.unverified + counts.permissionDenied + counts.unknown + counts.stale,
    },
    { key: 'not_detected', value: counts.notDetected },
  ];
}

/**
 * NF Health overall-state distribution. Unknown keys are retained verbatim
 * rather than dropped, so a new server state never disappears from the total.
 */
export function healthStatusDistribution(
  summary: OperationsSummaryResponse | undefined,
): StatusDistributionItem[] | null {
  const health = summary?.health?.completeness === 'complete' ? summary.health.targets : undefined;
  if (!health) return null;

  const states = health.overallByState ?? {};
  const ordered = ['healthy', 'degraded', 'unhealthy', 'unknown', 'stale', 'not_configured'];
  const items: StatusDistributionItem[] = [];
  for (const key of ordered) {
    if (typeof states[key] === 'number') items.push({ key, value: states[key] });
  }
  for (const key of Object.keys(states).sort()) {
    if (!ordered.includes(key)) items.push({ key, value: states[key] });
  }
  return items;
}
