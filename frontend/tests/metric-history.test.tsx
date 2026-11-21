import assert from 'node:assert/strict';
import test from 'node:test';
import { metricHistoryPoints, metricHistoryWindow, type MetricHourBucket } from '../src/features/nf-health/metric-history';
import { metricHistoryEn, metricHistoryZh } from '../src/lib/locales/metric-history';

test('hour history closes only UTC hours after the five minute grace', () => {
  assert.deepEqual(metricHistoryWindow(24, Date.parse('2026-11-22T08:04:59Z')), { from: '2026-11-21T07:00:00.000Z', to: '2026-11-22T07:00:00.000Z' });
  assert.equal(metricHistoryWindow(24, Date.parse('2026-11-22T08:05:00Z')).to, '2026-11-22T08:00:00.000Z');
});

test('hour plot keeps measured zero but excludes mixed identities and incomplete source', () => {
  const segment = { identityEpoch: 'epoch-a', count: 1, sum: 0, mean: 0, min: 0, max: 0, firstObservedAt: '', lastObservedAt: '', coveredSeconds: 0 };
  const bucket: MetricHourBucket = { from: '2026-11-22T01:00:00Z', to: '2026-11-22T02:00:00Z', revision: 1, generatedAt: '', coveredSeconds: 0, sourceComplete: true, quality: 'measured', excluded: {}, segments: [segment] };
  assert.equal(metricHistoryPoints([bucket])[0].value, 0);
  assert.equal(metricHistoryPoints([{ ...bucket, sourceComplete: false }])[0].value, null);
  assert.equal(metricHistoryPoints([{ ...bucket, quality: 'partial', excluded: {metric_missing: 1} }])[0].value, null);
  assert.equal(metricHistoryPoints([{ ...bucket, segments: [segment, { ...segment, identityEpoch: 'epoch-b', mean: 20 }] }])[0].value, null);
  assert.equal(metricHistoryPoints([{ ...bucket, segments: [] }])[0].value, null);
  assert.deepEqual(Object.keys(metricHistoryEn).sort(), Object.keys(metricHistoryZh).sort());
});
