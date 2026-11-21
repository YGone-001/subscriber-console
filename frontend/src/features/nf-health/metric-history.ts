export interface MetricHourSegment {
  identityEpoch: string; count: number; sum: number; min: number; max: number; mean: number;
  firstObservedAt: string; lastObservedAt: string; coveredSeconds: number;
}
export type MetricResolution = '1h' | '1d';
export interface MetricBucket {
  from: string; to: string; revision: number; generatedAt: string; period: string;
  coveredSeconds: number; sourceComplete: boolean; quality: string; reason?: string; excluded: Record<string, number>;
  segments: MetricHourSegment[];
  hours?: number; missingHours?: number; sourceDigest?: string; sourceAlgorithmVersion?: string;
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

// 24h is hourly only and 90d is daily only; 7d and 30d exist at both
// resolutions. The server rejects any other combination, so the UI never sends
// one and an unknown value falls back to the closest legal scope.
export function metricHistoryScope(rawRange?: string | null, rawResolution?: string | null, legacyHours?: string | null) {
  const legacy: Record<string, MetricHistoryRange> = { '24': '24h', '168': '7d', '720': '30d' };
  const range: MetricHistoryRange = (METRIC_HISTORY_RANGES as readonly string[]).includes(rawRange ?? '')
    ? rawRange as MetricHistoryRange
    : legacy[legacyHours ?? ''] ?? '24h';
  let resolution: MetricResolution = rawResolution === '1d' ? '1d' : '1h';
  if (range === '24h') resolution = '1h';
  if (range === '90d') resolution = '1d';
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

// Only one coherent segment per bucket gets a plotted mean. Mixed/invalid
// buckets retain their individual evidence in the table; no cross-population
// averaging, and missing buckets stay gaps instead of connecting across.
export function metricHistoryPoints(buckets: MetricBucket[]) {
  return buckets.map(bucket => ({ at: Date.parse(bucket.from), value: bucket.sourceComplete && bucket.quality === 'measured' && bucket.segments.length === 1 ? bucket.segments[0].mean : null }));
}
