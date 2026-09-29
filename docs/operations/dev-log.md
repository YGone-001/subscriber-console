# DEV_LOG

> 历史增量记录：阶段完成、commit、重要 bug / 修复、关键结论。
> 当前状态看 `AGENTS.md`；待办看 `TODO.md`；规则看 `CLAUDE.md`。

---

## Phase 0 — Baseline Freeze & Inventory

- Commit: `1f1cb3fb` (2026-08-31)
- 63 route files, 89 operations scanned
- API baseline, contract freeze, write inventory, governance inventory, MongoDB collection map, CNMS reuse matrix
- Migration routing matrix created

## Phase 1 — Go Backend Foundation

- Config, Mongo client, health endpoints (`/healthz`, `/readyz`)
- HTTP handler, middleware, rate limiter, JSON response, graceful shutdown
- Request ID, recovery, structured logging (`slog`), security middleware

## Phase 2A — Analytics + Audit + Ratings Read

- 6 endpoints migrated: audit list/detail, analytics metrics/sparkline, ratings list/detail
- First read parity proofs

## Phase 2B — Profiles + OCS + Tariff Read

- 16 endpoints migrated (4 profiles, 5 OCS, 7 tariff)
- Decimal128 scientific-notation bug fixed
- Numeric conversion validated (int32/int64/float64/Decimal128)

## Phase 2C — Subscriber + Search Read

- 4 endpoints migrated: subscriber list/detail, search, batch precheck
- Cross-DB joins (xcloud + xcloud_ops) proven
- MSISDN lookup contract preserved

## Phase 2D — Auth + User Read

- 6 endpoints migrated: auth/me, auth/permissions, auth/users, auth/users/:username, users, users/:username
- CapabilitiesFor supports legacy `root` role
- Strict query parser (rejects unknown keys, duplicates)

## Phase 3A — Security Audit Evidence Writer

- Authorization denial audit writer implemented (BestEffort + Strict modes)
- Security audit blocker resolved

## Phase 3B — Audit Writer Lifecycle

- Strict lifecycle foundation (WaitGroup, RWMutex, for-range queue)
- Close timeout guarantees workers exit

## Phase 3C — Approval Governance Read Foundation

- 3 endpoints: approval list/detail/audit
- CAS transitions, pure state machine (CanTransition)

## Phase 3D — Explicit Approval Decision Endpoints

- 5 endpoints: create, approve, reject, cancel, legacy compat
- ACCESS_REQUEST creation (viewer→operator)
- ISO 8601 millisecond boundaries

## Phase 4.1 — Subscriber Single-Write Contract Gate

- Governance policy: super_admin/root→DIRECT, operator/ops_admin→APPROVAL
- Actor-aware governance (evaluateSubscriberOperationForActor)
- Fresh actor validation (validateCurrentAccount)

## Phase 4.2-A — Subscriber Batch Create Governance

- Frozen v2 contract, create-only atomicity
- Profile drift protection, 5GiB default

## Phase 4.3 — Subscriber Single CRUD Cutover

- Commit: `fb38ca9`
- POST/PUT/DELETE /api/subscribers cut over to Go
- CUTOVER_TABLE: 8 routes

## Phase 4.4 — Subscriber Profile Apply Cutover

- Commit: `65b4c78`
- POST /api/subscribers/:imsi/profile cut over to Go
- CUTOVER_TABLE: 9 routes

## Phase 4.5 — Profile CRUD Cutover

- Commit: `c2e0292`
- POST/PUT/DELETE /api/profiles cut over to Go
- CUTOVER_TABLE: 12 routes

## Phase 4.6 — Subscriber Single CRUD Confirmed

- All subscriber single CRUD routes verified as Go-owned

## Phase 4.7 — Subscriber Batch Cutover

- 4.7 Batch Create: Commit `fb38ca9`
- 4.7-B Batch Update: Commit `65b4c78`
- 4.7-C Import: Commit `c2e0292`
- 4.7-D Bulk Delete: Commit `8b2fa7a`
- CUTOVER_TABLE: 12 routes, all ACTUALLY_ROUTED=1

## Phase 5.0 — OCS Management Domain Architecture Freeze

- Commit: `0d5e668`
- Management plane boundary: ocs_tariff_plans, ocs_subscribers, ocs_balances
- Charging plane frozen: sessions, reservations, usage, events, config
- 3 docs: architecture freeze, API inventory (27 endpoints), UI design

## Phase 5.1 — OCS Read API Migration & Management UI

- Commit: `1c0a368`
- Go: `GET /api/ocs/subscribers` (shadow read, not production-routed)
- UI: OCS Dashboard (`/ocs/dashboard`), OCS Subscribers (`/ocs/subscribers`)
- 4 KPI cards, balance pool, tariff plans list, paginated subscriber table
- 23 new i18n keys (en + zh)
- Migration validator: 0 errors,52 Go operations,35 semantic reads

## Phase 6.3-B — Controlled Authentication Cutover

- Commit: `f4ec52e`
- Production ownership of authentication endpoints migrated from Node to Go backend (`:18888`):
  - `POST /api/auth/login`
  - `POST /api/auth/logout`
  - `GET /api/auth/me`
  - `GET /api/auth/permissions`
- `CUTOVER_TABLE`: 32 → 36 routes
- `ACTUALLY_ROUTED`: 32 → 36 routes
- Next.js reverse proxy (`proxy.ts`) routes requests to Go with fail-closed semantics (HTTP 502 `GO_BACKEND_UNREACHABLE`; zero Node fallback)
- All 41 checks pass in `scripts/test-auth-cutover.mjs`
- CI remote pipeline: 7/7 jobs green on commit `f4ec52ebe4eb6d33f0e64c08aaa222022a3008df`

## Phase 6.4 — Authentication & User Management UI Final Integration

- Completed user-facing frontend integration and UX hardening for Authentication and User Management.
- Created `frontend/src/lib/auth-ui.ts` with `parseRetryAfter`, `mapLoginResponse`, and `mapUserManagementError`.
- Updated `LoginForm.tsx` with dynamic rate-limit cooldown countdown, accessible ARIA announcements, and session-expired vs credential alert presentation (`role="status"` vs `role="alert"`).
- Refactored user detail page `[username]/page.tsx` with dynamic `currentUser` actor awareness and self-protection; eliminated hard-coded `isSelf = false`.
- Wired user status lifecycle operations (`active`, `disabled`, `locked`) to canonical Go endpoints (`POST /api/users/{username}/disable`, `PATCH /api/users/{username}` with `status: "locked" | "active"`) with confirmation modal.
- Rendered security state metadata panel with safe attributes (`sessionVersion`, `failedLoginAttempts`, `lastLoginAt`, `lastLoginIp`, `passwordChangedAt`, and conditional `lockedAt`/`lockReason`).
- Added complete English (`en.ts`) and Chinese (`zh.ts`) localization parity for auth & user management error codes and UI concepts.
- Retained strict backend & routing invariants: `CUTOVER_TABLE = 36`, `ACTUALLY_ROUTED = 36`, 0 backend modifications, 54 route files / 78 operations unchanged.
- Validated via 75/75 checks in `scripts/test-auth-user-ui-integration.mjs`.

## Phase 7.0 — Alerts, Notifications & Platform Services Architecture Freeze

- Reconciled stale documentation drift across `AGENTS.md`, `docs/operations/todo.md`, and `docs/backend-migration/migration-routing-matrix.md`.
- Completed full inventory and freeze for 11 Phase 7 candidate platform endpoints:
  - Alerts: `GET /api/alerts`, `POST /api/alerts/acknowledge`, `POST /api/alerts/workflow`
  - Notification streaming: `GET /api/notifications/stream`
  - System health: `GET /api/system/health`, `GET /api/system/mongo/health`
  - System integrity audit: `GET /api/system/audit/status`, `POST /api/system/audit/scan`, `POST /api/system/audit/heal`, `POST /api/system/audit/batch-heal`
  - Analytics platform action: `POST /api/analytics/init`
- Proved read-only semantics for `POST /api/system/audit/scan` (zero mutation calls) and `POST /api/analytics/init`.
- Audited all background processes and timers across `frontend/src` and `backend/` (confirmed zero background daemon cron jobs; SSE connection-scoped polling).
- Created authoritative architecture freeze specification: `docs/architecture/phase-7-platform-services-architecture.md` (20 sections complete).
- Implemented parameterized freeze test suite: `scripts/test-phase-7-architecture-freeze.mjs`.
- Integrated `test-phase-7-architecture-freeze.mjs` into `.github/workflows/ci.yml`.
- Maintained strict operational invariants: `CUTOVER_TABLE = 36`, `ACTUALLY_ROUTED = 36`, 54 route files / 78 operations, 0 runtime code changes, 0 backend migrations.

## Phase 7.1 — Platform Health & Diagnostic Read Parity (Go Shadow Implementation)

- Implemented dormant Go HTTP parity for all six Phase 7.1 read / semantic-read platform service endpoints:
  - `GET /api/alerts`: List alerts with pagination, status filtering, and parallel active counts (`backend/internal/alert`). Rate limit `alerts:list:<user>` (120 req / 60s).
  - `GET /api/system/mongo/health`: Diagnostic Mongo health checking 30 expected indexes across 11 collections (`backend/internal/system`). Returns HTTP 200 with degraded null schema on failure. Rate limit `system:mongo-health:<user>` (30 req / 60s).
  - `GET /api/system/health`: Comprehensive system health report aggregating 4 subsystems (Database, OCS Engine, HSS Core, Security) with weighted scoring (0-100) and actionable recommendations (`backend/internal/system`). Rate limit `system:health:<user>` (30 req / 60s).
  - `GET /api/system/audit/status`: Audit scheduler status check returning integer Unix seconds timestamp and scheduler state (`backend/internal/system`). Rate limit `system:audit-status:<user>` (60 req / 60s).
  - `POST /api/system/audit/scan`: Multi-phase read-only document scan (`reservation`, `tariff`, `ocs`, `sub`) with cursor pagination and zero database writes (`backend/internal/system`). Denies viewer role (HTTP 403 `PERMISSION_DENIED`), returns HTTP 500 on malformed JSON. Rate limit `system:audit-scan:<user>` (30 req / 60s).
  - `POST /api/analytics/init`: Semantic-read platform action computing metrics across all collections with zero database writes (`backend/internal/analytics`). Denies viewer role (HTTP 403 `PERMISSION_DENIED`). Rate limit `analytics:init:<user>` (3 req / 300s).
- Registered all 6 endpoints in Go HTTP router under `authMiddleware` in `backend/cmd/server/main.go`. Total Go HTTP operations expanded to 64 (36 semantic reads/platform actions + 28 mutations/auth/health).
- Created parameterized Node-vs-Go parity integration test suite: `scripts/test-phase-7-read-parity.mjs` (33/33 PASS across 10 modules: unauthorized gates, contract parity, RBAC gates, rate limits, schema alignment, zero mutations, session invalidation, and cutover invariants).
- Updated architecture freeze test suite `scripts/test-phase-7-architecture-freeze.mjs` to enforce presence of the 6 Phase 7.1 routes and strict absence of later-phase routes in Go router.
- Added dedicated CI workflow job `platform-read-parity` in `.github/workflows/ci.yml`.
- Maintained strict operational invariants: `CUTOVER_TABLE = 36`, `ACTUALLY_ROUTED = 36`, 0 Next.js routes modified (54 route files, 78 operations), 0 production cutovers, 100% pure ASCII.

## Phase 7.2 — Alert Domain Governance & Mutation Shadow Parity (Go Shadow Implementation)

- Implemented Go shadow mutation endpoints for the Alert domain:
  - `POST /api/alerts/acknowledge`: Single and batch acknowledge up to 200 IDs with string filtering, whitespace trimming, and deduplication (`backend/internal/alert`). Rate limit `alerts:acknowledge:<user>` (60 req / 60s). Direct execution against `xcloud_ops.app_alerts`.
  - `POST /api/alerts/workflow`: Alert workflow status update (`acknowledged`, `assigned`, `recovering`, `resolved`), field cleaning (max 80 chars), and automatic acknowledgment on `resolved` status (`backend/internal/alert`). Rate limit `alerts:workflow:<user>` (120 req / 60s).
- Closed governance gap (Outcome B) across both Node and Go:
  - Added non-gating best-effort operation logging to `app_audit_logs` (`action: "alert.acknowledge"`, `action: "alert.workflow"`).
  - Validated that audit persistence failure (via MongoDB schema validation errors) does not roll back committed alert mutations.
- Updated Go HTTP router in `backend/cmd/server/main.go` and `backend/cmd/testserver/main.go` with `POST /api/alerts/acknowledge` and `POST /api/alerts/workflow`. Total Go HTTP operations expanded to 66 (36 semantic reads/platform actions + 2 alert mutations + 28 mutations/auth/health).
- Created dedicated integration test suite: `scripts/test-phase-7-alert-mutation-parity.mjs` (42/42 PASS across 8 sections: authentication & RBAC, rate limits, acknowledge mutations, workflow mutations, best-effort audit logs, database failure paths, zero unrelated collection mutations, and routing freeze invariants).
- Updated architecture freeze validator `scripts/test-phase-7-architecture-freeze.mjs` to include Phase 7.2 endpoints in implemented routes while strictly forbidding later-phase routes.
- Maintained strict operational invariants: `CUTOVER_TABLE = 36`, `ACTUALLY_ROUTED = 36`, zero Phase 7 production cutover (Node remains authoritative production owner), 100% pure ASCII.

## Phase 7.3 — Notification Streaming SSE Shadow Parity

- Added `backend/internal/notification`, a polling SSE handler for `GET /api/notifications/stream` that uses the frozen Node contract: initial `listAlerts(15)` with five emitted recent alerts, 4-second periodic `listAlerts(10)`, active-count-only updates, and a 12-second `:ping` heartbeat.
- The handler uses the existing authenticated `auth.Principal` and `auth.SessionValidator` for post-connection account/session checks. A failed check emits `session_expired` with `{}` and closes the stream.
- Added request-scoped write-deadline clearing through `http.ResponseController`; normal server read/write/idle timeout configuration remains unchanged. The access-log response wrapper now transparently supports `http.Flusher` and response-controller unwrapping.
- Registered the Go endpoint only as a shadow candidate in the production and dedicated test server. Next.js remains the production owner and `CUTOVER_TABLE = 36`, `ACTUALLY_ROUTED = 36` remain unchanged.
- Added `scripts/test-phase-7-notification-stream-parity.mjs`, which uses real TCP Node and Go streams with incremental SSE parsing and checks headers, authentication, init, alerts updates, session expiry, heartbeat, short WriteTimeout survival, and read-only collection behavior.
- Added the separate `Notification streaming SSE parity` step to the platform parity CI job. Existing Phase 7.1 and 7.2 suites remain separate.
- Remote CI Run #140 completed successfully on exact commit SHA `7787edf87d95a80ced8c29fff46b45cae782e007`, freezing Phase 7.3.

## Phase 7.4 — System Integrity Controlled Remediation Shadow Parity

- Implemented the initial Phase 7.4 shadow foundation (acceptance remains PARTIAL; see correction below): System Integrity Controlled Remediation Shadow Parity for `POST /api/system/audit/heal` and `POST /api/system/audit/batch-heal`.
- Implemented `backend/internal/remediation` package providing Go shadow parity for operator-initiated controlled remediation (L2; strictly NO autonomous loops, background intervals, or cron self-healing).
- Implemented exact 1:1 parity for authentication, RBAC capability checks (`system_heal`), user-scoped fixed-window rate limiting (20/60s for heal, 10/60s for batch-heal; emitting headers only on 429), validation, profile inheritance, targeted subscriber/OCS provisioning, reservation release, idempotency, best-effort audit logging (`app_audit_logs`), and runtime error isolation.
- Maintained strict operational invariants: `CUTOVER_TABLE = 36`, `ACTUALLY_ROUTED = 36`, zero Phase 7 production cutover (Node remains authoritative production owner), 100% pure ASCII.
- Added comprehensive cross-engine parity test suite in `scripts/test-phase-7-system-heal-parity.mjs` (65/65 PASS).
- Added `System integrity controlled remediation parity` step to `platform-read-parity` CI job in `.github/workflows/ci.yml`.
- All regression suites verified green: Phase 7.1 (55/55), Phase 7.2 (93/93), Phase 7.3 (63/63), Phase 7.4 (65/65), Go unit tests, Node test suite (445/445), Next.js production build, and migration inventory validation.

## Controlled remediation acceptance corrections

- Replaced umbrella test accounting with 96 mandatory IDs, five independently counted real re-scan cases, and five invariant cases (106 total). Registration and execution inventories reject missing and duplicate IDs.
- Removed fixture-side HSS repairs after heal; MongoDB command monitoring asserts zero fixture writes between heal and re-scan. Missing HSS fields and released reservations without sessions remain anomalous on both engines.
- Added complete persisted-document parity, individual malformed-item response/state evidence, real MongoDB rejection evidence for repository/audit/limiter failures, and independent rate budgets.
- The expanded HTTP matrix reproduced a Go default PCC persistence defect: GBR/MBR lacked directional fields and default pre-emption flags differed from Node. Corrected only those Go fields and added a focused regression test; Node production behavior is unchanged.
- Status: Phase 7.3 COMPLETE / FROZEN; Phase 7.4 PARTIAL / IN PROGRESS, not frozen pending independent review; Phase 7.5 and Phase 8 NOT STARTED. Route ownership remains Node, CUTOVER_TABLE=36 and ACTUALLY_ROUTED=36.

## Prerequisite recovery and continuous-state remediation acceptance

- Reverted the premature Phase 7.5 production cutover forward-only: `CUTOVER_TABLE` and `ACTUALLY_ROUTED` return to 36 with zero Phase 7 production cutover. Node Phase 7 route files and the Go shadow implementations remain in place; the revert commit is preserved in history.
- Reworked RS01-RS05 in `scripts/test-phase-7-system-heal-parity.mjs` from five isolated fixture -> scan -> heal -> re-scan units into one continuous persistent-state sequence: all five targets are established in exactly one initial fixture batch, and each step inherits and re-verifies every prior persisted remediation outcome.
- The Mongo command monitor now enforces the protected sequence with executable assertions: `rs_initial_fixture_batches=1`, `rs_interstep_fixture_writes=0`, `rs_cumulative_state_verified=true`, `rs_sequence_continuous=true`. Budget resets are deliberately skipped between RS steps so no harness write can invalidate the evidence.
- Added `mandatory_ids_executed` evidence alongside expected/missing/duplicate; all 96 mandatory callbacks execute (106/106 checks PASS, FAIL=0, SKIP=0).
- Status: Phase 7.4 CORRECTION IMPLEMENTED / NOT FROZEN pending independent acceptance; Phase 7.5 NOT STARTED / RECOVERY PENDING; Phase 8 NOT STARTED.
