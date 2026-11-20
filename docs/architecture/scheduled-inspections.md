# Scheduled inspections

Status: implemented in source. Real-source coverage, activation and multi-host
acceptance are separate from isolated fixture validation.

The Go-owned inspection service summarizes evidence that already exists. It does
not trigger collection, contact NFs, read configuration files, change baselines,
acknowledge alerts, execute commands or extend the Agent protocol. Inventory,
Topology, NF Health, configuration observations, drift episodes and Agent reports
remain their existing authorities.

## Scope and evidence

The service lives in `backend/internal/inspections`; the UI lives in
`frontend/src/features/inspections`. Eleven additive APIs are declared in
`frontend/inspections-contract.json`. Four SPA routes cover the directory, new
plan, plan detail and fixed run report. The directory and details use the existing
operations page frame, navigation, read client and mutation client.

A plan explicitly selects all current resources, an intersection of the existing
group selectors, or at most 200 resource UUIDs. Group mode uses
`operationsview.ResolveGroupScope`; failed or partial identity resolution never
broadens the request. Retired resources are excluded. Execution saves the chosen
selectors and the resolved resource names, identities and membership fingerprint.
Network/operator/PLMN assignments remain metadata, not tenant isolation.

Agent identity is separate from NF identity. Registered Agent scope is resolved
independently, capped at 100, and captured with assignment revisions. A domain
selection cannot be silently ignored for Agents: unsupported attribution remains
unavailable. Agent connectivity never establishes NF health or historical uptime.

Five check families read bounded evidence:

- Monitoring checks include the full NF population in scope, including NFs with
  no target. They reuse NF Health freshness, validate target/run/sample/resource
  identity and accepted measurement time, preserve layer states, and never hide a
  failed latest collection behind an older successful sample.
- Configuration uses declared source views, published observation identity and
  generation, applicable baseline and pending-publication state. The plan's age
  cap is 300 to 604800 seconds; scheduled sources also use interval plus 300
  seconds, taking the smaller cap. No configuration body or fingerprint is stored.
- Drift reads the existing engine's policy, sequence, input cycle and evaluation.
  It cannot reconstruct equality from a missing alert or complete a pending
  evaluation. An applicable open episode remains a finding.
- NF and configuration alerts are separately grouped by canonical resource ID
  using all matching unresolved records, not a browser page. A zero means no
  matching unresolved records at read time, not historical health.
- Agent connectivity uses server receipt time and the existing status helper.
  Missing registration, changed assignment and future timestamps are explicit
  gaps. Local-only plans can omit this check.

Each check stores result, reason, safe evidence references, read time, observation
time and age policy. Source completeness is independent from findings. A
completed run can be inconclusive or contain findings. Pass requires a nonempty
scope, complete selected sources, at least one valid passed check and no unknown
checks. No score, SLA, automatic cause or service-availability claim is generated.

## Plans, scheduling and execution

Plans default to paused. Reads need `core.read`; preview needs `core.configure`.
Creation, editing, enable/disable, archive and immediate execution use
`core.configure`, Fresh Actor, bounded input, CAS/idempotency and best-effort audit.
Viewer mutations return 403. A paused plan may run manually. Archiving requires
disabled state and no active execution. Pausing remains available when unchanged
source selection cannot currently be read.

Calendar plans save an IANA timezone and local time; interval plans save elapsed
seconds. The UI offers 15 minutes, one hour, four hours, daily and weekly, with the
next five valid occurrences previewed. Calendar arithmetic follows local dates;
repeated DST minutes use their first occurrence. A missing wall-clock time is
recorded as skipped on that local day, stamped at the first actual minute after
the gap. UTC is the storage time representation.

The scheduler is inside the existing Go controller, with two execution slots,
one active run per plan, a 20-run waiting bound and a 15-second scheduling scan.
Manual and scheduled admission share the same bounds. No second daemon or
browser-generated background identity exists.

An atomic plan journal first saves the active run ID and pending run. The run
projection is materialized idempotently, then the pending journal is removed.
Scheduled IDs derive from plan ID, schedule revision and scheduled time. Manual
IDs derive from plan ID, actor and request UUID, with a separate request digest;
the same key with different content conflicts. A returned 202 is durable even
before projection, and a disconnected browser does not cancel execution.

Run claim is a state CAS with a 60-second lease. A worker has a 30-second deadline;
finish requires the current token and unexpired lease. Expired workers cannot
overwrite recovery. The background recovery pass closes expired runs as
interrupted and releases their plans. It never uses later evidence to repair an
old report into a historical success. Reads perform no recovery writes.

Queued runs revalidate plan revision and their execution actor before starting.
Already-started executions use their captured definition. Automatic scheduling
revalidates the enabling operator against the current account store; missing,
disabled, locked or unauthorized operators suspend future scheduling. A transient
identity-store outage is unavailable, not permanent loss of authorization.

The late-start grace is five minutes. Beyond it, a missed summary preserves the
time range and bounded count, then advances the schedule without collecting.
Long outages do not produce an unbounded burst of catch-up work. Busy plans
record skipped occurrences; capacity backpressure leaves due work explicit.

## Fixed reports and comparisons

Only `xcloud_ops.app_inspection_plans` and `app_inspection_runs` are new domain
write collections. The module retains the existing Mongo client and Ops handle.
The report document contains at most 2000 safe items and 2 MiB, allowing atomic
publication. Item cursors and directory cursors are HMAC-protected and bound to
their filters. Export and detail read the same saved run; they never regenerate
evidence from current source state.

Source reads occur within an execution interval, with independent read times and
eventual consistency. The report is not a multi-collection transaction snapshot.
Stored summaries remain readable when source samples expire; links to original
workspaces can become unavailable. Reports do not copy raw metrics arrays,
configuration projections, fingerprints, logs, SQL, credentials or Agent secrets.

Previous-report comparison requires compatible check versions, age policy and
stable item identity. Changed scope adds/removes members explicitly. Only a valid
new pass can mark a prior finding not redetected; unknown, removed or incompatible
items never become recoveries. Existing alert anchors may enter investigations;
unanchored findings do not create alerts or new investigation anchor kinds.

New compatible reports save additive `comparison.scopeChanges` with individual
added/removed resource and Agent facts from the two captured populations. Resource
and Agent completeness are checked independently: each pair of arrays is `null`
when either population is incomplete, and `[]` means a complete, empty difference.
Canonical UUIDs determine membership; renames and Agent assignment revisions do
not create additions/removals. Removed names come from the previous fixed report.
Legacy reports omit the field and retain unavailable detail; reads never backfill
history. JSON and the existing CSV `comparison` column carry the same saved delta,
within the existing atomic report budget. Existing comparison counters count check
items, not distinct resource/Agent members.

## Initialization, bounds and retention

`backend/cmd/inspections-init` is an explicit, dry-run-default index initializer.
`--apply` creates only module indexes. Startup and GETs create no indexes. Missing
index readiness prevents enabling or executing plans; failure counts are null.

The retained-report budget reserves each run at its maximum 2 MiB: 512 retained or
journal-reserved reports consume the 1 GiB report budget. This is a conservative
reservation, not a measurement of occupied bytes. Pending reports participate in
admission. Capacity exhaustion blocks new work; it does not silently delete
reports early. Terminal reports expire after at most 90 days using a BSON Date TTL
field; active runs and plans have no TTL. Archived plan metadata remains.

Mongo queries have two-second contexts; an execution has 30 seconds. Resource,
Agent and configuration bounds are 200, 100 and 128. Scope overflow fails before
evaluation; partial source reads remain explicit. API body, response, page and
export budgets are bounded. CSV formula prefixes are escaped; JSON uses the same
safe report projection. No independent inspection notification subject is added.
