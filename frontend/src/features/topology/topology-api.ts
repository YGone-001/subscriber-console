/*
 * Topology request boundary.
 *
 * All calls go through the shared read/mutation clients. No raw fetch, no
 * absolute backend URL, no JWT handling and no automatic mutation retry exists
 * in this feature.
 */
import { getJson, getJsonWithSignal } from '../../lib/api/read-client';
import { postJson, putJson } from '../../lib/api/mutation-client';
import type {
  CreateEdgeRequest,
  EdgeListQueryParams,
  ListEdgesResponse,
  NeighborQueryParams,
  NeighborsResponse,
  RetireEdgeRequest,
  TopologyEdge,
  TopologyMetaResponse,
  UpdateEdgeRequest,
} from './topology-types';

export async function fetchTopologyMeta(): Promise<TopologyMetaResponse> {
  return getJson<TopologyMetaResponse>('/api/topology/meta');
}

export async function fetchTopologyEdges(
  params: EdgeListQueryParams = {},
  signal?: AbortSignal,
): Promise<ListEdgesResponse> {
  const searchParams = new URLSearchParams();
  if (params.fromResourceId) searchParams.set('fromResourceId', params.fromResourceId);
  if (params.toResourceId) searchParams.set('toResourceId', params.toResourceId);
  if (params.relationshipType) searchParams.set('relationshipType', params.relationshipType);
  if (params.lifecycleState) searchParams.set('lifecycleState', params.lifecycleState);
  if (params.cursor) searchParams.set('cursor', params.cursor);
  if (params.limit) searchParams.set('limit', String(params.limit));

  const query = searchParams.toString();
  const url = query ? `/api/topology/edges?${query}` : '/api/topology/edges';
  return signal
    ? getJsonWithSignal<ListEdgesResponse>(url, signal)
    : getJson<ListEdgesResponse>(url);
}

export async function fetchTopologyEdge(edgeId: string): Promise<TopologyEdge> {
  return getJson<TopologyEdge>(`/api/topology/edges/${encodeURIComponent(edgeId)}`);
}

export async function fetchTopologyNeighbors(
  resourceId: string,
  params: NeighborQueryParams = {},
  signal?: AbortSignal,
): Promise<NeighborsResponse> {
  const searchParams = new URLSearchParams();
  if (params.direction) searchParams.set('direction', params.direction);
  if (params.relationshipType) searchParams.set('relationshipType', params.relationshipType);
  if (params.lifecycleState) searchParams.set('lifecycleState', params.lifecycleState);
  if (params.cursor) searchParams.set('cursor', params.cursor);
  if (params.limit) searchParams.set('limit', String(params.limit));

  const query = searchParams.toString();
  const base = `/api/topology/resources/${encodeURIComponent(resourceId)}/neighbors`;
  const url = query ? `${base}?${query}` : base;
  return signal
    ? getJsonWithSignal<NeighborsResponse>(url, signal)
    : getJson<NeighborsResponse>(url);
}

export async function createTopologyEdge(payload: CreateEdgeRequest): Promise<TopologyEdge> {
  return postJson<TopologyEdge>('/api/topology/edges', payload);
}

export async function updateTopologyEdge(
  edgeId: string,
  payload: UpdateEdgeRequest,
): Promise<TopologyEdge> {
  return putJson<TopologyEdge>(`/api/topology/edges/${encodeURIComponent(edgeId)}`, payload);
}

export async function retireTopologyEdge(
  edgeId: string,
  payload: RetireEdgeRequest,
): Promise<TopologyEdge> {
  return postJson<TopologyEdge>(
    `/api/topology/edges/${encodeURIComponent(edgeId)}/retire`,
    payload,
  );
}
