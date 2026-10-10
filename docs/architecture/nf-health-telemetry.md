# NF Health / Telemetry Foundation

> Current-system documentation for the vendor-neutral, read-only network
> function health and telemetry plane. It describes the implemented backend,
> persistence, API, collector safety, metrics registry and UI model. The
> runtime described here is the current `develop` state; when this document and
> the running source disagree, the source and the automated tests prevail.

Related documents:

- [NF Health runbook](../operations/nf-health-runbook.md)
- [NF discovery foundation](nf-discovery.md)
- [Inventory resource model](inventory-resource-model.md)
- [Topology dependency model](topology-dependency-model.md)
- [System architecture](system-architecture.md)
- [Feature + UI/UX completion gate](stage-feature-ui-acceptance.md)

## 1. Purpose and Scope

NF Health observes operator-approved monitoring targets and records bounded,
time-stamped measurement evidence across three layers. It is not an Inventory
provisioner, a Topology writer, a Discovery scanner, a protocol-stack health
oracle, or a generic HTTP proxy.

```text
Operator-approved monitoring target
   |
   +-- L1 process / instance evidence   (read-only systemd show, or /proc scan)
   +-- L2 interface / endpoint evidence (bounded HTTP metrics GET)
   +-- L3 service / KPI evidence        (registry-supported metric samples)
   |
   v
app_nf_health_runs    (collection execution outcome)
app_nf_health_samples (bounded time-series measurement evidence)
```

Fundamental invariants:

```text
Inventory owns resource identity.
Topology owns declared relationships.
Discovery owns observation evidence.
NF Health owns operational measurement evidence.
System Health owns xCloud application/database integrity.
```

### 1.1 Hard semantic separations

```text
NRF REGISTERED          != process healthy
Metrics HTTP 200        != SBI / PFCP / NGAP / Diameter / SIP healthy
SBI endpoint reachable  != NGAP connected
Process active          != PFCP association established
NF discovered           != UE registration successful
UE registration         != IMS registration
```

Operational health is represented only by independent, explicitly identified
measurement evidence. Unsupported layers remain explicitly unverified and are
never collapsed into a healthy claim.

## 2. Three-Layer Health Model

### 2.1 L1 — Process / Instance

Measures whether an authorized, locally managed NF process or service exists
and is running.

Allowed evidence:

```text
systemd unit ActiveState
systemd unit SubState
systemd unit MainPID
read-only process presence (/proc comm scan)
```

L1 never infers state from NRF registration.

Outcomes:

```text
active | inactive | failed | unit_not_found | permission_denied | not_configured
running | not_running
```

### 2.2 L2 — Interface / Protocol Evidence

Measures an explicitly supported network endpoint. The only implemented
collector is the HTTP metrics endpoint probe.

```text
endpoint identity
HTTP status
response time
response content validation
collection error
timestamp
```

An HTTP 200 proves only that the probed endpoint answered. It does not prove
NGAP, PFCP, Diameter, SIP or all SBI services are functioning.

Outcomes:

```text
valid_response | connection_refused | timeout | invalid_response
http_4xx | http_5xx | collection_error | not_configured
```

Unsupported interface probes are never synthesised. UDP socket presence is not
PFCP association success. SCTP port presence is not NGAP health. No production
SIP call is ever generated.

### 2.3 L3 — Service / KPI Evidence

Records actual supported numeric service metrics with source, unit, type and
timestamp.

Unsupported KPI families stay `not_available` / `not_configured` with reason
`no_supported_service_kpi` or `metric_not_exported`. Missing metrics are never zero-filled.
A zero measurement is valid only when the exporter reports zero.

### 2.4 Canonical layer states

```text
healthy | degraded | unhealthy | unknown | not_configured | stale
```

Every state carries an evidence source or a reason for its absence.

Aggregation is deterministic and conservative:

- any measured `unhealthy` layer forces overall `unhealthy`
- any measured `degraded` layer forces overall `degraded` unless unhealthy wins
- if every measured layer is `healthy` and at least one layer is measured, the
  overall state is `healthy`
- if no layer is measured, the overall state is `unknown`
- unsupported layers never contribute a healthy claim

Coverage is exposed alongside status (`l1Measured`, `l2Measured`, `l3Measured`,
`l3Available`).

## 3. Persistence

Exactly three collections, all in `xcloud_ops`, none in `xcloud`:

```text
app_nf_health_targets   collector configuration and lifecycle
app_nf_health_runs      collection execution outcome
app_nf_health_samples   bounded time-series measurement evidence
```

No other NF Health collection is created. Health fields are never written into
`app_inventory_resources`, `app_topology_edges` or `app_nf_observations`.

### 3.1 Target identity

A monitoring target references an existing Discovery `candidateId`. The target
never creates its own independent NF identity and is never auto-created for
every discovered NF.

```json
{
  "targetId": "uuid-v4",
  "schemaVersion": 1,
  "candidateId": "existing-discovery-candidate-uuid",
  "name": "Operator-owned display label",
  "collectorProfile": "http_metrics",
  "metricsEndpoint": "http://127.0.0.5:9090/metrics",
  "serviceUnit": "approved-unit-or-process",
  "collectionMode": "manual",
  "intervalSeconds": 120,
  "enabled": true,
  "revision": 1
}
```

The collector profile vocabulary is server-owned and vendor-neutral. The value
in this build is `http_metrics`.

### 3.2 Freshness fields

Stored independently:

```text
lastAttemptAt    every attempted collection
lastSuccessAt    successful collection only
lastMeasuredAt   successful measurement only
sample timestamp the measurement instant
```

Failed collection never overwrites the last valid measurement timestamp.
A stale result is not current health. Disabled collection does not imply an NF
is down. A missing metrics endpoint does not imply NF failure.

### 3.3 Retention

Sample retention defaults to 7 days and is capped at 30 days. MongoDB TTL
expires samples only (`expiresAt` + `nf_health_samples_ttl`). Target identities,
runs, Discovery candidates and audit records are never TTL-deleted.

## 4. Collector Safety

All collectors are server-owned and allowlisted.

```text
fixed collector types
strict endpoint validation
explicit destination allowlist (NF_HEALTH_ALLOWED_TARGETS, default deny)
explicit service-unit allowlist (NF_HEALTH_SERVICE_UNITS, default deny)
bounded timeout (per-request 5s, total collection 15s)
bounded response size (1 MiB)
bounded parsing and sample count
bounded concurrency (global 2, per-target 1)
bounded collection frequency (minimum 60s)
```

- Redirects are rejected. URLs found inside response bodies are never requested.
- DNS rebinding, unexpected schemes, credentials-in-URL, fragments and query
  strings are rejected.
- TLS verification never uses `InsecureSkipVerify`.
- systemd inspection uses a fixed `systemctl show` invocation through
  `exec.CommandContext` with no shell interpolation, a timeout, server-approved
  unit names only, and never `sudo`. No generic command-execution abstraction
  is exposed.
- Process inspection is a read-only `/proc` scan. No process is signalled or
  terminated.
- There is no generic URL-fetch, remote-shell, NF restart/reload or
  subscription-creation endpoint.

## 5. Metrics Registry and Parsing

A server-owned registry defines each supported metric family with name, source
NF category, type (`counter` | `gauge`), unit, description, safe labels and
interpretation.

Prometheus text exposition parsing:

- recognizes `# HELP` and `# TYPE` metadata
- parses permitted sample syntax with labels
- rejects NaN, infinity and malformed numbers
- preserves counter/gauge semantics; a counter value is never presented as a rate
- detects counter resets when a caller supplies a previous baseline
- drops unregistered families rather than inventing them
- drops or redacts labels involving IMSI, SUPI, MSISDN, IMEI, IMPU, IMPI,
  authentication material, subscriber identity and session-specific identifiers

Raw metrics exports are never stored in MongoDB.

## 6. Collection Runtime

Collection modes:

```text
manual     default; triggered by an authorized operator
scheduled  explicitly enabled per authorized target
```

The scheduler lives inside the existing Go process. There is no second daemon
and no new Linux service.

```text
default interval       120 seconds
minimum interval        60 seconds
global concurrency       2
per-target concurrency   1
request timeout          5 seconds
total deadline          15 seconds
```

The scheduler:

- starts only when configured and cancels on application shutdown
- never overlaps collections for the same target
- respects disabled targets
- avoids burst collection on startup
- records failures without discarding last good samples
- identifies itself as `scheduler` rather than impersonating a human user

## 7. API Surface

Exactly 10 Go registrations (7 read + 3 mutation) and 2 SPA routes.

```text
GET    /api/nf-health/meta
GET    /api/nf-health/targets
GET    /api/nf-health/targets/{targetId}
GET    /api/nf-health/targets/{targetId}/history
GET    /api/nf-health/samples
GET    /api/nf-health/runs
GET    /api/nf-health/runs/{runId}
POST   /api/nf-health/targets
PUT    /api/nf-health/targets/{targetId}
POST   /api/nf-health/targets/{targetId}/collect
```

```text
/nf-health
/nf-health/:targetId
```

- Reads require `core.read`.
- Create/update monitoring target and trigger collection require `core.configure`.
- Validation is strict JSON with unknown-field rejection and body limits.
- Updates use CAS `expectedRevision`. Conflicts return HTTP 409
  `NF_HEALTH_REVISION_CONFLICT` and are never auto-retried.
- Pagination is bounded keyset pagination (default 50, maximum 200).
- Historical sample queries accept `targetId`, `from`, `to`, `cursor` and
  `limit`. Time ranges are bounded. There is no unrestricted aggregation API.

### 7.1 Stable error codes

```text
NF_HEALTH_TARGET_NOT_FOUND
NF_HEALTH_TARGET_DISABLED
NF_HEALTH_TARGET_CONFLICT
NF_HEALTH_REVISION_CONFLICT
NF_HEALTH_DESTINATION_NOT_ALLOWED
NF_HEALTH_SERVICE_UNIT_NOT_ALLOWED
NF_HEALTH_COLLECTION_IN_PROGRESS
NF_HEALTH_COLLECTION_RATE_LIMITED
NF_HEALTH_COLLECTOR_UNAVAILABLE
NF_HEALTH_METRICS_INVALID
NF_HEALTH_COLLECTION_TIMEOUT
NF_HEALTH_SAMPLE_NOT_FOUND
```

Expected validation failures never map to HTTP 500.

## 8. Audit

Actions written to `xcloud_ops.app_audit_logs`:

```text
nf_health.target.create
nf_health.target.update
nf_health.collection.request
```

Records include actor, targetId, revision, operation, timestamp, outcome and
safe before/after metadata. Raw metrics bodies and sensitive subscriber
identifiers are never logged. Scheduled collections identify `scheduler` as the
initiator.

## 9. UI Integration

NF Health is a native xCloud module:

- shared design tokens and shared UI primitives
- shared navigation authority (sidebar, tab bar, breadcrumbs, command palette)
- bilingual locale keys under `nav_nf_health` / `nf_health_*`
- L1/L2/L3 panels that visually and textually distinguish measured versus
  unsupported layers
- metric trend charts with time windows (15m / 1h / 6h / 24h), freshness state,
  empty/loading/error states, and no interpolation that conceals collection gaps
- Collect Now workflow that never claims success before server confirmation and
  never auto-retries failed collection

## 10. Explicit Non-Goals

This foundation does not implement NF restart/reload, SSH or MML terminals, EPC
or IMS adapters, active PFCP/NGAP/SIP/Diameter probes, UE session management,
PCAP capture, HEP signaling collection, alarm correlation, root-cause analysis,
AIOps prediction, automated remediation or closed-loop network control.

The existing `backend/internal/alert` module remains the sole application alert
owner. No duplicate alarm-management or remediation infrastructure is created.
