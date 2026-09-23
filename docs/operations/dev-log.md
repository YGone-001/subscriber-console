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
