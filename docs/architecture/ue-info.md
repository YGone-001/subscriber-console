# UE Information and EPC/5GC Online Users

> Current-system documentation for the read-only UE surface. It describes the
> approved source boundary, the merged projection and the counts that are
> deliberately unavailable. When this document and the running source disagree,
> the source and automated tests prevail.

Related documents:

- [Operational overview](operational-overview.md)
- [NF Health telemetry](nf-health-telemetry.md)
- [System architecture](system-architecture.md)

## 1. Scope

The feature exposes one read-only API and one SPA page:

```text
GET /api/ue-info      merged EPC/5GC UE list and optional summary
/ue-info              UE list workspace
```

The operations overview consumes `/api/ue-info?summary=1` for the
`EPC/5GC online users` KPI. No collection, write path or background worker is
introduced.

The first delivery covers EPC/5GC only. IMS online users and HSS SIP URIs are
explicitly unavailable until a separate read-only MySQL integration is approved
and configured; they are never reported as zero.

## 2. Source boundary

`UE_INFO_SOURCES` is a server-owned allowlist:

```text
mme=host:port,amf=host:port,smf=host:port
```

- Only roles `mme`, `amf` and `smf` are accepted; duplicates, schemes, paths,
  credentials and malformed ports are rejected.
- Empty configuration disables the feature explicitly; it does not fabricate an
  empty UE population.
- The backend issues only fixed read-only GET requests:
  - `GET http://<mme>/ue-info?page=-1`
  - `GET http://<amf>/ue-info?page=-1`
  - `GET http://<smf>/pdu-info?page=-1`
  - `GET http://<smf>/metrics` (for the `ues_active` gauge)
- Redirects are not followed, proxies are not consulted, responses are bounded
  to 4 MiB and every request has a 4 second timeout. Only host:port values from
  the allowlist are contacted.
- Upstream failures are reduced to safe reason tokens (`timeout`,
  `network_error`, `http_error`, `invalid_response`, `metric_absent`,
  `truncated`). Raw URLs, bodies and errors are never returned.

## 3. Merge semantics

- MME and AMF items are merged by normalized SUPI (`imsi-` prefix removed).
- SMF PDN sessions are merged into the matching SUPI. PDNs are deduplicated by
  APN, EBI, QCI, IPv4 and IPv6.
- Items without a SUPI are dropped; an empty identity is never fabricated.
- MSISDN is taken from the upstream item when present, otherwise from the
  xCloud `subscribers` collection by IMSI in one bounded `$in` query. SIP URI
  remains unavailable in this delivery.
- The result is sorted by SUPI for deterministic pagination.

## 4. Summary semantics

| Field | Meaning |
|---|---|
| `total` | merged UE records |
| `registered` | UEs whose reported MM state is `registered`; `null` when no MM state was reported |
| `idle` | UEs whose reported CM state is `idle`; `null` when no CM state was reported |
| `connected` | UEs whose reported CM state is `connected`; `null` when no CM state was reported |
| `stateUnreported` | UEs with neither MM nor CM state |
| `epc5gcOnlineUsers` | the SMF exporter's `ues_active` gauge; `null` when the metric is absent or the source fails |
| `imsOnlineUsers` | always `null` in this delivery |
| `totalSubscribers` | xCloud subscriber count; `null` when the read fails |
| `totalIMSUsers` | always `null` in this delivery |

A missing source contributes no count. The response exposes per-source
`state` (`ok`, `unavailable`, `not_configured`, `invalid_config`) and
`complete`. A partial response is still a successful read, but the UI labels it
as partial.

The SMF gauge is parsed through the NF Health registry and parser, so a metric
type mismatch or an unregistered family is dropped. Multiple exporter series
are not summed; the first accepted `ues_active` sample is used, matching the
reference console's single-gauge behavior.

## 5. API contract

```text
GET /api/ue-info
  summary=1|true     return summary only (items empty)
  q=...              search SUPI, MSISDN or SIP URI (max 64 characters)
  domain=EPS|5GS
  state=registered|idle|connected|unknown
  limit=1..200       default 50
  cursor=<opaque>    canonical page token returned by nextCursor
  offset=0..100000   legacy compatibility only; mutually exclusive with cursor
```

`pagination` returns `limit`, `offset`, `total`, `nextCursor` and `hasMore`.
`offset` remains so older clients keep working, but the SPA always pages with
`cursor`. A cursor only names a result position; it carries no filter state, so
filter changes must start from the first page.

Unknown parameters and invalid values return HTTP 400 with a stable error code.
A malformed cursor, or a request that sends both `cursor` and `offset`, returns
HTTP 400 `INVALID_CURSOR`.
The endpoint requires `core.read`, is rate-limited to 120 requests per 60
seconds per user, and sets `Cache-Control: no-store`.

## 6. UI

`/ue-info` renders:

- the shared operations page frame and workbench tab strip, with exactly one
  refresh control;
- four KPI cards (total, registered, idle, connected);
- per-source availability chips;
- server-side search and domain/state filters carried in the URL, with the page
  cursor also in the URL so reload, back/forward and a shared link restore the
  same page;
- a cursor-paginated UE table with expandable identity, radio, location, AMBR
  and PDN details;
- explicit loading, empty, error and partial states.

The operations overview replaces its former monitoring KPI slots with
`EPC/5GC online users`, `IMS online users`, `running components` and
`NF alerts`. The IMS card shows an unavailable state until the IMS source is
integrated.

## 7. Security and non-goals

- Read-only: no write, no network action beyond the allowlisted GET paths, no
  remote control, no process signals.
- No arbitrary URL, path, query or SQL input from clients.
- MSISDN/SIP URI are subscriber PII; access is limited to `core.read` and
  responses are not cached.
- IMS online users and HSS SIP/MSISDN enrichment are out of scope for this
  delivery and require a separate approved read-only MySQL boundary.
- No UE-to-Inventory association is inferred. A UE is not a managed resource.
