/*
 * Operational view model.
 *
 * Pure, read-only projection that joins the already-authorized xCloud data
 * authorities into the operational surfaces (dashboard overview and the
 * network-element view inside the existing Inventory route).
 *
 * Authority boundaries, never crossed here:
 *   - Inventory owns resourceId, name, domain, kind, role and lifecycle.
 *   - Topology owns declared relationships (used only for `contains` hierarchy).
 *   - Discovery owns observed NRF candidates (association only).
 *   - NF Health owns targets, coverage, layer evidence, freshness and samples.
 *
 * Nothing in this module fabricates a value: absent data becomes an explicit
 * unavailable state, never a zero and never a healthy indicator.
 */

export const OPERATIONAL_DOMAINS = ['epc', '5gc', 'ims', 'charging'] as const;
export type OperationalDomain = (typeof OPERATIONAL_DOMAINS)[number];

/** Canonical lowercase Inventory domain values, plus an honest unknown bucket. */
export type DomainKey = OperationalDomain | 'unknown';

export type UnknownRecord = Record<string, unknown>;

const asRecord = (value: unknown): UnknownRecord =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as UnknownRecord) : {};

const listOf = (value: unknown): UnknownRecord[] => (Array.isArray(value) ? value.map(asRecord) : []);

const str = (value: unknown): string => (typeof value === 'string' ? value : value == null ? '' : String(value));

const num = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
};

const bool = (value: unknown): boolean => value === true;

/** Canonical domain normalization. Never recategorizes charging as EPC or IMS. */
export function normalizeDomain(value: unknown): DomainKey {
  const domain = str(value).trim().toLowerCase();
  return (OPERATIONAL_DOMAINS as readonly string[]).includes(domain) ? (domain as OperationalDomain) : 'unknown';
}

export type LayerView = {
  state: string;
  measured: boolean;
  reason?: string;
};

export type MetricView = {
  key: string;
  value: number;
  unit: string;
  type: string;
  collectedAt: string;
  /** True only when the owning target's freshness is fresh. */
  fresh: boolean;
  /** Cumulative counters are never presented as a rate or a percentage. */
  cumulative: boolean;
};

export type MonitoringView = {
  targetId: string;
  enabled: boolean;
  /** Server-derived overall state; '' when the server could not project it. */
  overallState: string;
  statusComplete: boolean;
  coverage: { l1Measured: boolean; l2Measured: boolean; l3Measured: boolean; l3Available: boolean };
  freshnessState: string;
  freshnessAgeSeconds: number | null;
  freshnessPolicySeconds: number | null;
  freshnessReason: string;
  process: LayerView | null;
  iface: LayerView | null;
  service: LayerView | null;
  latestSampleAt: string;
  lastRunStatus: string;
  lastRunAt: string;
  resourceMetrics: MetricView[];
};

/**
 * Inventory kinds that are themselves network functions. Every other kind is a
 * valid managed resource but never inflates a network-function total.
 */
export const NETWORK_FUNCTION_KINDS = ['network_function', 'network_function_instance'] as const;

/** Association resolution state for one Inventory resource. */
export type AssociationState =
  /** An authoritative lookup succeeded and a monitoring target exists. */
  | 'confirmed'
  /** An authoritative lookup succeeded and no monitoring target exists. */
  | 'absent'
  /** The authoritative lookup did not succeed: absence is NOT established. */
  | 'unresolved';

export type OperationalResource = {
  resourceId: string;
  name: string;
  domain: DomainKey;
  kind: string;
  role: string;
  /** Server-derived NF type when a monitoring target resolved one, else ''. */
  nfType: string;
  /** Display token: the resolved NF type, or the explicit Inventory role. */
  typeLabel: string;
  lifecycleState: string;
  retired: boolean;
  /** True for network_function and network_function_instance only. */
  isNetworkFunction: boolean;
  /** True for network_function_instance only. */
  isInstance: boolean;
  monitoring: MonitoringView | null;
  /** Authoritative association state; never inferred from a cursor page. */
  association: AssociationState;
};

function layerView(value: unknown): LayerView | null {
  const record = asRecord(value);
  if (Object.keys(record).length === 0) return null;
  return {
    state: str(record.state),
    measured: bool(record.measured),
    reason: str(record.reason) || undefined,
  };
}

function metricViews(samples: unknown, fresh: boolean): MetricView[] {
  return listOf(samples).map((sample) => {
    const type = str(sample.type);
    return {
      key: str(sample.key),
      value: num(sample.value) ?? 0,
      unit: str(sample.unit),
      type,
      collectedAt: str(sample.collectedAt),
      fresh,
      cumulative: type === 'counter',
    };
  });
}

/** Builds the monitoring projection for one NF Health target summary. */
export function monitoringFromTarget(target: unknown): MonitoringView {
  const record = asRecord(target);
  const coverage = asRecord(record.coverage);
  const freshness = asRecord(record.freshness);
  const layers = asRecord(record.layers);
  const freshnessState = str(freshness.state);
  const fresh = freshnessState === 'fresh';
  return {
    targetId: str(record.targetId),
    enabled: record.enabled !== false,
    overallState: str(record.overallState),
    statusComplete: bool(record.statusComplete),
    coverage: {
      l1Measured: bool(coverage.l1Measured),
      l2Measured: bool(coverage.l2Measured),
      l3Measured: bool(coverage.l3Measured),
      l3Available: bool(coverage.l3Available),
    },
    freshnessState,
    freshnessAgeSeconds: num(freshness.ageSeconds),
    freshnessPolicySeconds: num(freshness.policySeconds),
    freshnessReason: str(freshness.reason),
    process: layerView(layers.process),
    iface: layerView(layers.interface),
    service: layerView(layers.service),
    latestSampleAt: str(record.latestSampleAt),
    lastRunStatus: str(record.lastRunStatus),
    lastRunAt: str(record.lastRunAt),
    resourceMetrics: metricViews(record.resourceMetrics, fresh),
  };
}

/**
 * Joins Inventory resources with NF Health targets by canonical resourceId.
 *
 * `associationResolved` states whether the authoritative association lookup for
 * exactly these resources succeeded:
 *   - true  -> a resource without a returned target is a *confirmed* absence;
 *   - false -> every association is *unresolved*, because absence was never
 *              established. An unresolved association is never reported as
 *              unmonitored.
 *
 * The caller must pass the targets resolved for the same resource identifiers it
 * passes here; a target list from an unrelated cursor page can never establish
 * absence.
 */
export function buildOperationalResources(
  resources: unknown,
  targets: unknown,
  associationResolved = false,
): { items: OperationalResource[]; duplicateTargetResources: string[] } {
  const byResource = new Map<string, MonitoringView>();
  const duplicates = new Set<string>();
  for (const target of listOf(targets)) {
    const resourceId = str(target.resourceId);
    if (!resourceId) continue;
    const view = monitoringFromTarget(target);
    const existing = byResource.get(resourceId);
    if (!existing) {
      byResource.set(resourceId, view);
      continue;
    }
    duplicates.add(resourceId);
    if (!existing.enabled && view.enabled) {
      byResource.set(resourceId, view);
    }
  }

  const items = listOf(resources).map((resource) => {
    const resourceId = str(resource._id ?? resource.resourceId);
    const monitoring = byResource.get(resourceId) ?? null;
    const lifecycleState = str(resource.lifecycleState);
    const kind = str(resource.kind);
    const role = str(resource.role);
    const association: AssociationState = monitoring
      ? 'confirmed'
      : associationResolved
        ? 'absent'
        : 'unresolved';
    return {
      resourceId,
      name: str(resource.name) || resourceId,
      domain: normalizeDomain(resource.domain),
      kind,
      role,
      // The NF type is server-derived and applied by applyResolvedNFTypes from
      // the monitoring target; the UI never infers it from a process name.
      nfType: '',
      typeLabel: role || '-',
      lifecycleState,
      retired: lifecycleState === 'retired',
      isNetworkFunction: (NETWORK_FUNCTION_KINDS as readonly string[]).includes(kind),
      isInstance: kind === 'network_function_instance',
      monitoring,
      association,
    } satisfies OperationalResource;
  });

  return { items, duplicateTargetResources: Array.from(duplicates) };
}

/** Applies the server-derived NF type from a target onto its resource entry. */
export function applyResolvedNFTypes(items: OperationalResource[], targets: unknown): OperationalResource[] {
  const nfTypes = new Map<string, string>();
  for (const target of listOf(targets)) {
    const resourceId = str(target.resourceId);
    const nfType = str(target.nfType);
    if (resourceId && nfType) nfTypes.set(resourceId, nfType);
  }
  return items.map((item) => {
    const nfType = nfTypes.get(item.resourceId) ?? '';
    return { ...item, nfType, typeLabel: nfType || item.role || '-' };
  });
}

export type OperationalCounts = {
  /** Non-retired network-function resources (logical + instance). */
  registered: number;
  /** Of which logical network_function resources. */
  logicalFunctions: number;
  /** Of which network_function_instance resources. */
  instances: number;
  /** Non-retired managed resources that are not network functions. */
  nonNfResources: number;
  /** Resources with a confirmed monitoring association. */
  monitored: number;
  /** Resources where an authoritative lookup confirmed no association. */
  unmonitored: number;
  /** Resources whose association could not be resolved (never "unmonitored"). */
  unresolved: number;
  fresh: number;
  stale: number;
  unknown: number;
  degraded: number;
  unhealthy: number;
  healthy: number;
  notMonitored: number;
  /** Monitored resources whose freshness could not be projected. */
  freshnessUnknown: number;
  disabledTargets: number;
  failedLastRun: number;
  legacyUnresolved: number;
  /** Monitored resources whose latest-evidence projection failed. */
  telemetryUnavailable: number;
};

/** Completeness of one independent data source. */
export type DimensionCompleteness = 'complete' | 'partial' | 'unavailable';

/**
 * Completeness is reported per source. A single boolean cannot represent several
 * independently incomplete sources, and a partial page must never be presented
 * as an authoritative platform total.
 */
export type CompletenessReport = {
  /** All resources of the queried population are loaded. */
  inventory: DimensionCompleteness;
  /** Every visible resource has an authoritative association result. */
  monitoring: DimensionCompleteness;
  /** Every associated target has a successful latest-evidence projection. */
  telemetry: DimensionCompleteness;
  /** Every relationship needed for the claimed hierarchy was evaluated. */
  topology: DimensionCompleteness;
  /** Complete only when every required dimension is complete. */
  overall: DimensionCompleteness;
};

export function combineCompleteness(report: Omit<CompletenessReport, 'overall'>): CompletenessReport {
  const dimensions = [report.inventory, report.monitoring, report.telemetry, report.topology];
  const overall: DimensionCompleteness = dimensions.includes('unavailable')
    ? 'unavailable'
    : dimensions.includes('partial')
      ? 'partial'
      : 'complete';
  return { ...report, overall };
}

export type OperationalSummary = OperationalCounts & {
  completeness: CompletenessReport;
  /** Explicit denominator documentation for every ratio a caller may render. */
  denominators: {
    population: string;
    monitoring: string;
    freshness: string;
  };
};

/**
 * Summarizes one loaded page of resources.
 *
 * Denominators are explicit:
 *   - population: registered, non-retired network-function resources on the page
 *     (network_function + network_function_instance); other Inventory kinds are
 *     reported separately and never inflate the NF total.
 *   - monitoring: network functions with a confirmed monitoring association;
 *     unresolved associations are counted separately and are never reported as
 *     unmonitored.
 *   - freshness: monitored network functions whose latest evidence was read.
 * Retired resources are excluded from operational counts.
 */
export function summarizeOperational(
  items: OperationalResource[],
  completeness: CompletenessReport,
): OperationalSummary {
  const counts: OperationalCounts = {
    registered: 0,
    logicalFunctions: 0,
    instances: 0,
    nonNfResources: 0,
    monitored: 0,
    unmonitored: 0,
    unresolved: 0,
    fresh: 0,
    stale: 0,
    unknown: 0,
    degraded: 0,
    unhealthy: 0,
    healthy: 0,
    notMonitored: 0,
    freshnessUnknown: 0,
    disabledTargets: 0,
    failedLastRun: 0,
    legacyUnresolved: 0,
    telemetryUnavailable: 0,
  };

  for (const item of items) {
    if (item.retired) continue;
    if (!item.isNetworkFunction) {
      counts.nonNfResources += 1;
      continue;
    }
    counts.registered += 1;
    if (item.isInstance) {
      counts.instances += 1;
    } else {
      counts.logicalFunctions += 1;
    }

    const monitoring = item.monitoring;
    if (item.association === 'unresolved') {
      counts.unresolved += 1;
      continue;
    }
    if (item.association === 'absent' || !monitoring) {
      counts.unmonitored += 1;
      counts.notMonitored += 1;
      continue;
    }

    counts.monitored += 1;
    if (!monitoring.enabled) counts.disabledTargets += 1;
    if (monitoring.lastRunStatus === 'failed') counts.failedLastRun += 1;
    if (item.lifecycleState === 'legacy_unresolved') counts.legacyUnresolved += 1;
    if (!monitoring.statusComplete) counts.telemetryUnavailable += 1;

    switch (monitoring.freshnessState) {
      case 'fresh':
        counts.fresh += 1;
        break;
      case 'stale':
        counts.stale += 1;
        break;
      case 'not_monitored':
        counts.notMonitored += 1;
        break;
      default:
        counts.freshnessUnknown += 1;
    }

    // Overall-state buckets are orthogonal to the freshness buckets above: a
    // resource is counted once per dimension, so a fresh measurement with an
    // undetermined service outcome is fresh AND unknown, never healthy.
    switch (monitoring.overallState) {
      case 'healthy':
        counts.healthy += 1;
        break;
      case 'degraded':
        counts.degraded += 1;
        break;
      case 'unhealthy':
        counts.unhealthy += 1;
        break;
      default:
        // unknown, stale, not_configured and an unprojected state are all
        // "no positive claim".
        counts.unknown += 1;
    }
  }

  return {
    ...counts,
    completeness,
    denominators: {
      population: 'registered non-retired network-function resources on the loaded page',
      monitoring: 'network functions with a confirmed monitoring association',
      freshness: 'monitored network functions whose latest evidence was read',
    },
  };
}

export type DomainGroupView = {
  domain: DomainKey;
  resources: OperationalResource[];
  counts: OperationalSummary;
};

/** Groups resources by canonical Inventory domain (presentation grouping only). */
export function groupByDomain(items: OperationalResource[], completeness: CompletenessReport): DomainGroupView[] {
  const groups = new Map<DomainKey, OperationalResource[]>();
  for (const item of items) {
    const bucket = groups.get(item.domain) ?? [];
    bucket.push(item);
    groups.set(item.domain, bucket);
  }
  const ordered: DomainKey[] = [...OPERATIONAL_DOMAINS, 'unknown'];
  return ordered
    .filter((domain) => groups.has(domain))
    .map((domain) => ({
      domain,
      resources: groups.get(domain) ?? [],
      counts: summarizeOperational(groups.get(domain) ?? [], completeness),
    }));
}

/**
 * Presentation token for one resource.
 *
 * `unresolved` is never collapsed into `not_monitored`, and a resource without a
 * monitoring target is never reported as healthy. An unprojected overall state
 * becomes `unknown`, never a positive claim.
 */
export function operationalStateToken(item: OperationalResource): string {
  if (item.association === 'unresolved') return 'unresolved';
  if (!item.monitoring) return 'not_monitored';
  return item.monitoring.overallState || 'unknown';
}

/** Compact per-layer coverage label. Measured is not healthy. */
export function layerLabel(coverage: { l1Measured: boolean; l2Measured: boolean; l3Measured: boolean }, layer: 'l1' | 'l2' | 'l3'): string {
  if (layer === 'l1') return coverage.l1Measured ? 'measured' : 'not_configured';
  if (layer === 'l2') return coverage.l2Measured ? 'measured' : 'not_configured';
  return coverage.l3Measured ? 'measured' : 'not_configured';
}

/** Resource-category metric lookup with correct measurement semantics. */
export function resourceMetric(monitoring: MonitoringView | null, key: string): MetricView | null {
  if (!monitoring) return null;
  return monitoring.resourceMetrics.find((metric) => metric.key === key) ?? null;
}

/**
 * CPU presentation.
 *
 * `process_cpu_seconds_total` is a cumulative CPU-time counter. It is never
 * converted into a utilization percentage: no verified interval calculation is
 * available in this build, so callers render it as cumulative seconds.
 */
export function cpuView(monitoring: MonitoringView | null): MetricView | null {
  return resourceMetric(monitoring, 'process_cpu_seconds_total');
}

/** Resident memory presentation (bytes). Never mixed with virtual memory. */
export function memoryView(monitoring: MonitoringView | null): MetricView | null {
  return resourceMetric(monitoring, 'process_resident_memory_bytes');
}

/** Topology relationship coverage for the hierarchy that is being rendered. */
export type TopologyCoverage = 'complete' | 'partial' | 'unavailable';

/**
 * How the rendered hierarchy was derived. The three virtual modes are distinct
 * because they carry different certainty: only `virtual_no_containment` may
 * state that no declared containment exists.
 */
export type TreeMode =
  | 'declared'
  | 'virtual_no_containment'
  | 'virtual_partial'
  | 'virtual_unavailable';

export type TreeNode = {
  id: string;
  label: string;
  kind: string;
  domain: DomainKey;
  resourceId: string | null;
  children: TreeNode[];
  /** True when this node exists only because of the presentation grouping. */
  virtual: boolean;
};

/**
 * Builds the hierarchy from Inventory resources and declared Topology
 * `contains` edges.
 *
 * Rules:
 *   - membership uses canonical resourceId only; process names are never tree ids
 *   - only `contains` edges define containment (`depends_on` / `connects_to` are
 *     ignored for hierarchy)
 *   - retired edges and edges to retired resources are ignored
 *   - cycles are broken defensively (a node is attached once)
 *   - resources without a parent remain visible as roots, never dropped
 *   - when no `contains` edge exists, a clearly labelled virtual domain grouping
 *     is returned instead of a fabricated location tree
 */
export function buildResourceTree(
  items: OperationalResource[],
  edges: unknown,
  topology: TopologyCoverage = 'complete',
): { nodes: TreeNode[]; mode: TreeMode } {
  const byId = new Map(items.map((item) => [item.resourceId, item]));
  const childrenOf = new Map<string, string[]>();
  let containsCount = 0;

  for (const edge of listOf(edges)) {
    const relation = str(edge.relationshipType ?? edge.relation ?? edge.edgeType ?? edge.type).toLowerCase();
    if (relation !== 'contains') continue;
    if (str(edge.lifecycleState) === 'retired') continue;
    const parent = str(edge.fromResourceId ?? edge.parentResourceId ?? edge.from);
    const child = str(edge.toResourceId ?? edge.childResourceId ?? edge.to);
    if (!parent || !child || parent === child) continue;
    if (!byId.has(parent) || !byId.has(child)) continue;
    containsCount += 1;
    const bucket = childrenOf.get(parent) ?? [];
    if (!bucket.includes(child)) bucket.push(child);
    childrenOf.set(parent, bucket);
  }

  if (containsCount === 0) {
    // Absence of containment may only be claimed when the edge read completed.
    const mode: TreeMode =
      topology === 'unavailable'
        ? 'virtual_unavailable'
        : topology === 'partial'
          ? 'virtual_partial'
          : 'virtual_no_containment';
    return { nodes: virtualDomainNodes(items), mode };
  }

  const childIds = new Set<string>();
  for (const bucket of childrenOf.values()) {
    for (const child of bucket) childIds.add(child);
  }

  const attached = new Set<string>();
  const build = (resourceId: string, path: Set<string>): TreeNode | null => {
    if (attached.has(resourceId) || path.has(resourceId)) return null;
    const resource = byId.get(resourceId);
    if (!resource) return null;
    attached.add(resourceId);
    const nextPath = new Set(path);
    nextPath.add(resourceId);
    const children: TreeNode[] = [];
    for (const childId of childrenOf.get(resourceId) ?? []) {
      const child = build(childId, nextPath);
      if (child) children.push(child);
    }
    return {
      id: resource.resourceId,
      label: resource.name,
      kind: resource.kind,
      domain: resource.domain,
      resourceId: resource.resourceId,
      children,
      virtual: false,
    };
  };

  const nodes: TreeNode[] = [];
  for (const item of items) {
    if (childIds.has(item.resourceId)) continue;
    const node = build(item.resourceId, new Set());
    if (node) nodes.push(node);
  }
  // Orphans (for example a child whose parent is retired) stay visible.
  for (const item of items) {
    if (attached.has(item.resourceId)) continue;
    const node = build(item.resourceId, new Set());
    if (node) nodes.push(node);
  }
  return { nodes, mode: 'declared' };
}

function virtualDomainNodes(items: OperationalResource[]): TreeNode[] {
  // The virtual grouping carries no data claim of its own, so the grouping
  // counts are computed against a complete report and only the mode label
  // communicates the certainty of the underlying relationship read.
  const neutral = combineCompleteness({
    inventory: 'complete',
    monitoring: 'complete',
    telemetry: 'complete',
    topology: 'complete',
  });
  return groupByDomain(items, neutral).map((group) => ({
    id: `virtual:${group.domain}`,
    label: group.domain,
    kind: 'domain_group',
    domain: group.domain,
    resourceId: null,
    virtual: true,
    children: group.resources.map((resource) => ({
      id: resource.resourceId,
      label: resource.name,
      kind: resource.kind,
      domain: resource.domain,
      resourceId: resource.resourceId,
      children: [],
      virtual: false,
    })),
  }));
}

/** True when the node (or any descendant) matches the predicate. */
export function treeMatches(node: TreeNode, predicate: (node: TreeNode) => boolean): boolean {
  if (predicate(node)) return true;
  return node.children.some((child) => treeMatches(child, predicate));
}

/** Collects the resource ids of a subtree, so selection filters the table. */
export function treeResourceIds(node: TreeNode): string[] {
  const ids: string[] = [];
  if (node.resourceId) ids.push(node.resourceId);
  for (const child of node.children) ids.push(...treeResourceIds(child));
  return ids;
}

/** Bounded byte formatting for memory telemetry. */
export function formatBytes(value: number): string {
  if (!Number.isFinite(value)) return '-';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let index = 0;
  let scaled = Math.abs(value);
  while (scaled >= 1024 && index < units.length - 1) {
    scaled /= 1024;
    index += 1;
  }
  const sign = value < 0 ? '-' : '';
  return `${sign}${scaled.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}
