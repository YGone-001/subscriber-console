# Alert investigation workbench

The implementation in source provides bounded evidence correlation and operator-authored investigation records. Deployment and real-environment acceptance are separate from isolated validation.

## Ownership and API

Go owns five additive routes:

| Method | Path | Purpose |
|---|---|---|
| GET | /api/investigations/context | Bounded evidence for one NF alert |
| GET | /api/investigations | Cursor-paginated record directory |
| POST | /api/investigations | Idempotent manual record creation |
| GET | /api/investigations/{investigationId} | Saved record and knowledge references |
| PATCH | /api/investigations/{investigationId} | Revision-protected manual update |

The SPA routes are /investigations and /investigations/:investigationId. NF alert rows and the alert evidence drawer enter the workspace with safe return context. The operations tabs and network navigation expose the directory.

All reads require the existing session and core.read. Writes require core.configure, fresh actor revalidation immediately before persistence, and atomic CAS for updates. Viewer writes return 403. Responses are no-store; reads are limited to 120 requests per user/endpoint/minute and writes to 30. Auditing is best-effort and stores IDs, status and revision, never free-form notes or conclusions. No approvals are created.

## Correlation and temporal semantics

An anchor is an existing canonical NF alert UUID. Its persisted resourceId is the only resource identity authority for the context. An unbound or missing resource does not broaden the query. Names, process names, addresses and Agent labels never establish identity or dependency.

Inventory metadata and active Topology relations are current-at-read facts. At most twenty edges and one hop are followed, covering at most twenty-one resources. Unknown/missing or retired related resources do not silently become a measurement scope. A retired anchor can retain its historical evidence without current relationship traversal. Adjacency is neither incident-time topology, a proven impact chain nor causation.

The default window is thirty minutes before and after the first recorded trigger, capped at read time. Explicit from/to must be paired, ordered, at most twenty-four hours and not in the future. The SPA canonicalizes the initial window into the URL so refresh keeps it fixed. A saved record binds its server-owned window, alert and resource; investigationId context reads use the stored window and reject a rebound alert/resource association.

Alert lifecycle timestamps, health run start times and published configuration observation times form the timeline. Alert and health timestamp conversion/sorting uses actual instants, normalizing offsets at millisecond query/window resolution rather than lexical string ordering. Event timestamps retain their recorded RFC3339 representation as instants. Health samples are attached only when sample/run/target/resource identifiers agree and the measurement instant is within the selected window. Run success is collection success, not service health. Accepted layer states remain NF Health evidence; the workbench introduces no alternative health model.

Configuration changed=true means content differed between observations. Collection time is not an exact modification time. Change does not establish baseline drift, secret modification or root cause. Unchanged, failed and unknown comparisons remain distinct. Unpublished observations are excluded. Configuration fingerprints, raw content, projections, health bodies, metric arrays, endpoint metadata and knowledge article bodies are not selected into this projection.

Every event labels its basis: anchor alert, same resource or current declared relation. No confidence score or automatic root-cause conclusion is generated. The existing resource-filtered log workspace is linked, but logs are neither archived nor retrospectively inferred here.

## Bounds and completeness

Each evidence source has independent complete/partial/unavailable/not_applicable state, returned count, limit and reason. Complete means a bounded read succeeded; historical coverage is always unknown. Empty or missing evidence does not prove an outage-free interval or lack of change. Source failures retain readable independent evidence, without leaking raw errors.

Related alerts, health runs and configuration observations each cap at 128 records with limit+1 truncation detection. Batched measurement and knowledge reads avoid N+1 queries. The combined timeline caps at 384 events; truncation is explicit. Each Mongo query has a two-second deadline, an entire context has eight seconds, four contexts may execute concurrently, and encoded responses cap at two MiB. Over-budget responses fail explicitly. Cross-collection reads are eventually consistent, not a transaction snapshot. Source time coverage and retention gaps are not invented.

All queries use positive projections and server-owned field names. GETs and startup never create indexes or repair source records. Resource/time query performance must be assessed against deployment volume; exceeding a deadline remains unavailable rather than an empty result.

## Manual record storage

The sole new domain collection is xcloud_ops.app_investigations, using the existing Ops handle. Existing domain collections are read-only. Records contain anchor identity, fixed window, title, status, bounded notes, human conclusion, up to eight explicit knowledge UUID references, revision and up to twenty recent actor/status change metadata entries. Article contents and evidence bodies are not copied.

A request UUID plus creator and normalized request digest makes creation idempotent; reuse with different content or actor conflicts. Mutable fields are an explicit allowlist. Status is open, investigating or resolved; resolving requires a human conclusion. Reopening is an explicit manual update. Resolving an investigation does not acknowledge, recover or resolve its source alert. Record writes never modify network functions, topology, health, configuration or knowledge articles.

Deleted knowledge references remain recorded and are marked partial on read. Updates validate selected references in one bounded batch. Read-time metadata may change after validation because these are eventually consistent references. The UI keeps unsaved drafts during refresh and conflicts; explicit reload confirms draft discard. Knowledge links and manual conclusions are attributed to the operator.

The additive investigations-init CLI defaults to a no-connection dry run and optionally creates only investigation-directory indexes. It does not mutate source collections, source indexes or business data.

## Exclusions

No signaling trace, MML, arbitrary command, active network probe, NF control, automatic repair, automatic notification, multi-hop RCA, statistical prediction, maintenance window, remote Agent extension, tenancy or registration-history collection is introduced. This is a bounded investigation surface, not the full future assurance/RCA platform.
