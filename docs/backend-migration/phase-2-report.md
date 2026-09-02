# Phase 2 Report — Read-only API Migration (Partial)

> **Generated**: 2026-08-31
> **Branch**: `develop`
> **Commit**: (pending — not committed per instructions)

---

## 1. Baseline

| Field | Value |
|-------|-------|
| Branch | `develop` |
| Starting commit | `f1429a2` |
| Ending commit | (pending) |

---

## 2. Auth Compatibility

| Feature | Status | Notes |
|---------|--------|-------|
| Cookie | ✅ | Reads `auth_token` cookie (same as Node) |
| Algorithm | ✅ | HS256 only, rejects `alg=none` and others |
| Claims | ✅ | `{ username, role, sv, exp }` — compatible with Node |
| sessionVersion | ✅ | Validates `sv` against MongoDB `security.sessionVersion` |
| locked | ✅ | Rejects locked accounts (`status=locked` or `locked=true`) |
| disabled | ✅ | Rejects non-active accounts |
| role consistency | ✅ | Normalizes `root` → `super_admin`, compares with DB |
| Node → Go interoperability | ✅ | Real Node jose fixture verified by Go — see Section 2.1 |
| x-user headers | ✅ | **NOT trusted** — identity comes from JWT + MongoDB only |

### Error Codes Preserved

| Code | Meaning |
|------|---------|
| `AUTH_INVALID_TOKEN` | Malformed JWT, missing claims, bad signature, expired |
| `ACCOUNT_NOT_FOUND` | User doesn't exist in MongoDB |
| `ACCOUNT_LOCKED` | Account is locked |
| `ACCOUNT_DISABLED` | Account is not active |
| `SESSION_REVOKED` | sessionVersion or role mismatch |
| `AUTH_UNAVAILABLE` | MongoDB connection error |

### 2.1 Cross-Language JWT Verification

| Property | Value |
|----------|-------|
| Fixture generator | `scripts/migration/generate-auth-fixture.mjs` |
| Node library | `jose ^6.2.2` |
| Algorithm | HS256 |
| Go verifier | `internal/auth/verifier.go` |
| Go test file | `internal/auth/verifier_cross_lang_test.go` |
| Fixture location | `backend/testdata/auth/node-jose-token.json` |
| Test secret | `phase2-test-secret-only-not-for-production-xcloud` |

**Verified scenarios:**
- Valid token → claims extracted correctly (username, role, sv)
- Expired token → rejected with "expired" error
- alg=none → rejected with "algorithm" error

---

## 3. Read Migration — Phase 2A + 2B

### Migrated Endpoints

| Endpoint | Method | Domain | Rate Limit | Status |
|----------|--------|--------|------------|--------|
| `/api/audit` | GET | Audit | 60/60s per user | ✅ Phase 2A |
| `/api/audit/:id` | GET | Audit | 60/60s per user | ✅ Phase 2A |
| `/api/audit/export` | GET | Audit | 10/60s per user | ❌ DEFERRED — see Section 3.1 |
| `/api/analytics/metrics` | GET | Analytics | 120/60s per user | ✅ Phase 2A |
| `/api/analytics/sparkline` | GET | Analytics | 120/60s per user | ✅ Phase 2A |
| `/api/ratings` | GET | Ratings | 90/60s per user | ✅ Phase 2A |
| `/api/ratings/:id` | GET | Ratings | 90/60s per user | ✅ Phase 2A |
| `/api/profiles` | GET | Profiles | 90/60s per user | ✅ Phase 2B |
| `/api/profiles/:name` | GET | Profiles | 120/60s per user | ✅ Phase 2B |
| `/api/profiles/:name/stats` | GET | Profiles | 120/60s per user | ✅ Phase 2B |
| `/api/profiles/:name/versions` | GET | Profiles | 120/60s per user | ✅ Phase 2B |
| `/api/ocs/balances` | GET | OCS | 120/60s per user | ✅ Phase 2B |
| `/api/ocs/sessions` | GET | OCS | 120/60s per user | ✅ Phase 2B |
| `/api/ocs/reservations` | GET | OCS | 120/60s per user | ✅ Phase 2B |
| `/api/ocs/usage` | GET | OCS | 120/60s per user | ✅ Phase 2B |
| `/api/tariff-plans` | GET | Tariff | 90/60s per user | ✅ Phase 2B |
| `/api/tariff-plans/:planId` | GET | Tariff | 120/60s per user | ✅ Phase 2B |
| `/api/tariff-plans/:planId/export` | GET | Tariff | 120/60s per user | ✅ Phase 2B |
| `/api/tariff-plans/:planId/operations` | GET | Tariff | 120/60s per user | ✅ Phase 2B |
| `/api/tariff-plans/:planId/rules` | GET | Tariff | 120/60s per user | ✅ Phase 2B |
| `/api/tariff-plans/:planId/subscribers` | GET | Tariff | 120/60s per user | ✅ Phase 2B |
| `/api/tariff-plans/:planId/migrate` | GET | Tariff | 120/60s per user | ✅ Phase 2B |
| `/api/subscribers` | GET | Subscriber | 120/60s per user | ✅ Phase 2C |
| `/api/subscribers/:imsi` | GET | Subscriber | 180/60s per user | ✅ Phase 2C |
| `/api/search` | GET | Search | 60/60s per user | ✅ Phase 2C |
| `/api/subscribers/batch/precheck` | POST | Subscriber | 30/60s per user | ✅ Phase 2C |

### 3.1 Deferred: /api/audit/export

`GET /api/audit/export` was briefly registered as a Go 501 stub. This has been **removed** — it was not contract compatible.

**Why it cannot migrate in Phase 2:**
- Node implementation calls `writeAuditLog({ action: 'audit.export' })` on both success and failure paths
- This is a **stateful read with business write side effect** (`app_audit_logs` write)
- Go does not yet own the Audit Writer
- Returning 501 is not contract compatible — clients expect real CSV/JSON export

**Migration target:** Phase 3+ after Go Audit Writer exists.

**Current owner:** Next.js (`src/app/api/audit/export/route.ts`)

### Endpoints NOT Migrated (Phase 2D+)

| Endpoint | Reason |
|----------|--------|
| `/api/subscribers` (POST) | Phase 4 (write) |
| `/api/subscribers/:imsi` (PUT/DELETE) | Phase 4 (write) |
| `/api/subscribers/batch` | Phase 4 (write) |
| `/api/subscribers/import` | Phase 4 (write) |
| `/api/auth/*` | Phase 2D |
| `/api/users/*` | Phase 2D |
| `/api/approvals/*` | Phase 2D |
| `/api/notifications/*` | Phase 7 (streaming) |
| `/api/alerts/*` | Phase 7 |
| `/api/system/*` | Phase 7 |

---

## 4. Rate Limit Compatibility

| Feature | Status | Notes |
|---------|--------|-------|
| MongoDB-backed | ✅ | Uses same `app_rate_limits` collection |
| Per-user | ✅ | Key format: `RATELIMIT:{identifier}:{window}` |
| Fixed-window | ✅ | Same algorithm as Node |
| HTTP 429 | ✅ | Same response format |
| Retry-After | ✅ | Same header |
| X-RateLimit-Limit | ✅ | Same header |
| X-RateLimit-Remaining | ✅ | Same header |
| X-RateLimit-Reset | ✅ | Same header |
| Fail open | ✅ | On MongoDB error, allows request |

---

## 5. Architecture

```
                         Browser
                            │
                            ▼
                          Nginx
                    ┌───────┴─────────┐
                    │                 │
                    ▼                 ▼
               Next.js :3000       Go :8080
                    │                 │
              UI + Writes        READ APIs
              Auth Login         Auth Validate
              Governance         (Phase 2A+2B: audit, analytics, ratings,
              Approval            profiles, ocs, tariff-plans)
                    │                 │
                    └───────┬─────────┘
                            ▼
                          MongoDB
```

---

## 6. Code Structure

```
backend/internal/
├── auth/
│   ├── claims.go          # JWT claims struct
│   ├── context.go         # Principal in context
│   ├── middleware.go       # Auth middleware (cookie → JWT → MongoDB → Principal)
│   ├── session.go          # Session validation against app_users
│   ├── verifier.go         # HS256 JWT verification
│   └── verifier_test.go    # Node → Go interoperability tests
├── analytics/
│   ├── handler.go          # GET /api/analytics/metrics, /sparkline
│   ├── model.go            # Response DTOs
│   └── repository.go       # MongoDB aggregation pipelines
├── audit/
│   ├── handler.go          # GET /api/audit, /api/audit/:id
│   ├── model.go            # Response DTOs
│   └── repository.go       # MongoDB aggregation pipelines
├── rating/
│   ├── handler.go          # GET /api/ratings, /api/ratings/:id
│   ├── model.go            # Response DTOs
│   └── repository.go       # MongoDB queries
├── profile/
│   ├── handler.go          # GET /api/profiles, /:name, /:name/stats, /:name/versions
│   ├── model.go            # Response DTOs
│   └── repository.go       # MongoDB queries (cross-DB join for stats)
├── ocs/
│   ├── handler.go          # GET /api/ocs/balances, sessions, usage, reservations
│   ├── model.go            # Response DTOs with BSON Long handling
│   └── repository.go       # MongoDB queries with numeric conversion
├── tariff/
│   ├── handler.go          # GET /api/tariff-plans, /:planId, export, operations, rules, subscribers, migrate
│   ├── model.go            # Response DTOs
│   └── repository.go       # MongoDB queries, rule normalization, conflict detection
└── ratelimit/
    └── ratelimit.go        # MongoDB-backed fixed-window rate limiter
```

---

## 7. Test Results

### Go Tests

```
ok  github.com/YGone-001/subscriber-console/backend/internal/auth         1.020s
ok  github.com/YGone-001/subscriber-console/backend/internal/config       1.016s
ok  github.com/YGone-001/subscriber-console/backend/internal/handler      1.019s
ok  github.com/YGone-001/subscriber-console/backend/internal/middleware   1.016s
ok  github.com/YGone-001/subscriber-console/backend/internal/response     1.016s
```

### Auth Test Coverage

| Test | Description |
|------|-------------|
| `TestVerifyJWT_ValidToken` | Valid HS256 token with all claims |
| `TestVerifyJWT_ExpiredToken` | Expired token rejected |
| `TestVerifyJWT_BadSignature` | Wrong secret rejected |
| `TestVerifyJWT_WrongAlgorithm` | `alg=none` rejected |
| `TestVerifyJWT_MissingUsername` | Missing username rejected |
| `TestVerifyJWT_MissingRole` | Missing role rejected |
| `TestVerifyJWT_MissingExp` | Missing exp rejected |
| `TestVerifyJWT_InvalidFormat` | Malformed token rejected |
| `TestVerifyJWT_LegacySVZero` | Legacy tokens with `sv=0` accepted |
| `TestNodeJoseInterop_ValidToken` | Node jose → Go verification (real fixture) |
| `TestNodeJoseInterop_ExpiredToken` | Node jose expired → Go rejects |
| `TestNodeJoseInterop_AlgNone` | Node jose alg=none → Go rejects |

### Node.js Tests

- `npm run lint` — 0 errors (3 warnings in validator script)
- `npm run typecheck` — clean
- `npm test` — 237/237 pass

---

## 8. Business Ownership

| Capability | Owner |
|-----------|-------|
| Subscriber writes | Node |
| Profile writes | Node |
| OCS writes | Node |
| Tariff writes | Node |
| Rating writes | Node |
| Approval writes | Node |
| Auth Login | Node |
| Audit reads | **Go** |
| Audit export | Node (DEFERRED — requires audit evidence persistence) |
| Analytics reads | **Go** |
| Rating reads | **Go** |
| Profile reads | **Go** |
| OCS reads | **Go** |
| Tariff reads | **Go** |
| Subscriber reads | **Go** |
| Search reads | **Go** |
| Batch precheck (semantic read) | **Go** |

### 8.1 Mongo Write Invariant

**Phase 2 strict rule:** Go MUST NOT write to business-domain collections.

| Collection | Go Write | Reason |
|-----------|----------|--------|
| `xcloud_ops.app_rate_limits` | ✅ ALLOWED | Infrastructure — rate limiting |
| `xcloud.subscribers` | ❌ FORBIDDEN | Business domain |
| `xcloud.ocs_*` | ❌ FORBIDDEN | Business domain |
| `xcloud_ops.app_profiles` | ❌ FORBIDDEN | Business domain |
| `xcloud_ops.app_users` | ❌ FORBIDDEN | Business domain (read-only in Phase 2 auth) |
| `xcloud_ops.app_approvals` | ❌ FORBIDDEN | Business domain |
| `xcloud_ops.app_audit_logs` | ❌ FORBIDDEN | Business domain (audit evidence) |

Phase 2 auth middleware: **read-only** on `app_users` (no `last_login` update, no session state mutation).

### 8.2 Semantic Classification of Phase 2A+2B GET Endpoints

Not all GET endpoints are pure reads. Classification:

| Endpoint | HTTP Semantic | Business Write | Infrastructure Write | Notes |
|----------|--------------|----------------|---------------------|-------|
| `GET /api/audit` | READ | NO | YES (`app_rate_limits`) | Pure read + rate limit |
| `GET /api/audit/:id` | READ | NO | YES (`app_rate_limits`) | Pure read + rate limit |
| `GET /api/audit/export` | STATEFUL_READ | YES (`app_audit_logs`) | YES (`app_rate_limits`) | **DEFERRED** — writes audit evidence |
| `GET /api/analytics/metrics` | READ | NO | YES (`app_rate_limits`) | Pure read + rate limit |
| `GET /api/analytics/sparkline` | READ | NO | YES (`app_rate_limits`) | Pure read + rate limit |
| `GET /api/ratings` | READ | NO | YES (`app_rate_limits`) | Pure read + rate limit |
| `GET /api/ratings/:id` | READ | NO | YES (`app_rate_limits`) | Pure read + rate limit |
| `GET /api/profiles` | READ | NO | YES (`app_rate_limits`) | Pure read + rate limit |
| `GET /api/profiles/:name` | READ | NO | YES (`app_rate_limits`) | Pure read + rate limit |
| `GET /api/profiles/:name/stats` | READ | NO | YES (`app_rate_limits`) | Cross-DB read + rate limit |
| `GET /api/profiles/:name/versions` | READ | NO | YES (`app_rate_limits`) | Pure read + rate limit |
| `GET /api/ocs/balances` | READ | NO | YES (`app_rate_limits`) | Pure read + rate limit |
| `GET /api/ocs/sessions` | READ | NO | YES (`app_rate_limits`) | Pure read + rate limit |
| `GET /api/ocs/reservations` | READ | NO | YES (`app_rate_limits`) | Pure read + rate limit |
| `GET /api/ocs/usage` | READ | NO | YES (`app_rate_limits`) | Pure read + rate limit |
| `GET /api/tariff-plans` | READ | NO | YES (`app_rate_limits`) | Pure read + rate limit |
| `GET /api/tariff-plans/:planId` | READ | NO | YES (`app_rate_limits`) | Pure read + rate limit |
| `GET /api/tariff-plans/:planId/export` | READ | NO | YES (`app_rate_limits`) | Pure serialization |
| `GET /api/tariff-plans/:planId/operations` | READ | NO | YES (`app_rate_limits`) | Read + computed summary |
| `GET /api/tariff-plans/:planId/rules` | READ | NO | YES (`app_rate_limits`) | Read + conflict detection |
| `GET /api/tariff-plans/:planId/subscribers` | READ | NO | YES (`app_rate_limits`) | Pure read + rate limit |
| `GET /api/tariff-plans/:planId/migrate` | READ | NO | YES (`app_rate_limits`) | Dry-run computation only |
| `GET /api/subscribers` | READ | NO | YES (`app_rate_limits`) | Pure read + rate limit |
| `GET /api/subscribers/:imsi` | READ | NO | YES (`app_rate_limits`) | Pure read + rate limit |
| `GET /api/search` | READ | NO | YES (`app_rate_limits`) | Pure read + rate limit |
| `POST /api/subscribers/batch/precheck` | SEMANTIC_READ | NO | YES (`app_rate_limits`) | POST body but no writes |

**Key insight:** `app_rate_limits` writes are infrastructure (rate limiting), not business mutations. Only `GET /api/audit/export` has genuine business write side effects. All Phase 2A+2B+2C endpoints are pure reads or semantic reads.

---

## 9. Security

| Check | Status |
|-------|--------|
| Trusted x-user headers | **NO** — identity from JWT + MongoDB only |
| Direct Go JWT validation | **YES** — HS256, all claims verified |
| Account DB validation | **YES** — locked/disabled/sessionVersion checked |
| Rate limiting | **YES** — MongoDB-backed, same collection as Node |

---

## 10. Files Added

| File | Purpose |
|------|---------|
| `backend/internal/auth/claims.go` | JWT claims and Principal structs |
| `backend/internal/auth/context.go` | Context helpers for Principal |
| `backend/internal/auth/middleware.go` | Auth middleware (cookie → JWT → MongoDB) |
| `backend/internal/auth/session.go` | Session validation against app_users |
| `backend/internal/auth/verifier.go` | HS256 JWT verification |
| `backend/internal/auth/verifier_test.go` | JWT interoperability tests |
| `backend/internal/auth/verifier_cross_lang_test.go` | Node jose → Go cross-language verification |
| `backend/testdata/auth/node-jose-token.json` | JWT fixture generated by Node jose |
| `scripts/migration/generate-auth-fixture.mjs` | Node jose fixture generator |
| `backend/internal/analytics/handler.go` | Analytics API handlers |
| `backend/internal/analytics/model.go` | Analytics response DTOs |
| `backend/internal/analytics/repository.go` | Analytics MongoDB queries |
| `backend/internal/audit/handler.go` | Audit API handlers |
| `backend/internal/audit/model.go` | Audit response DTOs |
| `backend/internal/audit/repository.go` | Audit MongoDB queries |
| `backend/internal/rating/handler.go` | Rating API handlers |
| `backend/internal/rating/model.go` | Rating response DTOs |
| `backend/internal/rating/repository.go` | Rating MongoDB queries |
| `backend/internal/profile/handler.go` | Profile API handlers |
| `backend/internal/profile/model.go` | Profile response DTOs |
| `backend/internal/profile/repository.go` | Profile MongoDB queries (cross-DB join) |
| `backend/internal/ocs/handler.go` | OCS API handlers |
| `backend/internal/ocs/model.go` | OCS response DTOs with BSON Long handling |
| `backend/internal/ocs/repository.go` | OCS MongoDB queries with numeric conversion |
| `backend/internal/tariff/handler.go` | Tariff API handlers |
| `backend/internal/tariff/model.go` | Tariff response DTOs |
| `backend/internal/tariff/repository.go` | Tariff MongoDB queries, rule normalization |
| `backend/internal/ocs/numeric_test.go` | BSON Long / Decimal128 numeric conversion tests |
| `backend/internal/tariff/numeric_test.go` | Tariff numeric conversion + rule normalization tests |
| `backend/internal/ratelimit/ratelimit.go` | MongoDB-backed rate limiter |
| `backend/internal/subscriber/handler.go` | Subscriber API handlers (list, detail, search, batch precheck) |
| `backend/internal/subscriber/model.go` | Subscriber response DTOs |
| `backend/internal/subscriber/repository.go` | Subscriber MongoDB queries (cross-DB joins) |
| `backend/internal/subscriber/handler_test.go` | Subscriber unit tests |
| `backend/internal/auth/capability_test.go` | Capability check tests |
| `backend/cmd/server/main.go` | Updated with Phase 2A+2B+2C wiring |

---

## 11. Deferred Reads

| Endpoint | Phase | Reason |
|----------|-------|--------|
| `/api/notifications/stream` | Phase 7 | SSE streaming lifecycle |
| `/api/system/audit/scan` | Phase 7 | May write scan state |
| `/api/alerts/*` | Phase 7 | Unknown governance |

---

## 12. Phase 2 Remaining Work

| Phase | Endpoints | Status |
|-------|-----------|--------|
| 2A | audit, analytics, ratings (6 endpoints) | ✅ Complete (audit/export deferred) |
| 2B | profiles, OCS, tariff-plans (15 endpoints) | ✅ Complete |
| 2C | subscribers list/detail, search, batch precheck (4 endpoints) | ✅ Complete |
| 2D | auth/me, auth/permissions, users | Not started |

---

## 13. Phase 3 Blockers

1. Phase 2B-D must complete before Phase 3 (write migration)
2. Contract parity testing framework needed for remaining endpoints

---

## 14. Validation

| Check | Result |
|-------|--------|
| gofmt | ✅ |
| go test | ✅ |
| go test -race | ✅ |
| go vet | ✅ |
| go build | ✅ |
| npm lint | ✅ |
| npm typecheck | ✅ |
| npm test | ✅ (237/237) |
| business write guard | ✅ (0 business writes in profile/ocs/tariff) |
| inventory validator | ✅ |

---

## 15. Phase 2B.1 Verification Findings

### Contract Corrections Applied

| # | Finding | Severity | Fix |
|---|---------|----------|-----|
| 1 | Tariff export missing `Content-Disposition` header | VALUE_MISMATCH | Added `attachment; filename="tariff-plan-{id}.json"` |
| 2 | Tariff export missing `version`, `exported_at` fields | SHAPE_MISMATCH | Added `version: "1.0"`, `exported_at: ISO timestamp` |
| 3 | Tariff export rate limit 120/60s (Node: 30/60s) | VALUE_MISMATCH | Corrected to 30/60s |
| 4 | Tariff operations rate limit 120/60s (Node: 90/60s) | VALUE_MISMATCH | Corrected to 90/60s |
| 5 | Tariff migrate rate limit 120/60s (Node: 12/60s) | VALUE_MISMATCH | Corrected to 12/60s |
| 6 | Tariff detail returned `{...plan}` instead of `{plan: {...}}` | SHAPE_MISMATCH | Wrapped in `map[string]any{"plan": plan}` |
| 7 | Tariff operations summary had wrong shape | SHAPE_MISMATCH | Rewrote to match `buildTariffPlanOperationsSummary` |
| 8 | Decimal128 parsing broken for scientific notation | VALUE_MISMATCH | Fixed using `BigInt()` method |
| 9 | Validator hardcoded `migratedCount === 21` | DESIGN | Replaced with Go router ↔ matrix cross-check |

### Parity Status

| Endpoint | Status | Body | Headers | Notes |
|----------|--------|------|---------|-------|
| `GET /api/profiles` | PARITY_PASS | ✅ | ✅ | |
| `GET /api/profiles/:name` | PARITY_PASS | ✅ | ✅ | |
| `GET /api/profiles/:name/stats` | PARITY_PASS | ✅ | ✅ | Cross-DB read |
| `GET /api/profiles/:name/versions` | PARITY_PASS | ✅ | ✅ | |
| `GET /api/ocs/balances` | PARITY_PASS | ✅ | ✅ | |
| `GET /api/ocs/sessions` | PARITY_PASS | ✅ | ✅ | |
| `GET /api/ocs/usage` | PARITY_PASS | ✅ | ✅ | |
| `GET /api/ocs/reservations` | PARITY_PASS | ✅ | ✅ | |
| `GET /api/tariff-plans` | PARITY_PASS | ✅ | ✅ | |
| `GET /api/tariff-plans/:planId` | PARITY_PASS | ✅ | ✅ | |
| `GET /api/tariff-plans/:planId/export` | PARITY_PASS | ✅ | ✅ | Content-Disposition added |
| `GET /api/tariff-plans/:planId/operations` | PARITY_PASS | ✅ | ✅ | Summary shape corrected |
| `GET /api/tariff-plans/:planId/rules` | PARITY_PASS | ✅ | ✅ | |
| `GET /api/tariff-plans/:planId/subscribers` | PARITY_PASS | ✅ | ✅ | |
| `GET /api/tariff-plans/:planId/migrate` | PARITY_PASS | ✅ | ✅ | |
| `GET /api/subscribers` | PARITY_PASS | ✅ | ✅ | detail=false/true, msisdn lookup |
| `GET /api/subscribers/:imsi` | PARITY_PASS | ✅ | ✅ | Legacy state mapping |
| `GET /api/search` | PARITY_PASS | ✅ | ✅ | subscriber/profile split |
| `POST /api/subscribers/batch/precheck` | PARITY_PASS | ✅ | ✅ | Semantic read, requires write cap |

### Routing Status

| Status | Value |
|--------|-------|
| Implemented in Go | 25 |
| Parity passed | 25 |
| Actually routed to Go (Nginx) | NO — Nginx not yet modified |
| Still routed to Node | YES — all /api/* still go to Next.js |
| Rollback | Not required — production routing unchanged |

---

## 16. Phase 2 Status

**PARTIAL** — Phase 2A + 2B + 2C complete, 2D remaining.

Phase 2A+2B+2C provides:
- Auth compatibility layer (JWT + session validation)
- 25 semantic-read implementations (24 GET + 1 POST semantic read)
- MongoDB-backed rate limiting
- Node → Go JWT interoperability proven (real Node jose fixture)
- Profile reads with cross-DB subscriber stats
- OCS reads with BSON Long → int64 conversion
- Tariff reads with rule normalization and conflict detection
- Subscriber list with detail=false/true modes, MSISDN lookup
- Subscriber detail with legacy state mapping (sub4G, pcrf4G, auth4G, OCS)
- Global search with subscriber/profile split
- Batch precheck (semantic read with subscriber_write capability)
- Capability-based authorization matching Node ROLE_CAPABILITIES exactly

### 16.1 Authorization Side-effect Audit

| Category | Count | Routes |
|----------|-------|--------|
| requireAuth only | 22 | analytics/*, ratings GET, profiles/*, ocs/*, tariff-plans/* GET, subscribers GET/Detail, search |
| requireCapability | 3 | audit list/detail (audit_view), batch/precheck (subscriber_write) |
| requirePermission | 2 | audit list/detail (audit.read) |
| authorization.denied audit required | 3 | audit list, audit detail, batch/precheck |
| Go security audit writer | NO | Not implemented (Phase 2 restriction) |

**Node denial path:** `requireCapability` and `requirePermission` both call `recordPermissionDenied` → `scheduleAuditLog({module: 'security', action: 'authorization.denied', ...})`.

**Go current behavior:** Returns 403 with `PERMISSION_DENIED` code but does NOT write security audit log.

**Impact:** None — production routing is still Node. When cutover is planned, the security audit writer must be implemented first.

### 16.2 Status Accounting

| Route | IMPLEMENTED | RESPONSE_PARITY | CUTOVER_READY | ACTUALLY_ROUTED | BLOCKER |
|-------|-------------|-----------------|---------------|-----------------|---------|
| GET /api/audit | YES | PASS | NO | NO | SECURITY_AUDIT_PARITY |
| GET /api/audit/:id | YES | PASS | NO | NO | SECURITY_AUDIT_PARITY |
| GET /api/analytics/metrics | YES | PASS | YES | NO | — |
| GET /api/analytics/sparkline | YES | PASS | YES | NO | — |
| GET /api/ratings | YES | PASS | YES | NO | — |
| GET /api/ratings/:id | YES | PASS | YES | NO | — |
| GET /api/profiles | YES | PASS | YES | NO | — |
| GET /api/profiles/:name | YES | PASS | YES | NO | — |
| GET /api/profiles/:name/stats | YES | PASS | YES | NO | — |
| GET /api/profiles/:name/versions | YES | PASS | YES | NO | — |
| GET /api/ocs/balances | YES | PASS | YES | NO | — |
| GET /api/ocs/sessions | YES | PASS | YES | NO | — |
| GET /api/ocs/usage | YES | PASS | YES | NO | — |
| GET /api/ocs/reservations | YES | PASS | YES | NO | — |
| GET /api/tariff-plans | YES | PASS | YES | NO | — |
| GET /api/tariff-plans/:planId | YES | PASS | YES | NO | — |
| GET /api/tariff-plans/:planId/export | YES | PASS | YES | NO | — |
| GET /api/tariff-plans/:planId/operations | YES | PASS | YES | NO | — |
| GET /api/tariff-plans/:planId/rules | YES | PASS | YES | NO | — |
| GET /api/tariff-plans/:planId/subscribers | YES | PASS | YES | NO | — |
| GET /api/tariff-plans/:planId/migrate | YES | PASS | YES | NO | — |
| GET /api/subscribers | YES | PASS | YES | NO | — |
| GET /api/subscribers/:imsi | YES | PASS | YES | NO | — |
| GET /api/search | YES | PASS | YES | NO | — |
| POST /api/subscribers/batch/precheck | YES | PASS | NO | NO | SECURITY_AUDIT_PARITY |

**Summary:**
- IMPLEMENTED: 25
- RESPONSE_PARITY_PASS: 25
- CUTOVER_READY: 23
- CUTOVER_BLOCKED: 3 (audit list, audit detail, batch/precheck — missing authorization.denied audit)
- ACTUALLY_ROUTED: 0 (Nginx not modified)

### 16.3 Future Security Audit Contract

When the security audit writer is implemented (Phase 3+), it must match:

```
module = security
action = authorization.denied
resource.type = api
resource.id = request pathname
result = denied
metadata = { capability, decision } or { permission }
```

Plus: actor, role, request_id, correlation_id, source_ip, user_agent, timestamp, event_id.

### 16.4 Phase 2 Write Invariant

| Category | Status |
|----------|--------|
| Business-domain writes by Go | NONE |
| Infrastructure writes | app_rate_limits (allowed) |
| Security audit writes | NONE (not yet implemented) |
