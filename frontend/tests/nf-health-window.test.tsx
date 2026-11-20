import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../src/providers/I18nProvider';
import { ServiceWindowPanel } from '../src/features/nf-health/ServiceWindowPanel';
import type { ServiceWindowReport } from '../src/features/nf-health/nf-health-types';
import { healthWindowEn, healthWindowZh } from '../src/lib/locales/nf-health-window';
import { BusinessRulePanel } from '../src/features/nf-health/BusinessRulePanel';
import { healthRulesEn, healthRulesZh } from '../src/lib/locales/nf-health-rules';
import type { BusinessRuleObservation } from '../src/features/nf-health/nf-health-types';

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

test('business observations preserve missing PCF evidence and distinguish gaps from failures', () => {
  const rule: BusinessRuleObservation = { ruleId: 'pcf_am_association', version: 'business-observation-v1', nfType: 'PCF', domain: '5gc', kind: 'request_completion',
    metrics: ['fivegs_pcffunction_pa_policyamassoreq', 'fivegs_pcffunction_pa_policyamassosucc'], minimumRequests: 100, semantics: 'per_slice_association',
    sourceReview: 'source_reviewed', binaryAttestation: 'not_attested', references: [{ path: 'src/pcf/npcf-handler.c', line: 189 }], missingSignals: ['transaction_cohort'],
    scope: 'null', status: 'unavailable', reason: 'metric_missing', quality: 'unavailable', coveragePercent: 0, validPoints: 0, validIntervals: 0,
    missingMetrics: ['fivegs_pcffunction_pa_policyamassoreq', 'fivegs_pcffunction_pa_policyamassosucc'], observed: [], requestDelta: null, completionDelta: null,
    difference: null, completionRatioPercent: null, decisionEligible: false, healthEffect: 'none' };
  const renderRule = (value: BusinessRuleObservation) => renderToStaticMarkup(<I18nProvider><BusinessRulePanel rules={[value]} /></I18nProvider>);
  const missing = renderRule(rule);
  assert.ok(missing.includes('fivegs_pcffunction_pa_policyamassoreq'));
  assert.ok(!missing.includes('nf_health_rule_'));
  assert.ok(!missing.includes('NaN'));
  // Zero coverage is real; the missing completion ratio must remain a dash.
  assert.equal((missing.match(/>0%</g) ?? []).length, 1);
  assert.ok(missing.includes('src/pcf/npcf-handler.c'));
  const gap = renderRule({ ...rule, ruleId: 'smf_n4_report', semantics: 'accept_response_sent', status: 'completion_gap', reason: 'gap_not_failure_count', quality: 'ready',
    coveragePercent: 100, validPoints: 6, validIntervals: 5, missingMetrics: [], requestDelta: 100, completionDelta: 90, difference: 10, completionRatioPercent: 90 });
  assert.ok(gap.includes('90%'));
  assert.ok(!gap.includes('badgeHealthy'));
  assert.ok(!gap.includes('nf_health_rule_'));
});

test('business rule labels have bilingual parity and every source boundary is explicit', () => {
  assert.deepEqual(Object.keys(healthRulesEn).sort(), Object.keys(healthRulesZh).sort());
  for (const label of Object.values(healthRulesEn)) assert.ok(label.trim());
  assert.notEqual(healthRulesZh.nf_health_rule_status_aligned_counts, '健康');
  assert.ok(healthRulesZh.nf_health_rule_binary_unattested.includes('尚未证明'));
});
