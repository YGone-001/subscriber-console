/*
 * Mapping from the live topology API to the existing deterministic canvas
 * model. Live nodes are runtime identities, never Inventory replacements.
 */
import type { ResourceProjection, TopologyEdge } from './topology-types';
import type { LiveTopologyResponse } from './live-topology-types';

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
