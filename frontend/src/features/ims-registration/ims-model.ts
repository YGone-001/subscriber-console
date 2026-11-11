import type { GroupFilter, GroupScope } from '../groups/groups-model';

export const IMS_SCOPE_KEYS = ['networkKey', 'siteResourceId', 'hostResourceId', 'operatorName', 'plmn'] as const;
export const IMS_QUERY_KEYS = [...IMS_SCOPE_KEYS, 'sourceId', 'q', 'state', 'cursor'] as const;
export type IMSBinding = { key: string; uri?: string; state: string; expiresAt: string | null };
export type IMSIdentity = { key: string; sourceId: string; resourceId: string; publicIdentity: string; state: string; bindings: IMSBinding[]; privateIdentities: string[]; msisdns: string[]; identityState: string; readAt: string };
export type IMSSource = { id: string; name: string; resourceId: string; authority: string; persistence: string; evidence: string; state: string; reason: string; completeness: string; freshness: string; readAt: string | null; sourceAsOf: string | null; observedIdentities: number; identityState: string };
export type IMSResponse = { catalogSources: { id: string; name: string }[]; generatedAt: string; configurationState: string; completeness: string; scope: GroupScope; scopeMeaning: string; consistency: string; counts: { publicIdentities: number | null; activePublicIdentities: number | null; activeBindings: number | null }; observed: { publicIdentities: number; activePublicIdentities: number; activeBindings: number }; sources: IMSSource[]; items: IMSIdentity[]; pagination: { limit: number; total: number | null; nextCursor: string | null; hasMore: boolean } };

export function imsQuery(params: URLSearchParams, summary = false): string {
  const query = new URLSearchParams();
  for (const key of IMS_QUERY_KEYS) if (params.has(key) && !(summary && key === 'cursor')) query.set(key, params.get(key)!);
  if (!summary) query.set('limit', '50');
  const suffix = query.toString();
  return `/api/ims/registrations${summary ? '/summary' : ''}${suffix ? `?${suffix}` : ''}`;
}
export function patchIMSQuery(current: URLSearchParams, values: Record<string, string | null>, reset = true): URLSearchParams {
  const next = new URLSearchParams([...current].filter(([key]) => ([...IMS_QUERY_KEYS, 'returnTo'] as readonly string[]).includes(key)));
  for (const [key, value] of Object.entries(values)) if (([...IMS_QUERY_KEYS, 'returnTo'] as readonly string[]).includes(key)) { if (!value) next.delete(key); else next.set(key, value); }
  if (reset) next.delete('cursor');
  return next;
}
export function groupIMSLink(filter: GroupFilter, returnTo: string): string {
  const params = new URLSearchParams();
  for (const key of IMS_SCOPE_KEYS) if (filter[key]) params.set(key, filter[key]!);
  if (/^\/inventory\/groups(?:\?|$)/.test(returnTo) && !/[\r\n]/.test(returnTo)) params.set('returnTo', returnTo);
  return `/ims-registrations?${params}`;
}
export function imsGroupReturn(params: URLSearchParams): string {
  const value = params.get('returnTo') || '';
  return /^\/inventory\/groups(?:\?|$)/.test(value) && !/[\r\n]/.test(value) ? value : '/inventory/groups';
}
export function clearIMSQuery(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams();
  if (params.has('returnTo')) next.set('returnTo', imsGroupReturn(params));
  return next;
}
export function imsActiveBindings(item: IMSIdentity): number | null { return item.state === 'unknown' ? null : item.bindings.filter((binding) => binding.state === 'active').length; }
