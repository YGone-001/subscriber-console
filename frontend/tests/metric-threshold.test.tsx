import React from 'react';
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../src/providers/I18nProvider';
import { MetricThresholdFields } from '../src/features/nf-alerts/MetricThresholdFields';
import { buildMetricCondition, metricConditionLabel, metricTimingLabel } from '../src/features/nf-alerts/metric-threshold';
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


test('duration payload accepts bounded integer seconds and preserves legacy zero omission', () => {
  const base = { operator: 'gt' as const, threshold: '100', recoveryThreshold: '50' };
  for (const value of ['', '-1', '1.5', '3601', 'Infinity']) {
    assert.equal(buildMetricCondition({ ...base, durationSeconds: value }), null);
    assert.equal(buildMetricCondition({ ...base, recoveryDurationSeconds: value }), null);
  }
  assert.equal(buildMetricCondition({ ...base, durationSeconds: '1' }, 0), null);
  assert.equal(buildMetricCondition({ ...base, durationSeconds: '0', recoveryDurationSeconds: '0' })?.durationSeconds, undefined);
  const condition = buildMetricCondition({ ...base, durationSeconds: '120', recoveryDurationSeconds: '60' });
  assert.equal(condition?.durationSeconds, 120);
  assert.equal(condition?.recoveryDurationSeconds, 60);
});

test('duration fields are named, range bounded, and absent against older metadata', () => {
  const markup = renderToStaticMarkup(<I18nProvider><MetricThresholdFields targetId="" value={{ operator: 'gt', threshold: '100', recoveryThreshold: '50', durationSeconds: '120', recoveryDurationSeconds: '60' }} onChange={() => {}} disabled={false} readOnly={false} maxDurationSeconds={3600} /></I18nProvider>);
  assert.ok(markup.includes('for="nf-metric-duration"'));
  assert.ok(markup.includes('for="nf-metric-recovery-duration"'));
  assert.ok(markup.includes('max="3600"'));
  assert.ok(markup.includes(metricAlertsEn.nf_metric_duration_hint));
  const t = (key: string, values?: Record<string, string | number>) => Object.entries(values ?? {}).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), metricAlertsEn[key] ?? key);
  assert.equal(metricTimingLabel({ quality: 'measured', reason: 'pending_trigger', phase: 'pending', elapsedSeconds: 60, requiredSeconds: 120, observations: 2 }, t), 'Pending trigger: 60/120 seconds, 2 valid observations');
  assert.equal(metricTimingLabel({ quality: 'indeterminate', reason: 'metric_missing', phase: 'firing' }, t), metricAlertsEn.nf_metric_phase_firing);
});
