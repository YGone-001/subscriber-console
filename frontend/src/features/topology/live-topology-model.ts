/*
 * Mapping from the live topology API to the existing deterministic canvas
 * model. Live nodes are runtime identities, never Inventory replacements.
 */
import type { ResourceProjection, TopologyEdge } from './topology-types';
import type { LiveTopologyResponse } from './live-topology-types';

export type RuntimeStateCount = {
  /* The locale token is `runtime_status_<state>`. */
  state: string;
  count: number;
};

const RUNTIME_STATE_FIELDS = [
  ['running', 'running'],
  ['stopped', 'stopped'],
  ['unverified', 'unverified'],
  ['permission_denied', 'permissionDenied'],
  ['unknown', 'unknown'],
  ['stale', 'stale'],
  ['not_detected', 'notDetected'],
] as const satisfies ReadonlyArray<readonly [string, keyof LiveTopologyResponse['runtime']]>;

/**
 * Runtime states present in the payload, in a stable order.
 *
 * A zero count is not a state observation: the summary must not invent a
 * "stopped 0" or "stale 0" row for a state that does not occur.
 */
export function presentRuntimeStates(runtime: LiveTopologyResponse['runtime']): RuntimeStateCount[] {
  return RUNTIME_STATE_FIELDS
    .map(([state, field]) => ({ state, count: runtime[field] }))
    .filter((entry) => entry.count > 0);
}

/**
 * Completeness of the configured-evidence read.
 *
 * A missing manifest means configured evidence is unavailable, not that the
 * runtime snapshot is healthy or empty. A partial source read stays partial.
 */
export function liveConfigCompleteness(
  config: LiveTopologyResponse['config'],
): 'complete' | 'partial' | 'unavailable' {
  if (!config.manifestConfigured) return 'unavailable';
  return config.complete ? 'complete' : 'partial';
}

export type ReconciliationSummary = {
  /* False when the ledger read was truncated: the diff is then a floor, not a total. */
  complete: boolean;
  matched: number;
  undeclared: number;
  unevidenced: number;
  retired: number;
  differing: number;
};

/**
 * Advisory diff between the persisted ledger and the configured evidence.
 *
 * Returns null when the server sent no reconciliation block or the ledger could
 * not be read: an unread ledger must never render as "nothing to reconcile".
 */
export function reconciliationSummary(
  data: LiveTopologyResponse | undefined,
): ReconciliationSummary | null {
  const block = data?.reconciliation;
  if (!block || !block.available) return null;
  return {
    complete: block.complete,
    matched: block.matchedCount,
    undeclared: block.undeclaredEvidence.length,
    unevidenced: block.unevidencedDeclarations.length,
    retired: block.undeclaredEvidence.filter((item) => item.retired).length,
    differing: block.matched.filter((item) => item.interfaceMatch === 'differs').length,
  };
}

export function liveDirectory(data: LiveTopologyResponse | undefined): Record<string, ResourceProjection> {
  const directory: Record<string, ResourceProjection> = {};
  for (const node of data?.nodes ?? []) {
    directory[node.componentId] = {
      resourceId: node.componentId,
      kind: 'network_function',
      name: node.componentId,
      displayName: node.displayName || node.componentId,
      domain: node.domain ?? '',
      role: node.role,
      lifecycleState: 'unknown',
      runtimeStatus: node.runtimeStatus,
      statusReason: node.statusReason,
    };
  }
  return directory;
}

export function liveEdges(data: LiveTopologyResponse | undefined): TopologyEdge[] {
  return (data?.edges ?? []).map((edge) => ({
    edgeId: edge.edgeId,
    schemaVersion: 1,
    relationshipType: edge.relationshipType,
    fromResourceId: edge.fromComponentId,
    toResourceId: edge.toComponentId,
    description: `${edge.protocol} configured relationship`,
    interfaceNames: edge.interfaceNames ?? [],
    protocol: edge.protocol,
    lifecycleState: 'active',
    source: {
      kind: edge.evidence || 'configured',
      system: 'nf_etc',
      authority: 'configured',
    },
    revision: 1,
    createdAt: data?.generatedAt ?? '',
    createdBy: 'nf_etc',
    updatedAt: data?.generatedAt ?? '',
    updatedBy: 'nf_etc',
  }));
}
