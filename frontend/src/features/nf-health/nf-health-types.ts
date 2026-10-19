export type LayerState =
  | 'healthy'
  | 'degraded'
  | 'unhealthy'
  | 'unknown'
  | 'not_configured'
  | 'stale';

export type EvidenceKind = 'systemd' | 'process' | 'http_metrics' | 'metric_registry' | 'none';

export type CollectionMode = 'manual' | 'scheduled';

export type RunStatus = 'success' | 'partial' | 'failed';

export type ServiceKind = 'systemd' | 'process' | 'none';

export type CollectorProfile = 'http_metrics' | 'process_only';

export type TargetIdentityState = 'inventory_authoritative' | 'legacy_unbound' | 'legacy_unresolved';

export interface LayerEvidence {
  state: LayerState;
  evidenceKind: EvidenceKind;
  reason?: string;
  httpStatus?: number;
  responseMs?: number;
  processOutcome?: string;
  mainPid?: number;
  measured: boolean;
}

export type MetricCategory = 'resource' | 'service';

export type MetricEvidenceClass =
  | 'live_verified'
  | 'source_verified'
  | 'fixture_tested'
  | 'not_verified'
  | 'not_exported';

export type MetricHealthRule =
  | 'none'
  | 'failure_counter_zero'
  | 'success_ratio_pair'
  | 'activity_gauge';

export interface MetricSample {
  key: string;
  value: number;
  unit: string;
  type: 'counter' | 'gauge';
  source: string;
  collectedAt: string;
  interpretation?: string;
  labels?: Record<string, string>;
  // Category is additive: samples stored before it existed decode as undefined
  // and are presented as resource evidence, never as a service-health claim.
  category?: MetricCategory;
}

export interface LayerSet {
  process: LayerEvidence;
  interface: LayerEvidence;
  service: LayerEvidence;
}

export interface CoverageSummary {
  l1Measured: boolean;
  l2Measured: boolean;
  l3Measured: boolean;
  l3Available: boolean;
}

export type FreshnessState = 'fresh' | 'stale' | 'unknown' | 'not_monitored';

export interface FreshnessProjection {
  state: FreshnessState;
  ageSeconds?: number;
  policySeconds: number;
  basis: string;
  evaluatedAt: string;
  reason?: string;
}

export interface HealthTarget {
  targetId: string;
  schemaVersion: number;
  resourceId?: string;
  candidateId?: string;
  name: string;
  collectorProfile: CollectorProfile;
  metricsEndpoint?: string;
  serviceUnit?: string;
  serviceKind: ServiceKind;
  collectionMode: CollectionMode;
  intervalSeconds: number;
  enabled: boolean;
  domain?: string;
  nfType?: string;
  identityState?: TargetIdentityState;
  revision: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastMeasuredAt?: string;
  lastError?: string;
}

export interface HealthTargetSummary extends HealthTarget {
  coverage: CoverageSummary;
  freshness: FreshnessProjection;
  // Server-derived projection of the latest accepted measurement. overallState
  // is the same value the detail endpoint reports; a target without evidence
  // reports "unknown" rather than an implied healthy.
  overallState?: string;
  statusComplete?: boolean;
  layers?: LayerSet;
  lastRunStatus?: RunStatus;
  lastRunAt?: string;
}

export interface HealthRun {
  runId: string;
  schemaVersion: number;
  targetId: string;
  resourceId?: string;
  candidateId?: string;
  startedAt: string;
  completedAt?: string;
  status: RunStatus;
  sampleId?: string;
  layersMeasured: number;
  errorCode?: string;
  errorSummary?: string;
  initiatedBy: string;
}

export interface HealthSample {
  sampleId: string;
  schemaVersion: number;
  targetId: string;
  runId: string;
  resourceId?: string;
  candidateId?: string;
  collectedAt: string;
  expiresAt?: string;
  layers: LayerSet;
  metrics: MetricSample[];
}

export interface MetricDefinition {
  name: string;
  domain: string;
  nfTypes: string[];
  category: MetricCategory;
  type: 'counter' | 'gauge';
  unit: string;
  description: string;
  safeLabels: string[];
  interpretation: string;
  source: string;
  evidence: MetricEvidenceClass;
  healthRule: MetricHealthRule;
  healthPair?: string;
  nonNegative: boolean;
}

export interface NfHealthMeta {
  schemaVersion: number;
  collectorProfiles: string[];
  collectionModes: CollectionMode[];
  runStatuses: RunStatus[];
  layerStates: LayerState[];
  freshnessStates?: FreshnessState[];
  evidenceKinds: EvidenceKind[];
  processOutcomes: string[];
  interfaceOutcomes: string[];
  serviceKinds: ServiceKind[];
  minIntervalSeconds: number;
  maxIntervalSeconds: number;
  defaultIntervalSeconds: number;
  requestTimeoutSeconds: number;
  totalDeadlineSeconds: number;
  maxGlobalConcurrent: number;
  stalenessGraceSeconds?: number;
  manualFreshnessWindowSeconds?: number;
  retentionDays: number;
  maxRetentionDays: number;
  supportedMetrics: MetricDefinition[];
  metricCategories?: MetricCategory[];
  metricEvidenceClasses?: MetricEvidenceClass[];
  serviceReasons?: string[];
  allowedDestinations: string[];
  allowedServiceUnits: string[];
}

export interface PageInfo {
  limit: number;
  nextCursor?: string | null;
  hasMore: boolean;
}

export interface ListTargetsResponse {
  targets: HealthTargetSummary[];
  page: PageInfo;
}

export interface GetTargetResponse {
  target: HealthTargetSummary;
  latestSample?: HealthSample;
  lastRun?: HealthRun;
  overallState: LayerState;
  freshness: FreshnessProjection;
}

export interface ListSamplesResponse {
  samples: HealthSample[];
  page: PageInfo;
}

export interface ListRunsResponse {
  runs: HealthRun[];
  page: PageInfo;
}

export interface CollectResult {
  run: HealthRun;
  sample: HealthSample | null;
}

export interface CreateNfHealthTargetRequest {
  resourceId?: string;
  candidateId?: string;
  name: string;
  collectorProfile: CollectorProfile;
  metricsEndpoint?: string;
  serviceUnit?: string;
  serviceKind: ServiceKind;
  collectionMode: CollectionMode;
  intervalSeconds: number;
  enabled?: boolean;
}

export interface UpdateNfHealthTargetRequest {
  expectedRevision: number;
  target: {
    name: string;
    metricsEndpoint?: string;
    serviceUnit?: string;
    serviceKind: ServiceKind;
    collectionMode: CollectionMode;
    intervalSeconds: number;
    enabled: boolean;
  };
}

export interface NfHealthTargetQueryParams {
  q?: string;
  enabled?: string;
  /* Exact domain predicate (epc, 5gc, ims, charging). */
  domain?: string;
  /* Canonical overall state predicate, read from the server projection. */
  state?: string;
  /* Comma-separated layer coverage requirement (l1, l2, l3). */
  layers?: string;
  /* "risk" orders the duty queue, "updated" keeps recency order. */
  sort?: string;
  cursor?: string;
  limit?: number;
}

export interface NfHealthSampleQueryParams {
  targetId?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}

export interface NfHealthRunQueryParams {
  targetId?: string;
  status?: string;
  cursor?: string;
  limit?: number;
}
