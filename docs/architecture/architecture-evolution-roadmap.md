# Architecture Evolution Roadmap

> Planned architecture evolution authority for xCloud subscriber-console.
> This roadmap describes proposed states. It does not change the current production
> runtime, API contracts, deployment configuration, security model, or the
> charging-plane exclusion.

## Purpose and Authority

The current production architecture is authoritative in
[System architecture](system-architecture.md) and
[Deployment](../operations/deployment.md). This roadmap is authoritative only for
the planned evolution direction. When a roadmap proposal conflicts with observable
current behavior, current source and deployment configuration prevail until an
approved implementation phase changes them.

The roadmap preserves these present facts:

- Nginx is the sole public browser edge (single upstream `xcloud_go`).
- Go runs on loopback `127.0.0.1:18888` and owns every current production API
  operation, API security authority, and embedded static React SPA hosting.
- Next.js source is retired; numeric port 13333 is reassigned to Vite development.
- MongoDB `xcloud` and `xcloud_ops` remain the current source of truth.
- The OCS management plane is open to governed lifecycle and UX correction; the charging plane remains excluded.
- Authorized business operations use direct execution with RBAC, fresh actor
  revalidation, best-effort operation logging, and CAS protection.

## Maturity Model

| Stage | Runtime | Data | Primary capability |
| --- | --- | --- | --- |
| Current | Nginx + Go + canonical frontend | MongoDB | Consolidated single-upstream runtime (Next.js retired, canonical frontend) |
| Medium term | Modular Go platform with event and telemetry foundations | MongoDB plus workload-specific stores where justified | Inventory, adapters, workflow, and assurance |
| Long term | Service-based and independently scalable platform where required | Multi-plane persistence | Multi-domain automation and closed-loop operations |
| Future | Autonomous operations platform | Digital operational model | Intent, digital twin, and guarded AI agents |

All stages after Current are planned. They are not claims about the deployed system.

## Short-Term Runtime Consolidation

The short-term target consolidates the application runtime behind the same public
edge:

```text
Browser
   |
   v
Nginx (public edge)
   |
   v
Go 127.0.0.1:18888
   |-- REST API
   |-- authentication and authorization authority
   `-- embedded static React SPA
          |
          v
MongoDB: xcloud + xcloud_ops
```

Single-upstream consolidation and frontend canonicalization are complete: Nginx proxies all production traffic
to Go `:18888`, which serves both the REST API and the embedded static React SPA. Next.js runtime
is retired, and `frontend/` is the canonical React+Vite SPA source.

### Implementation Status

The canonical SPA in `frontend/` includes the shared application shell,
cross-cutting providers, role-aware navigation metadata, compatibility redirects,
read-side business projections, governed business mutations, and operational mutations.
Go embedded static SPA hosting is edge-active. Nginx routes all production traffic
to Go `:18888`.
`frontend/` is the active production SPA source.
The Vite listener on `0.0.0.0:13333` is the LAN-reachable development server; Go remains loopback-only.

Platform Evolution Status:
- Inventory / Resource Model Foundation = IMPLEMENTED (authoritative metadata source of truth in `xcloud_ops.app_inventory_resources`, 6 Go endpoints, 3 SPA routes, keyset cursor pagination, CAS concurrency, terminal retirement).
- Frontend Visual & Interaction Parity Restoration = IMPLEMENTED (historical xCloud operator presentation forward-ported onto the current React/Vite + Go runtime; see `docs/architecture/frontend-ui-restoration.md`). The runtime remains React/Vite + Go; Next.js is not restored.
- Topology / Dependency Model Foundation = IMPLEMENTED (manual authoritative relationship management in `xcloud_ops.app_topology_edges`, 7 Go endpoints, 2 SPA routes, nine directed relationship types, partial-unique active-edge deduplication, revision CAS, terminal retirement, one-hop neighbour projection; see `docs/architecture/topology-dependency-model.md`).
- Discovery / NF Observation Foundation = IMPLEMENTED (vendor-neutral read-only NRF NFManagement observation into `xcloud_ops.app_nf_observations`, 12 Go endpoints, 2 SPA routes; see `docs/architecture/nf-discovery.md`).
- NF Health / Telemetry Foundation = IMPLEMENTED (read-only three-layer measurement evidence in `xcloud_ops.app_nf_health_targets` + `app_nf_health_runs` + `app_nf_health_samples`, 10 Go endpoints, 2 SPA routes; see `docs/architecture/nf-health-telemetry.md`).
- Assurance correlation, RCA, AIOps and multi-hop analysis remain future work and are not implemented by the discovery or telemetry foundations.

### Internal Backend Direction

The intended Go modular-monolith boundaries are logical boundaries, not packages to
create now:

```text
auth/          users/        subscriber/  profile/
ocs/           inventory/    topology/    operations/
workflow/      assurance/    telemetry/   adapter/
audit/         notification/ platform/
```

Service boundaries should be designed before they are deployed as independent
services. The roadmap avoids premature microservice decomposition.

## Business Operations Lifecycle and Retention

> Status: implemented. Balance reads now project missing measurements as
> null, every console balance adjustment sends a CAS version, tariff deletion is
> guarded server-side, OCS list filters are escaped, affected detail sections
> expose unavailable states, contract termination is a preserved terminal
> status with a guarded resume, subscriber deletion is blocked while a contract
> is active or suspended (terminated OCS history is retained), and the
> terminated-contract retention operation is available through the admin console
> and CLI. Template apply now requires a server-authoritative preview token,
> subscriber onboarding quota is derived from the selected tariff plan, template
> deletion archives the template while preserving subscriber bindings, and
> subscriber creation is a single server-side flow that writes the record, its
> 4G configuration and its OCS contract/quota together and compensates on
> failure.

The OCS management plane is open to governed lifecycle, data-truthfulness and UI
correction. The charging plane remains frozen and excluded.

### Contract Lifecycle

- `active <-> suspended`, then `terminated` as a terminal status.
- Termination preserves the contract and balance records; terminated contracts are read-only.
- `resume` is allowed only from `suspended`; terminated contracts cannot be resumed, re-priced or adjusted.
- Subscriber deletion is rejected while an active or suspended contract exists. After termination, deleting the subscriber identity does not cascade-delete OCS contract or balance history.
- An existing subscriber can be provisioned with a contract through the insert-only `POST /api/ocs/subscribers`: the subscriber identity must exist, the plan must be explicit and active, the contract is always created active, and only the supplied quota buckets are written. An existing balance account is adopted without rewriting its buckets; a plan mismatch or non-active account is refused. Retained terminated history is refused with 409 `OCS_CONTRACT_RETAINED`.
- The contract is the lifecycle and plan authority. Suspend, resume, terminate and plan changes mirror into the balance account, and balance reads prefer the contract's status/plan when both records exist; terminated contracts reject balance adjustments even if the cached account status is stale.

### Retention and Permanent Cleanup

Permanent cleanup is a data-retention operation, not a contract-row action.

- Admin surface: Platform Management -> Data Retention, plus a CLI that shares the same retention service.
- Retention window: configurable, default 365 days; `0` disables physical cleanup.
- Eligibility: only `terminated` contracts older than the window; active and suspended contracts are always refused.
- Workflow: dry-run first; the apply step requires a reason and explicit confirmation, writes audit evidence, supports batches and is idempotent.
- Cascade order: balance adjustments -> balance account -> contract. `app_audit_logs` and the subscriber identity record are retained.
- The contract detail page states the retention state and points to the retention surface; it never offers a single-record hard delete.

### Data Truthfulness

Read projections return `null` or explicit unavailability for missing measurements. They must not substitute 0, a default plan, a default status or default QoS values. Explicit zero remains a real value. Write paths treat an omitted field as "no change" and an explicit zero as a value; they do not coerce blanks to zero.

This covers OCS balance buckets, plan/status joins, subscriber traffic totals, AMBR and QoS fields, and adjustment-history reads.

### Template Apply and Onboarding

- Applying a template to an existing subscriber requires a server-authoritative preview at every entry point. The preview reports field-level changes, whether credential material changes, the current binding and a precondition token. This is implemented: `POST /api/subscribers/{imsi}/profile` with `preview:true` returns the safe before/after projection and token; applying without the token is refused and a stale token returns `PROFILE_APPLY_STALE` with zero writes.
- The apply request carries that token; a stale preview is rejected with no write.
- A subscriber create uses the selected tariff plan as the authority for the initial quota. Client-side onboarding values are suggestions only; voice and SMS may remain unconfigured when the plan does not model them. The create form now derives data quota from `quota_per_grant` and optional voice/SMS grants from plan rules; it no longer writes the former 10 GB / 1h / 100 constants.
- Template deletion is archival: an additive `archived` state hides the template from active lists, preserves the binding for existing subscribers and never modifies subscriber provisioning data. Referenced templates are not hard-deleted. This is implemented: `DELETE /api/profiles/{name}` archives, `includeArchived=true` lists archived templates, and `PUT {"archived":false}` restores them.

### Atomic Subscriber Create

- `POST /api/subscribers` accepts optional `sub4G` and `ocsTraffic` alongside `imsi`, `msisdn`, `planId`, `profileName` and `auth4G`. The record, the same sub4G projection the edit path applies, the template binding, the OCS contract and the initial quota are written by one handler call; the console no longer issues a follow-up `PUT` after create.
- Initial quota is strict: only supplied buckets are written. Voice and SMS stay unconfigured when the operator supplies no values, instead of inheriting the legacy 10 GB / 1 h / 100 defaults.
- If OCS provisioning fails after the subscriber insert, the handler deletes the inserted subscriber and any OCS rows it wrote. A successful compensation returns the original failure (for example a missing tariff plan); a failed compensation returns `SUBSCRIBER_CREATE_PARTIAL_WRITE` so the client finishes the rollback.
- Reusing an IMSI must not overwrite existing OCS state: a terminated contract still inside the retention window is refused with 409 `OCS_CONTRACT_RETAINED`, and an OCS contract without a subscriber record is refused with 409 `OCS_CONTRACT_EXISTS`. Both cases write nothing; retained history is removed only by the retention operation.
- `sub4G` writes accept only the five documented fields. Read projections such as `profile_name` and `allowedVisitedPlmns` are not writable: echoing a detail payload back would otherwise persist projection-only keys as top-level subscriber fields.
- `sub4G.msisdnList` is the MSISDN authority on create. A top-level `msisdn` that contradicts its first entry is refused with 400 `MSISDN_MISMATCH` instead of being silently dropped, every persisted number is checked for uniqueness (`MSISDN_EXISTS`), and the OCS contract's primary number is the list's first entry.

### Route and Scale Boundaries

- Redirect-only routes remain compatibility aliases. No OCS dashboard, session, usage or rating page is planned; the subscriber rating link targets the concrete tariff plan.
- The subscriber list remains on the current implementation at the current ~10k population. Server-side aggregation and keyset pagination are deferred behind a documented capacity trigger and benchmark.

### Acceptance Evidence

When implemented, this direction requires:

- Go tests for lifecycle transitions, retention eligibility/cascade/audit, CAS on every balance adjustment entry point, and server-side filter validation.
- Frontend render tests for null/unavailable states and preview-first template apply.
- Documentation and contract updates for any additive field or route, with AGENTS/CLAUDE parity and route/registration gates green.

## Medium-Term Platform Foundations

The medium-term control plane is organized around four foundations:

1. Unified inventory and topology.
2. Vendor-neutral adapter and mediation architecture.
3. Durable workflow and change governance.
4. Unified telemetry and assurance.

```text
                    Operator / NOC
                         |
                         v
                  Nginx / Edge
                         |
                         v
                  Go Control Plane
                         |
       +-----------------+-----------------+
       |                 |                 |
       v                 v                 v
 Inventory/Topology   Workflow/Policy   Assurance
       |                 |                 |
       +-----------------+-----------------+
                         |
                    Event Backbone
                         |
             +-----------+-----------+
             |                       |
             v                       v
      Telemetry Plane          Audit / Change
             |
             v
      Adapter / Mediation
             |
     +-------+-------+---------+
     |               |         |
    EPC             IMS       5GC
```

### Inventory and Topology

Inventory is the implemented node authority and Topology is the implemented edge
authority. The current relationship foundation covers manual authoritative
relationship management only, and it is delivered with an integrated operator UI.

The evolution of this area is explicitly staged:

```text
Stage 2 (implemented)
    Manual authoritative relationship management.
    Inventory owns nodes; Topology owns edges.
    Nine directed relationship types, two lifecycle states.
    One-hop neighbour projection only.
    No adapter runtime, no remote execution.

Discovery (implemented)
    Read-only registry observation feeding candidate identities.
    Operator-authored Inventory associations only.
    Observation state is not operational health.

NF Health (implemented)
    Read-only three-layer measurement evidence.
    Process / interface / KPI layers with explicit coverage.
    Bounded collection history and sample retention.

Later (future)
    Assurance correlation and multi-hop analysis.
    Alarm correlation, RCA and blast-radius analysis.
    Vendor-neutral adapter and mediation boundary.
```

A future network source of truth should model Region, Site, Cluster, Host, VM,
Container, Pod, Network Function, Network Function Instance, Interface, IP Address,
PLMN, DNN, Slice, Subscriber, Service, Configuration, Software Version, Alarm,
Dependency, and Deployment. It should express relationships such as AMF -> SMF ->
UPF, SMF -> PCF, NRF -> NF registrations, UE -> subscriber profile, UE -> IMS
identity, P-CSCF -> I-CSCF -> S-CSCF, NF -> host or cluster, and service ->
dependency.

Only the manual, authoritative subset of that model is implemented today; the
remaining vocabulary above is planned, not deployed.

Future state concepts are Desired State, Observed State, Actual State, and Historical
State. None are implemented by this documentation.

### Adapter and Mediation

Business modules should evolve away from direct dependencies on MongoDB-specific
subscriber calls, vendor REST, SSH, NETCONF, Kubernetes, SIP, Diameter, and
product-specific core-network APIs. The planned boundary is:

```text
Platform Capability
       |
       v
Adapter Contract
       |
       +-- 5GC Adapter
       +-- EPC Adapter
       +-- IMS Adapter
       +-- OCS/CHF Adapter
       +-- Kubernetes Adapter
       `-- Vendor-specific Adapter
```

Future capabilities may include discovery, health, inventory, metrics, alarms,
configuration read and validation, change planning, apply, verification, and
rollback. No generic shell/SSH execution API is part of the architecture contract.
Remote execution may only be introduced through trusted, server-owned,
target-specific executors in separately governed phases.

### Workflow and Change Governance

For future high-risk network operations, the intended path is:

```text
Operator Intent -> Validation -> Plan -> Impact Analysis
      -> Authorization / Policy -> Optional Approval Gate
      -> Pre-check -> Execution -> Verification
                                  | failure
                                  v
                               Rollback -> Audit
```

Current authorized business operations remain direct execution. This roadmap does
not reintroduce an approval workflow into the current business path; optional
approval is a future risk-based control for selected high-risk network operations.

### Telemetry and Assurance

The future assurance model spans metrics, logs, traces, events, alarms, signaling,
health, service KPIs, and subscriber journeys. Candidate data domains include NGAP,
NAS, PFCP, GTP, SIP, Diameter, HTTP/2 SBI, charging, Kubernetes, host metrics, and
application metrics.

Specialized persistence may be selected later by workload role: a
Prometheus/VictoriaMetrics-class system for metrics, an OpenSearch/Loki-class system
for logs, an OpenTelemetry-compatible tracing backend, S3/MinIO-class object storage
for large artifacts or PCAP, and a NATS/Kafka-class event backbone. None is a
mandatory immediate dependency or installed by this roadmap.

## Long-Term Platform Architecture

The long-term target is a service-based operations platform:

```text
                       Operator / API / Agent
                                |
                                v
                         Edge / API Gateway
                                |
            +-------------------+-------------------+
            |                   |                   |
            v                   v                   v
      Inventory Service   Workflow Service    Assurance Service
            |                   |                   |
            +-------------------+-------------------+
                                |
                         Event Backbone
                                |
        +-----------------------+-----------------------+
        |                       |                       |
        v                       v                       v
 Telemetry Platform       Audit/Compliance       Adapter Platform
                                                        |
                                  +---------------------+------------------+
                                  |                     |                  |
                                  v                     v                  v
                                 EPC                   IMS                5GC
```

Deployment decomposition is driven by scale, failure isolation, operational
ownership and availability requirements, not by architectural fashion. Logical
services do not require immediate independent processes.

### Deployment Profiles

**Profile A: Appliance, lab, or small operator**

```text
Nginx -> Go modular monolith
           |-- embedded SPA
           |-- API, inventory, workflow, assurance
           `-- adapters -> MongoDB
```

This profile may use systemd, containers, or a single-host deployment.

**Profile B: Carrier or HA**

```text
Load Balancer -> Ingress / Edge -> API Gateway
                                  |
                     +------------+------------+
                     |            |            |
                 Inventory      Workflow    Assurance
                     +------ Event Backbone-+
                                  |
                       Distributed Data Plane
```

Kubernetes may be appropriate for a future carrier deployment but is not a
short-term prerequisite.

### Security Evolution

Current security remains Go-only authentication authority, RBAC, fresh actor
revalidation, `sessionVersion` invalidation, operation logging, CAS protection,
Nginx identity-header stripping, and loopback-only internal services. Future phases
may separately evaluate OIDC/SSO, MFA, RBAC plus ABAC, resource scope, operation risk
classification, step-up authentication, four-eyes control for selected critical
operations, and a policy engine. This roadmap does not modify current authentication.

## Future Outlook

The intended outlook includes 3GPP management-service alignment, model-driven
operations, multi-vendor adapters, closed-loop assurance, intent-based operations,
network digital-twin concepts, predictive analytics, AI-assisted RCA, AI-assisted
change planning, and guarded operational agents.

```text
Telemetry / Inventory / Topology
              |
              v
           AI Agent
              |
              v
      Diagnosis / Plan
              |
              v
       Policy / Workflow
              |
              v
     Authorization / Guard
              |
              v
           Adapter
              |
              v
         Network Element
```

The architecture explicitly prohibits `LLM -> unrestricted shell/SSH/root access`.
AI assistance must remain behind inventory, policy, workflow, authorization, and
target-specific adapter controls.
