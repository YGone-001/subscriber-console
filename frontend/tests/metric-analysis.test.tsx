import assert from 'node:assert/strict';
import test from 'node:test';
import { metricAnalysisCounts, metricAnalysisWindow, metricTrendCounts, type MetricAnalysisItem } from '../src/features/nf-health/metric-analysis';
import { metricAnalysisEn, metricAnalysisZh } from '../src/lib/locales/metric-analysis';

test('analysis window ends at the last closed UTC hour', () => {
  assert.deepEqual(metricAnalysisWindow(168, Date.parse('2026-11-22T08:04:59Z')), { from: '2026-11-15T07:00:00.000Z', to: '2026-11-22T07:00:00.000Z' });
  assert.equal(metricAnalysisWindow(168, Date.parse('2026-11-22T08:05:00Z')).to, '2026-11-22T08:00:00.000Z');
});

test('analysis summary counts states instead of inventing a score', () => {
  const item = (state: MetricAnalysisItem['state']): MetricAnalysisItem => ({
    bucketStart: '2026-11-22T07:00:00Z', state, unit: 'bytes', sourceRevision: 1,
    baselineExpected: 48, baselineEligible: 48, baselinePresent: 48, baselineCoverage: 1,
    scoreThreshold: 3.5, minAbsoluteChange: 8388608, revision: 1, computedAt: '2026-11-22T08:00:00Z', evidenceExpired: false,
  });
  assert.deepEqual(metricAnalysisCounts([item('anomaly'), item('ok'), item('ok'), item('insufficient_data'), item('unavailable')]), { anomaly: 1, ok: 2, insufficient_data: 1, unavailable: 1 });
  assert.deepEqual(metricAnalysisCounts([]), { anomaly: 0, ok: 0, insufficient_data: 0, unavailable: 0 });
  const trend = (state: string, confirmed = false): MetricAnalysisItem => ({ ...item('ok'), state, confirmed });
  assert.deepEqual(metricTrendCounts([trend('rising', true), trend('rising'), trend('stable'), trend('insufficient_data'), trend('unavailable')]),
    { rising: 2, falling: 0, stable: 1, insufficient_data: 1, unavailable: 1, confirmed: 1 });
  // A trend record is an event only when it is confirmed.
  assert.equal(metricTrendCounts([trend('rising')]).confirmed, 0);
  assert.deepEqual(Object.keys(metricAnalysisEn).sort(), Object.keys(metricAnalysisZh).sort());
});
