export interface MetricHourSegment {
  identityEpoch: string; count: number; sum: number; min: number; max: number; mean: number;
  firstObservedAt: string; lastObservedAt: string; coveredSeconds: number;
  // Exact nearest-rank P95 of this segment. Absent when the segment exceeded
  // the sort budget, and never provided for a daily bucket.
  p95?: number | null;
  // Counter statistics. A cumulative total is never averaged, so a counter
  // segment reports deltas and a rate instead of gauge statistics.
  deltaSum?: number; deltaCount?: number; rate?: number | null;
}
export type MetricResolution = '1h' | '1d';
export interface MetricBucket {
  from: string; to: string; revision: number; generatedAt: string; period: string;
  coveredSeconds: number; sourceComplete: boolean; quality: string; reason?: string; excluded: Record<string, number>;
  segments: MetricHourSegment[];
  hours?: number; missingHours?: number; sourceDigest?: string; sourceAlgorithmVersion?: string;
  p95State?: 'complete' | 'budget' | 'unavailable' | 'not_provided';
}
// Retained name: hourly buckets and daily buckets share one read shape.
export type MetricHourBucket = MetricBucket;
export interface MetricHistory {
  metricType: string; metric: string; series: string; resolution: MetricResolution; period: string; unit: string; subject: string; algorithmVersion: string;
  from: string; to: string; watermark: string; retentionDays: number; complete: boolean;
  missingBuckets: number; incompleteBuckets: number; expiredBuckets: number; missingHours?: number;
  buckets: MetricBucket[]; page: { limit: number; nextCursor: string | null; hasMore: boolean };
}

export const METRIC_HISTORY_RANGES = ['24h', '7d', '30d', '90d'] as const;
export type MetricHistoryRange = typeof METRIC_HISTORY_RANGES[number];
export const METRIC_RANGE_HOURS: Record<MetricHistoryRange, number> = { '24h': 24, '7d': 168, '30d': 720, '90d': 2160 };

export type MetricKey = 'rss' | 'cpu';
export interface MetricHistorySpec {
  key: MetricKey; metric: string; labelKey: string; unit: string; metricType: 'gauge' | 'counter';
  ranges: readonly MetricHistoryRange[]; resolutions: readonly MetricResolution[];
}
// The selectable series. The counter is hourly only: daily counter rollups are
// not provided, so it never offers a daily resolution or a 90-day range.
export const METRIC_HISTORY_SPECS: readonly MetricHistorySpec[] = [
  { key: 'rss', metric: 'process_resident_memory_bytes', labelKey: 'nf_metric_history_metric_rss', unit: 'bytes', metricType: 'gauge', ranges: METRIC_HISTORY_RANGES, resolutions: ['1h', '1d'] },
  { key: 'cpu', metric: 'process_cpu_seconds_total', labelKey: 'nf_metric_history_metric_cpu', unit: 'seconds_per_second', metricType: 'counter', ranges: ['24h', '7d', '30d'], resolutions: ['1h'] },
];

export function metricHistorySpec(rawMetric?: string | null): MetricHistorySpec {
  return METRIC_HISTORY_SPECS.find(spec => spec.metric === rawMetric || spec.key === rawMetric) ?? METRIC_HISTORY_SPECS[0];
}

// 24h is hourly only and 90d is daily only. A range or resolution the selected
// series cannot serve falls back to that series' first legal value instead of
// being sent to the server, which would reject the combination.
export function metricHistoryScope(rawRange?: string | null, rawResolution?: string | null, legacyHours?: string | null, spec: MetricHistorySpec = METRIC_HISTORY_SPECS[0]) {
  const legacy: Record<string, MetricHistoryRange> = { '24': '24h', '168': '7d', '720': '30d' };
  const candidate: MetricHistoryRange = (METRIC_HISTORY_RANGES as readonly string[]).includes(rawRange ?? '')
    ? rawRange as MetricHistoryRange
    : legacy[legacyHours ?? ''] ?? '24h';
  // An unsupported range falls back to the closest range the series can serve,
  // so switching from a 90-day gauge view to a counter keeps a long window.
  const range = spec.ranges.includes(candidate) ? candidate : spec.ranges.reduce((best, item) =>
    Math.abs(METRIC_RANGE_HOURS[item] - METRIC_RANGE_HOURS[candidate]) < Math.abs(METRIC_RANGE_HOURS[best] - METRIC_RANGE_HOURS[candidate]) ? item : best, spec.ranges[0]);
  let resolution: MetricResolution = rawResolution === '1d' ? '1d' : '1h';
  if (range === '24h') resolution = '1h';
  if (range === '90d') resolution = '1d';
  if (!spec.resolutions.includes(resolution)) resolution = spec.resolutions[0];
  return { range, resolution, hours: METRIC_RANGE_HOURS[range] };
}

export function metricHistoryResolutions(range: MetricHistoryRange): MetricResolution[] {
  if (range === '24h') return ['1h'];
  if (range === '90d') return ['1d'];
  return ['1h', '1d'];
}

// Hourly windows end at the last closed hour; daily windows end at the next
// midnight so the current partial day is included and marked incomplete.
export function metricHistoryWindow(hours: number, now = Date.now(), resolution: MetricResolution = '1h') {
  const grace = now - 5 * 60_000;
  if (resolution === '1d') {
    const to = Math.floor(grace / 86_400_000) * 86_400_000 + 86_400_000;
    return { from: new Date(to - hours * 3_600_000).toISOString(), to: new Date(to).toISOString() };
  }
  const to = Math.floor(grace / 3_600_000) * 3_600_000;
  return { from: new Date(to - hours * 3_600_000).toISOString(), to: new Date(to).toISOString() };
}

// Only one coherent segment per bucket gets a plotted value. Mixed/invalid
// buckets retain their individual evidence in the table; no cross-population
// averaging, and missing buckets stay gaps instead of connecting across.
export function metricHistoryPoints(buckets: MetricBucket[], metricType: 'gauge' | 'counter' = 'gauge') {
  return buckets.map(bucket => ({
    at: Date.parse(bucket.from),
    value: bucket.sourceComplete && bucket.quality === 'measured' && bucket.segments.length === 1
      ? (metricType === 'counter' ? bucket.segments[0].rate ?? null : bucket.segments[0].mean)
      : null,
  }));
}
