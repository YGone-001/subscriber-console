import type { Agent } from '../agents/agents-api';
import type { Resource, MutableResource } from '../inventory/inventory-types';

export const GROUP_SCOPE_KEYS = ['networkKey', 'siteResourceId', 'hostResourceId', 'operatorName', 'plmn', 'domain', 'includeRetired'] as const;
// HTML pattern uses Unicode-set semantics; literal hyphens must be escaped.
export const GROUP_MACHINE_PATTERN = '[A-Za-z0-9][A-Za-z0-9._:\\-]{0,127}';
export const GROUP_NETWORK_PATTERN = '[a-z0-9][a-z0-9._\\-]{0,63}';
const NETWORK_KEY = new RegExp(`^${GROUP_NETWORK_PATTERN}$`);
export const GROUP_TABS = ['overview', 'resources', 'agents', 'alerts', 'config', 'issues'] as const;
const GROUP_URL_KEYS = new Set<string>([...GROUP_SCOPE_KEYS, 'groupBy', 'tab', 'q', 'kind', 'severity', 'directoryQ', 'directoryCursor', 'hostDirectoryCursor', 'networkSitesCursor', ...GROUP_TABS.map((tab) => `${tab}Cursor`)]);
export type GroupTab = typeof GROUP_TABS[number];
export type GroupFilter = Partial<Record<typeof GROUP_SCOPE_KEYS[number], string>>;
export type OperationalScope = { networkKey: string; operatorName: string; plmns: string[] };
export type Coverage = { completeness: string; reason: string; observedCount: number };
export type GroupScope = { filter: Record<string, string | boolean>; fingerprint: string; inventory: Coverage; topology: Coverage };
export type GroupSummary = { generatedAt: string; scope: GroupScope; counts: Record<string, number | null>; sources: Record<string, Coverage>; consistency: string; configurationScope: string };
export type GroupPage<T> = { generatedAt: string; scope: GroupScope; items: T[]; coverage: Coverage; nextCursor: string | null; hasMore: boolean };
export type GroupEntry = { key: string; name: string; kind: string };
export type GroupMonitoring = { targetId: string; enabled: boolean; overallState?: string; statusComplete: boolean; latestSampleAt?: string; freshness: { state: string }; coverage: { l1Measured: boolean; l2Measured: boolean; l3Measured: boolean } };
export type GroupResource = Resource & { operationalScopes: OperationalScope[]; declarationState: string; association: string; monitoring: GroupMonitoring | null };
export type GroupAgent = Agent;
export type GroupAlert = { alertId: string; resourceId: string; ruleName: string; targetName: string; severity: string; state: string; lastTriggeredAt: string };
export type GroupConfig = { sourceId: string; name: string; resourceId: string; registered: boolean; collectionState: string; comparison: string; baselineId: string; latest: { collectedAt: string } | null; latestSnapshot: null };
export type GroupIssue = { id: string; code: string; resourceId: string; relatedId?: string; agentId?: string };

export function groupFilter(params: URLSearchParams): GroupFilter {
  const out: GroupFilter = {};
  for (const key of GROUP_SCOPE_KEYS) if (params.has(key)) out[key] = params.get(key)!;
  return out;
}
export function groupSearch(values: Record<string, string | undefined>): string {
  return new URLSearchParams(Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== '')).toString();
}
export function patchGroupSearch(current: URLSearchParams, patch: Record<string, string | null>, reset = true): URLSearchParams {
  const next = new URLSearchParams([...current.entries()].filter(([key]) => GROUP_URL_KEYS.has(key)));
  for (const [key, value] of Object.entries(patch)) { if (!GROUP_URL_KEYS.has(key)) continue; if (value === null || value === '') next.delete(key); else next.set(key, value); }
  if (reset) for (const tab of GROUP_TABS) next.delete(`${tab}Cursor`);
  if (reset) next.delete('directoryCursor');
  if (reset) next.delete('hostDirectoryCursor');
  if (reset) next.delete('networkSitesCursor');
  return next;
}
export function mutableGroupResource(r: Resource): MutableResource {
  return { kind: r.kind, name: r.name, displayName: r.displayName, description: r.description, domain: r.domain, role: r.role, lifecycleState: r.lifecycleState, vendor: r.vendor, model: r.model, software: r.software, managementEndpoints: r.managementEndpoints, capabilities: r.capabilities, labels: r.labels, attributes: r.attributes };
}
export function parseOperationalScopes(value: unknown): OperationalScope[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) return null;
  const seen = new Set<string>();
  const result: OperationalScope[] = [];
  for (const row of value) {
    if (!row || typeof row !== 'object' || typeof row.networkKey !== 'string' || !NETWORK_KEY.test(row.networkKey) || seen.has(row.networkKey)) return null;
    const operatorName = row.operatorName ?? '';
    const plmns = row.plmns ?? [];
    if (typeof operatorName !== 'string' || [...operatorName].length > 128 || [...operatorName].some((character) => { const code = character.codePointAt(0)!; return code < 32 || code >= 127 && code <= 159; })) return null;
    if (!Array.isArray(plmns) || plmns.length > 16 || plmns.some((p: unknown) => typeof p !== 'string' || !/^[0-9]{5,6}$/.test(p)) || new Set(plmns).size !== plmns.length) return null;
    if (Object.keys(row).some((key) => !['networkKey', 'operatorName', 'plmns'].includes(key))) return null;
    seen.add(row.networkKey); result.push({ networkKey: row.networkKey, operatorName: operatorName.trim(), plmns: [...plmns] });
  }
  return result;
}
export function reportGroupLink(filter: GroupFilter): string { return `/ops-reports?${groupSearch({ ...filter, period: '24h' })}`; }
