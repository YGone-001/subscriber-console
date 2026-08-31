# Phase 0 Report — Baseline Freeze & Inventory

> **Generated**: 2026-08-31
> **Branch**: `develop`
> **Commit**: `1f1cb3fb27c680cc280e898801ca219d445788bb`

---

## 1. Baseline Commit

| Field | Value |
|-------|-------|
| Branch | `develop` |
| Commit SHA | `1f1cb3fb27c680cc280e898801ca219d445788bb` |
| Commit message | `feat(governance): add core operation registry` |
| Date | 2026-08-31 |
| Working tree | Clean |

---

## 2. Current Architecture

```
Browser → Nginx → Next.js :3000
                   ├── React UI (App Router)
                   ├── proxy.ts (JWT verify → x-user/x-user-role headers)
                   ├── API Route Handlers (src/app/api/**)
                   │   ├── authz.ts (requireAuth/requireCapability/requirePermission)
                   │   ├── rateLimit.ts (MongoDB-backed)
                   │   └── → server/repositories/ → MongoDB
                   └── MongoDB (open5gs + xcloud_ops)
```

**No Go backend exists yet.** All API, auth, governance, and data access is in Next.js.

---

## 3. Actual API Count

| Metric | Count |
|--------|------:|
| Route files | **63** |
| Total operations | **89** |
| GET | 40 |
| POST | 32 |
| PUT | 7 |
| PATCH | 3 |
| DELETE | 7 |

**Stale documentation**: CLAUDE.md claims "54 API Route Handlers" — actual is **63**.

---

## 4. API Count by Domain

| Domain | Routes | Operations |
|--------|-------:|----------:|
| alerts | 3 | 3 |
| analytics | 3 | 3 |
| approvals | 8 | 10 |
| audit | 3 | 3 |
| auth | 6 | 10 |
| notifications | 1 | 1 |
| ocs | 4 | 4 |
| profiles | 5 | 8 |
| ratings | 2 | 5 |
| search | 1 | 1 |
| subscribers | 9 | 12 |
| system | 6 | 6 |
| tariff-plans | 10 | 17 |
| users | 2 | 6 |

---

## 5. GET Count

**40 GET operations** across all domains.

> The Phase 2 migration table has 43 read entries: 40 GET + 2 semantic reads using POST
> (`batch/precheck`, `system/audit/scan`) + 1 dry-run preview (`tariff-plans/:planId/migrate` GET).

---

## 6. Mutation Count

**49 non-GET HTTP operations** (POST + PUT + PATCH + DELETE).

- 46 are semantic writes (actual data mutations)
- 2 are semantic reads using POST (`batch/precheck`, `system/audit/scan`)
- 1 is a write via GET (`tariff-plans/:planId/migrate` dry-run, no data mutation)

> The legacy approval POST (`/api/approvals/:id`) is a compatibility wrapper that dispatches
> to the explicit approve/reject endpoints. It is counted as a mutation (Phase 3) because it
> triggers state transitions.

---

## 7. Governance Operation Count

| Registry | Operations |
|----------|----------:|
| Subscriber Governance Registry | 7 |
| OCS Governance Registry | 18 |
| Core Operation Registry | 0 (intentionally empty) |
| Approval Risk Catalog | 25 actions |
| **Total governance operations** | **25** |

---

## 8. Approval Governed Count

**16 mutation endpoints** create approval requests (CHGs).

---

## 9. Runtime Internal Count

**4 OCS runtime operations**: `OCS_RUNTIME_RESERVE`, `OCS_RUNTIME_CONSUME`, `OCS_RUNTIME_RELEASE`, `OCS_RUNTIME_USAGE` — no HTTP routes.

---

## 10. Disabled Count

**11 OCS operations disabled**: All tariff/rating/plan operations except `OCS_BALANCE_ADJUST` are marked `DISABLED` in the OCS governance registry. However, their HTTP routes still work by creating approvals directly.

---

## 11. Unknown / Need Verification Count

**3 operations with UNKNOWN governance**:
- `POST /api/alerts/acknowledge` — no governance evidence
- `POST /api/alerts/workflow` — no governance evidence
- `POST /api/analytics/init` — no governance evidence

---

## 12. Database / Collection Count

| Database | Collections |
|----------|----------:|
| `open5gs` | 9 (subscribers, ocs_tariff_plans, ocs_subscribers, ocs_balances, ocs_sessions, ocs_reservations, ocs_usage_records, ocs_events, ocs_config) |
| `xcloud_ops` | 11 (app_profiles, app_profile_versions, app_ratings, app_users, app_approvals, app_sequences, app_audit_logs, app_alerts, app_rate_limits, app_metrics, ocs_balance_adjustments) |
| **Total** | **20** |

---

## 13. Critical BSON Risks

1. **Long type handling**: OCS collections use BSON `Long` extensively. Incorrect conversion corrupts data.
2. **Open5GS subscriber BSON**: Deeply nested (security, ambr, slice, session, qos). Go struct mapping must preserve all fields.
3. **No transactions**: Multi-collection writes are not atomic.
4. **Dual-database joins**: Subscriber list joins `open5gs` + `xcloud_ops` collections.

---

## 14. Auth Risks

1. **Session version revocation**: JWT includes `sv` (sessionVersion). Every request validates against MongoDB (`accountSession.ts`). Go must implement this.
2. **Account lock/disable**: `locked` and `status` fields checked on every request.
3. **Role consistency**: `normalizeGovernanceRole()` maps `root` → `super_admin`. JWT claims may have `root`, DB may have `super_admin`.
4. **bcryptjs**: 72-byte password limit. Go bcrypt is compatible but must match limits.
5. **JWT claims**: `{ username, role, sv }` — Go must produce identical claims.

---

## 15. Governance Risks

1. **OCS registry vs reality mismatch**: 11 operations marked `DISABLED` in registry but routes still create approvals. The registry is advisory; the actual governance is in the route + approval system.
2. **Profile CRUD has no governance**: Create, update, delete profiles bypass governance entirely. Only `PROFILE_RESTORE` uses approval.
3. **Core operation registry empty**: Intentional — no NF control operations. Future Phase 8.5 must not invent executors.

---

## 16. OCS Risks

1. **Version-based CAS**: Balance adjustments use `version` field for optimistic concurrency. Go must implement identical CAS logic.
2. **Ledger table**: `ocs_balance_adjustments` provides idempotency. Go must use same pattern.
3. **Invariant enforcement**: `total = used + reserved + available` must be enforced.
4. **Runtime operations**: Reserve/consume/release are internal-only. Go OCS runtime must not expose these as HTTP endpoints.

---

## 17. CNMS Reuse Summary

**Status**: VERIFIED — CNMS cloned from `https://github.com/YGone-001/CNMS.git`

Key findings from source code review:
- **Module**: `xcloud-cnms` (local module path)
- **MongoDB**: `go.mongodb.org/mongo-driver/v2` — correct version for sub-console
- **HTTP**: `net/http` standard library — correct approach for sub-console
- **JWT**: Manual HS256, Bearer token, Claims=`{username,role,exp}` — **different** from sub-console (cookie-based, Claims=`{username,role,sv}`)
- **No graceful shutdown**: Uses bare `http.ListenAndServe`
- **No request ID or structured logging**: Must be implemented from scratch
- **Rate limiter**: Token bucket, per-IP, in-memory — reference pattern

See `cnms-reuse-matrix.md` for detailed comparison.

---

## 18. Phase 1 Readiness

**Infrastructure ready**:
- [x] API inventory complete (63 files, 89 operations)
- [x] Governance system fully mapped
- [x] Approval chain fully traced
- [x] MongoDB collection map complete
- [x] API contract baseline frozen
- [x] Migration routing matrix established
- [x] Write operation classification complete

**Blockers for Phase 1**: See below.

---

## 19. Blockers

1. ~~**CNMS source not available**~~: RESOLVED — CNMS cloned and verified.
2. **No Go project structure**: Phase 1 must create `backend/` directory with Go module, config, Mongo client, HTTP server.
3. **CI missing develop trigger**: `.github/workflows/ci.yml` triggers on `main`, `feat/**`, `fix/**`, `chore/**` — NOT `develop`. This means PRs to develop don't get CI.

---

## 20. Recommended Next Step

1. **Clone CNMS** and complete reuse matrix verification
2. **Fix CI trigger** to include `develop` branch (small, safe fix)
3. **Begin Phase 1**: Go backend foundation — config, Mongo client, health endpoint, HTTP handler structure, middleware, rate limit, graceful shutdown
4. **Phase 1 target**: `GET /api/system/health` served by Go behind Nginx

---

## Stale Documentation Findings

| Document | Old Statement | Current Reality | Evidence | Impact |
|----------|--------------|-----------------|----------|--------|
| CLAUDE.md | "54 API Route Handlers" | 63 route files, 89 operations | `scripts/migration/inventory-api.mjs` scan | Migration scope underestimated |
| CLAUDE.md | "14 repositories" | 14 repositories (confirmed) | `src/server/repositories/` listing | Accurate |
| CLAUDE.md | "尚未 standalone" | **Already configured** — `next.config.ts` has `output: 'standalone'` | `next.config.ts:13` | Phase 1 can skip standalone setup |
| CLAUDE.md | "CNMS JWT 可直接复制" | UNVERIFIED — likely incompatible | subscriber-console has `sv`, `locked`, `status` | Must verify before Phase 6 |
