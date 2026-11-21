export interface MetricHourSegment {
  identityEpoch: string; count: number; sum: number; min: number; max: number; mean: number;
  firstObservedAt: string; lastObservedAt: string; coveredSeconds: number;
}
export interface MetricHourBucket {
  from: string; to: string; revision: number; generatedAt: string;
  coveredSeconds: number; sourceComplete: boolean; quality: string; reason?: string; excluded: Record<string, number>;
  segments: MetricHourSegment[];
}
export interface MetricHistory {
  metricType: string; metric: string; series: string; resolution: string; unit: string; subject: string; algorithmVersion: string;
  from: string; to: string; watermark: string; complete: boolean; missingHours: number;
  buckets: MetricHourBucket[]; page: { limit: number; nextCursor: string | null; hasMore: boolean };
}

export function metricHistoryWindow(hours: number, now = Date.now()) {
  const to = Math.floor((now - 5 * 60_000) / 3_600_000) * 3_600_000;
  return { from: new Date(to - hours * 3_600_000).toISOString(), to: new Date(to).toISOString() };
}

// Only one coherent segment per hour gets a plotted mean. Mixed/invalid hours
// retain their individual evidence in the table; no cross-population averaging.
export function metricHistoryPoints(buckets: MetricHourBucket[]) {
  return buckets.map(bucket => ({ at: Date.parse(bucket.from), value: bucket.sourceComplete && bucket.quality === 'measured' && bucket.segments.length === 1 ? bucket.segments[0].mean : null }));
}
