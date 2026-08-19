# xCloud — 电信运营控制台

## 项目概述

xCloud 是面向电信运营与核心网运维的 Web 控制台。当前阶段聚焦 IMSI 签约管理、OCS 计费、资费策略、配置模板、审批治理、告警、审计与系统健康。产品身份以 xCloud 为主体，Open5GS 仅为当前兼容的数据层参考。

**产品定位：** 不是 Open5GS 的附属 WebUI，而是独立的电信运营平台，未来将演进为包含网元管理、信令监控、AIOps 的完整运维体系。

## 技术栈

- **框架：** Next.js 16.2.2 App Router（非静态导出，需 Node.js runtime）
- **前端：** React 19.2.4 + TypeScript 5 + SWR + Recharts + lucide-react
- **后端：** Next.js API Route Handlers（`src/app/api/`）
- **数据库：** MongoDB（双库：`open5gs` 存 HSS/OCS 数据，`xcloud_ops` 存 `app_*` 运营数据）
- **认证：** JWT Cookie（jose 库）+ bcryptjs 密码哈希
- **角色：** `root` | `operator` | `viewer`，后端 `requireCapability` 为最终安全边界

## 源码结构

```
src/
├── app/
│   ├── (dashboard)/          # 认证后的业务路由组（不进入 URL）
│   │   ├── layout.tsx        # 侧栏导航、顶部审批摘要、用户菜单
│   │   ├── subscribers/      # 签约管理
│   │   ├── ocs/              # OCS 计费管理
│   │   ├── profiles/         # 配置模板
│   │   ├── ratings/          # 计费规则
│   │   ├── approvals/        # 审批中心（待从 /users 拆出）
│   │   ├── audit-logs/       # 审计日志
│   │   ├── system/           # 系统健康
│   │   ├── users/            # 系统用户管理
│   │   └── roles/            # 角色管理（待建）
│   ├── login/                # 登录页
│   └── api/                  # 54 个 API Route Handler
│       ├── auth/             # 认证 + 用户 CRUD
│       ├── subscribers/      # 签约 CRUD、批量、导入
│       ├── profiles/         # 配置模板 + 版本
│       ├── ratings/          # 计费规则
│       ├── approvals/        # 审批工作流
│       ├── audit/            # 审计日志查询
│       ├── alerts/           # 告警
│       ├── analytics/        # 运营指标
│       └── system/           # 系统健康、一致性扫描修复
├── components/               # 共享 UI 组件
├── hooks/                    # React hooks（useAuth 等）
├── lib/                      # 跨层工具（authz、audit、security、sentinel、csv、locales）
├── server/repositories/      # 14 个 MongoDB 数据仓库
├── proxy.ts                  # JWT 解包，设置 x-user / x-user-role 请求头
└── types/                    # 共享类型
```

## 数据模型

### MongoDB 数据库

| 数据库 | 用途 | 集合 |
|--------|------|------|
| `open5gs` (MONGODB_DB) | HSS 签约 + OCS 计费 | `subscribers`, `ocs_tariff_plans`, `ocs_subscribers`, `ocs_balances` |
| `xcloud_ops` (MONGODB_APP_DB) | 运营控制台自有数据 | `app_users`, `app_profiles`, `app_profile_versions`, `app_approvals`, `app_audit_logs`, `app_alerts`, `app_rate_limits`, `app_metrics` |

### 关键约束

- xCloud 自有集合与 Open5GS 业务数据必须保持清晰边界
- 不把 `_id` 暴露到前端；审批使用独立 UUID `id`
- 审批通过后触发实际操作（创建/修改/删除签约、资费等），是系统最复杂的业务逻辑
- `logAudit` 通过 `setTimeout` 异步写入，API 成功不等待审计成功

## 设计系统

详见 `DESIGN.md` 和 `docs/design-system-rules.md`。核心规则：

### Token 三层架构

1. **原始 token（reference）：** `--ref-color-teal-600`、`--ref-space-4` 等固定值
2. **语义 token（system）：** `--sys-color-text-primary`、`--sys-color-action-primary` 等随主题变化
3. **组件 token（component）：** `--cmp-table-row-height` 等组件独立契约

**禁止：** 新增 CSS/TSX 直接写 `#hex`、`rgb()`、`rgba()`；颜色字面量只允许在 `:root` 和 `[data-theme]` 的原始 token 声明中。

### 设计原则

- **信号稀缺性：** 青绿主色只用于交互、当前状态和关键系统信号
- **语义分离：** 选中=主色，健康=绿，警告=琥珀，故障=红，不可混用
- **数据赢得等宽：** 只有 IMSI、代码、协议、测量数据使用等宽字体
- **结构深度优先：** 默认以色面、边界和间距分层，阴影只用于真实覆盖层
- **动效约束：** 只过渡 transform、opacity、颜色、边界和阴影；禁止过渡 width/height/padding/margin
- **操作真相规则：** 视觉优先级必须反映真实运营优先级

### 响应式断点

| 名称 | 范围 | 布局行为 |
|------|------|----------|
| Base | < 640px | 单列、抽屉导航 |
| sm | >= 640px | 双列短字段 |
| md | >= 768px | 工具栏横排、表格增加核心列 |
| lg | >= 980px | 完整侧栏、完整运营表格 |
| xl | >= 1180px | 三/四列数据卡 |
| 2xl | >= 1440px | 限制内容宽度 |

组件内容断点：`metric-single-column`(560px)、`dense-table-cards`(760px)、`content-stack`(900px)。不得新增相邻断点。

### 关键组件规范

- **控件高度：** 紧凑 32px、默认 36px、触控/大型 44px
- **表格行高：** 默认 54px，紧凑 44px
- **图标按钮：** 固定 44×44px 触控目标
- **圆角：** 微型 compact、小型 7px、控件 8px、面板 10px、柔和卡 12px、胶囊 999px
- **间距基准：** 4px，常用 0/4/8/12/16/20/24/32/40/48/64px
- **动效时长：** 快 150ms、常规 200ms、慢 350ms

## 开发规范

### 必须遵循

1. **Next.js 不是你熟悉的版本。** 写代码前先读 `node_modules/next/dist/docs/` 中的相关指南，注意废弃通知。
2. **每个 Route Handler 视为公开端点。** 必须在服务端验证认证、授权、输入和业务冲突；不暴露内部错误或敏感数据。
3. **服务端鉴权是最终安全边界。** 前端权限感知只用于界面一致性。
4. **TypeScript 用于所有新文件。**
5. **新增用户可见文案必须同时添加到中英文 locale 文件。**
6. **遵循 Conventional Commits：** `feat:` / `fix:` / `docs:` / `chore:` / `refactor:` / `test:`

### 代码组织

- Route Handlers → `src/app/api/`
- 跨层纯工具 → `src/lib/`
- 服务端编排 → `src/server/`
- MongoDB 访问 → `src/server/repositories/`
- 可复用 UI → `src/components/`
- React hooks → `src/hooks/`

### 质量检查

```bash
npm run lint          # ESLint
npm run typecheck     # TypeScript 类型检查
npm test              # 单元测试
npm run test:component  # 组件测试（React Testing Library）
npm run test:e2e        # 端到端测试（Playwright）
npm run build         # 生产构建
npm run check         # 核心四项：lint → typecheck → test → build
npm run check:full    # 完整验证：lint → typecheck → test → component → e2e → mongo:test-core → build
npm run mongo:test-core  # MongoDB 集成烟雾测试（需 MongoDB 运行）
npm run mongo:perf       # MongoDB 查询性能检查
```

**每次开发或优化完成后，必须执行完整验证：**

```bash
npm run check:full
```

这是不可跳过的提交门槛。`check:full` 覆盖了从静态检查到集成测试的完整流水线。如果 `mongo:test-core` 因 MongoDB 未运行而失败，至少必须通过 `npm run check`（lint + typecheck + unit test + build）。

分项执行顺序及失败即停：

| 顺序 | 命令 | 失败后果 |
|:----:|------|----------|
| 1 | `npm run lint` | 代码风格错误，阻塞提交 |
| 2 | `npm run typecheck` | 类型错误，阻塞提交 |
| 3 | `npm test` | 单元测试失败，阻塞提交 |
| 4 | `npm run test:component` | 组件渲染/交互失败，阻塞提交 |
| 5 | `npm run test:e2e` | 端到端流程失败，阻塞提交 |
| 6 | `npm run mongo:test-core` | 数据库集成失败，阻塞提交 |
| 7 | `npm run build` | 生产构建失败，阻塞提交 |

任何一步失败必须修复后从第 1 步重新开始。

### 测试优先级

当前需要补充测试的领域：
- Route 级认证、授权、校验和错误净化
- 签约导入导出集成流程
- 批量创建并发冲突
- 审计和分析副作用（临时 MongoDB）
- 表格、表单、Dialog、图表的键盘焦点和可访问名称

## API 端点概览

| 模块 | 端点数 | 关键能力 |
|------|:------:|----------|
| Auth | 8 | 登录/登出/当前用户/用户 CRUD |
| Subscribers | 8 | CRUD/批量/导入/策略/流量调整 |
| Profiles | 5 | CRUD/版本历史/恢复 |
| Ratings | 4 | 计费规则 CRUD |
| Approvals | 4 | 审批列表/批准拒绝/审计链/导出 |
| Analytics | 3 | 指标/火花线/初始化 |
| Audit | 1 | 审计日志查询 |
| Alerts | 2 | 告警列表/确认 |
| System | 3 | 健康检查/一致性扫描/修复 |
| OCS | 4 | 余额/会话/预留/用量 |
| Tariff Plans | 10 | CRUD/克隆/导出/迁移/规则 |

详细文档见 `docs/api.md`。

## 安全要点

- `JWT_SECRET` 至少 32 字节，每环境唯一
- 密码哈希使用 bcryptjs
- K、OPc、密码等敏感值默认遮挡，不写入日志/URL/分析事件
- 禁止删除 admin 账户或当前用户
- 高风险操作（批量修改、余额调整、不可逆删除）必须提供复核摘要
- Root 账户有特殊保护：PUT 禁止修改自己的 role/status

## 当前演进方向

### 用户管理模块拆分（阶段 1-4）

详见 `docs/user-management-phase-0-audit.md`：

1. **阶段 1：** `/users` 页面组件化收口（拆出 SystemUserTable/Drawer/CreatePanel）
2. **阶段 2：** 新增 `/roles` 角色管理页（从旧工作台提取权限矩阵）
3. **阶段 3：** 新增 `/approvals` 审批中心（从旧工作台提取审批功能）
4. **阶段 4：** 审计能力复用与收尾（复用 Diff Modal）

### 技术演进路线

详见 `../sc_md/implementation_plan.md`：

**当前阶段（Node.js 优化，3-4 天）：**
- MongoDB 索引优化（P0）
- Next.js standalone 输出
- Docker 多阶段构建
- Nginx 反代 + SSL
- PM2 进程管理

**未来阶段（Go 迁移，23-32 天）：**
- 渐进式 6 阶段迁移：骨架 → Auth → Subscribers+Profiles → OCS+Tariff → 治理模块 → 清理验证
- API 路径保持一致，前端 SWR 调用零改动
- Monorepo 结构：`backend/`（Go）+ `frontend/`（Next.js）

### CNMS 复用资产

详见 `../sc_md/CNMS_REUSE.md`：

兄弟项目 xCloud-CNMS（Go + React）包含可复用的电信核心网监控模块：
- **直接复用（P0）：** JWT 认证、Dockerfile、Docker Compose、MongoDB 连接池、配置管理
- **参考改造（P1-P2）：** Handler 结构、Subscriber 模型、限流中间件、告警去重、定时任务
- **未来核心复用（P3）：** HEP 信令监听器、跨协议关联引擎、AIOps 引擎、抓包守护进程、NF 自动发现

## 品牌与语言

- 产品名称：**xCloud**，所有产品级叙事以此为主体
- Open5GS 只在兼容性、数据模型、集成说明语境中出现
- 语气：专业、直接、克制，使用真实电信运营术语
- 操作文案：明确对象、影响、风险和恢复方式
- 支持中文（Noto Sans SC）和英文，通过 i18n provider 切换
