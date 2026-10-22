/*
 * Monitoring association and health projection for declared-topology nodes.
 *
 * Inventory remains the node authority and NF Health remains the measurement
 * authority. A resource becomes "not monitored" only when the bounded
 * association lookup for that resource succeeded; a failed lookup stays
 * "unresolved" and is never presented as an absent target.
 */
import type { LayerState } from '../nf-health/nf-health-types';
import { monitoringFromTarget, type MonitoringView } from '../operations/operational-model';

export type NodeHealthState = LayerState | 'disabled' | 'not_monitored' | 'unresolved';

export type NodeHealth = {
  state: NodeHealthState;
  targetId: string;
  overallState: string;
  freshness: string;
  statusComplete: boolean;
};

const CANONICAL_STATES: readonly string[] = [
  'healthy',
  'degraded',
  'unhealthy',
  'unknown',
  'not_configured',
  'stale',
];

function isCanonicalState(value: string): value is LayerState {
  return CANONICAL_STATES.includes(value);
}

export function projectNodeHealth(
  resourceIds: readonly string[],
  targets: unknown[] | undefined,
  resolvedResourceIds: ReadonlySet<string>,
): Map<string, NodeHealth> {
  const byResource = new Map<string, MonitoringView>();
  for (const target of targets ?? []) {
    if (!target || typeof target !== 'object') continue;
    const resourceId = (target as { resourceId?: unknown }).resourceId;
    if (typeof resourceId !== 'string' || !resourceId) continue;
    const view = monitoringFromTarget(target);
    const existing = byResource.get(resourceId);
    if (!existing || (!existing.enabled && view.enabled)) byResource.set(resourceId, view);
  }

  const result = new Map<string, NodeHealth>();
  for (const resourceId of resourceIds) {
    const view = byResource.get(resourceId);
    if (!view) {
      result.set(resourceId, {
        state: resolvedResourceIds.has(resourceId) ? 'not_monitored' : 'unresolved',
        targetId: '',
        overallState: '',
        freshness: '',
        statusComplete: true,
      });
      continue;
    }
    const overall = isCanonicalState(view.overallState) ? view.overallState : 'unknown';
    result.set(resourceId, {
      // A failed status projection is not evidence of health, and a disabled
      // target is not collecting: neither is projected as the last good state.
      state: !view.enabled ? 'disabled' : view.statusComplete === false ? 'unknown' : overall,
      targetId: view.targetId,
      overallState: view.overallState,
      freshness: view.freshnessState,
      statusComplete: view.statusComplete,
    });
  }
  return result;
}

export type NodeHealthCounts = {
  monitored: number;
  healthy: number;
  abnormal: number;
  stale: number;
  unknown: number;
  notConfigured: number;
  disabled: number;
  notMonitored: number;
  unresolved: number;
};

export function summarizeNodeHealth(byResource: ReadonlyMap<string, NodeHealth>): NodeHealthCounts {
  const counts: NodeHealthCounts = {
    monitored: 0,
    healthy: 0,
    abnormal: 0,
    stale: 0,
    unknown: 0,
    notConfigured: 0,
    disabled: 0,
    notMonitored: 0,
    unresolved: 0,
  };
  for (const health of byResource.values()) {
    switch (health.state) {
      case 'healthy':
        counts.monitored += 1;
        counts.healthy += 1;
        break;
      case 'degraded':
      case 'unhealthy':
        counts.monitored += 1;
        counts.abnormal += 1;
        break;
      case 'stale':
        counts.monitored += 1;
        counts.stale += 1;
        break;
      case 'unknown':
        counts.monitored += 1;
        counts.unknown += 1;
        break;
      case 'not_configured':
        counts.monitored += 1;
        counts.notConfigured += 1;
        break;
      case 'disabled':
        counts.disabled += 1;
        break;
      case 'not_monitored':
        counts.notMonitored += 1;
        break;
      case 'unresolved':
        counts.unresolved += 1;
        break;
    }
  }
  return counts;
}

export function nodeHealthLabelKey(state: NodeHealthState): string {
  if (state === 'disabled' || state === 'not_monitored' || state === 'unresolved') {
    return `topology_health_${state}`;
  }
  return `nf_health_state_${state}`;
}
