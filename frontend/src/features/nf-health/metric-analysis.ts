export interface MetricAnalysisItem {
  bucketStart: string;
  kind?: 'baseline' | 'trend';
  state: string;
  reason?: string;
  direction?: 'rising' | 'falling' | 'stable';
  scoreMethod?: 'robust_z' | 'absolute_floor';
  identityEpoch?: string;
  unit: string;
  sourceRevision: number;
  baselineDigest?: string;
  value?: number;
  median?: number;
  mad?: number;
  score?: number;
  absoluteChange?: number;
  baselineExpected: number;
  baselineEligible: number;
  baselinePresent: number;
  baselineCoverage: number;
  scoreThreshold?: number;
  minAbsoluteChange?: number;
  // Trend-only fields.
  windowHours?: number;
  eligibleBuckets?: number;
  lastTwoConsecutive?: boolean;
  slope?: number;
  fit?: number;
  trendChange?: number;
  confirmed?: boolean;
  confirmedFrom?: string;
  minTrendChange?: number;
  minFit?: number;
  revision: number;
  computedAt: string;
  evidenceExpired: boolean;
}
export interface MetricAnalysisView {
  targetId: string; metric: string; kind: 'baseline' | 'trend'; algorithmVersion: string; policyVersion: string;
  from: string; to: string;
  baselineHours?: number; scoreThreshold?: number; minAbsoluteChange?: number;
  windowHours?: number; minTrendChange?: number; minFit?: number;
  items: MetricAnalysisItem[]; page: { limit: number; nextCursor: string | null; hasMore: boolean };
}

// The analysis window ends at the last closed hour and never includes the hour
// currently being collected.
export function metricAnalysisWindow(hours = 168, now = Date.now()) {
  const to = Math.floor((now - 5 * 60_000) / 3_600_000) * 3_600_000;
  return { from: new Date(to - hours * 3_600_000).toISOString(), to: new Date(to).toISOString() };
}

// A page summary counts states instead of inventing a health score. Nothing here
// is a probability: an anomaly means "this hour deviates from its own baseline".
export function metricAnalysisCounts(items: MetricAnalysisItem[]) {
  const counts = { anomaly: 0, ok: 0, insufficient_data: 0, unavailable: 0 };
  for (const item of items) {
    if (item.state in counts) counts[item.state as keyof typeof counts] += 1;
  }
  return counts;
}

// Trend states are directions, not severities. Only a confirmed record is an
// event, and confirmation requires two consecutive evaluations.
export function metricTrendCounts(items: MetricAnalysisItem[]) {
  const counts = { rising: 0, falling: 0, stable: 0, insufficient_data: 0, unavailable: 0, confirmed: 0 };
  for (const item of items) {
    if (item.state === 'rising' || item.state === 'falling' || item.state === 'stable' || item.state === 'insufficient_data' || item.state === 'unavailable') {
      counts[item.state] += 1;
    }
    if (item.confirmed) counts.confirmed += 1;
  }
  return counts;
}
