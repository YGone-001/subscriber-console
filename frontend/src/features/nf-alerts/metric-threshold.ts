import type { MetricCondition } from './nf-alerts-types';

export type MetricForm = { operator: MetricCondition['operator']; threshold: string; recoveryThreshold: string };
export function buildMetricCondition(form: MetricForm): MetricCondition | null {
  if (!form.threshold.trim() || !form.recoveryThreshold.trim()) return null;
  const threshold = Number(form.threshold);
  const recoveryThreshold = Number(form.recoveryThreshold);
  if (!Number.isFinite(threshold) || !Number.isFinite(recoveryThreshold) || threshold < 0 || recoveryThreshold < 0) return null;
  if (!['gt', 'gte', 'lt', 'lte'].includes(form.operator)) return null;
  if (['gt', 'gte'].includes(form.operator) ? recoveryThreshold > threshold : recoveryThreshold < threshold) return null;
  return { metric: 'process_resident_memory_bytes', series: 'unlabeled', operator: form.operator, threshold, recoveryThreshold };
}
export function metricConditionLabel(condition: MetricCondition | undefined): string {
  if (!condition) return '-';
  const operators = { gt: '>', gte: '>=', lt: '<', lte: '<=' };
  return `${condition.metric} ${operators[condition.operator]} ${condition.threshold} bytes`;
}
