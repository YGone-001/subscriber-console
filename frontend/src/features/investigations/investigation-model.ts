import { resolveReturnTo, withReturnTo } from '../../lib/return-to';

export type Coverage = { state: string; reason?: string; returned: number; limit: number; historyCoverage: string };
export type ResourceFact = { resourceId: string; name: string; domain: string; role: string; kind: string; lifecycleState: string };
export type EdgeFact = { edgeId: string; fromResourceId: string; toResourceId: string; relationshipType: string; revision: number };
export type KnowledgeFact = { id: string; title: string; protocol: string; revision: number };
export type EvidenceEvent = { key: string; kind: string; id: string; resourceId: string; targetId?: string; sourceId?: string; snapshotId?: string; at: string; measuredAt?: string; name?: string; outcome: string; basis: string; changed: boolean | null; layers?: { process: {state: string}; interface: {state: string}; service: {state: string} } };
export type InvestigationContext = {
  generatedAt: string; from: string; to: string; completeness: string; relationshipBasis: string;
  anchor: {alertId: string; resourceId: string; targetId: string; name: string; state: string; severity: string; firstTriggeredAt: string};
  resources: ResourceFact[]; relations: EdgeFact[]; events: EvidenceEvent[]; coverage: Record<string, Coverage>;
};
export type InvestigationRecord = {
  investigationId: string; alertId: string; resourceId: string; from: string; to: string; title: string; status: string; notes: string; conclusion: string; knowledgeIds: string[]; revision: number;
  createdAt: string; updatedAt: string; createdBy: string; updatedBy: string;
  recentChanges: {revision: number; at: string; actor: string; status: string}[];
};
export type RecordView = {record: InvestigationRecord; knowledge: KnowledgeFact[]; knowledgeCoverage: Coverage};
export type RecordSummary = Pick<InvestigationRecord, 'investigationId'|'alertId'|'resourceId'|'title'|'status'|'revision'|'updatedAt'|'updatedBy'>;
export type InvestigationList = {items: RecordSummary[]; nextCursor: string | null; hasMore: boolean};
export type RecordDraft = Pick<InvestigationRecord,'title'|'status'|'notes'|'conclusion'|'knowledgeIds'>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function investigationEntry(alertId: string, alertList = '/nf-alerts'): string {
  const safe = resolveReturnTo(`?returnTo=${encodeURIComponent(alertList)}`, '/nf-alerts', ['/nf-alerts']);
  return `/investigations?${new URLSearchParams({view:'context',alertId,alertReturnTo:safe})}`;
}
export function investigationReturn(search: string): string { return resolveReturnTo(search, '/investigations', ['/investigations']); }
export function alertReturn(search: string): string { const params = new URLSearchParams(search); return resolveReturnTo(`?returnTo=${encodeURIComponent(params.get('alertReturnTo') || '')}`, '/nf-alerts', ['/nf-alerts']); }
export function recordLink(id: string, current: string): string { return withReturnTo(`/investigations/${encodeURIComponent(id)}`, current); }
export function contextPath(alertId: string, from = '', to = '', investigationId = ''): string | null {
  if (!uuid.test(alertId)) return null;
  const params = new URLSearchParams({alertId}); if (investigationId) params.set('investigationId',investigationId); else { if (from) params.set('from',from); if (to) params.set('to',to); }
  return `/api/investigations/context?${params}`;
}
export function investigationListPath(params: URLSearchParams): string {
  const query = new URLSearchParams({limit:'25'});
  for (const key of ['q','status','alertId','resourceId','cursor']) { const value = params.get(key); if (value) query.set(key,value); }
  return `/api/investigations?${query}`;
}
export function localTime(value: string): string {
  const date = new Date(value); if (!Number.isFinite(date.getTime())) return '';
  return new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,19);
}
export function draftFor(record: InvestigationRecord): RecordDraft { return {title:record.title,status:record.status,notes:record.notes,conclusion:record.conclusion,knowledgeIds:[...record.knowledgeIds]}; }
export function eventTarget(event: EvidenceEvent): string {
  if (event.kind.startsWith('alert_')) return `/nf-alerts?${new URLSearchParams({alertId:event.id})}`;
  if (event.kind==='health' && event.targetId && uuid.test(event.targetId)) return `/nf-health/${event.targetId}`;
  if (event.kind==='configuration' && event.sourceId && uuid.test(event.sourceId)) return `/config-snapshots/${event.sourceId}`;
  return '/investigations';
}
export function eventCategory(event: EvidenceEvent): string { return event.kind.startsWith('alert_') ? 'alerts' : event.kind; }
