# Site / Network Operations Workbench

This document describes the implementation in source. Deployment, production
configuration and real multi-host HTTPS acceptance remain separate operator work.

## Surface and ownership

`/inventory/groups` is the fourth Inventory view. It composes the existing
operations frame and exposes overview, resources, Agents, open alerts,
configuration evidence and assignment checks. It adds no sidebar domain.

The Go operations-view domain owns three authenticated, read-only registrations:

```text
GET /api/operations/groups
GET /api/operations/groups/summary
GET /api/operations/groups/members
```

All require `core.read`, use per-user/endpoint rate limits of 120/60 seconds,
apply a five-second request budget and return `Cache-Control: no-store`.
Inventory and Topology retain their original write API paths and response shapes.
There is no new collection, Agent protocol, remote command or business database write.

## Identity and explicit declarations

Inventory remains the sole authority for site, host and NF UUIDs. Active,
directed Topology `contains` edges establish organizational containment;
`runs_on` and other relationship types do not enlarge a group.

The optional resource attribute `xcloudOperationalScopes` contains at most eight
declarations on site, host, network_function or network_function_instance:

```json
{
  "attributes": {
    "xcloudOperationalScopes": [
      { "networkKey": "lab-a", "operatorName": "Operator A", "plmns": ["00101", "001001"] }
    ]
  }
}
```

Network keys are unique within a resource and follow the existing Agent key
grammar. Operator names are trimmed, bounded to 128 Unicode code points and
reject controls. Each declaration accepts at most sixteen distinct five/six
digit PLMN strings. Leading zeros and five/six digit differences are preserved.
The controlled BSON attribute branch is projected as JSON objects, not BSON
key/value arrays; other attributes retain the existing resource contract.

Networks are query projections, not new Inventory kinds or persisted network
objects. Their directory combines valid resource declarations and Agent network
keys. Removing the final declaration removes an otherwise empty network view.
Operator names are management labels, not stable operator identities. PLMN
strings do not establish associations to Inventory PLMN resources or roaming
agreements. None of these fields are tenant authorization boundaries.

Resource network declarations do not inherit from sites or hosts. Agent scope
does not grant a network identity to its host or the host's NFs. Membership can
be shared explicitly; within a group resources are deduplicated by UUID.
Counts across groups are not additive.

## Scope and evidence

The shared `ResolveGroupScope` implementation serves the workbench and reports.
Network, site, host, operator name, PLMN and domain selectors intersect. Network,
operator and PLMN predicates must match the same declaration element. Invalid
selectors are rejected; an empty intersection never falls back to all resources.

Site/host selection follows bounded active containment. Default populations omit
retired resources and do not traverse through retired nodes. `includeRetired=1`
allows retired records under current active relationships; it does not resurrect
retired edges or reconstruct historical membership.

Agent populations use their own explicit scope fields. Declared Agent ownership
does not prove containment. Assignment checks also inspect Agents bound to
selected host UUIDs, so contradictory metadata is not hidden by the network
filter. Missing references, cycles, shared paths and mismatched declarations are
reported without rewriting either authority. Unknown ancestry is not unassigned.

Completeness is reported independently for Inventory, Topology, Agent metadata,
monitoring, alerts, configuration and assignment checks. Partial or failed scope
resolution yields null totals and bounded observed counts, not complete zeros.
Sources are eventually consistent; `generatedAt` is not a cross-collection snapshot.

NF denominators contain only logical NF and NF instance kinds, counted separately.
Target resolution uses at most fifty UUIDs per batch. Confirmed absence is
unmonitored; failed resolution is unresolved. A successful evidence read without
a sample remains configured but unmeasured. Lifecycle, process existence and
L1 measurements never establish L3 health. Retired NFs are excluded from current
health coverage.

Open alerts include active, acknowledged, assigned and recovering states. Their
total is a full-filter query, independent of the current page. Unbound alerts
are never assigned by name. `GET /api/nf-alerts?alertId=<uuid>` is an additive,
exclusive exact lookup for opening the existing evidence drawer; it retains the
list envelope and cannot be combined with list filters.

Configuration reads use the existing source service and explicit source resource
UUIDs, with a bounded resource-scoped metadata repository read. Empty resource
scopes remain empty. GET never captures a file. Source paths, raw configurations, fingerprints
and snapshot bodies are excluded from the group projection. Attempts, successful
evidence and baselines remain distinct. Change counts show the comparable-source
denominator, non-comparable sources and failed latest attempts. Coverage is limited
to controller-local declared files; remote Agent configuration/log collection is
not implemented. The local in-process collector is not counted as a remote Agent.

## Maintenance

Admin/operator site creation, resource declaration updates and relationship
changes reuse Inventory/Topology application services. Every write revalidates
the actor against `app_users`, retains `core.configure`, CAS or active-tuple
uniqueness, validation and best-effort audit. Missing actor storage fails closed.
Viewer writes remain 403. Agent metadata and credentials remain admin-owned.

Updates preserve unowned attributes. New/changed controlled declarations are
validated and normalized; unchanged malformed legacy attributes can survive an
unrelated update and are reported invalid during projection.

Containment add and retire are independent operations, not an atomic move or a
single-parent constraint. Each result is shown explicitly. Partial changes are
re-read and never advertised as a completed migration. Site retirement retains
members, edges, Agents and historical evidence. Endpoint retirement races remain
the existing MongoDB foreign-key limitation, not a new transactional guarantee.

## Reports, URLs and limits

The original four `/api/ops-reports/*` endpoints accept additive group selectors.
Their resource, domain, severity and window contracts remain; domain values now
include all ten canonical Inventory domains. Group reports filter historical
evidence by **current** assignments and explicitly label that meaning.
Agent sections remain current state, without historical availability claims.
Unsupported source filters are unavailable rather than silently dropped.

Group list cursors bind selectors, section and membership revisions. Group report
cursors additionally bind the absolute window and report section. Changed scope
requires pagination restart. Legacy ungrouped report cursors remain compatible.
CSV appends grouping metadata after the original columns and preserves formula
escaping, null semantics and row/byte limits.

| Boundary | Limit |
| --- | --- |
| Directory/member page | Default 50, maximum 200 |
| Selected resource population | 1000 |
| Containment traversal | 5000 edges, 8 levels |
| Selected/related Agent evidence | 1000 per bounded projection |
| NF association batch | 50 canonical UUIDs |
| Configuration projection | 1000 sources, bounded pages |
| Report window | At most seven days, `[from,to)` |
| Export | 10000 rows, 10MiB |

The directory is lazy; health is not prefetched for every group. URL state retains
selection, filters, tabs and independent section cursors. Inventory details retain
legal Inventory `returnTo`; cross-entity details open in a clearly labelled new
tab without expanding return-address allowlists.

The selected site's host directory is organizational navigation; it deliberately
omits network predicates and labels that context. The selected host's actual
member view still applies all explicit intersection predicates. Nested network
site and site host directories have independent bounded cursors.

`PERFORMANCE_FINDING`: current inventory indexes do not cover the new reserved
network attribute, and Agent metadata equality lookups have no dedicated group
indexes. Requests are bounded, but these predicates can scan the collection.
No GET or startup projection creates indexes. Larger deployments require measured
query plans and an operator-owned index change through the existing index authority
before claiming capacity beyond the tested population.

## Validation boundary

Unit tests cover intersection, non-inheritance, deduplication, unknown/absent
semantics, actor changes, CAS behavior, cursor invalidation and safe projections.
Opt-in Linux tests start their own mongod and HTTP processes, with explicit DEMO
data and fixture principals. They do not authenticate to production, inspect real
configuration files, or prove multi-host TLS deployment. Browser evidence and
operator acceptance must state those distinctions.

Related: [Inventory](inventory-resource-model.md), [Topology](topology-dependency-model.md),
[Agents](agent-management.md), [configuration observations](configuration-snapshots.md),
[reports](operations-reports.md), [operator guide](../operations/site-network-workbench.md).
