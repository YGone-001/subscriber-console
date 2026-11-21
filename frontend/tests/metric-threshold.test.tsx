import React from 'react';
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../src/providers/I18nProvider';
import { MetricThresholdFields } from '../src/features/nf-alerts/MetricThresholdFields';
import { buildMetricCondition, metricConditionLabel } from '../src/features/nf-alerts/metric-threshold';
import { metricAlertsEn, metricAlertsZh } from '../src/lib/locales/metric-alerts';

test('metric payload retains zero and rejects missing, nonfinite or reversed thresholds', () => {
  assert.equal(buildMetricCondition({ operator: 'gt', threshold: '', recoveryThreshold: '0' }), null);
  assert.equal(buildMetricCondition({ operator: 'gt', threshold: ' ', recoveryThreshold: '0' }), null);
  assert.equal(buildMetricCondition({ operator: 'gt', threshold: 'Infinity', recoveryThreshold: '0' }), null);
  assert.equal(buildMetricCondition({ operator: 'gt', threshold: '10', recoveryThreshold: '20' }), null);
  assert.equal(buildMetricCondition({ operator: 'lt', threshold: '20', recoveryThreshold: '10' }), null);
  assert.deepEqual(buildMetricCondition({ operator: 'gte', threshold: '0', recoveryThreshold: '0' }), {
    metric: 'process_resident_memory_bytes', series: 'unlabeled', operator: 'gte', threshold: 0, recoveryThreshold: 0,
  });
  assert.ok(metricConditionLabel(buildMetricCondition({ operator: 'gt', threshold: '100', recoveryThreshold: '50' })!).includes('100 bytes'));
});

test('metric form uses named shared fields and states the exporter and immediate-observation boundaries', () => {
  const markup = renderToStaticMarkup(<I18nProvider><MetricThresholdFields targetId="" value={{ operator: 'gt', threshold: '', recoveryThreshold: '' }} onChange={() => {}} disabled={false} readOnly={false} /></I18nProvider>);
  assert.ok(markup.includes('for="nf-metric-threshold"'));
  assert.ok(markup.includes('for="nf-metric-recovery"'));
  assert.ok(markup.includes(metricAlertsEn.nf_metric_note));
  assert.ok(markup.includes(metricAlertsEn.nf_metric_immediate));
  assert.ok(markup.includes('role="status"'));
  assert.deepEqual(Object.keys(metricAlertsEn).sort(), Object.keys(metricAlertsZh).sort());
});
