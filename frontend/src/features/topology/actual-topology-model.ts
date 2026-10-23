/*
 * Deterministic projection and layout for the declared topology graph.
 *
 * Inventory remains authoritative for resource identity. This module only
 * arranges resources referenced by active Topology edges; it never fills in
 * a reference interface or infers a missing relationship.
 *
 * The default view is kind-only: network_function and
 * network_function_instance are network functions. network_element and every
 * other kind are support resources, hidden unless showSupport is requested.
 * Role tokens are used for grouping and labels, never for NF visibility.
 */
import type { ResourceProjection, TopologyEdge } from './topology-types';
import {
  classifyResource,
  normalizeRoleToken,
  type TopologyResourceClass,
} from './nf-classification';

export type ActualTopologyGroup =
  | 'access'
  | 'session'
  | 'discovery'
  | 'data'
  | 'policy'
  | 'ims'
  | 'user'
  | 'other'
  | 'support';

export type ActualTopologyNode = ResourceProjection & {
  resourceClass: TopologyResourceClass;
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

export type ActualTopologyBuildOptions = {
  showSupport?: boolean;
};

export type ActualTopologyLayout = {
  nodes: ActualTopologyNode[];
  links: ActualTopologyLink[];
  groups: ActualTopologyGroup[];
  width: number;
  height: number;
  activeLinkCount: number;
  nfResourceCount: number;
  supportResourceCount: number;
  supportLinkCount: number;
  unresolvedResourceCount: number;
};

export const ACTUAL_NODE_WIDTH = 164;
export const ACTUAL_NODE_HEIGHT = 60;
export const ACTUAL_GROUP_WIDTH = 196;
export const ACTUAL_CANVAS_PADDING = 28;

const GROUPS: readonly ActualTopologyGroup[] = [
  'access',
  'session',
  'discovery',
  'data',
  'policy',
  'ims',
  'user',
  'other',
  'support',
];

export const ACTUAL_GROUP_LABEL_KEYS: Record<ActualTopologyGroup, string> = {
  access: 'topology_group_access',
  session: 'topology_group_session',
  discovery: 'topology_group_discovery',
  data: 'topology_group_data',
  policy: 'topology_group_policy',
  ims: 'topology_group_ims',
  user: 'topology_group_user',
  other: 'topology_group_other',
  support: 'topology_group_support',
};

const ROLE_GROUPS: Record<Exclude<ActualTopologyGroup, 'support'>, string[]> = {
  access: ['amf', 'mme', 'gnb', 'enb', 'ngenb'],
  session: ['smf', 'sgwc', 'pgwc'],
  discovery: ['nrf', 'scp', 'dra', 'nssf', 'bsf'],
  data: ['udm', 'udr', 'ausf', 'hss'],
  policy: ['pcf', 'pcrf', 'ocs'],
  ims: ['icscf', 'pcscf', 'scscf', 'smsc'],
  user: ['upf', 'sgwu', 'pgwu'],
  other: [],
};

export function groupForResource(
  resource: ResourceProjection,
  resourceClass: TopologyResourceClass = classifyResource(resource),
): ActualTopologyGroup {
  if (resourceClass === 'support') return 'support';
  const role = normalizeRoleToken(resource.role);
  for (const group of GROUPS) {
    if (group === 'support') continue;
    if (ROLE_GROUPS[group].includes(role)) return group;
  }
  return 'other';
}

export function nodeMatches(resource: ResourceProjection, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  const resourceClass = classifyResource(resource);
  const haystack = `${resource.displayName || ''} ${resource.name || ''} ${resource.role || ''} ${resource.kind || ''} ${resource.domain || ''} ${resourceClass}`;
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
  options: ActualTopologyBuildOptions = {},
): ActualTopologyLayout {
  const showSupport = options.showSupport === true;
  const activeEdges = edges.filter(isActiveEdge);
  const resourceIds = new Set(activeEdges.flatMap((edge) => [edge.fromResourceId, edge.toResourceId]));
  const resources = [...resourceIds]
    .map((resourceId) => {
      const projection = directory[resourceId] ?? unresolvedResource(resourceId);
      return { projection, resourceClass: classifyResource(projection) };
    })
    .sort((left, right) => sortResources(left.projection, right.projection));

  const classById = new Map(
    resources.map(({ projection, resourceClass }) => [projection.resourceId, resourceClass]),
  );
  const nfResourceCount = resources.filter(({ resourceClass }) => resourceClass === 'nf').length;
  const supportResourceCount = resources.filter(({ resourceClass }) => resourceClass === 'support').length;
  const unresolvedResourceCount = resources.filter(({ resourceClass }) => resourceClass === 'unresolved').length;
  const supportLinkCount = activeEdges.filter((edge) => (
    classById.get(edge.fromResourceId) === 'support'
    || classById.get(edge.toResourceId) === 'support'
  )).length;

  const visibleResources = resources.filter(({ resourceClass }) => (
    resourceClass !== 'support' || showSupport
  ));
  const visibleIds = new Set(visibleResources.map(({ projection }) => projection.resourceId));
  const visibleEdges = activeEdges.filter((edge) => (
    visibleIds.has(edge.fromResourceId) && visibleIds.has(edge.toResourceId)
  ));
  const visibleNodes = visibleResources.map(({ projection, resourceClass }) => ({
    ...projection,
    resourceClass,
  }));

  const presentGroups: ActualTopologyGroup[] = GROUPS.filter((group) => (
    visibleNodes.some((resource) => groupForResource(resource, resource.resourceClass) === group)
  ));
  const effectiveGroups: ActualTopologyGroup[] = presentGroups.length > 0 ? presentGroups : ['other'];
  const grouped = new Map<ActualTopologyGroup, (ResourceProjection & { resourceClass: TopologyResourceClass })[]>();
  for (const group of effectiveGroups) grouped.set(group, []);
  for (const resource of visibleNodes) {
    const group = groupForResource(resource, resource.resourceClass);
    const target = grouped.get(group) ?? grouped.get('other')!;
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
  for (const edge of visibleEdges) {
    const key = [edge.fromResourceId, edge.toResourceId].sort().join('|');
    pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
  }
  const links = visibleEdges.flatMap((edge) => {
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

  return {
    nodes,
    links,
    groups: effectiveGroups,
    width,
    height,
    activeLinkCount: activeEdges.length,
    nfResourceCount,
    supportResourceCount,
    supportLinkCount,
    unresolvedResourceCount,
  };
}
