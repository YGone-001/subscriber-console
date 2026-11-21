# Metric threshold alerts

The source implements opt-in gauge thresholds with observation-based trigger and
recovery durations in the existing NF alert module. It does not implement
historical rollups or statistical anomaly/trend detection. NF Health layer states
and business-process observations retain their existing meaning.

## Capability and activation

`NF_METRIC_ALERTS_ENABLED` defaults to false and rejects invalid boolean values.
When true, NF Alerts meta advertises `metric_threshold`; the existing rule dialog
then offers that condition. Switching the flag off stops metric evaluation without
closing open alerts or changing legacy state/run_failed evaluation. It does not
reset the persisted evaluation watermark. No production environment is modified
by the source change.

The only approved metric is `process_resident_memory_bytes`, in bytes, for the
exporter process. It does not establish NF-process memory usage or service health.
Only one verified unlabeled series is accepted. Cumulative CPU seconds, service
ratios, labeled series and other gauges are not implicitly approved.
NF Health meta exposes the capability directory; its target detail adds a
read-only `thresholdPreview` with a nullable value and an explicit quality reason.
That projection does not collect or evaluate an alert.

## Contract and authorization

No route is added. The existing rule CRUD and meta receive additive fields.
Metric rules require one explicit targetId, no resourceId scope, and no state
condition. `metricCondition` contains metric, series (`unlabeled`), operator
(`gt`, `gte`, `lt`, `lte`), threshold and recoveryThreshold. Optional
durationSeconds and recoveryDurationSeconds default to zero; they accept integer
seconds from 0 through 3600. Meta exposes maxMetricDurationSeconds. Both threshold fields
are mandatory finite nonnegative numbers; omitted/null is not zero. Unit and
measurement subject are server-owned, not request fields. Unknown fields are
rejected by the existing strict decoder.

A high-value trigger requires a recovery threshold no greater than the trigger;
low-value conditions reverse this. For equal thresholds the recovery comparison
is complementary: gt recovers at <=, gte at <, lt at >=, and lte at >. Between
thresholds an open alert remains open. Zero duration retains the original
single-observation behavior; positive duration requires a subsequent valid sample
at or beyond the configured duration, with at least two distinct observations. The repeated breach of the same incident
does not increment the
metric alert triggerCount, overwrite trigger evidence, or emit another open event.
The legacy cooldown/recount semantics are unchanged.

Reads require core.read. Metric rule create/update/delete reuse core.configure
and additionally revalidate the fresh actor before persistence. The production
metric target reader reuses collection-time Inventory identity validation, so
retired/missing/retyped resources are rejected. A rule requires an enabled,
Inventory-bound HTTP metrics target; process_only is not eligible. Creation can
precede the first sample, but no measurement is invented. Metric identity,
operator, thresholds and durations are fixed after creation; replacing those
requires a new rule. Names, enabled flag, severity and cooldown metadata remain mutable under
the existing CAS. Trigger snapshots retain the original severity and rule revision.
Disabling a rule holds its existing alert; manual resolve remains available.
Disabling can succeed even when the target is no longer eligible. Deletion uses
the existing rule_deleted lifecycle and cancels unpublished metric work.

## Evidence and state

A metric observation verifies current target binding, sample/run/resource identity,
HTTP metrics evidence, observation freshness, exact metric type/unit/source,
verified unlabeled scope and finite nonnegative value. Missing/stale/ambiguous or
failed observations are indeterminate. They do not open or recover an alert.
Unknown future condition types also cannot fall into the legacy false/recovery path.

The sole new collection is `xcloud_ops.app_nf_metric_rule_states`. Its `_id` is
the rule UUID, which is sufficient because each metric rule has one immutable
target/metric/series. The collection uses MongoDB's standard unique `_id` index;
there is no custom index, startup index mutation or TTL. State writes originate
only in authorized mutations or post-recording collection evaluation, never GET.
The document retains revision, accepted observation watermark, last sample ID,
last evaluation quality/reason, version-bound observation timing and an optional
display-safe transition journal. Timing and observation watermarks use exact UTC
RFC3339Nano BSON strings rather than millisecond-truncated BSON Dates. Legacy
Date watermarks remain readable and are conservatively rounded to the end of
their millisecond. These fields are not TTL fields.
It does not retain endpoints, labels, removed identifiers or raw response bodies.
Rule reads batch-project statuses by `_id`; the UI labels them as the last
evaluation, not current health. The existing rules/alerts collections remain owners.

One Go controller serializes metric evaluation and rule edits with a cancellable
process-local gate. State writes use revision CAS. This is not a distributed
lease or multi-controller guarantee. A transition is journaled before alert
publication and replayed idempotently after interruption. Opening uses a stable
rule/sample-based alert UUID; notifications reuse the existing outbox deduplication
key. The observation watermark includes valid failed-run timestamps, so an older
failed callback cannot erase a newer duration window. The sample watermark
remains separate. The accepted watermark prevents equal-time/duplicate/older samples from
reopening an incident after recovery, including after controller restart. Distinct
samples with identical instants are conservatively not ordered. Incoherent
sample/run references cannot advance the accepted watermark.

Trigger evidence and rule configuration remain unchanged after opening. Recovery
adds a separate `metricRecovery` snapshot. Journaled work that expires before
publication is discarded as indeterminate and awaits fresh evidence; it cannot
produce an obsolete notification or fabricated recovery. Disable/delete cancels
unpublished work. No expired source sample is needed to display stored safe values. Duration
transitions also retain the first observation ID/time, observed elapsed seconds,
observation count and maximum adjacent gap in the immutable trigger or recovery
snapshot.

Notification intent delivery retains the existing best-effort sink contract;
this feature does not promise lossless transport when the sink itself fails.
There is no background historical catch-up scanner yet. An interrupted journal
is revisited by the next metric evaluation or applicable authorized rule mutation. Duration
journals require a matching freshly verified continuity epoch before publication;
rule edits alone cannot replay them without that proof.
The entire metric evaluation has a four-second deadline; status reads have a
two-second deadline. No worker or extra network probe is introduced.

## Duration semantics

Positive-duration rules require the existing verified exporter incarnation plus
one verified unlabeled process_start_time_seconds metric, matching the RSS
population. The private continuity token also binds target configuration and
revision. A local endpoint without the existing approved process evidence cannot
establish this token. Such a rule remains indeterminate; startup identity is not
fabricated from a process name. Zero-duration rules keep their existing eligibility.
Target detail explains duration eligibility and the permitted sample gap without
exposing the private token.

The maximum adjacent gap reuses the NF Health interval window rule: 1.5 times
the configured valid interval (or its established default). Missing/failed/stale
observations, an excessive gap, ambiguous identity or a changed exporter/config
restart the pending segment. Entering the hysteresis band or the opposite
predicate clears incomplete trigger/recovery timing. An open alert remains open
until its recovery predicate completes; a manual lifecycle operation never
transfers a recovery timer to a different incident. No wall-clock timer can open
or recover an alert without a new accepted observation.

The persisted timing retains rule revision, private continuity epoch, last valid
observation, incident identity, direction, start instant, first sample ID and
count. Process restart resumes it only when subsequent evidence remains compatible
and within the gap. Every rule revision change, including metadata edits, starts
a new comparison segment. Disable/enable also changes revision and clears pending
timing. Rule reads project old-version progress as indeterminate without modifying
storage. Samples older than the current policy update do not accrue duration.

The UI distinguishes idle, pending trigger, firing, pending recovery and unknown
from alert lifecycle and NF service health. Progress is explicitly the last
observed elapsed/required seconds and sample count, never an interpolated timer.

## Rollback and operational checks

Set the feature flag false to stop new metric evaluation before any rollback.
It does not report measured recovery. Keep the state and alert collections; do
not remove watermarks or rewrite historical snapshots. An old binary does not
understand the new condition enum and must not evaluate enabled metric rules:
disable those rules first using the new binary. Retain the existing state/run_failed
rules and asynchronous notification infrastructure.

The automated evidence includes pure quality/comparison tests, HTTP permission
and fresh-actor tests, an isolated real-Mongo lifecycle/restart/journal test,
nanosecond boundary/legacy BSON compatibility tests, Linux race validation,
frontend payload/rendering tests and fixture-backed browser
acceptance. These do not establish real NF exporter deployment acceptance or
permission to turn the feature on in production.

For binary rollback, stop metric evaluation first and disable metric rules using
the new binary. The preceding single-observation binary ignores persisted duration
fields and must not evaluate positive-duration rules. Retain state and evidence;
there is no automatic schema rewrite or deletion during rollback.
