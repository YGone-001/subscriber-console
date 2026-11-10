import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../src/providers/I18nProvider';
import { SnapshotEvidence } from '../src/features/config-snapshots/ConfigSnapshotsPage';
import { captureRequestId, sourceListPath, type Snapshot } from '../src/features/config-snapshots/config-api';
import { ReportSectionCard } from '../src/features/ops-reports/OperationsReportsPage';
import { finiteMeasurement, reportQuery, reportSearch } from '../src/features/ops-reports/reports-model';
import { resolveReturnTo } from '../src/lib/return-to';

const snapshot: Snapshot = { snapshotId: 'v1', sourceId: 's1', generation: 'g1', collectorId: 'c1', resourceId: '', collectedAt: '2026-11-09T00:00:00Z', actor: 'operator', mode: 'metadata_only', reason: 'profile_metadata_only', policy: 'metadata-only-v1', projectionHash: '', projection: 'SYNTHETIC_FORBIDDEN_CONTENT', size: 1 };

test('metadata-only evidence does not render a raw body as an empty diff or configuration', () => {
  const html = renderToStaticMarkup(createElement(I18nProvider, null, createElement(SnapshotEvidence, { snapshot })));
  assert.doesNotMatch(html, /SYNTHETIC_FORBIDDEN_CONTENT/);
  assert.match(html, /Metadata only|\u4ec5\u5143\u6570\u636e/);
});
test('safe projected text is escaped rather than rendered as HTML', () => {
  const html = renderToStaticMarkup(createElement(I18nProvider, null, createElement(SnapshotEvidence, { snapshot: { ...snapshot, mode: 'projected', projection: '<img src=x onerror=alert(1)>' } })));
  assert.doesNotMatch(html, /<img/); assert.match(html, /&lt;img/);
});
test('unavailable report measurements do not become zero', () => {
  assert.equal(finiteMeasurement(null), null); assert.equal(finiteMeasurement(Number.NaN), null); assert.equal(finiteMeasurement(0), 0);
  const html = renderToStaticMarkup(createElement(I18nProvider, null, createElement(ReportSectionCard, { name: 'metrics', section: { completeness: 'unavailable', scope: 'requested_window', reason: 'source_unavailable', data: null } })));
  assert.match(html, /Unavailable|\u4e0d\u53ef\u7528/); assert.doesNotMatch(html, /<dd>0/);
});
test('report URL preserves the selected time window instead of replacing it with current time', () => {
  const params = new URLSearchParams({ from: '2026-11-08T00:00:00Z', to: '2026-11-09T00:00:00Z', resourceId: 'resource-a', severity: 'critical' });
  const query = reportQuery(params, '2027-01-01T00:00:00Z');
  assert.equal(query.to, params.get('to')); assert.equal(query.from, params.get('from'));
  assert.equal(new URLSearchParams(reportSearch(query)).get('severity'), 'critical');
});
test('relative report windows defer the clock to the server', () => { assert.deepEqual(reportQuery(new URLSearchParams(), '2099-01-01T00:00:00Z'), {period:'24h'}); assert.deepEqual(reportQuery(new URLSearchParams('period=7d')), {period:'7d'}); });
test('source list read key excludes untrusted paths and resets scope through explicit parameters', () => {
  const path = sourceListPath(new URLSearchParams({ q: 'AMF', path: '/etc/shadow', left: 'secret' }));
  assert.match(path, /q=AMF/); assert.doesNotMatch(path, /shadow|left|secret/);
  assert.equal(resolveReturnTo('?returnTo=https://external.example', '/config-snapshots', ['/config-snapshots']), '/config-snapshots');
});
test('capture request IDs work without the HTTPS-only randomUUID helper', () => {
  const ids = new Set(Array.from({ length: 100 }, captureRequestId)); assert.equal(ids.size, 100);
  for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
test('the feature contract excludes raw configuration, browser file paths and report writes', () => {
  const contract = JSON.parse(readFileSync(new URL('../evidence-contract.json', import.meta.url), 'utf8'));
  assert.equal(contract.rawConfigurationStored, false); assert.equal(contract.browserPathsAccepted, false); assert.equal(contract.reportWrites, false); assert.equal(contract.freshActorRequired, true);
});
