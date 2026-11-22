import assert from 'node:assert/strict';
import test from 'node:test';
import { metricHistoryPoints, metricHistoryScope, metricHistorySpec, metricHistoryWindow, type MetricBucket } from '../src/features/nf-health/metric-history';
import { metricHistoryEn, metricHistoryZh } from '../src/lib/locales/metric-history';

test('hour history closes only UTC hours after the five minute grace', () => {
  assert.deepEqual(metricHistoryWindow(24, Date.parse('2026-11-22T08:04:59Z')), { from: '2026-11-21T07:00:00.000Z', to: '2026-11-22T07:00:00.000Z' });
  assert.equal(metricHistoryWindow(24, Date.parse('2026-11-22T08:05:00Z')).to, '2026-11-22T08:00:00.000Z');
});

test('day history ends at the next UTC midnight so the current day is readable', () => {
  const window = metricHistoryWindow(168, Date.parse('2026-11-22T08:04:59Z'), '1d');
  assert.equal(window.to, '2026-11-23T00:00:00.000Z');
  assert.equal(window.from, '2026-11-16T00:00:00.000Z');
  assert.equal(metricHistoryWindow(2160, Date.parse('2026-11-22T00:00:10Z'), '1d').to, '2026-11-22T00:00:00.000Z');
});

test('range and resolution never combine into an unsupported scope', () => {
  assert.deepEqual(metricHistoryScope('24h', '1d', null), { range: '24h', resolution: '1h', hours: 24 });
  assert.deepEqual(metricHistoryScope('90d', '1h', null), { range: '90d', resolution: '1d', hours: 2160 });
  assert.deepEqual(metricHistoryScope('30d', '1d', null), { range: '30d', resolution: '1d', hours: 720 });
  assert.deepEqual(metricHistoryScope('7d', '1d', null), { range: '7d', resolution: '1d', hours: 168 });
  assert.deepEqual(metricHistoryScope(null, null, '168'), { range: '7d', resolution: '1h', hours: 168 });
  assert.deepEqual(metricHistoryScope('bogus', null, null), { range: '24h', resolution: '1h', hours: 24 });
});

test('counter series never offers a daily resolution or a 90-day range', () => {
  const counter = metricHistorySpec('process_cpu_seconds_total');
  assert.equal(counter.metricType, 'counter');
  assert.equal(metricHistorySpec(null).key, 'rss');
  assert.deepEqual(metricHistoryScope('90d', '1d', null, counter), { range: '30d', resolution: '1h', hours: 720 });
  assert.deepEqual(metricHistoryScope('24h', '1d', null, counter), { range: '24h', resolution: '1h', hours: 24 });
  assert.deepEqual(metricHistoryScope('30d', '1h', null, counter), { range: '30d', resolution: '1h', hours: 720 });
  // The gauge keeps its own daily and 90-day scope.
  assert.deepEqual(metricHistoryScope('90d', '1h', null), { range: '90d', resolution: '1d', hours: 2160 });
});
test('counter plot uses the rate and keeps measured zero apart from a missing rate', () => {
  const segment = { identityEpoch: 'e', count: 3, sum: 0, mean: 0, min: 0, max: 0, firstObservedAt: '', lastObservedAt: '', coveredSeconds: 240, deltaSum: 0, deltaCount: 2, rate: 0 };
  const bucket: MetricBucket = { from: '2026-11-22T01:00:00Z', to: '2026-11-22T02:00:00Z', revision: 1, generatedAt: '', period: '1h', coveredSeconds: 240, sourceComplete: true, quality: 'measured', excluded: {}, segments: [segment] };
  assert.equal(metricHistoryPoints([bucket], 'counter')[0].value, 0);
  assert.equal(metricHistoryPoints([{ ...bucket, segments: [{ ...segment, rate: null }] }], 'counter')[0].value, null);
  assert.equal(metricHistoryPoints([{ ...bucket, segments: [{ ...segment, rate: 0.5 }] }], 'counter')[0].value, 0.5);
});
test('plot keeps measured zero but excludes mixed identities and incomplete source', () => {
  const segment = { identityEpoch: 'epoch-a', count: 1, sum: 0, mean: 0, min: 0, max: 0, firstObservedAt: '', lastObservedAt: '', coveredSeconds: 0 };
  const bucket: MetricBucket = { from: '2026-11-22T01:00:00Z', to: '2026-11-22T02:00:00Z', revision: 1, generatedAt: '', period: '1h', coveredSeconds: 0, sourceComplete: true, quality: 'measured', excluded: {}, segments: [segment] };
  assert.equal(metricHistoryPoints([bucket])[0].value, 0);
  assert.equal(metricHistoryPoints([{ ...bucket, sourceComplete: false }])[0].value, null);
  assert.equal(metricHistoryPoints([{ ...bucket, quality: 'partial', excluded: { metric_missing: 1 } }])[0].value, null);
  assert.equal(metricHistoryPoints([{ ...bucket, segments: [segment, { ...segment, identityEpoch: 'epoch-b', mean: 20 }] }])[0].value, null);
  assert.equal(metricHistoryPoints([{ ...bucket, segments: [] }])[0].value, null);
  assert.deepEqual(Object.keys(metricHistoryEn).sort(), Object.keys(metricHistoryZh).sort());
});
