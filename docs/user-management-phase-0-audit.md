# 用户管理模块阶段 0 审计

审计日期：2026-07-28

## 一、当前结构

### 页面路由

项目使用 Next.js App Router。业务页面位于 `src/app`，`src/app/(dashboard)` 是 route group，不进入 URL。

当前相关路由：

| URL | 路由文件 | 说明 |
| --- | --- | --- |
| `/users` | `src/app/(dashboard)/users/page.tsx` | 当前系统用户页面 |
| `/audit-logs` | `src/app/(dashboard)/audit-logs/page.tsx` | 当前审计日志页面 |
| 暂无 | 暂无 | 角色管理独立页未建立 |
| 暂无 | 暂无 | Root 审批中心独立页未建立 |

### 页面入口文件

`src/app/(dashboard)/users/page.tsx` 是当前用户管理页面入口。页面是 `"use client"` Client Component，内部直接持有列表、筛选、新建、详情 Drawer、编辑和删除确认状态。

旧的混合工作台已保留在 `src/components/users/LegacyUserGovernanceWorkspace.tsx`，包含角色权限矩阵、动作权限说明、审批中心、审批统计、审批导出、审批审计详情以及旧版用户表。

### 主要组件

| 组件 | 文件 | 当前用途 |
| --- | --- | --- |
| `UsersPage` | `src/app/(dashboard)/users/page.tsx` | 系统用户页面入口 |
| `LegacyUserGovernanceWorkspace` | `src/components/users/LegacyUserGovernanceWorkspace.tsx` | 旧用户治理工作台保留基线，后续拆分来源 |
| `DashboardLayout` | `src/app/(dashboard)/layout.tsx` | 左侧导航、顶部审批摘要入口、用户菜单 |
| `AuditLogsPage` | `src/app/(dashboard)/audit-logs/page.tsx` | 审计日志列表、筛选、导出、JSON 差异 Modal |
| `OperationNotice` | `src/components/OperationFeedback.tsx` | 操作结果弹窗 |
| `ConfirmActionPanel` | `src/components/OperationFeedback.tsx` | 删除等危险操作二次确认 |
| `EmptyState` / `LoadingRows` | `src/components/OperationFeedback.tsx` | 空态和加载态 |

### 数据 Hooks 与请求方式

| 用途 | 位置 | 请求方式 |
| --- | --- | --- |
| 当前用户 | `src/hooks/useAuth.ts` | `useSWR('/api/auth/me')` |
| 用户列表 | `src/app/(dashboard)/users/page.tsx` | `useSWR('/api/auth/users', fetcher)` |
| 用户新增 | `src/app/(dashboard)/users/page.tsx` | `fetch('/api/auth/users', { method: 'POST' })` |
| 用户编辑/启停 | `src/app/(dashboard)/users/page.tsx` | `fetch('/api/auth/users/{username}', { method: 'PUT' })` |
| 用户删除 | `src/app/(dashboard)/users/page.tsx` | `fetch('/api/auth/users/{username}', { method: 'DELETE' })` |
| 顶部审批摘要 | `src/app/(dashboard)/layout.tsx` | `useSWR('/api/approvals?limit=5&status=...')` |
| 旧审批中心列表 | `src/components/users/LegacyUserGovernanceWorkspace.tsx` | `useSWR('/api/approvals?limit=30&status=...')` |
| 旧审批审计链 | `src/components/users/LegacyUserGovernanceWorkspace.tsx` | `useSWR('/api/approvals/{id}/audit')` |
| 审计日志页 | `src/app/(dashboard)/audit-logs/page.tsx` | `useSWR('/api/audit?...')` |

### API

| API | 方法 | 主要后端入口 | 权限 |
| --- | --- | --- | --- |
| `/api/auth/me` | GET | `src/app/api/auth/me/route.ts` | `requireAuth` |
| `/api/auth/permissions` | GET | `src/app/api/auth/permissions/route.ts` | `requireAuth` |
| `/api/auth/users` | GET/POST | `src/app/api/auth/users/route.ts` | `requireCapability('user_admin')` |
| `/api/auth/users/[username]` | PUT/DELETE | `src/app/api/auth/users/[username]/route.ts` | `requireCapability('user_admin')` |
| `/api/approvals` | GET | `src/app/api/approvals/route.ts` | `requireAuth`，非 root 只能看自己的 requester |
| `/api/approvals/[id]` | POST | `src/app/api/approvals/[id]/route.ts` | `requireCapability('user_admin')` |
| `/api/approvals/[id]/audit` | GET | `src/app/api/approvals/[id]/audit/route.ts` | `requireCapability('user_admin')` |
| `/api/approvals/export` | GET | `src/app/api/approvals/export/route.ts` | `requireCapability('user_admin')` |
| `/api/audit` | GET | `src/app/api/audit/route.ts` | `requireCapability('audit_export', { allowExport: true })` |

### 类型定义

| 类型 | 文件 | 备注 |
| --- | --- | --- |
| `UserRole` | `src/lib/authz.ts` | `root | operator | viewer` |
| `Capability` / `CapabilityDecision` | `src/lib/permissions.ts` | `allow | approval | export | deny` |
| `UserDocument` / `SafeUserDocument` | `src/server/repositories/userRepository.ts` | 后端用户存储类型，`safeUser` 去除 `passwordHash` 和 `_id` |
| `ApprovalAction` / `ApprovalStatus` / `ApprovalDocument` | `src/server/repositories/approvalRepository.ts` | 审批存储与 API 返回核心类型 |
| `AuditAction` | `src/lib/audit.ts` | 审计动作枚举 |
| `AuditLogRecord` | `src/server/repositories/auditRepository.ts` | 审计日志存储与 API 返回类型 |
| `SysUser` / `NewUserForm` / `EditUserForm` | `src/app/(dashboard)/users/page.tsx` | 页面内局部类型，后续建议迁出 |
| `ApprovalRequest` / `ApprovalAuditTrail` | `src/components/users/LegacyUserGovernanceWorkspace.tsx` | 旧审批 UI 的局部前端类型，后续建议迁出 |

### 权限判断位置

后端权限是事实来源：

| 层级 | 位置 | 作用 |
| --- | --- | --- |
| JWT 解包 | `src/proxy.ts` | 从 `auth_token` 设置 `x-user` 和 `x-user-role` 请求头 |
| 基础鉴权 | `src/lib/authz.ts` | `requireAuth` 检查 `x-user` |
| 能力鉴权 | `src/lib/authz.ts` + `src/lib/permissions.ts` | `requireCapability` 基于角色能力矩阵返回 403 |
| 前端展示 | `src/hooks/useAuth.ts`、`src/app/(dashboard)/layout.tsx`、`src/app/(dashboard)/users/page.tsx` | 控制导航、入口、按钮展示，不可替代后端权限 |
| Root 特殊保护 | `src/app/api/auth/users/[username]/route.ts` | 禁止删除 admin 或当前用户；PUT 时当前用户不能改自己的 role/status |

## 二、现有页面功能映射

| 功能名称 | 页面位置 | 组件文件 | API | 是否复用 | 后续迁移目标 |
| --- | --- | --- | --- | --- | --- |
| 用户列表 | `/users` 主表格 | `src/app/(dashboard)/users/page.tsx` | `GET /api/auth/users` | 是 | 保留在系统用户页，后续抽成 `SystemUserTable` |
| 用户新增 | `/users` 主表上方新建面板 | `src/app/(dashboard)/users/page.tsx` | `POST /api/auth/users` | 是 | 保留在系统用户页，后续抽成 `SystemUserCreatePanel` |
| 用户编辑 | `/users` 右侧 Drawer | `src/app/(dashboard)/users/page.tsx` | `PUT /api/auth/users/[username]` | 是 | 保留在系统用户页，后续抽成 `SystemUserDrawer` |
| 用户状态启用/禁用 | `/users` Drawer 编辑态 | `src/app/(dashboard)/users/page.tsx` | `PUT /api/auth/users/[username]` | 是 | 保留在系统用户页 |
| 用户删除 | `/users` 表格动作和 Drawer footer | `src/app/(dashboard)/users/page.tsx` | `DELETE /api/auth/users/[username]` | 是 | 保留在系统用户页，继续复用 `ConfirmActionPanel` |
| 角色权限矩阵 | 旧工作台上半区 | `src/components/users/LegacyUserGovernanceWorkspace.tsx` | 静态 `PERMISSION_MODULES` | 是，需拆分 | 角色管理页 `/roles` 或 `/access/roles` |
| 动作权限说明 | 旧工作台上半区 | `src/components/users/LegacyUserGovernanceWorkspace.tsx` | 静态 `ACTION_CAPABILITIES`，建议改读 `ROLE_CAPABILITIES` | 是，需拆分 | 角色管理页 |
| Root 审批中心 | 旧工作台中段 | `src/components/users/LegacyUserGovernanceWorkspace.tsx` | `GET /api/approvals`、`POST /api/approvals/[id]` | 是，需拆分 | 审批中心 `/approvals` |
| 审批统计 | 旧审批中心 SLA 卡片 | `src/components/users/LegacyUserGovernanceWorkspace.tsx` | `GET /api/approvals` 返回 `pending/sla/total` | 是，需拆分 | 审批中心 `/approvals` 顶部 |
| 审批导出 | 旧审批中心导出控件 | `src/components/users/LegacyUserGovernanceWorkspace.tsx` | `GET /api/approvals/export` | 是，需拆分 | 审批中心 `/approvals` 工具栏 |
| 审批审计详情 | 旧审批详情侧栏与 Diff Modal | `src/components/users/LegacyUserGovernanceWorkspace.tsx` | `GET /api/approvals/[id]/audit` | 是，需拆分 | 审批中心详情 Drawer |
| 审计日志 | 独立 `/audit-logs` 页面 | `src/app/(dashboard)/audit-logs/page.tsx` | `GET /api/audit` | 是 | 保留在审计日志页，后续可复用 Diff Modal |
| 顶部审批摘要 | 顶部导航 Bell 下拉 | `src/app/(dashboard)/layout.tsx` | `GET /api/approvals?limit=5&status=...` | 是，需改入口 | 指向审批中心路由 |

## 三、建议的信息架构

目标结构建议采用兼容现有 App Router 的平铺一级路由，避免一次性改动导航与权限范围过大：

```text
用户与权限
├── 系统用户      /users
├── 角色管理      /roles
├── 审批中心      /approvals
└── 审计日志      /audit-logs
```

兼容方案：

1. 短期保留当前 `/users` 作为系统用户页，不再承载角色矩阵和审批中心。
2. 新增 `/roles`，从 `LegacyUserGovernanceWorkspace` 提取角色矩阵和动作权限说明；先做只读角色权限展示，不改 API。
3. 新增 `/approvals`，从旧工作台提取审批列表、SLA 统计、导出、详情与审计链；顶部 Bell 入口改指向 `/approvals`。
4. `/audit-logs` 保持独立，仅在审批中心中复用审计链/差异查看体验，不合并页面。
5. 如果导航不想增加一级项，可在左侧导航增加“用户与权限”父级，子项为 `/users`、`/roles`、`/approvals`、`/audit-logs`；这需要小幅调整 `DashboardLayout` 的 nav 数据结构。

## 四、阶段 1 至阶段 4 改造计划

### 阶段 1：系统用户页组件化收口

涉及文件：

| 文件 | 改造内容 |
| --- | --- |
| `src/app/(dashboard)/users/page.tsx` | 保持当前 UI，不改 API；只拆出子组件与类型 |
| `src/components/users/SystemUserTable.tsx` | 承接用户列表、空态、行操作 |
| `src/components/users/SystemUserDrawer.tsx` | 承接详情、编辑、启停、密码更新 |
| `src/components/users/SystemUserCreatePanel.tsx` | 承接新建用户表单 |
| `src/components/users/userTypes.ts` | 迁出 `SysUser`、表单类型、role/status union |
| `src/components/users/userUtils.ts` | 迁出 normalize、format、校验辅助 |

验收：

- `/users` 只负责系统用户。
- 删除二次确认保留。
- 所有用户写操作仍走原 API。
- 不引入后端结构变更。

### 阶段 2：角色管理页

涉及文件：

| 文件 | 改造内容 |
| --- | --- |
| `src/app/(dashboard)/roles/page.tsx` | 新增角色管理页面 |
| `src/components/users/RolePermissionMatrix.tsx` | 从旧工作台提取角色权限矩阵 |
| `src/components/users/ActionCapabilityMatrix.tsx` | 从旧工作台提取动作权限说明 |
| `src/lib/permissions.ts` | 只读复用 `ROLE_CAPABILITIES`，不改变能力定义 |
| `src/lib/locales/en.ts` / `src/lib/locales/zh.ts` | 补导航与页面文案 |
| `src/app/(dashboard)/layout.tsx` | 增加角色管理导航入口 |

验收：

- 权限术语统一展示为“允许、需审批、禁止”；`export` 在 UI 上归类说明为允许的导出能力，避免成为第四种状态。
- 角色页暂不支持编辑数据库角色模型。

### 阶段 3：审批中心页

涉及文件：

| 文件 | 改造内容 |
| --- | --- |
| `src/app/(dashboard)/approvals/page.tsx` | 新增审批中心页面 |
| `src/components/approvals/ApprovalQueue.tsx` | 提取审批列表、搜索、状态筛选 |
| `src/components/approvals/ApprovalSlaSummary.tsx` | 提取审批统计 |
| `src/components/approvals/ApprovalDetailDrawer.tsx` | 提取审批详情、payload/result、审批意见、批准/拒绝 |
| `src/components/approvals/ApprovalExportPanel.tsx` | 提取审批导出 |
| `src/components/approvals/ApprovalAuditTrail.tsx` | 提取审批审计链 |
| `src/app/(dashboard)/layout.tsx` | 顶部 Bell footer 指向 `/approvals` |

验收：

- Root 审批从 `/users` 彻底迁到 `/approvals`。
- 仍使用现有 `/api/approvals*` API。
- 批准/拒绝继续以后端 `requireCapability('user_admin')` 为准。

### 阶段 4：审计能力复用与收尾

涉及文件：

| 文件 | 改造内容 |
| --- | --- |
| `src/app/(dashboard)/audit-logs/page.tsx` | 保持独立页面，必要时抽出公共 Diff Modal |
| `src/components/audit/AuditDiffModal.tsx` | 复用审计日志页和审批中心的 JSON 差异查看 |
| `src/components/users/LegacyUserGovernanceWorkspace.tsx` | 确认功能全部迁移后标记为 deprecated；暂不删除，除非后续阶段明确要求 |
| `tests/permissions.test.mjs` | 补充角色能力矩阵展示/能力键一致性相关测试，如有必要 |

验收：

- 审计日志负责操作追踪。
- 审批中心只引用审批相关审计链。
- 不改变 `app_audit_logs` 数据结构。

## 五、风险点

| 风险项 | 当前状态 | 建议 |
| --- | --- | --- |
| 权限判断耦合 | `/users` 前端用 `isRoot` 隐藏页面，后端 `/api/auth/users*` 用 `user_admin` 强校验；顶部审批入口仍跳 `/users` | 阶段 3 改顶部审批入口到 `/approvals`，保持后端为准 |
| 审批逻辑耦合 | 旧审批 UI 保留在 `LegacyUserGovernanceWorkspace`，API 与审计链已独立 | 阶段 3 按组件拆分，不改 API |
| 页面组件相互依赖 | 当前 `/users` 内部仍含大量局部类型、局部渲染函数和内联 CSS | 阶段 1 只做组件化拆分，不改变行为 |
| URL 查询参数 | `/users` 筛选当前是本地 state，没有 URL query；审批和审计 API 使用 query | 如需可分享视图，后续再引入 URL query，避免本阶段扩散 |
| 用户列表分页 | `GET /api/auth/users` 返回全量列表，前端无分页 | 用户量较小时可接受；如要分页需新增兼容参数，不应在阶段 1 直接改 API |
| 前后端字段命名 | 用户字段为 `username/role/status/createdAt/createdBy`；审批字段为 `id/action/status/requester/reviewer/targetId/summary/...` | 前端类型应复用或映射后端类型，避免重复局部 union 漂移 |
| 用户名校验差异 | 前端允许点和短横线且 3-32 位；后端只允许 `[a-zA-Z0-9_]` 且 3-20 位 | 阶段 1 可只对齐前端校验文案，不改 API；若改后端需兼容说明 |
| MongoDB ObjectId | 用户、审批、审计仓储均剥离 `_id` 后返回；审批使用独立 `id` UUID，不暴露 ObjectId | 保持现有返回结构，不把 `_id` 暴露到前端 |
| Root 账号特殊保护 | 前端禁止删除 admin/自己，Drawer 禁用 admin/自己 role/status；后端 DELETE 禁止 admin/自己，PUT 禁止自己改 role/status | 后端未禁止修改 admin 的 role/status；如需加强，需单独阶段说明影响 |
| 审计异步写入 | `logAudit` 通过 `setTimeout` 异步写入，API 成功不等待审计成功 | 现状可保留；审批中心详情可能短暂看不到最新审计链 |
| 类型宽松 | `audit-logs/page.tsx` 使用 `any`，ESLint 当前关闭 `no-explicit-any` | 阶段 4 可收紧审计类型，不作为阶段 0 阻塞 |
| 现有未提交改动 | 工作区存在 `src/lib/security.ts` 未提交改动 | 阶段 0 不纳入提交，避免混入业务行为变更 |

## 阶段 0 结论

当前项目已经具备拆分所需的后端 API、RBAC 能力矩阵、审批仓储、审计仓储和基础 UI 组件。后续阶段可以在不改 MongoDB 模型、不改 API 返回结构的前提下，按页面职责拆分：`/users` 保持系统用户，`/roles` 承载角色权限展示，`/approvals` 承载 Root 审批，`/audit-logs` 承载操作追踪。

本阶段未修改业务逻辑、API、数据库结构，也未删除任何组件。
