import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../src/providers/I18nProvider';
import { ServiceWindowPanel } from '../src/features/nf-health/ServiceWindowPanel';
import type { ServiceWindowReport } from '../src/features/nf-health/nf-health-types';
import { healthWindowEn, healthWindowZh } from '../src/lib/locales/nf-health-window';

const render = (report?: ServiceWindowReport) => renderToStaticMarkup(<I18nProvider><ServiceWindowPanel report={report} /></I18nProvider>);

test('window evidence preserves missing ratios, scopes and exclusions without inventing health', () => {
  const report: ServiceWindowReport = { version: 'interval-observation-v1', mode: 'observation_only', complete: true,
    evaluatedAt: '2026-11-20T08:00:00Z', windows: [{ seconds: 600, from: '2026-11-20T07:50:00Z', to: '2026-11-20T08:00:00Z',
      freshnessSeconds: 180, maxGapSeconds: 180, rows: [{ metric: 'synthetic_counter', scope: 'null', type: 'counter', unit: 'count',
        quality: 'insufficient', reason: 'insufficient_coverage', points: 2, intervals: 1, coveredSeconds: 120, coveragePercent: 20,
        delta: 0, rate: 0, latestValue: 100, excluded: { counter_reset: 1 }, businessJudgement: 'not_evaluated',
        pairMetric: 'synthetic_requests', pairReason: 'no_requests', evidence: [{ fromSampleId: 'sample-a', toSampleId: 'sample-b',
          from: '2026-11-20T07:58:00Z', to: '2026-11-20T08:00:00Z', seconds: 120, delta: null, reason: 'counter_reset' }] }] }] };
  const html = render(report);
  assert.ok(html.includes('20%'));
  assert.ok(html.includes('sample-a'));
  assert.ok(html.includes('<details>'));
  assert.ok(html.includes('aria-pressed="true"'));
  assert.ok(!html.includes('>0%</'));
  assert.ok(!html.includes('nf_health_window_'));
  assert.ok(!html.includes('NaN'));
  assert.ok(!html.includes('undefined'));
  assert.ok(!html.includes('badgeHealthy'));
});

test('a legacy backend produces a warmup explanation, with complete bilingual reasons', () => {
  assert.ok(!render().includes('nf_health_window_'));
  assert.deepEqual(Object.keys(healthWindowZh).sort(), Object.keys(healthWindowEn).sort());
  for (const value of [...Object.values(healthWindowEn), ...Object.values(healthWindowZh)]) assert.ok(value.trim());
});
