# NF Discovery Foundation

> Current-system documentation for the vendor-neutral, read-only NF discovery
> observation plane. It describes the implemented backend, persistence, API,
> security and UI model. The runtime described here is the current `develop`
> state; when this document and the running source disagree, the source and the
> automated tests prevail.

Related documents:

- [NF discovery runbook](../operations/nf-discovery-runbook.md)
- [Inventory resource model](inventory-resource-model.md)
- [Topology dependency model](topology-dependency-model.md)
- [System architecture](system-architecture.md)
- [Feature + UI/UX completion gate](stage-feature-ui-acceptance.md)

## 1. Purpose and Scope

Discovery observes network-function candidates from an approved registry
endpoint and records them as **observation evidence**. It is not an Inventory
provisioner, a Topology writer, a health monitor, or a generic HTTP proxy.

```text
Approved registry (allowlisted)
   |
   | bounded read-only GET
   v
NRF adapter (3GPP NFManagement collection)
   |
   v
app_nf_observations  (candidate evidence)
   |
   | operator link / unlink (metadata only)
   v
Inventory resource UUID reference
```

Fundamental invariants:

```text
Inventory owns resource identity.
Discovery owns observation evidence.
Topology owns declared relationships.
Observation state is not operational health.
```

### 1.1 What observation state means

| State | Meaning |
|---|---|
| `seen` | Present in the latest complete successful scan |
| `missing` | Absent from a complete successful scan that previously saw it |
| `stale` | Seen evidence whose last real observation is older than 3× the source scan interval (scheduled sources only) |

Registry status (`REGISTERED`, `SUSPENDED`, and so on) is a separate axis and is
never collapsed into observation state, Inventory lifecycle, Topology lifecycle,
or an online/offline health flag.

A failed or truncated scan never marks candidates missing. Absence is inferred
only from a complete, untruncated successful scan.

## 2. Persistence

Three collections, all in `xcloud_ops`, none in `xcloud`:

```text
app_discovery_sources    registry endpoint configuration
app_discovery_runs       bounded scan execution history
app_nf_observations      NF candidate observation evidence
```

No other discovery collection is created. Candidate identity is unique per
`(sourceId, externalNfInstanceId)` and is never TTL-deleted.

### 2.1 Adapter vocabulary

The adapter type identifier is the neutral value `nrf`. Source code, API
payloads, locale keys and fixtures use vendor-neutral vocabulary only.

### 2.2 NRF API support boundary

The NRF adapter performs bounded, read-only observation. Its precise 3GPP
service support is:

```text
implemented : Nnrf_NFManagement GET  /nnrf-nfm/v1/nf-instances        (collection)
implemented : Nnrf_NFManagement GET  /nnrf-nfm/v1/nf-instances/{id}   (NF profile)
not issued  : Nnrf_NFDiscovery search queries
not issued  : NF subscription create / delete
not issued  : PUT / PATCH / DELETE on any NF registration resource
```

`enrichFromDiscovery()` is a reserved extension point that performs no network
I/O in this build. Observation batches are assembled exclusively from the
verified NFManagement collection and per-profile GET operations. No speculative
3GPP query parameters and no generic collection read are issued. Wire-format
helpers that understand alternate NFProfile spellings are decoding tolerance
only and do not imply a second protocol path.

## 3. API Surface

Exactly 12 Go registrations (7 read + 5 mutation), 2 SPA routes, and no
hard-delete endpoint.

```text
GET    /api/discovery/meta
GET    /api/discovery/sources
GET    /api/discovery/sources/{sourceId}
GET    /api/discovery/runs
GET    /api/discovery/runs/{runId}
GET    /api/discovery/candidates
GET    /api/discovery/candidates/{candidateId}
POST   /api/discovery/sources
PUT    /api/discovery/sources/{sourceId}
POST   /api/discovery/sources/{sourceId}/scan
POST   /api/discovery/candidates/{candidateId}/link
POST   /api/discovery/candidates/{candidateId}/unlink
```

```text
/discovery
/discovery/sources/:sourceId
```

- Reads require `core.read`.
- Mutations require `core.configure`.
- Link and unlink write discovery metadata only. They never create, update or
  delete Inventory resources and never create Topology edges.
- Scheduled scanning is additive: no route is added, and source responses gain
  `scanIntervalSeconds` plus the derived `nextScanAt`; runs gain `trigger`.
  Older clients that omit `scanIntervalSeconds` on create receive the server
  default, while pre-existing source documents remain manual-only.

## 4. Security Boundary

- Destination allowlist `DISCOVERY_ALLOWED_TARGETS`, default deny.
- Unapproved destinations return HTTP 403 `DISCOVERY_TARGET_NOT_ALLOWED`.
- Redirects are rejected. Unsupported schemes, user-info URLs and fragment-based
  target changes are rejected. Cross-origin profile links are rejected.
- Transport verification never uses `InsecureSkipVerify`.
- Responses are bounded; oversized or unbounded payloads fail the scan.
- There is no generic URL-fetch, remote-shell, command-execution, NF control or
  subscription-creation endpoint.
- Browser users never control a backend HTTP proxy.

## 5. Scan Semantics

- One active scan per source and globally, shared by manual and scheduled
  scans through a single in-process scanner.
- Per-source minimum scan interval 60 seconds. Repeat manual scans return HTTP
  429 `DISCOVERY_SCAN_RATE_LIMITED` with `Retry-After`.
- `MarkMissing` runs only when the scan batch is complete.
- Truncated scans record `partial` and explicitly state that absence was not
  inferred.

### 5.1 Scheduled scanning

Each source carries `scanIntervalSeconds`:

```text
0                    manual only; the scheduler never starts a scan
60 .. 86400          scheduled cadence in seconds
omitted on create    server default 300 seconds
existing documents   decode as 0, so deployment never starts silent egress;
                     an operator opts in by setting an interval
```

The scheduler is part of the existing Go process, not a second daemon. It ticks
every 30 seconds and starts at most one scan per tick, because the global
live-scan bound is one. Due-ness is evaluated per source from the persisted
`lastScanAt` (or `createdAt` when never scanned) plus the interval; the
scheduler never scans early after a restart. A disabled source and a source with
interval 0 are never due. The scheduler calls the same scanner as the manual
endpoint, so per-source and global single-flight always hold across both entry
points.

`nextScanAt` is a response-only projection of that same cadence basis. It is
never persisted, and it is absent for disabled or manual-only sources. A
scheduled run records `trigger=scheduled` and `initiatedBy=scheduler`; a manual
run records `trigger=manual` and the operator identity. Scheduled runs do not
write the per-request user audit stream; the run document is their execution
evidence. Failed and truncated scheduled scans follow the same rules as manual
scans and never infer absence.

Scheduled sources also age their own evidence. After every scan attempt, a
`seen` candidate whose `lastSeenAt` is older than three scan intervals becomes
`stale`. The sweep never touches `missing` (absence from a complete scan is not
overwritten), preserves `lastSeenAt` and Inventory associations, and a later
successful observation restores the same candidate to `seen`. Manual-only
sources promise no cadence and therefore never age evidence.

### 5.2 Observation and scan timestamps

```text
lastSeenAt     moves only when an NF is actually observed again
firstSeenAt    set once at first observation, never rewritten
MarkMissing    sets observationState=missing and preserves lastSeenAt
lastScanAt     moves on every attempted scan with its actual completion time
lastSuccessAt  moves only on a complete, untruncated successful scan
```

Absence is not an observation event: marking a candidate missing never
fabricates an observation timestamp. Candidate identity (`candidateId`,
`externalNfInstanceId`) and Inventory associations (`linkedResourceId`) are
preserved across the absence transition.

Partial and failed attempts never move `lastSuccessAt`. They stay
distinguishable through the run status (`partial` versus `failed`) and through
the source `lastError` value (`scan truncated; absence not inferred` versus the
classified failure summary).

### 5.3 Build toolchain

The discovery backend is verified on Linux with the module-declared toolchain:

```text
go version      go1.24.0 linux/amd64
GOTOOLCHAIN     auto
go.mod          module subscriber / go 1.24.0
```

The module Go version is authoritative and is not downgraded.

## 6. UI Integration

Discovery is a native xCloud module:

- Shared design tokens and shared UI primitives.
- Shared navigation authority (sidebar, tab bar, breadcrumbs, command palette).
- Bilingual locale keys under `nav_discovery` / `discovery_*`.
- Observation state is rendered separately from registry status and never as a
  health flag.
- The source list and edit form expose the scan interval; the detail surface
  shows the derived next scan time; scan history distinguishes manual from
  scheduled triggers. Interval `0` is labelled as manual-only, not as an error.

## 7. Explicit Non-Goals

This foundation implements one in-process scheduler, but does not implement a
separate discovery worker process or daemon, NF health
monitoring, KPI telemetry, PCAP/HEP capture, tracing, alarm correlation, AIOps
RCA, remote shell execution, automated Inventory provisioning, automated
Topology rewriting, or closed-loop operations.
