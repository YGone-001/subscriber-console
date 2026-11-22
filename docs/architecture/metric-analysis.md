# Metric baseline analysis

NF Health compares each closed hourly gauge bucket with the same identity's own
recent history and stores one versioned record per analyzed hour. A related
record fits a line over the last eight hours and becomes an event only after two
consecutive agreeing evaluations. Both are served by a read-only endpoint and
rendered on the target detail. They never change NF Health layers, alert state or
collection scheduling, and they never express a failure probability.

## Scope and storage

Only the positively registered gauge `process_resident_memory_bytes` is
analyzable. Counters are interval statistics whose baseline policy is not frozen
yet, and unknown series are never analyzed.

One record per target/metric/series/bucket/algorithm/policy lives in
`xcloud_ops.app_nf_metric_analysis`. Both kinds (`baseline` deviation and
`trend`) share this collection: `kind` is part of the record identity and of the
read index, so the two partitions never mix and neither kind can shadow the
other. The identity is the algorithm version, the
policy version, the target, the metric, the series and the bucket start; `_id` is
a deterministic digest and publication replaces the whole record under revision
CAS. Records expire after 90 days through `expiresAt` and the
`ttl_nf_metric_analysis` TTL index; the read index is `nf_metric_analysis_read`.
Both are created only by the explicit dry-run/apply migration.

Each record stores the analyzed bucket revision (`sourceRevision`) and a digest
of the baseline revisions it consumed (`baselineDigest`). A repaired hour is
therefore detectable instead of silently changing an existing explanation. A
repair of an earlier baseline does not retroactively rewrite later records; the
next analysis under a new algorithm or policy version supersedes them.

## Inputs and eligibility

The analyzed hour must be a closed hourly gauge bucket whose bounded source read
was known-complete, with exactly one identity segment covering at least 80% of
the hour. A bucket with several identity segments has no single subject and is
not analyzed.

The baseline is the 48 hours immediately before the analyzed hour. The analyzed
hour is never part of its own training set. A baseline hour is eligible only when
it is an hourly gauge bucket with exactly one segment, the same identity epoch as
the analyzed hour, and at least 80% observed coverage. At least 80% of the
window (39 of 48 hours) must be eligible.

## Decision

The analyzer computes the median of the eligible baseline means and the median
absolute deviation (MAD). The robust score is
`0.6745 * (value - median) / MAD`.

A deviation is recorded only when both conditions hold: `|score| >= 3.5` and
`|value - median| >= 8388608` bytes (8 MiB). The absolute floor keeps a
statistically significant but operationally tiny wobble out of the record. When
MAD is zero the score is not computed at all: the absolute floor alone decides,
`scoreMethod` is `absolute_floor`, and no infinite score is invented. Direction
is `rising`, `falling` or `stable` from the sign of the change relative to the
floor.

## Sustained trend

A trend record fits an ordinary least-squares line over the eight hourly buckets
ending at the evaluated hour. The evaluated hour must be a closed, complete
hourly gauge bucket with one segment covering at least 80% of the hour; that
segment's identity is the subject. A bucket is usable only when it carries
exactly one segment of the same identity with at least 80% coverage. At least
seven of the eight buckets must be usable, and the newest two must both be
usable, so a window ending in a gap cannot produce a trend.

With `n` usable points the slope is `sxy / sxx` in bytes per hour and the fitted
change across the window is `slope * 7`. The fit quality is
`R² = 1 - ssRes / ssTot`, reported as 1 for a perfectly flat window. A direction
is claimed only when the fitted change clears the unit-ized floor of 8 MiB and
`R² >= 0.7`; a change below the floor reports `stable` with
`change_below_floor`, and a weak fit reports `stable` with `weak_fit`. A single
spike therefore does not become a trend. Fit quality decides whether a monotone
trend may be claimed at all; it is never multiplied into a probability or a
confidence value.

A trend becomes an event only when the evaluation of the immediately preceding
hour reports the same direction. The record then sets `confirmed` and
`confirmedFrom` to that earlier hour. An unconfirmed direction is still stored
and displayed, marked as awaiting the second evaluation, so a one-hour change is
never presented as an event.

## States and reasons

| State | Meaning |
|---|---|
| `ok` | Evaluated and inside both bounds. |
| `anomaly` | Both bounds exceeded. A statement about the measurement, not a diagnosis. |
| `insufficient_data` | The comparison could not be made. |
| `unavailable` | The input is not analyzable at all. |

Reasons are explicit: `cold_start` (no usable baseline hour),
`baseline_incomplete` (fewer than 80% eligible), `identity_changed` (baseline
hours belong to another process identity), `baseline_identity_ambiguous`,
`current_bucket_incomplete` (incomplete read or below 80% coverage),
`identity_ambiguous` (several segments in the analyzed hour),
`metric_not_analyzable`, `bucket_not_hourly_gauge` and `bucket_not_closed`. A
missing baseline is never treated as normal.

## Read contract and presentation

`GET /api/nf-health/targets/{targetId}/metric-analysis` requires `core.read`, an
existing UUID target and the existing authenticated identity. It has a per-user
60/minute rate limit, a two-second budget and never evaluates, collects or
repairs anything. The parameters are `metric`, `kind=baseline|trend` (default
`baseline`), hour-aligned `from` and `to`, `limit` (1-200) and `cursor`. An
unknown kind is rejected instead of falling back to the other partition. The window is at most 90 days, matching the
analysis retention, and must not include the still-open hour.

Records are returned newest first. The cursor binds the target, metric, window,
limit and a manifest watermark of record identities and revisions; a changed
record between pages returns 409 `NF_METRIC_ANALYSIS_CHANGED` and clients restart
the read. Invalid cursors return 400 and database failures return 503.

`evidenceExpired` is computed on read: hourly buckets are retained for 30 days,
so an older record can no longer be re-verified against its own evidence even
though the record itself is kept for 90 days.

The target detail renders two sections. The baseline section shows the frozen
policy, the state counts of the current page and a table of hour, state, current
value, baseline median, MAD, score, absolute change, eligible baseline hours and
reason. The trend section shows its own policy, the direction counts and a table
of window end, state, slope, fitted change, fit quality, usable hours,
confirmation and reason, plus a link into the existing investigation workbench
for the resource. Both state that this is a comparison with the metric's own
history, not a failure probability, and a missing number is never rendered as
zero.

## Alert integration

Analysis records are shadow evidence by default: nothing evaluates them and
nothing notifies. Turning them into alerts requires all three of the following,
so a deployment cannot start paging by accident.

1. `NF_METRIC_AGGREGATES_ENABLED` publishes records.
2. `NF_METRIC_ANALYSIS_ALERTS_ENABLED` (default false) accepts `metric_analysis`
   rules at all; with the flag off, rule creation and update are rejected with
   `NF_ALERT_ANALYSIS_DISABLED`.
3. An operator authors an explicit rule. No rule means no alert.

A rule pins one target, the approved gauge, the record kind (`baseline` or
`trend`), an optional direction for deviations (a mandatory one for trends) and
the exact algorithm and policy version it was written against. A later policy
change therefore cannot silently reinterpret an existing rule.

Evaluation happens when the aggregation worker publishes a record. The
classification has exactly three outcomes. `fire` requires a confirmed trend in
the rule's direction, or a baseline anomaly matching the rule's direction.
`recover` requires a valid normal record (`ok` or `stable`). Everything else —
insufficient data, unavailable, an unconfirmed trend, a different direction or a
record from another policy version — `hold`s, so missing analysis can never
close an open alert. An open alert closes only after two consecutive valid
normal records, and no maximum-hold timer exists: holding is not recovery.

Alert identity is deterministic per rule, target, series, kind, algorithm,
policy and analyzed hour, so replaying or repairing the same hour cannot create
a second instance. An event whose hour is older than two hours still becomes an
alert record but never emits a notification, which keeps a backfill or a
replay from paging an operator. Alerts use the existing lifecycle, permissions,
deduplication and notification chain.

`GET /api/nf-alerts/meta` advertises the capability only while the flag is on:
`analysisEnabled` plus the approved metric, the record kinds, the directions and
the exact algorithm and policy versions, together with the freshness window and
the recovery confirmations. The rule form renders its kind and direction selects
from that advertisement and never hardcodes a version; while the capability is
absent the option is not offered at all. Editing keeps the condition type fixed,
so an existing rule cannot silently change partition.

## Rollback

Set `NF_METRIC_AGGREGATES_ENABLED` false to stop both aggregation and analysis
writes. Existing records and indexes are retained; TTL deletion is performed by
MongoDB and cannot be undone by rolling back the application. Reads keep
returning stored records because the endpoint never evaluates on read.
