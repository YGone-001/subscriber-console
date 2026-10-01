# AGENTS.md — xCloud subscriber-console

> 当前项目快照，用于 Claude Code / MiMo / Codex 长会话续开发。
> **稳定规则看 `CLAUDE.md`；当前架构看 `docs/README.md` 与 `docs/architecture/`。**
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

### 0.2 操作模式 (Operation Model)

Approval workflow removed from business execution path. Authorization and operation logging remain.
- Authorized users execute permitted operations directly (Direct Execution).
- Zero approval records created on business operations (`app_approvals` count == 0).
- Best-effort / non-business-gating operation logging to `app_audit_logs`, RBAC capability gates, fresh actor revalidation, and CAS concurrency control remain active.

### 0.3 角色权限模型 (RBAC Model)

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
Nginx (only public origin)
   |----------------------|
   v                      v
Next.js 127.0.0.1:13333   Go 127.0.0.1:18888
UI / Rendering            Business API (owner)
UI navigation guard       Auth identity + session validation
(no JWT, no Mongo,        Read + write APIs
 no identity headers,     (84 METHOD+PATH registrations)
 no API forwarding)
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
           ├─ /api, /api/*  -> Go :18888
           └─ /*             -> Next.js :13333
```

Important:

```text
Nginx owns production API routing; Go owns every production API operation and API auth identity.
Route authority = the derived Go registration set (84 exact METHOD+PATH registrations).
The Next.js business backend (app/api + src/server) does not exist.
Next.js renders the UI and runs a UI-only navigation guard (proxy.ts); it never decodes a JWT, never reads MongoDB, never injects identity headers and never forwards an API request.
Frontend API paths remain unchanged.
```

---

## 3. Stack

```text
Next.js 16.2.2
React 19.2.4
TypeScript 5.x
Node 20
UI-only dependency set (no frontend jose / mongodb / jiti)
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

## 5. Current Production State

```text
Public edge                          = Nginx (deploy/nginx/xcloud.conf)
API owner (/api, /api/*)             = Go backend, 127.0.0.1:18888
UI owner (/*)                        = Next.js, 127.0.0.1:13333
Go production API registrations      = 84 exact METHOD+PATH registrations
Next.js business API operations      = 0
Next.js MongoDB access               = 0
Node business API execution          = 0
Route authority                      = derived Go registration set
Canonical API surface                = 33 operations + 2 legacy read aliases
OCS management writes                = 13 (tariff plan + subscriber contract + balance)
```

### 5.0 Deployment Boundary

```text
Sole public edge                     = Nginx
Next production listener             = 127.0.0.1:13333 (`next start -H 127.0.0.1 -p 13333`)
Go production listener               = 127.0.0.1:18888 (`HTTP_ADDR` default)
Loopback listener enforced by service, not firewall = YES
Standalone deployment path           = removed
Go business production changes       = 0
Go registration set                  = 84
```

- Edge: `deploy/nginx/xcloud.conf` uses two keepalive upstreams - `xcloud_next` (`127.0.0.1:13333`) and `xcloud_go` (`127.0.0.1:18888`). `location = /api`, `location /api/` and the dedicated unbuffered `location = /api/notifications/stream` proxy to Go; `location /` proxies to the Next.js UI. All API locations strip client identity headers (`X-User` / `X-Role` / `X-Permissions`) and generate `Host` / `X-Real-IP` / `X-Forwarded-For` / `X-Forwarded-Proto`; `client_max_body_size 10m`. `deploy/nginx/setup.sh [listen_port]` validates with `nginx -t` before reload.
- UI guard: `frontend/src/proxy.ts` is a UI-only navigation guard - no JWT decode, no HS256 verify, no MongoDB, no identity headers, no API forwarding. Protected pages without `auth_token` redirect to `/login?from=...`; the guard consults Go `GET /api/auth/me` with the incoming cookie (200 allow, 401 redirect + expire cookie, 503 fail-closed `AUTH_UNAVAILABLE` / `AUTH_SERVICE_UNAVAILABLE`). Its `config.matcher` excludes `api`.
- Route authority: the derived Go registration set (84 exact METHOD+PATH registrations parsed from `backend/cmd/server/main.go` plus `backend/internal/remediation/handler.go`, shared helper `scripts/lib/go-registrations.mjs`). Migration scripts derive from it.
- Next.js runtime: UI rendering plus the UI-only navigation guard. The Next.js business backend (`frontend/src/app/api/**`, `frontend/src/server/**`) does not exist. The frontend holds no route-owner resolver and no server-side session/Mongo runtime.
- Frontend dependencies: UI-only set. `jose`, `mongodb` and dev `jiti` are not dependencies; `frontend/src/lib/security.ts` keeps only the UI password policy (`isPasswordStrong`, `PASSWORD_POLICY_MESSAGE`); `next.config.ts` has no `serverExternalPackages: ['mongodb']`.
- Acceptance: `scripts/test-deployment-boundary.mjs` exercises the production topology (real Nginx + real Go + real `next build` / `next start` + real MongoDB) and proves, over real TCP against a real runner non-loopback address, that 127.0.0.1:{13333,18888} is reachable and the non-loopback address is not.
- Certification: `scripts/test-production-architecture.mjs` re-derives the current production architecture from primary source using semantic invariants only (no chronological baseline).
- Independent architecture suites: `scripts/test-api-ownership-invariants.mjs`, `scripts/test-next-backend-absence.mjs`, `scripts/test-frontend-runtime-dependencies.mjs`, `scripts/test-repository-normalization.mjs`.

### 5.1 OCS 管理平面冻结状态 (OCS Management Plane: Frozen)

OCS Management Plane is frozen.
Managed domains:
- Tariff Plans
- Contract Subscribers
- Balance Management

Charging Plane remains frozen and excluded.

- 权威基线：OCS 管理平面生产冻结基线（当前生产路由 = Go 全部接管，共 84 条 Go 注册）。
- 路由权威来源：Go 注册集合（`backend/cmd/server/main.go` + `backend/internal/remediation/handler.go`，共 84 条 METHOD+PATH 精确注册）；Nginx 负责 API 路由。
- 托管集合：`ocs_tariff_plans`、`ocs_subscribers`、`ocs_balances`。
- 冻结规约摘要（历史）：`docs/archive/backend-migration-summary.md`。
- 运维操作手册：`docs/operations/ocs-management-runbook.md`。
- 界面验收验证：通过无头浏览器 CDP 1440x900 渲染断言验证通过（本地测试截图即测即消，不入版本库）。

### 5.2 Local Full-Stack Access Contract

The full application browser origin is the Nginx edge.

```text
Default local URL:  http://localhost
Custom edge port:   http://localhost:<edge-port>   (sudo ./deploy/nginx/setup.sh <port>)
```

- Next.js `:13333` is an internal UI component endpoint only.
- Go `:18888` is an internal API component endpoint only.

Opening `:13333` directly may render the login page, but browser-relative `/api`
requests will correctly fail because Next.js owns no API routes.

When `/api` requests fail from `:13333`:
DO NOT add Next.js rewrites or API handlers.
Check/start the Nginx edge instead.

Use:

```bash
npm run local:doctor
```

Forbidden workarounds (never add):

```text
Next.js rewrite for /api
Next.js /api route handler
Next.js API reverse proxy / forwarding middleware
Node API fallback
browser-direct Go base URL (hardcoded http://127.0.0.1:18888/api/...)
```

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

## 7. Auth & User Management

Authentication model: `docs/operations/authentication-model.md`.
User management model: `docs/operations/user-management-model.md`.
RBAC model: `docs/operations/rbac-model.md`.

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

Only the Go backend performs JWT verification; the frontend holds no JWT runtime.

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
Legacy compatibility read aliases: `/api/auth/users`, `/api/auth/users/{username}` (Go-owned read-only; mutation methods retired).
Login/logout = Go owner.

Authentication security hardening:
- Dual rate limiting: IP-scoped request limiter (`login:<ip>`, 5/60s) + Account-scoped failed-login limiter (`login-user:<normalized-username>`, 10 failed attempts / 300s, peeked pre-auth, consumed only on failed authentication; successful logins do not consume budget).
- Automatic lockout: 10 consecutive failed password attempts transitions active unlocked user to `status="locked"`, `locked=true`, `sessionVersion+=1`, `lockedAt=now`, `lockReason="excessive_failed_logins"`. Attempt 11+ does not repeatedly increment `sessionVersion`.
- Response privacy: uniform HTTP 401 `{"error": "Invalid credentials"}` with `Cache-Control: no-store` on all credential/account-state failures (unknown username, wrong password, disabled account, locked account). Malformed JSON or request validation failures return HTTP 400.
- Password policy parity: minimum 8 Unicode code points after trimming surrounding whitespace, maximum 72 UTF-8 bytes, case-insensitive target username exclusion enforced identically in Node (`isPasswordStrong`) and canonical Go (`ValidatePassword`).
- Successful login: atomic reset of `failedLoginAttempts=0`, update `lastLoginAt` and `lastLoginIp` with concurrency state check; does not consume failed-login rate limit.
- Admin unlock: canonical Go API `PATCH /api/users/{username}` with `status="active"` resets lock state, unsets lock metadata, resets `failedLoginAttempts=0`, increments `sessionVersion`.
- Manual lock: `status="locked"` sets `locked=true`, `lockedAt`, `lockReason="manual_lock"`, increments `sessionVersion`.
- Last active admin protection: prevent auto-lockout or manual lock/disable on last active admin (`LAST_ACTIVE_ADMIN` 409).
- JWT secret startup validation: the Go backend fails closed on startup if `JWT_SECRET` is missing, <32 UTF-8 bytes, or matches common insecure placeholders.
- Cookie & header hardening: `SameSite=Lax`, `HttpOnly=true`, dynamic `Secure` over HTTPS, aligned logout cookie attributes, `Cache-Control: no-store` on sensitive auth responses.

Authentication runtime integration:
- Go owns all authentication APIs (`POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`, `GET /api/auth/permissions`), reached through the Nginx edge at `127.0.0.1:18888`.
- Fail closed: an unreachable Go backend returns HTTP 502 `GO_BACKEND_UNREACHABLE` with zero Node fallback.
- Validated via `scripts/test-authentication-runtime-integration.mjs`.

Authentication & User Management UI integration:
- Structured response and code mapping helper (`auth-ui.ts`) with strict privacy preserving uniform HTTP 401 presentation.
- Resilient rate-limit cooldown with countdown seconds display, automatic button re-enablement, unmount cleanup, and ARIA live regions.
- Session-expired vs credential alert presentation (`role="status"` vs `role="alert"`).
- Dynamic current actor awareness and self-protection in user detail view; removal of hard-coded `isSelf = false`.
- Status lifecycle governance actions (`active`, `disabled`, `locked`) guarded by confirmation modal.
- Security state metadata panel (`sessionVersion`, `failedLoginAttempts`, `lastLoginAt`, `lastLoginIp`, `passwordChangedAt`, and conditional `lockedAt`/`lockReason`).
- Complete English and Chinese localization parity for all auth & user management error codes and UI concepts.
- Validated via acceptance tests in `scripts/test-auth-user-ui-integration.mjs`.

---

## 8. Rate Limit

Go limiter:

```text
MongoDB fixed window
xcloud_ops.app_rate_limits
```

Preserve the exact rate-limit key/limit/window/headers/messages contract.

Current write invariant:

```text
Business-domain writes by Go = subscriber/profile CRUD + batch (Direct Execution), Go-owned
Infrastructure writes = app_rate_limits (allowed)
Operation logging = app_audit_logs (best-effort / non-business-gating internal operation logs; authorization denial evidence)
OCS writes = ocs_tariff_plans CRUD + enable/disable (Direct Execution), Go-owned
OCS subscriber writes = ocs_subscribers create/update-tariff/suspend/resume/terminate (Direct Execution), Go-owned
OCS balance writes = ocs_balances adjust (Direct Execution), reset (permanently disabled), Go-owned
User Management writes = app_users CRUD + disable + password-reset (Direct Execution), Go-owned
Platform Services writes = alerts acknowledge/workflow (Direct Execution), Go-owned
```

Route authority = the derived Go registration set (84 exact METHOD+PATH registrations).
Every production API operation is Go-owned at the Nginx edge.

---

## 9. Current Go Read Implementations

30 semantic-read implementations (29 GET + 1 POST semantic read).

Analytics / rating:

```text
GET /api/analytics/metrics
GET /api/analytics/sparkline
GET /api/ratings
GET /api/ratings/:id
```

Profiles / OCS / tariff:

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
GET /api/ocs/subscribers
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

Subscriber / search:

```text
GET /api/subscribers
GET /api/subscribers/:imsi
GET /api/search
POST /api/subscribers/batch/precheck
```

Auth / user management:

```text
GET /api/auth/me
GET /api/auth/permissions
GET /api/auth/users
GET /api/auth/users/:username
GET /api/users
GET /api/users/:username
```

Platform services:

```text
GET /api/alerts
GET /api/system/health
GET /api/system/mongo/health
GET /api/system/audit/status
POST /api/system/audit/scan
POST /api/analytics/init
```

Status:

```text
Go production API registrations = 84 (route authority: backend/cmd/server/main.go + backend/internal/remediation/handler.go)
Next API route tree = absent
Canonical API surface = 33 operations + 2 legacy read aliases
Go-native reads = 2
Node production operations = 0
OCS writes = 13 (tariff plan + subscriber contract + balance)
```

The route authority is the derived Go registration set; no route-owner table or resolver exists in production source.

Platform service, alert mutation, notification streaming, and system integrity endpoints are Go production-owned.
Production traffic is Go-owned with no Node fallback and no surviving Node business handler.
`next_business_mongo_readers = 0`, `next_business_mongo_writers = 0`; the Next.js runtime performs no MongoDB access at all.

---

## 9.1 Direct Operation Model

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

OCS boundary:

```text
Management plane (managed by Go):
  ocs_tariff_plans   — tariff plan definitions + rules
  ocs_subscribers    — subscriber contracts + plan assignments
  ocs_balances       — balance accounts + pools

Charging plane (frozen, excluded from the management plane):
  ocs_sessions       — active Gy/Ro sessions
  ocs_reservations   — reserved quota
  ocs_usage          — usage records
  ocs_events         — charging events
  ocs_config         — OCS engine config
```

OCS management UI:
- `GET /api/ocs/subscribers` — Go read implementation
- OCS Dashboard UI (`/ocs/dashboard`) — 4 KPI cards, balance pool, tariff plans
- OCS Subscribers UI (`/ocs/subscribers`) — paginated table, status filter, search

Tariff plan writes:
- 6 tariff plan write operations (create/update/delete/clone/enable/disable) — Go governed
- Fresh actor revalidation before every mutation
- Tariff routes are Go-owned at the edge
- Tariff list UI (`/ocs/tariffs`) — KPI cards, table, enable/disable/clone/delete actions
- Rate limits: create=20/60, update=30/60, delete=20/60, clone=20/60, enable/disable=20/60
- Capability: `ocs.tariff.write`
- Error codes: TARIFF_PLAN_EXISTS, TARIFF_PLAN_NOT_FOUND, DEFAULT_TARIFF_PLAN_PROTECTED, TARIFF_PLAN_DISABLE_IN_USE, INVALID_PLAN_ID

## 10. Removed Governance Surfaces

The following governance endpoints and surfaces are retired:
- `/api/approvals/*` (all approval read, decision, and export routes)
- `/api/audit/*` (user-facing audit console list, detail, export routes; note `/api/system/audit/*` remains for diagnostics and healing)
- Approval and Audit UI console pages and navigation entries

---

## 10.1 Platform Services

Platform services scope (11 endpoints):
- Alerts: `GET /api/alerts`, `POST /api/alerts/acknowledge`, `POST /api/alerts/workflow`
- Notification streaming: `GET /api/notifications/stream` (SSE, ping heartbeat, zero external broker)
- System health: `GET /api/system/health`, `GET /api/system/mongo/health` (distinct from `/healthz` and `/readyz`)
- System integrity: `GET /api/system/audit/status`, `POST /api/system/audit/scan` (read-only), `POST /api/system/audit/heal`, `POST /api/system/audit/batch-heal`
- Analytics platform action: `POST /api/analytics/init` (read-only on-demand calculation)

All 11 endpoints are Go production-owned.
Production routing: all Go-owned, routed by the Nginx edge; route authority = the derived 84-route Go registration set.
Production owner = Go with no Node fallback and no surviving Node business handler.

---

## 11. Contract Findings — Do Not Regress

### Tariff export

Must preserve:

```text
Content-Type: application/json
Content-Disposition: attachment; filename="tariff-plan-{id}.json"
```

Response includes:

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
Governance authority = Go.

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

## 12. Route Registration Authority

Route authority is the derived Go registration set, source-derived and METHOD+PATH aware.

Sources:

```text
backend/cmd/server/main.go
backend/internal/remediation/handler.go
```

Shared parse helper:

```text
scripts/lib/go-registrations.mjs
```

Must maintain:

- Go router ↔ registration cross-check (all HTTP methods)
- dynamic path canonicalization
- registered route count derived from source
- GET reads vs POST semantic reads classification
- business mutations count (should be 0)

Never hard-code endpoint counts.

Enforced by the permanent gates `scripts/test-api-ownership-invariants.mjs` and `scripts/test-production-architecture.mjs`.

---

## 13. Subscriber Read Endpoints

All 4 endpoints are Go-owned:

```text
GET /api/subscribers         — list/detail/MSISDN lookup
GET /api/subscribers/:imsi   — legacy state detail
GET /api/search              — subscriber/profile split
POST /api/subscribers/batch/precheck — semantic read, requires subscriber_write cap
```

Business writes: NONE.

---

## 14. Subscriber List Contract

```text
GET /api/subscribers
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

```text
GET /api/subscribers/:imsi
```

Detail uses:

```text
findSubscriberLegacyState(imsi)
```

The Go implementation must reproduce the legacy API representation, not raw xCloud BSON.

---

## 16. Subscriber Writes

Subscriber writes are Go-owned with direct execution:

```text
POST /api/subscribers
PUT /api/subscribers/:imsi
DELETE /api/subscribers/:imsi
batch create/update
bulk delete
import
policy mutation
```

No Node subscriber write path exists.

---

## 17. Search Contract

```text
GET /api/search
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

Do not improve/re-rank.

---

## 18. Batch Precheck

```text
POST /api/subscribers/batch/precheck
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

Do not change the capability or the rate-limit key: `precheckSubscriberRange()` behavior must be preserved.

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

Reads may compose:

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

Do not create indexes as part of a read-path change.

---

## 23. Subscriber Read Minimum Tests

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

Precheck:
- valid
- invalid IMSI
- invalid count
- overflow
- permission
- rate limit
- no business writes

---

## 24. Routing

Nginx routes all of `/api` and `/api/*` to the Go backend; `location /` serves the Next.js UI.

Ownership is method + path. Route authority is the derived Go registration set; every
registered METHOD+PATH is Go-owned and there is no Node fallback.

Before adding or changing a route, confirm the METHOD+PATH against the Go registration
sources (`backend/cmd/server/main.go` + `backend/internal/remediation/handler.go`).

---

## 25. Auth / User Management Read Semantics

Go-owned reads:
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

Governance semantics (current):
- Approval workflow is retired: business mutations execute directly (see §0.2 / §9.1).
- Audit writer lifecycle: strict lifecycle, bounded close.
- Contract preflight: paramOrElse, ISO8601Millis, presenter bson.D.
- Actor-aware governance: evaluateSubscriberOperationForActor.
- Fresh actor validation: validateCurrentAccount for CREATE/UPDATE/DELETE.
- Strict audit: fresh actor recorded in audit metadata.
- OCS provisioning: presence-aware input, no admin reservation, balance preservation.
- Subscriber batch create: frozen v2 contract, create-only atomicity, profile drift protection, 5GiB default.
- Authorization denial evidence: `authorization.denied` audit writer implemented.

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

Start from the owning entry points, then expand only by actual imports/call-chain.

Read-side (Go backend):

```text
backend/cmd/server/main.go
backend/internal/remediation/handler.go
backend/internal/subscriber/**
```

UI (Next.js frontend):

```text
frontend/src/proxy.ts
frontend/src/app/subscribers/**
frontend/src/lib/**
```

Edge:

```text
deploy/nginx/xcloud.conf
```

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

Documentation / architecture gates:

```bash
node scripts/test-current-architecture-docs.mjs
node scripts/test-documentation-integrity.mjs
node scripts/test-repository-normalization.mjs
node scripts/test-api-ownership-invariants.mjs
node scripts/test-next-backend-absence.mjs
node scripts/test-frontend-runtime-dependencies.mjs
node scripts/test-production-architecture.mjs
```

Run Node/Go parity where environment allows.

---

## 29. Git Protocol

After one logical feature:
- commit immediately
- concise Conventional Commit
- no lifecycle phase tokens or stage codes in commit messages (any case, with or without a separating space); never use one as a Conventional Commit scope or as part of the subject
- describe what changed, never which lifecycle stage it belongs to
- no trailing signatures (no Co-Authored-By, Signed-off-by, etc.)
- do not push unless explicitly requested
- do not amend already-pushed history
- do not reset/discard user changes

Exact current SHA belongs to Git, not this file.

---

## 30. Context Budget Protocol

Keep active:

```text
current task
current endpoint
current call-chain
current contract
current tests
current diff
current blocker
```

Do not repeatedly reload:
- all historical reports
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
Current architecture + operations → docs/architecture/, docs/operations/
Stable rules                   → CLAUDE.md
```

Completed implementation plans and acceptance records are not maintained in HEAD;
Git history preserves detailed historical development evidence. `docs/archive/**`
holds concise historical summaries only.

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
- change the Mongo schema
- remove unknown xCloud fields
- change API paths/SWR paths
- introduce a second write owner for a production operation
- assume GET is pure
- assume POST is write
- hard-code API surface counts
- claim route ownership from handler existence alone
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
