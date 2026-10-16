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
read-only process presence (/proc comm scan plus /proc/<pid>/exe verification)
```

L1 never infers state from NRF registration.

Process identity is strict: the `/proc/<pid>/comm` value must equal the
approved process name exactly, and the executable behind `/proc/<pid>/exe` must
resolve to the same approved name. Prefix or suffix variants (`pcscfd-test`,
`pcscfd-old`, `pcscfd2`, `mmed-helper`, `amfd-debug`) never match, and an
unrelated executable masquerading under the approved name is never a healthy
match. Bare-process deployments stay supported; systemd is not required for
local process-only monitoring.

Outcomes:

```text
active | inactive | failed | unit_not_found | permission_denied | not_configured
running | not_running | unverified
```

`unverified` reports a name-matching process whose executable identity could
not be verified. It is never a healthy match; it maps to the `unknown` state.

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

A `process_only` target performs no HTTP request at all: L2 stays
`not_configured`, no probe is executed and no success is synthesised. An
L1-only healthy measurement does not prove that the complete network function
service is healthy.

### 2.3 L3 — Service / KPI Evidence

Records actual supported numeric service metrics with source, unit, type and
timestamp.

Unsupported KPI families stay `not_available` / `not_configured` with reason
`no_supported_service_kpi` or `metric_not_exported`. Missing metrics are never zero-filled.
A zero measurement is valid only when the exporter reports zero.

**Resource metrics and service KPIs are distinct.** Every accepted sample
carries a category:

```text
resource   exporter-process telemetry (process_cpu_seconds_total,
           process_resident_memory_bytes, process_open_fds, ...)
service    NF-domain measurement attributed to the monitored resource
```

L3 service health is never inferred from the existence of samples:

- exporter-process telemetry can never establish service health; when only
  resource evidence is observed, L3 is `unknown` with reason
  `resource_metrics_only` and the measurement coverage is preserved;
- a measured service counter does not prove the service is healthy: a
  recognized counter may simply report how many failures occurred;
- only explicit, registered interpretation rules produce a positive or degraded
  reading (`service_health_confirmed` / `service_failures_observed`);
- when service evidence exists but no rule applies, L3 is `unknown` with reason
  `service_health_undetermined`;
- unsupported families stay unmeasured, and absence is never turned into zero.

Registered interpretation rules (no arbitrary thresholds):

```text
none                   resource metrics and families without a defensible
                       service-health interpretation
failure_counter_zero   a registered failure counter: zero with observed traffic
                       is positive evidence, a positive value is degraded evidence
success_ratio_pair     a success counter paired with its request counter on the
                       same event population: equality with a non-zero request
                       count is positive, a shortfall is degraded, a zero request
                       count yields no evidence
activity_gauge         a gauge counting active service objects: a positive value
                       is evidence of live service activity, zero yields none
```

A zero failure counter with no observed traffic proves nothing and stays
undetermined. An incomplete pair (a success counter without its request counter)
never becomes a percentage.

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

### 3.1 Canonical identity: Inventory Resource → NF Health Target → Evidence

Inventory is the sole canonical resource authority. A monitoring target
references an existing Inventory resource; the target never creates its own
independent NF identity and is never auto-created for every discovered NF.

Three identifiers are preserved and are never interchangeable. None is derived
by parsing or transforming another:

| Identifier | Authority | Meaning |
|---|---|---|
| `resourceId` | Inventory | Canonical managed resource (`network_function` or `network_function_instance`) |
| `candidateId` | Discovery | Optional observed NRF candidate |
| `targetId` | NF Health | Monitoring target configuration |

```json
{
  "targetId": "uuid-v4",
  "schemaVersion": 1,
  "resourceId": "existing-inventory-resource-uuid",
  "candidateId": "optional-existing-discovery-candidate-uuid",
  "name": "Operator-owned display label",
  "collectorProfile": "http_metrics",
  "domain": "ims",
  "nfType": "P-CSCF",
  "identityState": "inventory_authoritative",
  "metricsEndpoint": "http://127.0.0.5:9090/metrics",
  "serviceUnit": "approved-unit-or-process",
  "collectionMode": "manual",
  "intervalSeconds": 120,
  "enabled": true,
  "revision": 1
}
```

Identity rules:

- `domain` and `nfType` are server-derived projections of validated Inventory
  metadata. A client-supplied `domain` or `nfType` field is rejected by strict
  JSON decoding; the request body has no such fields.
- Supported monitoring domains reuse the canonical Inventory domain vocabulary:
  `epc`, `5gc`, `ims` and the shared charging domain `charging` (for OCS).
- The resource kind must be `network_function` or `network_function_instance`,
  and the resource must not be retired.
- The normalized NF type resolves from the explicit Inventory `role` token
  (for example role `pcscf` resolves to `P-CSCF`). An unresolvable role is
  rejected deterministically instead of being guessed from display names,
  executable suffixes or vendor names. The Inventory `role` field itself keeps
  its existing meaning; NF Health never redefines it.
- When both `resourceId` and `candidateId` are supplied, the Discovery
  candidate must be explicitly linked to the same Inventory resource and its
  observed NF type must be compatible. Discovery remains read-only from NF
  Health: unlinking is never performed silently.
- A candidate-only request adopts the candidate's explicit link only when the
  linked resource validates *and* the observed candidate NF type is explicitly
  compatible. A missing or mismatched observed type is never elevated into
  `inventory_authoritative`: the created target stays transitional
  (`legacy_unbound`) and reports the association as unresolved. Pre-phase
  candidate-only targets decode with an absent identity state and are projected
  on read as `legacy_unresolved`.

Identity states:

```text
inventory_authoritative  resource-native target; domain and NF type derived server-side
legacy_unbound           newly created candidate-only target; transitional, no resource
legacy_unresolved        pre-phase candidate-only target read without a resource
```

The collector profile vocabulary is server-owned and vendor-neutral:

```text
http_metrics   bounded HTTP metrics probe (L2/L3 evidence)
process_only   local read-only process inspection (L1 evidence only)
```

### 3.1.1 Logical uniqueness

Uniqueness is enforced by two partial unique indexes on
`app_nf_health_targets`:

```text
uniq_nf_health_target_candidate  candidateId unique where candidateId is a string
uniq_nf_health_target_resource   resourceId unique where resourceId is a string
```

The partial semantics let Inventory-only targets with an absent `candidateId`
coexist and keep per-candidate uniqueness, while one active monitoring target
per Inventory resource is the logical uniqueness policy. Concurrent duplicate
creation fails with the unique index, not with an application-only pre-check.

### 3.1.2 Local process binding

The collector runs inside the xCloud Go backend, so local `/proc` evidence
describes the backend host, not an arbitrary remote Inventory resource. For
`process_only` targets the server-owned configuration
`NF_HEALTH_LOCAL_PROCESS_BINDINGS` (comma-separated `resourceId=unit`)
establishes the authorized correspondence between the Inventory resource and
the approved local process or service. A client-provided host claim is never
authoritative; a missing or mismatched binding fails closed
(`NF_HEALTH_PROCESS_BINDING_MISSING` / `NF_HEALTH_PROCESS_BINDING_MISMATCH`,
HTTP 403). Remote monitoring is reserved for a subsequent phase.

A binding is necessary but not sufficient: the bound process must also be
compatible with the Inventory resource's canonical domain and NF type
(`NF_HEALTH_PROCESS_NF_TYPE_INCOMPATIBLE` /
`NF_HEALTH_PROCESS_DOMAIN_INCOMPATIBLE`). An EPC MME resource may bind to
`mmed`; an IMS P-CSCF resource may bind to `pcscfd`; an MME resource must never
become associated with `pcscfd` and a P-CSCF resource must never become
associated with `amfd`. Compatibility is enforced on creation, update and
collection. A process outside the bounded registry carries no derivable NF type:
its explicit server binding remains the authorization boundary and no type claim
is invented. The documented `.service` normalization is preserved; suffix
stripping is never used to infer an NF type.

The same rule protects resource-native HTTP Metrics targets that also collect
local L1 evidence: an allowlisted process name alone never establishes resource
ownership, so such a target must hold a matching binding for its own Inventory
resource. A pure HTTP-only target (no local inspection source) is unaffected.

### 3.1.3 Legacy association backfill

`MigrateLegacyTargetResourceLinks` backfills the canonical association for
legacy candidate-only targets whose Discovery candidate carries an explicitly
linked, valid Inventory resource. It applies the same validated relationship as
target creation: the linked resource must validate *and* the observed candidate
NF type must be explicitly compatible, otherwise the target is counted invalid
and left untouched. It is explicitly invoked (never at startup), bounded
(default 500 records), dry-run capable, idempotent, revision-safe and
non-destructive: the conditional update is bound to the observed revision and
must actually match before a migration is counted, unmatched targets are
reported and never deleted, association collisions are reported as conflicts
instead of silently reassigning identity, no Inventory resources are
fabricated, no unrelated documents are rewritten, and historical runs and
samples are never rewritten to claim a newly established resource identity.

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
explicit local process bindings (NF_HEALTH_LOCAL_PROCESS_BINDINGS)
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
- Process inspection is a read-only `/proc` scan with exact process-name
  matching and `/proc/<pid>/exe` identity verification. No process is signalled
  or terminated. Shell-based process discovery is never used as a workaround.
- `process_only` targets perform no HTTP request. Local `/proc` evidence
  describes the backend host: proving a local process runs does not prove a
  remotely deployed network function is operational.
- There is no generic URL-fetch, remote-shell, NF restart/reload or
  subscription-creation endpoint.

## 5. Process Registry

A bounded, server-owned registry maps known process identities to normalized
network function types with their permitted canonical domains:

| Process | NF type | Domain |
|---|---|---|
| `amfd` | AMF | 5gc |
| `smfd` | SMF | 5gc |
| `upfd` | UPF | 5gc |
| `nrfd` | NRF | 5gc |
| `ausfd` | AUSF | 5gc |
| `udmd` | UDM | 5gc |
| `udrd` | UDR | 5gc |
| `pcfd` | PCF | 5gc |
| `bsfd` | BSF | 5gc |
| `nssfd` | NSSF | 5gc |
| `scpd` | SCP | 5gc |
| `seppd` | SEPP | 5gc |
| `mmed` | MME | epc |
| `sgwcd` | SGW-C | epc |
| `sgwud` | SGW-U | epc |
| `hssd` | HSS | epc |
| `pcrfd` | PCRF | epc |
| `ocsd` | OCS | charging |
| `pcscfd` | P-CSCF | ims |
| `scscfd` | S-CSCF | ims |
| `icscfd` | I-CSCF | ims |
| `smscd` | SMSC | ims |

These are recognized process identities, not claims that every process is
installed, currently running, or exporting metrics. NF type is never inferred
by transforming a process name (for example `pcscfd` maps explicitly to
`P-CSCF`). A process name reused across domains must be domain-qualified
explicitly. Unknown processes are rejected unless independently and explicitly
authorized. Not every process supports L2 HTTP Metrics or L3 service KPIs.

## 6. Metrics Registry and Parsing

A server-owned registry defines each supported metric family with name, source
NF category, type (`counter` | `gauge`), unit, description, safe labels and
interpretation. The registry is deliberately conservative: only families
verified against the deployed exporter are listed. Unlisted families are
dropped and never zero-filled.

Every definition additionally carries:

```text
domain         canonical Inventory domain (epc | 5gc | ims | charging | *)
category       resource | service
source         vendor-neutral exporter identity (nf_metrics_exporter)
evidence       live_verified | source_verified | fixture_tested | not_verified | not_exported
healthRule     none | failure_counter_zero | success_ratio_pair | activity_gauge
healthPair     the paired request counter for success_ratio_pair
nonNegative    count-like families reject negative values
```

### 6.1 Telemetry capability matrix (22 reference process types)

The matrix records what the reference deployment actually exposes. `Exporter`
means a metrics implementation exists in the deployed exporter; `Enabled` means
the reference deployment configures a metrics listener. No family is registered
for an NF type whose exporter does not implement one.

| Domain | NF type | Process | Exporter | Enabled | Registered families | Evidence class |
|---|---|---|---|---|---|---|
| 5gc | AMF | `amfd` | yes | yes (live) | 24 | live_verified |
| 5gc | SMF | `smfd` | yes | yes (live) | 14 | live_verified |
| 5gc | UPF | `upfd` | yes | yes (live) | 8 | live_verified |
| 5gc | PCF | `pcfd` | yes | yes (metadata only) | 5 | live_verified (families declared; values appear only with policy associations) |
| 5gc | NRF | `nrfd` | no | no | 0 | not_exported |
| 5gc | AUSF | `ausfd` | no | no | 0 | not_exported |
| 5gc | UDM | `udmd` | no | no | 0 | not_exported |
| 5gc | UDR | `udrd` | no | no | 0 | not_exported |
| 5gc | BSF | `bsfd` | no | no | 0 | not_exported |
| 5gc | NSSF | `nssfd` | no | no | 0 | not_exported |
| 5gc | SCP | `scpd` | no | no | 0 | not_exported |
| 5gc | SEPP | `seppd` | no | no | 0 | not_exported |
| epc | MME | `mmed` | yes | yes (live) | 3 | live_verified |
| epc | SGW-C | `sgwcd` | no | no | 0 | not_exported |
| epc | SGW-U | `sgwud` | no | no | 0 | not_exported |
| epc | HSS | `hssd` | yes | yes (live) | 39 | live_verified |
| epc | PCRF | `pcrfd` | yes | yes (live) | 16 | live_verified |
| charging | OCS | `ocsd` | yes | no | 21 | source_verified |
| ims | P-CSCF | `pcscfd` | no | no | 0 | not_exported |
| ims | S-CSCF | `scscfd` | no | no | 0 | not_exported |
| ims | I-CSCF | `icscfd` | no | no | 0 | not_exported |
| ims | SMSC | `smscd` | no | no | 0 | not_exported |

Reading the matrix:

- `live_verified` families were observed on the declared metrics endpoints
  (`amf` 127.0.0.5, `smf` 127.0.0.4, `upf` 127.0.0.7, `mme` 127.0.0.2,
  `hss` 127.0.0.8, `pcrf` 127.0.0.9, `pcf` 127.0.0.13 — all `:9090`) through
  bounded, read-only GET requests, and cross-checked against the exporter
  implementation.
- `source_verified` (charging) means the exporter implementation declares the
  families but the reference deployment does not enable the OCS metrics
  listener: no live evidence exists and none is claimed.
- `not_exported` means the exporter implements no metrics for that NF type.
  These NF types keep L1 (and, where an endpoint is configured, L2) monitoring
  with L3 explicitly unavailable. This is an evidence-backed capability result,
  not a monitoring failure.
- The IMS deployment (P-CSCF / I-CSCF / S-CSCF / SMSC) exposes no Prometheus
  metrics through the authorized HTTP collection path. The SMSC HTTP listener is
  an SMS submission endpoint, never a metrics source. IMS therefore keeps L1
  process monitoring only.

### 6.2 Metric families by NF type

```text
generic resource (domain *, nfTypes *)  7 families
  process_resident_memory_bytes, process_cpu_seconds_total,
  process_start_time_seconds, process_open_fds, process_max_fds,
  process_virtual_memory_bytes, process_virtual_memory_max_bytes

5gc AMF   24  session/registration/auth/paging/configuration-update gauges and counters
5gc SMF   14  session, bearer, PFCP, N4 and PDU-session families
5gc UPF    8  session, QoS-flow, N3 packet and N4 families
5gc PCF    5  AM/SM policy association counters and active sessions
epc MME    3  mme_session, enb_ue, enb
epc HSS   39  S6a/Cx/SWx Diameter counters plus IMSI/IMPI/IMPU aggregate gauges
epc PCRF  16  Gx/Rx policy counters
charging OCS 21  session/reservation/subscriber gauges, Gy/Ro counters,
                 reconciliation and processing-latency gauges
```

Previously certified AMF/SMF/UPF families are preserved unchanged. The
deployed SMF exporter additionally emits EPC-side GTP families (`gn_*`, `s5c_*`,
`gtp1_pdpctxs_active`, `gtp_node_*`); they are deliberately not registered
because the SMF resource is attributed to the 5GC domain and the per-peer
`gtp_node_*` families lose their peer identity under the label policy below.

### 6.3 Endpoint trust boundary

The collection path proves that the configured, allowlisted endpoint answered
and produced parseable metrics. It does not prove that the remote process is
cryptographically authenticated as the claimed network function: attribution
comes from the operator-approved Inventory association and the destination
allowlist, not from the transport. This boundary is unchanged from the previous
phase and is stated here explicitly.

Prometheus text exposition parsing:

- recognizes `# HELP` and `# TYPE` metadata
- parses permitted sample syntax with labels
- rejects NaN, infinity and malformed numbers
- rejects negative values for count-like families (an observed negative session
  count is corrupted evidence, not a measurement)
- preserves counter/gauge semantics; a counter value is never presented as a rate
- detects counter resets when a caller supplies a previous baseline
- drops unregistered families rather than inventing them
- drops or redacts labels involving IMSI, SUPI, MSISDN, IMEI, IMPU, IMPI,
  authentication material, subscriber identity and session-specific identifiers

Metric attribution is bound to the validated target domain and NF type:

- generic resource families (wildcard domain and `nfTypes`) remain permitted for
  every target;
- for an identity-resolved target, a family must explicitly permit that
  canonical domain and NF type: a foreign NF's or foreign domain's metric is
  never relabelled as belonging to the selected Inventory resource;
- a legacy target without an authoritative identity keeps registry
  compatibility without inventing type-specific attribution;
- the metric's own `nfType` label is never an authority for resource identity.

Label policy: only `nf`, `nftype`, `nf_type`, `function` and `instance` survive.
Subscriber, session, peer-address and slice identifiers (including `plmnid` and
`snssai`) are dropped, which is why per-peer families are not registered.

### 6.4 Counter and derived-KPI limits

- A cumulative counter is never presented as a per-second rate; deriving a rate
  would require at least two valid observations with real timestamps.
- Counter resets are detected against a supplied baseline and never produce a
  manufactured delta.
- Success-ratio rules compare a success counter with its own request counter on
  the same event population; unrelated counters are never combined.
- An incomplete interval or a missing numerator/denominator never produces a
  percentage.
- No derived KPI is persisted, and no database field was added for rate
  calculation.

Raw metrics exports are never stored in MongoDB.

## 7. Collection Runtime

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

## 8. API Surface

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
- `GET /api/nf-health/meta` additionally exposes `identityStates`,
  `supportedResourceDomains`, the `process_only` collector profile,
  `metricCategories`, `metricEvidenceClasses`, `serviceReasons` and the full
  `supportedMetrics` registry with its domain, category, evidence class and
  health rule.

### 8.1 Stable error codes

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

Unified identity error codes (all additive; creation, update and collection
paths only):

```text
NF_HEALTH_RESOURCE_NOT_FOUND           HTTP 400 create/update | 409 collection
NF_HEALTH_RESOURCE_KIND_UNSUPPORTED    HTTP 400 create/update | 409 collection
NF_HEALTH_RESOURCE_DOMAIN_UNSUPPORTED  HTTP 400 create/update | 409 collection
NF_HEALTH_RESOURCE_RETIRED             HTTP 409 all identity paths
NF_HEALTH_NF_TYPE_UNRESOLVED           HTTP 400 create/update | 409 collection
NF_HEALTH_DOMAIN_TYPE_MISMATCH         HTTP 400 create/update | 409 collection
NF_HEALTH_TARGET_IDENTITY_MISMATCH     HTTP 409 stored identity no longer matches Inventory
NF_HEALTH_CANDIDATE_RESOURCE_MISMATCH  HTTP 400 candidate linked to another resource
NF_HEALTH_CANDIDATE_TYPE_MISMATCH      HTTP 400 candidate NF type incompatible
NF_HEALTH_RESOURCE_REQUIRED            HTTP 400 process_only without a resource
NF_HEALTH_PROCESS_BINDING_MISSING      HTTP 403 no server-authorized local binding
NF_HEALTH_PROCESS_BINDING_MISMATCH     HTTP 403 unit differs from the binding
NF_HEALTH_PROCESS_NF_TYPE_INCOMPATIBLE HTTP 400 bound process is not the resource NF type
NF_HEALTH_PROCESS_DOMAIN_INCOMPATIBLE  HTTP 400 bound process is not in the resource domain
NF_HEALTH_PROCESS_UNIT_REQUIRED        HTTP 400 local inspection without a unit
NF_HEALTH_RESOURCE_UNAVAILABLE         HTTP 503 identity resolution unavailable
```

Expected validation failures never map to HTTP 500.

### 8.2 Identity enforcement on every operation

Authoritative resource attribution is enforced on create, update, collection
and legacy migration, independently of client behaviour:

- **Create**: strict JSON rejects `domain`, `nfType` and `identityState`; the
  server derives them from validated Inventory metadata. A resource-native
  target that also configures local L1 process evidence must hold a matching,
  NF-type-compatible server binding.
- **Update**: the stored target is loaded first and the *effective*
  configuration is validated — immutable identity (`resourceId`, `candidateId`,
  `collectorProfile`) comes from storage, mutable fields from the request, and
  the stored collector profile governs the rules. An existing `process_only`
  target can never lose, disable, repoint or mis-type its authorized inspection
  source, and can never gain a metrics endpoint. A rejected update performs
  zero writes.
- **Collection**: the stored target's identity is revalidated against the
  current authoritative Inventory resource before any measurement, on both the
  manual and scheduled paths. Missing, retired, unsupported, re-domained,
  re-roled or otherwise mismatching resources fail closed with a deterministic
  error; no sample is written and no health claim is produced. A missing
  Inventory resource is never treated as evidence that the resource is valid.
  Legacy candidate-only targets without an established association keep their
  documented behavior.
- **Migration**: the backfill applies the same validated relationship as
  creation (linked resource must validate *and* the observed candidate NF type
  must be compatible), is revision-bound, verifies the actual conditional
  update result, and reports association collisions instead of silently
  reassigning identity.
- **Read**: an identity conflict is reported, never rewritten: the stored
  target keeps its recorded association and the history stays readable.

### 8.3 Inventory retirement behavior

When an Inventory resource is retired:

- new target creation against that resource is rejected
  (`NF_HEALTH_RESOURCE_RETIRED`, HTTP 409);
- collection for existing targets against that resource is blocked explicitly
  with the same code while historical runs and samples remain readable;
- monitoring history is never deleted and targets are never silently
  reassigned to another resource.

A valid Inventory-only target never becomes invalid merely because no NRF
Discovery candidate exists: the canonical resource association is distinct
from Discovery observation freshness.

## 9. Audit

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

## 10. UI Integration

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
- target creation selects an existing Inventory resource through the paginated
  Inventory read API, shows its canonical domain and NF type, and offers the
  Discovery candidate only as an optional association
- `process_only` configuration explains that only L1 is measured on the
  collector host and never displays unmeasured layers as healthy
- legacy candidate-only targets remain visible and are labeled honestly as
  lacking an authoritative Inventory resource association
- a measured-evidence table lists every accepted metric with its category
  (resource or service), type, value and interpretation, so process telemetry is
  never confused with service measurements
- the trend grid is bounded (12 charts) and states how many further measured
  series are listed in the evidence table instead of charting them
- layer reasons are localized (`resource_metrics_only`,
  `service_health_undetermined`, `service_health_confirmed`,
  `service_failures_observed`, ...); an unrecognized reason is shown verbatim
  rather than being explained away
- a missing metric is never displayed as `0`, and unsupported KPI categories are
  never shown as healthy

## 11. Explicit Non-Goals

This foundation does not implement NF restart/reload, SSH or MML terminals, EPC
or IMS adapters, active PFCP/NGAP/SIP/Diameter probes, UE session management,
PCAP capture, HEP signaling collection, alarm correlation, root-cause analysis,
AIOps prediction, automated remediation or closed-loop network control.

The existing `backend/internal/alert` module remains the sole application alert
owner. No duplicate alarm-management or remediation infrastructure is created.

Remote process monitoring, new EPC/IMS KPI metric families and comprehensive
metric adapters are intentionally deferred to a subsequent controlled phase.
The 22-process registry and the `process_only` profile establish the identity
and collection foundation only; they do not claim operational support for every
mapped process.

Remaining gaps recorded by the capability audit:

- Charging (OCS) metrics are source-verified only: the reference deployment does
  not enable the OCS metrics listener, so no live evidence exists and no
  delivered service-KPI monitoring is claimed for the charging domain.
- 5GC NRF/AUSF/UDM/UDR/BSF/NSSF/SCP/SEPP, EPC SGW-C/SGW-U and all four IMS NF
  types export no metrics through the authorized HTTP collection path; they keep
  L1 (and configured L2) monitoring with L3 explicitly unavailable.
- The PCF exporter declares its policy families but emits values only when
  policy associations exist; until then the families stay unmeasured.
- Live verification is restricted to bounded, read-only GET requests against
  metrics endpoints declared in the deployment configuration. Port scanning,
  endpoint guessing, configuration changes, service restarts, signaling probes
  and packet capture are prohibited, and the gated live suite refuses to run
  without an explicit read-only authorization flag.
