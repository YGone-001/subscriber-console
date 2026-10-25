# Runtime Discovery (CNMS-Compatible Local Process Recognition)

Status: implemented. This document describes the current behaviour of the
read-only local process scanner, the CNMS compatibility registry, the runtime
status model and the governed monitoring bootstrap. It is a description of the
running system, not a roadmap.

## 1. Purpose

xCloud must recognise the local network-function processes of the host it runs
on, without requiring an operator to register anything first. The capability is
migrated from the CNMS reference implementation (`backend/internal/monitor/*`),
but the xCloud architecture is preserved:

- **Inventory** remains the only canonical resource authority.
- **NF Health** remains the only monitoring authority.
- **Topology** remains edge-only, with Inventory as the node authority.
- **Discovery** (NRF) remains an independent, read-only evidence source.

Runtime discovery only *observes* and only *proposes*. It never starts, stops,
signals, reconfigures or probes a network function.

## 2. Recognition registry (single authority)

`backend/internal/runtimeinv/registry.go` is the only process-recognition
authority in the product. The scanner, the API projection and the frontend
status model all consume the same registry; the frontend contains no process
name table.

The registry contains **26 effective recognition entries**:

| Category | Entries | Notes |
|---|---|---|
| 5GC | 12 | 11 CNMS components + `seppd` (xCloud-only, preserved) |
| EPC | 7 | CNMS components, including `pgwcd` / `pgwud` |
| IMS | 5 | 4 CNMS components + `smscd` (xCloud-only, preserved) |
| Charging | 1 | `ocsd`, canonical `charging` domain |
| Support | 1 | `drad` |

Of these, **24 are CNMS-compatible component definitions** and **2 are
xCloud-only identities** that already existed before this phase and must never
be removed: `seppd` (5GC SEPP) and `smscd` (IMS SMSC).

### 2.1 Matching methods

- `exact_process_name`: `/proc/<pid>/comm` must equal the configured name
  exactly. Because the kernel truncates `comm` to 15 bytes, a configured name
  longer than that is resolved through the verified executable basename instead;
  the executable is only consulted for entries whose `comm` is at the limit.
- `java_command_line_identity`: the executable basename must be `java`, and an
  approved launch token must occupy a launch-identity position in the bounded
  command-line projection.

### 2.2 IMS HSS

CNMS matches the IMS HSS by substring against Java arguments
(`HSSContainer`, `imsHss`, `FHoSS`). That is treated as a compatibility hint,
not proof. xCloud requires **both**:

1. a verified executable identity (`java`), and
2. an approved token in a launch-identity position: a positional argument (main
   class, jar path, classpath entry) or the argument following `-jar`.

A token that appears only inside a JVM option (for example
`-Dnote=FHoSS`) leaves the candidate **unverified**. Whole-segment matching
prevents `HSSContainerManagerHelper` or `FHoSS-test-notes.jar` from being
accepted. The raw command line is never persisted, returned or audited; only the
approved token name and the reason code are retained.

IMS HSS is never classified as an EPC HSS instance. It is adopted into Inventory as
an `ims` / `hss` resource, but it is never given an NF Health target or a process
binding: its process identity is the shared `java` launcher, so a binding keyed on
that name would match every JVM on the host. The resource therefore carries no
measurement at all - it shows as unmonitored, never as healthy and never as a
fabricated target.

### 2.3 Approved executable aliases

The exact-name strategy compares the verified `/proc/<pid>/exe` **basename** with
the component's `processName`, so install paths never matter while the file name
always does. Some SIP stacks (Kamailio) rewrite their process title per role, which
makes `comm` report `pcscfd` while the executable behind it is `kamailio`; the exact
rule alone could never verify them.

A component may therefore declare `exeAliases`:

- an alias only widens the executable check for a component whose `comm` already
  matched exactly - it never identifies a process on its own;
- aliases are server-owned registry data, never client input;
- an alias that equals another component's exact `processName` makes the registry
  fail to load, so no role can vouch for another;
- the approved set is currently `kamailio` for `pcscf`, `icscf`, `scscf` and `smsc`,
  evidenced by the shared Kamailio command-line signature (`-f <cfg> -P /<role>.pid
  -DD -E -e`) across those roles.

## 3. Scanning

`backend/internal/runtimeinv/scanner.go` performs one bounded, read-only pass
over an injectable procfs root:

1. list numeric `/proc` entries (bounded, ascending, deterministic);
2. read `comm`; count unreadable entries;
3. verify `/proc/<pid>/exe` for every name candidate;
4. read `/proc/<pid>/stat` for start ticks and CPU time;
5. read `/proc/<pid>/status` for RSS / VMS;
6. derive per-component evidence, CPU and memory.

Bounds: at most 8192 process entries, 4096 bytes and 64 argv elements per
command line, 64 retained workers per component and 8 reported worker
identities. One scan runs at a time per backend instance.

### 3.1 Identity verification

- A name match alone is never a verified match.
- The executable basename must equal the approved process name.
- Start ticks are recorded per worker; a PID whose start ticks changed is a
  reused identifier and never inherits the previous CPU delta.
- An unreadable executable is reported as `permission_denied` when the failure
  is a permission error, otherwise `unverified`.

### 3.2 Workers

Multiple verified workers are retained (bounded) and reported as a worker count.
The primary PID is the earliest-started worker with the lowest PID as a
deterministic tie-break. Resource values describe the verified process group,
and the basis is published with every value (`interval_delta_verified_group`,
`verified_group_aggregate`).

### 3.3 CPU and memory

- CPU is `delta(utime+stime) / USER_HZ / elapsed_seconds * 100`. The first scan
  has no interval, so CPU is `null` with `cpuAvailable=false`. Cumulative CPU
  time is never rendered as a percentage.
- A failed measurement is never reported as `0`.
- Memory is the sum over the verified group; if any worker's RSS is missing the
  aggregate is unavailable rather than silently partial.
- `memoryPercent` is only produced when the host total memory is known.

## 4. Status model

| Status | Meaning |
|---|---|
| `running` | A compatible executable was positively verified in a successful scan. |
| `stopped` | A previously observed or explicitly expected service was absent from a **complete** scan. |
| `unverified` | A candidate was found but its identity could not be verified. |
| `permission_denied` | Inspection failed because of permissions. |
| `unknown` | Insufficient evidence (for example an incomplete scan). |
| `stale` | The last accepted observation exceeded the freshness policy. |
| `not_detected` | Recognised but never observed and not explicitly expected. |
| `not_configured` | The scanner is disabled or the component is outside the active profile. |
| `not_applicable` | The component cannot be evaluated in this environment. |

Critical rule: **a process-inspection failure never establishes `stopped`**, and
an incomplete scan converts an otherwise-absent component into `unknown`.
`stopped` requires either a previous positive observation or an explicit
expectation (`LOCAL_NF_DISCOVERY_EXPECTED`), plus a complete scan.

Freshness: an accepted observation expires after `max(3 x interval, 30s)`. An
expired observation becomes `stale` and keeps its previous status in
`previousStatus`.

## 5. Host identity and visibility

The host identity is a truncated SHA-256 digest of `/etc/machine-id` (falling
back to the hostname) and is namespaced as `host-...`. The raw machine
identifier is never returned. Browser-provided hostnames, IP claims, process
display names and NRF observations are never used as identity.

A container marker or a container cgroup yields
`visibility=container_limited`. In that case the scanner reports its actual
boundary and never reports unseen host processes as stopped.

## 6. Deployment templates

Templates are view and expectation profiles only. They never start, stop or
reconfigure anything, and they never change a component's runtime status.

| Template | Contents |
|---|---|
| `auto` | all 26 recognition entries |
| `5g` | CNMS 5GC (11) + IMS (4) + `seppd` |
| `4g` | CNMS EPC (7) + IMS (4) + support (DRA) + `smscd` |
| `ims` | CNMS IMS (4) + `smscd` |

OCS keeps the canonical `charging` domain and is not folded into `4g`, unlike
the original CNMS classification.

## 7. Governed bootstrap

`POST /api/runtime/bootstrap/preview` produces a bounded plan; `apply` executes
an approved plan.

Adoptability and measurement eligibility are two separate registry decisions.
Adoptability answers "may this verified component become an Inventory resource";
measurement eligibility answers "may it own an NF Health target and a process
binding". Every NF-Health-eligible component is adoptable, but the registry can
withhold measurement alone: the Java IMS HSS has a launch-identifier identity that
cannot scope a process binding, so it is adopted as an `ims/hss` resource while
staying unmeasured.

Decision order per component:

1. not adoptable (DRA) -> `skip_monitoring_unsupported`;
2. not verified running -> `skip_not_running`;
3. a discovered resource exists for the stable key -> `reuse_resource`;
4. exactly one compatible resource (same kind, domain, role) -> `reuse_resource`;
5. more than one -> `skip_ambiguous`;
6. none -> `create_resource`;
7. adoptable, resource decided, but not NF-Health-eligible (IMS HSS) -> no target
   and no binding are proposed; the entry keeps an empty `targetAction`.

An unmeasurable adoption never fabricates a collector: the resource is created
without an NF Health target, so it is reported as unmonitored rather than shown as
a healthy or unknown process target.

Stable key: `xrt:<hostId>:<componentId>:<processName>`. A PID is never part of
it.

The plan identifier is a digest of the runtime identity inputs a client cannot
influence (host, template, component, process, domain, role, status, verified).
Inventory or target state is excluded, so an approved plan can be applied
idempotently. A changed runtime identity invalidates the plan with
`RUNTIME_BOOTSTRAP_STALE_PREVIEW`.

### 7.1 Inventory creation

Discovered resources are created through a dedicated server-authoritative path
with `source.kind = discovered`, `source.system = xcloud-runtime`,
`source.authority = authoritative` and `source.externalId` set to the stable key.
Concurrency is resolved by the existing partial unique index
`uniq_inventory_source_external_id`: a duplicate insert re-reads the winner.

Lifecycle starts at `planned`. A running PID is not proof that the production
service carries traffic, so the bootstrap never promotes a resource to `active`,
never retires a resource when a process disappears, and never overwrites
manually maintained attributes.

### 7.2 NF Health binding

Bootstrap-installed bindings are persisted in
`xcloud_ops.app_nf_health_bindings` (`_id = resourceId`, unique `bindingKey`) and
loaded into the in-process registry at startup:

- static configuration (`NF_HEALTH_LOCAL_PROCESS_BINDINGS`) always wins;
- a dynamic binding that contradicts a static one is rejected;
- two resources can never claim the same `(host, process, NF type)`;
- the existing domain / NF type compatibility validation still applies, so an
  EPC MME resource can never bind to an IMS process.

Adopted targets use `collectorProfile=process_only`, `serviceKind=process`,
`collectionMode=scheduled` and a 120s interval, so L1 collection continues after
a backend restart. L2 and L3 stay `not_configured`.

## 8. API surface

| Method | Path | Permission |
|---|---|---|
| GET | `/api/runtime/meta` | `core.read` |
| GET | `/api/runtime/observations` | `core.read` |
| POST | `/api/runtime/scan` | `core.configure` |
| POST | `/api/runtime/bootstrap/preview` | `core.configure` |
| POST | `/api/runtime/bootstrap/apply` | `core.configure` |

`GET /api/runtime/observations` serves the cached snapshot and never starts a
scan. `POST /api/runtime/scan` is rate-limited and rejects overlapping scans.

## 9. Persistence

| Collection | Purpose |
|---|---|
| `xcloud_ops.app_runtime_component_state` | Cross-restart observation memory (`_id = hostId|componentId`) |
| `xcloud_ops.app_nf_health_bindings` | Bootstrap-installed process bindings |
| `xcloud_ops.app_inventory_resources` | Discovered resources (`source.externalId`) |
| `xcloud_ops.app_nf_health_targets` | Adopted monitoring targets (one per resource) |

## 10. Explicit non-goals

- No remote scanning, no SSH, no container privilege escalation.
- No process signals, restarts or systemd changes.
- No arbitrary PID inspection API, no client-specified paths or process names.
- No active SIP / Diameter / PFCP / NGAP probing.
- No fabricated topology edges: the observed hierarchy is derived from host and
  process membership and is never persisted as a protocol relationship.
- No NRF join by NF type or IP address: local process evidence and NRF
  registration evidence stay separate.

## 11. Configuration

```text
LOCAL_NF_DISCOVERY_ENABLED=true
LOCAL_NF_DISCOVERY_INTERVAL_SECONDS=10
LOCAL_NF_DISCOVERY_PROC_ROOT=/proc
LOCAL_NF_DISCOVERY_EXPECTED=          # comma-separated component ids
NF_HEALTH_LOCAL_PROCESS_BINDINGS=     # static bindings, always win
```
