# Operational Overview and Network Element Management

> Current-system documentation for the CNMS-inspired operational surfaces. It
> describes the implemented read-only projection, the authorities it consumes,
> the aggregation denominators it publishes and the boundaries it must never
> cross. When this document and the running source disagree, the source and the
> automated tests prevail.

Related documents:

- [NF Health / Telemetry foundation](nf-health-telemetry.md)
- [Inventory resource model](inventory-resource-model.md)
- [Topology dependency model](topology-dependency-model.md)
- [NF discovery foundation](nf-discovery.md)
- [System architecture](system-architecture.md)

## 1. Scope

xCloud presents two operational surfaces derived from the reference operations
console:

```text
/            Operational Network Overview (additional section below the
             existing business analytics cockpit)
/inventory   Network element view (additional view mode inside the existing
             Inventory route)
```

No new route, collection, endpoint or background worker is introduced. Both
surfaces are read-only projections of data that already has an owning authority.

## 2. CNMS capability mapping

The reference repository was inspected read-only at a fixed commit. Every
adopted concept is rebuilt natively against xCloud authorities.

| Reference capability | Original backend dependency | Reused concept | xCloud authority | Status |
|---|---|---|---|---|
| Operational summary cards | `/api/v1/deployment/status` | summary cards over real populations | Inventory + NF Health | Implemented |
| Component status distribution | deployment status payload | status distribution with explicit denominators | NF Health evidence | Implemented |
| Domain-grouped NF table | process list keyed by process name | collapsible domain groups, compact NF rows | Inventory domain/kind + NF Health status | Implemented |
| Location tree | `/api/v1/sites` plus a hardcoded fallback tree | expand/collapse tree driving table filtering | Inventory resources + Topology `contains` edges, with a labelled virtual fallback | Implemented |
| Search and status filtering | process-name substring match | text search plus domain/kind/monitoring filters | Inventory query parameters + bounded client filters | Implemented |
| Compact process indicator | process map from the monitor backend | per-resource L1 indicator with honest unknown states | NF Health L1 evidence | Implemented |
| Resource detail navigation | legacy element pages | drill-down to resource and monitoring detail | `/inventory/{resourceId}`, `/nf-health/{targetId}` | Implemented |
| Deployment template switching | `/api/v1/deployment/templates` | none | none | Excluded |
| Process restart / stop | `/api/v1/mml/execute` (`CTRL-NF`) | none | none | Excluded |
| Log viewer and log stream | `/api/v1/nf/logs`, log WebSocket | none | none | Excluded |
| Business metrics from the monitor backend | `/api/v1/business-metrics` | none; existing xCloud analytics are preserved unchanged | existing analytics endpoints | Excluded |
| Site CRUD | `/api/v1/sites` | none (would require a new collection) | none | Excluded |
| Unified monitor socket | legacy WebSocket transport | bounded polling only | existing read APIs | Excluded |

The reference `MonitorContext`, `useUnifiedSocket`, deployment template state,
hardcoded process maps and raw API clients are not imported in any form.

## 3. Authority and ownership model

| View field | Authority |
|---|---|
| `resourceId`, name, domain, kind, role, lifecycle | Inventory |
| declared parent/relationship | Topology (`contains` only, for hierarchy) |
| candidate association | Discovery (not displayed as operational identity) |
| target association, coverage, layers, freshness, timestamps | NF Health |
| measured metric values | NF Health samples |

Joins use canonical `resourceId` only. Display names, hostnames, IP addresses and
process-name spelling are never used to join or to derive identity. The NF type
shown for a resource is the server-derived type of its monitoring target; when no
target exists the explicit Inventory `role` is shown as a role token, never
inferred from a process name.

## 4. Operational view model

`frontend/src/features/operations/operational-model.ts` is a pure projection with
no network access, so it is unit-testable and cannot invent data:

- `buildOperationalResources(resources, targets)` — one entry per Inventory
  resource; a resource without monitoring stays a valid managed resource.
- `applyResolvedNFTypes(items, targets)` — applies the server-derived NF type.
- `summarizeOperational(items, hasMore, sourcesComplete)` — the published counts.
- `groupByDomain(items, ...)` — canonical domain grouping.
- `buildResourceTree(items, edges)` — hierarchy or labelled virtual grouping.
- `cpuView`, `memoryView`, `resourceMetric` — measurement-semantics accessors.

## 5. Health and lifecycle separation

Inventory lifecycle and operational health are independent dimensions:

```text
Inventory lifecycle = active   + monitoring state = unknown        (valid)
Inventory lifecycle = active   + monitoring state = not monitored  (valid)
Inventory lifecycle = retired  + historical evidence readable      (valid)
```

An `active` Inventory lifecycle is never rendered as a running process, a missing
monitoring association is never rendered as stopped, and a successful metrics HTTP
response is never rendered as service health.

## 6. Resource and target deduplication

- One operational entry per Inventory resource.
- A target is attached by `resourceId`; target identifiers are never treated as
  network-element identities.
- Logical network functions and their runtime instances remain distinct entries
  because they are distinct Inventory resources with distinct kinds.
- Multiple targets for one resource cannot occur under the accepted uniqueness
  policy; if a page ever contains them the enabled target wins, the entry is
  flagged, and the resource is counted once.
- A resource that exists only as a Discovery candidate is not an operational
  resource and is not counted.

## 7. Aggregation denominators

Every published count states its denominator:

```text
registered   non-retired Inventory network resources on the loaded page
monitored    resources with an established NF Health monitoring association
unmonitored  managed resources without a monitoring target
fresh        monitored resources whose latest measurement is inside the policy
stale        monitored resources whose latest measurement is outside the policy
unknown      monitored resources whose overall state is not a positive or
             negative claim (unknown, stale, not_configured, unprojected)
degraded     measured degraded evidence only
unhealthy    measured unhealthy evidence only
```

Freshness and overall state are orthogonal dimensions: a resource is counted once
per dimension, so a fresh measurement with an undetermined service outcome counts
as fresh **and** unknown, never healthy. Retired resources are excluded from
operational counts and remain visible in the list.

## 8. Pagination and completeness

Both surfaces read one bounded page per source (Inventory resources, NF Health
targets, Topology edges). The completeness marker is explicit:

- `complete` — the loaded page is the whole filtered population and every source
  answered;
- `partial` — more pages exist or a source failed.

A partial page is never presented as a platform total, an API failure is never
replaced by zero counters, and the table caption states the completeness of the
rows it shows.

## 9. Bounded status projection

`GET /api/nf-health/targets` previously returned an empty coverage summary, which
would have made "nothing was measured" indistinguishable from "no evidence
available". The list projection now carries the same latest-evidence projection
the detail endpoint uses, computed with exactly two aggregations per page
(one for samples, one for runs) served by the existing
`(targetId, collectedAt)` / `(targetId, startedAt)` indexes — never one request
or one query per target.

Additive summary fields:

```text
statusComplete     whether the latest-evidence projection was readable
overallState       server-derived, identical to the detail projection
latestSampleAt     observation timestamp of the latest accepted sample
layers             the latest sample's layer evidence (L1/L2/L3 states)
resourceMetrics    latest sample's exporter-process metrics only
lastRunStatus      most recent collection attempt outcome
lastRunAt          most recent collection attempt time
coverage           measured layers derived from the stored sample
```

A target without a stored sample reports `coverage` all-false with an overall
state that is never `healthy`. The response is additive: existing fields, cursor
contracts, rate limits and authorization are unchanged.

## 10. CPU and memory measurement limits

- `process_cpu_seconds_total` is a cumulative CPU-time counter. It is displayed
  as cumulative seconds and is never converted into a utilization percentage: no
  verified interval calculation exists in this build. The view model exposes no
  percentage field at all.
- `process_resident_memory_bytes` is displayed in binary units. Virtual memory
  and its maximum are never presented as resident usage.
- A metric whose owning target is not fresh is labelled historical.
- A metric that is absent is displayed as unavailable, never as zero.
- CPU percentages are never summed across processes to claim host utilization,
  and resident memory is never summed into an invented host total.

## 11. Hierarchy authority and fallback

- Membership uses canonical `resourceId`; process names are never tree ids.
- Only declared Topology `contains` edges define containment. `depends_on` and
  `connects_to` are ignored for hierarchy.
- Retired edges and edges whose endpoints are not on the loaded page are ignored.
- Cycles are broken defensively: every resource appears at most once.
- Resources without a parent remain visible as roots; a child whose parent is
  missing is preserved as an orphan rather than dropped.
- When no `contains` edge exists, the surface renders a clearly labelled virtual
  grouping by canonical domain. That grouping is a UI categorisation only and
  never claims a physical location or a Topology edge.

## 12. Permission boundaries

Both surfaces use the existing read authorization (`core.read`). Users without the
required permission receive no operational data: the endpoints they call remain
RBAC-governed and unchanged. No write action exists on either surface; Inventory
creation, update and retirement continue through their existing
`core.configure`-governed workflows. The surfaces expose no subscriber identity,
session secret, credential or unfiltered metric label.

## 13. Unsupported or incomplete operational metrics

The following are intentionally absent and rendered as unavailable or unknown:

- CPU utilization percentage (no verified interval calculation);
- host-level aggregate utilization (no host capacity authority);
- subscriber or online-user counts from the operational overview (the existing
  business analytics keep their own authoritative sources);
- IMS L2/L3 measurements (no metrics exporter exists for IMS functions);
- service health for activity-only or cumulative-counter evidence (the Phase
  5-B-C semantics keep L3 `unknown`).

## 14. Future migration dependencies

Not implemented in this phase, and each requires its own authorization:

- Log Center, UE information, Knowledge Base, Alarm Center, signaling analysis
  and automated remediation;
- deployment template management, MML command execution and process control;
- remote process collection and new exporter integrations;
- any physical site/region hierarchy (requires authoritative Inventory kinds and
  declared Topology containment, not a fabricated tree).
