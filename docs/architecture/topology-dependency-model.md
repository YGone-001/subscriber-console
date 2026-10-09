# Topology Dependency Model

> Current-system documentation for the xCloud topology relationship foundation.
> It describes the implemented backend, persistence, API, security and UI model.
> The runtime described here is the current `develop` state; when this document and
> the running source disagree, the source and the automated tests prevail.

Related documents:

- [Inventory resource model](inventory-resource-model.md)
- [System architecture](system-architecture.md)
- [Feature + UI/UX completion gate](stage-feature-ui-acceptance.md)
- [Architecture evolution roadmap](architecture-evolution-roadmap.md)

## 1. Purpose and Scope

Topology records the authoritative **relationships** between resources that
Inventory owns.

```text
Inventory
   |
   +-- Resource A
   +-- Resource B
   +-- Resource C
   |
   v
Topology
   |
   +-- Edge A -> B
   +-- Edge B -> C
```

The fundamental invariant:

```text
Inventory owns NODES.
Topology owns EDGES.
```

Inventory remains the sole source of resource identity, classification, name and
lifecycle. Topology persists relationships only, and every edge endpoint is a
reference to an existing Inventory UUID. Topology never stores a second copy of
Inventory identity inside an edge document.

### 1.1 What the relationships mean

Relationships are **manually declared logical links**. An edge recorded as
`active` states that an operator has declared a relationship; it does **not**
prove live interface connectivity, registration success, or service health.

Declared topology state and observed operational state are different things. The
implementation never presents one as the other.

## 2. Persistence

```text
Database:   xcloud_ops
Collection: app_topology_edges
```

- Exactly one operational collection is created for this capability.
- `app_topology_nodes`, `app_topology_vertices` and `app_topology_resources` are
  forbidden and are never created.
- No graph database is introduced.
- No TTL is configured: topology history is retained.

### 2.1 Canonical edge model

Schema version `1`:

```json
{
  "edgeId": "uuid-v4",
  "schemaVersion": 1,
  "relationshipType": "depends_on",
  "fromResourceId": "uuid-v4",
  "toResourceId": "uuid-v4",
  "description": "SMF depends on PCF",
  "labels": {},
  "attributes": {},
  "lifecycleState": "active",
  "source": {
    "kind": "manual",
    "system": "xcloud",
    "authority": "authoritative"
  },
  "revision": 1,
  "createdAt": "UTC timestamp",
  "createdBy": "actor",
  "updatedAt": "UTC timestamp",
  "updatedBy": "actor"
}
```

`edgeId` is a server-generated strict RFC 4122 UUID v4 and is stored as the
MongoDB `_id`.

Immutable: `edgeId`, `schemaVersion`, `relationshipType`, `fromResourceId`,
`toResourceId`, `source`, `createdAt`, `createdBy`.

Mutable: `description`, `labels`, `attributes`.

`source` is server-owned provenance. It is never accepted from a client request.

### 2.2 Indexes

Created by the production index authority `scripts/init-mongo-indexes.mjs`:

| Index | Keys | Purpose |
| --- | --- | --- |
| `uniq_topology_active_edge` | `fromResourceId`, `toResourceId`, `relationshipType` (partial: `lifecycleState = active`, unique) | At most one active relationship per directed tuple |
| `topology_from_type_state_updated` | `fromResourceId`, `relationshipType`, `lifecycleState`, `updatedAt` DESC | Source-side filtered reads |
| `topology_to_type_state_updated` | `toResourceId`, `relationshipType`, `lifecycleState`, `updatedAt` DESC | Target-side filtered reads |
| `topology_updated_id` | `updatedAt` DESC, `_id` ASC | Stable keyset pagination order |

The partial unique index is not sparse. There is no test-only index schema: the
production initializer is the sole authority and the integration suite asserts
the resulting indexes.

## 3. Relationship Taxonomy

Exactly nine canonical directed relationship types:

```text
contains
runs_on
depends_on
connects_to
routes_to
registers_with
serves
uses
exposes
```

Direction is preserved. The source is always `fromResourceId`, the target is
always `toResourceId`.

Examples:

```text
SMF --depends_on--> PCF
AMF --connects_to--> SMF
NF Instance --runs_on--> Host
P-CSCF --routes_to--> I-CSCF
Service --uses--> DNN
```

No automatically generated reverse edge is persisted. Vendor-specific
relationship types are not part of this model.

## 4. Lifecycle, Uniqueness and Concurrency

```text
active
retired
```

Transitions:

```text
create -> active
active -> retired
retired -> terminal
```

- A retired edge cannot be edited or retired again.
- There is no hard-delete API.
- Active-edge uniqueness is enforced by the partial unique index across
  `(fromResourceId, toResourceId, relationshipType)`.
- A duplicate active edge returns `HTTP 409` with code
  `TOPOLOGY_DUPLICATE_ACTIVE_EDGE`.
- After retirement, the same directed tuple may be created again as a new edge
  with a new `edgeId`.

Optimistic concurrency:

```text
revision begins at 1
successful update increments revision
successful retirement increments revision
stale expectedRevision returns HTTP 409
```

There is no automatic mutation retry.

## 5. Referential Integrity

On edge creation:

- Both resource identifiers must be valid UUID v4 values.
- Both resources must exist in Inventory.
- Neither endpoint may be retired.
- Self-referential edges are rejected.
- The relationship type must be canonical.

Topology reuses a narrow, read-only Inventory resolver and never duplicates
Inventory validation or persistence ownership.

### 5.1 Retirement does not cascade

Inventory retirement does **not** cascade into topology edge mutation. Historical
edges remain readable after a referenced resource is retired.

### 5.2 Concurrency boundary

Endpoint existence is validated before the insert. MongoDB provides no
database-level foreign-key guarantee, so a concurrent Inventory retirement
between the validation and the insert is narrowed but not eliminated by this
check. This is a documented boundary, not a claimed guarantee.

## 6. API Surface

Seven Topology endpoints:

| Method | Path | Access | Permission |
| --- | --- | --- | --- |
| GET | `/api/topology/meta` | read | `core.read` |
| GET | `/api/topology/edges` | read | `core.read` |
| GET | `/api/topology/edges/{edgeId}` | read | `core.read` |
| GET | `/api/topology/resources/{resourceId}/neighbors` | read | `core.read` |
| POST | `/api/topology/edges` | write | `core.configure` |
| PUT | `/api/topology/edges/{edgeId}` | write | `core.configure` |
| POST | `/api/topology/edges/{edgeId}/retire` | write | `core.configure` |

Expected authorization:

```text
viewer   = read only
operator = read/write
admin    = read/write
```

The backend remains the final authorization authority. Go registration count is
`97`; canonical frontend routes are `28`.

### 6.1 Metadata

`GET /api/topology/meta` returns the backend-authoritative vocabulary:

```text
schemaVersion
relationshipTypes
lifecycleStates
```

The frontend never maintains a competing hardcoded taxonomy; it consumes this
endpoint.

### 6.2 List contract

`GET /api/topology/edges` accepts exactly:

```text
fromResourceId
toResourceId
relationshipType
lifecycleState
limit
cursor
```

Defaults: `lifecycleState = active`, `limit = 50`. Limit range: `1..200`.

Ordering is stable: `updatedAt DESC`, `_id ASC`. Pagination uses an opaque keyset
cursor. A cursor is bound to the filter set that produced it: reusing it against
incompatible filters is rejected, and malformed cursors are rejected.

`GET /api/topology/edges/{edgeId}` distinguishes a malformed identifier
(`HTTP 400`) from an unknown but well-formed identifier (`HTTP 404`). Retired
edges remain readable.

### 6.3 One-hop neighbours

`GET /api/topology/resources/{resourceId}/neighbors` accepts:

```text
direction          (inbound | outbound | both; default both)
relationshipType
lifecycleState     (default active)
limit              (default 50)
cursor
```

The response includes the requested root Inventory identity, the direct edge
identity, the relationship type, the edge direction relative to the root, the
neighbour Inventory identity, the current Inventory lifecycle projection, and
pagination information.

Read projections hydrate `resourceId`, `kind`, `name`, `displayName`, `domain`,
`role` and `lifecycleState`. None of these are persisted as edge identity.

Traversal is strictly **one hop**. There is no recursive BFS/DFS, no multi-hop
impact analysis, no shortest path and no automated blast-radius analysis.

### 6.4 Mutations

Create accepts `relationshipType`, `fromResourceId`, `toResourceId` and the
optional `description`, `labels`, `attributes`. Every other field - including
server-owned identity and provenance - is rejected. Success returns `HTTP 201`
with `revision = 1` and `lifecycleState = active`.

Update accepts `expectedRevision` and a nested `edge` object containing only
`description`, `labels`, `attributes`. Empty metadata replacement is supported.
Relationship identity is immutable and cannot be supplied.

Retirement accepts `expectedRevision` and a bounded, trimmed, non-empty `reason`.

### 6.5 Error semantics

| Condition | HTTP | Code |
| --- | --- | --- |
| Invalid edge identifier | 400 | `INVALID_EDGE_ID` |
| Invalid resource identifier | 400 | `INVALID_RESOURCE_ID` |
| Unknown edge | 404 | `TOPOLOGY_EDGE_NOT_FOUND` |
| Unknown endpoint resource | 404 | `TOPOLOGY_ENDPOINT_NOT_FOUND` |
| Unknown root resource | 404 | `TOPOLOGY_ROOT_RESOURCE_NOT_FOUND` |
| Retired endpoint resource | 409 | `TOPOLOGY_ENDPOINT_RETIRED` |
| Self-edge | 400 | `TOPOLOGY_SELF_EDGE` |
| Invalid relationship type | 400 | `INVALID_RELATIONSHIP_TYPE` |
| Duplicate active edge | 409 | `TOPOLOGY_DUPLICATE_ACTIVE_EDGE` |
| Stale revision | 409 | `TOPOLOGY_REVISION_CONFLICT` |
| Retired edge mutation | 409 | `TOPOLOGY_EDGE_RETIRED` |
| Unknown query parameter | 400 | `UNSUPPORTED_QUERY_PARAMETER` |
| Invalid cursor | 400 | `INVALID_CURSOR` |
| Invalid limit | 400 | `INVALID_LIMIT` |
| Invalid metadata | 400 | `VALIDATION_FAILED` |
| Server-owned field spoofing | 400 | `SERVER_OWNED_FIELD_FORBIDDEN` |

Failures are never collapsed into a generic `HTTP 500`.

## 7. Metadata Validation and Security

Labels:

```text
maximum entries = 32
lowercase key grammar
slash permitted
dot prohibited
value maximum = 128 UTF-8 bytes
```

Attributes:

```text
JSON object
maximum size = 32 KiB
maximum depth = 6
maximum aggregate keys = 128
maximum array length = 128
maximum string length = 2048
```

Rejected keys: dangerous and normalized sensitive variants (`password`,
`passwd`, `secret`, `token`, `apikey`, `privatekey`, `credential`), `$`-prefixed
keys and dot-containing keys. Topology is not a secret store.

Mutation decoding enforces strict JSON, unknown-field rejection (top level and
nested), trailing-data rejection and a bounded body size: `128 KiB` for
create/update, `64 KiB` for retire.

## 8. Audit

Records are written to the existing `xcloud_ops.app_audit_logs`:

```text
topology.edge.create
topology.edge.update
topology.edge.retire
```

Resource identity:

```text
resourceType = topology_edge
resourceId   = edgeId
```

Successful mutations record before/after data and actor information. The
retirement audit includes the exact validated reason. Rejected mutations do not
produce successful mutation audit records. Authentication material and secret
metadata are never copied into audit records.

## 9. UI Model

Two canonical frontend routes:

```text
/topology
/topology/:resourceId
```

Both render inside the shared `AppShell` and participate in the existing sidebar,
tab bar, breadcrumbs and command palette, all derived from the shared navigation
authority.

### 9.1 Relationship explorer (`/topology`)

```text
PageHeader (title, description, refresh, create for authorized users)
Filter toolbar (from resource, to resource, relationship type, lifecycle state, clear)
Relationship table (from, relationship, direction, to, lifecycle, revision, updated, actions)
Cursor pagination
```

The table renders readable resource names plus the complete endpoint UUID with a
copy affordance, preserves filter state across pages, links to an endpoint's
topology detail, and can display retired records when explicitly requested. It
never reports fabricated totals or KPI values and never loads the whole graph:
pagination is server-side.

### 9.2 Resource topology (`/topology/:resourceId`)

```text
PageHeader (resource name, kind/domain, inventory link, refresh)
Direction / relationship / lifecycle / domain filters
One-hop visualization (root node, inbound nodes, outbound nodes, directed edges, labels)
Equivalent relationship table
Selected relationship detail
```

The visualization is a deterministic SVG rendered from the Topology API only. It
distinguishes inbound from outbound relationships, applies existing design
tokens, supports light and dark themes, highlights the selected relationship,
allows selecting a node or edge, and allows navigating to a related resource.

Keyboard accessibility is preserved through the equivalent relationship table,
which is the primary semantic representation. A graph without an accessible
equivalent would not be acceptable.

Empty, loading, degraded-projection and error states are explicit. Long resource
names and dense one-hop neighbourhoods are handled without unreadable scaling.

### 9.3 Shared components

Reused from the existing design system:

```text
components/ui/PageHeader.tsx
components/ui/Dialog.tsx
components/ui/Field.tsx
components/ui/StatePanel.tsx        (ErrorState, LoadingState)
components/ui/OperationFeedback.tsx (EmptyState, LoadingRows)
styles/tokens.css                   (via semantic CSS variables)
```

Introduced for Topology only:

```text
features/topology/components/TopologyGraph.tsx
features/topology/components/TopologyEdgeTable.tsx
features/topology/components/TopologyResourcePicker.tsx
features/topology/components/TopologyEdgeForm.tsx
features/topology/components/TopologyEdgeDetail.tsx
styles/modules/topology.module.css
```

No parallel design language, no independent palette, no competing navigation
registry and no separate theme system is introduced.

### 9.4 CNMS presentation adaptation

The historical CNMS topology pages were reviewed for presentation ideas only
(domain grouping, node identification, directional links, node detail). What was
borrowed:

- Domain-oriented grouping as a **presentation filter** over existing Inventory
  `domain` values.
- Explicit direction rendering and relationship labelling.
- A node detail surface for the selected relationship.

What was deliberately **not** ported:

```text
CNMS static NF_NODES as data
CNMS static NF_LINKS as data
CNMS hardcoded NF identity
CNMS direct restart action
/api/v1 runtime
JWT implementation
WebSocket authentication
direct NF control, sudo systemctl, MML executor
NRF discovery execution
AIOps RCA execution
```

All rendered nodes and edges originate from current xCloud Inventory and Topology
APIs. No 3GPP interface label is presented as a validated fact: the model carries
no stored interface data, so none is displayed.

## 10. Explicit Exclusions

This capability does **not** introduce:

```text
topology node collection
NF discovery worker
Open5GS / Kamailio / FreeSWITCH / RAN adapters
SSH, NETCONF, gNMI, SNMP execution
NF restart / reload, MML terminal, configuration push, generic command endpoint
PCAP capture, HEP listener, Diameter / SIP / PFCP tracing
live network telemetry, live NF health, alarm correlation, AIOps RCA
multi-hop impact analysis
```

The presence of a node icon or a relationship line does not imply that network
control or live monitoring has been implemented.

## 11. Verification

| Gate | Script |
| --- | --- |
| Contract and security evidence | `scripts/test-topology-contract.mjs` |
| Real MongoDB + Go HTTP integration | `scripts/test-topology-foundation.mjs` |
| Frontend UI/UX acceptance | `scripts/test-topology-ui-contract.mjs` |
| Frontend behaviour | `frontend/tests/topology.test.ts` |

Backend unit tests live in `backend/internal/topology/`. The integration suite
runs the production index initializer, a real Go backend and real HTTP requests
against isolated test databases.
