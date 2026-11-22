# Documentation

Permanent documentation entry point for the xCloud subscriber-console repository.

## Authority Model

Documentation authority is explicit and ordered:

```text
1. README.md
   Repository overview and entry point.

2. docs/README.md
   Documentation map and authority guide (this file).

3. docs/architecture/**
   Current production architecture and design authority.

4. docs/operations/**
   Current operating models, runbooks, deployment and administration guidance.

5. docs/database/**
   Current data and database operational documentation.

6. docs/archive/**
   Concise historical summaries only. NOT current architecture authority.
```

Where documentation and production source disagree, the running source and
configuration are authoritative:

```text
Nginx edge routing                -> deploy/nginx/xcloud.conf
Go API registration authority     -> backend/cmd/server/main.go
                                     backend/internal/remediation/handler.go
Canonical frontend SPA source     -> frontend/src/
```

## Architecture

- [Metric threshold alerts](architecture/metric-threshold-alerts.md) - opt-in exporter RSS policy, verified evidence, hysteresis and replay-safe single-observation evaluation.
- [Metric history](architecture/metric-history.md): opt-in exporter RSS hourly and daily aggregates, exact hourly percentiles, observed coverage, retention and bounded history reads.
- [Metric baseline analysis](architecture/metric-analysis.md): per-hour robust deviation against the metric's own 48-hour baseline, with explicit insufficient-data reasons.

- [Site / network workbench](architecture/site-network-workbench.md) - explicit management scope, shared operational evidence and governed site maintenance.
- [Site / network operations](operations/site-network-workbench.md) - site setup, explicit assignments, conflict checks and scoped reports.

- [Configuration drift alerts](architecture/configuration-drift.md) / [操作说明](operations/configuration-drift.md) - ordered baseline evaluation, independent episode lifecycle, explicit notifications and manual investigations.
- [Configuration observations](architecture/configuration-snapshots.md) - approved local sources, safe projections, immutable observations, baseline comparison and retention.
- [Scheduled inspections](architecture/scheduled-inspections.md) / [Operation guide](operations/scheduled-inspections.md) - governed schedules, fixed evidence reports, explicit gaps and compatible comparisons.
- [Operations reports](architecture/operations-reports.md) - windowed alert/measurement evidence, scope completeness and bounded CSV exports.

- [System architecture](architecture/system-architecture.md)
- [Production topology](architecture/production-topology.md) - edge contract, single-process request path, frontend build-and-embed chain and the redeploy acceptance evidence.
- [Inventory resource model](architecture/inventory-resource-model.md)
- [Topology dependency model](architecture/topology-dependency-model.md)
- [NF discovery foundation](architecture/nf-discovery.md)
- [Operational overview and network element management](architecture/operational-overview.md) - current operational surfaces: authorities, projection, denominators and boundaries.
- [UE information and EPC/5GC online users](architecture/ue-info.md) - read-only UE source allowlist, merge semantics, partial-source behavior and the current IMS scope boundary.
- [Agent management](architecture/agent-management.md) - single controller, independent read-only Linux collectors, machine identity, node freshness and explicit management assignment.
- [Host observation](architecture/runtime-discovery.md) - CNMS-compatible local process recognition, runtime status semantics and the governed monitoring bootstrap.
- [Knowledge base](architecture/knowledge-base.md) - fault phenomena, root causes and resolutions with secure local attachment storage.
- [Architecture evolution roadmap](architecture/architecture-evolution-roadmap.md) - planned architecture evolution authority; it distinguishes future targets from current production behavior.
- [Scale capacity triggers](architecture/scale-capacity-triggers.md) - measured list benchmark, quantified warning/hard triggers, index verification and the actions required when a trigger is reached.
- [Frontend UI ownership](architecture/frontend-ui-ownership.md) - token, shared-primitive, domain-component and stylesheet ownership; why `ocs.css` remains a shared business layer.
- [Frontend-backend boundary](architecture/frontend-backend-boundary.md)
- [Security model](architecture/security-model.md)
- [Governance design](architecture/governance-design.md)
- [Product](architecture/product.md)
- [Repository conventions](architecture/repository-conventions.md)
- [Design tokens](architecture/design-tokens.md)
- [Design system rules](architecture/design-system-rules.md)
- [Page templates](architecture/page-templates.md)

## Operations

- [Configuration observation operations](operations/configuration-observations.md) - declaration, private key, explicit indexes, acceptance and rollback.

- [Deployment](operations/deployment.md)
- [Metric assurance deployment](operations/metric-assurance-deployment.md) - staged activation, verification queries and the rollback drill for aggregation, analysis and analysis alerts.
- [Authentication model](operations/authentication-model.md)
- [User management model](operations/user-management-model.md)
- [RBAC model](operations/rbac-model.md)
- [Operation model](operations/operation-model.md)
- [Direct operation model](operations/direct-operation-model.md)
- [OCS management runbook](operations/ocs-management-runbook.md)
- [OCS usage record write contract](operations/ocs-usage-record-contract.md)
- [NF discovery runbook](operations/nf-discovery-runbook.md)
- [Security](operations/security.md)

## Database

- [Core network operations inventory](database/core-network-operations-inventory.md)

## Archive

- [Backend migration summary](archive/backend-migration-summary.md)

`docs/archive/**` contains concise historical summaries only. It is not current
architecture authority. Detailed historical development evidence remains
available from Git history.

- [IMS registration observation architecture](architecture/ims-registration-observation.md)
- [Alert investigation architecture](architecture/alert-investigations.md) / [操作说明](operations/alert-investigations.md)
- [IMS registration observation runbook](operations/ims-registration-observation.md)
