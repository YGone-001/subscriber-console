/*
 * Deterministic projection and layout for the declared topology graph.
 *
 * Inventory remains authoritative for resource identity. This module only
 * arranges resources referenced by active Topology edges; it never fills in a
 * reference interface or infers a missing relationship.
 *
 * Visibility is kind-only. Domain modes scope the declared relationships, and
 * shared nodes outside the selected domain are boundary nodes rather than
 * inferred in-domain members. DRA/SCP remain proxy nodes; their two edges are
 * never stitched into a synthetic direct link.
 */
import type { ResourceProjection, TopologyEdge } from './topology-types';
import {
  classifyResource,
  isKnownDomainMode,
  isProxyRole,
  normalizeRoleToken,
  topologyDomain,
  KNOWN_TOPOLOGY_DOMAINS,
  type KnownTopologyDomain,
  type TopologyDomain,
  type TopologyDomainMode,
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

export type ActualTopologyBandKind = 'domain' | 'boundary' | 'unclassified' | 'support';

export type ActualTopologyColumn = {
  group: ActualTopologyGroup;
  x: number;
  width: number;
};

export type ActualTopologyBand = {
  kind: ActualTopologyBandKind;
  domain?: TopologyDomain;
  labelKey: string;
  x: number;
  y: number;
  width: number;
  height: number;
  nodeCount: number;
  abnormalCount: number;
  columns: ActualTopologyColumn[];
};

export type ActualTopologyNode = ResourceProjection & {
  resourceClass: TopologyResourceClass;
  group: ActualTopologyGroup;
  band: ActualTopologyBandKind;
  domainBand: TopologyDomain;
  boundary: boolean;
  proxy: boolean;
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
  showBoundary?: boolean;
  domainMode?: TopologyDomainMode;
  /** Optional standalone nodes, for a runtime graph that can exist without edges. */
  resources?: ResourceProjection[];
};

export type ActualTopologyLayout = {
  nodes: ActualTopologyNode[];
  links: ActualTopologyLink[];
  groups: ActualTopologyGroup[];
  bands: ActualTopologyBand[];
  width: number;
  height: number;
  domainMode: TopologyDomainMode;
  selectedDomain: KnownTopologyDomain | null;
  activeLinkCount: number;
  scopedLinkCount: number;
  nfResourceCount: number;
  supportResourceCount: number;
  supportLinkCount: number;
  unresolvedResourceCount: number;
  boundaryNodeCount: number;
  boundaryLinkCount: number;
  hiddenBoundaryNodeCount: number;
  hiddenBoundaryLinkCount: number;
  crossDomainLinkCount: number;
  proxyNodeCount: number;
};

export const ACTUAL_NODE_WIDTH = 164;
export const ACTUAL_NODE_HEIGHT = 60;
export const ACTUAL_GROUP_WIDTH = 196;
export const ACTUAL_CANVAS_PADDING = 28;
export const ACTUAL_BAND_GAP = 20;
/* Content width a band row may occupy before the next band wraps to a new row.
 * Sized so a whole IMS-plus-EPC row fits without splitting a band, while keeping
 * the graph close to the aspect ratio of the canvas. */
export const ACTUAL_BAND_ROW_MAX_WIDTH = 1900;
export const ACTUAL_BAND_HEADER_HEIGHT = 30;
export const ACTUAL_GROUP_HEADER_HEIGHT = 26;
export const ACTUAL_ROW_HEIGHT = 78;
/* Breathing room under the last node row of a band. */
export const ACTUAL_LANE_FOOT = 12;

const NODE_TOP_OFFSET = ACTUAL_BAND_HEADER_HEIGHT + ACTUAL_GROUP_HEADER_HEIGHT + 12;

/* Runtime states that represent a real problem rather than a missing
 * observation. They drive the per-lane abnormal count. */
const ABNORMAL_RUNTIME_STATES = new Set(['stopped', 'unverified', 'permission_denied', 'stale']);

export function isAbnormalRuntimeStatus(status: string | undefined): boolean {
  return Boolean(status) && ABNORMAL_RUNTIME_STATES.has(status as string);
}

export const ACTUAL_DOMAIN_MODE_OPTIONS: ReadonlyArray<{ value: TopologyDomainMode; labelKey: string }> = [
  { value: 'all', labelKey: 'topology_domain_all' },
  { value: '5gc', labelKey: 'topology_domain_5gc' },
  { value: 'epc', labelKey: 'topology_domain_epc' },
  { value: 'ims', labelKey: 'topology_domain_ims' },
  { value: 'charging', labelKey: 'topology_domain_charging' },
  { value: 'cross-domain', labelKey: 'topology_domain_cross' },
];

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

type ResourceRecord = {
  projection: ResourceProjection;
  resourceClass: TopologyResourceClass;
  domain: TopologyDomain;
  proxy: boolean;
};

function isCrossDomainNfEdge(
  edge: TopologyEdge,
  records: ReadonlyMap<string, ResourceRecord>,
): boolean {
  const from = records.get(edge.fromResourceId);
  const to = records.get(edge.toResourceId);
  return Boolean(
    from
    && to
    && from.resourceClass === 'nf'
    && to.resourceClass === 'nf'
    && from.domain !== 'unclassified'
    && to.domain !== 'unclassified'
    && from.domain !== to.domain,
  );
}

function bandForRecord(
  record: ResourceRecord,
  resourceId: string,
  selectedDomain: KnownTopologyDomain | null,
  boundaryIds: ReadonlySet<string>,
): { band: ActualTopologyBandKind; group: ActualTopologyGroup } {
  if (record.resourceClass === 'support') {
    return { band: 'support', group: 'support' };
  }
  const group = groupForResource(record.projection, record.resourceClass);
  if (selectedDomain && boundaryIds.has(resourceId)) {
    return { band: 'boundary', group };
  }
  if (record.resourceClass === 'unresolved' || record.domain === 'unclassified') {
    return { band: 'unclassified', group };
  }
  return { band: 'domain', group };
}

export function buildActualTopology(
  edges: unknown[],
  directory: Record<string, ResourceProjection>,
  options: ActualTopologyBuildOptions = {},
): ActualTopologyLayout {
  const showSupport = options.showSupport === true;
  const showBoundary = options.showBoundary !== false;
  const domainMode = options.domainMode ?? 'all';
  const selectedDomain = isKnownDomainMode(domainMode) ? domainMode : null;
  const activeEdges = edges.filter(isActiveEdge);
  const resourceIds = new Set(activeEdges.flatMap((edge) => [edge.fromResourceId, edge.toResourceId]));
  for (const resource of options.resources ?? []) {
    if (resource.resourceId) resourceIds.add(resource.resourceId);
  }
  const extraResources = new Map((options.resources ?? []).map((resource) => [resource.resourceId, resource]));
  const records = [...resourceIds]
    .map((resourceId) => {
      const projection = directory[resourceId] ?? extraResources.get(resourceId) ?? unresolvedResource(resourceId);
      return {
        projection,
        resourceClass: classifyResource(projection),
        domain: topologyDomain(projection.domain),
        proxy: isProxyRole(projection.role),
      };
    })
    .sort((left, right) => sortResources(left.projection, right.projection));
  const recordById = new Map(records.map((record) => [record.projection.resourceId, record]));

  let scopedEdges: TopologyEdge[] = [];
  let visibleIds = new Set<string>();
  const boundaryIds = new Set<string>();
  const supportIds = new Set<string>();
  const unresolvedIds = new Set<string>();
  let crossDomainLinkCount = 0;
  let boundaryLinkCount = 0;

  if (domainMode === 'cross-domain') {
    scopedEdges = activeEdges.filter((edge) => isCrossDomainNfEdge(edge, recordById));
    visibleIds = new Set(scopedEdges.flatMap((edge) => [edge.fromResourceId, edge.toResourceId]));
    crossDomainLinkCount = scopedEdges.length;
  } else if (selectedDomain) {
    const inDomainNfIds = new Set(records
      .filter((record) => record.resourceClass === 'nf' && record.domain === selectedDomain)
      .map((record) => record.projection.resourceId));
    scopedEdges = activeEdges.filter((edge) => (
      inDomainNfIds.has(edge.fromResourceId) || inDomainNfIds.has(edge.toResourceId)
    ));
    for (const edge of scopedEdges) {
      const from = recordById.get(edge.fromResourceId);
      const to = recordById.get(edge.toResourceId);
      if (inDomainNfIds.has(edge.fromResourceId) && to?.resourceClass === 'nf' && !inDomainNfIds.has(edge.toResourceId)) {
        boundaryIds.add(edge.toResourceId);
      }
      if (inDomainNfIds.has(edge.toResourceId) && from?.resourceClass === 'nf' && !inDomainNfIds.has(edge.fromResourceId)) {
        boundaryIds.add(edge.fromResourceId);
      }
      if (from?.resourceClass === 'support') supportIds.add(edge.fromResourceId);
      if (to?.resourceClass === 'support') supportIds.add(edge.toResourceId);
      if (from?.resourceClass === 'unresolved') unresolvedIds.add(edge.fromResourceId);
      if (to?.resourceClass === 'unresolved') unresolvedIds.add(edge.toResourceId);
    }
    crossDomainLinkCount = scopedEdges.filter((edge) => isCrossDomainNfEdge(edge, recordById)).length;
    boundaryLinkCount = scopedEdges.filter((edge) => (
      boundaryIds.has(edge.fromResourceId) || boundaryIds.has(edge.toResourceId)
    )).length;
    visibleIds = new Set([
      ...inDomainNfIds,
      ...unresolvedIds,
      ...(showSupport ? supportIds : []),
      ...(showBoundary ? boundaryIds : []),
    ]);
  } else {
    scopedEdges = activeEdges;
    for (const record of records) {
      if (record.resourceClass === 'support') supportIds.add(record.projection.resourceId);
      if (record.resourceClass === 'unresolved') unresolvedIds.add(record.projection.resourceId);
    }
    visibleIds = new Set(records
      .filter((record) => record.resourceClass !== 'support' || showSupport)
      .map((record) => record.projection.resourceId));
    crossDomainLinkCount = activeEdges.filter((edge) => isCrossDomainNfEdge(edge, recordById)).length;
  }

  const visibleEdges = scopedEdges.filter((edge) => (
    visibleIds.has(edge.fromResourceId) && visibleIds.has(edge.toResourceId)
  ));
  const visibleRecords = records.filter((record) => visibleIds.has(record.projection.resourceId));
  const supportLinkCount = scopedEdges.filter((edge) => (
    recordById.get(edge.fromResourceId)?.resourceClass === 'support'
    || recordById.get(edge.toResourceId)?.resourceClass === 'support'
  )).length;
  const nfIds = new Set<string>();
  for (const edge of scopedEdges) {
    for (const resourceId of [edge.fromResourceId, edge.toResourceId]) {
      if (recordById.get(resourceId)?.resourceClass === 'nf') nfIds.add(resourceId);
    }
  }

  const bandSpecs: Array<{ kind: ActualTopologyBandKind; domain?: TopologyDomain; labelKey: string }> = selectedDomain
    ? [
      { kind: 'domain', domain: selectedDomain, labelKey: `topology_domain_${selectedDomain}` },
      { kind: 'boundary', labelKey: 'topology_domain_boundary' },
      { kind: 'unclassified', labelKey: 'topology_domain_unclassified' },
      { kind: 'support', labelKey: 'topology_group_support' },
    ]
    : domainMode === 'cross-domain'
      ? KNOWN_TOPOLOGY_DOMAINS.map((domain) => ({
        kind: 'domain' as const,
        domain,
        labelKey: `topology_domain_${domain}`,
      }))
      : [
        ...KNOWN_TOPOLOGY_DOMAINS.map((domain) => ({
          kind: 'domain' as const,
          domain,
          labelKey: `topology_domain_${domain}`,
        })),
        { kind: 'unclassified' as const, labelKey: 'topology_domain_unclassified' },
        { kind: 'support' as const, labelKey: 'topology_group_support' },
      ];

  const drafts: ActualTopologyNode[] = visibleRecords.map((record) => {
    const bandInfo = bandForRecord(record, record.projection.resourceId, selectedDomain, boundaryIds);
    return {
      ...record.projection,
      resourceClass: record.resourceClass,
      group: bandInfo.group,
      band: bandInfo.band,
      domainBand: record.domain,
      boundary: bandInfo.band === 'boundary',
      proxy: record.proxy,
      x: 0,
      y: 0,
      resolved: Boolean(record.projection.name || record.projection.displayName),
    };
  });

  /* Multi-domain modes flow domain bands into horizontal rows that wrap at a
   * bounded content width. Stacking one band per row made a whole-fleet graph
   * several times taller than the canvas, so the readable default fit could only
   * ever show the first band; flowing them keeps the graph roughly as wide as it
   * is tall, which is the shape the canvas actually has. A focused single domain
   * has one band and never wraps. */
  const verticalLanes = selectedDomain === null;
  const draftById = new Map(drafts.map((draft) => [draft.resourceId, draft]));
  const laneKeyOf = (node: ActualTopologyNode) => (
    node.band === 'domain' ? `domain:${node.domainBand}` : node.band
  );
  const crossLaneIds = new Set<string>();
  for (const edge of visibleEdges) {
    const from = draftById.get(edge.fromResourceId);
    const to = draftById.get(edge.toResourceId);
    if (!from || !to) continue;
    if (laneKeyOf(from) !== laneKeyOf(to)) {
      crossLaneIds.add(from.resourceId);
      crossLaneIds.add(to.resourceId);
    }
  }
  const crossLaneFirst = (left: ActualTopologyNode, right: ActualTopologyNode) => (
    Number(crossLaneIds.has(right.resourceId)) - Number(crossLaneIds.has(left.resourceId))
  );

  const bands: ActualTopologyBand[] = [];
  let cursorX = ACTUAL_CANVAS_PADDING;
  let cursorY = ACTUAL_CANVAS_PADDING;
  let rowHeight = 0;
  let widestRow = 0;
  for (const spec of bandSpecs) {
    const bandRecords = drafts.filter((node) => (
      node.band === spec.kind
      && (spec.kind !== 'domain' || node.domainBand === spec.domain)
    ));
    if (bandRecords.length === 0) continue;
    const presentGroups = GROUPS.filter((group) => bandRecords.some((node) => node.group === group));
    const columnLists = presentGroups.map((group) => {
      const nodesInGroup = bandRecords.filter((node) => node.group === group);
      /* Nodes reaching into another lane sit at the lane edge so cross-lane
       * relationships leave the lane without crossing unrelated cards. */
      if (verticalLanes) nodesInGroup.sort(crossLaneFirst);
      return { group, nodes: nodesInGroup };
    });
    const laneRows = columnLists.reduce((max, entry) => Math.max(max, entry.nodes.length), 0);
    const bandWidth = presentGroups.length * ACTUAL_GROUP_WIDTH;
    const bandHeight = NODE_TOP_OFFSET
      + Math.max(0, laneRows - 1) * ACTUAL_ROW_HEIGHT
      + ACTUAL_NODE_HEIGHT
      + ACTUAL_LANE_FOOT;
    if (cursorX > ACTUAL_CANVAS_PADDING
      && cursorX + bandWidth > ACTUAL_CANVAS_PADDING + ACTUAL_BAND_ROW_MAX_WIDTH) {
      widestRow = Math.max(widestRow, cursorX - ACTUAL_BAND_GAP - ACTUAL_CANVAS_PADDING);
      cursorY += rowHeight + ACTUAL_BAND_GAP;
      cursorX = ACTUAL_CANVAS_PADDING;
      rowHeight = 0;
    }
    const band: ActualTopologyBand = {
      kind: spec.kind,
      domain: spec.domain,
      labelKey: spec.labelKey,
      x: cursorX,
      y: cursorY,
      width: bandWidth,
      height: bandHeight,
      nodeCount: bandRecords.length,
      abnormalCount: bandRecords.filter((node) => isAbnormalRuntimeStatus(node.runtimeStatus)).length,
      columns: [],
    };
    let columnX = band.x;
    for (const entry of columnLists) {
      const column: ActualTopologyColumn = { group: entry.group, x: columnX, width: ACTUAL_GROUP_WIDTH };
      columnX += ACTUAL_GROUP_WIDTH;
      band.columns.push(column);
      entry.nodes.forEach((node, rowIndex) => {
        node.x = column.x + (ACTUAL_GROUP_WIDTH - ACTUAL_NODE_WIDTH) / 2;
        node.y = band.y + NODE_TOP_OFFSET + rowIndex * ACTUAL_ROW_HEIGHT;
      });
    }
    bands.push(band);
    rowHeight = Math.max(rowHeight, bandHeight);
    cursorX += bandWidth + ACTUAL_BAND_GAP;
  }
  widestRow = Math.max(widestRow, cursorX - ACTUAL_BAND_GAP - ACTUAL_CANVAS_PADDING);

  const nodes = drafts.filter((node) => node.x > 0 && node.y > 0);
  const groups = GROUPS.filter((group) => nodes.some((node) => node.group === group));
  const width = bands.length === 0
    ? ACTUAL_CANVAS_PADDING * 2 + ACTUAL_GROUP_WIDTH
    : ACTUAL_CANVAS_PADDING * 2 + widestRow;
  const height = bands.length === 0
    ? ACTUAL_CANVAS_PADDING * 2 + NODE_TOP_OFFSET + ACTUAL_NODE_HEIGHT
    : cursorY + rowHeight + ACTUAL_CANVAS_PADDING;

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
    groups,
    bands,
    width,
    height,
    domainMode,
    selectedDomain,
    activeLinkCount: activeEdges.length,
    scopedLinkCount: scopedEdges.length,
    nfResourceCount: nfIds.size,
    supportResourceCount: supportIds.size,
    supportLinkCount,
    unresolvedResourceCount: unresolvedIds.size,
    boundaryNodeCount: boundaryIds.size,
    boundaryLinkCount,
    hiddenBoundaryNodeCount: showBoundary ? 0 : boundaryIds.size,
    hiddenBoundaryLinkCount: showBoundary ? 0 : boundaryLinkCount,
    crossDomainLinkCount,
    proxyNodeCount: nodes.filter((node) => node.proxy).length,
  };
}
