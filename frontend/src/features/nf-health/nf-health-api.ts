import { getJson } from '../../lib/api/read-client';
import { postJson, putJson } from '../../lib/api/mutation-client';
import type {
  CollectResult,
  CreateNfHealthTargetRequest,
  GetTargetResponse,
  HealthRun,
  HealthTarget,
  ListRunsResponse,
  ListSamplesResponse,
  ListTargetsResponse,
  NfHealthMeta,
  NfHealthRunQueryParams,
  NfHealthSampleQueryParams,
  NfHealthTargetQueryParams,
  UpdateNfHealthTargetRequest,
} from './nf-health-types';

function withQuery(path: string, params: Record<string, string | number | undefined>): string {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    searchParams.set(key, String(value));
  }
  const query = searchParams.toString();
  return query ? `${path}?${query}` : path;
}

export async function fetchNfHealthMeta(): Promise<NfHealthMeta> {
  return getJson<NfHealthMeta>('/api/nf-health/meta');
}

export async function fetchNfHealthTargets(
  params: NfHealthTargetQueryParams = {},
): Promise<ListTargetsResponse> {
  return getJson<ListTargetsResponse>(
    withQuery('/api/nf-health/targets', {
      q: params.q,
      enabled: params.enabled,
      cursor: params.cursor,
      limit: params.limit,
    }),
  );
}

export async function fetchNfHealthTarget(targetId: string): Promise<GetTargetResponse> {
  return getJson<GetTargetResponse>(`/api/nf-health/targets/${encodeURIComponent(targetId)}`);
}

export async function fetchNfHealthTargetHistory(
  targetId: string,
  params: NfHealthSampleQueryParams = {},
): Promise<ListSamplesResponse> {
  return getJson<ListSamplesResponse>(
    withQuery(`/api/nf-health/targets/${encodeURIComponent(targetId)}/history`, {
      from: params.from,
      to: params.to,
      cursor: params.cursor,
      limit: params.limit,
    }),
  );
}

export async function fetchNfHealthSamples(
  params: NfHealthSampleQueryParams = {},
): Promise<ListSamplesResponse> {
  return getJson<ListSamplesResponse>(
    withQuery('/api/nf-health/samples', {
      targetId: params.targetId,
      from: params.from,
      to: params.to,
      cursor: params.cursor,
      limit: params.limit,
    }),
  );
}

export async function fetchNfHealthRuns(
  params: NfHealthRunQueryParams = {},
): Promise<ListRunsResponse> {
  return getJson<ListRunsResponse>(
    withQuery('/api/nf-health/runs', {
      targetId: params.targetId,
      status: params.status,
      cursor: params.cursor,
      limit: params.limit,
    }),
  );
}

export async function fetchNfHealthRun(runId: string): Promise<HealthRun> {
  return getJson<HealthRun>(`/api/nf-health/runs/${encodeURIComponent(runId)}`);
}

export async function createNfHealthTarget(
  payload: CreateNfHealthTargetRequest,
): Promise<HealthTarget> {
  return postJson<HealthTarget>('/api/nf-health/targets', payload);
}

export async function updateNfHealthTarget(
  targetId: string,
  payload: UpdateNfHealthTargetRequest,
): Promise<HealthTarget> {
  return putJson<HealthTarget>(`/api/nf-health/targets/${encodeURIComponent(targetId)}`, payload);
}

export async function collectNfHealthTarget(targetId: string): Promise<CollectResult> {
  return postJson<CollectResult>(`/api/nf-health/targets/${encodeURIComponent(targetId)}/collect`, {});
}
