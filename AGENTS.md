# AGENTS.md — xCloud subscriber-console

> 当前项目快照，用于 Claude Code / MiMo / Codex 长会话续开发。
> **稳定规则看 `CLAUDE.md`；历史看 `docs/operations/dev-log.md`；待办看 `docs/operations/todo.md`。**
> 本文件可覆盖更新，不保存完整历史。

## 0. Minimal Bootstrap

新会话只做：

```text
1. Read CLAUDE.md
2. Read AGENTS.md
3. git status
4. git branch --show-current
5. git log --oneline -10
6. Read only task-relevant source
```

不要先扫描整个仓库。

### 0.1 核心防卫底线 (Core Defensive Constraints)

1. **【编码与字符规范】**：程序编码强制默认使用 UTF-8 格式，绝不允许使用 Base64 编码方式。所有编程语言源码必须严格遵守“纯 ASCII（纯英文+符号）”原则，剔除代码中的所有 Emoji 和无关中文，仅保留最纯粹的代码以及必要的中文注释说明。
2. **【接口向前兼容性】**：每次更新源码前，必须全面回顾涉及模块的上下文。绝对不能随意删除已有函数接口！如需调整，必须选择更新原接口或创建新接口。功能模块的升级必须紧密依赖现有的最新内容框架与源码结构进行，严禁“去头掐尾”导致旧功能断裂。
3. **【前端表达规范】**：在输出修改说明、更新日志或注释时，涉及前端开发的变动，严禁使用“说明出现在网页前端展示上”这类非专业表述，必须采用规范的工程化技术术语。

### 0.2 操作模式 (Operation Model - Phase 5.7-A)

Approval workflow removed from business execution path. Authorization and operation logging remain.
- Authorized users execute permitted operations directly (Direct Execution).
- Zero approval records created on business operations (`app_approvals` count == 0).
- Best-effort / non-business-gating operation logging to `app_audit_logs`, RBAC capability gates, fresh actor revalidation, and CAS concurrency control remain active.

### 0.3 角色权限模型 (RBAC Model - Phase 5.7-B)

Canonical Three-Role Model:
- `admin`: System and user administration, plus permitted business operations.
- `operator`: Permitted operational business operations (subscribers, balances, profiles, tariffs, rating); no user administration.
- `viewer`: Read-only inspection. All mutations and user administration denied.

Backward Compatibility:
- Runtime normalization: `root` / `super_admin` -> `admin`, `ops_admin` -> `operator`, `auditor` -> `viewer`.
- Write boundary: API strictly accepts only `['admin', 'operator', 'viewer']`; legacy roles rejected with HTTP 400 (`INVALID_ROLE`).
- UI role selection: Exactly 3 options (`admin`, `operator`, `viewer`).

---

## 1. Repository

Primary:

```text
https://github.com/YGone-001/subscriber-console.git
branch: develop
```

Reference only:

```text
https://github.com/YGone-001/CNMS.git
branch: develop
```

CNMS 不整仓合并。

Product = `xCloud`.

---

## 2. Current Architecture

```text
Browser
   |
   v
Nginx
   |----------------------|
   v                      v
Next.js :13333        Go :18888
UI                     Migrating API
Legacy writes          Auth validation
                       Read APIs
   |                      |
   +----------+-----------+
              |
              v
           MongoDB
      xcloud + xcloud_ops
```

Target:

```text
Browser -> Nginx
           ├─ /*      -> Next.js
           └─ /api/*  -> Go
```

Important:

```text
Production /api/* has NOT been globally cut over to Go.
Frontend API paths remain unchanged.
```

---

## 3. Stack

```text
Next.js 16.2.2
React 19.2.4
TypeScript 5.x
Node 20
MongoDB Node Driver 7.x
jose 6.2.2
```

Go:

```text
Go 1.24+
net/http
modern ServeMux
log/slog
mongo-driver/v2 v2.6.0
```

No Gin/Fiber/Echo/GORM.

---

## 4. Mongo

Same URI, two DBs:

```text
xcloud
xcloud_ops
```

Go:

```go
type Databases struct {
    Client  *mongo.Client
    xCloud *mongo.Database
    Ops     *mongo.Database
}
```

One client, two handles.

---

## 5. Migration Status

Latest verified logical status:

```text
Phase 0     COMPLETE
Phase 0.1   COMPLETE
Phase 1     COMPLETE
Phase 2A    COMPLETE
Phase 2A.1  COMPLETE
Phase 2B    COMPLETE
Phase 2B.1  COMPLETE
Phase 2C    COMPLETE
Phase 2C.1  COMPLETE
Phase 2D    COMPLETE
Phase 2D.1  COMPLETE

Phase 3     IN PROGRESS
Phase 3A    COMPLETE — security audit evidence writer + authorization denial integration
Phase 3B    COMPLETE — audit writer lifecycle closeout
Phase 3C    COMPLETE — approval governance read foundation
Phase 3D    COMPLETE — explicit approval decision endpoints + contract preflight
Phase 4.1   COMPLETE — subscriber single-write final contract gate
Phase 4.2-A COMPLETE — subscriber batch create governance
Phase 4.3   COMPLETE — subscriber single create/update/delete cutover
Phase 4.4   COMPLETE — subscriber profile apply cutover
Phase 4.5   COMPLETE — profile CRUD cutover
Phase 4.6   COMPLETE — subscriber single CRUD cutover (create/update/delete)
Phase 4.7   COMPLETE — subscriber batch create/update/import/bulk-delete cutover
Phase 5.0   COMPLETE — OCS management domain architecture freeze
Phase 5.1   COMPLETE — OCS read API migration + management UI
Phase 5.2   COMPLETE — OCS tariff plan governance (create/update/delete/clone/enable/disable)
Phase 5.3   COMPLETE — OCS subscriber contract governance (create/update-tariff/suspend/resume/terminate)
Phase 5.3-B-0 COMPLETE — repository structure refactor (frontend/backend separation)
Phase 5.4   COMPLETE — OCS balance governance implementation (CAS versioning, strict audit, disabled reset)
Phase 5.4-B COMPLETE — OCS balance controlled production cutover (ACTUALLY_ROUTED = 26)
Phase 5.5-A COMPLETE — OCS management final alignment & UI polish
Phase 5.6   COMPLETE — OCS production freeze & documentation closure
Phase 5.7-A COMPLETE — Direct Execution (approval workflow removed from business execution path)
Phase 5.7-B COMPLETE — Three-role RBAC canonicalization (admin/operator/viewer with legacy normalization)
Phase 5.7-C COMPLETE — CI migration validator dependency installation fix
Phase 6.0   COMPLETE — Authentication & User Management architecture freeze
Phase 6.1-B COMPLETE — User management CRUD lifecycle (Go backend)
Phase 6.1-C COMPLETE — User management UI (dedicated pages and API client)
Phase 6.1-D COMPLETE — User management integration hardening and controlled Go cutover (ACTUALLY_ROUTED = 32)
Phase 6.2   COMPLETE — Authentication security hardening (dual rate limits, auto lockout, response privacy, JWT secret validation)
Phase 6.3-A COMPLETE — Authentication Go contract parity foundation (1:1 behavioral/security/contract/persistence parity, shadow Go candidate, CUTOVER_TABLE=32, ACTUALLY_ROUTED=32)
Phase 6.3-B COMPLETE — Controlled Authentication Cutover (Production owner = Go backend, CUTOVER_TABLE = 36, ACTUALLY_ROUTED = 36)
Phase 6.4   COMPLETE — Authentication & User Management UI Final Integration (UX hardening, rate limit cooldown, privacy, status lifecycle, security state)
```

### 5.1 OCS 生产冻结基线 (OCS Production Freeze Baseline)

OCS Management Plane is frozen.
Managed domains:
- Tariff Plans
- Contract Subscribers
- Balance Management

Charging Plane remains frozen and excluded.

- 权威基线：Phase 5.6 生产冻结基准（历史基线 ACTUALLY_ROUTED = 26，当前生产路由 ACTUALLY_ROUTED = 36）。
- 路由表状态：`CUTOVER_TABLE = 36`，`ACTUALLY_ROUTED = 36`。
- 托管集合：`ocs_tariff_plans`、`ocs_subscribers`、`ocs_balances`。
- 冻结规约文档：`docs/backend-migration/phase-5-6-ocs-production-freeze.md`。
- 运维操作手册：`docs/operations/ocs-management-runbook.md`。
- 界面验收验证：通过无头浏览器 CDP 1440x900 渲染断言验证通过（本地测试截图即测即消，不入版本库）。

Exact HEAD is intentionally not stored here.

Always use Git for SHA/status.

---

## 6. Go Foundation

`backend/` includes:

- env config
- one Mongo client / two DB handles
- `/healthz`
- `/readyz`
- request ID
- recovery
- structured logging
- security middleware
- graceful shutdown
- HTTP timeouts
- Go CI
- security audit evidence writer (BestEffort + Strict modes)
- authorization denial guard (RequireCapabilityWithAudit, RequirePermissionWithAudit)
- payload sanitizer (secret redaction, depth/bounds)

`/healthz` does not require Mongo.
`/readyz` checks Mongo.

---

## 7. Auth & User Management (Phase 6.0 Frozen)

Architecture freeze: `docs/architecture/phase-6-auth-architecture.md`.
Authentication model: `docs/operations/authentication-model.md`.
User management model: `docs/operations/user-management-model.md`.

Three canonical roles: `admin`, `operator`, `viewer`.
Legacy normalization: `root`/`super_admin`->`admin`, `ops_admin`->`operator`, `auditor`->`viewer`.
New users: only `admin`/`operator`/`viewer` accepted (HTTP 400 `INVALID_ROLE` otherwise).
User collection: `xcloud_ops.app_users` (single source of truth).
Delete policy: soft delete only (`status=disabled`).
Session invalidation: `security.sessionVersion++` on password/role/status change.
JWT: HS256, 24h expiry, `auth_token` cookie (httpOnly, sameSite=lax).
No refresh token. No OAuth/SSO/LDAP/MFA. No policy engine.

Current chain:

```text
auth_token cookie
→ HS256 verify
→ username / role / sv / exp
→ xcloud_ops.app_users
→ enabled
→ unlocked
→ sessionVersion match
→ role consistency
→ Principal
```

Real Node `jose` → Go verifier interoperability is proven.

Never trust:

```text
x-user
x-user-role
x-user-id
x-user-session-version
```

as authority.

`app_users` = Authoritative User Management store (`xcloud_ops.app_users`).
Canonical User Management routes (production owner = Go):
- `GET /api/users`
- `POST /api/users`
- `GET /api/users/{username}`
- `PATCH /api/users/{username}`
- `POST /api/users/{username}/disable`
- `POST /api/users/{username}/password-reset`
Legacy compatibility read aliases: `/api/auth/users`, `/api/auth/users/{username}`.
Login/logout = Node owner.

Phase 6.2 Authentication Security Hardening:
- Dual rate limiting: IP-scoped request limiter (`login:<ip>`, 5/60s) + Account-scoped failed-login limiter (`login-user:<normalized-username>`, 10 failed attempts / 300s, peeked pre-auth, consumed only on failed authentication; successful logins do not consume budget).
- Automatic lockout: 10 consecutive failed password attempts transitions active unlocked user to `status="locked"`, `locked=true`, `sessionVersion+=1`, `lockedAt=now`, `lockReason="excessive_failed_logins"`. Attempt 11+ does not repeatedly increment `sessionVersion`.
- Response privacy: uniform HTTP 401 `{"error": "Invalid credentials"}` with `Cache-Control: no-store` on all credential/account-state failures (unknown username, wrong password, disabled account, locked account). Malformed JSON or request validation failures return HTTP 400.
- Password policy parity: minimum 8 Unicode code points after trimming surrounding whitespace, maximum 72 UTF-8 bytes, case-insensitive target username exclusion enforced identically in Node (`isPasswordStrong`) and canonical Go (`ValidatePassword`).
- Successful login: atomic reset of `failedLoginAttempts=0`, update `lastLoginAt` and `lastLoginIp` with concurrency state check; does not consume failed-login rate limit.
- Admin unlock: canonical Go API `PATCH /api/users/{username}` with `status="active"` resets lock state, unsets lock metadata, resets `failedLoginAttempts=0`, increments `sessionVersion`.
- Manual lock: `status="locked"` sets `locked=true`, `lockedAt`, `lockReason="manual_lock"`, increments `sessionVersion`.
- Last active admin protection: prevent auto-lockout or manual lock/disable on last active admin (`LAST_ACTIVE_ADMIN` 409).
- JWT secret startup validation: Node and Go fail closed on startup if `JWT_SECRET` is missing, <32 UTF-8 bytes, or matches common insecure placeholders.
- Cookie & header hardening: `SameSite=Lax`, `HttpOnly=true`, dynamic `Secure` over HTTPS, aligned logout cookie attributes, `Cache-Control: no-store` on sensitive auth responses.

Phase 6.3-A Authentication Go Contract Parity Foundation:
- Complete 1:1 behavioral, HTTP contract, security, and persistence parity achieved across Node and Go authentication implementations (`POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`, `GET /api/auth/permissions`).
- Validated via 63 comprehensive cross-engine tests in `scripts/test-auth-go-parity.mjs`.

Phase 6.3-B Controlled Authentication Cutover:
- Authoritative production ownership cutover of Authentication APIs (`POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`, `GET /api/auth/permissions`) to Go backend (`:18888`).
- `CUTOVER_TABLE = 36`, `ACTUALLY_ROUTED = 36`.
- Reverse proxy forwards all 4 routes to Go with `cutover_forward` telemetry.
- Fail closed: Go backend unreachable returns HTTP 502 `GO_BACKEND_UNREACHABLE` with zero Node fallback.
- Validated via comprehensive cross-engine tests in `scripts/test-auth-cutover.mjs` (41/41 PASS).

Phase 6.4 Authentication & User Management UI Final Integration:
- Structured response and code mapping helper (`auth-ui.ts`) with strict privacy preserving uniform HTTP 401 presentation.
- Resilient rate-limit cooldown with countdown seconds display, automatic button re-enablement, unmount cleanup, and ARIA live regions.
- Session-expired vs credential alert presentation (`role="status"` vs `role="alert"`).
- Dynamic current actor awareness and self-protection in user detail view; removal of hard-coded `isSelf = false`.
- Status lifecycle governance actions (`active`, `disabled`, `locked`) guarded by confirmation modal.
- Security state metadata panel (`sessionVersion`, `failedLoginAttempts`, `lastLoginAt`, `lastLoginIp`, `passwordChangedAt`, and conditional `lockedAt`/`lockReason`).
- Complete English and Chinese localization parity for all auth & user management error codes and UI concepts.
- Strict invariant preservation: `CUTOVER_TABLE = 36`, `ACTUALLY_ROUTED = 36`, 0 backend modifications, 54 route files / 78 operations unchanged.
- Validated via 75 acceptance tests in `scripts/test-auth-user-ui-integration.mjs`.

---

## 8. Rate Limit

Go limiter:

```text
MongoDB fixed window
xcloud_ops.app_rate_limits
```

Preserve exact Node key/limit/window/headers/messages.

Current write invariant:

```text
Business-domain writes by Go = subscriber/profile CRUD + batch (Direct Execution), ACTUALLY_ROUTED=36
Infrastructure writes = app_rate_limits (allowed)
Operation logging = app_audit_logs (best-effort / non-business-gating internal operation logs; authorization denial evidence)
OCS writes = ocs_tariff_plans CRUD + enable/disable (Direct Execution), ACTUALLY_ROUTED=36
OCS subscriber writes = ocs_subscribers create/update-tariff/suspend/resume/terminate (Direct Execution), ACTUALLY_ROUTED=36
OCS balance writes = ocs_balances adjust (Direct Execution), reset (permanently disabled), ACTUALLY_ROUTED=36
User Management writes = app_users CRUD + disable + password-reset (Direct Execution), ACTUALLY_ROUTED=36
```

---

## 9. Current Go Read Implementations

30 semantic-read implementations (29 GET + 1 POST semantic read).

Phase 2A — 4:

```text
GET /api/analytics/metrics
GET /api/analytics/sparkline
GET /api/ratings
GET /api/ratings/:id
```

Phase 2B — 16:

### Profiles

```text
GET /api/profiles
GET /api/profiles/:name
GET /api/profiles/:name/stats
GET /api/profiles/:name/versions
```

### OCS

```text
GET /api/ocs/balances
GET /api/ocs/sessions
GET /api/ocs/usage
GET /api/ocs/reservations
GET /api/ocs/subscribers          — Phase 5.1
```

### Tariff

```text
GET /api/tariff-plans
GET /api/tariff-plans/:planId
GET /api/tariff-plans/:planId/export
GET /api/tariff-plans/:planId/operations
GET /api/tariff-plans/:planId/rules
GET /api/tariff-plans/:planId/subscribers
GET /api/tariff-plans/:planId/migrate
```

Phase 2C — 4:

```text
GET /api/subscribers
GET /api/subscribers/:imsi
GET /api/search
POST /api/subscribers/batch/precheck
```

Phase 2D — 6:

```text
GET /api/auth/me
GET /api/auth/permissions
GET /api/auth/users
GET /api/auth/users/:username
GET /api/users
GET /api/users/:username
```

Status:

```text
Go HTTP operations = 58
  Semantic reads = 30
  Business mutations = 12 (subscriber+profile CRUD + batch)
  Tariff mutations = 6 (create/update/delete/clone/enable/disable)
  OCS subscriber mutations = 5 (create/update-tariff/suspend/resume/terminate)
  OCS balance mutations = 2 (adjust/reset)
  User Management mutations = 4 (create/update/disable/password-reset)
  Auth public = 2 (login/logout)
  Health = 2 (healthz/readyz)
Actually Routed = 36 (CUTOVER_TABLE routes)
OCS writes = 13 (tariff plan + subscriber contract + balance)
```

CUTOVER_TABLE = 36 routes (all ACTUALLY_ROUTED=1).

Read endpoints are shadow-implemented in Go; production reads still route through Next.js unless explicitly cut over.

---

## 9.1 Direct Operation Model (Phase 5.7-A / Phase 5.7-C)

All business mutations execute directly after authentication, fresh actor validation, RBAC capability checks, domain validation, and concurrency checks:
- Zero approval dependency: No approval tickets, maker-checker handoffs, or pending approvals created (`app_approvals` count == 0 for normal operations).
- Canonical three-role authorization:
  - `admin`: Full administration, user management, direct business mutations.
  - `operator`: Direct business mutations (subscribers, balances, profiles, tariffs, rating); no user administration.
  - `viewer`: Read-only; all mutations denied with HTTP 403.
- Non-gating operation logging: Mutations record operation evidence to `xcloud_ops.app_audit_logs`. Logging is best-effort and does not gate business response.
- Concurrency: Atomic CAS versioning protects balances, tariff plans, and subscribers against concurrent modification conflicts.
- Historical data: `xcloud_ops.app_approvals` is retained as historical data only; not accessed during normal business operations.

---

## 9.2 OCS Management Domain

Phase 5.0 defined the OCS boundary:

```text
Management plane (active migration):
  ocs_tariff_plans   — tariff plan definitions + rules
  ocs_subscribers    — subscriber contracts + plan assignments
  ocs_balances       — balance accounts + pools

Charging plane (frozen, not migrating):
  ocs_sessions       — active Gy/Ro sessions
  ocs_reservations   — reserved quota
  ocs_usage          — usage records
  ocs_events         — charging events
  ocs_config         — OCS engine config
```

Phase 5.1 added:
- `GET /api/ocs/subscribers` — Go read implementation (shadow, not production-routed)
- OCS Dashboard UI (`/ocs/dashboard`) — 4 KPI cards, balance pool, tariff plans
- OCS Subscribers UI (`/ocs/subscribers`) — paginated table, status filter, search

Phase 5.2 added:
- 6 tariff plan write operations (create/update/delete/clone/enable/disable) — Go governed
- Fresh actor revalidation before every mutation
- CUTOVER_TABLE = 18 (was 12): 6 tariff routes ACTUALLY_ROUTED to Go
- Tariff list UI (`/ocs/tariffs`) — KPI cards, table, enable/disable/clone/delete actions
- Rate limits: create=20/60, update=30/60, delete=20/60, clone=20/60, enable/disable=20/60
- Capability: `ocs.tariff.write`
- Error codes: TARIFF_PLAN_EXISTS, TARIFF_PLAN_NOT_FOUND, DEFAULT_TARIFF_PLAN_PROTECTED, TARIFF_PLAN_DISABLE_IN_USE, INVALID_PLAN_ID

Next: Phase 5.3+ OCS subscriber/balance governance per `docs/operations/todo.md`.

## 10. Removed Governance Surfaces (Phase 5.7-C)

The following governance endpoints and surfaces were retired in Phase 5.7-C:
- `/api/approvals/*` (all approval read, decision, and export routes)
- `/api/audit/*` (user-facing audit console list, detail, export routes; note `/api/system/audit/*` remains for diagnostics and healing)
- Approval and Audit UI console pages and navigation entries

---

## 11. Phase 2B Contract Findings — Do Not Regress

### Tariff export

Must preserve:

```text
Content-Type: application/json
Content-Disposition: attachment; filename="tariff-plan-{id}.json"
```

Response includes current Node-compatible:

```text
version
exported_at
plan_id
name
...
```

Rate limit:

```text
30 / 60s
```

### Tariff operations

Go = compatibility read view only + governed write (create/update/delete/clone/enable/disable).
Governance authority = Go (Phase 5.2+). Node = read owner for remaining read endpoints not yet cut over.

### Tariff migrate GET

```text
GET /api/tariff-plans/:planId/migrate
```

= dry-run only.

No tariff/subscriber/balance/audit business write.

### Numeric

OCS conversion already tested for:

```text
int32
int64
float64
Decimal128
```

including:

```text
0
2147483648
10737418240
9007199254740991
```

Decimal128 scientific-notation bug was fixed.

### Zero / Date / ObjectId

- explicit zero must not disappear through `omitempty`
- dates match Node ISO millisecond form
- do not expose `_id`, `$oid`, driver internals

---

## 12. Migration Validator

Validator is source-derived and METHOD+PATH aware.

Must maintain:

- Go router ↔ matrix cross-check (all HTTP methods)
- phantom detection
- missing route detection
- dynamic path canonicalization
- migrated count derived from artifacts/source
- GET reads vs POST semantic reads classification
- business mutations count (should be 0)

Never hard-code endpoint counts.

---

## 13. Phase 2C — Complete

All 4 endpoints migrated:

```text
GET /api/subscribers         — list/detail/MSISDN lookup
GET /api/subscribers/:imsi   — legacy state detail
GET /api/search              — subscriber/profile split
POST /api/subscribers/batch/precheck — semantic read, requires subscriber_write cap
```

Business writes: NONE.
Security audit writes: NONE (authorization.denied audit not implemented).
Production routing: still Node.

---

## 14. Subscriber List Contract

Node:

```text
frontend/src/app/api/subscribers/route.ts
```

Modes:

```text
detail=false → listSubscriberImsis()
detail=true  → listSubscriberRows()
msisdn set   → MSISDN lookup mode
```

Query aliases:

```text
detail
page
limit
q
status
sortField
sort
sortDirection
sortDir
order
msisdn
excludeImsi
```

Known statuses:

```text
all
active
restricted
lowTraffic
```

Do not redesign validation.

MSISDN lookup contract includes:

```json
{
  "exists": false,
  "imsi": null,
  "source": null
}
```

when not found.

---

## 15. Subscriber Detail

Node:

```text
frontend/src/app/api/subscribers/[imsi]/route.ts
```

Phase 2C only migrates:

```text
GET
```

Do not touch:

```text
PUT
DELETE
```

Detail uses:

```text
findSubscriberLegacyState(imsi)
```

Go must reproduce legacy API representation, not raw xCloud BSON.

---

## 16. Historical Phase 2C Note: Subscriber Writes
 
During historical Phase 2C, subscriber writes remained with Node:
 
```text
POST /api/subscribers
PUT /api/subscribers/:imsi
DELETE /api/subscribers/:imsi
batch create/update
bulk delete
import
policy mutation
```
 
In Phase 4.6 and 4.7, subscriber CRUD and batch were cut over to Go with direct execution (ACTUALLY_ROUTED = 36). Node retains no active subscriber write paths.

---

## 17. Search Contract

Node:

```text
frontend/src/app/api/search/route.ts
```

Behavior:

```text
q.trim()
query length < 2 → {"results":[]}
```

Limit:

```text
default 8
min 1
max 12
invalid 8
```

Subscriber search:
- digits-only query

Profile search:
- lowercase `name/title` includes

Split:

```text
subscriberLimit = ceil(limit / 2)
profileLimit = limit - subscriberLimit
```

Order:

```text
subscriber results first
profile results second
```

Shape:

```text
id
label
desc
type
path
```

Types:

```text
imsi
profile
```

Current paths:

```text
/subscribers
/profile
```

Do not improve/re-rank during migration.

---

## 18. Batch Precheck

Node:

```text
frontend/src/app/api/subscribers/batch/precheck/route.ts
```

HTTP = POST.
Potential semantic read.

Current security/contract:
- `subscriber_write` capability
- `subscribers:batch-precheck:{user}`
- 30/60s
- `startImsi`
- `count`
- `IMSI_RANGE_OVERFLOW`

Even if read-only, permission remains `subscriber_write`.

Must audit `precheckSubscriberRange()` before migration.

---

## 19. xCloud Subscriber Risk

Highest-risk collection:

```text
xcloud.subscribers
```

Potential structures:
- security
- AMBR
- slices
- sessions
- MSISDN
- policy
- unknown fields
- Binary
- int32/int64
- dates

Preferred read path:

```text
bson.M / bson.Raw
→ explicit mapper
→ legacy API DTO
```

Do not strict-decode entire document into one giant struct unless proven safe.

---

## 20. Compatibility Rules

Must preserve distinctions:

```text
missing
null
0
""
[]
```

Beware:

```text
Go nil slice → null
Node may return []
```

Binary/Buffer:
- do not accidentally emit Go base64 if Node uses hex/string.

Unknown xCloud fields:
- must not make read fail.

---

## 21. Cross-DB Reads

Phase 2C may compose:

```text
xcloud
xcloud_ops
```

No cross-DB writes.
No transaction required.

If reads span collections, treat result as eventually consistent unless current Node proves snapshot semantics.

---

## 22. Performance

Correctness first, but detect obvious N+1.

Do not replace batch lookups with N per-subscriber OCS/profile queries if avoidable.

If indexes appear missing:

```text
PERFORMANCE_FINDING
```

Do not create indexes during Phase 2C.

---

## 23. Phase 2C Minimum Tests

Subscriber list:
- empty/single/multiple
- detail false/true
- q
- status
- sort aliases
- asc/desc
- pagination
- MSISDN found/missing
- excludeImsi
- invalid MSISDN

Detail:
- found
- invalid IMSI
- 404
- optional fields missing
- full doc
- multi-slice
- multi-session
- unknown field
- sensitive field behavior
- Binary/hex behavior

Search:
- q < 2
- digits
- text
- default/min/max/invalid limit
- order
- shape

Precheck if migrated:
- valid
- invalid IMSI
- invalid count
- overflow
- permission
- rate limit
- no business writes

---

## 24. Routing

Do NOT route entire:

```text
/api/subscribers/
```

to Go because same prefix contains write APIs.

Ownership is method + path.

It is valid to report:

```text
Implemented = YES
Parity = PASS
Actually Routed = NO
```

---

## 25. Phase 2D / Phase 3

Phase 2D complete. Phase 3 may start next.

Phase 2D provides:
- auth/me with permission and role normalization
- auth/permissions with full capability map (CapabilitiesFor, supports raw `root` role)
- User list with two modes: legacy (/api/auth/users no query) and query (strict parser)
- User detail with activity, actions, assignable roles
- User management policy (read-only): assignableRoles, userManagementActions
- Strict query parser: rejects unknown keys, duplicates, invalid values (400 INVALID_QUERY)
- Regex escape for search input
- Status filters: locked = status=locked OR locked=true; active/disabled = status + locked!=true
- Pagination: totalPages=max(1,ceil), page clamp, stable _id tiebreaker sort
- Stats: global total (not filtered), active excludes locked, locked includes status=locked
- Empty arrays preserved as [] (not null)
- Sensitive field guard: passwordHash, _id, security secrets never returned
- Mongo write guard: user package is read-only
- CapabilitiesFor supports raw `root` role for auth/permissions endpoint

Phase 3 (Historical Archive — approval workflow retired in Phase 5.7-C):
- Governance — COMPLETE (for subscriber single-write scope)
- Approval read foundation — COMPLETE (retired in Phase 5.7-C)
- Audit writer lifecycle — COMPLETE (strict lifecycle, bounded close)
- Explicit decision endpoints — COMPLETE (retired in Phase 5.7-C)
- Contract preflight — COMPLETE (paramOrElse, ISO8601Millis, presenter bson.D)
- ACCESS_REQUEST creation — COMPLETE (retired in Phase 5.7-C)
- ACCESS_REQUEST handler tests — COMPLETE
- Actor-aware governance — COMPLETE (evaluateSubscriberOperationForActor)
- Fresh actor validation — COMPLETE (validateCurrentAccount for CREATE/UPDATE/DELETE)
- Strict audit — COMPLETE (fresh actor in audit metadata)
- OCS provisioning — COMPLETE (presence-aware input, no admin reservation, balance preservation)
- Subscriber batch create — COMPLETE (frozen v2 contract, create-only atomicity, profile drift protection, 5GiB default, Node production authority aligned)
- Approval execute — RETIRED (direct execution established in Phase 5.7-A/5.7-C)

Security audit blocker:
- RESOLVED — authorization.denied audit writer implemented (Phase 3A)

---

## 26. CNMS Boundary

Keep sibling roles:

```text
subscriber-console
→ subscriber / OCS / tariff / governance

CNMS
→ monitoring / signaling / capture / RCA / AIOps / NF
```

Future integration by API/SSO/unified UI/context links, not repo absorption.

---

## 27. Task Start Protocol

For Phase 2C start only with:

```text
frontend/src/app/api/subscribers/route.ts
frontend/src/app/api/subscribers/[imsi]/route.ts
frontend/src/app/api/search/route.ts
frontend/src/app/api/subscribers/batch/precheck/route.ts
frontend/src/server/repositories/subscriberRepository.ts
frontend/src/lib/xcloudSubscriber.ts
frontend/src/lib/subscriberValidation.ts
```

Expand only by actual imports/call-chain.

---

## 28. Task End Protocol

Go:

```bash
cd backend
gofmt -w .
go test ./...
go test -race ./...
go vet ./...
go build ./...
```

Node:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

If available:

```bash
npm run check:full
```

Migration:

```bash
node scripts/migration/inventory-api.mjs
node scripts/migration/validate-inventory.mjs
```

Run Node/Go parity where environment allows.

---

## 29. Git Protocol

After one logical feature:
- commit immediately
- concise Conventional Commit
- no phase/stage numbers in commit messages (describe what changed, not which phase)
- no trailing signatures (no Co-Authored-By, Signed-off-by, etc.)
- do not push unless explicitly requested
- do not amend completed phase history
- do not reset/discard user changes

Exact current SHA belongs to Git, not this file.

---

## 30. Context Budget Protocol

Keep active:

```text
current phase
current endpoint
current call-chain
current contract
current tests
current diff
current blocker
```

Do not repeatedly reload:
- all old phase reports
- all commits
- all docs
- all routes
- all repositories
- whole CNMS source

When context grows, create checkpoint:

```text
Confirmed
Implemented
Unresolved
Files touched
Tests
Next exact action
```

Persistent placement:

```text
Architecture/current ownership → AGENTS.md
Historical completed work      → docs/operations/dev-log.md
Pending work                   → docs/operations/todo.md
Stable rules                   → CLAUDE.md
```

Rule:

```text
Source code is memory.
Git is history.
AGENTS.md is the current map.
CLAUDE.md is the law.
```

---

## 31. Non-Negotiable

Never:
- trust forwarded identity headers
- dual-write business mutations
- change Mongo schema during language migration
- remove unknown xCloud fields
- change API paths/SWR paths
- move write ownership during Phase 2
- assume GET is pure
- assume POST is write
- hard-code migration counts
- claim cutover from handler existence
- copy CNMS auth model over subscriber-console

Always:

```text
verify source
preserve contract
preserve security
preserve data
test parity
commit small
keep rollback possible
```
