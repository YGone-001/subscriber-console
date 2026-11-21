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
  scopeVerified?: boolean;
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

/* Interface probe vocabulary. The server owns the list; the UI renders it. */
export type ProbeFamily = 'metrics' | 'sbi' | 'oam' | 'health';

export interface InterfaceProbe {
  family: ProbeFamily;
  url: string;
}

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
  probes?: InterfaceProbe[];
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
  serviceWindows?: ServiceWindowReport;
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
  metricHistory?: {enabled: boolean; state: string; lastAttemptAt?: string; lastSuccessAt?: string; failures: number};
  businessRulesVersion?: string;
  businessRules?: BusinessRuleDefinition[];
  serviceWindowVersion?: string;
  serviceWindowMode?: 'observation_only';
  collectorProfileTransitions?: boolean;
  processSnapshotConfigured?: boolean;
  schemaVersion: number;
  collectorProfiles: string[];
  collectionModes: CollectionMode[];
  runStatuses: RunStatus[];
  layerStates: LayerState[];
  freshnessStates?: FreshnessState[];
  evidenceKinds: EvidenceKind[];
  processOutcomes: string[];
  interfaceOutcomes: string[];
  probeFamilies?: ProbeFamily[];
  maxInterfaceProbes?: number;
  serviceKinds: ServiceKind[];
  minIntervalSeconds: number;
  maxIntervalSeconds: number;
  defaultIntervalSeconds: number;
  requestTimeoutSeconds: number;
  totalDeadlineSeconds: number;
  maxGlobalConcurrent: number;
  maxLocalConcurrent?: number;
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

export interface InterfaceCell {
  state: LayerState;
  reason?: string;
  httpStatus?: number;
  responseMs?: number;
  measuredAt?: string;
}

export interface InterfaceMatrixRow {
  targetId: string;
  resourceId?: string;
  name: string;
  nfType?: string;
  domain?: string;
  overallState: string;
  freshness: FreshnessState;
  lastMeasuredAt?: string;
  cells: Record<string, InterfaceCell>;
}

export interface InterfaceMatrixResponse {
  generatedAt: string;
  columns: ProbeFamily[];
  rows: InterfaceMatrixRow[];
  page: PageInfo;
}

export interface NfHealthInterfaceQueryParams {
  q?: string;
  domain?: string;
  /* Comma-separated measurement freshness states (fresh, stale, unknown, not_monitored). */
  freshness?: string;
  /* Latest collection attempt outcome: "failed" or "succeeded". */
  collection?: string;
  sort?: string;
  cursor?: string;
  limit?: number;
}

export interface ListTargetsResponse {
  targets: HealthTargetSummary[];
  page: PageInfo;
}

export interface GetTargetResponse {
  thresholdPreview?: { value: number | null; reason: string; durationEligible?: boolean; durationReason?: string; maxGapSeconds?: number };
  target: HealthTargetSummary;
  latestSample?: HealthSample;
  lastRun?: HealthRun;
  overallState: LayerState;
  freshness: FreshnessProjection;
  serviceWindows?: ServiceWindowReport;
}

export interface WindowInterval {
  fromSampleId: string;
  toSampleId: string;
  from: string;
  to: string;
  seconds: number;
  delta: number | null;
  reason?: string;
}

export interface ServiceWindowRow {
  metric: string;
  scope: string;
  type: 'counter' | 'gauge';
  unit: string;
  quality: 'ready' | 'insufficient' | 'unavailable' | 'stale';
  reason: string;
  points: number;
  intervals: number;
  coveredSeconds: number;
  coveragePercent: number;
  delta: number | null;
  rate: number | null;
  latestValue: number | null;
  excluded: Record<string, number>;
  evidence: WindowInterval[];
  pairMetric?: string;
  pairDelta?: number;
  completionRatioPercent?: number;
  pairReason?: string;
  businessJudgement: 'not_evaluated';
}

export interface ServiceWindowReport {
  version: string;
  rulesVersion?: string;
  mode: 'observation_only';
  evaluatedAt: string;
  complete: boolean;
  reason?: string;
  windows: {
    seconds: number;
    from: string;
    to: string;
    freshnessSeconds: number;
    maxGapSeconds: number;
    rows: ServiceWindowRow[];
    businessRules?: BusinessRuleObservation[];
  }[];
}

export interface BusinessRuleDefinition {
  ruleId: string;
  version: string;
  nfType: string;
  domain: string;
  kind: 'request_completion' | 'activity' | 'reconciliation';
  metrics: string[];
  minimumRequests?: number;
  semantics: string;
  sourceReview: 'source_reviewed' | 'registry_documented';
  binaryAttestation: 'not_attested';
  references: { path: string; line: number }[];
  missingSignals: string[];
}

export interface BusinessRuleObservation extends BusinessRuleDefinition {
  scope: string;
  status: string;
  reason: string;
  quality: string;
  coveragePercent: number;
  validPoints: number;
  validIntervals: number;
  missingMetrics: string[];
  observed: { metric: string; latestValue: number | null; delta: number | null; rate: number | null; quality: string; reason: string }[];
  requestDelta: number | null;
  completionDelta: number | null;
  difference: number | null;
  completionRatioPercent: number | null;
  decisionEligible: boolean;
  healthEffect: 'none';
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
  probes?: InterfaceProbe[];
  serviceUnit?: string;
  serviceKind: ServiceKind;
  collectionMode: CollectionMode;
  intervalSeconds: number;
  enabled?: boolean;
}

export interface UpdateNfHealthTargetRequest {
  expectedRevision: number;
  target: {
    collectorProfile?: CollectorProfile;
    name: string;
    metricsEndpoint?: string;
    probes?: InterfaceProbe[];
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
  /* Comma-separated measurement freshness states (fresh, stale, unknown, not_monitored). */
  freshness?: string;
  /* Latest collection attempt outcome: "failed" or "succeeded". */
  collection?: string;
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
