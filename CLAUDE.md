# xCloud — Claude Code 项目规则

> 适用于 `subscriber-console` 当前 `develop` 分支长期开发。
> `CLAUDE.md` 只保存稳定规则；当前阶段、已迁接口和下一步放在 `AGENTS.md`。
> 新会话必须先读 `CLAUDE.md`，再读 `AGENTS.md`，然后只读取任务直接相关源码。

## 0. 核心防卫底线 (Core Defensive Constraints)

### 0.1 【编码与字符规范】
- **强制 UTF-8 编码**：程序编码强制默认使用 UTF-8 格式，绝不允许使用 Base64 编码方式混淆或存储代码/配置。
- **纯 ASCII 源码原则**：所有编程语言源码（TypeScript, TSX, Go, JavaScript 等）必须严格遵守“纯 ASCII（纯英文+标准符号）”原则。
- **无 Emoji / 无无关中文**：剔除代码中的所有 Emoji 图标与无关中文，仅保留最纯粹的代码以及必要的中文注释说明（国际化文案存放在 `src/lib/locales/`）。

### 0.2 【接口向前兼容性】
- **全面回顾上下文**：每次更新源码前，必须全面回顾涉及模块的前后依赖与调用上下文。
- **严禁随意删除已有接口**：绝对不能随意删除已有函数接口、API 路由或结构体公共方法！
- **平滑演进与接口升级**：如需功能调整，必须选择在原接口上做向下兼容的参数扩展或创建新接口。
- **依附最新架构框架**：功能模块的升级必须紧密依赖现有的最新内容框架与源码结构进行，严禁“去头掐尾”导致旧功能断裂。

### 0.3 【前端表达规范】
- **专业化工程表述**：在输出修改说明、更新日志、提交记录（Commit Message）或代码注释时，涉及前端开发的变动必须使用严谨、专业的工程化术语（如“DOM 渲染结构优化”、“SWR 客户端状态同步”、“组件样式自适应重构”、“响应式布局与交互对齐”等）。
- **禁用口语化非专业表达**：严禁使用“说明出现在网页前端展示上”、“把字写在网页上”等非专业口语化表述。

## 1. 产品定位

xCloud 是独立的电信运营与核心网运维平台，不是 xCloud 的附属 WebUI。

当前核心域：
- IMSI 签约
- Profile
- OCS
- Tariff / Rating
- 用户管理与认证
- 审计
- 告警
- 系统健康
- 运营分析

### 1.1 运维操作模式 (Operation Model - Phase 5.7-A)

Approval workflow removed from business execution path. Authorization and operation logging remain.
- 授权用户直接执行业务变更操作，即时生效（Direct Execution）。
- 移除阻塞式业务审批工作流，业务操作不再生成 `app_approvals` 记录。
- 严格保留 RBAC 权限检查、操作主体重新鉴权（Fresh Actor Revalidation）、严格操作审计日志（Operation Log / `app_audit_logs`）及 CAS 并发冲突保护。

### 1.2 角色权限模型 (RBAC Model - Phase 5.7-B)

三标准角色模型 (Canonical Three-Role Model)：
- `admin` (管理员): 全系统管理，包含用户管理、角色分配、审批复核/执行、审计导出与完整源 IP 查看、业务直接变更。
- `operator` (操作员): 业务直接变更（签约、余额、Profile 回滚、资费、计费等）、核心网运维与配置，不可管理用户，不可导出审计。
- `viewer` (查看员): 只读查看，所有业务变更与用户管理均拒绝。

向后兼容与运行时归一化：
- 历史角色透明映射：`root` / `super_admin` → `admin`，`ops_admin` → `operator`，`auditor` → `viewer`。
- 写入边界：用户创建与角色更新仅接受 `['admin', 'operator', 'viewer']`，写入历史角色直接返回 HTTP 400 `INVALID_ROLE`。
- UI 下拉选项严格展示三标准角色。

### 1.3 Auth & User Management Architecture (Phase 6.0 Freeze)

架构冻结文档：`docs/architecture/phase-6-auth-architecture.md`。

稳定边界：
- 用户集合：`xcloud_ops.app_users` 为唯一权威用户存储，禁止复制到其他集合。
- 新用户仅接受 `admin` / `operator` / `viewer` 三标准角色。
- 会话失效机制：`security.sessionVersion++`（密码/角色/状态变更时强制递增）。
- 删除策略：不硬删除用户，使用 `status=disabled`（保留操作溯源能力）。
- 认证链：`auth_token` cookie → HS256 JWT → `app_users` 校验 → Principal；Node 与 Go 独立验签。
- 禁止引入：IAM 框架、OAuth、SSO、LDAP、MFA、多租户隔离、策略引擎。
- 禁止触碰：OCS 业务逻辑、`CUTOVER_TABLE`、`ACTUALLY_ROUTED = 26`、charging plane。

运维模型文档：
- `docs/operations/authentication-model.md`
- `docs/operations/user-management-model.md`

长期演进：
- EPC / 5GC / IMS 网元管理
- 信令追踪、HEP/HOMER
- 告警关联、RCA、AIOps
- CNMS 能力集成

xCloud 只是当前兼容数据层之一。

## 2. 当前目标架构

```text
Browser
   |
   v
Nginx
   |-----------------------------|
   v                             v
Next.js :13333                Go :18888
UI / Rendering               Business API
Legacy writes during         Auth validation
migration                    Read migration
   |                             |
   +-------------+---------------+
                 |
                 v
              MongoDB
```

最终目标：

```text
Browser -> Nginx
           ├─ /*      -> Next.js :13333
           └─ /api/*  -> Go :18888
```

当前仍是渐进迁移：
- Next.js 保留前端。
- Go Backend 位于 `backend/`。
- API 路径保持 `/api/...` 不变。
- 前端 SWR 不感知 Node/Go ownership。
- 禁止一次性将整个 `/api/*` 切到 Go。

### 2.1 OCS 生产冻结规范 (OCS Management Plane Freeze)

OCS Management Plane is frozen.
Managed domains:
- Tariff Plans
- Contract Subscribers
- Balance Management

Charging Plane remains frozen and excluded.

- 资费计划 (`ocs_tariff_plans`, `/ocs/tariffs`)、签约合同 (`ocs_subscribers`, `/ocs/contracts`)、余额管理 (`ocs_balances`, `/ocs/balances`) 生产基线永久冻结。
- 严禁向 OCS 管理平面添加新业务能力或重新设计架构。
- 严禁引入或耦合运行时计费面实体（`ocs_sessions`, `ocs_reservations`, `ocs_usage_records`, `ocs_events`, `ocs_config`, Gy/Ro/CCR/CCA 协议栈）。
- 路由表 `ACTUALLY_ROUTED = 26` 严格保持不变。

## 3. 技术栈

### Frontend / Legacy Backend

- Next.js 16.2.2 App Router
- React 19.2.4
- TypeScript 5.x
- Tailwind CSS 4
- SWR
- Recharts
- Lucide React
- MongoDB Node Driver 7.x
- jose 6.x
- bcryptjs
- Node 20 (`.nvmrc`)
- `next.config.ts` 已启用 `output: 'standalone'`

### Go Backend

- Go 1.24+
- 标准库 `net/http`
- modern ServeMux method/path routing
- `log/slog`
- `mongo-driver/v2`
- 不使用 Gin / Fiber / Echo
- 不使用 GORM

### MongoDB

同一 Mongo URI 下：

```text
xcloud
xcloud_ops
```

Go 必须采用：

```text
one mongo.Client
+ xcloud database handle
+ xcloud_ops database handle
```

除非未来真实配置变成两个不同 URI，否则不要创建两个 client。

## 4. Source of Truth

冲突时优先级：

```text
1. 当前运行源码
2. 自动化测试
3. 冻结 API Contract / migration inventory
4. AGENTS.md
5. docs/operations/deployment.md
6. docs/operations/dev-log.md
7. README / 旧设计文档
8. 注释
```

如果文档与源码冲突：
1. 不猜。
2. 读取真实调用链。
3. 记录差异。
4. 以当前 observable behavior 为迁移基线。
5. 必要时修正文档。

禁止为了“让文档正确”而改业务源码。

## 5. AI 上下文加载规则

### 会话开始

只先读：

```text
CLAUDE.md
AGENTS.md
```

然后：

```bash
git status
git branch --show-current
git log --oneline -10
```

仅当任务涉及迁移时，再按需读：

```text
docs/backend-migration/README.md
docs/backend-migration/migration-routing-matrix.md
```

### 禁止无目的全库扫描

不要在任务开始时：
- `cat` 整个仓库
- `find .` 全量展开
- 读取全部 docs
- 读取全部 route/repository/test
- 读取 CNMS 全仓

优先：

```bash
rg "<symbol>"
rg "<route>"
rg "<collection>"
git diff
git show
```

原则：

> 先定位，再读取；先调用链，再扩展。

### Context Budget

当前任务上下文只保留：
- 当前 phase
- 当前 endpoint
- 当前调用链
- 当前 contract
- 当前 tests
- 当前 diff
- 当前 blocker

上下文膨胀时：
1. 总结已确认事实。
2. 架构级事实更新 `AGENTS.md`。
3. 历史写 `docs/operations/dev-log.md`。
4. 待办写 `docs/operations/todo.md`。
5. 下一会话从 `CLAUDE.md + AGENTS.md` 重建上下文。

## 6. 文档职责

### CLAUDE.md
只放：
- 架构原则
- 安全边界
- Git 规则
- 编码规范
- 迁移禁止项
- 测试门槛

### AGENTS.md
只放：
- 当前架构
- 当前阶段
- 当前 ownership
- 当前关键 contract
- 当前风险
- 下一阶段入口

必须短、准、可覆盖。

### docs/operations/dev-log.md
只放历史增量：
- 阶段完成
- commit
- 重要 bug / 修复
- 关键结论

### docs/operations/todo.md
只放：
- 当前任务
- blocker
- deferred
- 风险

## 7. 迁移原则

必须遵循：

```text
Contract First
Read First
Governance Before Write
Single Writer
Route-by-Route Cutover
Easy Rollback
```

禁止：
- Node + Go 双写同一业务 mutation。
- 同一 mutation 两个 authoritative implementation。
- 改 API path 来迁移。
- 改 Mongo schema 来迁移。
- 一次性重写全部 Next API。
- 整仓吸收 CNMS。

允许：
- pure read shadow compare。
- route-by-route parity。
- Go read implementation 与 Node read 同时存在，但生产只有一个 owner。
- `app_rate_limits` 作为 Phase 2 基础设施写。

## 8. HTTP Method 不等于业务语义

不得简单认为：

```text
GET = read
POST = write
```

必须沿完整调用链分类：

```text
PURE_READ
INFRA_STATEFUL_READ
PLATFORM_STATEFUL_READ
BUSINESS_STATEFUL_READ
```

例如：
- `GET /api/audit/export` 会写审计证据，不是 pure read。
- `POST /api/subscribers/batch/precheck` 可能是 semantic read，必须审计 repository。

phase ownership 以真实副作用为准。

## 9. Go Backend 分层

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

禁止 Handler 直接操作 Mongo。
不要创建无实现的空 package。

## 10. API Contract

迁移必须保持：
- method
- path
- query aliases
- request body
- status
- response shape
- `null`
- missing
- `[]`
- `0`
- sort
- pagination
- headers
- permissions
- rate limit
- error code/message
- export filename/MIME

禁止趁迁移 redesign。

Go 特别注意：
- int64
- Decimal128
- ObjectId
- time.Time
- nil slice
- `omitempty`
- Binary/Buffer

必须通过 mapper + contract tests 控制。

## 11. xCloud BSON 兼容

xCloud document 高度 schema-sensitive。

读取时允许：

```text
bson.M
bson.Raw
```

再显式映射 API DTO。

禁止：
- 未证明 schema 时巨大 struct 强 decode 全文档。
- 删除未知字段。
- 修改 nested slice/session/security/ambr。
- 改字段名/字段类型。
- 把 API 语言迁移变成 DB schema migration。

## 12. Auth 安全边界

当前兼容链：

```text
auth_token cookie
  ↓
HS256
  ↓
username / role / sv / exp
  ↓
xcloud_ops.app_users
  ↓
enabled / locked / sessionVersion / role consistency
```

Go 必须自己认证。

禁止信任以下 header 为最终身份：

```text
x-user
x-user-role
x-user-id
x-user-session-version
```

当前重要语义：
- Node `jose` token → Go verifier interoperability 已验证。
- legacy `root` role 按当前 Node 行为规范化。
- `app_users` 在 Phase 2 只读。
- login/logout 未迁移前仍由 Node owns。

## 13. Permission

每个迁移接口必须检查原 Node：

```text
requireAuth
requireCapability
requirePermission
```

Go 必须复制 observable permission contract。

不要用 CNMS RBAC 替换 subscriber-console 规则。

## 14. Rate Limit

当前 Go limiter：

```text
MongoDB fixed window
xcloud_ops.app_rate_limits
```

必须保持 Node：
- key
- user scope
- limit
- window
- 429
- Retry-After
- X-RateLimit-Limit
- X-RateLimit-Remaining
- endpoint-specific error text

Phase 2 报告必须写：

```text
Business-domain writes by Go = NONE
Infrastructure writes = app_rate_limits
```

不要写 `Go writes NONE`。

## 15. Governance / Write 边界

最终写链：

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

write migration 前禁止：
- 提前复制半套 Governance。
- Go 成为新 policy authority。
- 绕过 Approval。
- Handler 直接写 DB。

Phase 2 除 `app_rate_limits` 外不得写：
- `xcloud.subscribers`
- `xcloud.ocs_*`
- `xcloud_ops.app_profiles`
- `xcloud_ops.app_profile_versions`
- `xcloud_ops.app_ratings`
- `xcloud_ops.app_users`
- `xcloud_ops.app_approvals`
- `xcloud_ops.app_audit_logs`

## 16. CNMS 复用

CNMS 是参考仓库，不是合并目标。

可参考：
- config
- Mongo connect/ping/close
- middleware
- WebSocket
- HEP
- signaling correlation
- capture
- monitoring
- AIOps

不要直接复制：
- CNMS JWT/Bearer auth
- CNMS RBAC
- CNMS one-database Mongo wrapper
- CNMS response envelope

subscriber-console contract/session semantics 优先。

## 17. Routing

必须区分：

```text
IMPLEMENTED
PARITY_PASS
CUTOVER_READY
ACTUALLY_ROUTED
```

Go Handler 存在 != 生产已切流。

禁止仅按 `/api/subscribers/` prefix 整体送 Go，因为同 prefix 下仍有写 API。

## 18. Frontend / Design

- 不改 SWR API path。
- 不让前端感知 Node/Go owner。
- UI 优化与 backend migration 分开 commit。
- 用户可见文案同步中英文 locale。

设计继续遵守现有 token：
- 禁止新增硬编码 `#hex` / `rgb()` / `rgba()`。
- 青绿只用于关键交互/信号。
- 状态语义色不混用。
- 4px spacing baseline。

## 19. Next.js

涉及 Next 16 App Router/runtime 行为时，先读：

```text
node_modules/next/dist/docs/
```

不要凭旧版 Next.js 记忆实现。

## 20. 测试

### Node

```bash
cd frontend
npm run lint
npm run typecheck
npm test
npm run build
npm run check
```

环境满足时：

```bash
npm run check:full
```

### Go

```bash
cd backend
gofmt -w .
go test ./...
go test -race ./...
go vet ./...
go build ./...
```

### Migration

```bash
# Run from repo root
node scripts/migration/inventory-api.mjs
node scripts/migration/validate-inventory.mjs
```

有 Node/Go parity 环境时必须运行 compare 工具。

## 21. Validator

Migration validator 必须：
- source-derived
- 不硬编码 migrated count
- 检测 phantom/missing route
- Go router ↔ matrix cross-check
- canonicalize dynamic paths
- 501 placeholder 不算 migrated

禁止：

```js
const EXPECTED_MIGRATED = 21
```

## 22. Git

任务开始：

```bash
git status
git branch --show-current
git log --oneline -10
```

功能完成后及时 commit。

Conventional Commits：

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
feat(backend): migrate subscriber read APIs
fix(backend): correct tariff contract parity
test(migration): verify read parity
```

禁止在 commit message 中包含阶段编号（如 Phase 2A、Phase 1、2C.1）。
Commit 只描述变更内容，不描述属于哪个阶段。

禁止在 commit message 末尾添加签名行，包括但不限于：
- `Co-Authored-By: ...`
- `Signed-off-by: ...`
- 其他 trailer 格式

未经用户明确要求：
- 不 push
- 不 force push
- 不 rebase public history
- 不 reset --hard
- 不丢弃用户修改
- 不 amend 已确认历史阶段 commit

每个 commit 应：

```text
buildable
testable
rollbackable
```

## 23. 文档更新

仅在确有变化时更新：

```text
AGENTS.md
docs/operations/dev-log.md
docs/operations/todo.md
docs/architecture/
docs/api/
docs/operations/deployment.md
```

只有这些变化需要更新 `AGENTS.md`：
- ownership 改变
- phase 完成
- 安全边界改变
- 核心数据流改变
- blocker 改变
- 重要 contract 结论改变

不要把普通 bug fix 都塞进 AI_CONTEXT。

## 24. AI 开发行为

开始编码前：
1. 读任务。
2. 读 CLAUDE.md。
3. 读 AGENTS.md。
4. 查 Git。
5. 定位真实源码。
6. 建最小调用链。
7. 识别 security/data/contract 边界。
8. 再编码。

原则：

```text
VERIFY > GUESS
```

禁止猜：
- collection
- route
- role
- response shape
- xCloud schema
- migration phase
- side effect

## 25. 阶段输出

至少报告：

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

Migration 额外报告：

```text
Implemented
Parity Passed
Actually Routed
Deferred
```

四者不得混用。

## 26. 当前阶段

当前迁移状态、ownership 和下一阶段入口全部见：

```text
AGENTS.md
```

不要把阶段日志继续堆进本文件。
