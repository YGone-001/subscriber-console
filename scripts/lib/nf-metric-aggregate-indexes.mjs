// One atomic document per UTC hour, with bounded separate incarnation segments.
export const NF_METRIC_AGGREGATE_INDEX_SPECS = [{
  collection: 'app_nf_health_targets',
  indexes: [{ key: { enabled: 1, collectorProfile: 1, identityState: 1, _id: 1 }, name: 'nf_metric_aggregate_targets' }],
}, {
  collection: 'app_nf_metric_aggregates',
  indexes: [{ key: { targetId: 1, metric: 1, series: 1, algorithmVersion: 1, bucketStart: 1 }, unique: true, name: 'uniq_nf_metric_hour' }],
}];
