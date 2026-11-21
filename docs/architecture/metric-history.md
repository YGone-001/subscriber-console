# Metric history

NF Health owns an opt-in aggregation worker and a pure historical read endpoint
for exporter RSS statistics. It shares the existing recording and measurement
identity checks. It does not change alert decisions, NF Health/L3 states,
collection scheduling or notification delivery. Percentiles, counter rates,
capacity forecasting and anomaly or trend detection are not implemented by this
module.

## Activation and storage

`NF_METRIC_AGGREGATES_ENABLED` is a strict boolean and defaults to false,
independently of `NF_METRIC_ALERTS_ENABLED`. When disabled, the worker makes no
queries and the history endpoint returns 503 `NF_METRIC_HISTORY_DISABLED`.
Meta exposes the opt-in, the runtime worker status and the retention policy.
Production configuration is not modified by source changes.

The only additional collection is `xcloud_ops.app_nf_metric_aggregates`. One
deterministic document represents a UTC target/metric/series/period/algorithm
bucket. `period` is part of the identity because an hourly bucket and the daily
bucket that starts at the same UTC midnight are different populations. Separate
bounded segments inside a document retain each compatible exporter incarnation
and continuous observation sequence. This allows atomic whole-bucket
publication; it never averages separate populations into one value. Publication
uses `_id` uniqueness and revision CAS, replacing counts rather than
incrementing them. A repeated visit that would produce identical statistics does
not write again.

Hourly buckets expire after 30 days and daily buckets after 90 days through an
`expiresAt` field and the `ttl_nf_metric_bucket` TTL index. Deletion is performed
by the MongoDB TTL monitor, not by the application; expired buckets are gone and
are not recreated. Raw sample retention is unchanged and is never extended by
aggregation.

The explicit index migration is
`node scripts/migrate-nf-metric-aggregate-indexes.mjs` (default offline dry-run).
`--apply` creates the declared target-scan, unique bucket and TTL indexes, then
drops the superseded hourly-only unique index `uniq_nf_metric_hour`, and only
after its replacement `uniq_nf_metric_bucket` exists. It never drops any other
index and never writes documents. The dry run prints the full plan, including
that replacement. The full initializer shares the same index specification.
Ordinary startup, GET requests and the worker never create indexes.

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

## Daily rollup semantics

A day is the half-open UTC interval `[00:00,24:00)`. Daily buckets are derived
only from published hourly buckets; the worker never reads raw samples for a
day. Only mergeable statistics are combined: counts and sums add, minima and
maxima extend, and the daily mean is recomputed from total sum and total count.
Hourly means are never averaged, and no percentile is derived from hourly
percentiles.

The hourly segmentation rule still applies. Two adjacent hourly segments merge
into one daily segment only when they share the same identity epoch and the gap
between the last observation of one hour and the first observation of the next
stays within the collection-derived allowance. A missing hour, an identity
change or an excessive gap starts a new daily segment, so separate populations
are never folded into one daily value. Daily coverage is the sum of the clipped
hourly coverage, which is already disjoint because hours are half-open.

A daily bucket records how many hours contributed (`hours`) and how many
expected hours were absent (`missingHours`). `sourceComplete` requires every
expected hour to be present and known-complete, so a day is never complete while
an hour is missing or truncated. A day that has not ended yet is still published
so the current day is readable, but it is marked `day_not_closed` and never
presented as a full day. A day whose hours exist but contain no valid
observation is `no_valid_observations`, not a measured zero.

Every daily document carries `sourceDigest`, a digest of the exact hourly
revisions it consumed, plus the hourly algorithm version. A changed digest is the
staleness handle a later analysis can bind to; publishing never rewrites the
source evidence. No analysis collection exists yet, so nothing else is marked
stale today. A recomputation replaces the whole daily document under revision
CAS; identical rebuilds are not rewritten, so read watermarks do not churn while
an incomplete bucket is being retried.

## Worker bounds and completeness

One worker visits at most 16 enabled Inventory-bound HTTP targets per 60-second
tick, with an `_id` cursor for fairness. A tick has a 10-second deadline, a
target four seconds and source reads two seconds. Each target first finalizes the
latest closed hour after a five-minute grace. The leading continuity allowance is
at most 90 minutes; the full source window is at most 150 minutes and 10,000 runs,
with limit+1 detecting truncation. No telemetry is recollected.

After the newest hour, the same target may repair at most three older missing or
incomplete hours per tick, newest first, inside a 48-hour window. A slot is
skipped when its raw samples are already past their own retention: it stays
missing instead of being published as zero. A slot with no recorded evidence at
all is not published either, because an empty document would claim a read that
never happened and would inflate the day rollup; the read contract reports it as
missing while the slot remains inside the repair window. Repair therefore costs
bounded empty index reads rather than unbounded work.

Hours outside the repair window, controller downtime and expired raw samples can
leave missing hours. Startup never implies a full historical backfill. The API
explicitly counts absent, incomplete and unreconstructable buckets. The worker
does not claim complete historical coverage or a cross-collection transaction
snapshot.

Every published or changed hour triggers a rollup of the UTC day it belongs to.
The rollup reads at most 24 published hours and writes only when the merged
statistics or the consumed digest changed. Runtime status reports attempts,
successful scans, failures, retention days, the repair window, raw retention and
cumulative published-hour, published-day and repair counters. Scan success is not
evidence of a complete measurement population.

## Read contract and presentation

`GET /api/nf-health/targets/{targetId}/metric-history` requires `core.read`, an
existing UUID target and the existing authenticated identity. It has a per-user
60/minute rate limit and does not write, collect, repair or backfill. The
parameters are `metric=process_resident_memory_bytes`, `series=unlabeled`,
`resolution=1h|1d`, explicit UTC-aligned `from` and `to`, optional `limit`
(1-200, default 200) and `cursor`.

Hourly reads require hour-aligned bounds, exclude the still-open hour and are
limited to 30 days. Daily reads require day-aligned bounds, are limited to 90
days and may include the current day, whose bucket is reported as not closed.
Unknown or duplicate parameters and unregistered resolutions are rejected.

The response includes units/subject/type, resolution, period, algorithm version,
per-bucket revisions, generation times, segments, quality/exclusions, retention
days, `missingBuckets`, `incompleteBuckets`, `expiredBuckets` and pagination.
`expiredBuckets` counts absent buckets older than the raw sample policy, which
can no longer be reconstructed. A manifest of the whole requested window
produces a deterministic read watermark; the cursor binds the target,
metric/series, window, resolution, limit and watermark. A revision, deletion or
newly published bucket between pages returns 409 `NF_METRIC_HISTORY_CHANGED` and
clients restart the read. The bounded read queries share a two-second request
budget and do not promise an atomic snapshot. Invalid cursors return 400;
database failures return 503 rather than pretending the history is empty.

The existing target detail offers 24-hour/7-day/30-day hourly ranges and
7-day/30-day/90-day daily ranges when meta advertises the feature.
`metricRange` and `metricResolution` are URL state; older `metricHours` links are
still read. Reads are aborted on scope changes; refresh restarts pagination. A
scatter plot shows only single coherent segments with complete available source
reads and never connects missing buckets. The shared ChartDataTable retains mixed
segments, mean/min/max, sample counts, observed coverage, contributing hours for
daily buckets and reasons. Missing buckets, partial evidence, unreconstructable
buckets and raw-source failures are distinct from measured zero. The UI uses
shared fields, feedback, chart styling and bilingual locale strings.

## Rollback

Set the aggregation flag false and restart to stop writes. Existing alerts and
raw sampling remain independent. Retain the aggregate collection and its
indexes; there is no automatic deletion, raw data rewrite or schema downgrade.
TTL deletion is performed by MongoDB and cannot be undone by rolling back the
application. Source and isolated test acceptance do not establish a live
exporter deployment acceptance or authorize enabling production aggregation.
