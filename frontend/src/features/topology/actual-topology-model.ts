/*
 * Deterministic projection and layout for the declared topology graph.
 *
 * Inventory remains authoritative for resource identity. This module only
 * arranges resources referenced by active Topology edges; it never fills in
 * a reference interface or infers a missing relationship.
 */
import type { ResourceProjection, TopologyEdge } from './topology-types';

export type ActualTopologyGroup =
  | 'access'
  | 'session'
  | 'discovery'
  | 'data'
  | 'policy'
  | 'user'
  | 'other';

export type ActualTopologyNode = ResourceProjection & {
  group: ActualTopologyGroup;
  x: number;
  y: number;
  resolved: boolean;
};

export type ActualTopologyLink = TopologyEdge & {
  fromNode: ActualTopologyNode;
  toNode: ActualTopologyNode;
  parallelIndex: number;
  parallelCount: number;
};

export type ActualTopologyLayout = {
  nodes: ActualTopologyNode[];
  links: ActualTopologyLink[];
  groups: ActualTopologyGroup[];
  width: number;
  height: number;
};

export const ACTUAL_NODE_WIDTH = 164;
export const ACTUAL_NODE_HEIGHT = 60;
export const ACTUAL_GROUP_WIDTH = 196;
export const ACTUAL_CANVAS_PADDING = 28;

const GROUPS: readonly ActualTopologyGroup[] = ['access', 'session', 'discovery', 'data', 'policy', 'user', 'other'];

export const ACTUAL_GROUP_LABEL_KEYS: Record<ActualTopologyGroup, string> = {
  access: 'topology_group_access',
  session: 'topology_group_session',
  discovery: 'topology_group_discovery',
  data: 'topology_group_data',
  policy: 'topology_group_policy',
  user: 'topology_group_user',
  other: 'topology_group_other',
};

const ROLE_GROUPS: Record<ActualTopologyGroup, string[]> = {
  access: ['amf', 'mme', 'gnb', 'enb', 'ngenb'],
  session: ['smf', 'sgwc', 'pgwc', 'sgw-c', 'pgw-c'],
  discovery: ['nrf', 'scp', 'nssf', 'bsf'],
  data: ['udm', 'udr', 'ausf', 'hss'],
  policy: ['pcf', 'pcrf', 'ocs'],
  user: ['upf', 'sgwu', 'pgwu', 'sgw-u', 'pgw-u'],
  other: [],
};

function normalizedRole(resource: ResourceProjection): string {
  return (resource.role || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
}

export function groupForResource(resource: ResourceProjection): ActualTopologyGroup {
  const role = normalizedRole(resource);
  return GROUPS.find((group) => ROLE_GROUPS[group].includes(role)) ?? 'other';
}

export function nodeMatches(resource: ResourceProjection, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  const haystack = `${resource.displayName || ''} ${resource.name || ''} ${resource.role || ''} ${resource.kind || ''} ${resource.domain || ''}`;
  return haystack.toLowerCase().includes(normalized);
}

function sortResources(left: ResourceProjection, right: ResourceProjection): number {
  const leftName = left.displayName || left.name || left.resourceId;
  const rightName = right.displayName || right.name || right.resourceId;
  return leftName.localeCompare(rightName) || left.resourceId.localeCompare(right.resourceId);
}

function isActiveEdge(value: unknown): value is TopologyEdge {
  if (!value || typeof value !== 'object') return false;
  const edge = value as Partial<TopologyEdge>;
  return edge.lifecycleState === 'active'
    && typeof edge.edgeId === 'string'
    && typeof edge.fromResourceId === 'string'
    && typeof edge.toResourceId === 'string'
    && edge.fromResourceId !== edge.toResourceId;
}

function unresolvedResource(resourceId: string): ResourceProjection {
  return {
    resourceId,
    kind: '',
    name: '',
    domain: '',
    lifecycleState: 'unknown',
  };
}

export function buildActualTopology(
  edges: unknown[],
  directory: Record<string, ResourceProjection>,
): ActualTopologyLayout {
  const activeEdges = edges.filter(isActiveEdge);
  const resourceIds = new Set(activeEdges.flatMap((edge) => [edge.fromResourceId, edge.toResourceId]));
  const resources = [...resourceIds]
    .map((resourceId) => directory[resourceId] ?? unresolvedResource(resourceId))
    .sort(sortResources);
  const groups: ActualTopologyGroup[] = GROUPS.filter(
    (group) => resources.some((resource) => groupForResource(resource) === group),
  );
  const effectiveGroups: ActualTopologyGroup[] = groups.length > 0 ? groups : ['other'];
  const grouped = new Map<ActualTopologyGroup, ResourceProjection[]>();
  for (const group of effectiveGroups) grouped.set(group, []);
  for (const resource of resources) {
    const group = groupForResource(resource);
    const target: ResourceProjection[] = grouped.get(group) ?? grouped.get('other')!;
    target.push(resource);
  }

  const rows = Math.max(1, ...effectiveGroups.map((group) => grouped.get(group)?.length ?? 0));
  const width = ACTUAL_CANVAS_PADDING * 2 + effectiveGroups.length * ACTUAL_GROUP_WIDTH;
  const height = ACTUAL_CANVAS_PADDING * 2 + 34 + rows * 78;
  const nodes: ActualTopologyNode[] = [];

  effectiveGroups.forEach((group, groupIndex) => {
    const column = grouped.get(group) ?? [];
    column.forEach((resource, rowIndex) => {
      nodes.push({
        ...resource,
        group,
        x: ACTUAL_CANVAS_PADDING + groupIndex * ACTUAL_GROUP_WIDTH + (ACTUAL_GROUP_WIDTH - ACTUAL_NODE_WIDTH) / 2,
        y: ACTUAL_CANVAS_PADDING + 34 + rowIndex * 78,
        resolved: Boolean(resource.name || resource.displayName),
      });
    });
  });

  const byId = new Map(nodes.map((node) => [node.resourceId, node]));
  const pairCounts = new Map<string, number>();
  const pairProgress = new Map<string, number>();
  for (const edge of activeEdges) {
    const key = [edge.fromResourceId, edge.toResourceId].sort().join('|');
    pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
  }
  const links = activeEdges.flatMap((edge) => {
    const source = byId.get(edge.fromResourceId);
    const target = byId.get(edge.toResourceId);
    if (!source || !target) return [];
    const key = [edge.fromResourceId, edge.toResourceId].sort().join('|');
    const parallelIndex = pairProgress.get(key) ?? 0;
    pairProgress.set(key, parallelIndex + 1);
    return [{
      ...edge,
      fromNode: source,
      toNode: target,
      parallelIndex,
      parallelCount: pairCounts.get(key) ?? 1,
    }];
  });

  return { nodes, links, groups: effectiveGroups, width, height };
}
