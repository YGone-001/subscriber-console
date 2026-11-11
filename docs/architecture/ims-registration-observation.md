# IMS registration observations

The implementation in source provides a read-only, bounded database observation
surface. Production connection configuration and live registration acceptance are
separate deployment work. It does not establish end-to-end IMS availability.

## Ownership and surfaces

Go owns two authenticated reads:

```text
GET /api/ims/registrations
GET /api/ims/registrations/summary
```

The SPA route `/ims-registrations` shares the UE information workbench and its
single refresh entry. The grouping workbench passes its selectors and return
context. The operational overview reads the independent IMS summary. Existing
EPC/5GC APIs, response fields and constructors retain their behavior, including
the nullable legacy `imsOnlineUsers` and `totalIMSUsers` fields.

Every read requires the existing session and `core.read`, uses per-user/endpoint
120/60 second limits, and returns `Cache-Control: no-store`. There is no mutation,
Mongo business write, registration history collection, remote command, Agent
protocol extension, registration control, signaling trace or MML surface.

## Source declarations and database boundary

`IMS_REGISTRATION_SOURCES_FILE` names an absolute deployment-owned JSON file.
It supports at most sixteen sources with stable source ID, display name,
Inventory resource UUID, identity authority, persistence mode and explicit
connection metadata. Secrets are environment references matching
`IMS_[A-Z0-9_]+_PASSWORD`; they are never stored in the manifest or returned.
An absent manifest is `not_configured`; rejected declarations disable this
feature without disabling EPC/5GC observations.

Each S-CSCF declaration uses the fixed `scscf-mysql-v1` adapter. It expects the
verified column projection `impu(id,impu,reg_state)`,
`impu_contact(impu_id,contact_id)` and `contact(id,contact,expires)`. Column types
are checked before reading. Only the adapter's registered value `reg_state=1`
and an expiry strictly greater than the database's `NOW()` establish a positive
database binding observation. Unknown states, missing expiry and truncated
reads leave evidence and exact totals incomplete. Special permanent binding
semantics are not guessed. The profile uses the upstream public-identity enum:
`0` not registered, `1` registered and `-1` unregistered with a stored profile.
Future-expiry Contacts on a `0`/`-1` identity are inactive evidence, not active
bindings. The [upstream enum definition](https://github.com/kamailio/kamailio/blob/5.8/src/modules/ims_usrloc_scscf/usrloc.h)
is a semantic reference, not proof of a deployed binary's provenance.

`write_back` permits database observation. `memory_only` or `unknown` persistence
returns `persistence_not_current` without reading old registration rows. Database
read success never proves write-back freshness: `sourceAsOf` remains null and
freshness is `unknown`. Operators must verify deployment version, persistence
mode and enum semantics before declaring a source.

Connections are server-owned TCP destinations. Numeric ports and bounded names
are validated; non-loopback destinations require a CA and expected server name.
TLS certificate validation remains enabled. Pools have at most two connections,
two-second I/O timeouts, idle expiry and an explicit close path.

The account guard accepts only direct USAGE/SELECT/SHOW VIEW grants, including
SELECT column grants. Write privileges, role grants whose effective privileges
are unknown, and grant option fail closed. Queries execute in read-only
transactions. SQL is fixed or contains only generated placeholder lists; clients
cannot provide a destination, schema, table, column or SQL fragment. The HSS
reader does not select authentication material or subscription XML.

## Evidence and denominators

Public identities are source-qualified records; a matching URI on two independent
sources does not prove the same person. Contact IDs are deduplicated per source
across associated public identities. Private identities are optional HSS mapping
evidence, never a synonym for Contact count or an IMS success-rate denominator.
Repeated connection/database declarations are rejected; deployment owners must
also avoid aliasing one shared database as independent populations.

The response separates `counts` (exact, nullable) and `observed` (bounded evidence
returned), source read status, read completeness, and synchronization freshness.
A missing or incomplete source makes scope-wide exact counts and pagination total
null. A confirmed empty intersection stays empty. Current-page length is never
the total. An unknown binding state is not presented as zero active bindings.

`active_binding_observed` and `no_active_binding_observed` describe database
evidence. Neither a provisioned SIP URI nor absence of a Contact proves current
registration, deregistration, a failed REGISTER, a physical device count or
service health. No IMSI is extracted from an IMPI, SIP URI, realm or number prefix.

Optional HSS enrichment uses exact, binary public-identity comparisons and
explicit `impi_impu` relationships. It batches at most fifty page identities,
caps related rows and identities, and exposes ambiguity. Missing/failed HSS
mapping does not erase independently read S-CSCF binding evidence. Telephone
identities are taken only from explicitly related `tel:` values. Contact output
removes routing parameters, headers and credential-bearing user information.

## Grouping and limits

The shared operations `ResolveGroupScope` implementation selects active IMS
Inventory NF/NF-instance resources through explicit network/operator/PLMN
declarations and active `contains` relationships for site/host traversal. No
source assignment is inferred from IPs, names, URI realms, Agent metadata or
parent network declarations. A missing source resource and an unresolved scope
cannot silently broaden a query.

The scope describes the organization of reporting IMS sources, not UE location,
home operator, visited network or a roaming agreement. Existing grouping bounds
and independent Inventory/Topology coverage apply.

An entire read has an eight-second budget, individual source reads have two
seconds, and one service-wide semaphore allows four source reads concurrently.
The ten-thousand-row budget is divided among selected sources and split between
identity and joined-binding reads. Lists default to
fifty, cap at two hundred identities and two thousand projected bindings; encoded
responses cap at ten MiB. HSS enrichment has independent bounded page reads.

Five-minute HMAC cursors bind source configuration, adapter version, filters and
group fingerprint. They resume deterministic source/native-ID ordering, not a
cross-database transaction snapshot. Context changes return 409
`IMS_CURSOR_CHANGED`; malformed requests return 400 `IMS_INVALID_QUERY`.
Reads across sources, scope and HSS are eventually consistent.

The UI keys SWR reads by the complete query, cancels superseded source requests,
does not display a previous scope's rows, and hides old results after a failed
refresh. Optional thirty-second polling pauses while the tab is hidden.
Translations, theme tokens, shared dialogs and pagination remain authoritative.

## Deployment evidence boundary

The 2026-11-11 source qualification found MySQL 8.0.46 and the native column
shapes above. The inspected S-CSCF configuration declares `db_mode=0`, a
fifteen-second timer and a local BinRPC control socket. Those declarations do
not prove the running process loaded that exact configuration. The supplied
application accounts have write privileges and are not accepted observation
accounts. No permissions or NF configuration were changed.

The current integration does not invoke the control socket. A fixed read-only
runtime adapter needs separate interface qualification; a generic control proxy
is not introduced. In particular, upstream `ulscscf.snapshot` writes a file and
is not a read-only fallback. See the [official storage documentation](https://www.kamailio.org/docs/modules/stable/modules/ims_usrloc_scscf.html)
and [RPC source](https://github.com/kamailio/kamailio/blob/master/src/modules/ims_usrloc_scscf/ul_rpc.c).

Operational steps and minimum column grants are in the
[IMS observation runbook](../operations/ims-registration-observation.md).
