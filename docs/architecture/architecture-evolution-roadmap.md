# Architecture Evolution Roadmap

> Planned architecture evolution authority for xCloud subscriber-console.
> This roadmap describes proposed states. It does not change the current production
> runtime, API contracts, deployment configuration, security model, or OCS freeze.

## Purpose and Authority

The current production architecture is authoritative in
[System architecture](system-architecture.md) and
[Deployment](../operations/deployment.md). This roadmap is authoritative only for
the planned evolution direction. When a roadmap proposal conflicts with observable
current behavior, current source and deployment configuration prevail until an
approved implementation phase changes them.

The roadmap preserves these present facts:

- Nginx is the sole public browser edge.
- Next.js runs on loopback `127.0.0.1:13333` for current UI rendering and its
  UI-only navigation guard.
- Go runs on loopback `127.0.0.1:18888` and owns every current production API
  operation and API security authority.
- MongoDB `xcloud` and `xcloud_ops` remain the current source of truth.
- The OCS management plane is frozen; the charging plane remains excluded.
- Authorized business operations use direct execution with RBAC, fresh actor
  revalidation, best-effort operation logging, and CAS protection.

## Maturity Model

| Stage | Runtime | Data | Primary capability |
| --- | --- | --- | --- |
| Current | Nginx + Next.js + Go | MongoDB | Subscriber and OCS operations |
| Short term | Nginx + Go + embedded SPA | MongoDB | Unified application runtime and modular control plane |
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

The planned change replaces the production Next.js runtime with a static React SPA
served by Go. It retains Nginx as the public edge, Go `:18888` as the internal
application listener, current browser-relative API paths, and MongoDB as the source
of truth. Production port `13333` is retired only after an implementation phase has
completed the transition and acceptance validation.

This roadmap does not introduce Vite, React Router, Go SPA hosting, a single-upstream
Nginx configuration, or a port removal in the current phase.

### Implementation Status

The parallel SPA foundation in `frontend-spa/` includes the shared application shell,
cross-cutting providers, role-aware navigation metadata, compatibility redirects,
read-side business projections, and governed business mutation parity across subscriber
management, OCS balance adjustments, subscriber contracts, tariff plans, profiles, and
user management. Operational mutations for system-health remediation remain deferred.
Parallel SPA business read parity is implemented; parallel SPA governed business mutation
parity is implemented; frontend-spa production transition is NOT STARTED; and the Next.js
production runtime remains active on `:13333`. Nginx routing remains unchanged, and Go does
not serve SPA assets yet. The Vite listener on `127.0.0.1:13334` is a loopback-only,
migration-only development listener.

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

A future network source of truth should model Region, Site, Cluster, Host, VM,
Container, Pod, Network Function, Network Function Instance, Interface, IP Address,
PLMN, DNN, Slice, Subscriber, Service, Configuration, Software Version, Alarm,
Dependency, and Deployment. It should express relationships such as AMF -> SMF ->
UPF, SMF -> PCF, NRF -> NF registrations, UE -> subscriber profile, UE -> IMS
identity, P-CSCF -> I-CSCF -> S-CSCF, NF -> host or cluster, and service ->
dependency.

Future state concepts are Desired State, Observed State, Actual State, and Historical
State. None are implemented by this documentation phase.

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
