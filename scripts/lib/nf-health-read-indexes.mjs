// Latest-evidence queries sort by identity, timestamp and the deterministic ID tie-break.
// Keep the focused repair and the full initializer on the same non-destructive spec.
export const NF_HEALTH_READ_INDEX_SPECS = [
  { collection: 'app_nf_health_samples', indexes: [{ key: { targetId: 1, collectedAt: -1, _id: -1 }, name: 'nf_health_samples_target_collected_id' }] },
  { collection: 'app_nf_health_runs', indexes: [{ key: { targetId: 1, startedAt: -1, _id: -1 }, name: 'nf_health_runs_target_started_id' }] },
];
