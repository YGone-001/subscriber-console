# Metric threshold alerts

The source implements opt-in gauge thresholds with observation-based trigger and
recovery durations in the existing NF alert module. Hourly rollups have a
separate opt-in owner described in [metric history](metric-history.md).
Statistical anomaly/trend detection is not implemented. NF Health layer states
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
precede the first sample, but no measurement is invented. Target scope and condition type remain immutable. Approved metric conditions,
operators, thresholds and durations are editable under the existing revision CAS.
Meta advertises metricConditionEditable; clients connected to older servers keep
conditions read-only. Every metric rule revision, including metadata edits, closes
old open incidents as configuration_changed, or rule_disabled when disabled.
These are resolved events, never recovered events, and add no metricRecovery.
Trigger snapshots retain their original condition, severity and rule revision.
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
target and one approved metric/series per revision. The collection uses MongoDB's standard unique `_id` index;
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
adds a separate `metricRecovery` snapshot. `metricLatest` retains the last accepted
evaluation quality/time and optional safe value without rewriting trigger evidence
or changing lifecycle timestamps. Journaled work that expires before
publication is discarded as indeterminate and awaits fresh evidence; it cannot
produce an obsolete notification or fabricated recovery. Disable/delete cancels
unpublished work. No expired source sample is needed to display stored safe values. Duration
transitions also retain the first observation ID/time, observed elapsed seconds,
observation count and maximum adjacent gap in the immutable trigger or recovery
snapshot.

Notification intent delivery retains the existing best-effort sink contract;
this feature does not promise lossless transport when the sink itself fails.
A bounded background reconciliation worker and the live post-recording callback
use the same serialized source replay. Duration journals require a matching
freshly verified continuity epoch before publication. Rule edits cancel unpublished
measurement transitions; they do not publish an earlier measurement intent.
The entire metric evaluation has a four-second deadline; status reads have a
two-second deadline. Reconciliation introduces no extra network probe.

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
until its recovery predicate completes, or an explicit manual/configuration closure; a manual lifecycle operation never
transfers a recovery timer to a different incident. No wall-clock timer can open
or recover an alert without a new accepted observation.

The persisted timing retains rule revision, private continuity epoch, last valid
observation, incident identity, direction, start instant, first sample ID and
count. Process restart resumes it only when subsequent evidence remains compatible
and within the gap. Every rule revision change, including metadata edits, starts
a new comparison segment. Disable/enable also changes revision and clears pending
timing. Rule reads project old-version progress as indeterminate without modifying
storage. Samples older than the current policy update cannot trigger or recover even when
duration is zero.

The UI distinguishes idle, pending trigger, firing, pending recovery and unknown
from alert lifecycle and NF service health. Progress is explicitly the last
observed elapsed/required seconds and sample count, never an interpolated timer.

## Recording reconciliation and diagnostics

The worker starts only when NF_METRIC_ALERTS_ENABLED is true. It visits a keyset
page of at most 16 enabled metric rules or pending policy closures every 30 seconds, sharing the existing
single-controller evaluation gate. A tick has a ten-second budget, each rule a
four-second budget and each source query a two-second deadline. One failing
rule cannot permanently starve later pages. Shutdown cancels the worker and waits
for its bounded work. It never collects telemetry or modifies Inventory/Topology.

NF Health RecordCollection stores its original run, sample and target projection
before best-effort publication of a private metricRecorded marker on that run.
A marker write failure never changes a successfully recorded health response.
The marker is not in any JSON response. The reader stops at an unpublished run
for 30 seconds, so a newer callback cannot skip a recording still in progress.
An older incomplete recording or a missing/expired sample is a gap; no value or
failed-run claim is invented. Legacy unmarked runs are also gaps, without
backfilling or repairing the NF Health collections.

Reconciliation reads at most 128 rows per rule visit in a two-hour UTC window,
using the existing target/startedAt indexes, with one bounded sample batch by ID.
Canonical controller timestamps are parsed as instants. A limited page never
splits its final whole second, since fractional RFC3339 strings have a different
lexical order from the whole-second representation. Dense seconds, noncanonical
timestamps and unpublished barriers report partial reads rather than dropping
records. Duplicate instants are ambiguous evidence, not multiple healthy samples.
The existing nf_health_runs_target_started_id read index supports this ordered
query; deployments retain the existing explicit read-index migration workflow.
No index is created by reads or by this worker.

Source rows are processed chronologically with both failed runs and successful
samples. Intermediate rows are observation-only, including fresh intermediate
rows: their trigger/recovery crossings cannot publish incidents or notifications.
They can reconstruct a verified continuous timer. Only the latest row after a
fully consumed bounded read, still fresh and consistent with current policy and
Inventory evidence, can publish through the existing journal/outbox. A newer
observation supersedes an unpublished intermediate intent. Concurrent live and
worker passes use the same watermark and cannot duplicate the incident. GETs
never start replay or repair state.

The durable metric state stores a separate metricReplay diagnostic: last attempt,
last successful bounded read, processing watermark/run ID, window, rows visited,
historical rows, gaps, continuation flag, policy revision and cumulative failures.
A failed source read cannot fall back to evaluating only the live callback.
Failure diagnostics are best-effort with a separate 500 ms budget when the caller
is canceled; if MongoDB itself is unavailable, persistence cannot be guaranteed.
Current Inventory identity read failures invalidate pending timing. Meta exposes
worker state, tick failures and callback failures as process-lifetime counters;
these runtime counters reset at restart, while per-rule diagnostics remain durable.
The existing rules page shows these facts separately from measurement and health.

Caught-up means the available bounded query succeeded; it is not proof of full
historical coverage, absence of future late writes, or a transaction snapshot.
Cross-collection reads remain eventually consistent. Data inserted later with an
older observation time, outside the forward watermark/window, is not retroactively
applied to published incidents. Overlong downtime resets pending timing at the
lookback boundary and reports a gap. No archival replay, automatic repair,
lossless notification guarantee or multi-controller lease is introduced.

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

## Policy closure, notification and investigation

The same rule CAS stores a private metricClosure intent on app_nf_alert_rules.
The existing open alert is resolved before another evaluation of that rule. The
worker includes disabled rules with pending closure intents, so a controller
restart after the CAS can finish closure without a target or telemetry read.
Closure retries select older rule revisions and reuse the exact resolution time;
re-emission uses the existing alert/event/channel outbox key. The intent clears
only after alert persistence and best-effort notification publication. A failed
post-CAS close can return an error after the rule revision has committed; clients
must reload the current rule before editing again. No Mongo transaction or new
collection/index is required. Deletion first finishes any earlier policy closure,
then retains the existing rule_deleted behavior.

NF notification deliveries and webhook payloads add optional metric and
resolvedReason fields. The metric summary includes trigger rule revision,
condition, retained trigger proof and optional measured recovery proof. Legacy
payload fields and outbox keys remain unchanged. Delayed escalations retain the
same snapshot and the existing worker skips them when the alert is resolved.
Sink failures remain best effort, not guaranteed lossless delivery.

Investigation uses explicit nested field projections from retained alerts, with
no raw sample dependency and no raw labels, endpoints or private source content.
Its anchor and alert timeline include the condition, version, trigger/recovery
summaries and closure reason. Missing raw samples do not erase this explanation;
the UI states that raw evidence may have expired rather than asserting a TTL
lookup it has not performed. Reads remain pure, bounded and core.read protected.
