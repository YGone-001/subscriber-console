# Hourly metric history

NF Health owns an opt-in hourly RSS aggregation worker and a pure historical
read endpoint. It shares the existing recording and measurement identity checks.
It does not change alert decisions, NF Health/L3 states, collection scheduling
or notification delivery. Daily rollups, P95, historical backfill and anomaly or
trend detection are not implemented by this module.

## Activation and storage

`NF_METRIC_AGGREGATES_ENABLED` is a strict boolean and defaults to false,
independently of `NF_METRIC_ALERTS_ENABLED`. When disabled, the worker makes no
queries and the history endpoint returns 503 `NF_METRIC_HISTORY_DISABLED`.
Meta exposes the opt-in and runtime worker status. Production configuration is
not modified by source changes.

The only additional collection is `xcloud_ops.app_nf_metric_aggregates`.
One deterministic document represents a UTC target/metric/series/algorithm/hour.
Separate bounded segments inside that document retain each compatible exporter
incarnation and continuous observation sequence. This allows an atomic whole-hour
publication; it never averages separate populations into one hour value.
Publication uses `_id` uniqueness and revision CAS, replacing counts rather than
incrementing them. A repeated finalized visit does not write again.

The explicit index migration is
`node scripts/migrate-nf-metric-aggregate-indexes.mjs` (default offline dry-run).
`--apply` creates only the declared target-scan and unique hour/read indexes and never drops an
index or writes documents. The full initializer shares the same specification.
The existing NF Health target/startedAt read index supports source reads. Ordinary
startup, GET and the worker never create indexes. The source provides no aggregate
TTL yet; retention policy, daily rollups and bounded cleanup belong to the next
retention/backfill work package. Raw sample TTL remains unchanged.

## Measurement and hour semantics

Only verified unlabeled `process_resident_memory_bytes` gauges are approved.
Their unit is bytes and their subject is the exporter process, not necessarily
the NF service. Counters, CPU percentages, business observations and unknown
series are excluded. Historical values are verified at their observation instant
against the current target binding. Incompatible prior target configurations
are not retroactively reinterpreted. Current Inventory identity is checked before
and after source reading; a target revision change aborts publication.

The worker shares `MetricOutcomes` recording/probe/sample consistency checks.
It reads recorded runs plus one bounded sample batch; failed, unpublished,
expired, ambiguous or missing evidence breaks continuity. A verified exporter
incarnation and matching `process_start_time_seconds` proof are mandatory.
Local endpoints without approved process evidence remain unavailable.
Private endpoints, labels and process tokens never enter aggregate documents.
Only an opaque epoch digest and safe scalar summaries are retained.

Hours are half-open UTC intervals `[from,to)`. Counts, sum, minimum, maximum and
sample mean include only observations inside the hour. The mean is not a time
average. Coverage is the union of clipped adjacent valid intervals with matching
identity and gaps no greater than the existing 1.5-times collection-interval rule.
A leading point and a point exactly at the end can prove coverage but are not
counted in that hour. There is no extrapolation after the last observation.
Single samples may have zero observed coverage; measured zero is retained as zero.

Failures, duplicate instants, scope/type/binding mismatches, incarnation changes
and excessive gaps start new segments. Each segment retains its first/last
observation time, count/sum/min/max/mean and observed covered seconds. The bucket
also retains total clipped coverage independently of the number of samples inside
the hour; boundary-only evidence can prove coverage without inventing a mean. More than
32 segments, numeric overflow or source truncation publishes an explicit
unavailable/incomplete hour with no truncated statistics. Individual exclusions
and missing source samples remain visible. Empty hours do not invent zero values.

## Worker bounds and completeness

One worker visits at most 16 enabled Inventory-bound HTTP targets per 60-second
tick, with an `_id` cursor for fairness. A tick has a 10-second deadline, a target
four seconds and source reads two seconds. Each target processes the latest
closed hour after a five-minute grace. The leading continuity allowance is at
most 90 minutes; the full source window is at most 150 minutes and 10,000 runs,
with limit+1 detecting truncation. No telemetry is recollected.

Only the latest eligible hour is generated; startup and downtime do not imply
historical backfill. Finalized hours are not automatically recomputed for late
records. Incomplete source hours can retry while still the latest hour. More
targets than the fairness/budget capacity, controller downtime, expired raw
samples or late records can leave missing hours. The API explicitly counts absent
hours. The later backfill task must address those gaps; this worker does not
claim complete historical coverage or a cross-collection transaction snapshot.

Runtime status reports attempts, successful scans and failures. Scan success is
not evidence of a complete measurement population. A bucket's `sourceComplete`
means the available bounded recording read was consumed without known missing
samples, not full measurement coverage, no future late writes or healthy service.
Observed coverage and exclusion reasons remain separate.

## Read contract and presentation

`GET /api/nf-health/targets/{targetId}/metric-history` requires `core.read`,
an existing UUID target and the existing authenticated identity. It has a
per-user 60/minute rate limit and does not write, collect, repair or backfill.
The parameters are `metric=process_resident_memory_bytes`, `series=unlabeled`,
`resolution=1h`, explicit UTC-hour-aligned `from` and `to`, optional `limit`
(1-200, default 200) and `cursor`. The interval is at most 30 days and excludes
the still-open hour. Unknown or duplicate parameters are rejected.

The response includes units/subject/type, algorithm version, per-hour revisions,
generation times, segments, quality/exclusions, missing-hour count and pagination.
A manifest of at most 720 hour identities/revisions produces a deterministic
read watermark. The cursor binds the target, metric/series, window, resolution,
limit and watermark. A revision, deletion or newly generated hour between pages
returns 409 `NF_METRIC_HISTORY_CHANGED`; clients restart the read. The two bounded
read queries share a two-second request budget and do not promise an atomic snapshot. Invalid cursors return 400;
database failures return 503 rather than pretending the history is empty.

The existing target detail offers 24-hour/7-day/30-day hourly ranges when meta
advertises the feature. `metricHours` is URL state. Reads are aborted on scope
changes; refresh restarts pagination. A scatter plot shows only single coherent
segments with complete available source reads and never connects missing hours.
The shared ChartDataTable retains mixed segments, mean/min/max, sample counts,
observed coverage and reasons. Missing hours, partial evidence and raw-source
failures are distinct from measured zero. The UI uses shared fields, feedback,
chart styling and bilingual locale strings.

## Rollback

Set the aggregation flag false and restart to stop writes. Existing alerts and
raw sampling remain independent. Retain the aggregate collection and index;
there is no automatic deletion, raw data rewrite or schema downgrade.
Source and isolated test acceptance do not establish a live exporter deployment
acceptance or authorize enabling production aggregation.
