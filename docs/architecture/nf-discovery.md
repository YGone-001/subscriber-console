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
| `stale` | Retained evidence that is no longer fresh under the observation policy |

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

- One active scan per source and globally.
- Per-source minimum scan interval 60 seconds. Repeat scans return HTTP 429
  `DISCOVERY_SCAN_RATE_LIMITED` with `Retry-After`.
- `MarkMissing` runs only when the scan batch is complete.
- Truncated scans record `partial` and explicitly state that absence was not
  inferred.

## 6. UI Integration

Discovery is a native xCloud module:

- Shared design tokens and shared UI primitives.
- Shared navigation authority (sidebar, tab bar, breadcrumbs, command palette).
- Bilingual locale keys under `nav_discovery` / `discovery_*`.
- Observation state is rendered separately from registry status and never as a
  health flag.

## 7. Explicit Non-Goals

This foundation does not implement recurring discovery workers, NF health
monitoring, KPI telemetry, PCAP/HEP capture, tracing, alarm correlation, AIOps
RCA, remote shell execution, automated Inventory provisioning, automated
Topology rewriting, or closed-loop operations.
