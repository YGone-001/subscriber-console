import type { MetricCondition, MetricEvaluationStatus } from './nf-alerts-types';

export type MetricForm = { operator: MetricCondition['operator']; threshold: string; recoveryThreshold: string; durationSeconds?: string; recoveryDurationSeconds?: string };
export function buildMetricCondition(form: MetricForm, maxSeconds = 3600): MetricCondition | null {
  const durationSeconds = parseDuration(form.durationSeconds, maxSeconds);
  const recoveryDurationSeconds = parseDuration(form.recoveryDurationSeconds, maxSeconds);
  if (durationSeconds === null || recoveryDurationSeconds === null) return null;
  if (!form.threshold.trim() || !form.recoveryThreshold.trim()) return null;
  const threshold = Number(form.threshold);
  const recoveryThreshold = Number(form.recoveryThreshold);
  if (!Number.isFinite(threshold) || !Number.isFinite(recoveryThreshold) || threshold < 0 || recoveryThreshold < 0) return null;
  if (!['gt', 'gte', 'lt', 'lte'].includes(form.operator)) return null;
  if (['gt', 'gte'].includes(form.operator) ? recoveryThreshold > threshold : recoveryThreshold < threshold) return null;
  return { metric: 'process_resident_memory_bytes', series: 'unlabeled', operator: form.operator, threshold, recoveryThreshold, ...(durationSeconds > 0 ? { durationSeconds } : {}), ...(recoveryDurationSeconds > 0 ? { recoveryDurationSeconds } : {}) };
}
export function metricConditionLabel(condition: MetricCondition | undefined): string {
  if (!condition) return '-';
  const operators = { gt: '>', gte: '>=', lt: '<', lte: '<=' };
  return `${condition.metric} ${operators[condition.operator]} ${condition.threshold} bytes`;
}

function parseDuration(raw: string | undefined, max: number): number | null {
  if (raw === undefined) return 0;
  if (!raw.trim()) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 && value <= max ? value : null;
}

export function metricTimingLabel(status: MetricEvaluationStatus | undefined, t: (key: string, params?: Record<string, string | number>) => string): string {
  if (!status?.phase) return '';
  if (status.quality === 'measured' && (status.phase === 'pending' || status.phase === 'recovering')) {
    return t('nf_metric_timing_progress', { phase: t(`nf_metric_phase_${status.phase}`), elapsed: status.elapsedSeconds ?? 0, required: status.requiredSeconds ?? 0, count: status.observations ?? 0 });
  }
  return t(`nf_metric_phase_${status.phase}`);
}
