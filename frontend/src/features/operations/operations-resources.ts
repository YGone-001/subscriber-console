/*
 * Operations resource projection client.
 *
 * The server resolves the authoritative join (Inventory identity + NF Health
 * monitoring association for exactly one page of resources). The browser must
 * never assemble that join itself: a target list from an unrelated cursor page
 * cannot establish that a resource is unmonitored.
 *
 * The adapter below maps the projection onto the existing presentation model so
 * the tree, state tokens and counts keep one implementation.
 */
import { getJson } from '../../lib/api/read-client';
import {
  combineCompleteness,
  monitoringFromTarget,
  normalizeDomain,
  type CompletenessReport,
  type DimensionCompleteness,
  type OperationalResource,
  type RuntimeBindingSummary,
} from './operational-model';

export type ResourceAssociation = 'confirmed' | 'absent' | 'unresolved';
export type ResourceCompletenessValue = 'complete' | 'partial' | 'unavailable';

export type ResourceMonitoringDto = {
  targetId: string;
  enabled: boolean;
  nfType?: string;
  overallState?: string;
  statusComplete: boolean;
  coverage?: {
    l1Measured?: boolean;
    l2Measured?: boolean;
    l3Measured?: boolean;
    l3Available?: boolean;
  };
  freshness?: {
    state?: string;
    ageSeconds?: number | null;
    policySeconds?: number;
    reason?: string;
  };
  latestSampleAt?: string;
  lastRunStatus?: string;
  lastRunAt?: string;
  resourceMetrics?: unknown[];
};

export type OperationsResourceDto = {
  resourceId: string;
  name: string;
  displayName?: string;
  domain: string;
  kind: string;
  role?: string;
  lifecycleState: string;
  isNetworkFunction: boolean;
  association: ResourceAssociation;
  monitoring?: ResourceMonitoringDto;
  runtimeBinding?: RuntimeBindingSummary;
};

export type ResourceCompletenessDto = {
  inventory: ResourceCompletenessValue;
  monitoring: ResourceCompletenessValue;
  telemetry: ResourceCompletenessValue;
  overall: ResourceCompletenessValue;
};

export type ResourcePageDto = {
  limit: number;
  hasMore: boolean;
  nextCursor?: string | null;
  /** Present when a predicate was evaluated against the loaded page only. */
  filterScope?: 'page';
  filteredCount?: number;
};

export type OperationsResourcesResponse = {
  generatedAt: string;
  completeness: ResourceCompletenessDto;
  page: ResourcePageDto;
  resources: OperationsResourceDto[];
};

export type OperationsResourceQuery = {
  q?: string;
  domain?: string;
  kind?: string;
  monitoring?: string;
  roles?: string[];
  cursor?: string;
  limit?: number;
};

export const OPERATIONS_RESOURCE_LIMIT = 20;

/** Builds the bounded projection request path. */
export function operationsResourcesPath(query: OperationsResourceQuery = {}): string {
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  if (query.domain) params.set('domain', query.domain);
  if (query.kind) params.set('kind', query.kind);
  if (query.monitoring) params.set('monitoring', query.monitoring);
  if (query.roles?.length) params.set('roles', query.roles.join(','));
  if (query.cursor) params.set('cursor', query.cursor);
  params.set('limit', String(query.limit ?? OPERATIONS_RESOURCE_LIMIT));
  return `/api/operations/resources?${params.toString()}`;
}

export async function fetchOperationsResources(
  query: OperationsResourceQuery = {},
): Promise<OperationsResourcesResponse> {
  return getJson<OperationsResourcesResponse>(operationsResourcesPath(query));
}

/**
 * Maps one projection entry onto the presentation model.
 *
 * The mapping is total: a missing monitoring projection becomes `null` with the
 * server's association state preserved, so `unresolved` can never be rendered as
 * "not monitored".
 */
export function adaptOperationsResource(dto: OperationsResourceDto): OperationalResource {
  const monitoring = dto.monitoring ? monitoringFromTarget(dto.monitoring) : null;
  const nfType = dto.monitoring?.nfType ?? '';
  return {
    resourceId: dto.resourceId,
    name: dto.name || dto.resourceId,
    domain: normalizeDomain(dto.domain),
    kind: dto.kind,
    role: dto.role ?? '',
    nfType,
    typeLabel: nfType || dto.role || '-',
    lifecycleState: dto.lifecycleState,
    retired: dto.lifecycleState === 'retired',
    isNetworkFunction: dto.isNetworkFunction,
    isInstance: dto.kind === 'network_function_instance',
    monitoring,
    association: dto.association,
    runtimeBinding: dto.runtimeBinding,
  };
}

/**
 * Projects the server completeness dimensions onto the presentation report.
 *
 * A failed read is `unavailable` for every dimension it covers; an absent
 * dimension is `partial`, never `complete`. Topology stays owned by its own
 * bounded edge read.
 */
export function adaptCompleteness(
  dto: ResourceCompletenessDto | undefined,
  topology: DimensionCompleteness,
  failed = false,
): CompletenessReport {
  const dimension = (value: ResourceCompletenessValue | undefined): DimensionCompleteness =>
    failed ? 'unavailable' : value ?? 'partial';
  return combineCompleteness({
    inventory: dimension(dto?.inventory),
    monitoring: dimension(dto?.monitoring),
    telemetry: dimension(dto?.telemetry),
    topology,
  });
}

export function adaptOperationsResources(response: OperationsResourcesResponse | undefined): OperationalResource[] {
  return (response?.resources ?? []).map(adaptOperationsResource);
}
