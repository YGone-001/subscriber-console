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

export interface MetricSample {
  key: string;
  value: number;
  unit: string;
  type: 'counter' | 'gauge';
  source: string;
  collectedAt: string;
  interpretation?: string;
  labels?: Record<string, string>;
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

export interface HealthTarget {
  targetId: string;
  schemaVersion: number;
  candidateId: string;
  name: string;
  collectorProfile: string;
  metricsEndpoint?: string;
  serviceUnit?: string;
  serviceKind: ServiceKind;
  collectionMode: CollectionMode;
  intervalSeconds: number;
  enabled: boolean;
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
}

export interface HealthRun {
  runId: string;
  schemaVersion: number;
  targetId: string;
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
  candidateId?: string;
  collectedAt: string;
  expiresAt?: string;
  layers: LayerSet;
  metrics: MetricSample[];
}

export interface MetricDefinition {
  name: string;
  nfTypes: string[];
  type: 'counter' | 'gauge';
  unit: string;
  description: string;
  safeLabels: string[];
  interpretation: string;
}

export interface NfHealthMeta {
  schemaVersion: number;
  collectorProfiles: string[];
  collectionModes: CollectionMode[];
  runStatuses: RunStatus[];
  layerStates: LayerState[];
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
  retentionDays: number;
  maxRetentionDays: number;
  supportedMetrics: MetricDefinition[];
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
  candidateId: string;
  name: string;
  collectorProfile: string;
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
