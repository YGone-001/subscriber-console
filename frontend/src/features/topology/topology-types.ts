/*
 * Topology relationship foundation - shared types.
 *
 * Topology owns EDGES only. Every endpoint references an existing Inventory
 * resource UUID; Inventory remains the sole owner of node identity,
 * classification, name and lifecycle.
 *
 * The relationship types are NOT re-declared as a hardcoded authority: the
 * canonical list is served by GET /api/topology/meta and consumed from there.
 * The union below exists only to type the wire values the backend defines.
 */

export type RelationshipType =
  | 'contains'
  | 'runs_on'
  | 'depends_on'
  | 'connects_to'
  | 'routes_to'
  | 'registers_with'
  | 'serves'
  | 'uses'
  | 'exposes';

export type TopologyLifecycleState = 'active' | 'retired';

/** Direction of a single edge relative to a queried root resource. */
export type NeighborDirection = 'inbound' | 'outbound';

/** Direction filter accepted by the one-hop neighbor query. */
export type DirectionFilter = 'inbound' | 'outbound' | 'both';

/** Declared topology state, distinct from any observed operational state. */
export type DeclaredState = 'declared';

export interface SourceMetadata {
  kind: string;
  system: string;
  authority: string;
}

export interface TopologyEdge {
  edgeId: string;
  schemaVersion: number;
  relationshipType: RelationshipType | string;
  fromResourceId: string;
  toResourceId: string;
  description?: string;
  labels?: Record<string, string>;
  attributes?: Record<string, unknown>;
  lifecycleState: TopologyLifecycleState | string;
  source: SourceMetadata;
  revision: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export interface CreateEdgeRequest {
  relationshipType: string;
  fromResourceId: string;
  toResourceId: string;
  description?: string;
  labels?: Record<string, string>;
  attributes?: Record<string, unknown>;
}

export interface MutableEdge {
  description?: string;
  labels?: Record<string, string>;
  attributes?: Record<string, unknown>;
}

export interface UpdateEdgeRequest {
  expectedRevision: number;
  edge: MutableEdge;
}

export interface RetireEdgeRequest {
  expectedRevision: number;
  reason: string;
}

export interface TopologyMetaResponse {
  schemaVersion: number;
  relationshipTypes: string[];
  lifecycleStates: string[];
}

export interface PageInfo {
  limit: number;
  nextCursor: string | null;
  hasMore: boolean;
}

export interface ListEdgesResponse {
  edges: TopologyEdge[];
  page: PageInfo;
}

/** Read-only hydrated Inventory projection returned with neighbor entries. */
export interface ResourceProjection {
  resourceId: string;
  kind: string;
  name: string;
  displayName?: string;
  domain: string;
  role?: string;
  lifecycleState: string;
}

export interface Neighbor {
  edge: TopologyEdge;
  direction: NeighborDirection | string;
  neighborResource: ResourceProjection;
}

export interface NeighborsResponse {
  rootResource: ResourceProjection;
  neighbors: Neighbor[];
  page: PageInfo;
}

export interface EdgeListQueryParams {
  fromResourceId?: string;
  toResourceId?: string;
  relationshipType?: string;
  lifecycleState?: string;
  limit?: number;
  cursor?: string;
}

export interface NeighborQueryParams {
  direction?: DirectionFilter;
  relationshipType?: string;
  lifecycleState?: string;
  limit?: number;
  cursor?: string;
}

/** Presentation metadata for a relationship type. */
export interface RelationshipPresentation {
  /** i18n key for the human-readable label. */
  labelKey: string;
  /** i18n key for the short operator-facing explanation of the direction. */
  hintKey: string;
}

/**
 * Stable, non-authoritative presentation map. The canonical set is still the
 * backend one; an unknown value falls back to the raw identifier.
 */
export const RELATIONSHIP_PRESENTATION: Record<string, RelationshipPresentation> = {
  contains: { labelKey: 'topology_rel_contains', hintKey: 'topology_rel_contains_hint' },
  runs_on: { labelKey: 'topology_rel_runs_on', hintKey: 'topology_rel_runs_on_hint' },
  depends_on: { labelKey: 'topology_rel_depends_on', hintKey: 'topology_rel_depends_on_hint' },
  connects_to: { labelKey: 'topology_rel_connects_to', hintKey: 'topology_rel_connects_to_hint' },
  routes_to: { labelKey: 'topology_rel_routes_to', hintKey: 'topology_rel_routes_to_hint' },
  registers_with: { labelKey: 'topology_rel_registers_with', hintKey: 'topology_rel_registers_with_hint' },
  serves: { labelKey: 'topology_rel_serves', hintKey: 'topology_rel_serves_hint' },
  uses: { labelKey: 'topology_rel_uses', hintKey: 'topology_rel_uses_hint' },
  exposes: { labelKey: 'topology_rel_exposes', hintKey: 'topology_rel_exposes_hint' },
};

/**
 * Presentation-only domain filter buckets. These map onto the existing
 * Inventory `domain` values; they are not new relationship types.
 */
export const DOMAIN_FILTER_BUCKETS: Array<{ key: string; labelKey: string; domains: string[] }> = [
  { key: 'epc', labelKey: 'topology_domain_epc', domains: ['epc'] },
  { key: '5gc', labelKey: 'topology_domain_5gc', domains: ['5gc'] },
  { key: 'ims', labelKey: 'topology_domain_ims', domains: ['ims'] },
  { key: 'ran', labelKey: 'topology_domain_ran', domains: ['ran'] },
  { key: 'shared', labelKey: 'topology_domain_shared', domains: ['shared', 'platform', 'transport', 'cloud', 'charging', 'other'] },
];
