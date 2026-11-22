# Metric assurance deployment and rollback

Scope: exporter RSS aggregation, hourly/daily history, baseline deviation,
sustained trends and the optional `metric_analysis` alert rule type.

## Flags and defaults

| Variable | Default | Effect when off |
|---|---|---|
| `NF_METRIC_AGGREGATES_ENABLED` | `false` | Worker performs no queries; history read returns 503; no new analysis records |
| `NF_METRIC_ALERTS_ENABLED` | `false` | `metric_threshold` rules cannot be created; existing threshold rules are not evaluated |
| `NF_METRIC_ANALYSIS_ALERTS_ENABLED` | `false` | `metric_analysis` rules cannot be created **and existing ones are not evaluated** |

Analysis records are shadow evidence. Nothing notifies until an operator authors
a rule, and no rule can be authored while its flag is off.

## Activation order

Follow the order; each step is independently verifiable and reversible.

1. **Indexes.** `node scripts/migrate-nf-metric-aggregate-indexes.mjs` prints the
   plan without touching the database. `--apply` creates the declared indexes on
   `app_nf_metric_aggregates` and `app_nf_metric_analysis`, then drops only the
   superseded `uniq_nf_metric_hour`. Ordinary startup, GET and the worker never
   create indexes.
2. **Aggregation.** Set `NF_METRIC_AGGREGATES_ENABLED=true` and restart. The
   worker finalizes the newest closed hour, repairs at most three older hours per
   target per tick inside a 48-hour window, rolls up the UTC day, and publishes
   one baseline and one trend record per analyzed hour.
3. **Shadow observation.** Leave the alert flags off for at least a week. Review
   deviation states, trend confirmations, misses and resource cost. No
   notification can be sent in this phase.
4. **Analysis alerts.** Set `NF_METRIC_ANALYSIS_ALERTS_ENABLED=true` and restart.
   The rule form now offers the type and `GET /api/nf-alerts/meta` advertises the
   frozen policy.
5. **Rules.** Operators author rules per target. Every rule pins the algorithm and
   policy version it was written against.

## Verification

```text
# indexes present
mongosh xcloud_ops --quiet --eval 'db.app_nf_metric_aggregates.getIndexes().map(i=>i.name)'
mongosh xcloud_ops --quiet --eval 'db.app_nf_metric_analysis.getIndexes().map(i=>i.name)'

# the worker is publishing
mongosh xcloud_ops --quiet --eval 'db.app_nf_metric_aggregates.countDocuments({period:"1h"})'
mongosh xcloud_ops --quiet --eval 'db.app_nf_metric_analysis.countDocuments({kind:"trend", confirmed:true})'

# reads are bounded and honest
curl -s -H 'Cookie: <session>' \
  'https://<edge>/api/nf-health/targets/<targetId>/metric-history?metric=process_resident_memory_bytes&series=unlabeled&resolution=1h&from=...&to=...'
curl -s -H 'Cookie: <session>' \
  'https://<edge>/api/nf-health/targets/<targetId>/metric-analysis?kind=trend&from=...&to=...'
```

`missingBuckets`, `incompleteBuckets` and `expiredBuckets` must be read, not
ignored: a gap is never a measured zero. The trend read must show
`confirmed=false` until two consecutive evaluations agree.

## Rollback drill

1. **Stop new analysis alerts.** Set `NF_METRIC_ANALYSIS_ALERTS_ENABLED=false` and
   restart. Rule authoring is rejected and existing analysis rules stop being
   evaluated. Open analysis alerts stay open: they are not closed as recovered,
   because recovery requires two valid normal analyses, not a configuration
   change.
2. **Stop aggregation.** Set `NF_METRIC_AGGREGATES_ENABLED=false` and restart. The
   worker makes no queries. `metric-history` returns 503; `metric-analysis` keeps
   returning stored records because the endpoint never evaluates on read.
3. **Keep everything else.** Threshold alerts, raw sampling, notification
   channels, the collections and the indexes are untouched. TTL deletion
   continues on its own schedule.
4. **Do not delete.** No collection is dropped, no index is dropped, no alert is
   resolved by hand as if measured, and no history is rewritten.
5. **Older binaries.** Before running a binary that predates these condition
   types, pause evaluation first. An older binary does not understand
   `metric_analysis` and would treat the rule as false, silently closing open
   alerts. Rolling back the binary is not a substitute for pausing evaluation.

## Irreversible effects

- The index migration drops `uniq_nf_metric_hour`; the replacement
  `uniq_nf_metric_bucket` is required for daily buckets to coexist with hourly
  ones.
- TTL deletion is performed by MongoDB. Expired hourly buckets cannot be
  reconstructed, and an analysis older than the hourly retention reports
  `evidenceExpired` instead of pretending it can still be verified.
- Records written under an older algorithm version are not reinterpreted; a
  version bump starts a new read partition.
