import { getJson } from '../../lib/api/read-client';
import { postJson, putJson } from '../../lib/api/mutation-client';
import type {
  CreateDiscoverySourceRequest,
  DiscoveryCandidateQueryParams,
  DiscoveryMetaResponse,
  DiscoveryRun,
  DiscoveryRunQueryParams,
  DiscoverySource,
  DiscoverySourceQueryParams,
  LinkCandidateRequest,
  ListCandidatesResponse,
  ListRunsResponse,
  ListSourcesResponse,
  NfObservation,
  ScanResult,
  UnlinkCandidateRequest,
  UpdateDiscoverySourceRequest,
} from './discovery-types';

function withQuery(path: string, params: Record<string, string | number | undefined>): string {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    searchParams.set(key, String(value));
  }
  const query = searchParams.toString();
  return query ? `${path}?${query}` : path;
}

export async function fetchDiscoveryMeta(): Promise<DiscoveryMetaResponse> {
  return getJson<DiscoveryMetaResponse>('/api/discovery/meta');
}

export async function fetchDiscoverySources(
  params: DiscoverySourceQueryParams = {},
): Promise<ListSourcesResponse> {
  return getJson<ListSourcesResponse>(
    withQuery('/api/discovery/sources', {
      q: params.q,
      cursor: params.cursor,
      limit: params.limit,
    }),
  );
}

export async function fetchDiscoverySource(sourceId: string): Promise<DiscoverySource> {
  return getJson<DiscoverySource>(`/api/discovery/sources/${encodeURIComponent(sourceId)}`);
}

export async function createDiscoverySource(
  payload: CreateDiscoverySourceRequest,
): Promise<DiscoverySource> {
  return postJson<DiscoverySource>('/api/discovery/sources', payload);
}

export async function updateDiscoverySource(
  sourceId: string,
  payload: UpdateDiscoverySourceRequest,
): Promise<DiscoverySource> {
  return putJson<DiscoverySource>(`/api/discovery/sources/${encodeURIComponent(sourceId)}`, payload);
}

export async function scanDiscoverySource(sourceId: string): Promise<ScanResult> {
  return postJson<ScanResult>(`/api/discovery/sources/${encodeURIComponent(sourceId)}/scan`, {});
}

export async function fetchDiscoveryRuns(
  params: DiscoveryRunQueryParams = {},
): Promise<ListRunsResponse> {
  return getJson<ListRunsResponse>(
    withQuery('/api/discovery/runs', {
      sourceId: params.sourceId,
      status: params.status,
      cursor: params.cursor,
      limit: params.limit,
    }),
  );
}

export async function fetchDiscoveryRun(runId: string): Promise<DiscoveryRun> {
  return getJson<DiscoveryRun>(`/api/discovery/runs/${encodeURIComponent(runId)}`);
}

export async function fetchDiscoveryCandidates(
  params: DiscoveryCandidateQueryParams = {},
): Promise<ListCandidatesResponse> {
  return getJson<ListCandidatesResponse>(
    withQuery('/api/discovery/candidates', {
      sourceId: params.sourceId,
      nfType: params.nfType,
      nfStatus: params.nfStatus,
      observationState: params.observationState,
      linkedResourceId: params.linkedResourceId,
      cursor: params.cursor,
      limit: params.limit,
    }),
  );
}

export async function fetchDiscoveryCandidate(candidateId: string): Promise<NfObservation> {
  return getJson<NfObservation>(`/api/discovery/candidates/${encodeURIComponent(candidateId)}`);
}

export async function linkDiscoveryCandidate(
  candidateId: string,
  payload: LinkCandidateRequest,
): Promise<NfObservation> {
  return postJson<NfObservation>(
    `/api/discovery/candidates/${encodeURIComponent(candidateId)}/link`,
    payload,
  );
}

export async function unlinkDiscoveryCandidate(
  candidateId: string,
  payload: UnlinkCandidateRequest,
): Promise<NfObservation> {
  return postJson<NfObservation>(
    `/api/discovery/candidates/${encodeURIComponent(candidateId)}/unlink`,
    payload,
  );
}
