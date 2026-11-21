# Metric threshold alerts

The source implements an opt-in single-observation gauge threshold in the existing
NF alert module. It does not implement duration rules, historical rollups or
statistical anomaly/trend detection. NF Health layer states and business-process
observations retain their existing meaning.

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
(`gt`, `gte`, `lt`, `lte`), threshold and recoveryThreshold. Both numeric fields
are mandatory finite nonnegative numbers; omitted/null is not zero. Unit and
measurement subject are server-owned, not request fields. Unknown fields are
rejected by the existing strict decoder.

A high-value trigger requires a recovery threshold no greater than the trigger;
low-value conditions reverse this. For equal thresholds the recovery comparison
is complementary: gt recovers at <=, gte at <, lt at >=, and lte at >. Between
thresholds an open alert remains open. Each fresh sample can trigger or recover
immediately. The repeated breach of the same incident does not increment the
metric alert triggerCount, overwrite trigger evidence, or emit another open event.
The legacy cooldown/recount semantics are unchanged.

Reads require core.read. Metric rule create/update/delete reuse core.configure
and additionally revalidate the fresh actor before persistence. The production
metric target reader reuses collection-time Inventory identity validation, so
retired/missing/retyped resources are rejected. A rule requires an enabled,
Inventory-bound HTTP metrics target; process_only is not eligible. Creation can
precede the first sample, but no measurement is invented. Metric identity,
operator and thresholds are fixed after creation; replacing those requires a new
rule. Names, enabled flag, severity and cooldown metadata remain mutable under
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
last evaluation quality/reason, and an optional display-safe transition journal.
It does not retain endpoints, labels, removed identifiers or raw response bodies.
Rule reads batch-project statuses by `_id`; the UI labels them as the last
evaluation, not current health. The existing rules/alerts collections remain owners.

One Go controller serializes metric evaluation and rule edits with a cancellable
process-local gate. State writes use revision CAS. This is not a distributed
lease or multi-controller guarantee. A transition is journaled before alert
publication and replayed idempotently after interruption. Opening uses a stable
rule/sample-based alert UUID; notifications reuse the existing outbox deduplication
key. The accepted watermark prevents equal-time/duplicate/older samples from
reopening an incident after recovery, including after controller restart. Distinct
samples with identical instants are conservatively not ordered. Incoherent
sample/run references cannot advance the accepted watermark.

Trigger evidence and rule configuration remain unchanged after opening. Recovery
adds a separate `metricRecovery` snapshot. Journaled work that expires before
publication is discarded as indeterminate and awaits fresh evidence; it cannot
produce an obsolete notification or fabricated recovery. Disable/delete cancels
unpublished work. No expired source sample is needed to display stored safe values.

Notification intent delivery retains the existing best-effort sink contract;
this feature does not promise lossless transport when the sink itself fails.
There is no background historical catch-up scanner yet. An interrupted journal
is revisited by the next metric evaluation or applicable authorized rule mutation.
The entire metric evaluation has a four-second deadline; status reads have a
two-second deadline. No worker or extra network probe is introduced.

## Rollback and operational checks

Set the feature flag false to stop new metric evaluation before any rollback.
It does not report measured recovery. Keep the state and alert collections; do
not remove watermarks or rewrite historical snapshots. An old binary does not
understand the new condition enum and must not evaluate enabled metric rules:
disable those rules first using the new binary. Retain the existing state/run_failed
rules and asynchronous notification infrastructure.

The automated evidence includes pure quality/comparison tests, HTTP permission
and fresh-actor tests, an isolated real-Mongo lifecycle/restart/journal test,
Linux race validation, frontend payload/rendering tests and fixture-backed browser
acceptance. These do not establish real NF exporter deployment acceptance or
permission to turn the feature on in production.
