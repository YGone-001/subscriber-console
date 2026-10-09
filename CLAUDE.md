# xCloud subscriber-console — Agent 规则与当前状态

<!-- PARITY-HEADER-BEGIN -->
> **面向对象**：Claude Code。
> **配对文件**：`AGENTS.md`。本文件与 `AGENTS.md` 正文逐字一致，仅本声明区不同。
<!-- PARITY-HEADER-END -->

> **适用范围**：`subscriber-console` 仓库 `develop` 分支的长期开发。
> **文档定位**：稳定规则（法）+ 当前快照（地图）的统一体。详细事实见 `docs/`；最终真相是运行源码与自动化测试。
> **同步约束**：修改本文件必须同步配对文件，并运行 `npm run check:agent-docs-parity` 校验。

---

## 0. 最小启动流程 (Minimal Bootstrap)

新会话只做：

```text
1. Read AGENTS.md / CLAUDE.md (identical content; read either one)
2. git status
3. git branch --show-current
4. git log --oneline -10
5. Read only task-relevant source
```

不要先扫描整个仓库。

### 0.1 核心防卫底线 (Core Defensive Constraints)

1. **【编码与字符规范】**：程序编码强制默认使用 UTF-8 格式，绝不允许使用 Base64 编码方式。所有编程语言源码必须严格遵守“纯 ASCII（纯英文+符号）”原则，剔除代码中的所有 Emoji 和无关中文，仅保留最纯粹的代码以及必要的中文注释说明（国际化文案存放在 `src/lib/locales/`）。
2. **【接口向前兼容性】**：每次更新源码前，必须全面回顾涉及模块的上下文。绝对不能随意删除已有函数接口、API 路由或结构体公共方法！如需调整，必须选择在原接口上做向下兼容的参数扩展或创建新接口。功能模块的升级必须紧密依赖现有的最新内容框架与源码结构进行，严禁“去头掐尾”导致旧功能断裂。
3. **【前端表达规范】**：在输出修改说明、更新日志、提交记录或代码注释时，涉及前端开发的变动必须使用严谨、专业的工程化术语（如“DOM 渲染结构优化”、“SWR 客户端状态同步”、“组件样式自适应重构”、“响应式布局与交互对齐”）；严禁使用“说明出现在网页前端展示上”等非专业口语化表述。

### 0.2 权威与冲突裁决 (Source of Truth)

冲突时优先级：

```text
1. 当前运行源码
2. 自动化测试
3. 冻结 API Contract / Go 注册集合
4. AGENTS.md 与 CLAUDE.md（本规则文件；二者正文一致）
5. docs/README.md（文档权威模型）
6. docs/architecture/ + docs/operations/ + docs/database/
7. README / 旧设计文档
8. 注释
```

裁决规则：

- **规则类冲突**（怎么做、允许与禁止）→ 以本规则文件为准。
- **事实类冲突**（现状是什么）→ 以当前运行源码与自动化测试为准。
- 文档与源码冲突时：不猜 → 读取真实调用链 → 记录差异 → 以当前 observable behavior 为基线 → 必要时修正文档。
- 禁止为了“让文档正确”而改业务源码。

### 0.3 文档职责与同步规则

| 文档 | 只放 |
|---|---|
| `AGENTS.md` / `CLAUDE.md` | 稳定规则 + 当前快照（二者正文逐字一致） |
| `docs/README.md` | 文档权威模型与索引 |
| `docs/architecture/`、`docs/operations/`、`docs/database/` | 当前系统事实（现在时描述） |
| `docs/archive/**` | 简明历史摘要，非当前架构权威 |

- `AGENTS.md` 与 `CLAUDE.md` 正文必须逐字一致，仅顶部声明区（面向对象 / 配对文件）不同。
- 修改任一份后必须同步另一份，并运行 `npm run check:agent-docs-parity`。
- 只有以下变化需要更新本文件：ownership 改变、架构变更完成、安全边界改变、核心数据流改变、blocker 改变、重要 contract 结论改变。
- 不要把普通 bug fix 塞进本文件。

### 0.4 操作模式 (Operation Model)

Approval workflow removed from business execution path. Authorization and operation logging remain.

- 授权用户直接执行业务变更操作，即时生效（Direct Execution）。
- 移除阻塞式业务审批工作流，业务操作不生成 `app_approvals` 记录（正常业务路径下 `app_approvals` 计数恒为 0）。
- 严格保留：RBAC 能力门、操作主体重新鉴权（Fresh Actor Revalidation）、非阻塞式操作日志、CAS 并发冲突保护。
- 操作日志为 best-effort、不阻塞业务响应。

### 0.5 角色权限模型 (RBAC Model)

三标准角色模型 (Canonical Three-Role Model)：

- `admin`（管理员）：全系统与用户管理，包含用户生命周期管理、角色分配、业务直接变更。
- `operator`（操作员）：业务直接变更（签约、余额、Profile、资费、计费等）与核心网运维配置，不可管理用户。
- `viewer`（查看员）：只读查看，所有业务变更与用户管理均拒绝（HTTP 403）。

向后兼容与运行时归一化：

- 历史角色透明映射：`root` / `super_admin` → `admin`，`ops_admin` → `operator`，`auditor` → `viewer`。
- 写入边界：用户创建与角色更新仅接受 `['admin', 'operator', 'viewer']`；写入历史角色直接返回 HTTP 400 `INVALID_ROLE`。
- UI 角色下拉严格展示三标准角色。

---

## 1. 仓库与产品定位

### 1.1 仓库

主仓库：

```text
https://github.com/YGone-001/subscriber-console.git
branch: develop
```

仅作参考：

```text
https://github.com/YGone-001/CNMS.git
branch: develop
```

产品名 = `xCloud`。

### 1.2 产品定位与核心域

xCloud 是独立的电信运营与核心网运维平台，不是附属 WebUI。

当前核心域：IMSI 签约、Profile、OCS、Tariff / Rating、用户管理与认证、审计、告警、系统健康、运营分析。

长期演进：EPC / 5GC / IMS 网元管理、信令追踪与 HEP/HOMER、告警关联 / RCA / AIOps、CNMS 能力集成。

### 1.3 CNMS 边界

CNMS 是参考仓库，不是合并目标；不整仓合并。

```text
subscriber-console
→ subscriber / OCS / tariff / governance

CNMS
→ monitoring / signaling / capture / RCA / AIOps / NF
```

- 可参考：config、Mongo connect/ping/close、middleware、WebSocket、HEP、signaling correlation、capture、monitoring、AIOps。
- 不要直接复制：CNMS JWT/Bearer auth、CNMS RBAC、CNMS 单库 Mongo wrapper、CNMS response envelope。
- subscriber-console 的 contract / session 语义优先。
- 未来集成通过 API / SSO / 统一 UI / 上下文链接，而非仓库吸收。

---

## 2. 当前生产架构

### 2.1 生产拓扑

```text
Browser
   |
   v
Nginx (only public origin)
   |
   v
Go 127.0.0.1:18888
Business API (owner)
Auth identity + session validation
Read + write APIs (97 exact METHOD+PATH registrations)
Embedded static React SPA (production UI)
   |
   v
MongoDB
xcloud + xcloud_ops
```

当前浏览器路由：

```text
Browser -> Nginx
           └── /*, /api/* -> Go :18888
```

关键事实：

- Nginx 是唯一对外入口，单一应用 upstream（`xcloud_go` → `127.0.0.1:18888`），代理 `/api`、`/api/*`、SSE 及 `/*`。
- Go 独占全部生产 API，并内嵌托管静态 React SPA（embedded static React SPA）。
- `frontend/` 是规范 React + Vite SPA 源码，构建为静态资产后嵌入 Go 二进制。
- Next.js 源码已退役，原 Next.js 端口重新分配给 Vite 本地开发（`127.0.0.1:13333`）；生产 edge 流量为 0，生产环境不需要 Node 运行时。
- Next.js 业务后端不存在，不得重建。
- API 路径保持 `/api/...` 不变。

### 2.2 部署边界 (Nginx)

```text
Sole public edge                     = Nginx (single upstream xcloud_go)
Go production listener               = 127.0.0.1:18888 (`HTTP_ADDR` default)
Retained legacy Next listener        = retired
Loopback listener enforced by service, not firewall = YES
Standalone deployment path           = removed
Go business production changes       = 0
Go registration set                  = 97
```

- 边缘配置为 `deploy/nginx/xcloud.conf`。`location = /api`、`location /api/`、专用非缓冲 `location = /api/notifications/stream` 与 `location /` **全部代理至 Go**；UI 由 Go 内嵌 SPA 提供。
- 所有 location 剥离客户端身份头（`X-User` / `X-Role` / `X-Permissions`），并生成 `Host` / `X-Real-IP` / `X-Forwarded-For` / `X-Forwarded-Proto`；`client_max_body_size 10m`。
- `deploy/nginx/setup.sh [listen_port]` 在 reload 前执行 `nginx -t` 校验。

### 2.3 架构演进状态

```text
Current runtime                 = Nginx -> Go :18888 (API + embedded static SPA)
Architecture evolution roadmap  = runtime consolidation and frontend canonicalization completed
Next implementation direction   = complete
```

- 短期运行时整合与前端规范化已完成：Nginx → Go（API + 内嵌静态 React SPA）。
- 前端视觉与交互一致性恢复已完成：历史 xCloud 运维界面表现层已前向移植到当前 React/Vite + Go 运行时。权威文档：`docs/architecture/frontend-ui-restoration.md`。
- 双权威约定：历史 UI 参考 SHA = `2c40903fea1e56650736ee862e3ddab33d9f64fc`（仅决定外观与交互）；当前架构权威 = 当前 `develop`（决定运行方式）。UI 恢复绝不恢复已退役的 Next 运行时权威。
- Topology / Dependency Model Foundation = PLANNED（未开始）。
- 长期演进权威文档：`docs/architecture/architecture-evolution-roadmap.md`；在其实施阶段开始前，不得当作运行时部署指令。
- 长期方向：模块化运维平台（inventory / topology、workflow、assurance、telemetry、厂商中立 adapter 边界）。逻辑边界先于部署拆分；仅在规模、故障隔离、运维归属或可用性要求时才引入独立服务。

### 2.4 本地全栈访问契约

生产浏览器访问始终从 Nginx 边缘进入；本地开发由 Vite 开发服务器提供。

```text
Default local production URL: http://localhost
Custom edge port:             http://localhost:<edge-port>   (production: sudo ./deploy/nginx/setup.sh <port>)
Local development URL:        http://localhost:13333
```

- Vite 开发服务器 `127.0.0.1:13333`（loopback-only，strictPort）将 `/api/*` 代理至 Go `127.0.0.1:18888`。
- Go `127.0.0.1:18888` 仅为内部 API 端点，不作为浏览器直接页面访问地址。
- 本地开发不需要 Nginx。
- 端口现状：80 为生产生效的 Nginx HTTP 边缘（`deploy/nginx/xcloud.conf` 中 `listen 80;`）；443 默认不生效，仅存在于被注释的 HTTPS 模板中。

本地运维命令：

```bash
npm run local:preflight
npm run local:dev
npm run local:status
npm run local:doctor
npm run local:stop
```

本地运维铁律：

```text
Never resolve canonical port contamination by changing 13333/18888.
Never automatically kill an arbitrary listener.
Acceptance suites must own the processes they measure.
Use `npm run local:preflight` to inspect contamination before debugging business behavior.
```

- 规范内部端口不可被环境变量覆盖。
- `local:stop` 仅在归属记录与活动进程校验通过后终止进程；身份不匹配一律 `REFUSE_TO_KILL`；权限不足报 `INSUFFICIENT_PERMISSION`，绝不自动提权、绝不触发 UAC。
- 托管进程生命周期为原子操作：`local:dev` 必须在 readiness 轮询开始前写入归属记录（`spawn -> inspect live process identity -> write record -> readiness`），后续任一步失败按逆序回滚，每个退出路径满足“子进程不存在，或存在且带有效归属记录”（`local_dev_unmanaged_live_processes=0`）。
- `local:stop` 以“确认进程退出”为成功判据：发送信号不等于已停止；进程仍存活则保留归属记录并报 `STOP_TIMEOUT` / `NEEDS_ATTENTION` 并非 0 退出（`local_stop_record_preserved_on_timeout=true`），绝不引入任意强杀。

禁止新增的绕过手段：

```text
Next.js rewrite for /api
Next.js /api route handler
Next.js API reverse proxy / forwarding middleware
Node API fallback
browser-direct Go base URL (hardcoded http://127.0.0.1:18888/api/...)
```

### 2.5 技术栈

前端：

```text
React 19.2.4
TypeScript 5.x
Vite 8
React Router 7
Lucide React
Recharts
SWR
Plain CSS design-token layers (frontend/src/styles: tokens / base / shell / components / pages / utilities)
Node 20 (.nvmrc)
UI-only dependency set (no frontend jose / mongodb / jiti)
```

前端运行时边界（前端不持有 API 认证运行时）：

- 前端不使用 MongoDB Node Driver、`jose`、`bcryptjs`。
- 前端不解析/校验 JWT，不访问 MongoDB，不注入身份头。
- 仅保留 UI 密码策略 `isPasswordStrong` / `PASSWORD_POLICY_MESSAGE`（`frontend/src/lib/security.ts`）。

Go：

```text
Go 1.24+
net/http
modern ServeMux
log/slog
mongo-driver/v2
```

不使用 Gin / Fiber / Echo / GORM。

### 2.6 Go 基础能力

`backend/` 已具备：env config、one Mongo client / two DB handles、`/healthz`、`/readyz`、request ID、recovery、结构化日志、安全中间件、优雅关闭、HTTP 超时、Go CI、安全审计证据写入器（BestEffort + Strict 模式）、授权拒绝守卫（RequireCapabilityWithAudit / RequirePermissionWithAudit）、payload sanitizer（敏感信息脱敏、深度/边界）。

- `/healthz` 不依赖 Mongo；`/readyz` 检查 Mongo。

---

## 3. 数据层

### 3.1 MongoDB 双库

同一 Mongo URI 下两个库：

```text
xcloud
xcloud_ops
```

Go 必须采用：

```go
type Databases struct {
    Client  *mongo.Client
    xCloud *mongo.Database
    Ops     *mongo.Database
}
```

一个 `mongo.Client` + 两个 database handle。除非未来真实配置变成两个不同 URI，否则不要创建两个 client。

### 3.2 xCloud BSON 兼容

xCloud document 高度 schema-sensitive。最高风险集合为 `xcloud.subscribers`，可能包含 security、AMBR、slices、sessions、MSISDN、policy、未知字段、Binary、int32/int64 与日期结构。

读取路径优先：

```text
bson.M / bson.Raw
→ explicit mapper
→ legacy API DTO
```

禁止：

- 未证明 schema 时把整个文档强 decode 进巨大 struct。
- 删除未知字段。
- 修改 nested slice / session / security / AMBR。
- 改字段名或字段类型。
- 把 API 语言迁移变成 DB schema migration。

必须保持区分：`missing` / `null` / `0` / `""` / `[]`。注意 Go nil slice 会序列化为 `null`，而旧实现可能返回 `[]`；Binary/Buffer 不得意外输出 Go base64（旧实现可能用 hex/string）。未知 xCloud 字段不得导致读取失败。

### 3.3 跨库读取

读取可组合 `xcloud` 与 `xcloud_ops`；**禁止跨库写入**，无需事务。若读取跨多个集合，除非已证明快照语义，否则按最终一致处理。

---

## 4. 认证、授权与用户管理

### 4.1 认证模型与边界

权威文档：`docs/operations/authentication-model.md`、`docs/operations/user-management-model.md`、`docs/operations/rbac-model.md`。

认证链：

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

稳定边界：

- 用户集合 `xcloud_ops.app_users` 为唯一权威用户存储，禁止复制到其他集合。
- 删除策略：不硬删除，使用 `status=disabled`。
- 会话失效：密码 / 角色 / 状态变更时 `security.sessionVersion++`。
- JWT：HS256，24h 过期，`auth_token` cookie（httpOnly，sameSite=lax）；无 refresh token。
- 仅 Go 后端验签，前端不持有 JWT 运行时。
- 禁止引入：IAM 框架、OAuth、SSO、LDAP、MFA、多租户隔离、策略引擎。
- 认证 API 生产所有权：Go 独占 `POST /api/auth/login`、`POST /api/auth/logout`、`GET /api/auth/me`、`GET /api/auth/permissions`；Nginx 直接将 `/api` 与 `/api/*` 转发至 Go，无 Node fallback。Go 不可达时返回 HTTP 502 `GO_BACKEND_UNREACHABLE`。
- 用户管理读路径不写 `app_users`；写仅通过 Go 用户管理写 API。

禁止信任以下 header 作为身份权威：

```text
x-user
x-user-role
x-user-id
x-user-session-version
```

用户管理路由（生产 owner = Go）：

```text
GET    /api/users
POST   /api/users
GET    /api/users/{username}
PATCH  /api/users/{username}
POST   /api/users/{username}/disable
POST   /api/users/{username}/password-reset
```

历史兼容只读别名：`/api/auth/users`、`/api/auth/users/{username}`（Go-owned 只读，写方法已退役）。

### 4.2 认证安全加固

- 双重限流：IP 维度（`login:<ip>`，5 次 / 60s）+ 账号维度（`login-user:<normalized-username>`，10 次失败 / 300s，认证前预检，仅认证失败时扣减；登录成功不扣减）。
- 自动锁定：连续 10 次密码错误置为 `status="locked"`、`locked=true`、`sessionVersion+=1`、`lockedAt`、`lockReason="excessive_failed_logins"`；后续失败不重复递增 `sessionVersion`。
- 响应隐私：凭据与账号状态失败（用户不存在 / 密码错误 / 已禁用 / 已锁定）统一返回 HTTP 401 `{"error": "Invalid credentials"}` 与 `Cache-Control: no-store`；请求格式错误、字段缺失或密码超长（>72 字节）返回 HTTP 400。
- 密码策略：去除首尾空白后 Unicode 码点数 ≥ 8、UTF-8 编码 ≤ 72 字节、且不包含目标用户名（不区分大小写）；Node 与 Go 必须一致。
- 登录成功：原子重置 `failedLoginAttempts=0`，更新 `lastLoginAt` / `lastLoginIp`（带并发状态检查），不消耗失败限流配额。
- 管理员解锁：`PATCH /api/users/{username}` 且 `status="active"`，清空锁定元数据、重置 `failedLoginAttempts=0`、递增 `sessionVersion`。
- 手动锁定：`status="locked"` 设置 `locked=true`、`lockedAt`、`lockReason="manual_lock"`、递增 `sessionVersion`。
- 末位管理员保护：禁止对最后一个激活管理员自动锁定或手动锁定 / 禁用（HTTP 409 `LAST_ACTIVE_ADMIN`）。
- 密钥启动校验：Go 启动时若 `JWT_SECRET` 缺失、< 32 UTF-8 字节或命中常见弱占位符，则拒绝启动（fail closed）。
- Cookie 与响应头加固：`SameSite=Lax`、`HttpOnly=true`、HTTPS 下 `Secure`、登出属性对齐、敏感响应 `Cache-Control: no-store`。

### 4.3 Permission 契约

每个接口必须检查权限契约：

```text
requireAuth
requireCapability
requirePermission
```

Go 必须保持 observable permission contract；不要用 CNMS RBAC 替换 subscriber-console 规则。

---

## 5. 写边界与治理

### 5.1 直接操作模型

所有业务变更在通过认证、Fresh Actor 校验、RBAC 能力检查、域校验与并发检查后**直接执行**：

- 零审批依赖：不创建审批工单，不做 maker-checker 交接（正常业务下 `app_approvals` 计数恒为 0）。
- 三标准角色授权见 §0.5；`viewer` 的所有变更请求返回 HTTP 403。
- 非阻塞操作日志：变更将操作证据写入 `xcloud_ops.app_audit_logs`；日志为 best-effort，不阻塞业务响应。
- 并发：原子 CAS 版本保护 balances / tariff plans / subscribers。
- 历史数据：`xcloud_ops.app_approvals` 仅作历史数据保留，正常业务路径不访问。

### 5.2 写边界清单

当前写边界（Go 为唯一 owner）：

```text
Business-domain writes by Go = subscriber/profile CRUD + batch (Direct Execution), Go-owned
Infrastructure writes = app_rate_limits (allowed)
Operation logging = Best-effort / non-business-gating operation logging to app_audit_logs
OCS writes = ocs_tariff_plans CRUD + enable/disable (Direct Execution), Go-owned
OCS subscriber writes = ocs_subscribers create/update-tariff/suspend/resume/terminate (Direct Execution), Go-owned
OCS balance writes = ocs_balances adjust (Direct Execution), reset (permanently disabled), Go-owned
User Management writes = app_users CRUD + disable + password-reset (Direct Execution), Go-owned
Platform Services writes = alerts acknowledge/workflow (Direct Execution), Go-owned
```

写链：

```text
Handler
  ↓
Application Service
  ↓
Governance Policy
  ↓
Executor / Repository
  ↓
Audit
```

- 禁止 Node + Go 双写同一业务 mutation；同一 mutation 只能有一个 authoritative implementation。
- 禁止绕过 RBAC 能力门或 Fresh Actor 重新鉴权。
- 禁止 Handler 直接写 DB。
- 禁止改 API path 或改 Mongo schema 来达成迁移。

### 5.3 已移除的治理面

```text
/api/approvals/*   (all approval read, decision, and export routes)
/api/audit/*       (user-facing audit console list, detail, export routes)
```

审批与审计的前端控制台页面与导航入口均已移除。`/api/system/audit/*` 保留，用于诊断与修复。

---

## 6. OCS 管理平面（冻结）

### 6.1 冻结范围

OCS Management Plane is frozen.

```text
Managed domains:
  Tariff Plans
  Contract Subscribers
  Balance Management

Charging Plane remains frozen and excluded.
```

- 资费计划（`ocs_tariff_plans`）、签约合同（`ocs_subscribers`）、余额管理（`ocs_balances`）的生产基线永久冻结。
- 严禁向 OCS 管理平面添加新业务能力或重新设计架构。
- 严禁引入或耦合运行时计费面实体（`ocs_sessions`、`ocs_reservations`、`ocs_usage`、`ocs_events`、`ocs_config`、Gy/Ro/CCR/CCA 协议栈）。

### 6.2 托管集合与端点

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

- 权威基线：OCS 管理平面生产冻结基线；当前生产路由 = Go 全部接管，**共 97 条 Go 注册**。
- 路由权威来源：Go 注册集合（`backend/cmd/server/main.go` + `backend/internal/remediation/handler.go`，97 条 METHOD+PATH 精确注册）；Nginx 负责 API 路由。
- 冻结规约摘要（历史）：`docs/archive/backend-migration-summary.md`。
- 运维操作手册：`docs/operations/ocs-management-runbook.md`。

OCS 管理 UI：

- `GET /api/ocs/subscribers` — Go read implementation
- OCS Dashboard UI（`/ocs/dashboard`）— 4 张 KPI 卡、余额池、资费计划
- OCS Subscribers UI（`/ocs/subscribers`）— 分页表格、状态过滤、搜索

### 6.3 资费写入

- 6 个资费计划写操作（create / update / delete / clone / enable / disable）— Go governed，每次变更前 Fresh Actor 重新鉴权。
- 资费路由在边缘由 Go 独占。
- 资费列表 UI（`/ocs/tariffs`）— KPI 卡、表格、启用/禁用/克隆/删除操作。
- 限流：create=20/60、update=30/60、delete=20/60、clone=20/60、enable/disable=20/60。
- 能力：`ocs.tariff.write`。
- 错误码：`TARIFF_PLAN_EXISTS`、`TARIFF_PLAN_NOT_FOUND`、`DEFAULT_TARIFF_PLAN_PROTECTED`、`TARIFF_PLAN_DISABLE_IN_USE`、`INVALID_PLAN_ID`。

---

## 7. API 契约与路由权威

### 7.1 路由注册权威

```text
Route authority = the derived Go registration set (97 exact METHOD+PATH registrations).
```

权威来源：

```text
backend/cmd/server/main.go
backend/internal/remediation/handler.go
```

共享解析助手：`scripts/lib/go-registrations.mjs`。

必须保持：

- Go router ↔ registration 交叉校验（覆盖所有 HTTP method）
- 动态路径 canonicalization
- 注册数量由源码派生，**绝不硬编码**
- phantom / missing route 检测
- 禁止按 `/api/subscribers/` 之类 prefix 推断归属

所有权以 method + path 为准。Go Handler 存在本身不等于该 route 已登记为生产注册。

### 7.2 API 契约保持项

演进必须保持：method、path、query aliases、request body、status、response shape、`null`、`missing`、`[]`、`0`、sort、pagination、headers、permissions、rate limit、error code/message、export filename/MIME。禁止趁改动 redesign。

Go 特别注意：int64、Decimal128、ObjectId、time.Time、nil slice、`omitempty`、Binary/Buffer —— 必须通过 mapper + contract tests 控制。

### 7.3 契约结论（不得回退）

- **Tariff export**：必须保持 `Content-Type: application/json` 与 `Content-Disposition: attachment; filename="tariff-plan-{id}.json"`；响应含 `version`、`exported_at`、`plan_id`、`name` 等；限流 30/60s。
- **Tariff operations**：Go = 兼容只读视图 + governed write（create / update / delete / clone / enable / disable）。
- **Tariff migrate GET**：`GET /api/tariff-plans/{planId}/migrate` 仅 dry-run，不产生任何资费 / 签约 / 余额 / 审计业务写。
- **Numeric**：OCS 转换已覆盖 int32、int64、float64、Decimal128，含 `0`、`2147483648`、`10737418240`、`9007199254740991`；Decimal128 科学计数法缺陷已修复。
- **Zero / Date / ObjectId**：显式零值不得被 `omitempty` 吞掉；日期与旧实现 ISO 毫秒形式一致；不得暴露 `_id`、`$oid`、driver internals。

### 7.4 Rate Limit

Go limiter：

```text
MongoDB fixed window
xcloud_ops.app_rate_limits
```

必须保持 key、user scope、limit、window、429、`Retry-After`、`X-RateLimit-Limit`、`X-RateLimit-Remaining` 与各端点专属错误文案。

### 7.5 生产注册路由清单

路由权威为源码派生的 Go 注册集合，共 **97 条** METHOD+PATH 精确注册（GET 42 / POST 39 / PUT 7 / DELETE 6 / PATCH 3）：

```text
GET    /api/analytics/metrics
GET    /api/analytics/sparkline
GET    /api/ratings
GET    /api/ratings/{id}
GET    /api/profiles
GET    /api/profiles/{name}
GET    /api/profiles/{name}/stats
GET    /api/profiles/{name}/versions
GET    /api/ocs/balances
GET    /api/ocs/balances/{imsi}
GET    /api/ocs/sessions
GET    /api/ocs/usage
GET    /api/ocs/reservations
GET    /api/ocs/subscribers
GET    /api/tariff-plans
GET    /api/tariff-plans/{planId}
GET    /api/tariff-plans/{planId}/export
GET    /api/tariff-plans/{planId}/operations
GET    /api/tariff-plans/{planId}/rules
GET    /api/tariff-plans/{planId}/subscribers
GET    /api/tariff-plans/{planId}/migrate
GET    /api/subscribers
GET    /api/subscribers/{imsi}
GET    /api/search
GET    /api/auth/me
GET    /api/auth/permissions
GET    /api/auth/users
GET    /api/auth/users/{username}
GET    /api/users
GET    /api/users/{username}
GET    /api/alerts
GET    /api/notifications/stream
GET    /api/system/health
GET    /api/system/mongo/health
GET    /api/system/audit/status
GET    /api/inventory/meta
GET    /api/inventory/resources
GET    /api/inventory/resources/{resourceId}
GET    /api/topology/meta
GET    /api/topology/edges
GET    /api/topology/edges/{edgeId}
GET    /api/topology/resources/{resourceId}/neighbors
POST   /api/auth/login
POST   /api/auth/logout
POST   /api/subscribers
POST   /api/subscribers/batch
POST   /api/subscribers/batch-update
POST   /api/subscribers/batch/precheck
POST   /api/subscribers/bulk-delete
POST   /api/subscribers/import
POST   /api/subscribers/policy
POST   /api/subscribers/{imsi}/profile
POST   /api/subscribers/{imsi}/traffic-adjustments
POST   /api/profiles
POST   /api/profiles/{name}/versions/{versionId}/restore
POST   /api/ratings
POST   /api/ocs/subscribers
POST   /api/ocs/subscribers/{imsi}/suspend
POST   /api/ocs/subscribers/{imsi}/resume
POST   /api/ocs/balances/{imsi}/adjust
POST   /api/ocs/balances/{imsi}/reset
POST   /api/tariff-plans
POST   /api/tariff-plans/import
POST   /api/tariff-plans/{planId}/clone
POST   /api/tariff-plans/{planId}/enable
POST   /api/tariff-plans/{planId}/disable
POST   /api/tariff-plans/{planId}/migrate
POST   /api/tariff-plans/{planId}/rules
POST   /api/users
POST   /api/users/{username}/disable
POST   /api/users/{username}/password-reset
POST   /api/alerts/acknowledge
POST   /api/alerts/workflow
POST   /api/analytics/init
POST   /api/system/audit/scan
POST   /api/system/audit/heal
POST   /api/system/audit/batch-heal
POST   /api/inventory/resources
POST   /api/inventory/resources/{resourceId}/retire
POST   /api/topology/edges
POST   /api/topology/edges/{edgeId}/retire
PUT    /api/subscribers/{imsi}
PUT    /api/profiles/{name}
PUT    /api/ratings/{id}
PUT    /api/tariff-plans/{planId}
PUT    /api/tariff-plans/{planId}/rules/{ruleId}
PUT    /api/inventory/resources/{resourceId}
PUT    /api/topology/edges/{edgeId}
PATCH  /api/users/{username}
PATCH  /api/ocs/subscribers/{imsi}
PATCH  /api/tariff-plans/{planId}/rules/{ruleId}
DELETE /api/subscribers/{imsi}
DELETE /api/profiles/{name}
DELETE /api/ratings/{id}
DELETE /api/ocs/subscribers/{imsi}
DELETE /api/tariff-plans/{planId}
DELETE /api/tariff-plans/{planId}/rules/{ruleId}
```

状态：

```text
Go production API registrations = 97 (route authority: backend/cmd/server/main.go + backend/internal/remediation/handler.go)
Canonical API surface = 33 operations + 2 legacy read aliases
Go-native reads = 2
Node production operations = 0
OCS writes = 13 (tariff plan + subscriber contract + balance)
```

平台服务（11 个端点，全部 Go-owned）：Alerts（`GET /api/alerts`、`POST /api/alerts/acknowledge`、`POST /api/alerts/workflow`）、Notification streaming（`GET /api/notifications/stream`，SSE + ping 心跳 + 零外部 broker）、System health（`GET /api/system/health`、`GET /api/system/mongo/health`，区别于 `/healthz` 与 `/readyz`）、System integrity（`GET /api/system/audit/status`、`POST /api/system/audit/scan`、`POST /api/system/audit/heal`、`POST /api/system/audit/batch-heal`）、Analytics（`POST /api/analytics/init`）。

Inventory 资源模型底座：权威存储 `xcloud_ops.app_inventory_resources`（`xcloud` 中为 0）；6 条 Go 路由；3 条前端 SPA 路由（`/inventory`、`/inventory/{resourceId}`、`/inventory/create`，前端共 28 条规范路由）；读需 `core.read`，写需 `core.configure`；单调递增 `revision` CAS 乐观锁，`retired` 为不可逆终态；仅作资源事实元数据源，不执行远端网络操作。

Topology 依赖模型底座（Stage 2）：权威存储 `xcloud_ops.app_topology_edges`（`xcloud` 中为 0，且不创建 `app_topology_nodes` / `app_topology_vertices` / `app_topology_resources` 任何节点集合）；7 条 Go 路由（4 读 + 3 写）；2 条前端 SPA 路由（`/topology`、`/topology/{resourceId}`）；9 种有向关系类型（`contains`、`runs_on`、`depends_on`、`connects_to`、`routes_to`、`registers_with`、`serves`、`uses`、`exposes`）与 2 种生命周期（`active`、`retired`），由 `GET /api/topology/meta` 权威下发；Inventory 独占节点权威，Topology 仅持久化资源间关系边，端点必须引用已存在且未退役的 Inventory UUID；活动边按 `(fromResourceId, toResourceId, relationshipType)` 部分唯一索引去重，重复创建返回 409，退役后可用新 `edgeId` 重建同一有向组合；`revision` CAS 乐观锁，`retired` 为不可逆终态；仅一跳邻域查询（`inbound` / `outbound` / `both`），不含多跳、自动发现或远端执行能力；读需 `core.read`，写需 `core.configure`。声明式拓扑关系不代表接口真实连通、注册成功或服务健康。权威文档：`docs/architecture/topology-dependency-model.md`；面向未来阶段的 Feature + UI/UX 完成门见 `docs/architecture/stage-feature-ui-acceptance.md`。

### 7.6 订阅者与搜索契约

- `GET /api/subscribers` 模式：`detail=false` → `listSubscriberImsis()`；`detail=true` → `listSubscriberRows()`；`msisdn` 有值 → MSISDN 查找模式。query 别名：`detail`、`page`、`limit`、`q`、`status`、`sortField`、`sort`、`sortDirection`、`sortDir`、`order`、`msisdn`、`excludeImsi`。已知状态：`all`、`active`、`restricted`、`lowTraffic`。不要重新设计校验逻辑。
- MSISDN 未命中时返回 `{"exists": false, "imsi": null, "source": null}`。
- `GET /api/subscribers/{imsi}` 使用 `findSubscriberLegacyState(imsi)`；Go 实现必须复现旧 API 表示，而非原始 xCloud BSON。
- `GET /api/search`：`q.trim()`；query 长度 < 2 → `{"results":[]}`。limit 默认 8、最小 1、最大 12、非法值按 8。订阅者搜索为纯数字 query；Profile 搜索为 `name`/`title` 小写包含。拆分：`subscriberLimit = ceil(limit / 2)`，`profileLimit = limit - subscriberLimit`。顺序：订阅者在前、Profile 在后。返回形状：`id`、`label`、`desc`、`type`、`path`；类型为 `imsi` / `profile`；路径为 `/subscribers`、`/profile`。不要改进排序或重新排名。
- `POST /api/subscribers/batch/precheck`：HTTP = POST，语义读。需 `subscriber_write` 能力，限流键 `subscribers:batch-precheck:{user}`，30/60s；参数 `startImsi`、`count`；溢出报 `IMSI_RANGE_OVERFLOW`。即使只读，权限仍为 `subscriber_write`；不得更改能力或限流键。

### 7.7 订阅者读最小测试集

- 列表：空 / 单条 / 多条、`detail` false/true、`q`、`status`、sort 别名、asc/desc、分页、MSISDN 命中/未命中、`excludeImsi`、非法 MSISDN。
- 详情：命中、非法 IMSI、404、可选字段缺失、完整文档、多 slice、多 session、未知字段、敏感字段行为、Binary/hex 行为。
- 搜索：`q < 2`、纯数字、文本、默认/最小/最大/非法 limit、顺序、形状。
- Precheck：合法、非法 IMSI、非法 count、溢出、权限、限流、无业务写。

---

## 8. 后端工程规范

### 8.1 Go 分层

优先领域式结构：

```text
backend/internal/<domain>/
├── handler.go
├── service.go
├── repository.go
├── model.go
├── dto.go
├── mapper.go
└── *_test.go
```

必须保持：

```text
Handler
  ↓
Service
  ↓
Repository
  ↓
MongoDB
```

禁止 Handler 直接操作 Mongo。不要创建无实现的空 package。

### 8.2 HTTP Method 不等于业务语义

不得简单认为 `GET = read`、`POST = write`。必须沿完整调用链分类：

```text
PURE_READ
INFRA_STATEFUL_READ
PLATFORM_STATEFUL_READ
BUSINESS_STATEFUL_READ
```

例如：`POST /api/subscribers/batch/precheck` 可能是 semantic read，必须审计 repository。所有权以真实副作用为准。

### 8.3 性能

正确性优先，但要检测明显的 N+1。若可避免，不要用逐订阅者的 OCS/Profile 查询替代批量查询。发现索引缺失时报告 `PERFORMANCE_FINDING`；不要在读路径变更中顺带创建索引。

---

## 9. 前端

### 9.1 前端边界

- 不改 SWR API path。
- 不让前端感知 Node/Go owner。
- UI 优化与后端变更分开 commit。
- 用户可见文案同步中英文 locale。
- 前端不持有 API 认证运行时（见 §2.5）。

### 9.2 设计与文案

继续遵守现有 design token：

- 禁止新增硬编码 `#hex` / `rgb()` / `rgba()`。
- 青绿只用于关键交互/信号。
- 状态语义色不混用。
- 4px spacing baseline。

### 9.3 Next.js 已退役

- Next.js 源码与运行时已退役，生产 edge 流量为 0，生产环境不需要 Node 运行时。
- Next.js 业务后端（业务 API handler、业务 repository、业务 Mongo 访问）不存在，**不得重建**。
- 禁止重新引入任何 Node 业务 API handler、业务 repository 或业务 Mongo 访问。
- 禁止用 Next.js 承担 `/api` 转发、rewrite、反向代理或 fallback。

---

## 10. 测试与门禁

前端：

```bash
cd frontend
npm run lint
npm run typecheck
npm test
npm run build
npm run check
```

Go：

```bash
cd backend
gofmt -w .
go test ./...
go test -race ./...
go vet ./...
go build ./...
```

文档与架构门（从仓库根运行）：

```bash
node scripts/test-current-architecture-docs.mjs
node scripts/test-documentation-integrity.mjs
node scripts/test-repository-normalization.mjs
node scripts/test-api-ownership-invariants.mjs
node scripts/test-frontend-runtime-boundary.mjs
node scripts/test-frontend-runtime-dependencies.mjs
node scripts/test-production-architecture.mjs
node scripts/test-agent-docs-parity.mjs
```

有 Node/Go parity 环境时必须运行 compare 工具。环境满足时可运行 `npm run check:full`。

---

## 11. 任务协议

### 11.1 任务开始

从拥有者入口出发，只按真实 import / 调用链扩展。

读侧（Go 后端）：

```text
backend/cmd/server/main.go
backend/internal/remediation/handler.go
backend/internal/subscriber/**
```

UI（规范 React SPA）：

```text
frontend/src/router/**
frontend/src/features/**
frontend/src/lib/**
```

边缘：

```text
deploy/nginx/xcloud.conf
```

开始编码前：读任务 → 读本规则文件 → 查 Git → 定位真实源码 → 建最小调用链 → 识别 security/data/contract 边界 → 再编码。

原则：`VERIFY > GUESS`。禁止猜 collection、route、role、response shape、xCloud schema、side effect。

优先使用：

```bash
rg "<symbol>"
rg "<route>"
rg "<collection>"
git diff
git show
```

### 11.2 任务结束

按 §10 运行对应测试与门禁。完成一个逻辑特性后：

```text
What changed
Contract impact
Security impact
Mongo reads/writes
Validation
Git commit
Working tree
Next blocker
```

### 11.3 上下文预算 (Context Budget)

当前任务上下文只保留：当前 endpoint、当前调用链、当前 contract、当前 tests、当前 diff、当前 blocker。

不要反复重载：全部历史报告、全部 commit、全部 docs、全部 route、全部仓库、CNMS 全仓。

上下文膨胀时建立检查点：

```text
Confirmed
Implemented
Unresolved
Files touched
Tests
Next exact action
```

持久化放置：

```text
Architecture/current ownership → AGENTS.md 与 CLAUDE.md
Current architecture + operations → docs/architecture/, docs/operations/
Stable rules                   → AGENTS.md 与 CLAUDE.md
```

已完成实施计划与验收记录不保留在 HEAD；详细历史证据由 Git 历史保存，`docs/archive/**` 仅保留简明历史摘要。

规则：

```text
Source code is memory.
Git is history.
AGENTS.md is the current map.
CLAUDE.md is the law.
```

---

## 12. Git 协议

任务开始：

```bash
git status
git branch --show-current
git log --oneline -10
```

功能完成后及时 commit，使用 Conventional Commits：

```text
feat(...)
fix(...)
test(...)
docs(...)
chore(...)
refactor(...)
```

示例：

```text
feat(backend): add subscriber read APIs
fix(backend): correct tariff contract parity
test(backend): verify read parity
```

- commit message 必须为一句话概括：仅用单句简洁说明本次变更；禁止长篇描述、多段叙述，禁止在正文使用 bullet 列表。
- 只描述变更内容（what changed），不描述属于哪个生命周期阶段。
- 禁止在 commit message 中出现任何生命周期阶段编号、阶段代号或阶段词样（大小写任意，分隔空格可有可无），亦不得将其用作 Conventional Commits 的 scope 或 subject 组成部分。

明确禁止的提交信息字眼（生命周期阶段用词），以下任意一项均不得出现在 commit message 的任何位置：

```text
phasexxx
Phasexxx
Phase xxx
Px
Px-x
```

- 大小写变体一律禁止（`phasexxx`、`phaseXXX`、`PHASEXXX`、`Phasexxx`、`PHASExxx` 等）。
- 空格变体一律禁止（有无分隔空格均可，如 `phasexxx`、`phase xxx`、`Phase x`、`Px-x`、`P x-x` 等）。
- 不得将上述任一字眼用作 Conventional Commits 的 type、scope，或 subject / body 的任何组成部分。
- 亦不得以任何其他形式引用生命周期阶段、阶段代号或阶段编号。

禁止在 commit message 末尾添加签名行，包括但不限于 `Co-Authored-By: ...`、`Signed-off-by: ...` 及其他 trailer 格式。

未经用户明确要求：

```text
不 push
不 force push
不 rebase public history
不 reset --hard
不丢弃用户修改
不 amend 已推送 commit
```

每个 commit 应满足：

```text
buildable
testable
rollbackable
```

---

## 13. 不可协商项 (Non-Negotiable)

Never:

```text
trust forwarded identity headers
dual-write business mutations
change the Mongo schema
remove unknown xCloud fields
change API paths/SWR paths
introduce a second write owner for a production operation
assume GET is pure
assume POST is write
hard-code API surface counts
claim route ownership from handler existence alone
copy CNMS auth model over subscriber-console
```

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
