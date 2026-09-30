# Phase 8.2 - Residual Production Cutover, Compatibility Closure & Retired Surface Removal

Evidence document for the Phase 8.2 residual production cutover.

Status: IMPLEMENTED / NOT SELF-FROZEN (independent Phase 8.2 acceptance pending).
This document records **post-Phase-8.1 / Phase-8.2 current state**. The Phase 8.0
frozen inventory (`docs/backend-migration/phase-8-residual-api-inventory.md`) and
the Phase 8.1 shadow parity evidence (`docs/backend-migration/phase-8.1-residual-go-parity.md`)
are not rewritten here; they remain the authoritative record of the pre-cutover
state (33 canonical Node-owned residuals, 2 legacy aliases, 6 retired surfaces,
2 stale callers, 2 Go-native unrouted reads).

- Ownership suite: `scripts/test-phase-8-residual-cutover.mjs`
- Behaviour parity suite (must remain valid): `scripts/test-phase-8-residual-api-parity.mjs`
- Readiness validator: `scripts/test-phase-8-backend-removal-readiness.mjs`
- Architecture: `docs/architecture/phase-8-backend-removal-architecture.md`

---

## 1. Scope and Final Invariants

Phase 8.2 performs the controlled production ownership transfer of every residual
API operation to the already frozen Go implementation, closes the legacy read
aliases on Go, retires the 6 non-canonical mutation surfaces, removes the 2 stale
frontend callers, and resolves the 2 Go-native unrouted reads.

```text
CUTOVER_TABLE  = 84   (Phase 7.5 baseline 47 + 33 canonical + 2 legacy + 2 Go-native)
ACTUALLY_ROUTED = 84  (every entry owner=go)

api_operations          = 72
go_production_owned     = 70
node_production_owned   = 0
legacy_alias            = 2
retired_surface         = 0
test_only               = 0
unresolved              = 0

inventory_runtime_go    = 72
inventory_runtime_node  = 0
inventory_runtime_unreachable = 0
runtime_owner_unknown   = 0

canonical_node_migration_remainder = 0
node_production_operations          = 0
fallback_count                      = 0
go_registered_unrouted_reads        = 0
backend_removal_ready               = true
```

Zero Node production API business execution. No MongoDB schema was altered, no
dependency was removed, no dual write or Node fallback was introduced.

---

## 2. Arithmetic Derivation

```text
final_cutover_table = 47 (Phase 7.5 frozen baseline)
                    + 33 (canonical residual Node operations)
                    +  2 (legacy read aliases moved to Go)
                    +  2 (Go-native residue cutover)
                    = 84
```

```text
ACTUALLY_ROUTED = 84 == CUTOVER_TABLE.length   (per-entry owner=go proven)
```

`api_operations = 72` is derived from the Next.js route tree (54 route modules);
after retiring 6 mutation methods the canonical operation count is 72, and every
one of them is Go production-owned except the 2 legacy read aliases which are
`LEGACY_ALIAS` lifecycle with `runtime_owner=go`.

---

## 3. Thirty-Three Canonical Residual Operations Cut Over

All 33 operations were frozen in Phase 8.1 shadow parity and are now production
owned by Go. Node route modules remain on disk as dormant reference only.

| METHOD | PATH (canonical) | Group |
| --- | --- | --- |
| GET | /api/analytics/metrics | analytics |
| GET | /api/analytics/sparkline | analytics |
| GET | /api/ocs/balances | ocs read |
| GET | /api/ocs/reservations | ocs read |
| GET | /api/ocs/sessions | ocs read |
| GET | /api/ocs/usage | ocs read |
| GET | /api/profiles | profile read |
| GET | /api/profiles/{name} | profile read |
| GET | /api/profiles/{name}/stats | profile read |
| GET | /api/profiles/{name}/versions | profile read |
| GET | /api/ratings | rating read |
| POST | /api/ratings | rating disabled-write gate |
| GET | /api/ratings/{id} | rating read |
| PUT | /api/ratings/{id} | rating disabled-write gate |
| DELETE | /api/ratings/{id} | rating disabled-write gate |
| GET | /api/search | search |
| GET | /api/subscribers | subscriber read |
| GET | /api/subscribers/{imsi} | subscriber read |
| POST | /api/subscribers/batch/precheck | subscriber semantic read |
| POST | /api/subscribers/policy | disabled-write gate |
| POST | /api/subscribers/{imsi}/traffic-adjustments | routed acknowledgement |
| GET | /api/tariff-plans | tariff read |
| GET | /api/tariff-plans/{planId} | tariff read |
| GET | /api/tariff-plans/{planId}/export | tariff read |
| GET | /api/tariff-plans/{planId}/migrate | tariff dry-run read |
| POST | /api/tariff-plans/{planId}/migrate | disabled-write gate |
| GET | /api/tariff-plans/{planId}/rules | tariff rule read |
| POST | /api/tariff-plans/{planId}/rules | disabled-write gate |
| PUT | /api/tariff-plans/{planId}/rules/{ruleId} | disabled-write gate |
| PATCH | /api/tariff-plans/{planId}/rules/{ruleId} | disabled-write gate |
| DELETE | /api/tariff-plans/{planId}/rules/{ruleId} | disabled-write gate |
| GET | /api/tariff-plans/{planId}/subscribers | tariff read |
| POST | /api/tariff-plans/import | disabled-write gate |

Each entry is appended to `CUTOVER_TABLE` in `frontend/src/lib/cutover-routing.ts`
as an exact METHOD+PATH pair with `owner=go`. The controlled proxy
`frontend/src/proxy.ts` matches only exact METHOD+PATH, so the dormant Node route
files are unreachable for these operations.

The 10 disabled-write gates keep their frozen behaviour: authenticated and
authorized requests still receive HTTP 409 `{ "error": CODE, "code": CODE }` from
Go, so no business mutation is performed. Behaviour parity for all 33 operations
(eight-one HTTP scenarios) remains proven by the Phase 8.1 suite.

---

## 4. Legacy Read Aliases Closed on Go

```text
GET /api/auth/users              lifecycle=LEGACY_ALIAS  runtime_owner=go
GET /api/auth/users/{username}   lifecycle=LEGACY_ALIAS  runtime_owner=go
```

The two legacy compatibility read aliases now resolve to the Go user-management
read implementation while retaining `LEGACY_ALIAS` lifecycle metadata. Only the
`GET` method is cut over; no mutation method was reintroduced on these paths.

---

## 5. Six Retired Non-Canonical Mutation Surfaces

The following non-canonical mutation methods were removed from their Next.js
route modules. The sibling methods in the same files are preserved; no Go
replacement was created and no fake no-op handler was introduced.

| METHOD | PATH | Module (retained siblings) |
| --- | --- | --- |
| POST | /api/auth/users | `auth/users/route.ts` (GET retained) |
| PUT | /api/auth/users/{username} | `auth/users/[username]/route.ts` (GET retained) |
| PATCH | /api/auth/users/{username} | `auth/users/[username]/route.ts` (GET retained) |
| DELETE | /api/auth/users/{username} | `auth/users/[username]/route.ts` (GET retained) |
| PUT | /api/users/{username} | `users/[username]/route.ts` (GET, PATCH retained) |
| DELETE | /api/users/{username} | `users/[username]/route.ts` (GET, PATCH retained) |

```text
retired_surfaces_active = 0
retired_surface         = 0
```

The suite asserts, per retired method, that the module no longer exports the
method and that every sibling method is still exported, so the retirement is
provable and the surviving surface is intact.

### 5.1 Real Next.js App Router HTTP retirement evidence

The retirement status is observed from a real HTTP response, never derived from
source inspection. The suite builds the frontend (`next build`) and starts the
real production Next.js application (`next start`) on loopback; `proxy.ts`
participates exactly as in production (`owner=node` for each retired METHOD+PATH,
so it calls `NextResponse.next()`), and the actual App Router method dispatcher
produces the response.

```text
POST   /api/auth/users                 -> actual_http=405
PUT    /api/auth/users/{username}      -> actual_http=405
PATCH  /api/auth/users/{username}      -> actual_http=405
DELETE /api/auth/users/{username}      -> actual_http=405
PUT    /api/users/{username}           -> actual_http=405
DELETE /api/users/{username}           -> actual_http=405
```

Each status value is assigned directly from `response.status`; no expected-status
constant, route-source parse, inventory membership or `CUTOVER_TABLE` membership
is used. A control probe against an `owner=go` route on the same real server first
proves the cutover stack is live (exactly one Go forwarding, HTTP 200); the six
retired requests then produce zero Go forwardings, zero `cutover_forward`
telemetry and zero `app_users` mutation.

---

## 6. Stale Caller Cleanup

Two stale frontend callers pointed at the retired `/api/audit` surface. Both were
removed.

```text
stale_callers_to_retired_surfaces = 0
```

The `/api/audit` path was NOT recreated, no new audit API was invented, and the
`/api/system/audit/*` diagnostics surface is untouched.

---

## 7. Go-Native Unrouted Reads Resolved

Phase 8.0 froze two Go-native reads that had no Next.js caller and were not in
`CUTOVER_TABLE`:

```text
GET /api/tariff-plans/{planId}/operations   (frontend caller present -> cut over)
GET /api/ocs/balances/{imsi}                (no caller -> source-backed decision)
```

Both are resolved by bringing them into production Go routing. The second keeps
its source-backed decision `KEEP_AS_PUBLIC_GO_API`: the Go handler is a supported
public Go API with no Node counterpart, so it is registered and routed rather
than removed.

```text
go_native_unrouted_start    = 2
go_native_residue_cutover   = 2
go_native_residue_removed   = 0
go_native_unrouted_remaining = 0
go_registered_unrouted_reads = 0
```

---

## 8. Ownership Proof Method

The suite proves ownership executably, not by inspecting handler existence:

1. Real controlled routing: requests are issued as `NextRequest` instances against
   the actual `proxy()` from `frontend/src/proxy.ts`, which resolves ownership
   through the real `resolveRouteOwner` from `frontend/src/lib/cutover-routing.ts`.
2. Real forwarding observer: every forwarded request is counted per METHOD+PATH at
   a test-side observer positioned at `GO_BACKEND_URL`; exactly one forwarding is
   asserted per newly cut-over route.
3. Real production Go binary: `backend/cmd/server` is compiled and started; the
   observer forwards to the actual production Go server against an isolated Mongo
   database pair.
4. Fail-closed: the same routes are probed with `GO_BACKEND_URL` pointed at a
   closed port; every one returns HTTP 502 `GO_BACKEND_UNREACHABLE` with zero Node
   business execution (`fallback_count = 0`, `middlewareFallthroughCount = 0`).
5. Real Next.js App Router runtime: for the six retired METHOD+PATH values the
   suite starts the real production Next.js server (`next start` over a real
   `next build`) and issues genuine HTTP requests. The observed status is taken
   from `response.status` produced by the framework's method dispatcher.

Note: the controlled proxy URL-encodes `{param}` placeholders before forwarding,
so ownership probes use the concrete instance path (`concretePath()`), i.e. the
exact METHOD+PATH a real client would send.

---

## 9. Machine-Readable Evidence

Emitted by `scripts/test-phase-8-residual-cutover.mjs`:

```text
phase82_canonical_expected=33
phase82_canonical_cutover=33
phase82_canonical_missing=0
phase82_canonical_duplicate=0

phase82_legacy_expected=2
phase82_legacy_go_owned=2

phase82_retired_expected=6
phase82_retired_active=0

phase82_retired_http_expected=6
phase82_retired_http_executed=6
phase82_retired_http_missing=0
phase82_retired_http_successful_business_responses=0
phase82_retired_http_go_forward_count=0
phase82_retired_http_business_mutations=0
phase82_retired_http_runtime_evidence=true

stale_callers_to_retired_surfaces=0

go_native_unrouted_start=2
go_native_residue_resolved=2
go_native_unrouted_remaining=0
go_native_residue_cutover=2
go_native_residue_removed=0

cutover_table=84
actually_routed=84

api_operations=72

inventory_runtime_go=72
inventory_runtime_node=0
inventory_runtime_unreachable=0
runtime_owner_unknown=0

canonical_node_migration_remainder=0

node_production_operations=0
fallback_count=0

phase82_result=PASS
```

Suite totals: `TOTAL=138 PASS=138 FAIL=0`.

Emitted by `scripts/test-phase-8-backend-removal-readiness.mjs`:

```text
api_route_files=54
api_operations=72
cutover_routes=84
actually_routed=84

go_production_owned=70
node_production_owned=0
legacy_alias=2
retired_surface=0
test_only=0
unresolved=0

frontend_api_callers_unmapped=0
stale_callers_to_retired_surfaces=0
unknown_production_owner=0

inventory_runtime_go=72
inventory_runtime_node=0
inventory_runtime_unreachable=0
runtime_owner_unknown=0
node_production_operations=0
legacy_alias_node_dependency=0

go_registered_operations=84
go_registered_classified=84
go_registered_unclassified=0
go_native_cutover_operations=12
go_registered_unrouted_reads=0
go_registration_negative_sentinel=true

canonical_residual_expected=33
canonical_residual_cutover=33
canonical_residual_runtime_go=33
canonical_residual_runtime_node=0
canonical_node_migration_remainder=0
retired_surfaces_active=0
go_native_unrouted_start=2
go_native_residue_cutover=2
go_native_residue_removed=0
go_native_unrouted_remaining=0
backend_removal_ready=true
backend_removal_blockers=0

phase8_acceptance=PASS
invariants_failed=0
```

Phase 8.1 behaviour parity remains valid after the ownership flip:

```text
TOTAL: 122 PASS: 122 FAIL: 0
phase81_cutover_count=33
phase81_runtime_node=0
phase81_scenarios_executed=81
phase81_scenarios_failed=0
phase81_result=PASS
```

---

## 10. Regression Set

Suites that assert on the route table were evolved to derive from the frozen
baseline plus the known Phase 8.2 increment rather than hard-coding a literal, so
the integrity mechanism is preserved (no assertion was weakened):

```text
scripts/test-phase-7-architecture-freeze.mjs
scripts/test-phase-7-platform-cutover.mjs
scripts/test-phase-7-read-parity.mjs
scripts/test-phase-7-alert-mutation-parity.mjs
scripts/test-phase-7-notification-stream-parity.mjs
scripts/test-phase-7-system-heal-parity.mjs
scripts/test-auth-go-parity.mjs
scripts/test-auth-cutover.mjs
scripts/test-user-management-cutover.mjs
scripts/test-auth-user-ui-integration.mjs
scripts/test-direct-operations.mjs
scripts/test-ocs-management-suite.mjs
scripts/test-current-architecture-docs.mjs
scripts/test-phase-8-backend-removal-readiness.mjs
scripts/test-phase-8-residual-api-parity.mjs
```

---

## 11. Rollback Boundary

The phase is a routing-and-surface change only:

- `CUTOVER_TABLE` gains 37 exact METHOD+PATH entries (33 + 2 + 2); each can be
  removed to return ownership to the still-present dormant Node route files;
- 6 non-canonical mutation method exports were removed; their modules retain the
  sibling methods and their Go read counterparts;
- 2 frontend callers to the retired `/api/audit` surface were removed;
- no Go registry entry was deleted, no MongoDB schema was altered, no dependency
  was removed;
- rollback = revert the Phase 8.2 commit.

---

## 12. Reproduction

```bash
node scripts/test-phase-8-residual-cutover.mjs
node scripts/test-phase-8-residual-api-parity.mjs
node scripts/test-phase-8-backend-removal-readiness.mjs
node scripts/migration/validate-inventory.mjs
```

All suites require a reachable MongoDB and a Go toolchain; the ownership suite
compiles and runs the production Go binary and fails closed on the first
divergence.
