import { MutationApiError } from '../../lib/api/mutation-client';
import { resolveReturnTo } from '../../lib/return-to';
import { inspectionsEn } from '../../lib/locales/inspections';
import { investigationEntry } from '../investigations/investigation-model';

export const CHECK_KINDS = ['monitoring', 'configuration', 'drift', 'alerts', 'agents'] as const;
export const SCOPE_KEYS = ['networkKey', 'siteResourceId', 'hostResourceId', 'operatorName', 'plmn', 'domain'] as const;
export type CheckKind = typeof CHECK_KINDS[number];
export type InspectionFilter = Record<typeof SCOPE_KEYS[number], string> & { includeRetired: boolean };
export type InspectionScope = { mode: 'groups' | 'resources' | 'all'; filter: InspectionFilter; resourceIds: string[] };
export type InspectionSchedule = { kind: 'interval' | 'daily' | 'weekly'; intervalSeconds: number; timezone: string; time: string; weekday: number };
export type Definition = { name: string; description: string; scope: InspectionScope; checks: CheckKind[]; configMaxAgeSeconds: number; schedule: InspectionSchedule };
export type InspectionPlan = Definition & { planId: string; revision: number; scheduleRevision: number; enabled: boolean; archived: boolean; authorizedBy: string; createdAt: string; updatedAt: string; nextAt: string | null; activeRunId: string; lastRunId: string; scheduleReason: string };
export type Coverage = { state: string; reason: string; readAt: string; count: number; limit: number };
export type ResourceFact = { resourceId: string; name: string; kind: string; domain: string };
export type ScopeChanges = {
  addedResources: ResourceFact[] | null;
  removedResources: ResourceFact[] | null;
  addedAgents: ResolvedScope['agents'] | null;
  removedAgents: ResolvedScope['agents'] | null;
};
export type ResolvedScope = { resources: ResourceFact[]; agentIds: string[]; agents: { agentId: string; name: string; revision: number }[]; fingerprint: string; membershipDigest: string; coverage: Coverage; agentCoverage: Coverage };
export type InspectionItem = { key: string; kind: string; subjectId: string; resourceId: string; name: string; result: string; severity: string; reason: string; readAt: string; evidenceAt: string | null; ageSeconds: number | null; maxAgeSeconds: number; evidenceId: string; compatibility: string; layers?: Record<string, string>; count?: number; link: string; change?: string };
export type InspectionRun = { runId: string; planId: string; planRevision: number; definition: Definition; version: number; mode: string; actor: string; state: string; reason: string; conclusion: string; queuedAt: string; scheduledFor: string | null; missedUntil: string | null; missedCount: number; startedAt: string | null; finishedAt: string | null; scope: ResolvedScope; coverage: Record<string, Coverage>; counts: Record<string, number>; comparison: { previousRunId: string; state: string; added: number; removed: number; newFindings: number; notRedetected: number; incomparable: number; scopeChanges?: ScopeChanges } };
export type InspectionPage<T> = { items: T[]; nextCursor: string | null; hasMore: boolean };
export type InspectionPreview = { definition: Definition; scope: ResolvedScope; next: string[]; generatedAt: string };
export type InspectionMeta = { running: boolean; lastError: string; readiness: string; reason: string; retainedRuns: number | null; queuedRuns: number | null; maxRetainedRuns: number; retentionDays: number; maxResources: number; maxAgents: number; timezones: string[] };
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function emptyFilter(): InspectionFilter { return { networkKey: '', siteResourceId: '', hostResourceId: '', operatorName: '', plmn: '', domain: '', includeRetired: false }; }
export function newDefinition(params = new URLSearchParams()): Definition { const filter = emptyFilter(); for (const key of SCOPE_KEYS) filter[key] = params.get(key) || ''; return { name: '', description: '', scope: { mode: 'groups', filter, resourceIds: [] }, checks: [...CHECK_KINDS], configMaxAgeSeconds: 86400, schedule: { kind: 'daily', intervalSeconds: 3600, timezone: 'Asia/Shanghai', time: '09:00', weekday: 1 } }; }
export function definitionFor(p: Definition): Definition { return { name: p.name, description: p.description, scope: p.scope, checks: p.checks, configMaxAgeSeconds: p.configMaxAgeSeconds, schedule: p.schedule }; }
export function validateInspectionDraft(d: Definition): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!d.name.trim() || [...d.name.trim()].length > 128 || [...d.name].some(char => char.charCodeAt(0) < 32 || (char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159))) errors['inspection-name'] = 'inspection_validation_name';
  if (d.scope.mode === 'groups' && !Object.entries(d.scope.filter).some(([key, value]) => key !== 'includeRetired' && Boolean(value))) errors['inspection-scope-mode'] = 'inspection_validation_group';
  if (d.scope.mode === 'resources' && (d.scope.resourceIds.length < 1 || d.scope.resourceIds.length > 200 || d.scope.resourceIds.some(id => !UUID.test(id)))) errors['inspection-scope-mode'] = 'inspection_validation_resources';
  if (d.scope.filter.plmn && !/^\d{5,6}$/.test(d.scope.filter.plmn)) errors['inspection-plmn'] = 'inspection_validation_plmn';
  if (!d.checks.length) errors['inspection-check-monitoring'] = 'inspection_validation_checks';
  if (d.schedule.kind !== 'interval' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(d.schedule.time)) errors['inspection-time'] = 'inspection_validation_time';
  try { if (!d.schedule.timezone) throw new Error('missing'); new Intl.DateTimeFormat('en', { timeZone: d.schedule.timezone }).format(); } catch { errors['inspection-timezone'] = 'inspection_validation_timezone'; }
  return errors;
}
export function isActiveRun(state: string) { return state === 'queued' || state === 'running'; }
export function inspectionReturn(search: string) { return resolveReturnTo(search, '/inspections', ['/inspections']); }
export function planLink(id: string, back = '/inspections') { return `/inspections/plans/${encodeURIComponent(id)}?${new URLSearchParams({ returnTo: back })}`; }
export function runLink(id: string, back = '/inspections?view=runs') { return `/inspections/runs/${encodeURIComponent(id)}?${new URLSearchParams({ returnTo: back })}`; }
export function inspectionNewLink(filter: Partial<Record<typeof SCOPE_KEYS[number], string>>) { const params = new URLSearchParams(); for (const key of SCOPE_KEYS) if (filter[key]) params.set(key, filter[key]!); return `/inspections/new?${params}`; }
export function directoryPath(params: URLSearchParams, runs: boolean) { const query = new URLSearchParams(); for (const key of ['q', 'cursor', ...(runs ? ['planId', 'state', 'conclusion'] : ['archived']), ...SCOPE_KEYS]) if (params.get(key)) query.set(key, params.get(key)!); query.set('limit', '50'); return `${runs ? '/api/inspection-runs' : '/api/inspection-plans'}?${query}`; }
export function evidenceLink(link: string): string | null { return /^\/(?:inventory|nf-health|nf-alerts|config-snapshots|agents)(?:[/?]|$)/.test(link) && !/[\r\n\\]/.test(link) ? link : null; }
export function inspectionError(error: unknown): string { if (error instanceof MutationApiError && error.code) { const key = `inspection_error_${error.code}`; if (inspectionsEn[key]) return key; } return 'inspection_error_generic'; }
export function inspectionInvestigationLink(item: InspectionItem, current: string): string | null {
  if (item.result !== 'finding' || !UUID.test(item.evidenceId)) return null;
  if (item.kind === 'alerts') return investigationEntry(item.evidenceId, current, item.subjectId.startsWith('drift:') ? 'config_drift' : 'nf_alert');
  if (item.kind === 'drift' && item.reason === 'configuration_drift_open') return investigationEntry(item.evidenceId, current, 'config_drift');
  return null;
}
