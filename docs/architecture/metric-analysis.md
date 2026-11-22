# Metric baseline analysis

NF Health compares each closed hourly gauge bucket with the same identity's own
recent history and stores one versioned record per analyzed hour. The result is
served by a read-only endpoint and rendered on the target detail. It never
changes NF Health layers, alert state or collection scheduling, and it never
expresses a failure probability.

## Scope and storage

Only the positively registered gauge `process_resident_memory_bytes` is
analyzable. Counters are interval statistics whose baseline policy is not frozen
yet, and unknown series are never analyzed.

One record per target/metric/series/bucket/algorithm/policy lives in
`xcloud_ops.app_nf_metric_analysis`. The identity is the algorithm version, the
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
repairs anything. The parameters are `metric`, hour-aligned `from` and `to`,
`limit` (1-200) and `cursor`. The window is at most 90 days, matching the
analysis retention, and must not include the still-open hour.

Records are returned newest first. The cursor binds the target, metric, window,
limit and a manifest watermark of record identities and revisions; a changed
record between pages returns 409 `NF_METRIC_ANALYSIS_CHANGED` and clients restart
the read. Invalid cursors return 400 and database failures return 503.

`evidenceExpired` is computed on read: hourly buckets are retained for 30 days,
so an older record can no longer be re-verified against its own evidence even
though the record itself is kept for 90 days.

The target detail renders the frozen policy, the state counts of the current page
and a table of hour, state, current value, baseline median, MAD, score, absolute
change, eligible baseline hours and reason. The section states that this is a
deviation from the metric's own baseline, not a failure probability, and a
missing number is never rendered as zero.

## Rollback

Set `NF_METRIC_AGGREGATES_ENABLED` false to stop both aggregation and analysis
writes. Existing records and indexes are retained; TTL deletion is performed by
MongoDB and cannot be undone by rolling back the application. Reads keep
returning stored records because the endpoint never evaluates on read.
