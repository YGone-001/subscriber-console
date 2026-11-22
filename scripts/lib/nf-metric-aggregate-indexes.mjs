// Storage owned by the metric aggregation worker: one atomic document per UTC
// hour or day with bounded separate incarnation segments, plus one analysis
// record per analyzed hour. The period is part of the bucket identity so an
// hourly bucket and the daily bucket that starts at the same UTC midnight never
// collide.
export const NF_METRIC_AGGREGATE_INDEX_SPECS = [{
  collection: 'app_nf_health_targets',
  indexes: [{ key: { enabled: 1, collectorProfile: 1, identityState: 1, _id: 1 }, name: 'nf_metric_aggregate_targets' }],
}, {
  collection: 'app_nf_metric_aggregates',
  indexes: [
    { key: { targetId: 1, metric: 1, series: 1, period: 1, algorithmVersion: 1, bucketStart: 1 }, unique: true, name: 'uniq_nf_metric_bucket' },
    { key: { expiresAt: 1 }, name: 'ttl_nf_metric_bucket', expireAfterSeconds: 0 },
  ],
}, {
  collection: 'app_nf_metric_analysis',
  indexes: [
    { key: { targetId: 1, metric: 1, series: 1, kind: 1, algorithmVersion: 1, bucketStart: -1 }, name: 'nf_metric_analysis_read' },
    { key: { expiresAt: 1 }, name: 'ttl_nf_metric_analysis', expireAfterSeconds: 0 },
  ],
}];

// The hourly-only unique key is superseded by uniq_nf_metric_bucket. Only the
// explicit migration drops it, and only after the replacement exists.
export const NF_METRIC_AGGREGATE_SUPERSEDED_INDEXES = [{
  collection: 'app_nf_metric_aggregates',
  name: 'uniq_nf_metric_hour',
  replacedBy: 'uniq_nf_metric_bucket',
}];
