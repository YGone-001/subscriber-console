/**
 * Discovery domain types.
 *
 * Mirrors the vendor-neutral read-only NF observation contract owned by the Go
 * backend. Observed NF registry status is deliberately distinct from operational
 * health and from Inventory lifecycle.
 */

export type DiscoveryAdapterType = 'nrf';
export type DiscoveryTransportMode = 'h2c' | 'h2_tls';
export type DiscoveryRunStatus = 'running' | 'success' | 'partial' | 'failed';
export type DiscoveryObservationState = 'seen' | 'missing' | 'stale';
export type DiscoveryScanTrigger = 'manual' | 'scheduled';

export interface DiscoveryMetaResponse {
  schemaVersion: number;
  adapterTypes: DiscoveryAdapterType[];
  transportModes: DiscoveryTransportMode[];
  runStatuses: DiscoveryRunStatus[];
  observationStates: DiscoveryObservationState[];
  minScanIntervalSeconds: number;
  defaultScanIntervalSeconds: number;
  maxScanIntervalSeconds: number;
  requestTimeoutSeconds: number;
  totalScanDeadlineSeconds: number;
  maxNfProfiles: number;
}

export interface DiscoverySource {
  sourceId: string;
  schemaVersion: number;
  name: string;
  adapterType: DiscoveryAdapterType;
  baseUrl: string;
  enabled: boolean;
  transportMode: DiscoveryTransportMode;
  /** Scheduled scan cadence in seconds. 0 means manual-only. */
  scanIntervalSeconds: number;
  /**
   * Read-only next scan projection (last attempt or creation + interval).
   * Absent for disabled or manual-only sources; never persisted.
   */
  nextScanAt?: string;
  revision: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  lastSuccessAt?: string;
  lastScanAt?: string;
  lastError?: string;
}

export interface DiscoveryRun {
  runId: string;
  schemaVersion: number;
  sourceId: string;
  startedAt: string;
  completedAt?: string;
  status: DiscoveryRunStatus;
  discoveredCount: number;
  createdCount: number;
  updatedCount: number;
  unchangedCount: number;
  missingCount: number;
  errorCode?: string;
  errorSummary?: string;
  /** Execution origin. Runs written before this field existed have no value. */
  trigger?: DiscoveryScanTrigger;
  initiatedBy: string;
}

export interface ObservedEndpoint {
  serviceName?: string;
  scheme?: string;
  addressType?: string;
  address?: string;
  port?: number;
}

export interface ObservedService {
  serviceName: string;
  status?: string;
  apiVersions?: string[];
  endpoints?: ObservedEndpoint[];
}

export interface PlmnID {
  mcc: string;
  mnc: string;
}

export interface SNssai {
  sst: number;
  sd?: string;
}

export interface NfObservation {
  candidateId: string;
  schemaVersion: number;
  sourceId: string;
  adapterType: DiscoveryAdapterType;
  externalNfInstanceId: string;
  nfType: string;
  nfStatus: string;
  fqdn?: string;
  ipv4Addresses?: string[];
  ipv6Addresses?: string[];
  observedEndpoints: ObservedEndpoint[];
  observedServices: ObservedService[];
  heartBeatTimer?: number;
  plmnList?: PlmnID[];
  sNssaiList?: SNssai[];
  firstSeenAt: string;
  lastSeenAt: string;
  observationState: DiscoveryObservationState;
  linkedResourceId: string | null;
  revision: number;
  /**
   * Read-only projection of the candidate-resource-target chain. Response-only
   * (the backend never persists it); absent for unlinked candidates.
   */
  monitoringAssociation?: CandidateMonitoringAssociation;
}

/**
 * Monitoring association states of one candidate.
 *
 *   monitored   - the linked Inventory resource has an NF Health target
 *   unmonitored - the linked resource exists and has no target (absence proven)
 *   unresolved  - the association lookup failed; absence is NOT established
 *
 * An unlinked candidate carries no association summary at all.
 */
export type CandidateMonitoringState = 'monitored' | 'unmonitored' | 'unresolved';

export interface CandidateMonitoringAssociation {
  state: CandidateMonitoringState;
  targetId?: string;
}

export interface PageInfo {
  limit: number;
  nextCursor: string | null;
  hasMore: boolean;
}

export interface ListSourcesResponse {
  sources: DiscoverySource[];
  page: PageInfo;
}

export interface ListRunsResponse {
  runs: DiscoveryRun[];
  page: PageInfo;
}

export interface ListCandidatesResponse {
  candidates: NfObservation[];
  page: PageInfo;
}

export interface CreateDiscoverySourceRequest {
  name: string;
  adapterType: DiscoveryAdapterType;
  baseUrl: string;
  transportMode: DiscoveryTransportMode;
  enabled?: boolean;
  /** Optional server default when omitted; 0 explicitly opts out. */
  scanIntervalSeconds?: number;
}

export interface MutableSourceForm {
  name: string;
  baseUrl: string;
  transportMode: DiscoveryTransportMode;
  enabled: boolean;
  scanIntervalSeconds: number;
}

export interface UpdateDiscoverySourceRequest {
  expectedRevision: number;
  source: MutableSourceForm;
}

export interface LinkCandidateRequest {
  expectedRevision: number;
  resourceId: string;
}

export interface UnlinkCandidateRequest {
  expectedRevision: number;
}

export interface ScanResult {
  run: DiscoveryRun;
}

export interface DiscoverySourceQueryParams {
  q?: string;
  cursor?: string;
  limit?: number;
}

export interface DiscoveryRunQueryParams {
  sourceId?: string;
  status?: DiscoveryRunStatus;
  cursor?: string;
  limit?: number;
}

export interface DiscoveryCandidateQueryParams {
  sourceId?: string;
  nfType?: string;
  nfStatus?: string;
  observationState?: DiscoveryObservationState;
  linkedResourceId?: string;
  cursor?: string;
  limit?: number;
}
