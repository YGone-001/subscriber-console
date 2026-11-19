import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { SWRConfig } from 'swr';
import { I18nProvider } from '../src/providers/I18nProvider';
import { inspectionsEn, inspectionsZh } from '../src/lib/locales/inspections';
import { CHECK_KINDS, directoryPath, evidenceLink, inspectionInvestigationLink, inspectionNewLink, inspectionReturn, newDefinition, planLink, runLink, validateInspectionDraft, type InspectionItem } from '../src/features/inspections/inspection-model';
import { InspectionCoverage, InspectionItemEvidence, InspectionStatus } from '../src/features/inspections/InspectionEvidence';
import { InspectionEditor } from '../src/features/inspections/InspectionEditor';
import { alertReturn } from '../src/features/investigations/investigation-model';

const id = '10000000-0000-4000-8000-000000000001';
test('preview validation locates invalid fields before submitting and accepts explicit valid scope', () => {
  const draft = newDefinition(); draft.checks = []; draft.schedule.timezone = 'invalid-zone'; draft.scope.filter.plmn = 'abc'; draft.schedule.time = '';
  const errors = validateInspectionDraft(draft);
  for (const field of ['name', 'plmn', 'check-monitoring', 'time', 'timezone']) assert.ok(errors[`inspection-${field}`]);
  draft.scope.filter.plmn = ''; assert.ok(validateInspectionDraft(draft)['inspection-scope-mode']);
  const valid = newDefinition(); valid.name = 'SYNTHETIC duty'; valid.scope.mode = 'all'; assert.deepEqual(validateInspectionDraft(valid), {});
});
function render(element: React.ReactNode) { return renderToStaticMarkup(<MemoryRouter><SWRConfig value={{ provider: () => new Map(), revalidateOnMount: false }}><I18nProvider>{element}</I18nProvider></SWRConfig></MemoryRouter>); }
test('new inspection inherits explicit group scope and does not default to the whole network', () => { const value = newDefinition(new URLSearchParams({ siteResourceId: id, networkKey: 'lab-a', includeRetired: '1' })); assert.equal(value.scope.mode, 'groups'); assert.equal(value.scope.filter.siteResourceId, id); assert.equal(value.scope.filter.networkKey, 'lab-a'); assert.equal(value.scope.filter.includeRetired, false); assert.deepEqual(value.checks, [...CHECK_KINDS]); assert.equal(new URL(inspectionNewLink({ siteResourceId: id }), 'http://test.local').searchParams.get('siteResourceId'), id); });
test('inspection read queries preserve scope and drop navigation and unrelated filters', () => { const params = new URLSearchParams({ view: 'runs', planId: id, state: 'failed', networkKey: 'lab-a', returnTo: '//evil.test', command: 'bad', result: 'unknown' }); const path = new URL(directoryPath(params, true), 'http://test.local'); assert.equal(path.searchParams.get('planId'), id); assert.equal(path.searchParams.get('networkKey'), 'lab-a'); for (const key of ['returnTo', 'view', 'command', 'result']) assert.equal(path.searchParams.has(key), false); assert.equal(new URL(directoryPath(params, false), 'http://test.local').searchParams.has('state'), false); });
test('run and plan navigation preserve local inspection return context only', () => { const current = '/inspections?view=runs&state=missed'; for (const link of [runLink(id, current), planLink(id, current)]) assert.equal(inspectionReturn(link.slice(link.indexOf('?'))), current); for (const value of ['https://evil.test', '//evil.test', '/ocs/contracts']) assert.equal(inspectionReturn(`?returnTo=${encodeURIComponent(value)}`), '/inspections'); });
test('evidence links reject external, executable and unrelated destinations', () => { for (const value of ['javascript:alert(1)', '//evil.test/', '/users', '/inventory\\evil.test', '/agents\n/evil']) assert.equal(evidenceLink(value), null); assert.equal(evidenceLink(`/config-snapshots/${id}`), `/config-snapshots/${id}`); });
test('an unavailable source displays a gap rather than a zero observation count', () => { const html = render(<InspectionCoverage coverage={{ configuration: { state: 'unavailable', reason: 'source_unavailable', readAt: '2026-11-19T00:00:00Z', count: 0, limit: 128 } }} />); assert.ok(html.includes('data-state="unavailable"')); assert.ok(!html.includes('0 / 128')); assert.ok(!html.includes('inspection_reason_')); });
test('report evidence retains unknown layers and only supported alert anchors enter investigations', () => {
  const item: InspectionItem = { key: 'drift:1', kind: 'drift', subjectId: id, resourceId: id, name: 'SYNTHETIC', result: 'finding', severity: 'warning', reason: 'configuration_drift_open', readAt: '2026-11-19T00:00:00Z', evidenceAt: null, ageSeconds: null, maxAgeSeconds: 900, evidenceId: id, compatibility: 'g1', link: `/config-snapshots/${id}`, layers: { service: 'unknown' } };
  const current = `/inspections/runs/${id}?result=unknown`; const link = new URL(inspectionInvestigationLink(item, current)!, 'http://test.local'); assert.equal(link.searchParams.get('anchorKind'), 'config_drift'); assert.equal(link.searchParams.get('anchorId'), id); assert.equal(link.searchParams.has('alertId'), false); assert.equal(alertReturn(link.search), current); assert.equal(inspectionInvestigationLink({ ...item, kind: 'monitoring' }, current), null); assert.equal(inspectionInvestigationLink({ ...item, result: 'unknown' }, current), null);
  const html = render(<InspectionItemEvidence item={item} current={current} />); assert.ok(!html.includes('inspection_layer_unknown')); assert.ok(html.includes('/investigations?')); assert.ok(!html.includes('fingerprint'));
});
test('the editor requires explicit preview before saving a paused plan', () => { const html = render(<InspectionEditor initial={newDefinition()} back="/inspections" />); assert.ok(html.includes('id="inspection-scope-mode"')); assert.ok(html.includes('id="inspection-timezone"')); assert.ok(html.includes('value="Asia/Shanghai"')); assert.ok(html.includes('type="submit" disabled=""')); assert.ok(!html.includes('name="command"')); });
test('inspection execution and evidence states have distinct bilingual labels', () => { assert.deepEqual(Object.keys(inspectionsEn).sort(), Object.keys(inspectionsZh).sort()); assert.notEqual(inspectionsEn.inspection_status_completed, inspectionsEn.inspection_status_pass); assert.notEqual(inspectionsZh.inspection_status_unknown, inspectionsZh.inspection_status_pass); for (const value of [...Object.values(inspectionsEn), ...Object.values(inspectionsZh)]) assert.ok(value.trim()); assert.ok(render(<InspectionStatus value="missed" />).includes('data-state="missed"')); });
