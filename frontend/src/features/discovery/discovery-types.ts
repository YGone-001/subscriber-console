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

export interface DiscoveryMetaResponse {
  schemaVersion: number;
  adapterTypes: DiscoveryAdapterType[];
  transportModes: DiscoveryTransportMode[];
  runStatuses: DiscoveryRunStatus[];
  observationStates: DiscoveryObservationState[];
  minScanIntervalSeconds: number;
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
}

export interface MutableSourceForm {
  name: string;
  baseUrl: string;
  transportMode: DiscoveryTransportMode;
  enabled: boolean;
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
