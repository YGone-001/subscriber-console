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
Read + write APIs (159 exact METHOD+PATH registrations)
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
- Next.js 源码已退役，原 Next.js 端口重新分配给 Vite 本地开发（`0.0.0.0:13333`）；生产 edge 流量为 0，生产环境不需要 Node 运行时。
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
Go registration set                  = 159
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
- Topology / Dependency Model Foundation = IMPLEMENTED（Inventory 独占节点权威，Topology 仅持久化关系边）。
- Operational Overview / Network Element Management = IMPLEMENTED（CNMS 启发、xCloud 原生：仪表盘新增运维总览区段（域分组、资源汇总、L1/L2/L3 覆盖、诚实的完整性标记），`/inventory` 新增网元视图（域/种类/监测状态筛选、搜索、游标分页、层级树与虚拟域分组回退）；身份仅用规范 `resourceId` 连接，绝不使用进程名/主机名/IP 推断；CNMS 的部署模板、MML/重启、日志流、业务指标与站点 CRUD 一律排除；CPU 累计计数器绝不显示为百分比，缺失指标显示为不可用而非 0；关联完整性铁律：监测关联仅由 `GET /api/nf-health/targets?resourceIds=`（≤50 个规范 UUID，去重、拒绝空/畸形/超限、禁止与 cursor/q/enabled/limit 组合，单次有界索引查询）权威解析，绝不从未相关游标页推断缺失，未解析（unresolved）绝不计入未纳管（unmonitored）；完整性按来源分维度（inventory/monitoring/telemetry/topology）独立报告，任一不可用即整体不可用，部分页绝不作为平台总量；NF 人口仅含 `network_function`/`network_function_instance`（其余种类单列 nonNfResources，绝不抬高 NF 计数），逻辑网元与实例分母分开；拓扑关系仅用 `contains` 边并有界游标分页（超界标 partial，读取失败标 unavailable），虚拟分组按确定性区分三种文案，绝不宣称不存在包含关系；`statusComplete` 描述读取成功而非证据存在（无历史样本的新目标是已配置未测量，不是读取失败）；服务端筛选变更重置游标/历史/树选择。权威文档：`docs/architecture/operational-overview.md`）。
- UE 信息 / EPC-5GC 在线用户 = IMPLEMENTED（只读 `GET /api/ue-info` + `/ue-info` 页面；源清单 `UE_INFO_SOURCES` 仅接受 mme/amf/smf host:port，固定 GET 路径、禁止重定向、超时与响应体有界；MME/AMF UE 列表与 SMF PDU 会话按 SUPI 合并、PDN 去重，MSISDN 由 xCloud subscribers 单次有界查询补充；SMF `ues_active` 经 NF Health 注册表/解析器读取，缺失/失败为 null 绝不补零；来源状态 ok/unavailable/not_configured/invalid_config 与 complete 显式返回；IMS 在线用户与 HSS SIP 本期未接入并显式不可用；读需 core.read，限流 120/60s，无写、无任意 URL/SQL；前端 `/ue-info` 为规范路由，运维总览使用 `?summary=1`。权威文档：`docs/architecture/ue-info.md`）。
- 知识库 Knowledge Base = IMPLEMENTED（故障现象、根因与处置方案的沉淀/检索/编辑；条目存于 `xcloud_ops.app_knowledge_entries`，附件元数据存于 `app_knowledge_files`，附件字节落本地磁盘（`KNOWLEDGE_UPLOAD_DIR` + `.trash` 软删）；搜索转义 + 有界输入、游标分页、CAS revision、`core.read`/`core.configure` 权限门、端点级限流与 best-effort 审计；附件魔数+扩展名双重校验，拒绝 SVG/HTML/可执行，下载带 nosniff/ETag/private；Markdown 不渲染原始 HTML，链接/图片白名单。权威文档：`docs/architecture/knowledge-base.md`）。
- Discovery / NF Observation Foundation = IMPLEMENTED（只读 NRF 观测，绝不推断缺失，绝不自动写 Inventory/Topology）。
- NF Health / Telemetry Foundation = IMPLEMENTED（只读三层测量证据，采集器固定类型 + 默认拒绝白名单，样本 TTL 仅作用于样本集合；Inventory 权威身份统一，支持 EPC/5GC/IMS/charging 资源原生目标与可选 Discovery 候选关联；跨域指标适配为证据驱动：EPC/5GC 已实测核验、charging 仅源码核验、IMS 无指标导出器，L3 服务健康仅由登记规则判定且进程遥测永不建立服务健康）。
- Runtime discovery / CNMS process compatibility = IMPLEMENTED（只读本地 /proc 扫描，24 个 CNMS 兼容组件 + 2 个 xCloud 专有身份（seppd/smscd）共 26 条识别项，由单一中央识别权威定义并被扫描器、API 投影与前端状态模型共同复用；状态语义以证据为准：仅正向验证的进程报告 running，`comm` 精确匹配 + `/proc/<pid>/exe` 身份校验（可执行文件基名必须精确等于组件进程名，registry 不设别名/同义词表——曾用 `kamailio` 别名放宽已按运营决定撤销：共享二进制按角色改进程标题的装法必须不显示，这正是暴露打包错误的信号，且 NF Health L1 巡检本就严格同名，两个身份权威对同一 PID 绝不允许结论相左；安装路径自由，基名不行） + 进程启动标识防 PID 复用，扫描不完整时缺失只报告 unknown 而绝不报告 stopped，从未观测的组件报告 not_detected；CPU 仅由真实采样区间差值计算（累计 CPU 时间绝不显示为百分比），内存为已验证进程组聚合且缺失测量不显示为 0；Java IMS HSS 采用「可执行文件校验 + 已批准启动标识位置」双重判定，歧义候选保持 unverified，原始命令行永不返回或持久化；纳管走受控预览/批准流程（`POST /api/runtime/bootstrap/preview`、`apply`），资源以 `source.kind=discovered` 的服务器权威来源创建、生命周期为 planned（PID 存在不等于 active），动态进程绑定持久化于 `xcloud_ops.app_nf_health_bindings`（静态配置优先、冲突拒绝、重启后继续调度 L1 采集）；监测资格与可纳管性是两件事：`monitoring_not_supported` 只否决 NF Health 目标与进程绑定，是否进入 Inventory 由 registry 的 `adoptable` 决定；DRA 作为无 NF 类型声明的支撑组件不可纳管，IMS HSS 可纳管为 `ims/hss` 资源但因 `java` 启动器无法界定进程绑定作用域而不建目标（缺失测量记为 unknown，绝不伪造）；观测层级（主机/域/组件）不落拓扑边，绝不伪造 SIP/Diameter/PFCP/SBI 连接。权威文档：`docs/architecture/runtime-discovery.md`）。
- Assurance correlation / RCA / AIOps / multi-hop analysis = 未实施。
- 长期演进权威文档：`docs/architecture/architecture-evolution-roadmap.md`；在其实施阶段开始前，不得当作运行时部署指令。
- 长期方向：模块化运维平台（inventory / topology、workflow、assurance、telemetry、厂商中立 adapter 边界）。逻辑边界先于部署拆分；仅在规模、故障隔离、运维归属或可用性要求时才引入独立服务。

### 2.4 本地全栈访问契约

生产浏览器访问始终从 Nginx 边缘进入；本地开发由 Vite 开发服务器提供。

```text
Default local production URL: http://localhost
Custom edge port:             http://localhost:<edge-port>   (production: sudo ./deploy/nginx/setup.sh <port>)
Local development URL:        http://localhost:13333
LAN development URL:          http://<host-lan-ip>:13333     (same-subnet client)
```

- Vite 开发服务器 `0.0.0.0:13333`（LAN-reachable，strictPort）将 `/api/*` 代理至 Go `127.0.0.1:18888`。
- Vite 绑定 `0.0.0.0` 仅影响开发传输层：同网段客户端可经主机局域网地址访问开发服务及其 `/api` 反代。
- Go `127.0.0.1:18888` 仍为 loopback-only 内部 API 端点，不作为浏览器直接页面访问地址，也不对局域网暴露。
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

- 权威基线：OCS 管理平面生产冻结基线；当前生产路由 = Go 全部接管，**共 159 条 Go 注册**。
- 路由权威来源：Go 注册集合（`backend/cmd/server/main.go` + `backend/internal/remediation/handler.go`，159 条 METHOD+PATH 精确注册）；Nginx 负责 API 路由。
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
Route authority = the derived Go registration set (159 exact METHOD+PATH registrations).
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

路由权威为源码派生的 Go 注册集合，共 **159 条** METHOD+PATH 精确注册（GET 78 / POST 55 / PUT 13 / DELETE 10 / PATCH 3）：

```text
GET    /api/analytics/metrics
GET    /api/analytics/sparkline
GET    /api/ratings
GET    /api/ratings/{id}
GET    /api/profiles
GET    /api/profiles/meta
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
GET    /api/topology/live
GET    /api/topology/edges
GET    /api/topology/edges/{edgeId}
GET    /api/topology/resources/{resourceId}/neighbors
GET    /api/discovery/meta
GET    /api/discovery/sources
GET    /api/discovery/sources/{sourceId}
GET    /api/discovery/runs
GET    /api/discovery/runs/{runId}
GET    /api/discovery/candidates
GET    /api/discovery/candidates/{candidateId}
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
POST   /api/discovery/sources
POST   /api/discovery/sources/{sourceId}/scan
POST   /api/discovery/candidates/{candidateId}/link
POST   /api/discovery/candidates/{candidateId}/unlink
PUT    /api/subscribers/{imsi}
PUT    /api/profiles/{name}
PUT    /api/ratings/{id}
PUT    /api/tariff-plans/{planId}
PUT    /api/tariff-plans/{planId}/rules/{ruleId}
PUT    /api/inventory/resources/{resourceId}
PUT    /api/topology/edges/{edgeId}
PUT    /api/discovery/sources/{sourceId}
PATCH  /api/users/{username}
PATCH  /api/ocs/subscribers/{imsi}
PATCH  /api/tariff-plans/{planId}/rules/{ruleId}
DELETE /api/subscribers/{imsi}
DELETE /api/profiles/{name}
DELETE /api/ratings/{id}
DELETE /api/ocs/subscribers/{imsi}
DELETE /api/tariff-plans/{planId}
DELETE /api/tariff-plans/{planId}/rules/{ruleId}
GET    /api/nf-health/meta
GET    /api/nf-health/targets
GET    /api/nf-health/targets/{targetId}
GET    /api/nf-health/targets/{targetId}/history
GET    /api/nf-health/samples
GET    /api/nf-health/runs
GET    /api/nf-health/runs/{runId}
POST   /api/nf-health/targets
PUT    /api/nf-health/targets/{targetId}
POST   /api/nf-health/targets/{targetId}/collect
GET    /api/runtime/meta
GET    /api/runtime/observations
GET    /api/runtime/stream
POST   /api/runtime/scan
POST   /api/runtime/bootstrap/preview
POST   /api/runtime/bootstrap/apply
GET    /api/nf-alerts/meta
GET    /api/nf-alerts
GET    /api/nf-alerts/rules
GET    /api/nf-alerts/rules/{ruleId}
POST   /api/nf-alerts/rules
PUT    /api/nf-alerts/rules/{ruleId}
DELETE /api/nf-alerts/rules/{ruleId}
POST   /api/nf-alerts/{alertId}/acknowledge
POST   /api/nf-alerts/{alertId}/resolve
GET    /api/operations/summary
GET    /api/ue-info
```

状态：

```text
Go production API registrations = 159 (route authority: backend/cmd/server/main.go + backend/internal/remediation/handler.go)
Canonical API surface = 33 operations + 2 legacy read aliases
Go-native reads = 2
Node production operations = 0
OCS writes = 13 (tariff plan + subscriber contract + balance)
```

平台服务（11 个端点，全部 Go-owned）：Alerts（`GET /api/alerts`、`POST /api/alerts/acknowledge`、`POST /api/alerts/workflow`）、Notification streaming（`GET /api/notifications/stream`，SSE + ping 心跳 + 零外部 broker）、System health（`GET /api/system/health`、`GET /api/system/mongo/health`，区别于 `/healthz` 与 `/readyz`）、System integrity（`GET /api/system/audit/status`、`POST /api/system/audit/scan`、`POST /api/system/audit/heal`、`POST /api/system/audit/batch-heal`）、Analytics（`POST /api/analytics/init`）。

运维总览统计端点：`GET /api/operations/summary`（Go-owned，读需 `core.read`，限流 120/60s per user）。`sections` 参数按需选择 `inventory`/`discovery`/`health`/`alerts`/`topology`（逗号分隔，缺省全部；未知或重复 section 返回 400 `INVALID_SECTION`）；未请求的分区不查询。每个分区返回全量集合统计（`scope=full_collection`，绝不受列表 limit/cursor 影响）与 `completeness`（`complete`/`unavailable`）；单一来源失败仅将对应分区标为 `unavailable`（错误码 `SECTION_UNAVAILABLE`），其余分区正常返回，绝不整体失败。统计落在各域 repository 的有界聚合查询（inventory 按种类/生命周期/域分组、discovery 观测状态与关联分布、health 目标 freshness/overall/层状态分布（与列表投影同语义）、alerts 状态/严重度分布与启用规则数、topology 声明边按生命周期与关系类型分布），不新建集合、无业务写。健康分区中"已配置未测量"的目标计入 `unknown`，绝不假定为健康；累计计数器绝不显示为百分比；缺失统计显示为不可用而非 0。

Inventory 资源模型底座：权威存储 `xcloud_ops.app_inventory_resources`（`xcloud` 中为 0）；6 条 Go 路由；3 条前端 SPA 路由（`/inventory`、`/inventory/{resourceId}`、`/inventory/create`，前端共 41 条规范路由）；读需 `core.read`，写需 `core.configure`；单调递增 `revision` CAS 乐观锁，`retired` 为不可逆终态；仅作资源事实元数据源，不执行远端网络操作。

NF 发现观测底座（只读）：权威存储 `xcloud_ops.app_discovery_sources` + `xcloud_ops.app_discovery_runs` + `xcloud_ops.app_nf_observations`（共 3 个集合，`xcloud` 中为 0）；12 条 Go 路由（7 读 + 5 写）；2 条前端 SPA 路由（`/discovery`、`/discovery/sources/{sourceId}`）；适配器类型权威值为 `nrf`，目标必须命中后端默认拒绝白名单 `DISCOVERY_ALLOWED_TARGETS`，仅允许有界只读 GET；观测状态 `seen`/`missing`/`stale` 与注册状态、运行健康、Inventory 生命周期严格分离，失败或截断扫描绝不推断缺失；link/unlink 仅写发现侧元数据，绝不创建或修改 Inventory 资源，绝不自动生成 Topology 边；读需 `core.read`，写需 `core.configure`。权威文档：`docs/architecture/nf-discovery.md`。

NF 健康遥测底座（只读）：权威存储 `xcloud_ops.app_nf_health_targets` + `xcloud_ops.app_nf_health_runs` + `xcloud_ops.app_nf_health_samples`（共 3 个集合，`xcloud` 中为 0）；10 条 Go 路由（7 读 + 3 写）；2 条前端 SPA 路由（`/nf-health`、`/nf-health/{targetId}`，前端共 41 条规范路由）；三层测量证据（L1 进程/实例、L2 接口/端点、L3 服务 KPI），状态 `healthy`/`degraded`/`unhealthy`/`unknown`/`not_configured`/`stale`，NRF REGISTERED 不等于进程健康、metrics HTTP 200 不等于 SBI/PFCP/NGAP/Diameter/SIP 健康、进程 active 不等于会话成功、缺失指标绝不补零、采集失败绝不覆盖最后一次有效测量；Inventory 为唯一权威资源来源：目标通过 `resourceId` 引用 Inventory `network_function`/`network_function_instance`（不得退役），`domain`/`nfType` 为服务端推导投影，客户端 `domain`/`nfType` 字段一律拒绝；网络域支持 `epc`/`5gc`/`ims`/`charging`，NF 类型由显式 Inventory `role` 解析；Discovery `candidateId` 为可选关联，双 id 时候选必须显式链接同一资源且类型兼容，绝不伪造候选、绝不静默链接；身份态 `inventory_authoritative`/`legacy_unbound`/`legacy_unresolved`；目标唯一性为候选/资源双部分唯一索引（`uniq_nf_health_target_candidate`、`uniq_nf_health_target_resource`），同缺失候选不碰撞、同一资源一个逻辑目标；采集器类型 `http_metrics` + `process_only`（仅本地 L1，不发 HTTP，L2/L3 恒 `not_configured`，本地归属需服务端绑定 `NF_HEALTH_LOCAL_PROCESS_BINDINGS`，缺失/不匹配即失败关闭）；采集准入按工作类别分预算：可能发起 HTTP 的采集受全局 2 并发约束，`process_only`（可证明零出口）走独立 32 并发预算，两类互不占用，故数十个 120s 目标不会因排队长期 `stale` 而使其名义间隔与新鲜度投影不自洽；目标命中默认拒绝白名单 `NF_HEALTH_ALLOWED_TARGETS`，服务单元命中 `NF_HEALTH_SERVICE_UNITS`，仅 `systemctl show` 或只读 `/proc` 巡检（精确进程名 + `/proc/<pid>/exe` 身份校验，不可验证即 `unverified`→`unknown`），禁止 sudo、禁止任意命令执行；22 个受控进程→NF 类型映射（5GC 12 / EPC 5 / charging 1 / IMS 4）；绝不自动创建目标、绝不写 Inventory/Topology/Discovery 字段；退役资源拒绝新建目标并阻断采集但保留历史证据；身份完整性在创建、更新、采集、遗留迁移全路径强制：更新路径以"存储身份不可变 + 存储采集配置生效"校验有效目标（process_only 不得失去/停用/改指/改型其授权检查源，不得引入指标端点，校验失败零写入），采集前对当前权威 Inventory 资源复验（缺失/退役/类型不支持/域变更/角色变更/绑定失效一律失败关闭并返回确定性错误，不落样本、不宣称健康、不改写身份），进程绑定还须与资源网络域及网元类型兼容（`NF_HEALTH_PROCESS_NF_TYPE_INCOMPATIBLE`/`NF_HEALTH_PROCESS_DOMAIN_INCOMPATIBLE`），遗留回填同样校验候选观测类型且为 revision 绑定条件更新、冲突显式上报；跨域指标适配（证据驱动）：注册表为服务端独占，每条指标族携带 `domain`/`category`(resource|service)/`source`(厂商中立 `nf_metrics_exporter`)/`evidence`(live_verified|source_verified|fixture_tested|not_verified|not_exported)/`healthRule`/`nonNegative`；域与 NF 类型双重过滤，异构域/异构网元指标绝不改标签归属，指标自带 `nfType` 标签绝不作为身份权威；通用进程遥测（`process_*`，category=resource）永不建立 L3 服务健康，仅资源指标时 L3 为 `unknown`+`resource_metrics_only` 且保留实测覆盖；服务健康判定以证据强度为界（无任意阈值、无区间证据不判定）：累计计数器（`failure_counter_zero`/`success_ratio_pair`）为历史累计总量，绝不解释为当前区间结果 → 一律 `unknown`+`service_health_undetermined` 且原始计数保留（历史失败不再永久降级、历史零失败不证明当前成功）；活动类 gauge（`activity_gauge`，如活动会话/注册用户/PFCP 会话/接入节点）只证明活动存在 → `unknown`+`activity_observed`，零值不等于故障；确认/降级（`service_health_confirmed`/`service_failures_observed`）保留给未来经显式验证的区间规则；序列配对须同族单序列且清洗后 scope 签名一致，跨 scope/跨资源/标签被清洗后塌缩的序列一律禁止配对；解析器以注册表为类型权威，`# TYPE` 与注册类型不符即确定性丢弃（计数为 type mismatch，绝不把 counter 当 gauge 或反之）；总体状态为顺序无关的强度优先级（unhealthy > degraded > stale > unknown > healthy，未测量层不参与且不假定健康），陈旧/未知新鲜度绝不投影为健康；计数类指标拒绝负值（实测发现导出器可返回负会话数），缺失指标绝不补零、绝不合成百分比或速率；22 进程遥测能力矩阵：5GC AMF/SMF/UPF/PCF 与 EPC MME/HSS/PCRF 为 live_verified（实测端点 127.0.0.2/4/5/7/8/9/13:9090），charging OCS 为 source_verified（参考部署未启用其指标监听），5GC NRF/AUSF/UDM/UDR/BSF/NSSF/SCP/SEPP、EPC SGW-C/SGW-U 与全部 IMS 网元 not_exported（无 HTTP 指标导出器，保持 L1/L2 且 L3 显式不可用）；标签策略仅保留 `nf`/`nftype`/`nf_type`/`function`/`instance`，丢弃订阅者/会话/对端地址/切片标识（含 `plmnid`/`snssai`），故不注册逐对端族；端点信任边界：允许清单与 Inventory 归属提供归属证明，传输层不提供网元密码学认证；样本 TTL 仅作用于 `app_nf_health_samples`（默认 7 天、上限 30 天）；读需 `core.read`，写需 `core.configure`。权威文档：`docs/architecture/nf-health-telemetry.md`。

Topology 依赖模型底座（Stage 2）：权威存储 `xcloud_ops.app_topology_edges`（`xcloud` 中为 0，且不创建 `app_topology_nodes` / `app_topology_vertices` / `app_topology_resources` 任何节点集合）；8 条 Go 路由（5 读 + 3 写）；2 条前端 SPA 路由（`/topology`、`/topology/{resourceId}`）；9 种有向关系类型（`contains`、`runs_on`、`depends_on`、`connects_to`、`routes_to`、`registers_with`、`serves`、`uses`、`exposes`）与 2 种生命周期（`active`、`retired`），由 `GET /api/topology/meta` 权威下发；`GET /api/topology/live` 为只读运行时投影：节点来自当前 runtime 快照，链路仅来自运维人员提供的 `NF_ETC_MANIFEST` 中每网元绝对配置路径的显式对端配置（Open5GS YAML / freeDiameter / IMS Diameter XML / SIP cfg / DRA），绝不硬编码 IP、绝不推断未配置连接、绝不返回密钥、绝不写 Inventory/Topology/Health/Discovery；同一投影附带 `reconciliation` 咨询性差集（按无序 Inventory 资源对匹配台账与配置证据，接口标注分 `agrees`/`differs`/`unannotated`，已按决定退役单列而非当作漏登记，台账读取截断标 `partial`、读取失败标 `available=false`，绝不据此自动写台账）；Inventory 独占节点权威，Topology 仅持久化资源间关系边，端点必须引用已存在且未退役的 Inventory UUID；`contains`/`runs_on` 属显式声明的组成与落位关系，绝不由 runtime 派生，当前部署刻意保持 0 条（主机归属由 runtime 观测与按域虚拟分组承载，自动写入既会在对账中制造伪差异，也会在重装后静默过期）；活动边按 `(fromResourceId, toResourceId, relationshipType)` 部分唯一索引去重，重复创建返回 409，退役后可用新 `edgeId` 重建同一有向组合；`revision` CAS 乐观锁，`retired` 为不可逆终态；仅一跳邻域查询（`inbound` / `outbound` / `both`），不含多跳、自动发现或远端执行能力；读需 `core.read`，写需 `core.configure`。声明式拓扑关系不代表接口真实连通、注册成功或服务健康；配置证据同样不代表实测流量。权威文档：`docs/architecture/topology-dependency-model.md`；面向未来阶段的 Feature + UI/UX 完成门见 `docs/architecture/stage-feature-ui-acceptance.md`。

NF 告警规则底座：权威存储 `xcloud_ops.app_nf_alert_rules` + `xcloud_ops.app_nf_alerts`（共 2 个集合，`xcloud` 中为 0）；9 条 Go 路由（4 读 + 5 写）；1 条前端 SPA 路由（`/nf-alerts`）；规则由运营人员编写，是网元健康测量证据的纯观察者——在每次记录采集后由 scheduler 钩子评估，绝不触发采集、绝不修改网络、绝不写 Inventory/Topology/Discovery/NF Health 字段；两种条件类型（`state` 观测 L1/L2/L3/overall 层状态词表 [unhealthy, degraded, unknown]，`run_failed` 响应采集运行失败）；词表由 `GET /api/nf-alerts/meta` 权威下发；`not_configured` 与 `stale` 不可选（前者属于目标配置，后者属于新鲜度投影）；作用域三选一（`targetId` 单目标 / `resourceId` 资源全部目标 / 留空全部目标），创建后不可变；去重窗口（cooldown，有界秒数）内重复触发仅累计 `triggerCount`，绝不新建实例；每 (rule, target) 至多一个未闭合实例（active/acknowledged），由部分唯一索引 `uniq_nf_alert_open_instance` 强制；恢复即清除（条件不再满足时自动 resolve，`resolveReason=recovery`）；规则删除时引擎自动 resolve 其全部未闭合告警（`resolveReason=rule_deleted`）；告警实例保留不可变触发证据快照（runStatus/sampleId/collectedAt/layers/overallState）；`revision` CAS 乐观锁；读需 `core.read`，写需 `core.configure`；无 TTL，历史保留。

用户模板读权限与凭据脱敏：5 个模板读端点（`GET /api/profiles`、`GET /api/profiles/meta`、`GET /api/profiles/{name}`、`GET /api/profiles/{name}/stats`、`GET /api/profiles/{name}/versions`）要求 `profiles.read` 权限，拒绝经 `RequirePermissionWithAudit` 落 403 `PERMISSION_DENIED` 审计证据；`POST /api/profiles/{name}/versions/{versionId}/restore` 在 `profile_rollback` 能力判定前先过同一读门（恢复需读取含凭据的快照）。模板写拒绝（POST/PUT/DELETE）保持原有 403 `Insufficient permissions` 响应体，并经 `audit.RecordPermissionDenied` 补记 `authorization.denied` 证据，与读拒绝证据对称。`GET /api/profiles/{name}` 与 versions 详情分支对无 `subscribers.write` 权限的角色将 `auth.k`/`auth.op`/`auth.opc` 的非空值替换为 `[MASKED]`（键位保留、已配置/未配置可辨，AMF 不脱敏），与订阅者详情剥离 `auth4G` 的策略及 `/api/profiles/meta` 下发的 `credentialVisibility` 能力位同源；`[MASKED]` 永不作为合法写入值——PUT 在 `auth` 三键内遇到即返回 400 `INVALID_PROFILE_UPDATE`，防止读投影被回存为真实鉴权材料并经 governed apply 复制进订阅者 `security.k`。`POST /api/profiles` 的键名策略严于路径解析策略：拒绝空串、超过 64 字符、首尾空白或含制表/换行、以及保留键 `new`（大小写不敏感，会遮蔽 `/profile/new` SPA 路由）；读路径历史正则保持宽松，确保既有奇名模板仍可访问。

### 7.6 订阅者与搜索契约

- `GET /api/subscribers` 模式：`detail=false` → `listSubscriberImsis()`；`detail=true` → `listSubscriberRows()`；`msisdn` 有值 → MSISDN 查找模式。query 别名：`detail`、`page`、`limit`、`q`、`status`、`sortField`、`sort`、`sortDirection`、`sortDir`、`order`、`msisdn`、`excludeImsi`。已知状态：`all`、`active`、`restricted`、`lowTraffic`。不要重新设计校验逻辑。
- 可选筛选：`searchBy=imsi|auto`（`auto` 在 IMSI 前缀无命中时回退到 MSISDN 精确查找，默认 `imsi` 保持旧语义）、`contractStatus=active|suspended|terminated|none`、`provisioning=complete|incomplete|missing_contract|missing_balance|missing_plan`、`planId`、`balanceStatus=exhausted|low|normal|available|missing`、可选 `profile`（按模板绑定钻取，匹配 `webui_meta.profile_name` / `webui_meta.profile` / `profile_name` / `profile` 四字段任一，与模板统计口径一致，仅在 detail=true 行模式生效）。`status=lowTraffic` 保留为 `balanceStatus=exhausted` 的兼容别名；`available` 为包含 low 与 normal 的旧别名。
- `detail=true` 行新增 `msisdn`、`contractStatus`、`balanceState=missing|exhausted|low|normal`、`balanceThreshold`、`provisioning{contract,balance,tariffPlan}`；`summary` 新增 `lowBalance` 与 `unprovisioned`，列表结果可带 `matchedBy`/`matchSource`。余额状态以 `data_available` 与套餐 `volume_threshold` 推导：`available <= 0` 为 exhausted，`0 < available <= threshold` 为 low，其余为 normal；缺少余额记录归入 missing，绝不补零。`lowTraffic` 仅统计 exhausted；`lastActive` 取候选时间最大值，无证据返回空字符串。
- 详情 `GET /api/subscribers/{imsi}` 对无 `subscriber_write` 能力的角色移除 `auth4G.k/opc/op`；operator/admin 行为不变。
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
