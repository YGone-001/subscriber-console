# Configuration drift alerts

The Go controller evaluates published, explicitly declared local configuration observations against an accepted baseline. Drift is independent from NF Health alerts. It does not collect on reads, write network configuration, install packages, execute commands or extend the read-only Agent protocol.

## Evidence and lifecycle

Each source has an opt-in policy, initially disabled with warning severity. Enabling requires a usable explicit Inventory resource binding. Only subsequent observations are evaluated; enabling does not reinterpret historical snapshots. Severity changes apply to new episodes. Existing episodes retain their opening severity and policy revision.

Observation.changed retains its adjacent-observation meaning. A separate immutable input binds the baseline ID and revision, generation, profile, resource, policy revision, observation/snapshot references and comparison while holding the source lease. No private HMAC, key version, original configuration, path or projection body is copied into a drift input, alert, event, audit entry or webhook.

| Input | Evaluation | Episode |
|---|---|---|
| No baseline / binding | not_armed | No new episode |
| Successful compatible comparison equal to baseline | in_sync | Close with returned_to_baseline |
| Visible or unprojected difference | drifted | Open or update one episode |
| Unreadable, changing or pending publication | evaluation_unavailable | Preserve last verified fact; no recovery |
| Incompatible comparison | comparison_unavailable | Preserve episode; no recovery |
| Baseline replaced / cleared | awaiting_observation / not_armed | baseline_superseded / baseline_removed |
| Policy disabled | disabled | policy_disabled |
| Explicit source withdrawal / reconfiguration / resource retirement | comparison_unavailable | source_withdrawn / source_reconfigured / resource_retired |

An invalid manifest and an unavailable Inventory read do not prove withdrawal or retirement. Lifecycle is active, acknowledged or resolved; endReason distinguishes recovery from administrative closure. Acknowledgment only records awareness. Resolving an investigation changes only the operator's investigation record. Missing projected content is never interpreted as a particular changed secret field.

## Ordered publication and crash recovery

Policy ownership remains in app_config_sources alongside the existing source lease and version CAS. This is deliberate: the policy, baseline controls and their replay inputs must commit atomically with their authoritative owner. app_config_drift_sources owns evaluation progress and projection journals, rather than a second independent policy copy.

The source document has a monotonic driftSequence and a bounded driftQueue of 256 positive inputs. Publication binds its input before preparation; the existing Pending publication journal keeps it through interruption. The input enters the queue in the same CAS that finishes publication. Only fully published observations enter evaluation. Baseline and policy controls append an input in the same source-document CAS as the control change. Generation changes reserve space for both the administrative input and the observation. An orphan unpublished preparation cannot be attached to a newer source version.

Queue capacity applies backpressure before publication. Inputs are not silently discarded. Workers serialize each source through the existing lease, with two source workers and at most 32 inputs per source visit. A sequence gap or unsupported input version stops processing. Wall-clock timestamps never substitute for order or the baseline-cycle fence.

The evaluator first commits progress, current episode and a Pending mutation together in one app_config_drift_sources CAS. It then idempotently materializes the alert and immutable event, persists notification intentions, and clears Pending. A failure at any boundary leaves replay state. Source queue removal follows successful consumption; duplicate replay is harmless. Acknowledgment uses the same evaluator-document CAS and projection journal. The worker also repairs this journal when no new observation exists. GET endpoints never repair or write this state.

## Storage and bounded reads

All writes use the existing Ops database handle:

- app_config_sources: source-owned policy and ordered publication/control queue.
- app_config_drift_sources: processing sequence, last evaluation, current episode and Pending projection.
- app_config_drift_alerts: materialized immutable identity/baseline context plus governed lifecycle.
- app_config_drift_events: immutable episode events.
- Existing notification deliveries and investigations retain their owners.

There is no cross-database write, transaction assumption or Inventory/Topology/NF Health mutation. A unique partial index permits one open episode per source. The evaluator CAS and contiguous sequence enforce order independently of wall-clock timestamps. Explicit config-drift-init defaults to a no-connection dry run and applies indexes only with --apply; normal startup does not create drift indexes.

Queries have two-second budgets; combined HTTP reads have eight seconds. Lists default to 50 and cap at 200; request bodies cap at 16 KiB. Cursors bind filters and the resolved group-scope fingerprint. ResolveGroupScope supplies explicit membership; unavailable resolution fails closed and partial scope suppresses complete totals. Alert summaries cover the entire selected filter, independently from the current page. Cross-collection observations are eventually consistent.

Hourly bounded retention expires resolved episodes after 90 days. Current episodes, Pending projection journals and nonterminal delivery intentions are protected. Work stops if protection scans exceed 4096 sources or 10000 pending delivery rows. A batch contains at most 1000 expired alerts. Expiration is marked before event deletion, allowing restart and preventing a retained-looking alert with an empty history. Open episodes, source journals and evaluation progress have no TTL. Old configuration versions can become unavailable under the configuration module's separate retention; evidence links report this explicitly.

## API and permissions

Seven Go registrations use the existing session cookie and three-role model. Reads require core.read; writes require core.configure, Fresh Actor, explicit revision checks and best-effort audit. Read/write limits are 120/30 per minute. All responses use no-store.

| Method | Path |
|---|---|
| GET | /api/config-drift/meta |
| GET | /api/config-drift/sources/{sourceId}/policy |
| PUT | /api/config-drift/sources/{sourceId}/policy |
| GET | /api/config-drift/alerts |
| GET | /api/config-drift/alerts/{driftAlertId} |
| POST | /api/config-drift/alerts/{driftAlertId}/acknowledge |
| GET | /api/config-drift/alerts/{driftAlertId}/events |

Policy writes require explicit expectedRevision, enabled and severity. Initial expectedRevision is 0. Alert acknowledgment requires a positive expectedRevision. There are no approval records. No browser-supplied path, command, SQL or raw configuration is accepted.

## Notifications and investigation compatibility

Configuration subscriptions explicitly include subjectKinds=config_drift, with optional sourceIds. Missing subjectKinds retains the old NF-only meaning; ruleIds retain their NF semantics. Notification writes in the controller perform Fresh Actor revalidation. Configuration delivery records use subjectKind/subjectId/sourceId/resourceId and a versioned webhook payload. They never populate an NF alertId or targetId with a configuration ID. The existing NF webhook JSON remains unchanged.

Only the notification worker sends webhooks. Opening and genuine recovery persist idempotent intentions; administrative endings do not produce a fake recovery notification. Late escalations read the real kind-specific lifecycle; unavailable or unknown state is retried, and verified resolved state is skipped. Sending claims have a bounded lease so interrupted sends can be retried. Network delivery is at least once, with receiver idempotency keys, not exactly once.

Investigations accept anchorKind=nf_alert|config_drift and anchorId as an additive alternative to alertId. Mixed identity forms are rejected. Legacy requests and records remain NF-compatible; old list requests remain NF-only. Explicit anchorKind=all includes both domains. Configuration IDs are never written into Record.AlertID. A configuration anchor carries its fixed resource, baseline cycle and trigger/latest evidence references; one-hop correlation, coverage, fixed saved windows, operator conclusions, CAS and knowledge references retain their existing meaning.

## SPA integration

The existing /nf-alerts route has a configuration view with URL filters, contextual detail return, acknowledgment, safe diff links, events, delivery records and investigation entry. No SPA route is added. Configuration source details show policy, last verified time, baseline cycle, queue progress and freshness. Manual sources show an observation time rather than current freshness. Policy conflicts retain drafts, and failed reads hide stale scope evidence. Existing shared fields, dialogs, pagination, feedback, guards, tokens, locales and cancellation-aware SWR reads are reused.

The package-layout declaration example uses /etc/xCloud and 54 explicitly reviewed paths from the supplied EPC/5GC/IMS packages. This is an editable declaration example, not recursive discovery or evidence of installation. The legacy source-tree example is retained separately. No deb installer or automatic baseline initialization is implemented.

See [operations](../operations/configuration-drift.md), [configuration observations](configuration-snapshots.md) and [investigations](alert-investigations.md). Real deployment and notification-receiver acceptance are separate from isolated browser/database validation.
