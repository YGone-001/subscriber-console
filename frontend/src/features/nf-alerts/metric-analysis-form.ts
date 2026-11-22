import type { AlertRule, AnalysisCondition } from './nf-alerts-types';

export interface AnalysisForm {
  kind: 'trend' | 'baseline';
  direction: '' | 'rising' | 'falling';
}

export function defaultAnalysisForm(): AnalysisForm {
  return { kind: 'trend', direction: 'rising' };
}

export function analysisFormFromRule(rule?: AlertRule | null): AnalysisForm {
  const condition = rule?.analysisCondition;
  if (!condition) return defaultAnalysisForm();
  const direction = condition.direction === 'falling' ? 'falling' : condition.direction === 'rising' ? 'rising' : '';
  return { kind: condition.kind === 'baseline' ? 'baseline' : 'trend', direction };
}

export interface AnalysisPolicy {
  metric: string; series: string; kinds: string[]; directions: string[];
  deviationAlgorithm: string; deviationPolicy: string; trendAlgorithm: string; trendPolicy: string;
  freshnessSeconds: number; recoveryConfirmations: number;
}

// The builder pins the advertised policy and never invents a version. Without an
// advertised capability there is nothing to build, so the caller keeps the form
// in a rejected state instead of guessing.
export function buildAnalysisCondition(form: AnalysisForm, policy?: AnalysisPolicy): AnalysisCondition | undefined {
  if (!policy) return undefined;
  const trend = form.kind === 'trend';
  if (trend && form.direction !== 'rising' && form.direction !== 'falling') return undefined;
  return {
    metric: policy.metric,
    series: policy.series,
    kind: form.kind,
    direction: form.direction || undefined,
    algorithmVersion: trend ? policy.trendAlgorithm : policy.deviationAlgorithm,
    policyVersion: trend ? policy.trendPolicy : policy.deviationPolicy,
  };
}
