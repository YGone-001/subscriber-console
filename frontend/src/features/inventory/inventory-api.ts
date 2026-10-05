import { getJson } from '../../lib/api/read-client';
import { postJson, putJson } from '../../lib/api/mutation-client';
import type {
  CreateResourceRequest,
  InventoryMetaResponse,
  ListResourcesResponse,
  Resource,
  ResourceListQueryParams,
  RetireResourceRequest,
  UpdateResourceRequest,
} from './inventory-types';

export async function fetchInventoryMeta(): Promise<InventoryMetaResponse> {
  return getJson<InventoryMetaResponse>('/api/inventory/meta');
}

export async function fetchInventoryResources(
  params: ResourceListQueryParams = {},
): Promise<ListResourcesResponse> {
  const searchParams = new URLSearchParams();
  if (params.kind) searchParams.set('kind', params.kind);
  if (params.domain) searchParams.set('domain', params.domain);
  if (params.lifecycleState) searchParams.set('lifecycleState', params.lifecycleState);
  if (params.q) searchParams.set('q', params.q);
  if (params.cursor) searchParams.set('cursor', params.cursor);
  if (params.limit) searchParams.set('limit', String(params.limit));

  const query = searchParams.toString();
  const url = query ? `/api/inventory/resources?${query}` : '/api/inventory/resources';
  return getJson<ListResourcesResponse>(url);
}

export async function fetchInventoryResource(resourceId: string): Promise<Resource> {
  return getJson<Resource>(`/api/inventory/resources/${encodeURIComponent(resourceId)}`);
}

export async function createInventoryResource(
  payload: CreateResourceRequest,
): Promise<Resource> {
  return postJson<Resource>('/api/inventory/resources', payload);
}

export async function updateInventoryResource(
  resourceId: string,
  payload: UpdateResourceRequest,
): Promise<Resource> {
  return putJson<Resource>(`/api/inventory/resources/${encodeURIComponent(resourceId)}`, payload);
}

export async function retireInventoryResource(
  resourceId: string,
  payload: RetireResourceRequest,
): Promise<Resource> {
  return postJson<Resource>(`/api/inventory/resources/${encodeURIComponent(resourceId)}/retire`, payload);
}
