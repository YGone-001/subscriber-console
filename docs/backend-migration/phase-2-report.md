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

## 3. Read Migration — Phase 2A

### Migrated Endpoints

| Endpoint | Method | Domain | Rate Limit | Status |
|----------|--------|--------|------------|--------|
| `/api/audit` | GET | Audit | 60/60s per user | ✅ Migrated |
| `/api/audit/:id` | GET | Audit | 60/60s per user | ✅ Migrated |
| `/api/audit/export` | GET | Audit | 10/60s per user | ❌ DEFERRED — see Section 3.1 |
| `/api/analytics/metrics` | GET | Analytics | 120/60s per user | ✅ Migrated |
| `/api/analytics/sparkline` | GET | Analytics | 120/60s per user | ✅ Migrated |
| `/api/ratings` | GET | Ratings | 90/60s per user | ✅ Migrated |
| `/api/ratings/:id` | GET | Ratings | 90/60s per user | ✅ Migrated |

### 3.1 Deferred: /api/audit/export

`GET /api/audit/export` was briefly registered as a Go 501 stub. This has been **removed** — it was not contract compatible.

**Why it cannot migrate in Phase 2:**
- Node implementation calls `writeAuditLog({ action: 'audit.export' })` on both success and failure paths
- This is a **stateful read with business write side effect** (`app_audit_logs` write)
- Go does not yet own the Audit Writer
- Returning 501 is not contract compatible — clients expect real CSV/JSON export

**Migration target:** Phase 3+ after Go Audit Writer exists.

**Current owner:** Next.js (`src/app/api/audit/export/route.ts`)

### Endpoints NOT Migrated (Phase 2B-D)

| Endpoint | Reason |
|----------|--------|
| `/api/profiles/*` | Phase 2B |
| `/api/ocs/*` | Phase 2B |
| `/api/tariff-plans/*` | Phase 2B |
| `/api/subscribers/*` | Phase 2C (complex joins) |
| `/api/search` | Phase 2C |
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
              Governance         (Phase 2A: audit, analytics, ratings)
              Approval                │
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
│   ├── handler.go          # GET /api/audit, /api/audit/:id, /api/audit/export
│   ├── model.go            # Response DTOs
│   └── repository.go       # MongoDB aggregation pipelines
├── rating/
│   ├── handler.go          # GET /api/ratings, /api/ratings/:id
│   ├── model.go            # Response DTOs
│   └── repository.go       # MongoDB queries
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

### 8.1 Mongo Write Invariant

**Phase 2 strict rule:** Go MUST NOT write to business-domain collections.

| Collection | Go Write | Reason |
|-----------|----------|--------|
| `xcloud_ops.app_rate_limits` | ✅ ALLOWED | Infrastructure — rate limiting |
| `open5gs.subscribers` | ❌ FORBIDDEN | Business domain |
| `open5gs.ocs_*` | ❌ FORBIDDEN | Business domain |
| `xcloud_ops.app_profiles` | ❌ FORBIDDEN | Business domain |
| `xcloud_ops.app_users` | ❌ FORBIDDEN | Business domain (read-only in Phase 2 auth) |
| `xcloud_ops.app_approvals` | ❌ FORBIDDEN | Business domain |
| `xcloud_ops.app_audit_logs` | ❌ FORBIDDEN | Business domain (audit evidence) |

Phase 2 auth middleware: **read-only** on `app_users` (no `last_login` update, no session state mutation).

### 8.2 Semantic Classification of Phase 2A GET Endpoints

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

**Key insight:** `app_rate_limits` writes are infrastructure (rate limiting), not business mutations. Only `GET /api/audit/export` has genuine business write side effects.

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
| `backend/internal/ratelimit/ratelimit.go` | MongoDB-backed rate limiter |
| `backend/cmd/server/main.go` | Updated with Phase 2 wiring |

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
| 2B | profiles, OCS, tariff-plans | Not started |
| 2C | subscribers, search, profile stats | Not started |
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
| inventory validator | ✅ |

---

## 15. Phase 2 Ready

**NO** — Phase 2A complete, but 2B-D remaining.

Phase 2A provides:
- Auth compatibility layer (JWT + session validation)
- 6 read-only endpoints migrated (audit/export deferred)
- MongoDB-backed rate limiting
- Node → Go JWT interoperability proven (real Node jose fixture)
