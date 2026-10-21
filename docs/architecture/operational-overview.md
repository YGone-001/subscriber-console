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
/            Operations Overview (primary surface: full-collection posture
             KPIs, runtime attention queue, paired local-runtime and
             managed-NF summaries)
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
| Operational summary cards | `/api/v1/deployment/status` | summary cards over real populations | NF Health + NF Alerts, from the full-collection operations summary; Inventory is read by the managed-NF view | Implemented |
| Component status distribution | deployment status payload | status distribution with explicit denominators | local runtime snapshot and NF Health overall states, each in its own summary panel | Implemented |
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

## 7. Aggregation denominators and NF populations

Every published count states its denominator:

```text
registered   non-retired network-function resources on the loaded page
             (kind network_function or network_function_instance only)
monitored    network functions with a confirmed monitoring association
unmonitored  network functions where an authoritative lookup confirmed absence
unresolved   network functions whose association could not be resolved
fresh        monitored network functions whose latest measurement is inside the policy
stale        monitored network functions whose latest measurement is outside the policy
unknown      monitored network functions whose overall state is not a positive
             or negative claim (unknown, stale, not_configured, unprojected)
degraded     measured degraded evidence only
unhealthy    measured unhealthy evidence only
```

**Network-function population.** Only `network_function` and
`network_function_instance` are network functions. `region`, `site`, `host`,
`cluster`, `virtual_machine`, `interface`, `ip_address`, `network_slice` and every
other Inventory kind are valid managed resources but are counted separately as
`nonNfResources` and never inflate an NF total. Organizational parents may still
appear in the hierarchy.

**Logical NF versus instance.** `logicalFunctions` and `instances` are reported
separately; the combined `registered` value is a count of managed NF records, not
a count of running instances. Instance presence is never inferred from process
names.

**Unresolved versus unmonitored.** A resource may only be reported as unmonitored
when an authoritative association lookup for that resource completed and returned
no target. When the lookup fails, the resource is reported as `unresolved`, is
never counted as unmonitored, and keeps its Inventory row visible.

Freshness and overall state remain orthogonal dimensions: a resource is counted
once per dimension, so a fresh measurement with an undetermined service outcome
counts as fresh **and** unknown, never healthy. Retired resources are excluded
from operational counts and remain visible in the list.

## 8. Association resolution and completeness

### 8.1 Authoritative bounded association lookup

`GET /api/nf-health/targets` accepts one additive, strictly validated filter:

```text
resourceIds=<uuid1>,<uuid2>,...
```

- comma-separated canonical Inventory resource UUID v4 values;
- at least one and at most 50 identifiers (`MaxTargetResourceFilterIDs`);
- empty entries, malformed values and oversized lists are rejected with
  `INVALID_RESOURCE_ID` / `RESOURCE_ID_FILTER_TOO_LARGE` (HTTP 400) and are never
  silently truncated;
- repeated identifiers are deduplicated while preserving request order;
- the filter is exclusive: combining it with `cursor`, `q`, `enabled` or `limit`
  is rejected with `UNSUPPORTED_QUERY_COMBINATION` (HTTP 400), because a filter
  that could hide a target would turn a hidden target into a false confirmed
  absence;
- the response is a single bounded page (`hasMore=false`, no cursor) that
  authoritatively answers "which of these resources have a monitoring target?";
- the lookup performs one indexed `$in` query over the existing partial unique
  `resourceId` index — never one query per resource;
- authentication (`core.read`), rate limiting and the response envelope are
  unchanged, and existing callers that omit the parameter keep the previous
  paginated behavior.

A page of at most 50 Inventory resources is therefore resolvable with exactly one
NF Health request.

### 8.2 Completeness per source

Completeness is tracked independently for four sources and combined only for
display:

| Dimension | Meaning |
|---|---|
| `inventory` | all resources of the queried population are loaded |
| `monitoring` | every visible resource has an authoritative association result, including confirmed absence |
| `telemetry` | every associated target has a successful latest-evidence projection |
| `topology` | every relationship needed for the claimed hierarchy was evaluated |

`complete` is declared only when every required dimension is complete;
`unavailable` in any dimension dominates; otherwise the combined state is
`partial`. A partial Inventory page is never presented as a platform-wide total,
and an unavailable monitoring read is never converted into a zero monitored
count.

## 9. Bounded status projection and empty-history semantics

`GET /api/nf-health/targets` previously returned an empty coverage summary, which
would have made "nothing was measured" indistinguishable from "no evidence
available". The list projection now carries the same latest-evidence projection
the detail endpoint uses, computed with exactly two aggregations per page (one for
samples, one for runs) served by the existing `(targetId, collectedAt)` /
`(targetId, startedAt)` indexes — never one request or one query per target.

Additive summary fields:

```text
statusComplete     whether the latest-evidence projection succeeded
overallState       server-derived, identical to the detail projection
latestSampleAt     observation timestamp of the latest accepted sample
layers             the latest sample's layer evidence (L1/L2/L3 states)
resourceMetrics    latest sample's exporter-process metrics only
lastRunStatus      most recent collection attempt outcome
lastRunAt          most recent collection attempt time
coverage           measured layers derived from the stored sample
```

**Completeness describes the read, not the evidence.** A successful projection
reports `statusComplete=true` even when the target has no stored sample yet:

```text
successful projection, no sample   statusComplete=true, coverage all-false,
                                   overallState never healthy, latestSampleAt absent
successful projection, sample      authoritative sample-derived state with
                                   freshness gating
failed projection                  statusComplete=false; coverage is unavailable
                                   rather than falsely confirmed unmeasured
```

A newly configured target without collection history is therefore a configured,
unmeasured target, not an infrastructure read failure. The list and detail
endpoints agree field by field, and freshness, last successful measurement, last
attempt, latest failed run and historical samples are preserved unchanged.

### 9.1 Pagination and filter-state integrity

- Changing a server-side filter (`q`, `domain`, `kind`) resets the cursor, the
  cursor history and any tree selection that belonged to the previous query.
- Pagination controls never navigate with a cursor from another query.
- The client-side monitoring filter reads only the authoritative association
  projection of the current page; it never reuses a stale projection.
- Read requests are keyed by their full query (including the resolved resource
  identifiers), so a stale response cannot overwrite a newer query result, and
  the bounded Topology read is abortable on unmount or query change.
- Manual refresh works, errors stay visible, and no unbounded retry or polling
  loop exists.

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
- Edges are read with bounded cursor pagination (`relationshipType=contains`,
  200 per page, at most 3 pages). The loaded edges are kept, and the Topology
  dimension is marked `partial` when the bound is reached, so a missing edge from
  an incomplete page never proves that containment does not exist.
- A failed edge read marks Topology `unavailable`; it never becomes an empty
  authoritative graph.
- Retired edges and edges whose endpoints are not on the loaded page are ignored.
- Cycles are broken defensively: every resource appears at most once.
- Resources without a parent remain visible as roots; a child whose parent is
  missing is preserved as an orphan rather than dropped.
- When no `contains` edge is present, the surface renders a virtual grouping by
  canonical domain with a label that matches the actual certainty:

```text
declared                 hierarchy from declared contains relationships
virtual_no_containment   no declared containment exists (complete edge read)
virtual_partial          topology read incomplete; containment may exist beyond
                         the loaded pages
virtual_unavailable      topology unavailable; absence of containment is not
                         established
```

  A virtual grouping is a UI categorisation only and never claims a physical
  location or a Topology edge.

## 11.1 Monitoring read failures

- A failed Inventory read keeps the error visible and renders no zero counts.
- A failed association lookup keeps every Inventory row visible, marks the
  monitoring dimension `unavailable`, reports the affected resources as
  `unresolved` and preserves retry.
- A failed latest-evidence projection marks the telemetry dimension `partial`
  and the affected rows `statusComplete=false`, never "nothing measured".
- A failed Topology read keeps the resources loaded so far and labels the
  hierarchy `virtual_unavailable`.

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
- subscriber or online-user counts derived from the Inventory/NF Health
  projection (the overview's EPC/5GC online KPI reads the separate UE Info
  source and publishes its source coverage);
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

## 15. Presentation surfaces

Four presentation additions keep the read-only projection semantics of this
document intact. None of them adds an endpoint, mutates data or derives a count
that the projection model does not already define.

- **Operations overview page** (`OperationsOverviewPage`): the default `/`
  surface. Four full-collection posture KPIs (running/expected runtime
  components, EPC/5GC online users with source coverage, managed NFs with
  health/freshness, unresolved NF alerts) deep-link to their owning surfaces. A
  runtime attention queue lists stopped, unverified, unknown and stale local
  components from the full runtime snapshot; `not_detected` (never observed and
  not expected) never enters the queue. Two paired summaries keep local runtime
  and managed NF health separate, with page scope and per-source completeness
  stated explicitly. The business analysis sibling view (`?view=business`) is
  mounted only while selected and reads `/api/analytics/metrics` plus
  `/api/ue-info?summary=1` for real 24-hour usage, top usage, tariff adoption,
  OCS resource health and a business risk queue. It never renders a generated
  trend or a synthetic readiness score, and the page H1 remains the Operations
  Overview title. No API path, route or collection is added.
- **Operations workbench navigation** (`OperationsNav`): one tab strip rendered
  by the four operational routes (`/inventory`, `/topology`, `/discovery`,
  `/nf-health`). It adds no route and no destination; nested detail routes keep
  the owning tab active.
- **Network-element card wall** (`NetworkElementCards`): the scannable view of
  the same projection the table renders, grouped by canonical Inventory domain,
  with the monitoring state, the three layer-coverage marks and resident memory.
  The table remains the audit surface; its semantics are unchanged.
- **Unmanaged-process strip** (`UnmanagedProcesses`): verified running processes
  whose runtime inventory association is `absent`. They are visible, explicitly
  not monitored, and never counted as faults; management happens only through
  the governed runtime bootstrap in the runtime view.

`/inventory` accepts a `view` query parameter (`network` as default, `list`,
`runtime`) so a specific presentation is linkable. Every unavailable value on
these surfaces remains an explicit unavailable state, never a zero and never a
positive health claim.
