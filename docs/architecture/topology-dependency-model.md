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
  "interfaceNames": ["N7"],
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

Mutable: `description`, `labels`, `attributes`, `interfaceNames`.

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

### 2.3 Controlled interface names

`interfaceNames` is an optional array on every edge. It records a declared
3GPP interface segment; it does not prove live connectivity.

```text
maximum 8 names per edge
trim and deduplicate before storage
exact, case-sensitive membership in the server catalog
empty array = unannotated
legacy document without the field = []
unknown name = HTTP 400 INVALID_INTERFACE_NAME
never inferred from relationshipType or endpoint roles
```

The catalog lives in `backend/internal/topology/catalog.go` and is returned by
`GET /api/topology/meta` together with `catalogVersion`. V1 contains 46
`nf_nf` entries: 20 5GC reference points, 9 5GC SBI services, 12 EPC reference
points and 5 IMS reference points. External interfaces, including `Gm`, are not
part of the v1 catalog or the edge form.

Role tokens in the catalog use the compact values stored in Inventory, for
example `sgwc`, `sgwu`, `pgwc`, `pgwu`, `pcscf`, `icscf` and `scscf`. Display
labels use the standard 3GPP hyphenated forms (`SGW-C`, `SGW-U`, `PGW-C`,
`PGW-U`, `P-CSCF`, `I-CSCF`, `S-CSCF`, `SMSC`); matching and storage use the
compact Inventory token. 5GC NFs such as `AMF`, `SMF`, `UPF` and `PCF` remain
unhyphenated.

Endpoint compatibility is advisory in v1. The catalog `endpoints` and
`producerRole` fields populate form suggestions; they are not hard validation.
DRA and SCP are proxy nodes, not logical endpoints: an interface name on an edge
through a proxy describes the logical segment and must not be presented as a
direct logical link. Shared HSS, PCRF and OCS resources may participate in more
than one domain, so catalog domains are suggestions rather than constraints.

Old edges without interface names are shown as unannotated. They are never
backfilled and no name is guessed from the endpoints.

Update semantics: omitting `interfaceNames` preserves the stored value for
backward compatibility; an explicit empty array clears it; a non-empty array
replaces it after catalog validation.

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
- Every supplied interface name must be an exact member of the controlled
  catalog, with at most eight names after trimming and deduplication.
- Catalog endpoint compatibility is advisory only; it is not a hard rejection.

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

Eight Topology endpoints:

| Method | Path | Access | Permission |
| --- | --- | --- | --- |
| GET | `/api/topology/meta` | read | `core.read` |
| GET | `/api/topology/live` | read | `core.read` |
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
`158`; canonical frontend routes are `39`.

### 6.1 Metadata

`GET /api/topology/meta` returns the backend-authoritative vocabulary:

```text
schemaVersion
relationshipTypes
lifecycleStates
catalogVersion
interfaceCategories
interfaceScopes
interfacePlanes
interfaceCatalog
```

`interfaceCatalog` is the controlled v1 vocabulary. `interfaceScopes` includes
`nf_nf` and the reserved `external` value, but v1 contains no external entries.
The frontend never maintains a competing hardcoded taxonomy; it consumes this
endpoint.

Every catalog entry carries `name`, `category`, `domains`, `plane`, `scope`,
`spec` and `description`; reference points may carry suggested `endpoints`, and
SBI entries carry a `producerRole` instead of fixed endpoints. Entries without
fixed endpoints (`Ro`) and SBI entries omit `endpoints`.

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
optional `description`, `labels`, `attributes`, `interfaceNames`. Every other
field - including server-owned identity and provenance - is rejected. Success
returns `HTTP 201` with `revision = 1` and `lifecycleState = active`.

Update accepts `expectedRevision` and a nested `edge` object containing only
`description`, `labels`, `attributes`, `interfaceNames`. Empty metadata
replacement is supported. Omitting `interfaceNames` preserves the stored value;
an explicit empty array clears it. Relationship identity is immutable and cannot
be supplied.

Unknown interface names return `HTTP 400` with code `INVALID_INTERFACE_NAME` on
both create and update.

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

### 6.6 Live runtime projection

`GET /api/topology/live` is a read-only projection, not a persisted model. It
joins the current runtime discovery snapshot with operator-owned NF configuration
files:

```text
runtime snapshot  -> nodes, process identity, runtime status
NF_ETC_MANIFEST   -> configured listeners and explicit peers
```

`NF_ETC_MANIFEST` is an absolute path to a flat JSON object mapping a recognized
component ID to the absolute config files that component actually uses:

```json
{
  "smf": ["/usr/local/src/open5gs/install/etc/open5gs/smf.yaml"],
  "icscf": ["/etc/xCloud/gcc/icscf/icscf_main.cfg"]
}
```

The manifest is environment-specific. There is no default root and no fallback
to a reference copy: a missing or unreadable file is reported per source in
`config.unavailable`, `config.complete` becomes `false`, and runtime nodes keep
rendering without invented links. Bounds are enforced: manifest `256 KiB`, each
config file `1 MiB`, `64` components, `16` files per component and `128` files
total. Paths must be absolute.

Parsed evidence is limited to explicit protocol sections:

```text
Open5GS YAML          sbi, pfcp, gtpc, gtpu server/client address and port
freeDiameter .conf    Identity, Realm, Port, ListenOn, ConnectPeer
IMS Diameter XML      DiameterPeer FQDN/Realm, Acceptor, Peer
SIP .cfg              listen=proto:address:port
DRA .cfg              local listeners and realm only
```

Addresses and ports are read from the files; no IP address or single config root
is hardcoded. The parser never parses or returns certificates, keys, passwords or
other secret material.

A live edge exists only when one component's config explicitly names another
recognized component's identity or listener address and port. Unmatched peers are
returned as `unresolvedPeers` and are never guessed into an edge. DRA config
does not synthesize direct links through the proxy. The edge `state` is derived
from the two endpoints' runtime status (`active`, `partial`, `inactive`,
`unknown`); it is not a health, traffic or connectivity claim. `inactive` is
reported only when both endpoints were explicitly observed as stopped. A
permission failure, an unverified identity, a stale observation or a component
that was never detected keeps the edge `unknown`; failed inspection is never
reported as a stopped or inactive link.

The endpoint accepts no query parameters, requires `core.read`, is rate limited
to `120/60s` per user, and returns `HTTP 503 TOPOLOGY_LIVE_UNAVAILABLE` when the
runtime snapshot is unavailable. It never writes Inventory, Topology, NF Health
or Discovery state.

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
Operations workbench navigation (shared tab strip)
Reference architecture canvas (see 9.5)
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
CNMS hardcoded NF identity
CNMS process-state-driven link colouring
CNMS direct restart action
/api/v1 runtime
JWT implementation
WebSocket authentication
direct NF control, sudo systemctl, MML executor
NRF discovery execution
AIOps RCA execution
```

All rendered resource bindings originate from current xCloud Inventory, NF Health
and Topology APIs. An interface label is architecture knowledge, never a validated
fact; the canvas legend and footnote state this explicitly.

### 9.5 Reference architecture canvas

The `/topology` route additionally renders a deterministic 3GPP reference canvas
(`ArchitectureView`). It is a three-layer projection, and the layers never merge:

```text
layer 1  reference skeleton    static, versioned frontend reference data
                               (20 roles, 33 reference points, view filters)
layer 2  authoritative binding Inventory resources matched to roles; an
                               authoritative runtime association outranks name
                               matching; an equal-ranked duplicate is reported
                               as ambiguous instead of silently chosen
layer 3  observed state        NF Health association, coverage and metrics;
                               runtime process evidence for roles with no
                               resource
```

Rules enforced by the projection model:

- a role without a resource is `unregistered`, never `stopped`;
- a role without a monitoring target is `unmonitored`, never `healthy`;
- an unresolved association lookup is `unresolved`, never `unmonitored`;
- a verified running process on an unregistered role is `observed`, which is
  process evidence only and never a health claim;
- a reference point is rendered as `declared` only when a connectivity
  relationship for the two bound resources exists in the Topology authority;
  otherwise it is `reference` and makes no claim about the deployment;
- the reference skeleton is never persisted to the topology collection and is
  never presented as topology data;
- label anchors are chosen deterministically so the canvas can be verified by
  counting nodes, links and label placements.

Components:

```text
features/topology/ArchitectureView.tsx
features/topology/components/ArchitectureCanvas.tsx
features/topology/architecture-model.ts
features/topology/reference-architecture.ts
styles/modules/architecture.module.css
```

The static reference labels use `N15` for AMF–PCF and `N36` for PCF–UDR;
`N8` remains AMF–UDM. Reference role keys and accepted role tokens use the
stored compact values (`sgwc`, `pgwc`, `sgwu`, `pgwu`), while the rendered node
labels remain the standard 3GPP forms (`SGW-C`, `PGW-C`, `SGW-U`, `PGW-U`).

### 9.6 Declared topology default view

The `actual` topology view is the default `/topology` tab. It renders only
resources whose kind is `network_function` or `network_function_instance`.

When no active declared relationship exists, the tab renders the live runtime
projection instead of a blank page. Nodes come from the current runtime snapshot;
links come only from explicit NF_ETC configuration evidence. The section is
clearly labelled as runtime identities plus configured links, and the 3GPP
reference architecture remains one click away in its own view. Reference
suggestions, runtime identities and configured links are never persisted as
topology edges.

Every `network_element` and every other Inventory kind is a support resource:

```text
hidden by default
counted and named in the loaded topology
shown only through the explicit "show support resources" toggle
grouped in a separate support column
never counted as a network function
```

Role tokens never decide NF visibility. They are used only for grouping,
display labels and future interface suggestions.

Unresolved endpoints are never hidden as support: an absent Inventory projection
is a diagnostic and remains visible. A network function also remains visible
when every one of its relationships is hidden by the support filter; the
toolbar reports the hidden support resource and relationship counts. The view
distinguishes an unavailable read, a genuinely empty topology, and a topology
that contains only hidden support resources.

The IMS column groups `icscf`, `pcscf`, `scscf` and `smsc`; the support column
groups every support resource. Grouping uses the stored compact role tokens,
while node labels use the standard 3GPP forms (`SGW-C`, `P-CSCF`, ...).

### 9.7 Domain views, boundaries and proxies

The declared topology view supports six domain modes:

```text
all domains
5gc
epc
ims
charging
cross-domain
```

In all-domain mode, nodes are arranged in domain bands (`5gc`, `epc`, `ims`,
`charging`), with role columns inside each band. Unknown or non-network domains
are placed in an `unclassified` band; support resources, when shown, occupy a
separate support band. Role columns are presentation only and never change
domain membership.

In a single-domain mode, the selected domain is scoped to its own network
functions. An NF in another domain becomes a **boundary node** only when it has
a direct declared relationship with an NF in the selected domain:

```text
boundary nodes are shown by default
boundary nodes are counted separately
the boundary toggle hides them and reports the hidden node and relationship counts
cross-domain relationship counts are always shown
an unknown-domain boundary keeps its unclassified marker instead of being guessed
unresolved endpoints connected to the selected domain remain visible diagnostics
```

Boundary relationships are the direct declared edges only. The view never walks
through a boundary node to synthesize a second-domain edge. Support resources
remain auxiliary: they are hidden by default, can be shown with the support
toggle, and never count as boundary nodes or network functions.

Cross-domain mode shows only edges whose two endpoints are network functions in
two different known domains (`5gc`, `epc`, `ims`, `charging`). Same-domain edges,
support edges and unresolved endpoints are excluded. The domain bands still show
which domain each endpoint belongs to.

DRA and SCP are proxy nodes, not logical interface endpoints. They are rendered
with a low-emphasis proxy treatment and their detail states
`via DRA` / `via SCP`. Two declared edges through a proxy remain two edges; they
are never collapsed into a synthetic direct link.

### 9.8 Interface names in the UI

The edge form consumes `interfaceCatalog` from `GET /api/topology/meta` and
renders a controlled searchable checkbox list grouped by category and primary
domain. Each option shows its domains, plane, specification and suggested
endpoint roles or SBI producer. There is no free-text interface input, and the
form enforces the maximum of eight selections. Unannotated relationships remain
valid.

The ledger and the relationship detail render every annotated interface name.
An edge stored without names is shown explicitly as `Unannotated`; no name is
inferred from its endpoints or relationship type.

The declared-topology canvas prefers interface names for its edge labels
(multiple names are joined with ` / `) and falls back to the relationship type
when no name is present. Labels remain focus/hover-driven by default; a
`Show all interface names` control reveals labels for every annotated edge in
the current view. The rendered label carries an explicit interface/relationship
kind for visual and test distinction.

The actual-topology toolbar also provides:

```text
interface filter: all / an annotated name / unannotated
annotated coverage over the loaded relationships
show-all interface labels toggle
```

The filter is client-side over the bounded loaded edge set. A partial read is
never presented as a complete annotation population; the existing coverage
indicator remains authoritative.

### 9.9 Live topology surface

The live surface is shown when the declared relationship read is genuinely empty,
and it reads `GET /api/topology/live` independently:

```text
runtime chips        running / stopped / attention / not detected
configured links     explicit NF-to-NF config evidence count
config status        complete / incomplete / manifest unconfigured
unresolved peers     configured peers that match no recognized component
canvas               every runtime component, even when it has no link
relationships table  from / to / interface / state / evidence / endpoints
```

Runtime status is rendered as text and as a dot; stopped and not-detected
components are visually de-emphasised but remain selectable. The `attention`
chip aggregates `unverified`, `permission_denied`, `unknown` and `stale`
observations, so an inspection failure is visible in the header instead of being
silently folded into a running or stopped count. Selecting a component reveals
its process identity, runtime status, type and domain, configured listeners and
Inventory link. Configured links use a dashed edge and an explicit `configured`
evidence marker so they cannot be mistaken for declared edges. Interface names
are the preferred edge label, followed by protocol.

Unknown or unreadable config sources are listed under `Sources`; the view never
falls back to a reference config copy. An API failure renders an explicit
unavailable state with retry and a link to the 3GPP reference architecture. The
surface contains no mutation control.

## 10. Explicit Exclusions

This capability does **not** introduce:

```text
topology node collection
NF discovery worker
vendor NF / IMS / RAN adapters
SSH, NETCONF, gNMI, SNMP execution
NF restart / reload, MML terminal, configuration push, generic command endpoint
PCAP capture, HEP listener, Diameter / SIP / PFCP tracing
live network telemetry, live NF health, alarm correlation, AIOps RCA
multi-hop impact analysis
```

The live topology projection is read-only. It does not scan the network, run NF
discovery, infer an unconfigured link, persist an edge, or treat configured
evidence as connectivity or health.

The presence of a node icon or a relationship line does not imply that network
control or live monitoring has been implemented.

## 11. Verification

| Gate | Script |
| --- | --- |
| Contract and security evidence | `scripts/test-topology-contract.mjs` |
| Real MongoDB + Go HTTP integration | `scripts/test-topology-foundation.mjs` |
| Frontend UI/UX acceptance | `scripts/test-topology-ui-contract.mjs` |
| Frontend behaviour | `frontend/tests/topology.test.ts` |
| Browser-rendered acceptance | `frontend/tests/topology-screenshots.mjs` |
| Supplemental rendered HTML | `frontend/tests/render-topology-evidence.mjs` |

Backend unit tests live in `backend/internal/topology/` and
`backend/internal/livetopology/`. The integration suite runs the production
index initializer, a real Go backend and real HTTP requests against isolated test
databases.

### 11.1 Browser-rendered acceptance

The built production SPA (`frontend/dist`) is served to real Chromium together
with the deterministic, test-only API fixture adapter
(`frontend/tests/topology-fixtures.mjs`). The harness:

- captures the mandated 24-PNG matrix (Topology list and one-hop graph at
  desktop / tablet / mobile in light and dark, the create and retire dialogs, and
  the Inventory and System Health comparison pages);
- asserts operator-observable behaviour (authenticated shell, fixture
  relationships, direction representation, dialog geometry, theme application,
  Chinese labels, read-only controls for a viewer session, completed create
  workflow, no raw translation keys, no horizontal page overflow);
- verifies PNG signature, dimensions and size, and records a SHA-256 checksum per
  screenshot in `manifest.json`;
- fails closed on browser console errors, page errors, unexpected API requests,
  missing screenshots or layout regressions.

The screenshots demonstrate frontend rendering against deterministic fixtures,
not a live core-network deployment.

### 11.2 Recorded visual corrections

Two defects were found by the browser acceptance and corrected within the
Topology-specific frontend implementation only:

1. **Relationship labels overlapped the node boxes** on the one-hop graph. The
   neighbour columns were widened (`NODE_WIDTH` 176 -> 152, `COLUMN_GAP` 40 -> 36)
   and the labels gained a surface-coloured halo, so every label now sits fully
   inside the horizontal gap.
2. **A form dialog taller than the viewport pushed its own header out of view**
   and the relationship table clipped its trailing columns at desktop. The
   Topology dialogs now clear the fixed shell chrome and bound their height with
   an internally scrolling body, and the table columns are proportional so the
   full table fits the content column without a page-level scrollbar.

No global design token, shared shell rule or existing module was modified.
