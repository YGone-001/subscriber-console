# Phase 8.0 — Next.js Backend Removal Architecture Freeze

Status: ARCHITECTURE FREEZE / INVENTORY ONLY (Phase 8.0)
Frozen baseline: Phase 7.0 – 7.5 = PASS / FROZEN (`CUTOVER_TABLE = 47`, `ACTUALLY_ROUTED = 47`)

This document freezes the *removal plan* for the Next.js backend. It does **not** remove anything.
No route, no server implementation, no dependency, and no ownership is changed in Phase 8.0.

Authoritative machine-readable companion: `scripts/test-phase-8-backend-removal-readiness.mjs`
Full per-operation evidence table: `docs/backend-migration/phase-8-residual-api-inventory.md`

---

## 1. Current Dual-Runtime Architecture

The repository runs two HTTP backends behind Nginx. Ownership is decided per `METHOD + PATH`,
not per prefix.

```text
Browser
  |
  v
Nginx
  |-----------------------------|
  v                             v
Next.js :13333                Go :18888
- UI (App Router)             - Migrated API (production owner for 47 ops)
- Node API handlers            - Auth verification (HS256, independent)
  (runtime production owner     - Read APIs + governed writes
   for 41 ops = 33 canonical
   + 2 legacy aliases
   + 6 retired surfaces)
  |                             |
  +--------------+--------------+
                 v
              MongoDB
         xcloud + xcloud_ops
```

Runtime ownership resolution for `/api/*` is implemented by
`frontend/src/proxy.ts` → `resolveRouteOwner(method, pathname)`
(`frontend/src/lib/cutover-routing.ts`). If a `METHOD + PATH` matches a
`CUTOVER_TABLE` entry with `owner: 'go'`, the request is forwarded to
`GO_BACKEND_URL` (default `http://127.0.0.1:18888`) with `cutover_forward`
telemetry and **no Node fallback** (Go unreachable → HTTP 502
`GO_BACKEND_UNREACHABLE`). Otherwise the request continues into the Next.js
Node route handler (`NextResponse.next()`), which is the Node production owner.

Current measured state (derived from source by the Phase 8.0 validator).

Two ownership dimensions are measured and validated **independently**:

```text
lifecycle_class  = contract/migration state (GO_PRODUCTION_OWNED / NODE_PRODUCTION_OWNED /
                   LEGACY_ALIAS / RETIRED_SURFACE / TEST_ONLY / UNRESOLVED)
runtime_owner    = actual request owner, derived by invoking the production routing
                   function resolveRouteOwner (frontend/src/lib/cutover-routing.ts),
                   which frontend/src/proxy.ts executes per request.
```

```text
api route files          = 54
api operations           = 78
CUTOVER_TABLE            = 47  (37 present in the 78 + 10 Go-native)
ACTUALLY_ROUTED          = 47

inventory_runtime_go          = 37
inventory_runtime_node        = 41
inventory_runtime_unreachable = 0
runtime_owner_unknown         = 0
                                37 + 41 + 0 + 0 = 78

go_registered_operations = 73  (production source: cmd/server + internal/remediation)
go_registered_classified = 73  (61 inventory + 10 Go-native cutover + 2 curated unrouted reads)
go_registered_unclassified = 0
go_registration_negative_sentinel = true
go_native_cutover        = 10  (Go routes with no Node route file)

canonical_node_migration_remainder = 33  (lifecycle bucket; NOT the runtime Node count)
```

---

## 2. Node Backend Removal Boundary

The "Next.js backend" that Phase 8 ultimately removes is exactly:

```text
frontend/src/app/api/**            (54 route files, 78 operations; runtime owner of 41 = 33 canonical + 2 legacy aliases + 6 retired surfaces)
frontend/src/server/**             (repositories, governance, policy, lock, fixtures-support, __tests__)
frontend/src/proxy.ts              (cutover routing + Go forwarding + public-route gate)  -- retained until cutover boundary is finalized
frontend/src/lib/mongo*.ts         (Mongo client/driver access)
frontend/src/lib/audit*.ts         (audit writer / evidence)
frontend/src/lib/auth*.ts          (session/JWT helpers used by Node handlers)
frontend/src/lib/security*.ts      (security helpers)
frontend/src/lib/rateLimit*.ts     (rate limit helpers)
frontend/src/lib/xcloudSubscriber.ts, subscriberContract.ts, subscriberValidation.ts  (xCloud/server mapping, server-consumed)
```

Removal is **not** permitted until every residual production consumer is removed.
The exact residual set is enumerated in Section 4 and in the residual inventory doc.

---

## 3. UI / Frontend Keep Boundary

Phase 8 removes the backend runtime only. It **keeps** the entire frontend
application and all API call sites:

```text
frontend/src/app/**                (all dashboard/login pages, EXCEPT app/api/**)
frontend/src/components/**
frontend/src/hooks/**
frontend/src/lib/**                (client data-fetch helpers and SWR keys)
frontend/src/types/**              (shared types; type-only mongodb imports are BUILD_ONLY)
```

API URLs (e.g. `/api/subscribers`, `/api/profiles`, `/api/users`, `/api/ocs/subscribers`)
do not change. The frontend is owner-agnostic: it only sees Nginx.

The Phase 8.0 validator maps every frontend `/api/` caller to an authoritative
operation (`frontend_api_callers_unmapped = 0`). The only callers that do not map
to a *current* operation are two stale references to the retired `/api/audit`
surface (Section 9), which are reported, not hidden.

---

## 4. Canonical Node Migration Remainder (33) vs Runtime Node Ownership (41)

`NODE_PRODUCTION_OWNED = 33` is the canonical **lifecycle/migration bucket**:
canonical contract operations that still require migration to Go because their
`METHOD + PATH` is absent from `CUTOVER_TABLE`. There are **33** such operations.
Because this list is non-empty:

```text
Next.js backend removal readiness = BLOCKED
```

`backend_removal_ready = false` is the truthful, evidence-derived result for Phase 8.0,
with exactly 4 evidence-derived blockers:

```text
CANONICAL_NODE_MIGRATION_REMAINDER=33
RETIRED_SURFACES_PENDING_DELETION=6
LEGACY_ALIASES_PENDING_CLOSURE=2
STALE_CALLERS_TO_RETIRED_SURFACES=2
```

The 33 is **not** the complete count of operations whose current *runtime* owner is
Node. The 2 legacy read aliases and the 6 retired-but-still-reachable surfaces are
also Node-routed at runtime (Section 9), because they are absent from
`CUTOVER_TABLE` and are backed by executable Next.js route files. Runtime totals
(totals in Section 1) are therefore `37 go + 41 node = 78`; the validator derives
them by invoking `resolveRouteOwner`, never by re-labeling lifecycle buckets.

### 4a. Residual Node operations with an existing Go shadow implementation (candidate for cutover)

These are already implemented in Go but not production-routed. They are
`CANDIDATE` for a controlled production cutover (Phase 8.2) once parity is frozen.

| METHOD | PATH | Go implementation |
| --- | --- | --- |
| GET | /api/analytics/metrics | PRESENT (shadow) |
| GET | /api/analytics/sparkline | PRESENT (shadow) |
| GET | /api/ocs/balances | PRESENT (shadow) |
| GET | /api/ocs/sessions | PRESENT (shadow) |
| GET | /api/ocs/usage | PRESENT (shadow) |
| GET | /api/ocs/reservations | PRESENT (shadow) |
| GET | /api/profiles | PRESENT (shadow) |
| GET | /api/profiles/{name} | PRESENT (shadow) |
| GET | /api/profiles/{name}/stats | PRESENT (shadow) |
| GET | /api/profiles/{name}/versions | PRESENT (shadow) |
| GET | /api/ratings | PRESENT (shadow) |
| GET | /api/ratings/{id} | PRESENT (shadow) |
| GET | /api/search | PRESENT (shadow) |
| GET | /api/subscribers | PRESENT (shadow) |
| GET | /api/subscribers/{imsi} | PRESENT (shadow) |
| GET | /api/tariff-plans | PRESENT (shadow) |
| GET | /api/tariff-plans/{planId} | PRESENT (shadow) |
| GET | /api/tariff-plans/{planId}/export | PRESENT (shadow) |
| GET | /api/tariff-plans/{planId}/migrate | PRESENT (shadow) |
| GET | /api/tariff-plans/{planId}/rules | PRESENT (shadow) |
| GET | /api/tariff-plans/{planId}/subscribers | PRESENT (shadow) |
| POST | /api/subscribers/batch/precheck | PRESENT (shadow) |

### 4b. Residual Node operations with no Go counterpart (requires Go implementation first)

| METHOD | PATH | Go implementation |
| --- | --- | --- |
| POST | /api/ratings | ABSENT |
| PUT | /api/ratings/{id} | ABSENT |
| DELETE | /api/ratings/{id} | ABSENT |
| POST | /api/subscribers/policy | ABSENT |
| POST | /api/subscribers/{imsi}/traffic-adjustments | ABSENT |
| POST | /api/tariff-plans/import | ABSENT |
| POST | /api/tariff-plans/{planId}/migrate | ABSENT |
| POST | /api/tariff-plans/{planId}/rules | ABSENT |
| PUT | /api/tariff-plans/{planId}/rules/{ruleId} | ABSENT |
| PATCH | /api/tariff-plans/{planId}/rules/{ruleId} | ABSENT |
| DELETE | /api/tariff-plans/{planId}/rules/{ruleId} | ABSENT |

4a (22) + 4b (11) = 33 operations in the canonical Node migration remainder.

For a per-operation record (reason, Go status, parity, cutover readiness,
retire-vs-migrate decision, required phase) see the residual inventory document.

---

## 5. Go Registration Classification (Non-Tautological)

Production Go registrations are derived from the production binary source only:

```text
backend/cmd/server/main.go              (mux.Handle("METHOD /path", ...))
backend/internal/remediation/handler.go (RegisterRoutes → POST /api/system/audit/heal, /batch-heal)
```

Every registration must **independently** map to exactly one accepted category
(P8-I11). Merely existing inside the Go source list is not evidence:

```text
A. exact current 78-operation inventory entry           = 61
     - production-routed via CUTOVER_TABLE (owner=go)   = 37
     - Go shadow implementation, not routed             = 22
     - legacy read aliases (Go-registered; runtime=node)= 2
B. approved Go-native CUTOVER_TABLE operation           = 10  (no Node route file)
C. curated Go-native unrouted read registration         = 2   (explicit allowlist)

go_registered_operations  = 73
go_registered_classified  = 73
go_registered_unclassified = 0
```

Anything not matching A / B / C is `UNCLASSIFIED_GO_REGISTRATION` and fails
Phase 8.0 acceptance. The gate is falsifiable: a synthetic sentinel registration
(`GET /api/__phase8_unclassified_sentinel__`, never registered in production) is
asserted to classify as `UNCLASSIFIED_GO_REGISTRATION`
(`go_registration_negative_sentinel=true`), proving the classification function
can fail.

### 5a. Curated unrouted read residue (category C)

Explicit, exact-match allowlist of Go-native READ registrations that are currently
**not production-routed** — absent from the 78-operation inventory (no current
Next.js route backs them) and absent from `CUTOVER_TABLE` (so the runtime request
path does not reach Go for them). Membership is exact-match only and asserted to
be `GET`.

| METHOD | PATH | Evidence / reason |
| --- | --- | --- |
| GET | /api/tariff-plans/{planId}/operations | Node route file was deleted with the retired governance surfaces (Phase 5.7-C); the Go read registration remains; the rating UI caller `useRatingManagement.tsx:25` still references it and the request does not reach Go at runtime — tracked Phase 8 cleanup residue |
| GET | /api/ocs/balances/{imsi} | Go-first read added with OCS balance governance; no Node counterpart ever existed; no frontend caller |

All 47 cutover routes are registered by the production Go source. Independent
executable registration probes over the real production binary (invalid auth →
non-404 / non-405) are provided by the Phase 7.5 cutover suite
(`scripts/test-phase-7-platform-cutover.mjs`, section 5) which Phase 8.0 re-runs,
and by the Phase 2–6 cutover suites. Phase 8.0 adds a static source-level
cross-check across the full 78-operation inventory plus all 47 cutover routes.

Remaining coverage gap for full removal = the 33 canonical Node migration
remainder (Section 4) plus the 2 legacy aliases and 6 retired surfaces
(Section 9).

---

## 6. Authentication / Session Ownership

Authentication and session handling are Go-owned in production (Phase 6.3-B):

```text
POST /api/auth/login   -> Go
POST /api/auth/logout  -> Go
GET  /api/auth/me      -> Go
GET  /api/auth/permissions -> Go
```

The chain is: `auth_token` cookie (httpOnly, sameSite=lax) → HS256 verify →
`xcloud_ops.app_users` → enabled / unlocked / sessionVersion / role → Principal.
Go verifies independently and never trusts `x-user*` forwarded headers.

Because `proxy.ts` performs JWT verification for the *cutover gate* itself
(`jose`), and because the Next.js runtime still executes residual Node handlers
that authenticate, the Node authentication/session **logic cannot be deleted**
until the last Node-owned API handler is removed. `jose` and `bcryptjs` therefore
remain backend-only dependencies of the Node runtime during Phase 8.0–8.2.

---

## 7. Proxy Responsibilities

Responsibilities of `frontend/src/proxy.ts` (classified, all present):

| Responsibility | Evidence |
| --- | --- |
| Public API route gate | `/api/auth/login`, `/api/auth/logout` exempt from the cutover/forward gate |
| API prefix gate | `pathname.startsWith('/api/')` |
| Route ownership resolution | `resolveRouteOwner(method, pathname)` |
| Go forwarding | `forwardToGo` / `GO_BACKEND_URL` |
| Fail-closed contract | Go unreachable → HTTP 502 `GO_BACKEND_UNREACHABLE`, no Node fallback |
| Cutover telemetry | `cutover_forward` structured log |
| Node passthrough | `NextResponse.next()` for non-cutover routes |

The proxy is retained through Phase 8.0–8.3. It is removed/replaced only in
Phase 8.5 once `/api/*` is fully Go-owned (or the boundary is finalized at Nginx).

---

## 8. Node Package Dependency Graph

Tracked modules and their classified consumers (derived from source):

| Module | Consumers | Classifications |
| --- | --- | --- |
| `mongodb` | 14 | BACKEND_ONLY = 13, BUILD_ONLY = 1 |
| `jose` | 2 | BACKEND_ONLY = 2 |
| `bcryptjs` | 4 | BACKEND_ONLY = 4 |

- `mongodb`: server repositories + `lib/mongo.ts` + `server/userManagementLock.ts`
  (BACKEND_ONLY); `types/xcloud.ts` uses `import type` → BUILD_ONLY.
  `lib/xcloudSubscriber.ts` holds a value import but is imported only by
  backend/server modules → BACKEND_ONLY.
- `jose`: `proxy.ts` + `app/api/auth/login/route.ts` (both backend runtime).
- `bcryptjs`: `app/api/auth/login` + `app/api/auth/users*` (backend runtime).

```text
UNRESOLVED dependency consumers = 0
FRONTEND_REQUIRED runtime consumers of mongodb/jose/bcryptjs = 0
```

No dependency may be removed from `package.json` until all of its consumers above
are deleted (Phase 8.4).

---

## 9. Compatibility / Retirement Strategy

Every operation has exactly one **lifecycle** classification (contract/migration
state; see residual inventory doc):

```text
GO_PRODUCTION_OWNED = 37   contract migrated; production owner is Go (CUTOVER_TABLE)
NODE_PRODUCTION_OWNED = 33 canonical Node migration remainder (removal blocker)
LEGACY_ALIAS = 2           read-only compatibility aliases: GET /api/auth/users, GET /api/auth/users/{username}
RETIRED_SURFACE = 6        present as Node route files but not part of the canonical contract
TEST_ONLY = 0
UNRESOLVED = 0
```

Lifecycle class does **not** by itself express runtime request ownership.
`runtime_owner` is derived independently by invoking `resolveRouteOwner` (the
production routing function executed by proxy.ts). All eight compatibility
surfaces below are absent from `CUTOVER_TABLE` and backed by executable Next.js
route files, so each request resolves to the Next.js handler and their runtime
owner is `node` — asserted executably by P8-I20 (the routing function must also
discriminate cutover operations to Go, otherwise "unmatched defaults to Node"
would be vacuous). `RETIRED_SURFACE` does not imply `unreachable`;
`LEGACY_ALIAS` does not imply Go.

Retired surfaces still present as Node files (retire before Node removal):

| METHOD | PATH | Lifecycle | Runtime owner | Removal action | Rationale |
| --- | --- | --- | --- | --- | --- |
| POST | /api/auth/users | RETIRED_SURFACE | node | RETIRE_BEFORE_NODE_REMOVAL | `/api/auth/users` is a read-only alias; mutations are not canonical |
| PUT | /api/auth/users/{username} | RETIRED_SURFACE | node | RETIRE_BEFORE_NODE_REMOVAL | same |
| PATCH | /api/auth/users/{username} | RETIRED_SURFACE | node | RETIRE_BEFORE_NODE_REMOVAL | same |
| DELETE | /api/auth/users/{username} | RETIRED_SURFACE | node | RETIRE_BEFORE_NODE_REMOVAL | same |
| PUT | /api/users/{username} | RETIRED_SURFACE | node | RETIRE_BEFORE_NODE_REMOVAL | canonical update is `PATCH /api/users/{username}` |
| DELETE | /api/users/{username} | RETIRED_SURFACE | node | RETIRE_BEFORE_NODE_REMOVAL | delete policy is soft-delete via `POST /api/users/{username}/disable` |

Evidence: no frontend caller exists for any of the six (repository-wide caller
scan) and none is registered by Go (except the retained GET read aliases).
Behavior is intentionally unchanged in Phase 8.0 — retirement belongs to a later
controlled phase (`RETIRE_BEFORE_NODE_REMOVAL`).

Legacy read aliases: lifecycle `LEGACY_ALIAS`, decision `KEEP_COMPAT` (documented
in `AGENTS.md` §7) until the compatibility window closes; current runtime owner
`node` for both (Go-registered reads exist, but the routes are not in
`CUTOVER_TABLE`, so production requests are served by the Next.js handlers).

Stale frontend references to already-removed surfaces:

```text
frontend/src/components/SubscriberTraceModal.tsx:78  -> /api/audit?target=...
frontend/src/components/ocs/balances/OcsBalanceDetail.tsx:38 -> /api/audit?q=...
```

`/api/audit/*` was retired in Phase 5.7-C. These calls are dead against the
current backend (404). Decision: `RETIRE_BEFORE_NODE_REMOVAL` (remove the stale
UI calls before Node backend removal). They form the
`STALE_CALLERS_TO_RETIRED_SURFACES=2` blocker; non-blocking for Phase 8.0
acceptance.

Additional tracked residue (not a blocker, maps to a Go registration):
`frontend/src/components/rating/hooks/useRatingManagement.tsx:25` calls
`GET /api/tariff-plans/{planId}/operations`, which matches a Go registration
(category C, Section 5a) but is not in `CUTOVER_TABLE`; the Next.js route file no
longer exists, so the request cannot reach a handler. Cleanup tracked for
Phase 8.2.

---

## 10. Deletion Ordering

Deletion proceeds only after each precondition is met:

```text
1. Freeze + inventory (Phase 8.0)                      -- DONE (this document)
2. Close residual API parity / implement missing Go     (Phase 8.1)
3. Controlled production cutover or retirement          (Phase 8.2)
   - migrate residual CANDIDATE routes into CUTOVER_TABLE (owner=go)
   - retire RETIRED_SURFACE Node files + stale UI calls
4. Delete frontend/src/app/api/** + frontend/src/server/**  (Phase 8.3)
5. Clean frontend package deps (mongodb / jose / bcryptjs)  (Phase 8.4)
6. Finalize proxy / deployment boundary                 (Phase 8.5)
7. Backend removal production freeze                    (Phase 8.6)
```

Deletion must be method+path-scoped and reversible at each step; no step may
change Mongo schema or API paths.

---

## 11. Rollback Strategy

- Phase 8.0 is non-destructive: rollback = revert the documentation/validator commit.
- Phase 8.2 cutover rollback = flip the `CUTOVER_TABLE` entry `owner` back to
  `'node'` (same mechanism used by Phases 4–7). No schema/data migration.
- Phase 8.3+ deletion rollback = `git revert` of the deletion commit; the
  pre-deletion SHA is the authoritative restore point.
- `proxy.ts` forwarding/rollback remains available until Phase 8.5.

---

## 12. Frozen Charging-Plane Exclusions

The charging plane remains frozen and excluded from Phase 8:

```text
ocs_sessions
ocs_reservations
ocs_usage_records
ocs_events
Gy / Ro / CCR / CCA
```

Read endpoints over frozen charging data
(`GET /api/ocs/sessions`, `GET /api/ocs/usage`, `GET /api/ocs/reservations`)
are telemetry reads only and must never be turned into a charging-runtime
migration. Validated: all three are `GET`, read-only, and not in `CUTOVER_TABLE`.
Any Phase 8 recommendation that crosses this boundary must be classified
`OUT_OF_SCOPE`.

---

## 13. Phase 8 Subphase Plan

Boundaries follow discovered evidence:

```text
Phase 8.0  Architecture Freeze + Residual Inventory                 -- THIS PHASE
Phase 8.1  Residual API Go Implementation Closure
           - implement Go for the 11 residual operations with no Go counterpart
             (ratings CRUD, subscriber policy/traffic-adjustments, tariff import/rules/migrate POST)
Phase 8.2  Residual Controlled Production Cutover / Retirement
           - cut over the 22 CANDIDATE read/shadow operations into CUTOVER_TABLE
           - retire the 6 RETIRED_SURFACE Node files + 2 LEGACY read aliases (window close)
           - remove 2 stale frontend /api/audit calls
Phase 8.3  Next.js API + Server Runtime Removal
           - delete frontend/src/app/api/**, frontend/src/server/**
Phase 8.4  Frontend Dependency Cleanup
           - remove mongodb / jose / bcryptjs from package.json once proven unused
Phase 8.5  Proxy / Deployment Boundary Finalization
           - remove/replace frontend/src/proxy.ts; finalize Nginx /api/* -> Go
Phase 8.6  Backend Removal Production Freeze
```

Phase 8.0 stops at the freeze. Phase 8.1 must not be started in this phase.