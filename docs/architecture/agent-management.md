# Agent Management

Status: implemented in source. Remote deployment and real multi-host acceptance
are separate from the local automated evidence described below.

## Purpose and ownership

xCloud has one Go controller and an in-process local collector. Independently
installed Linux collectors publish bounded read-only observations to the
controller. The browser continues using the existing Nginx origin and cookie
session; collectors have separate machine credentials.

The current implementation supports a single controller. It does not implement
controller election, replication, failover, remote commands or tenant isolation.

Inventory remains the resource authority. NF Health remains the service-health
authority. Remote process reports never create Inventory resources, topology
edges or NF Health targets and do not establish L3 service health.

## Components

- `backend/internal/agents`: management service, machine ingress, projections,
  latest-report repository and host measurements.
- `backend/internal/agentclient`: outbound HTTPS transport and collection loop.
- `backend/cmd/agent`: standalone Linux collector binary.
- Console integration is delivered separately from the backend and collector.
- `deploy/systemd/xcloud-agent.service`: unprivileged service example.

The local controller retains the existing runtime scanner and its registry.
Remote collectors reuse that same registry and exact executable checks. Process
IDs and component identifiers are local to the authenticated collector; equal
names, host labels or PIDs on two nodes never merge node evidence.

Existing `/inventory/runtime`, live topology, log sources and local NF Health
bindings retain their existing scope. The new remote observations are exposed
through Agent management; they are not silently fed into those local authorities.

## Identity and assignment

The controller generates each agent ID and a 256-bit random credential. Only the
SHA-256 credential digest is persisted. Creation and rotation return the clear
credential once with `Cache-Control: no-store`; list and detail never return the
credential, digest or session internals.

Management assignment includes:

- a stable `networkKey` for grouping;
- an optional operator display name;
- zero or more five/six-digit PLMN strings, preserving leading zeroes;
- optional existing, non-retired Inventory site and host UUIDs.

These assignments are controlled by an administrator. The machine report schema
does not accept them. A collector-reported hostname is a display fact, never an
Inventory identity or proof of placement. Host and site references do not create
`runs_on` or `contains` relationships.

Network assignment is not a tenant boundary, a roaming agreement or an assertion
that a user is attached to a visited network. All human roles retain their
existing scope. Future multi-operator authorization and roaming workflows need
separate domain and access-control designs.

## API and permissions

| Method and path | Identity | Meaning |
| --- | --- | --- |
| GET /api/agents | Browser cookie, core.read | Local controller and bounded remote page with filtered collection-wide counts |
| GET /api/agents/{agentId} | Browser cookie, core.read | Node assignment and latest accepted observation |
| POST /api/agents | Browser cookie, user_admin + fresh actor | Provision a collector and return its one-time clear credential |
| PUT /api/agents/{agentId} | Browser cookie, user_admin + fresh actor | CAS-protected metadata, assignment and enable/disable |
| POST /api/agents/{agentId}/credentials | Browser cookie, user_admin + fresh actor | CAS-protected credential rotation |
| POST /api/agent-sessions/{agentId} | Agent credential | Replace the node's active publication session |
| POST /api/agent-reports/{agentId} | Agent credential + session + sequence | Publish the latest bounded observation |

All operations are Go-owned. The production registration set grows by seven
operations, from 168 to 175; existing METHOD+PATH contracts are unchanged.

Admin manages machine access. Operator and viewer can read. Browser writes use
the existing account store and fresh actor primitive and record best-effort
operation evidence. No approval workflow is introduced.

Machine ingress never accepts browser cookies or X-User identity. It requires
`Authorization: Agent <credential>`, an enabled agent and the current digest.
Only a loopback proxy can assert HTTPS termination; direct non-loopback plain
HTTP is rejected. Collector clients require HTTPS except a literal loopback
origin, validate certificates, can load an explicit CA, and refuse redirects.

Machine reports cannot modify assignment, users, subscribers, OCS, Inventory,
Topology, Discovery or NF Health. Their only domain write is the authenticated
collector's latest record in `xcloud_ops.app_agents`. Rate-limit and operation-log
infrastructure continue using their existing operations collections.

## Sessions and concurrency

A session is issued by the controller, lasts one hour and accepts increasing
report sequence numbers. Starting a session replaces the previous session.

The repository atomically matches enabled state, credential digest, session,
expiry and sequence before accepting a report. Disabling or rotating a node
therefore rejects an already authenticated in-flight publication. Metadata edits
also invalidate the session so the collector reconnects under the current
assignment.

An identical retry of the latest report is acknowledged without moving
`lastReceivedAt`. Reused sequence numbers with different content and older
sequences are rejected. The collector retains no unbounded queue; reconnects use
bounded exponential backoff and new observations supersede older ones.

Management revision changes only on management mutations, not each heartbeat.
Every update or rotation requires the expected revision.

## Evidence and status

Connectivity is projected using controller receipt time:

- `pending`: no report has ever been accepted;
- `online`: last accepted report is no older than 45 seconds;
- `stale`: older than 45 seconds, no older than 120 seconds;
- `offline`: older than 120 seconds;
- `disabled`: management has revoked publication access.

The 15-second reporting interval is distinct from these status windows. Node
connectivity does not determine NF process or service health. Disconnection
preserves the last observation and marks it stale.

Reports include observation time, process visibility, scan completeness, bounded
recognized components and nullable host measurements. The protocol accepts a
small clock window and rejects future/old observations. Incomplete scans cannot
establish stopped state. Running requires positive process evidence. The server
does not cryptographically attest the remote OS: evidence is attributed to the
authenticated collector.

CPU is derived from measured counter deltas; the initial sample is unavailable.
Memory uses MemTotal/MemAvailable, disk covers the collector's root filesystem,
and uptime is read from procfs. Missing or unsupported measurements stay null.
Container-limited visibility is reported explicitly.

The collection-wide summary is computed with the same filter as the page using
one Mongo aggregation. A partial page is never the platform total. A failed
remote-list read returns unavailable completeness and a null summary while the
local controller projection remains separately identifiable.

## Deployment

Build a Linux binary from the backend module:

```sh
GOOS=linux GOARCH=amd64 go build -o xcloud-agent ./cmd/agent
```

Create a dedicated unprivileged operating-system account and install the binary
and the supplied systemd unit. Configure actual read permissions for procfs;
restricted observations remain unknown/unverified instead of requiring root.

An example config is:

```json
{
  "serverUrl": "https://controller.example",
  "agentId": "<controller-generated ID>",
  "tokenFile": "/etc/xcloud-agent/token"
}
```

The optional `caFile` points to an approved CA bundle. Store only the clear
credential in tokenFile, owned by the collector account with mode 0600. Neither
Mongo access nor browser credentials are installed on the collector.

Launch with:

```sh
xcloud-agent -config /etc/xcloud-agent/config.json
```

The repository's default Nginx deployment currently serves HTTP on port 80;
its HTTPS template is not activated by this feature. Real remote enrollment
therefore requires an operator-configured, certificate-valid HTTPS edge first.
The feature does not change Nginx, firewall rules or deployed services.

No network listener is opened on the collector. It uses outbound requests to
the controller's existing API origin.

## Validation and limits

Automated tests exercise independent node evidence, duplicate/out-of-order
publication, session replacement, atomic revocation, disabled/fresh-actor
rejection, missing values, partial scans, bounded schema, transport and redirect
rules, metadata assignment and node status projection.

The Linux integration test launches two actual collector binaries against a
test-owned TLS controller on one host. It verifies executable/protocol/service
integration without claiming a deployment across physical hosts.

Latest observations are retained; this is not a historical telemetry store.
Remote log streaming, topology composition, NF Health ingestion, software
deployment and agent-driven business mutations are not implemented. Real
multi-host acceptance must use actual collector binaries and TLS transport;
unit/fixture validation is not evidence of that deployment.
