# 核心网治理：现状审查与 Phase 1

日期：2026-08-26。基线：`7df0f2e`，开始时工作区干净。

本次交付范围为 Phase 0 现状分析与 Phase 1 治理基础设施。Phase 2–5 的完整用户、审计、审批控制台及执行联动尚未交付，不能据此宣布生产治理闭环已经完成。

## 1. Existing Architecture

- Next.js 16.2.2 App Router / React 19.2.4 / TypeScript strict / Tailwind 4。
- 原生 MongoDB driver；应用集合在 `xcloud_ops`，核心网集合在 `xcloud`，名称可由环境变量覆盖。
- `src/app/api` 调用 `src/server/repositories`；公共 MongoDB 连接由 `src/lib/mongo.ts` 管理。
- 页面使用 SWR；JWT 使用 jose，密码使用 bcryptjs；standalone 构建。
- `src/proxy.ts` 是 JWT 边界；`src/lib/authz.ts` 是 Route Handler 授权入口。
- 已阅读项目随附的 Next.js Route Handlers、authentication、after 文档；不引入 ORM、UI 框架或工作流引擎。

## 2. Existing /approvals Analysis

- 页面委托 `components/users/ApprovalCenterPanel.tsx`，已有 SWR、Tab、搜索、Drawer、审批记录和审计链。
- 列表取有限条数后前端筛选，无服务端页码；API 上限与页面请求数还不一致。
- 状态为 `pending / approved / rejected / executed / failed`。批准接口立即调用执行器，不能独立保留“已批准待执行”。
- 服务端已禁止所有自审批，但 `transitionApproval` 仅按 id 更新，没有预期状态 CAS 条件，存在重复并发执行风险。
- 拒绝原因仅前端校验；非法 decision 默认批准；这些属于 Phase 4 必须修复的边界。
- 风险此前由动作名、等待时间和失败状态推算。Phase 1 删除该推算，没有服务端评级时显示“未评级”。
- 保留 `/api/approvals`、`/[id]`、`/[id]/audit`、`/export` 及已有 `ACCESS_REQUEST` 语义。

## 3. Existing /audit-logs Analysis

- 现有 `/api/audit` 支持动作、级别、对象、操作人、关键词和日期；最多返回 500 条，无分页。
- 页面有统计区域、热点筛选、列表和 Diff Modal，导出由浏览器 Blob 完成，仅前端按钮控制，缺少独立导出审计。
- 旧记录使用 `actor` 字符串、`operatorIp`、`correlationId`、`oldData/newData`。
- 原 `appendAuditLog` 每次写入都扫描并删除超过 50,000 条的旧记录；Phase 1 移除该逻辑。
- 原 `logAudit` 通过 Next `after()` 重试三次，无统一脱敏；Phase 1 补齐写入和历史读取清洗。

## 4. Existing /users Analysis

- 已有独立目录和 hooks：筛选、排序、分页、批量操作、Drawer、创建、编辑、密码重置。
- 列表接口全量返回，筛选/分页在客户端；URL 使用 replaceState，不完整支持前进/后退状态恢复。
- 只有 root 可以管理用户。`DELETE` 兼容端点实际禁用，保留历史身份，不做物理删除。
- 更新不允许修改自己的角色/状态，但目前是忽略字段；尚无最后一个有效管理员的原子保护。
- 用户界面有最近登录/锁定展示，后端尚未完整持久化并维护这些安全字段。

## 5. Existing Auth / JWT Analysis

- Cookie：`auth_token`，HttpOnly、SameSite=Lax、24 小时；HTTPS 时 Secure。
- JWT claims：`username / role / exp`，HS256；未持久化 session version。
- Proxy 验签后覆盖 `x-user / x-user-role`；鉴权 helper 仅供受此 Proxy 保护的 Route 使用。
- 当前持久角色是 `root / operator / viewer`，不是附件中的五角色。Phase 1 保留 `RoleKey` 和登录路径。
- `root → super_admin` 只是新权限目录的解释别名，绝不改写数据库或旧 token。
- 新 `ops_admin / auditor / super_admin` 定义已在目录中，但账号创建、JWT/Proxy 和全部旧能力门槛接入需在 Phase 2 统一实施；不要提前写这些角色到现有数据库。
- 禁用、降权后旧 JWT 仍可使用至过期；Phase 2 必须解决有效账号/session 校验，再宣称会话可撤销。

## 6. Existing MongoDB Schemas

| 集合 | 当前关键字段 | 处理方式 |
| --- | --- | --- |
| `app_users` | username、passwordHash、role、status、createdAt、createdBy、displayName、email | 保持原数据与唯一 username 索引 |
| `app_approvals` | UUID id、action、status、requester/reviewer 字符串、targetId、payload、note、result、时间 | 本阶段不改变执行/持久状态 |
| `app_audit_logs` | UUID id、ISO timestamp、level、action、targetId、actor、operatorIp、oldData/newData | 增量补 eventId、actorContext、module、resource、result、riskLevel、request/source、metadata/error |

审计的 `actor` 继续是字符串；结构化身份放入 `actorContext`。新服务接受 `before/after`，映射到已有 `oldData/newData`，避免重复存储快照或破坏旧消费者。旧记录没有 result/risk 时不编造成功或低风险。

新审计写入使用稳定字符串 `_id = id`，利用 MongoDB 内置 `_id` 唯一约束保证一次事件重试不重复插入；历史 ObjectId 记录继续读取。只吞掉匹配本事件 `_id` 的重复键，其他错误仍失败。未执行生产数据库初始化、迁移、索引创建或历史清理。

## 7. Reusable Components

| 现有组件 / API | 本阶段使用方式 |
| --- | --- |
| DashboardLayout、AppSidebar、PageHeader | 不替换整体布局或导航 |
| `Dialog`：open/onClose、labelledBy、initialFocusRef | 保留现有 Drawer/Modal 焦点管理与 Escape 行为 |
| `iam.module.css` badge、semantic CSS variables | 复用 badge 基础样式，增加 warning/info/critical 语义 |
| `VisualDiffViewer`：oldData/newData、semantic mode、compact | `ChangeDiff(before, after)` 包装，继续使用原 telecom 字段 Diff 引擎 |
| `OperationNotice`、EmptyState、LoadingRows、DataTablePagination | 保留；后续页面改造组合使用 |
| I18nProvider、ThemeProvider | 所有新文案提供中英对照，沿用亮/暗色 token |

共享组件为 `GovernanceBadges`、`ChangeDiff`、`EventTimeline`，不重建通用 Button/Input/Drawer。

## 8. Compatibility Risks

1. 不更名集合、用户角色、API URL、旧审批状态，不重写认证。
2. 旧 capability matrix 保持原样；`requirePermission(request, permission)` 为增量边界，先与审计读取旧 guard 一起接入。
3. 权限只是动作资格，不代表资源范围许可，更不意味着绕过审批或 Maker-Checker。
4. `approvals.cancel` 后续必须追加申请人范围校验；用户管理必须追加目标管理员和自操作保护。
5. 停止 50,000 条截断后，审计存储会持续增长；上线前规划容量、归档和独立 retention，不能重新放回业务写入函数。
6. `after()` 是请求后任务，不是进程崩溃后仍可恢复的持久队列。默认模式最多重试 3 次，失败输出不包含 driver 原始错误；严格模式需显式 await 并处理 `AuditWriteError`。严格模式也不提供跨业务与审计的原子事务。
7. 脱敏覆盖大小写/分隔符变体、嵌套数组、嵌入 JSON、常见凭据文本、核心网 K/OP/OPc 等，并限制深度/节点/文本量；它不是任意自然语言中的秘密识别器。调用者不应把 request body、header 或原始错误整包写入。
8. 保留现有 IP 遮罩；本阶段未实现敏感字段查看权限。真实源 IP 的信任依赖受控反向代理，不应将任意客户端 X-Forwarded-For 当可信身份。
9. 读取清洗阻止旧敏感字段继续返回，但不会改写/删除历史存储。是否存在已泄露凭据需单独安全评估与轮换。
10. 现有 `npm run test:e2e` 是源码断言，不是真实浏览器端到端测试。本阶段新增的服务测试实际执行编译后的服务/guard/repository，替换外部 I/O，但仍不能替代真实 MongoDB 集成测试。

## 9. Proposed File Changes / 已实施

- `src/types/governance.ts`、`src/types/audit.ts`：共享风险、状态、事件、审计类型。
- `src/lib/permissions.ts`：Permission Catalog、五角色矩阵、hasPermission、旧 root 兼容。
- `src/lib/authz.ts`：requirePermission；拒绝角色/能力/权限操作写入 denied evidence。
- `src/lib/audit.ts`、`src/lib/audit/*`：新统一服务、旧 logAudit 适配、脱敏、请求上下文与错误策略。
- `src/server/repositories/auditRepository.ts`：append-only、重试幂等、历史读取脱敏。
- `src/app/api/auth/permissions/route.ts`：保留旧 capabilities，增量返回治理角色解释和权限目录结果。
- `src/app/api/audit/route.ts`：增量权限检查，不拓宽旧 gate。
- `src/components/governance/*`、`src/components/iam/iam.module.css`：共享 badge、复用 Diff、真实事件时间线。
- `src/lib/diffEngine.ts`：复用过程中修正既有 AMBR `{value, unit}` 的错误 bps 展示，合成方向级差异；原字段值仍保留在脱敏 JSON。
- 审批和审计页面：接入共享组件、去除业务风险猜测、消除本次涉及的 any。
- `src/lib/locales/{en,zh}.ts`：新增文案。
- `tests/permissions.test.mjs`、`tests/governanceP0.test.mjs`、`tests/visualDiffEngine.test.mjs`：扩展已有测试，无新增框架。

## 10. Phase 1 Implementation Plan / 进度

- [x] 扫描现有结构和兼容边界，开发前输出结论。
- [x] RiskLevel、Permission Catalog、ROLE_PERMISSIONS、hasPermission、requirePermission。
- [x] 审计类型、递归脱敏、统一服务、legacy adapter、denied evidence。
- [x] 去除业务路径的审计删除；稳定事件 ID 支持重试。
- [x] 共享 Badge、ChangeDiff、事件时间线；接入现有页面。
- [x] 扩展 Node builtin 行为测试。
- [x] 完成最终 lint / typecheck / tests / build 结果记录。

### 验证记录

| 检查 | 结果 |
| --- | --- |
| 修改前 `npm test` | 159/159 通过 |
| 修改后 `npm run lint` | 通过，无错误/警告 |
| 修改后 `npm run typecheck` | 通过，strict 保持开启 |
| 修改后 `npm test` | 170/170 通过 |
| 修改后 `npm run build` | 最终通过，standalone 构建及页面生成成功；首次尝试因 fonts.gstatic.com 临时不可达失败，未替换字体或跳过检查 |
| `git diff --check` | 通过 |
| 浏览器只读验证 | 使用现有 Chrome 登录会话：用户页正常；审批待处理/历史列表为空且空态正常；审计返回 34 条历史记录，可打开字段 Diff；AMBR 展示已核对为 128 Kbps → 1 Gbps；脱敏 JSON 默认折叠；审计页面错误日志为空 |

未创建或修改用户、Subscriber、审批单，也未执行危险业务操作来造测试数据。当前数据库无审批样本，因此真实审批动作、critical 确认和完整事件时间线未做浏览器验证；这些属于后续 Phase。新增服务/仓储写入测试替换了 MongoDB I/O，尚未验证真实数据库写入与并发异常。尚未完成各分辨率及完整键盘流程的浏览器验收，不将它们计作通过。

### 后续 Phase 顺序

**Phase 2 / Users**：五角色账号与所有相关授权端接入；服务端分页；有效会话检查；最后一个管理员并发保护；密码与登录安全字段；用户活动来自审计。

**Phase 3 / Audit**：服务端分页和索引；结果/风险/模块/上下文筛选；URL 状态；宽 Drawer；服务端导出权限与 audit.export；渐进接入关键业务 API。

**Phase 4 / Approvals**：服务端风险和快照；CHG 编号；事件数据；原子状态机；严格 decision/reason 验证；批准与执行拆分；二次确认；取消/过期及参数校验。

**Phase 5 / Integration**：选择一个现有批量 Subscriber 高风险操作，将权限、策略、审批、原子执行、失败审计串联；不要一次改造所有生产操作。
