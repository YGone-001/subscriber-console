/*
 * Operations overview projection.
 *
 * Pure mapping from the platform-wide operations summary and the local runtime
 * snapshot to the dashboard posture. Every value is nullable so an unavailable
 * section is rendered as unavailable instead of a fabricated zero.
 */
import type { RuntimeCounts } from '../runtime/runtime-types';
import type { OperationsSummaryResponse } from './operations-summary';

export type OperationsPosture = {
  runtime: {
    running: number | null;
    total: number | null;
    expected: number | null;
    stopped: number | null;
    attention: number | null;
  };
  monitored: {
    enabled: number | null;
    configured: number | null;
    failed: number | null;
  };
  fresh: {
    fresh: number | null;
    enabled: number | null;
    staleUnknown: number | null;
    failed: number | null;
  };
  alerts: {
    active: number | null;
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

  const enabled = health ? health.enabled : null;
  const fresh = health ? (health.freshnessByState?.fresh ?? 0) : null;
  const failed = health ? health.failed : null;
  const staleUnknown = health ? Math.max(health.enabled - (health.freshnessByState?.fresh ?? 0) - health.failed, 0) : null;

  return {
    runtime: {
      running: counts ? counts.running : null,
      total: counts ? counts.total : null,
      expected: counts ? counts.expected : null,
      stopped: counts ? counts.stopped : null,
      attention: counts ? counts.unverified + counts.permissionDenied + counts.unknown + counts.stale : null,
    },
    monitored: {
      enabled,
      configured: health ? health.configured : null,
      failed,
    },
    fresh: {
      fresh,
      enabled,
      staleUnknown,
      failed,
    },
    alerts: {
      active: alerts ? (alerts.alertsByState?.active ?? 0) : null,
      critical: alerts ? (alerts.openBySeverity?.critical ?? 0) : null,
    },
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
