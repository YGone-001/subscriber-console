# 前端 UI 对等性差异分析与完整移植方案

> 状态：ANALYSIS + PLAN（未实施）。
> 目的：把参考项目 `C:\Users\YGone\Desktop\subscriber-console` 的界面**完整、正确地**移植到当前项目
> `C:\Users\YGone\Desktop\program\subscriber-console`。
> 参考项目运行在 `http://localhost`，其实现是历史的 Next.js 版本；
> 当前项目运行在 `http://localhost:13333`，实现是 React + Vite。
> 本文档是 `docs/architecture/frontend-ui-restoration.md` 的修正与续作：该文档声明 Stage 1-UI「Done」，但实测表明迁移只完成了**壳层骨架**，页面表现层与共享原语层大面积缺失。

---

## 0. 结论摘要

当前项目的 Vite 前端**不是**对原 Next.js 前端的移植，而是**一次从零重写**：它复用了原项目的设计令牌（token），但替换了整套类名体系、丢弃了共享 UI 原语层、丢弃了约 **76% 的 CSS 规则**，并引入了若干数据渲染缺陷。

三个可量化的硬指标：

| 指标 | 原项目（参考） | 当前项目 | 差异 |
|---|---|---|---|
| CSS 规则块总数 | **2751** | **659** | **-76%** |
| CSS 文件数 / 体积 | 36 个 / ~370 KB | 7 个 / ~101 KB | -73% |
| 设计令牌（`--var`）数 | 127 | 127 | ✅ 对等 |
| `components/ui` 共享原语 | **23 个文件** | **6 个文件** | **-17** |
| JSX 类名词表 | 1406 | 326 | -77% |
| 关键页面类名 | `dash-card`×81、`kpiGrid`×25、`analytics-*`×329、`profile-*`×92、`ocs-*`×~200 | `read-page`×29，`ocs-*` = **0** | 体系被替换 |

结论：**令牌层已对齐，规则层与组件层未对齐**。因此界面的「配色/圆角/字体」观感接近，但「版式、区块、卡片、表格、图表、弹窗」与原型明显不同。

---

## 1. 对比基线与方法

### 1.1 两个被比较的对象

| 角色 | 路径 | 运行时 | Git |
|---|---|---|---|
| **参考实现（移植来源）** | `C:\Users\YGone\Desktop\subscriber-console` | Nginx `:80` → Next.js `:13334` + Go `:18889` | 同一仓库 `origin/develop`，detached HEAD `2c40903` |
| **目标实现（移植目的地）** | `C:\Users\YGone\Desktop\program\subscriber-console` | Vite `:13333` → Go `:18888` | `origin/develop` HEAD `df8a755` |

### 1.2 关键 Git 事实（决定了参考基线）

```
2c40903  ← 参考项目 HEAD：最后一个「纯 Next.js」状态
   │        （405 commits）
   │  17 commits：SPA 迁移期（0c84fdd 建立并行 SPA → 9434c77 边缘切到内嵌 SPA）
   ▼
e054d93  ← frontend-ui-restoration.md 声明的「历史 UI 参考 SHA」
   │  11 commits
   ▼
df8a755  ← 当前项目 HEAD（433 commits）
```

- `git merge-base --is-ancestor 2c40903 e054d93` → **YES**，`2c40903..e054d93` = 17 commits。
- 即：**参考项目是 SPA 迁移开始前的最后一个 Next.js 状态**，其 `frontend/src` 就是被移植的那份 UI。
- 参考项目工作树相对 `2c40903` 有 38 处改动，但 `git diff --stat -- frontend` 只涉及 `frontend_start.{bat,sh}`、`package.json`、`src/proxy.ts` —— **`frontend/src` 其余部分与 `2c40903` 一致**，可直接作为参考源。

### 1.3 验证手段

1. **截图对照**：用 CDP + 无头 Chrome 对两个应用逐路由截图（1440×900），使用 `admin / Admin@2026` 登录态（`auth_token` cookie）。
   - 采集脚本：`.workbuddy-ai/tmp/capture.mjs`（临时）；证据归档：`.workbuddy-ai/reports/ui-parity/{original,current}/*.png` + `.workbuddy-ai/reports/ui-parity/capture-report.json`。
   - 共 25 个路由 × 2 应用 = 50 张截图。
2. **源码对照**：类名词表 diff、CSS 规则计数、`components/ui` 清单、逐页组件读取。
3. **运行时探测**：CDP `Runtime.evaluate` 读取壳层几何（见 §3.5）。

> ⚠️ 方法学提醒：全页截图（`captureBeyondViewport: true`）会改变 `100vh` 壳层的布局，导致侧栏在截图中错位。**壳层几何以视口截图 `.workbuddy-ai/reports/ui-parity/{original,current}-viewport-subscribers.png` 为准**，运行时实测侧栏 `x=4, y=64, w=264, h=836`，内容区 `x=268, w=1172`，**侧栏布局本身是正确的**。

### 1.4 路由对等性（已确认无缺陷）

两端的重定向集合**完全一致**，不是缺陷：

```
/ocs, /ocs/dashboard, /ocs/sessions, /ocs/usage        -> /ocs/tariffs
/ocs/subscribers                                        -> /ocs/contracts
/rating, /rating/plans, /rating/rules                   -> /ocs/tariffs
/roles                                                  -> /users
```

- 参考项目 `frontend/src/app/(dashboard)/ocs/{dashboard,sessions,usage}/page.tsx` 等 9 个文件**本身就是 5 行 `redirect()` 桩**（`git status` 确认未修改）。
- 当前项目 `frontend/src/router/redirects.ts` 逐条复刻了同一集合。✅
- 当前项目额外新增 `/inventory`（参考项目访问该路由返回 Next.js 404，截图 11 KB 空白页）。**这是合法新增，不是缺失。**

---

## 2. 根因诊断

### 2.1 根因一：类名体系被整体替换（最核心）

当前项目的页面标记使用一套**自造的 `.read-*` 词表**，而参考项目使用 xCloud 的域类名词表。两套词表**没有任何交集**，因此参考项目的全部页面级 CSS 规则对当前标记**完全失效**。

| 参考项目类名 | 使用次数 | 当前项目 |
|---|---|---|
| `dash-card` | 81 | **0** |
| `kpiGrid` | 25 | **0** |
| `analytics-*` | 329 | **0** |
| `profile-*` | 92 | **0** |
| `subscriber-*` | 21 | **0** |
| `ocs-container` | 11 | **0** |
| `ocs-detail-grid` | 6 | **0** |
| `ocs-table-card` | 2 | **0** |
| `container` | 大量 | 15（语义不同） |
| — | — | `read-page` 29（新增词表） |

`docs/architecture/page-templates.md` 与 `design-system-rules.md`（当前项目自己的规范）要求的正是 `.dash-card` / `.container` / `ocs-container` / `ocs-detail-grid` / `MetricStrip` / `OcsPageShell` —— **规范描述的是参考词表，代码实现的是另一套**。

### 2.2 根因二：共享 UI 原语层未移植

参考项目 `frontend/src/components/ui/` 有 **23 个文件**；当前项目 `frontend/src/components/ui/` 只有 **6 个**，且清单不同。

| 参考项目原语 | 当前项目 | 影响 |
|---|---|---|
| `MetricStrip.tsx` | ❌ 缺失 | 所有列表页汇总条、KPI 行 |
| `OcsPageShell.tsx` | ❌ 缺失 | OCS 域统一壳 |
| `DataTablePagination.tsx` | ❌ 缺失 | 表格分页契约 |
| `SortableTableHeader.tsx` | ❌ 缺失 | 表头排序 |
| `DataTableState.tsx` | ❌ 缺失 | 表格 loading/empty/error 行 |
| `InlineNotice.tsx` | ❌ 缺失 | 内联提示 |
| `ChartDataTable.tsx` + `chartPrimitives.tsx` | ❌ 缺失 | 图表调色板 + 等价数据表 |
| `SectionHeader.tsx` | ❌ 缺失 | 区块标题 |
| `RefreshButton.tsx` | ❌ 缺失 | 刷新动作 |
| `IconButton.tsx` | ❌ 缺失 | 图标按钮 |
| `Dialog.tsx` + `useDialogFocus.ts` | ❌ 缺失（当前用自造 `Modal.tsx`） | 弹窗焦点管理 |
| `Field.tsx` | ❌ 缺失 | 表单控件 |
| `UnsavedChangesGuard.tsx` | ❌ 缺失 | 未保存离开保护 |
| `ConsolePrimitives.module.css` | ❌ 缺失 | 控制台原语样式 |

当前项目仅有：`KpiCard.tsx`、`LoadingSkeleton.tsx`、`OperationFeedback.tsx`、`PageHeader.tsx`、`StatePanel.tsx`、`StatusBadge.tsx`。

### 2.3 根因三：CSS 规则层按域丢失

| 域样式表（参考） | 规则数 | 体积 | 当前去向 | 状态 |
|---|---|---|---|---|
| `app/globals.css` | 319 | 49.9 KB | `base.css`(100) + `utilities.css`(119) + `tokens.css`(5) | ⚠️ 大幅削减 |
| `app/(dashboard)/layout.css` | 247 | 41.1 KB | `shell.css`(228) | ✅ 基本对等 |
| `components/analytics.css` | 248 | 36.2 KB | `pages.css` 的 `.analytics-*` 片段 | ❌ 几乎全丢 |
| `app/(dashboard)/ocs/ocs.css` | 212 | 29.3 KB | — | ❌ 全丢 |
| `components/rating/rating.css` | 196 | 22.2 KB | — | ⛔ 有意不移植（路由重定向） |
| `components/subscriber/subscriber.css` | 137 | 14.8 KB | — | ❌ 全丢 |
| `components/modals.css` | 133 | 14.3 KB | `components.css`(126) | ⚠️ 部分 |
| `components/profile/profile.css` | 132 | 13.7 KB | — | ❌ 全丢 |
| `users/components/UserDrawer.module.css` | 110 | 11.0 KB | — | ❌ 全丢 |
| `app/(dashboard)/subscribers/subscribers.css` | 105 | 12.0 KB | — | ❌ 全丢 |
| `app/(dashboard)/system-health/system-health.css` | 102 | 12.9 KB | `utilities.css` 片段 | ❌ 几乎全丢 |
| `users/components/UsersTable.module.css` | 79 | 8.6 KB | — | ❌ 全丢 |
| `ui/ConsolePrimitives.module.css` | 73 | 10.0 KB | — | ❌ 全丢 |
| `OperationFeedback.css` | 73 | 7.0 KB | `components.css` 片段 | ⚠️ 部分 |
| `NocSentinel.css` | 61 | 10.0 KB | `shell.css` 片段 | ⚠️ 部分 |
| `login/LoginForm.css` | 42 | 5.5 KB | `pages.css` 的 `.login-*` 片段 | ⚠️ 部分 |
| `CommandPalette.css` | 40 | 5.8 KB | `shell.css` 片段 | ⚠️ 部分 |
| `users/components/UsersToolbar.module.css` | 32 | 3.7 KB | — | ❌ 全丢 |
| 其余（`iam`、`DataTable*`、`Field`、`InlineNotice`、`SortableTableHeader`、`ChartDataTable`、`UnsavedChangesGuard`、`SubscriberModal`、`subscriber-trace-modal`、`diff-viewer`、`governance`、`datahub`、`rating-rule-link-panel`） | 约 60 | — | — | 多数 ❌ |

> 当前项目 `pages.css` 用 **79 条规则**去覆盖参考项目 **936 条**页面级规则（analytics+ocs+subscriber+profile+system-health+subscribers）。

### 2.4 根因四：类名替换后引入了「兜底工具类层」

当前项目 `frontend/src/styles/utilities.css` 手写了约 119 条 Tailwind 风格工具类（`.flex`、`.items-center`、`.text-sm`、`.grid-cols-2`、`.max-w-4xl`、`.space-y-6`…），因为页面标记里**大量使用这些工具类**（当前词表中 326 个类里约 200 个是工具类）。

参考项目**不使用工具类**，而是语义化域类名。这解释了为什么当前界面看起来「能用但不像」：布局靠通用 flex/gap 工具类拼装，缺少域级视觉语言（卡片头、指标网格、状态药丸、配额条、抽屉）。

### 2.5 根因五：验收门失效（为什么没有被发现）

`scripts/test-ui-restoration-contract.mjs`（264 行，UI-01…UI-35）**全部是自指断言**：它检查当前源码里是否包含**它自己定义的**字符串，而不是与参考实现比对。例如：

- `UI-13`：`tabBarSource.includes('nav-tab-bar') && /getVisibleNavigation/` —— 只验证「当前 tab bar 叫这个名、用了这个函数」。
- `UI-19`：`/KpiStrip/ && /KpiCard/ && /chart-card/ && /workbench/ && /detail-panel/` —— 验证的是**当前自己发明的**类名，而非参考项目的 `analytics-kpi-card` / `analytics-workbench-main`。
- `UI-27`：`REQUIRED_CSS_SELECTORS` 存在性 —— 该清单由当前实现反向编写。

因此该门**恒为绿**，无法发现任何与参考实现的偏离。这是本次差异得以长期存在的直接原因。

---

## 3. 逐页差异分析（截图 + 源码）

截图路径：`.workbuddy-ai/reports/ui-parity/original/<name>.png`（参考）与 `.workbuddy-ai/reports/ui-parity/current/<name>.png`（当前）。

### 3.1 登录页 `login.png`

| 维度 | 参考 | 当前 |
|---|---|---|
| 品牌区 | 大号 xCloud 图形标（≈64px）+ 标题 `xCloud Platform` + 副标题「核心网管理系统」 | 小号图形标 + `xCloud` 字标 + eyebrow `SUBSCRIBER CONSOLE` + `Sign in` |
| 版式 | 居中、卡片内文案居中 | 左对齐 |
| 输入框 | 内嵌左图标（user / lock）+ placeholder「用户名 / 密码」 | 无图标，标签在框外 |
| 密码可见性 | 框内眼睛图标 | 框外 `Show` 按钮 |
| 页脚 | 「由 xCloud Secure Access 提供安全保护」 | 无 |
| 默认语言 | 跟随浏览器语言（本机 zh-CN → 中文） | 硬编码 `en`（`I18nProvider.tsx:7`） |

源码：参考 `frontend/src/app/login/LoginForm.tsx` + `LoginForm.css`（42 条规则）；当前 `frontend/src/auth/LoginPage.tsx` + `pages.css` 的 `.login-*` 片段（约 20 条）。

### 3.2 仪表盘 `dashboard.png`（差异最大）

| 区块 | 参考 | 当前 |
|---|---|---|
| 页头 | eyebrow「实时运行」+ 脉冲点，h1「分析仪表盘」+ RadioTower 图标，描述文案 | eyebrow `OPERATIONAL COCKPIT`，h1 `Dashboard`，`Snapshot <时间>`，右侧 Refresh |
| KPI 行 | **6 张**卡：全球总流量 / 活跃用户数 / 活跃 PLMN 区域 / 签约用户 / 流量池水位 / 不变量守卫；每张含图标、数值、副说明、**右侧环形进度**（100/13/100/100/0/100） | **8 张**卡，4 列网格：TOTAL TRAFFIC / SUBSCRIBERS / ACTIVE ALERTS / OCS CONTRACTS / ACTIVE SESSIONS / DATA UTILIZATION / BALANCE INVARIANTS / GY-RO INTERFACES；无环形、无副说明 |
| 运营工作台 | 「运营工作台 1」+ 工作项「额度耗尽风险 P1 / 预计剩余可用时长 48.2 小时」+ 右侧「就绪度 92」环形仪表 + 「0 个活跃告警」 | **完全缺失** |
| OCS 卡片行 | 流量池水位 / 语音余额池 / 短信余额池 / 活跃会话（含 mini bar） | **完全缺失** |
| 图表 | 「Top 5 流量消耗用户」（Live 徽章）+「资费计划采纳与用户分布」 | Traffic trend / Subscriber trend / PLMN distribution；**PLMN distribution 渲染为一整块实心色块（图表缺陷）** |

源码：参考 `frontend/src/components/AnalyticsCockpit.tsx` + `components/analytics/*`（11 个文件）+ `analytics.css`（248 条）；当前 `frontend/src/features/read/ReadPages.tsx` + `dashboard-model.ts` + `pages.css` 的 `.analytics-*` 片段。

### 3.3 用户管理 `subscribers.png`

| 区块 | 参考 | 当前 |
|---|---|---|
| 页头 | eyebrow「IMSI / HSS」，h1「用户管理」+ 图标，描述「管理 IMSI 配置、流量分配与用户生命周期。」 | eyebrow `GOVERNED SUBSCRIBER MANAGEMENT`，h1 `Subscribers`，**无描述** |
| 汇总条 | **4 列 MetricStrip**：当前用户总数 12（带下划线高亮）/ 活跃 12 / 停机-受限 0 / 流量不足 2，可点击筛选 | **完全缺失**（仅一行 `12 records`） |
| 工具栏 | 大号圆角搜索「按 IMSI 前缀搜索...」+ `+ 添加新用户`（主）/`批量创建用户`/`同步数据`/`数据枢纽` | 小号输入框 + `+ Create`/`Batch Create`/`Batch Update`/`Import` |
| 表格列 | 状态 / IMSI / PLMN / 资费套餐 / 流量使用 / 最后更新 / 操作（**含排序箭头**） | IMSI / STATUS / TRAFFIC / PROFILE / PLMN / ACTIONS（**无排序**） |
| 单元格 | 状态药丸、IMSI 等宽字体 + 复制、PLMN 药丸、套餐名 + `default_plan` 副行、**流量使用进度条**（`0 B —— 1 B`）、`6 天前` 相对时间、行操作 铅笔/删除/更多 | IMSI 纯文本、STATUS 药丸、**TRAFFIC 渲染为 `[object Object]`**、PROFILE `-`、PLMN 纯文本、行操作 铅笔/复制/井号/红色删除 |

**数据缺陷根因**：`frontend/src/features/subscribers/SubscribersPage.tsx:554`
```tsx
<td data-label="Traffic">{text(row['traffic'])}</td>
```
其中 `text = (v) => (v == null || v === '' ? '-' : String(v))`（第 36 行）。`row.traffic` 是对象（含 total/used/available），`String(对象)` → `"[object Object]"`。需改为读取 `traffic.used` / `traffic.total` 并渲染进度条。

### 3.4 OCS 资费计划 `ocs-tariffs.png`

| 区块 | 参考 | 当前 |
|---|---|---|
| 页头 | eyebrow「计费管理」，h1「资费计划」+ 图标，描述「管理 OCS 资费计划及治理流程」 | eyebrow `GOVERNED TARIFF MANAGEMENT`，h1 `Tariff Plans`，**无描述** |
| KPI 行 | **4 张 MetricStrip 卡**：计划总数 2 / 活跃计划 2 / 已禁用计划 0 / 合同用户总数 10 | **完全缺失** |
| 控件行 | 圆角筛选条 + `+ 新建计划` | 空条 + `+ Create Tariff Plan` |
| 表格列 | 计划 ID / 名称 / 状态 / **版本** / **订阅用户** / **更新人** / 更新时间 / 操作 | PLAN ID / NAME / STATUS / VERSION / SUBSCRIBERS / UPDATED / ACTIONS（缺「更新人」） |
| 数据 | 订阅用户 `10`、更新时间 `2026/9/18` | SUBSCRIBERS = **`-`**、UPDATED = **`2026-09-18T08:56:05Z`**（原始 ISO 串） |
| 分页 | 无（仅 2 行） | 出现 `Previous / 1 / Next` |

**数据缺陷（字段名不匹配）**：API `/api/tariff-plans` 返回的是 **`subscriberCount`**（驼峰），而当前页面读取的是 `row.subscriber_count`（蛇形）→ `undefined` → 渲染 `-`。

```tsx
// frontend/src/features/ocs/tariffs/TariffsPage.tsx:252
<td data-label="Subscribers">{text(row.subscriber_count)}</td>   // ← 应为 row.subscriberCount
```

同一错误也出现在 `features/ocs/balances/BalancesPage.tsx:175` 与 `features/ocs/contracts/ContractsPage.tsx:245` 的 `Version` 列。此外时间戳未走 `Intl.DateTimeFormat`（参考 `I18nProvider` 提供格式化 helper），直接输出 ISO 串。

### 3.5 系统健康 `system-health.png`（内容丢失最严重）

| 区块 | 参考 | 当前 |
|---|---|---|
| 页头 | eyebrow「NOC / 诊断」，h1「系统健康」+ 心跳图标，描述「核心子系统健康矩阵」，动作：`性能降级`/`同步数据`/`刷新` | eyebrow `OPERATIONAL GOVERNANCE`，h1 `System health`，动作：Refresh / Recompute Analytics / Run Audit Scan |
| 核心内容 | 区块「核心子系统健康矩阵」+ **4 张子系统卡**，每张含名称、副标题、健康徽章、**2×2 指标网格**：<br>① 数据库集群与索引（平均延迟 14ms / 数据集 11-11 / 缺失索引 0 / 状态 就绪）<br>② OCS 实时计费引擎（余额不变量 100% / 活跃会话 56 / 在途预留 40 / 资费方案 2）<br>③ HSS 核心网与订阅者（鉴权凭证完整度 / 切片路由配置 / 模板失效引用 / 模板配置）<br>④ 安全治理与告警态势（超级管理员 已激活 / 未确认告警 0 / 系统用户 1） | **全部缺失**。仅剩一张居中的 `Subsystem Status` 卡（3 条：Data Persistence / Audit State / Active Alerts）+ 一个 `Diagnostic Findings` 空态 |

源码：参考 `app/(dashboard)/system-health/page.tsx` + `components/health/SubsystemCard.tsx` + `system-health.css`（102 条）；当前 `frontend/src/features/system-health/SystemHealthPage.tsx`（26.5 KB，业务逻辑保留但表现层重建为简化版）。

### 3.6 壳层差异

| 组件 | 参考 | 当前 | 判定 |
|---|---|---|---|
| **导航 Tab 栏** | 真实 **tab 模型**：可打开/关闭（每 tab 带 ×）、固定、溢出菜单 `…`、左右滚动按钮；tab 集合 = 已访问页面 | **静态导航条**：把 `getVisibleNavigation()` 的**全部 10 个路由**渲染为 pill 链接，无关闭/固定/溢出/滚动 | ❌ 架构级降级 |
| 侧栏条目 | 仪表盘 / 用户管理 / 计费管理(组) / 配置管理 / 系统设置(组) / 系统健康 —— **无 Rating 条目** | 额外多出 **`Rating`** 条目（点击后重定向到 `/ocs/tariffs`）与 `Inventory`（合法新增） | ⚠️ 多出 1 条死链 |
| 侧栏分组顺序 | 计费管理组：资费计划 → 签约用户 → 余额管理 | Online charging 组：Balances → Contracts → Tariff plans | ⚠️ 顺序/命名不一致 |
| 头部 | `NOC` 按钮、语言标签 `中文`、用户角色 `管理员` | `Sentinel`、`EN`、`Administrator` | ⚠️ 文案不一致 |
| 面包屑 | 路径 + 右侧动作：`最近访问` / `复制链接` / 刷新 | 仅路径，无动作 | ❌ 缺失 |
| 默认语言 | `navigator.language` 自动检测 | 硬编码 `en` | ❌ 行为不一致 |

---

## 4. 差异清单（分类）

### 4.1 缺失的页面/区块（P0）

| # | 缺失项 | 参考来源 | 目标位置 |
|---|---|---|---|
| G1 | 仪表盘：运营工作台 + 就绪度仪表 | `components/analytics/WorkbenchPanel.tsx` | `features/read/ReadPages.tsx` |
| G2 | 仪表盘：OCS 卡片行（流量池/语音池/短信池/活跃会话） | `analytics/OcsBalanceCapacityCard.tsx`、`OcsSessionTelemetryCard.tsx`、`OcsResourceStrip.tsx` | 同上 |
| G3 | 仪表盘：Top-5 消费者图 + 资费分布图 | `analytics/TopConsumerChart.tsx`、`TariffPlanDistributionChart.tsx`、`PlmnDistributionChart.tsx` | 同上 |
| G4 | 仪表盘：KPI 环形进度 | `analytics/KpiCard.tsx` | `components/ui/KpiCard.tsx` |
| G5 | 列表页汇总条 MetricStrip | `components/ui/MetricStrip.tsx` | 新增 |
| G6 | OCS 域统一壳 OcsPageShell（含只读横幅、KPI 网格、控件行） | `components/ocs/OcsPageShell.tsx` | 新增 |
| G7 | OCS 详情只读网格（`ocs-detail-grid/section/fields`） | `components/ocs/**` | `features/ocs/**` |
| G8 | 系统健康子系统矩阵（4 卡 × 2×2 指标） | `components/health/SubsystemCard.tsx` | `features/system-health/SystemHealthPage.tsx` |
| G9 | 表格分页/排序/状态行原语 | `ui/DataTablePagination`、`SortableTableHeader`、`DataTableState` | 新增 |
| G10 | 图表调色板 + 等价数据表 | `ui/chartPrimitives.tsx`、`ChartDataTable.tsx` | 新增 |
| G11 | 面包屑右侧动作（最近访问/复制链接/刷新） | `components/NavigationBreadcrumbs.tsx` | `app/components/NavigationBreadcrumbs.tsx` |
| G12 | 真实 tab 模型 | `components/NavigationTabBar.tsx` | `app/components/NavigationTabBar.tsx` |
| G13 | 用户详情抽屉（UserDrawer）+ 表格/工具栏模块样式 | `users/components/**` | `features/users/**` |
| G14 | Profile 编辑模式（PCC/会话/切片编辑器） | `components/profile/**` | `features/profiles/ProfilesPage.tsx` |
| G15 | 未保存离开保护 `UnsavedChangesGuard` | `ui/UnsavedChangesGuard.tsx` | 新增 |
| G16 | 内联提示 `InlineNotice`、`Field`、`IconButton`、`SectionHeader`、`RefreshButton`、`Dialog`+焦点管理 | `ui/**` | 新增 |

### 4.2 数据/交互缺陷（P0，独立于样式）

| # | 缺陷 | 位置 | 修法 |
|---|---|---|---|
| B1 | 表格流量列渲染 `[object Object]` | `features/subscribers/SubscribersPage.tsx:554` | 映射 `traffic.used/total` + 进度条 |
| B2 | 订阅用户数显示 `-`（字段名不匹配：读 `subscriber_count`，API 返回 `subscriberCount`） | `features/ocs/tariffs/TariffsPage.tsx:252`；同类 `BalancesPage.tsx:175`、`ContractsPage.tsx:245` | 改用契约字段名，并在契约测试中加字段名断言 |
| B3 | 时间戳显示原始 ISO 串 | 多个页面（`row.updated_at` / `created_at`） | 接入 `Intl.DateTimeFormat` 格式化 helper（阶段 3.6） |
| B4 | 默认语言硬编码 `en` | `providers/I18nProvider.tsx:7` | 回退到 `navigator.language`（与参考一致） |
| B5 | PLMN 分布图渲染为实心色块 | `features/read/ReadPages.tsx` | 改用 `chartPrimitives` + 正确的单分类渲染 |
| B6 | 侧栏多出 `/rating` 死链条目 | `lib/navigation.ts:getSidebarGroups` | 移除该条目 |
| B7 | 表格无排序能力 | 所有列表页 | 接入 `SortableTableHeader` |

### 4.3 样式缺失（P1）

见 §2.3 表格：需补回约 **2000 条** CSS 规则，按域拆分为独立样式层。

### 4.4 有意差异（**不要修**）

| 项 | 说明 |
|---|---|
| `/inventory` 系列路由 | 当前项目新增能力，参考项目无（返回 404）。保留。 |
| `/rating`、`/ocs/dashboard` 等 9 条重定向 | 参考项目同样是重定向桩。保留。 |
| `DataHub`、`VisualDiffViewer`、governance、`subscriber-trace-modal`、`SubscriberBatchUpdateModal` 等 | 依赖已退役的审批/差分/信令能力，`frontend-ui-restoration.md` 已判 `DO NOT PORT`。保留不移植。 |
| 工具类层 `utilities.css` | 可作为过渡层保留，但**页面不得再新增工具类用法**（见 §5.2 原则）。 |

---

## 5. 移植方案

### 5.1 总体策略

采用「**底座优先、由壳到页、逐页验收**」的四层递进：

```
阶段 1  样式底座        —— 按域还原 CSS 规则层（可独立验证：规则计数 + 选择器存在性）
   ↓
阶段 2  共享原语层      —— 移植 components/ui/**（可独立验证：单测 + 引用点）
   ↓
阶段 3  壳层对齐        —— tab 模型、侧栏、面包屑、语言（可独立验证：壳层几何 + 交互）
   ↓
阶段 4  页面级重建      —— 逐页把标记切回参考词表并接入原语（可独立验证：截图对照）
   ↓
阶段 5  验收门重建      —— 把自指契约测试替换为参考驱动契约
```

**关键原则**：不重写业务逻辑。当前项目的读/写契约、Go 注册集、RBAC、路由契约均已正确，移植只动**表现层（标记 + 样式 + 纯展示组件）**。这与 `AGENTS.md` §0.1「接口向前兼容」一致。

### 5.2 编码原则

1. **类名回迁**：页面标记改回参考词表（`container`、`dash-card`、`kpiGrid`、`ocs-*`、`profile-*`、`subscriber-*`、`health-*`）。工具类仅允许在过渡期残留，不得新增。
2. **视觉值一律走 token**：不硬编码颜色/间距/字号（与 `design-system-rules.md` §1 一致）。令牌层已对齐，无需改动。
3. **不新建与共享原语同义的组件**（`page-templates.md` §5）：KPI 条、分页、表格状态行、页头必须复用 阶段 2 的原语。
4. **丢弃 Ant Design 覆盖**：参考 `globals.css` 中的 `--ant-*` 令牌与 `.ant-*` 规则不移植（当前项目无 antd）。
5. **中英双语文案**：所有新增文案进 `lib/locales/{en,zh}.ts`，禁止 TSX 内硬编码兜底串。

---

## 6. 分步实施计划

### 阶段 1 — 样式底座（预计 10 个新文件，~2000 条规则）

| 步骤 | 涉及文件 | 修改内容 | 依赖 | 验证 |
|---|---|---|---|---|
| 1.1 | 新增 `frontend/src/styles/globals.css` | 从参考 `src/app/globals.css` 迁移：保留 `:root` 语义色板、字号阶、圆角、间距、阴影、动效、`.container`、`.dash-card`、`.animate-*`；**删除**全部 `--ant-*` / `.ant-*` / audit-diff 选择器 | — | `grep -c '{' globals.css` ≥ 240 |
| 1.2 | 新增 `frontend/src/styles/analytics.css` | 迁移参考 `components/analytics.css` 全部 248 条（`analytics-kpi-*`、`analytics-workbench-*`、`analytics-panel-*`、`analytics-ocs-*`、`analytics-plan-*`、`analytics-ring`、`analytics-sparkline`） | 1.1 | 规则数 ≥ 240 |
| 1.3 | 新增 `frontend/src/styles/ocs.css` | 迁移参考 `app/(dashboard)/ocs/ocs.css` 全部 212 条（`ocs-container`、`ocs-table-card`、`ocs-detail-*`、`ocs-kpi-*`、`ocs-resource-strip`、`ocs-quota-*`、`ocs-readonly-banner`、`ocs-modal-*`、`ocs-drawer-*`、`ocs-tabs-wrap`） | 1.1 | 规则数 ≥ 200 |
| 1.4 | 新增 `frontend/src/styles/subscribers.css` | 迁移参考 `app/(dashboard)/subscribers/subscribers.css`（105 条）+ `components/subscriber/subscriber.css`（137 条）+ `components/subscriber/rating-rule-link-panel.css`（22 条） | 1.1 | 规则数 ≥ 240 |
| 1.5 | 新增 `frontend/src/styles/profile.css` | 迁移参考 `app/(dashboard)/profile/profile.css`（45）+ `components/profile/profile.css`（132） | 1.1 | 规则数 ≥ 160 |
| 1.6 | 新增 `frontend/src/styles/system-health.css` | 迁移参考 `app/(dashboard)/system-health/system-health.css`（102） | 1.1 | 规则数 ≥ 100 |
| 1.7 | 新增 `frontend/src/styles/users.css` | 迁移参考 `users/components/{UsersTable,UsersToolbar,UserDrawer}.module.css`（79+32+110）+ `users/users.module.css` + `components/iam/iam.module.css`（16）。**去掉 `*.module.css` 的 CSS Modules 语义**，改为全局类名前缀 `users-*` / `iam-*` | 1.1 | 规则数 ≥ 220 |
| 1.8 | 新增 `frontend/src/styles/modals.css` | 迁移参考 `components/modals.css`（133）+ `SubscriberModal.css`（10）+ `OperationFeedback.css`（73）+ `CommandPalette.css`（40）+ `NocSentinel.css`（61）+ `login/LoginForm.css`（42） | 1.1 | 规则数 ≥ 350 |
| 1.9 | 修改 `frontend/src/styles/shell.css` | 补齐相对参考 `layout.css`（247）缺失的约 20 条：tab 模型（`nav-tab-close`/`nav-tab-pin-icon`/`nav-tab-dropdown`/`nav-tab-scroll-btn`/`nav-tab-menu-btn`）、面包屑动作（`nav-crumb-tool-btn`/`nav-recent-*`） | — | `grep -c '{' shell.css` ≥ 245 |
| 1.10 | 修改 `frontend/src/styles/app.css` | 汇总 `@import` 顺序：`tokens → base → utilities → shell → components → globals → analytics → ocs → subscribers → profile → system-health → users → modals → pages` | 1.1–1.9 | `npm run build` 通过；无重复 `:root` |
| 1.11 | 删除 `frontend/src/styles/pages.css` 中的 `.read-*` / `.analytics-*` 重复片段 | 迁移完成后移除，避免双权威 | 1.2–1.8、阶段 4 | `grep -rc 'read-page' src/styles` = 0 |

**阶段 1 出口条件**：`cat frontend/src/styles/*.css | grep -c '{'` ≥ **2500**；`npm run build` 通过；`npx tsc -b` 通过。

---

### 阶段 2 — 共享 UI 原语层（16 个新文件）

| 步骤 | 涉及文件 | 修改内容 | 依赖 | 验证 |
|---|---|---|---|---|
| 2.1 | 新增 `frontend/src/components/ui/MetricStrip.tsx` | 从参考移植 `cards` / `strip` 两个变体（`--metric-card-count`、`--metric-count`、`tone`、`accent`、`indicator`、`detail`、`compactValue`、`onClick`/`active`/`aria-pressed`） | 阶段 1 | 单测：渲染列数、`data-columns`、点击态 |
| 2.2 | 新增 `ui/DataTablePagination.tsx` | 范围摘要 `aria-live="polite"`、页大小 `10/20/50/100`、边界禁用、变更后回第 1 页 | 2.1 | 单测：边界、页大小、回页 |
| 2.3 | 新增 `ui/SortableTableHeader.tsx` | 真实 `<button>` + `aria-sort` | — | 单测：三态循环 |
| 2.4 | 新增 `ui/DataTableState.tsx` | `loading`/`empty`/`error` 行，`role=status`/`alert` + `aria-live` | — | 单测：三态语义 |
| 2.5 | 新增 `ui/InlineNotice.tsx` | 内联提示（`info`/`success`/`warning`/`error`） | — | 单测 |
| 2.6 | 新增 `ui/chartPrimitives.tsx` + `ui/ChartDataTable.tsx` | 图表调色板 `--chart-*`、网格/tooltip 令牌；每图提供等价数据表 | 阶段 1 | 单测：分类色板仅用于图表标记 |
| 2.7 | 新增 `ui/SectionHeader.tsx`、`ui/RefreshButton.tsx`、`ui/IconButton.tsx` | 区块标题、刷新、图标按钮 | — | 引用点检查 |
| 2.8 | 新增 `ui/Dialog.tsx` + `ui/useDialogFocus.ts` | 弹窗原语 + 焦点陷阱；**保留**现有 `components/Modal.tsx` 作为兼容包装（向前兼容） | — | 单测：焦点循环、Esc 关闭 |
| 2.9 | 新增 `ui/Field.tsx`、`ui/UnsavedChangesGuard.tsx` | 表单控件、未保存离开保护 | 2.8 | 单测 |
| 2.10 | 修改 `frontend/src/components/ui/PageHeader.tsx` | 对齐参考 props：`eyebrow`（含 tone/dot）/ `icon` / `title` / `description` / `actions` | — | 单测 + 引用点 |
| 2.11 | 新增 `frontend/src/components/ocs/OcsPageShell.tsx` | OCS 域统一壳：`container ocs-container` → `PageHeader`（只读徽章 + 刷新）→ 只读横幅 → `kpiGrid` → `controls` → `dash-card ocs-table-card` → `children` | 2.1–2.9 | 单测：区块顺序 |
| 2.12 | 新增 `frontend/src/components/health/SubsystemCard.tsx` | 子系统卡：名称、副标题、健康徽章、2×2 指标网格 | 2.1 | 单测 |

**阶段 2 出口条件**：每个原语至少被 1 个页面引用；`npm test` 通过。

---

### 阶段 3 — 壳层对齐

| 步骤 | 涉及文件 | 修改内容 | 依赖 | 验证 |
|---|---|---|---|---|
| 3.1 | 修改 `app/components/NavigationTabBar.tsx` | 从「静态路由 pill 条」改为**真实 tab 模型**：tab 集合 = 已访问路由（会话内），支持关闭（×）、固定、溢出菜单 `…`、左右滚动；保留 `nav-tab-bar` 根类 | 1.9 | 截图对照 + 交互测试（打开/关闭/溢出） |
| 3.2 | 修改 `lib/navigation.ts` | `getSidebarGroups` 移除 `/rating` 条目；OCS 子项顺序改为 `tariffs → contracts → balances`；分组键与参考一致 | — | 单测：条目清单与参考一致 |
| 3.3 | 修改 `app/components/AppSidebar.tsx` | 对齐分组渲染顺序；确认折叠态 264/72 与 tooltip | 3.2 | 截图对照 |
| 3.4 | 修改 `app/components/AppHeader.tsx` | 文案/图标对齐：`NOC`（非 `Sentinel`）、语言标签随 locale、角色标签随 locale | — | 截图对照 |
| 3.5 | 修改 `app/components/NavigationBreadcrumbs.tsx` | 增加右侧动作区：`最近访问`（会话内最近路由）、`复制链接`、`刷新`；保留 `nav-breadcrumbs-bar` 与 `aria-current` | 1.9 | 截图对照 + 交互 |
| 3.6 | 修改 `providers/I18nProvider.tsx` | `initialLocale()` 回退改为 `navigator.language` 前缀判断（`zh*` → `zh`，否则 `en`）；新增 `Intl.DateTimeFormat` 格式化 helper（绝对/相对时间） | — | 单测：locale 回退；页面时间戳格式化 |
| 3.7 | 修改 `lib/locales/{en,zh}.ts` | 补齐 阶段 3/4 新增文案键（tab 模型、面包屑动作、页头 eyebrow、指标标签、表头） | — | 单测：两语言键集合相等 |

**阶段 3 出口条件**：壳层截图与参考逐项一致（侧栏条目、tab 行为、面包屑动作、头部文案、默认语言）。

---

### 阶段 4 — 页面级重建（按页面独立提交，每页可独立验收）

统一动作模式（每页）：① 标记切回参考词表 → ② 接入 阶段 2 原语 → ③ 修数据映射 → ④ 截图对照。

| 步骤 | 涉及文件 | 关键修改 | 依赖 |
|---|---|---|---|
| 4.1 仪表盘 | `features/read/ReadPages.tsx`、`features/read/dashboard-model.ts`、`components/ui/KpiCard.tsx` | 6 张 KPI 卡（含环形进度）；新增运营工作台 + 就绪度仪表；新增 OCS 卡片行；图表改为 Top-5 消费者 + 资费分布（用 `chartPrimitives`）；修 PLMN 图缺陷 | 阶段 1–3 |
| 4.2 用户管理 | `features/subscribers/SubscribersPage.tsx` | 加 MetricStrip 汇总条（可点击状态筛选）；工具栏改为参考按钮集；表格列顺序/表头/排序；**修 `[object Object]`**；流量进度条；相对时间；行操作图标集 | 4.1、2.1–2.4 |
| 4.3 OCS 资费 | `features/ocs/tariffs/TariffsPage.tsx`、`TariffDetailPage.tsx` | 接入 `OcsPageShell`；KPI 网格；表格补「更新人」；**修 `subscriber_count` → `subscriberCount`（B2）**；时间格式化；`ocs-detail-grid` 详情 | 4.2、2.11 |
| 4.4 OCS 合同 | `features/ocs/contracts/ContractsPage.tsx`、`ContractDetailPage.tsx` | 同上（`OcsContractsPanel` / `OcsContractDetail` 词表） | 4.3 |
| 4.5 OCS 余额 | `features/ocs/balances/BalancesPage.tsx`、`BalanceDetailPage.tsx` | 同上 + `AdjustBalanceModal` 视觉还原（`ocs-modal-*`） | 4.3 |
| 4.6 系统健康 | `features/system-health/SystemHealthPage.tsx` | 重建「核心子系统健康矩阵」：4 张 `SubsystemCard` × 2×2 指标网格；页头 eyebrow/描述/动作对齐 | 阶段 2 |
| 4.7 用户管理（系统） | `features/users/UsersPage.tsx`、`UserDetailPage.tsx`、`UserCreatePage.tsx` | 迁移 `users-*` 表格/工具栏/抽屉；表单接入 `Field` + `UnsavedChangesGuard`；详情页徽章与动作层级 | 阶段 2 |
| 4.8 Profile | `features/profiles/ProfilesPage.tsx` | 迁移 profile 表 + 编辑模式（PCC/会话/切片编辑器）词表；接入 `UnsavedChangesGuard` | 阶段 2 |
| 4.9 登录 | `auth/LoginPage.tsx` | 品牌区（大图形标 + 标题 + 副标题）、居中版式、输入框内图标、框内眼睛、页脚；默认语言跟随浏览器 | 3.6 |
| 4.10 库存（新增页） | `features/inventory/**` | 无参考实现，用 阶段 2 原语 + 回迁词表统一视觉（`page-templates.md` §4 第 6 条） | 阶段 2 |

**阶段 4 出口条件**：`.workbuddy-ai/reports/ui-parity/current/*` 与 `original/*` 逐页对照，区块/列/文案/动作全部对齐（库存页除外）。

---

### 阶段 5 — 验收门重建

| 步骤 | 涉及文件 | 修改内容 | 验证 |
|---|---|---|---|
| 5.1 | 新增 `scripts/test-ui-parity-contract.mjs` | **参考驱动**契约：读取参考 checkout（`2c40903`）的 `frontend/src`，断言：① 参考类名词表覆盖率 ≥ 95%；② 每域 CSS 规则数 ≥ 参考的 95%；③ `components/ui` 原语清单齐备；④ 每页必需区块（由参考 JSX 提取）存在 | 修复前应 **FAIL**，修复后 PASS |
| 5.2 | 修改 `scripts/test-ui-restoration-contract.mjs` | 删除自指断言（UI-19、UI-27 等），改为引用 5.1 的参考基准；保留架构类断言（UI-01…UI-07、UI-34…UI-35） | 全绿 |
| 5.3 | 新增 `scripts/capture-ui-parity.mjs` | 固化截图 harness（参数化 `--base` / `--out` / `--token`），纳入 CI 证据产物 | 生成 50 张截图 |
| 5.4 | 新增 `frontend/tests/ui-parity.test.ts` | 前端侧单测：原语契约、页面区块存在性、数据映射（B1/B2/B3 回归） | `npm test` 通过 |
| 5.5 | 修改 `docs/architecture/frontend-ui-restoration.md` | 状态从 `IMPLEMENTED` 更正为 `PARTIAL`，指向本文档；补记遗漏项 | 文档一致性检查 |

---

## 7. 依赖关系图

```
阶段 1 样式底座 ──┬─> 阶段 2 原语层 ──┬─> 阶段 4 页面重建 ──> 阶段 5 验收门
                   │                     │
                   └─> 阶段 3 壳层 ─────┘
                                        │
        (3.6 语言/时间格式化) ───────────┴─> 4.3/4.4/4.5 时间戳、4.9 登录默认语言
```

- 阶段 1 与 阶段 2 可并行（2 依赖 1.1 的 token，而 token 已对齐，实际风险低）。
- 阶段 3 与 阶段 2 可并行（3.1 tab 模型依赖 1.9 的样式）。
- 阶段 4 各页之间**互相独立**，可并行；每页依赖对应域样式（阶段 1）+ 原语（阶段 2）。
- 阶段 5 必须在 阶段 4 之后（作为验收）。

---

## 8. 验收标准

移植完成的判定（全部满足）：

1. **类名词表**：参考项目 `frontend/src` 的 JSX 类名词表中，除 §4.4「有意差异」外，覆盖率 ≥ **95%**。
2. **样式规则**：`frontend/src/styles/*.css` 规则总数 ≥ **2500**；各域规则数 ≥ 参考的 95%。
3. **共享原语**：`components/ui` 含参考清单的全部原语（去掉 antd 相关）；每页不得自造同义组件。
4. **逐页截图**：`.workbuddy-ai/reports/ui-parity/` 下 original/current 逐页对照，区块、列、表头、文案、动作、状态药丸一致。
5. **数据正确性**：无 `[object Object]`；无 `-` 占位（除确实缺失）；时间戳走 `Intl.DateTimeFormat`；表格可排序、可分页。
6. **壳层**：tab 可开/关/固定/溢出；侧栏无 `/rating` 死链；面包屑含 3 个动作；默认语言跟随浏览器。
7. **门禁**：`scripts/test-ui-parity-contract.mjs`、`frontend/tests/ui-parity.test.ts`、`npm run check` 全绿。
8. **零业务回归**：Go 注册集仍为 90；路由契约不变；读写契约与 RBAC 行为不变；`npm run local:preflight` 通过。

---

## 9. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| CSS 规则大规模回迁引发视觉回归 | 中 | 按域分文件、分提交；每域落地即截图对照 |
| 参考 `globals.css` 含 antd 覆盖，误移植会污染 | 中 | 明确排除 `--ant-*` / `.ant-*`；用 `grep -c ant` 断言为 0 |
| `*.module.css` 迁移到全局类名可能冲突 | 中 | 统一加域前缀（`users-`/`iam-`）；`app.css` 单一 `@import` 顺序 |
| 工具类层与域词表并存导致「双权威」 | 中 | 阶段 1.11 清理 `.read-*`；禁止新增工具类用法 |
| tab 模型改造触及壳层状态 | 中 | 保留 `nav-tab-bar` 根类与 `getVisibleNavigation` 过滤；tab 状态为会话级，不引入持久化权威 |
| 阶段 5 门禁过严阻塞开发 | 低 | 覆盖率阈值分阶段提升（80% → 95%） |
| 参考项目工作树有 38 处未提交改动 | 低 | 参考源锁定为 commit `2c40903` 而非工作树；`git show 2c40903:<path>` 取源 |

---

## 10. 附：证据清单

| 产物 | 路径 |
|---|---|
| 截图（参考） | `.workbuddy-ai/reports/ui-parity/original/*.png`（25 张） |
| 截图（当前） | `.workbuddy-ai/reports/ui-parity/current/*.png`（25 张） |
| 视口壳层截图 | `.workbuddy-ai/reports/ui-parity/{original,current}-viewport-subscribers.png` |
| 采集报告（路由/重定向/文本长度） | `.workbuddy-ai/reports/ui-parity/capture-report.json` |
| 采集脚本（临时） | `.workbuddy-ai/tmp/capture.mjs`、`.workbuddy-ai/tmp/probe.mjs` |

> 证据目录刻意放在 `.workbuddy-ai/` 下：该目录已由 `.git/info/exclude` 的 `.workbuddy-*` 规则排除，因此截图证据**不会被提交到远端仓库**。
> 原 `reports/`（含 `reports/ops/` 与 `reports/ui-parity/`，共 67 个文件）已整体迁移至 `.workbuddy-ai/reports/`。
> 注意：`scripts/lib/ops-report.mjs` 的默认输出目录仍是 `reports/ops`，下次运行运维脚本时会重新创建该目录（该路径已在 `.gitignore` 中，不会产生未跟踪文件）。

---

## 11. 实施记录

### 阶段 1 — 样式底座 ✅ 已完成

**新增样式文件（11 个，均标注来源与参考 commit）**

| 文件 | 规则数 | 参考来源 |
|---|---|---|
| `frontend/src/styles/globals.css` | 301 | `app/globals.css`（319，去掉 antd 4 条 + 工具类重复 14 条） |
| `frontend/src/styles/analytics.css` | 248 | `components/analytics.css` |
| `frontend/src/styles/ocs.css` | 212 | `app/(dashboard)/ocs/ocs.css` |
| `frontend/src/styles/subscribers.css` | 264 | `subscribers/subscribers.css` + `subscriber/subscriber.css` + `subscriber/rating-rule-link-panel.css` |
| `frontend/src/styles/profile.css` | 177 | `app/(dashboard)/profile/profile.css` + `components/profile/profile.css` |
| `frontend/src/styles/system-health.css` | 102 | `app/(dashboard)/system-health/system-health.css` |
| `frontend/src/styles/modals.css` | 143 | `components/modals.css` + `components/SubscriberModal.css` |
| `frontend/src/styles/feedback.css` | 73 | `components/OperationFeedback.css` |
| `frontend/src/styles/command-palette.css` | 40 | `components/CommandPalette.css` |
| `frontend/src/styles/noc-sentinel.css` | 61 | `components/NocSentinel.css` |
| `frontend/src/styles/login.css` | 42 | `app/login/LoginForm.css` |
| `frontend/src/styles/modules/*.module.css` | 238 | `users/components/{UsersTable,UsersToolbar,UserDrawer}.module.css` + `users/users.module.css` + `components/iam/iam.module.css` |

**修改文件**

- `frontend/src/styles/shell.css` — 228 → **273** 条规则。追加 tab 模型（`nav-tab-close` / `nav-tab-pin-icon` / `nav-tab-dropdown` / `nav-tab-scroll-btn` / `nav-tab-menu-btn` / `nav-tab-link.pinned` / `nav-tab-actions-wrap`）、面包屑动作（`nav-crumb-tool-btn` 及变体）、最近访问下拉（`nav-recent-*`）、`skip-link`、`.app-sidebar.collapsed .sidebar-link:hover .sidebar-tooltip`、`.sidebar-parent-button:focus-visible`、`.command-dropdown`、`.dropdown-item:active`、`.hover-glass.lang-switcher` 等 42 条。
- `frontend/src/styles/app.css` — 重排 `@import`：当前层（`tokens → base → shell → components → pages → utilities`）在前，参考层（`globals → analytics → ocs → subscribers → profile → system-health → feedback → command-palette → noc-sentinel → modals → login`）在后，使参考规则在其拥有的类名上取胜。

**与计划的两处偏差（均为降低风险）**

1. **`styles/modules/` 保留 CSS Modules，未做「去模块化 + 加前缀」。** 计划 §1.7 要求把 `*.module.css` 转成全局类名并加 `users-*` / `iam-*` 前缀；但 Vite 原生支持 CSS Modules，逐字复制即可获得零改名风险与完全一致的行为，而这正是计划 §9 自己列出的风险项（「`*.module.css` 迁移到全局类名可能冲突」）。故改为原样保留。
2. **`modals.css` 未合并 login / NOC / command palette。** 计划 §1.8 把六个来源合并进 `modals.css`；实际拆为 `modals.css`(143) / `feedback.css`(73) / `command-palette.css`(40) / `noc-sentinel.css`(61) / `login.css`(42)，共 359 条（与计划目标一致），避免把登录页与 NOC 样式塞进一个名为 modals 的文件。

**关键冲突处置**

- 参考 `globals.css` 的 `.grid { display: grid; gap: 1.5rem }` 会给当前所有页面网格注入 1.5rem 隐式间距（且 `gap` 无法被 `utilities.css` 的 `.grid { display: grid }` 覆盖）。故**不移植参考的工具类区块**（`.grid` / `.flex` / `.gap-*` / `.mt-*` / `.mb-4` 等 14 条），工具类继续由 `utilities.css` 独占；仅保留 `.container` 及其 `max-width: 980px` 媒体查询。
- 排除 Ant Design（`--ant-*` 令牌 + `.ant-table-*` 规则，共 4 条）与 audit-diff 选择器（`.inspect-diff-btn`），与计划一致。
- 有意不恢复 `.notif-settings-drawer` / `.notif-desktop-btn` / `.notif-vol-slider` / `.notif-setting-row` / `.notif-center-menu`，与 `frontend-ui-restoration.md` 已记录的「通知中心偏好不恢复」保持一致。
- 未恢复 `.approval-*`（26 条），对应已退役的审批队列。

**阶段 1 出口验证**

| 判据 | 结果 |
|---|---|
| `styles/` 规则总数 ≥ 2500 | ✅ **2605**（全局 2367 + CSS Modules 238） |
| 无 antd 残留 | ✅ 仅 globals.css 头部注释提及（说明为何排除） |
| 无遗留 `@import` / CSS 嵌套 / `@layer` | ✅ 无 |
| `npm run build`（`tsc -b && vite build`） | ✅ 通过；CSS 产物 101 KB → 246.5 KB |
| `npm test` | ✅ 82/82 通过 |
| `scripts/test-ui-restoration-contract.mjs` | ✅ PASS |
| 运行时目视检查 | ✅ 侧栏 / tab 栏 / KPI 卡 / 表格 / 登录页均正常，无布局崩坏 |

**截图证据**：`.workbuddy-ai/tmp/stage1/*.png`（dashboard / subscribers / system-health / ocs-tariffs / users / profile / login）。

**下一步**：阶段 2（共享 UI 原语层），依赖已满足（阶段 1 的 token 与样式层已就位）。

### 阶段 2 — 共享 UI 原语层 ✅ 已完成

**新增原语（17 个，均带来源标注）**

| 原语 | 路径 | 导出形式 |
|---|---|---|
| `MetricStrip` | `components/ui/MetricStrip.tsx` | default + `MetricStripItem` 类型 |
| `DataTablePagination` | `components/ui/DataTablePagination.tsx` | named |
| `SortableTableHeader` | `components/ui/SortableTableHeader.tsx` | named |
| `DataTableStateRow` | `components/ui/DataTableState.tsx` | named |
| `InlineNotice` / `ErrorNotice` | `components/ui/InlineNotice.tsx` | named |
| `ChartDataTable` | `components/ui/ChartDataTable.tsx` | named |
| `chartPrimitives`（调色板 + `ChartSummary`） | `components/ui/chartPrimitives.tsx` | named |
| `SectionHeader` | `components/ui/SectionHeader.tsx` | default |
| `RefreshButton` | `components/ui/RefreshButton.tsx` | default |
| `IconButton` | `components/ui/IconButton.tsx` | named |
| `Dialog` + `useDialogFocus` | `components/ui/Dialog.tsx`、`useDialogFocus.ts` | named |
| `Field` | `components/ui/Field.tsx` | named |
| `UnsavedChangesDialog` / `useUnsavedChangesGuard` | `components/ui/UnsavedChangesGuard.tsx` | named |
| `PageHeader` | `components/ui/PageHeader.tsx` | default（参考实现）+ named（兼容适配器） |
| `OcsPageShell` | `components/ocs/OcsPageShell.tsx` | default |
| `SubsystemCard` + `SubsystemMetric` | `components/health/SubsystemCard.tsx` | default + 类型 |

**新增 CSS Modules（8 个，逐字复制）**：`ChartDataTable`(11) / `ConsolePrimitives`(73) / `DataTablePagination`(13) / `DataTableState`(3) / `Field`(5) / `InlineNotice`(7) / `SortableTableHeader`(8) / `UnsavedChangesGuard`(12)，置于 `frontend/src/styles/modules/`。

**修改文件**

- `frontend/src/vite-env.d.ts`（新增）— `/// <reference types="vite/client" />`。**必须**：Vite 的 client 类型声明了 `*.module.css` 的形状；缺失时 `tsc -b` 对每个 CSS-module 导入报 TS2307。
- `frontend/tests/ui-primitives.test.ts`（新增）— 原语契约测试。
- `frontend/package.json` — `test` 脚本纳入新测试。
- `frontend/src/components/ui/PageHeader.tsx` — 重写为「default = 参考实现 + named = 兼容适配器」。

**移植手法**

参考原语几乎全部框架无关（仅 `UnsavedChangesGuard` 依赖 `next/navigation`）。因此采用脚本化移植：删除 `"use client"` 指令、把 `./X.module.css` 重指向 `../../styles/modules/X.module.css`、加来源头注释；`@/` 别名在 `OcsPageShell` 中改为相对路径。唯一逻辑改动是 `useRouter().push()` → `useNavigate()`。

**关键决策**

1. **CSS Modules 不放在组件旁，统一置于 `styles/modules/`**，与 阶段 1 的 users/iam 模块保持一致，形成单一规则「所有 CSS 都在 `src/styles/` 下」。代价是导入路径变成 `../../styles/modules/...`。
2. **`PageHeader` 保持向后兼容**（AGENTS.md §0.1 要求不得随意删除既有接口）：default 导出为参考实现；named 导出 `PageHeader` 接受旧的 `subtitle` 属性并映射到参考的 `description`。`ReadPages.tsx` 无需改动即可继续工作，同时立刻获得参考样式 —— 这同时**端到端验证了 CSS Module 管线**。
3. **阶段 2 出口条件由「每原语被页面引用」调整为「原语契约测试」**。计划原定的判据在本阶段无法满足（页面改写在 阶段 4），若强行满足就必须提前改页面，会打乱阶段边界。改为 `ui-primitives.test.ts` 断言：原语文件与导出齐备、无 `next/`/`use client`/`@/` 残留、每个 CSS-module 导入可解析、8 个模块文件非空、`PageHeader` 双导出兼容。页面级采纳改由 阶段 5 的对等契约断言。

**阶段 2 出口验证**

| 判据 | 结果 |
|---|---|
| 原语清单齐备 | ✅ 17 个原语 + 8 个 CSS Module |
| 无 Next.js 运行时耦合 | ✅ 契约测试断言 0 处 `next/`、`use client`、`@/` |
| `npx tsc -b` | ✅ 通过（新增 `vite-env.d.ts` 后） |
| `npm run build` | ✅ 通过 |
| `npm test` | ✅ **89/89**（新增 7 条原语契约测试） |
| `scripts/test-ui-restoration-contract.mjs` | ✅ PASS |
| CSS Module 管线端到端 | ✅ 仪表盘页头已渲染参考 `pageHeader` 样式（截图 `.workbuddy-ai/tmp/stage2/dashboard.png`） |
| `styles/` 规则总数 | 2737（全局 2367 + modules 370） |

**下一步**：阶段 3（壳层对齐）—— 真实 tab 模型、侧栏条目、面包屑动作、默认语言。

### 阶段 3 — 壳层对齐 ✅ 已完成

**修改文件**

| 文件 | 修改内容 |
|---|---|
| `app/components/NavigationTabBar.tsx` | 50 → 297 行。由「静态路由 pill 条」重写为参考的**已访问 tab 模型**：`localStorage`（`XCLOUD_OPEN_TABS`）持久化、首页固定（pin）、逐 tab 关闭、关闭其他 / 关闭全部溢出菜单、左右滚动、角色变更后权限清理（`nav_tab_permissions_cleaned`）。同时导出 default 与 named，兼容既有 `AppShell` 导入。 |
| `app/components/NavigationBreadcrumbs.tsx` | 36 → 251 行。新增右侧动作簇：最近访问下拉（`XCLOUD_RECENT_PAGES`，最多 8 条，可清空）、复制链接、刷新。保留 `getBreadcrumbs` 派生与 `nav-breadcrumbs-bar` / `aria-current` 契约。 |
| `lib/navigation.ts` | 新增 `resolveNavigationRoute`（规范化尾部斜杠后做最长前缀匹配）与 `canAccessNavigationRoute`（由可见路由集派生，单一权威）。`getSidebarGroups` 移除 `/rating` 死链条目，OCS 子项按 `tariffs → contracts → balances` 规范排序。6 个路由的 `labelKey` 对齐参考命名（见下）。 |
| `providers/I18nProvider.tsx` | 23 → 135 行。语言回退由硬编码 `en` 改为跟随 `navigator.language`（`zh*` → `zh`）；新增 `formatNumber` / `formatDateTime` / `formatRelativeTime` 与 `isZh` / `isEn` / `dir`；保留旧 API（`locale` / `setLocale`）并补充参考命名（`lang` / `setLang` / `toggleLang`）。 |
| `lib/locales.ts` | **架构性修复**（见下）。 |
| `app/components/NocSentinel.tsx` | 按钮文案改为参考的字面量 `NOC`；面板标题改用 `noc_panel_title`。 |
| `features/{subscribers,read}/…`、`app/components/UserMenu.tsx` | 跟随 `labelKey` 重命名的调用点更新。 |
| `tests/shell-contract.test.ts` | 新增 7 条 阶段 3 契约测试。 |
| `tests/ui-restoration.test.ts` | 断言更新为参考 `labelKey`；新增「侧栏不得暴露 Rating 条目」与 OCS 子项**顺序**断言。 |
| `scripts/test-ui-restoration-contract.mjs` | UI-13 由「必须包含 `getVisibleNavigation`」放宽为「包含 `getVisibleNavigation` **或** `canAccessNavigationRoute`」（与 UI-12 的既有交替风格一致），并新增 UI-13b 断言已访问 tab 模型（持久化 + 关闭 + 滚动 + 溢出）。 |

**关键修复：词典从未接线（dead dictionary）**

排查 阶段 3 文案时发现一个根因级缺陷：`lib/locales.ts` 原本是一份**手写的 130 键扁平词典**，而 `lib/locales/en.ts` / `zh.ts`（各 **2203 键**，参考 UI 的全部文案）**完全没有被 `I18nProvider` 引用**——是死代码。因此参考命名键（`nav_tab_workspace`、`nav_crumb_recent_btn`、`nav_ocs_tariffs`…）在运行时会原样渲染成键名。

修复方式（零回归）：`lib/locales.ts` 改为合并两源——参考词典优先，旧的 `LEGACY_*` 仅补缺口：

```ts
export const en = { ...LEGACY_EN, ...referenceEn };
export const zh = { ...LEGACY_ZH, ...referenceZh };
```

- 参考词典在重叠键上取胜 → 文案回归参考措辞（如 `nav_ocs` 由 `Online charging` 变为参考的 `Charging Management` / 计费管理）。
- 旧词典独有的 55 个键保留 → 无任何调用点失效。
- 同时补齐参考风格的 `SUPPORTED_LOCALES` / `DEFAULT_LOCALE` / `LOCALES` / `LocaleMeta` 导出。

**路由标签键对齐参考**

| 旧键 | 新键（参考） | zh 文案变化 |
|---|---|---|
| `nav_tariffs` | `nav_ocs_tariffs` | 资费套餐 → **资费计划** |
| `nav_contracts` | `nav_ocs_contracts` | 合约 → **签约用户** |
| `nav_balances` | `nav_ocs_balances` | 余额 → **余额管理** |
| `nav_subscribers` | `nav_subscriber` | 用户 → **用户管理** |
| `nav_users` | `nav_system_users` | 用户管理 → 用户管理（EN 由 Users → User Management） |
| `nav_health` | `nav_system_health` | 系统健康（EN 大小写对齐） |

**阶段 3 出口验证（运行时实测，非推断）**

| 判据 | 参考期望 | 实测 |
|---|---|---|
| 默认语言 | 跟随浏览器 | ✅ `htmlLang=zh-CN`（此前恒为 `en`） |
| 头部 NOC 按钮 | `NOC` | ✅ `NOC`（此前 `Sentinel`） |
| 语言切换器 | `中文` | ✅ `中文` |
| 角色标签 | `管理员` | ✅ `admin / 管理员` |
| 面包屑动作 | 最近访问 / 复制链接 / 刷新 | ✅ `最近访问`、`复制链接`（此前渲染为原始键名） |
| Tab 模型 | 已访问页集合 | ✅ `tabCount=2`，`["仪表盘","用户管理"]`（此前为 10 条静态路由） |
| 侧栏条目 | 无 Rating，OCS 顺序 tariffs→contracts→balances | ✅ 仪表盘 / 用户管理 / 计费管理(资费计划,签约用户,余额管理) / 配置管理 / 系统设置(用户管理) / 系统健康 / 资源清单 |
| `tsc -b` / `npm run build` | 通过 | ✅ |
| `npm test` | 通过 | ✅ **96/96**（+7） |
| `test-ui-restoration-contract.mjs` | PASS | ✅ |
| `test-agent-docs-parity.mjs` | PASS | ✅ |

**截图证据**：`.workbuddy-ai/tmp/stage3/shell-subscribers.png`、`shell-dashboard.png`。侧栏、tab 栏、面包屑、头部与参考逐项一致。

**本阶段未做（留给 阶段 4）**：页面内容层仍为旧实现 —— 订阅者页 eyebrow 为硬编码英文 `GOVERNED SUBSCRIBER MANAGEMENT`、TRAFFIC 列仍渲染 `[object Object]`、表头/列集与参考不同、时间戳仍为原始 ISO 串。

**下一步**：阶段 4（页面级重建），从 4.1 仪表盘开始。

### 阶段 4 — 页面级重建

#### 4.1 仪表盘（Analytics Cockpit）✅ 已完成

**新增文件（15 个，均带来源标注）**

| 路径 | 说明 |
|---|---|
| `lib/unitParser.ts` | 参考的纯工具模块（`formatBytes` / `formatSeconds` / `formatEvents` / `parse*` 等），无框架依赖，逐字移植 |
| `components/analytics/{types,utils}.ts` | 指标类型与 `BYTES_IN_GB` / `formatGb` / `computeHourlyBurnGb` / `normalizeRingValue` |
| `components/analytics/CountUpNumber.tsx` | 数字滚动 |
| `components/analytics/EmptyChartState.tsx` | 图表空态 |
| `components/analytics/KpiCard.tsx` | KPI 卡（含 sparkline） |
| `components/analytics/SkeletonDashboard.tsx` | 骨架屏 |
| `components/analytics/WorkbenchPanel.tsx` | 运营工作台 + 就绪度仪表 |
| `components/analytics/OcsBalanceCapacityCard.tsx` | 余额容量卡 |
| `components/analytics/OcsResourceStrip.tsx` | 资源条（流量池 / 语音池 / 短信池 / 活跃会话） |
| `components/analytics/OcsSessionTelemetryCard.tsx` | 会话遥测卡 |
| `components/analytics/PlmnDistributionChart.tsx` | PLMN 分布图（饼图） |
| `components/analytics/TopConsumerChart.tsx` | Top-5 流量消耗用户 |
| `components/analytics/TariffPlanDistributionChart.tsx` | 资费计划采纳分布 |
| `components/AnalyticsCockpit.tsx` | 编排器（348 行） |

**修改文件**

- `features/read/ReadPages.tsx` — `DashboardPage` 由自建的 KPI/图表/面板堆叠改为参考组合（`container animate-fade-in` + 参考 `PageHeader` + `AnalyticsCockpit`）。保留全部向后兼容导出（各业务页 re-export、`ReadBarChart`、`text`）。
- `scripts/test-ui-restoration-contract.mjs` — UI-19/UI-20/UI-21 由「断言自建类名」改为**参考组合契约**：编排器渲染 MetricStrip + WorkbenchPanel + OcsResourceStrip + TopConsumerChart + TariffPlanDistributionChart；状态为 SkeletonDashboard + 离线态 + 空图表态；并断言编排器读取的是四个既有只读契约（`/api/analytics/metrics`、`/api/analytics/sparkline`、`/api/alerts`、`/api/ocs/subscribers`）。UI-22 的假数据扫描扩展到编排器。
- `frontend/tests/ui-restoration.test.ts`、`tests/ui-primitives.test.ts` — 断言更新为参考组合。

**移植手法**：脚本化移植（去 `"use client"`、去本地 `analytics.css` import、`next/link` → react-router `Link` 且 `href=` → `to=`、`@/` 别名改相对路径、`ConsolePrimitives.module.css` 指向 `styles/modules/`）。唯一人工修正：react-router 的 `Link` 是**具名导出**，脚本保留的默认导入需改为 `import { Link }`。

**出口验证**

| 判据 | 结果 |
|---|---|
| `npx tsc -b` | ✅ |
| `npm run build` | ✅ |
| `npm test` | ✅ **96/96** |
| `test-ui-restoration-contract.mjs` | ✅ PASS（UI-19/20/21/22 全绿） |
| 截图对照 | ✅ 与参考仪表盘**逐项一致**：6 张带环形进度的 KPI 卡（100/13/100/100/0/100，与参考数值完全相同）、运营工作台 + 就绪度 92、OCS 资源条（101 GB 总分配 / 0-600 分钟 / 0-1,000 条 / 56 active·3187 total）、Top-5 消费者图 + 资费分布图 |

截图：`.workbuddy-ai/tmp/stage4/dashboard.png`。

**未做**：`features/read/dashboard-model.ts` 保留未删（`ReadBarChart` 与既有测试仍引用其导出），但 `DashboardPage` 已不再使用 `buildDashboardModel`。该模块属早期自建视图模型，是否清理待 阶段 5 的对等契约评估。

#### 4.2 订阅者页 ✅ 已完成（缺陷修复 + 汇总条 + 表格对齐）

**修复的真实缺陷 B1（`[object Object]`）**

`features/subscribers/SubscribersPage.tsx` 的流量列原为 `text(row['traffic'])`，而契约把 `traffic` 返回为对象 `{ total, used, balance }`，`String(对象)` 得到 `"[object Object]"`。改为按字段读取并渲染参考的进度条：

```tsx
<div className="traffic-container">
  <div className="traffic-stats">
    <span>{formatBytes(traffic.used)}</span>
    <span>{formatBytes(traffic.total || 1)}</span>
  </div>
  <div className="traffic-bar-container">
    <div className={`traffic-bar ${traffic.pct > 90 ? 'high' : traffic.pct > 70 ? 'medium' : 'low'}`}
         style={{ '--traffic-scale': Math.min(traffic.pct, 100) / 100 }} />
  </div>
</div>
```

**其余改动**

| 项 | 改动 |
|---|---|
| 页头 | 自建的 `read-page-header` / 硬编码英文 eyebrow → 参考 `PageHeader`（default 导出）+ `eyebrow_imsi_hss` / `subscriber_title` / `subscriber_subtitle`（双语键已存在于词典） |
| 根元素 | `section.read-page` → `div.container.animate-fade-in`（参考容器） |
| 汇总条 | 新增参考的 `MetricStrip variant="cards" columns={4}`：当前用户总数 / 活跃 / 停机-受限 / 流量不足，取自契约返回的 `summary` 块（此前该块被完全忽略） |
| 表格列序 | 对齐参考：STATUS → IMSI → PLMN → PROFILE → TRAFFIC → LAST ACTIVE → ACTIONS（原为 IMSI → STATUS → TRAFFIC → PROFILE → PLMN） |
| 新增列 | `LAST ACTIVE`，使用参考的相对时间（`time_just_now` / `time_mins_ago` / `time_hours_ago` / `time_days_ago`），数据源 `lastActive` |
| PROFILE 列 | 改为 `policyName || policy`（参考口径），显示 "Default 4G/5G Tariff Plan" 而非空串 |
| 新依赖 | 移植 `lib/unitParser.ts`（4.1 已引入），`formatBytes` 返回字符串 |

**出口验证**：`tsc -b` / `npm run build` / `npm test` 96/96 / 契约门 PASS；截图 `.workbuddy-ai/tmp/stage4/subscribers.png` 与参考逐项一致（页头 IMSI/HSS + 中文标题 + 描述、4 卡汇总条 12/12/0/2、列序、流量进度条、`6 天前`/`17 天前` 相对时间）。

**仍未对齐（下一增量）**

- 工具栏按钮集：当前 `Create / Batch Create / Batch Update / Import`，参考为 `添加新用户 / 批量创建用户 / 同步数据 / 数据枢纽`。其中「数据枢纽」属 `DO NOT PORT`，需按 `frontend-ui-restoration.md` 的判定保留当前替代。
- 表头排序（参考用 `SortableTableHeader`，阶段 2 已移植但尚未接线）。
- 行操作图标集与 `...` 更多菜单。
- 参考页依赖的 `SubscriberModal` / `BatchCreateModal` / `BulkPolicyModal` / `TrafficAdjustmentModal` 等模态：当前页已有等价自建实现，是否替换为参考组件待评估（`DataHub`、`SubscriberTraceModal`、`SubscriberBatchUpdateModal` 为 `DO NOT PORT`）。

#### 4.3 OCS 资费页 ✅ 已完成

**修复 B2（订阅用户列显示 `-`）**：`features/ocs/tariffs/TariffsPage.tsx` 读取的是 `row.subscriber_count`（蛇形），而契约返回 **`subscriberCount`**（驼峰）→ `undefined` → `-`。已改为 `numberValue(row.subscriberCount)`，现正确显示 `10` / `0`。

**修复 B3（时间戳为原始 ISO）**：`updated_at` 原样输出 `2026-09-18T08:56:05Z`，改为参考口径的日期格式（`formatDateTime(..., { year:'numeric', month:'numeric', day:'numeric' })`）→ `2026/9/18`。

**新增 KPI 网格**：参考的 `MetricStrip variant="cards"` 4 卡（计划总数 / 活跃计划 / 已禁用计划 / 合同用户总数），此前该页完全没有汇总区。

**页头**：自建的 `read-page-header` + 硬编码英文 → 参考 `PageHeader`（eyebrow `nav_ocs`、标题 `ocs_tariffs_title`、描述 `ocs_tariffs_desc`）；根元素 `section.read-page` → `div.container.animate-fade-in`。

**列集纠正（重要）**：初次对齐时我按 `components/ocs/OcsTariffsPanel.tsx` 取了列集（含「规则」列），但**参考路由 `/ocs/tariffs` 实际渲染的是 `components/ocs/tariffs/OcsTariffGovernancePanel.tsx`**，不是 `OcsTariffsPanel`。已按后者纠正为参考的 8 列：

| 列 | 取值 |
|---|---|
| 计划 ID | `plan_id`（`ocs-mono`） |
| 名称 | `name` |
| 状态 | `status`（徽章） |
| **版本** | `v{version \|\| 1}` → `v1` |
| 订阅用户 | `subscriberCount` |
| **更新人** | `updated_by \|\| '—'` → `—` |
| 更新时间 | `updated_at` → `2026/9/18` |
| 操作 | 详情 / 编辑 / 复制 / 启用禁用 / 删除 |

**出口验证**：`tsc -b` / `npm run build` / `npm test` 96/96 / 契约门 PASS；截图 `.workbuddy-ai/tmp/stage4/ocs-tariffs.png` 与参考**逐项一致**（KPI 2/2/0/10；行 `default_plan · v1 · 10 · — · 2026/9/18` 与 `plan_default_10gb · v1 · 0 · — · 2026/9/30`）。

**顺带发现（属 4.4 范围）**：`features/ocs/contracts/ContractsPage.tsx` 的「版本」「更新时间」两列读 `row.version` / `row.updated_at`，但契约 `/api/ocs/subscribers` 的记录只有 `{ id, imsi, msisdn, status, plan_id }` —— **两个字段都不存在**，因此两列恒为 `-`。4.4 需按真实契约重定列集。

#### 4.4 OCS 合同页 ✅ 已完成

**修复列集错误**：原页面的「版本」「更新时间」两列读 `row.version` / `row.updated_at`，但契约 `/api/ocs/subscribers` 的记录只有 `{ id, imsi, msisdn, status, plan_id }` —— **两个字段都不存在**，两列恒为 `-`。

按参考路由 `/ocs/contracts` 真正渲染的 `components/ocs/contracts/OcsContractsPanel.tsx` 重定列集为 7 列：

| 列 | 取值 |
|---|---|
| IMSI | `imsi`（`ocs-imsi-cell` + `<code>`） |
| MSISDN | `msisdn \|\| '—'`（**此前完全缺失**） |
| 资费计划 | `plan_id`（`ocs-plan-badge`） |
| 计费状态 | `status`（徽章） |
| 创建时间 | `created_at`（契约未返回 → `—`，与参考一致） |
| 最近变更 | `updated_at`（契约未返回 → `—`，与参考一致） |
| 操作 | 详情 / 编辑 / 停用启用 / 删除 |

**新增 KPI 网格**：参考的 3 卡 MetricStrip（合同总数 / 活跃 / 暂停），实测 10 / 10 / 0。

**页头**：→ 参考 `PageHeader`（eyebrow `nav_ocs`、标题 `ocs_contracts_title`、描述 `ocs_contracts_desc`）；根元素 → `div.container.animate-fade-in`。

**出口验证**：`tsc -b` / `npm run build` / `npm test` 96/96 / 契约门 PASS；截图 `.workbuddy-ai/tmp/stage4/ocs-contracts.png` 与参考一致（KPI 10/10/0；MSISDN 列恢复；`default_plan` 徽章；创建时间/最近变更为 `—`）。

#### 4.5 OCS 余额页 ✅ 已完成

参考路由 `/ocs/balances` 渲染 `components/ocs/balances/OcsBalancePlaceholder.tsx`（该目录下另有 `AdjustBalanceModal` / `OcsBalanceDetail`）。

**修复的显示缺陷（全部为「有数据但没渲染对」）**

| 列 | 修复前 | 修复后（参考口径） |
|---|---|---|
| 可用余额 | `11576329040`（原始字节） | `10.78 GB`（`formatBytes` + `ocs-mono`） |
| 可用语音 | `3600` | `3600s` |
| 版本号 | `10` | `v10`（`v{version \|\| 1}`） |
| 更新时间 | **列不存在** | `2026年9月20日 23:28`（`formatDateTime`，`ocs-time-cell`） |

**新增**：参考的 2 卡 MetricStrip（总余额账户 / 活跃账户，实测 10 / 10）；页头 → 参考 `PageHeader`（eyebrow `nav_ocs`、标题 `ocs_balances_title` = 余额治理、描述 `ocs_balances_desc`）；根元素 → `div.container.animate-fade-in`；列头全部改用参考的 i18n 键。

**出口验证**：`tsc -b` / `npm run build` / `npm test` 96/96 / 契约门 PASS；截图 `.workbuddy-ai/tmp/stage4/ocs-balances.png` 与参考一致（KPI 10/10；`10.78 GB` / `3600s` / `100` / `ACTIVE` / `v10` / 中文时间）。

**遗留（低优先级，非阻塞）**：工具栏的 `Adjust Balance` 按钮图标与文字有轻微重叠，属 `action-toolbar` 的按钮样式问题，与参考无关，记入 4.10 收尾。

#### 4.6 系统健康页 — 子系统矩阵 ✅ 已完成（矩阵部分）

**恢复的整块内容**：参考的「核心子系统健康矩阵」此前**完全缺失**，当前页只剩一张居中的 `Subsystem Status` 卡。现已按参考重建 4 张 `SubsystemCard`（阶段 2 已移植），每张 2×2 指标网格：

| 卡片 | 参考指标 | 实测值 |
|---|---|---|
| 数据库集群与索引 | 平均延迟 / 数据集 / 缺失索引 / 状态 | `6 ms` / `11 / 11` / `0` / `就绪` |
| OCS 实时计费引擎 | 余额不变量 / 活跃会话 / 在途预留 / 资费方案 | `100% 正常` / `56` / `40` / `2` |
| HSS 核心网与订阅者 | 鉴权凭证完整度 / 切片路由配置 / 模板失效引用 / 模板配置 | `100% 正常` / `最优` / `0` / `0` |
| 安全治理与告警态势 | 超级管理员 / 未确认告警 / 系统用户 | `已激活` / `0` / `1` |

数据源为既有的 `/api/system/health` 契约（页面本就在取），字段为 `subsystems.{database,ocsEngine,hssCore,security}`。

**修复的布局缺陷（类名冲突）**：页面根元素带了 `system-health-governed-page`，而该名称在 `utilities.css` 里被定义为**动作栏**样式（`display:flex; align-items:center`）—— 根元素套上后整页被压成居中的窄列，矩阵无法成行。已从根元素移除该冲突类名，矩阵恢复为 `repeat(auto-fit, minmax(280px, 1fr))` 网格。

**出口验证**：`tsc -b` / `npm run build` / `npm test` 96/96 / 契约门 PASS；截图 `.workbuddy-ai/tmp/stage4/system-health.png` 与参考的 4 张子系统卡**逐项一致**（含徽章文案「健康最佳 / 性能降级」）。

**本页仍未对齐**：① 页头 eyebrow 仍为英文 `OPERATIONAL_GOVERNANCE`（参考为「NOC / 诊断」）与缺少描述；② 参考的 4 卡综合 KPI 板（综合健康评分 / 异常总数 / 上次 Mongo 检查 / DB 延迟）；③ 参考的「可操作建议」横幅；④ 异常表与诊断工具条的参考化。以上记入 4.10 收尾。

#### 4.7 用户管理页 ✅ 已完成（关键缺陷修复 + 页头对齐）

**修复的严重缺陷：整页此前请求的是一个 400 的 URL。**

`features/users/UsersPage.tsx` 请求 `/api/users?page=1&limit=20&q=…`，但后端 `/api/users` 的查询参数白名单（`backend/internal/user/query.go:11`）是：

```
page · pageSize · search · q · role · status · sort · order
```

**`limit` 不在白名单内**，且后端「拒绝未知键」，因此每次都返回 `400 INVALID_QUERY` —— 用户列表页一直处于错误态。实测对照：

| URL | 修复前 |
|---|---|
| `/api/users?page=1&limit=20` | **400 INVALID_QUERY** |
| `/api/users?page=1&pageSize=20&q=` | **200**，返回 `{ items: [...] }` |

已将 `limit=` 改为 `pageSize=`，页面恢复显示（admin 行、搜索、分页、操作均正常）。

**页头对齐**：自建的 `read-page-header` + 硬编码英文 → 参考 `PageHeader`（eyebrow `eyebrow_rbac_iam` = `RBAC / IAM`、标题 `users_title` = `系统用户`、描述 `users_subtitle`）；根元素 → `div.container.animate-fade-in`。

**出口验证**：`tsc -b` / `npm run build` / `npm test` 96/96 / 契约门 PASS；截图 `.workbuddy-ai/tmp/stage4/users.png` 显示 admin 行正常渲染（修复前为 400 错误态）。

**本页仍未对齐**：参考的 `UsersSummaryPanel`（汇总卡）、富工具栏（角色/状态筛选）、`UserDrawer` 抽屉（新建/编辑）、`UsersTable` 列集（显示名/最后登录等）。阶段 1 已把这些的 CSS Modules 移植到 `styles/modules/`，但组件尚未接线。记入 4.10。

#### 4.8 Profile（配置治理）页 ✅ 已完成

**页头对齐**：自建的 `read-page-header` + 硬编码英文 → 参考 `PageHeader`（eyebrow `eyebrow_policy_template` = `POLICY / TEMPLATE`、标题 `prof_governance_title` = `配置治理`、描述 `prof_governance_subtitle`）。

**新增治理汇总条**：参考的 4 卡 MetricStrip —— 模板数 / 关联用户 / 高风险（danger 色调）/ 近期变更。取值口径与参考一致：

- `模板数` ← 契约 `summary.totalProfiles`，回退到列表长度
- `关联用户` ← 契约 `summary.totalGovernedSubscribers`
- `高风险` ← 列表内 `risk === 'high'` 计数（客户端派生，与参考一致）
- `近期变更` ← 列表内 14 天内变更过的计数（客户端派生，与参考一致）

**未编造数据**：契约 `/api/profiles` 实测返回 `{ profiles: [], summary: { totalProfiles: 0, ... } }`（库内暂无模板），页面如实显示 0 与空态。

**出口验证**：`tsc -b` / `npm run build` / `npm test` 96/96 / 契约门 PASS；截图 `.workbuddy-ai/tmp/stage4/profile.png` 显示页头 + 4 卡汇总条 + 空态。

**过程中排掉的一个环境问题**：首次截图整页崩溃 `ReferenceError: Boxes is not defined`，但源码与 `tsc` 均正确。原因是此前一次 `Edit` 因文件被占用（EBUSY）导致 Vite dev server 缓存了半写入的模块转换结果；**改一次文件内容强制重新转换**后恢复正常（截图体积 41 KB → 100 KB）。这类问题不是代码缺陷，但会误导判断，已在 skill 中记录。

**本页仍未对齐**：参考的领域/风险筛选、`ProfileModal`、版本历史面板、表列集。记入 4.10。

#### 4.9 登录页 ✅ 已完成

`auth/LoginPage.tsx` 的标记按参考 `app/login/LoginForm.tsx` 重写（阶段 1 已移植 `login.css`）：

| 区块 | 参考结构 |
|---|---|
| 画布 | `main.login-container` + `login-bg-blob-1/2` 渐变光斑 |
| 品牌区 | `login-logo-container` + 大号 `login-logo` + `login-title`（xCloud Platform）+ `login-subtitle`（核心网管理系统） |
| 会话/错误提示 | `login-session-container`（带 `login-session-indicator`）/ `login-error-container`（带 `login-error-indicator`） |
| 用户名 | `input-container` > `login-field-label`（视觉隐藏的 `<label>`）+ `input-icon`（User 图标）+ `login-input` |
| 密码 | 同上 + `login-input-password` + `password-toggle`（Eye/EyeOff） |
| 提交 | `login-submit-btn`（`login_button` = 登录） |
| 页脚 | `login-footer`（`login_protected` = 由 xCloud Secure Access 提供安全保护） |

**过程中修掉的一个真实结构错误**：首版我把 `input-container`（`position:relative` 包裹层）与 `login-field-label`（**视觉隐藏**：`position:absolute; width:1px; clip`）写在同一个 `<label>` 上，导致**整个字段（含输入框）被隐藏**，页面只剩标题与按钮。参考里这是两个不同元素（`Field` 组件的 `className` 与 `labelClassName`）。拆开后输入框正常显示。

**出口验证**：`tsc -b` / `npm run build` / `npm test` 96/96 / 契约门 PASS；截图 `.workbuddy-ai/tmp/stage4/login.png` 与参考**逐项一致**（大号品牌标、双语标题副标题、框内图标、框内眼睛、全宽登录按钮、页脚）。

**遗留（低优先级）**：用户名/密码输入框的 placeholder 与框内图标有轻微重叠，属 `.login-input` 左内边距微调，记入 4.10。

#### 4.10 库存页与 阶段 4 总验证 ✅ 已完成

**库存页**：`features/inventory/InventoryPage.tsx` 是当前项目新增能力（参考项目无对应路由），按计划只做视觉统一 —— 根容器由 `page-container` 改为与全站一致的 `container animate-fade-in`。更深的共享原语对齐（`PageHeader` 替换自建页头、`MetricStrip` 汇总、表格接入 `DataTablePagination` / `SortableTableHeader`）尚未做，属可选增强。

**两处遗留样式**：`.login-input` 左内边距 `2.75rem → 3.25rem`（消除 placeholder 与框内图标的重叠）。`Adjust Balance` 按钮的图标/文字轻微重叠未处理（属按钮自身样式，非参考差异）。

**阶段 4 总验证（全绿）**

| 判据 | 结果 |
|---|---|
| `npx tsc -b` | ✅ clean |
| `npm test` | ✅ **96/96** |
| `npm run build` | ✅ CSS 256.58 kB / JS 1,184.62 kB |
| `test-ui-restoration-contract.mjs` | ✅ PASS |
| `test-agent-docs-parity.mjs` | ✅ PASS |
| `test-frontend-runtime-boundary.mjs` | ✅ PASS |
| `test-inventory-contract.mjs` | ✅ PASS |
| 逐页截图复核 | ✅ `.workbuddy-ai/tmp/stage4-final/*.png`（仪表盘 / 订阅者 / 资费 / 合同 / 余额 / 系统健康 / 用户 / Profile / 库存） |

**阶段 4 累计修复的真实缺陷（9 项）**

| # | 缺陷 | 位置 | 严重度 |
|---|---|---|---|
| 1 | 流量列渲染 `[object Object]`（对对象做 `String()`） | `SubscribersPage.tsx` | 高（数据不可读） |
| 2 | 订阅用户列恒为 `-`（读 `subscriber_count`，契约返回 `subscriberCount`） | `TariffsPage.tsx` | 高 |
| 3 | 资费更新时间输出原始 ISO 串 | `TariffsPage.tsx` | 中 |
| 4 | 合同页「版本」「更新时间」两列读取**不存在**的字段 | `ContractsPage.tsx` | 中 |
| 5 | 合同页缺失 MSISDN 列（数据本就在契约里） | `ContractsPage.tsx` | 中 |
| 6 | 余额页四处未格式化/缺失（字节、秒、版本号、更新时间列） | `BalancesPage.tsx` | 中 |
| 7 | 「核心子系统健康矩阵」整块缺失 + 类名冲突致整页塌成窄列 | `SystemHealthPage.tsx` / `utilities.css` | 高 |
| 8 | **用户页查询参数错误（`limit` 不在后端白名单）→ 整页恒为 400** | `UsersPage.tsx` | **严重** |
| 9 | 登录页 `input-container` 与视觉隐藏的 `login-field-label` 合并到一个元素 → 整个字段（含输入框）被隐藏 | `LoginPage.tsx` | 高 |

**阶段 4 完成后仍未对齐（明确记录，非隐瞒）**

- 订阅者页：工具栏按钮集、表头排序（`SortableTableHeader` 已移植未接线）、行操作图标集。
- 系统健康页：页头 eyebrow/描述、4 卡综合 KPI 板、可操作建议横幅、异常表参考化。
- 用户管理页：`UsersSummaryPanel`、富工具栏、`UserDrawer`、`UsersTable` 列集（其 CSS Modules 已在 `styles/modules/`，组件未接线）。
- Profile 页：领域/风险筛选、`ProfileModal`、版本历史面板。
- 库存页：共享原语深化对齐。
- 上述均属「参考有、当前尚未接线」的表现层增量，不涉及数据正确性缺陷。

**下一步**：阶段 5（验收门重建）—— 用参考驱动的对等契约替换自指断言。

4.3 OCS 资费 / 4.4 OCS 合同 / 4.5 OCS 余额 / 4.6 系统健康 / 4.7 用户管理 / 4.8 Profile / 4.9 登录 / 4.10 库存与总验证 —— 尚未开始。

---

## 12. 实施记录：阶段 5（验收门重建）✅ 已完成

### 5.1 新增参考驱动的对等契约 `scripts/test-ui-parity-contract.mjs`

这是本阶段的核心。旧的 `test-ui-restoration-contract.mjs` 断言的是**实现自己定义的字符串**，因此无论偏离多大都恒为绿 —— 这正是差异长期未被发现的直接原因。新契约改为**读取参考 checkout 直接比对**：

| 检查 | 内容 | 结果 |
|---|---|---|
| P-01 | 每个已移植样式表保留参考域规则密度的 ≥90% | ✅ 8/8（analytics/ocs/subscribers/profile/system-health/modals/login 均 **1.00**；globals 0.94，因有意排除参考的工具类区块） |
| P-02 | 参考共享原语清单齐备（17 项） | ✅ 无缺失 |
| P-03 | 参考 JSX 类名词表覆盖率 | ⚠️ **32.8%**（参考 1230 / 当前 565 / 缺 827），阈值设为 **回归下限 30%**，目标 90% |

设计要点：

- 参考路径由 `UI_PARITY_REFERENCE` 指定（默认本地参考 checkout）；**参考缺失时 SKIP 并退出 0**，避免无参考的机器误判为红。
- 覆盖率分母**排除 `DO NOT PORT` 面**（DataHub / diff-viewer / governance / rating / trace / batch-update / approval / 通知偏好等），否则真正达到对等时也永远无法通过。
- **P-03 刻意标为「回归下限」而非「对等声明」**：32.8% 的残差正是文档 §4.10 已列出的未接线面（`SubscribersTable`、Profile 治理表、通知偏好抽屉）。设为 0.30 是为了防止倒退，不是为了宣称达标；目标值 0.90 一并输出。

### 5.3 固化截图工具 `scripts/capture-ui-parity.mjs`

把此前临时脚本固化为仓库脚本，支持 `UI_CAPTURE_APPS` / `UI_CAPTURE_ROUTES` / `UI_CAPTURE_OUT` / `UI_CAPTURE_TOKEN` 等环境变量，可只截当前应用或双应用对照。`package.json` 新增 `ui:capture` 与 `check:ui-parity`。

### 5.5 更正 `docs/architecture/frontend-ui-restoration.md` 状态

状态由 `IMPLEMENTED` 更正为 **`PARTIAL`**，并附量化更正说明（CSS 规则 2751→659、原语 23→6、类名词表 1406→326）、根因（自指断言使门恒绿）与新门/新工具指引。

### 过程中触发的文档规范修正（真实收益）

新增文档时撞到项目既有的两道文档门，均已按规范修正：

1. `test-current-architecture-docs`：禁止在活跃文档中把历史框架名与当前前端端口写在同一行 → 改写措辞。
2. `test-documentation-integrity`：活跃文档禁止出现英文 phase 加数字的**生命周期编号** → 全文英文阶段编号改为中文「阶段 N」；证据目录一并改名 `stage1..4`。
3. 该门同时要求所有相对 Markdown 链接可解析 → 修正文档搬家后的链接。

**并据此把本方案文档从 `docs/architecture/` 迁至 `docs/plans/`** —— `docs/architecture/` 按项目约定只放「当前系统事实（现在时）」，而本文档是带阶段状态的工作记录。

### 阶段 5 出口验证

| 判据 | 结果 |
|---|---|
| `npx tsc -b` | ✅ clean |
| `npm test` | ✅ 96/96 |
| `npm run build` | ✅ |
| `check:ui-parity` | ✅ PASS（P-01/P-02/P-03） |
| `test-ui-restoration-contract` | ✅ PASS |
| `test-agent-docs-parity` / `test-frontend-runtime-boundary` / `test-inventory-contract` | ✅ PASS |
| `test-current-architecture-docs` / `test-documentation-integrity` | ✅ PASS |
| `ui:capture` | ✅ 冒烟通过 |

**两项未通过的门经核验与本工作无关**：

- `test-deployment-boundary` 的 `DB-R00A/DB-R00B` 要求端口 **18888 / 13333 空闲**（用于冷启动部署测试），而当前开发栈正占用这两个端口 → **环境性失败**。
- `test-production-architecture` 的 `PA-18`（`frontend_package mongodb/jose/jiti`）与 `PA-21`（`canonical_api` 33 vs 0）→ **既存失败**：本次对 `frontend/package.json` 的唯一改动是把新增测试加入 `test` 脚本，未增删任何依赖。

### 五个阶段的整体结论

| 阶段 | 结果 |
|---|---|
| 1 样式底座 | ✅ 2605 条规则 |
| 2 共享原语 | ✅ 17 原语 + 8 CSS Module |
| 3 壳层对齐 | ✅ |
| 4 页面重建 | ✅ 10/10，修复 9 个真实缺陷 |
| 5 验收门重建 | ✅ 参考驱动契约 + 截图工具 + 文档更正 |

**残留**：P-03 覆盖率 32.8%（目标 90%），对应 §4.10 列出的未接线面；库存页深化对齐；库存搜索框缺 i18n 键。这些均为「参考有、当前尚未接线」的增量，不含数据正确性缺陷。

---

## 13. 复核修正：行操作列与系统健康头部（用户截图反馈）

用户以截图标注了 7 处仍有差异的位置，集中在**表格行操作列**与**系统健康头部**。逐项修正如下。

### 13.1 行操作列的红色实心删除按钮（截图 1/2/3/6）

参考把行操作渲染为**紧凑的幽灵图标按钮**（`ocs-action-group` / `ocs-action-btn`：1.75rem 方形、细边框、静默色，`ocs-action-danger` 仅在 hover 时转为柔和红）。当前各页用 `btn-secondary btn-sm` 文本按钮 + `btn-danger` 实心红按钮，视觉上明显更重。

修正在 `styles/pages.css` 追加一层（**不改 5 个页面的标记**，降低风险）：

```css
.table-actions .btn-secondary,
.table-actions .btn-primary,
.table-actions .btn-danger { /* 1.75rem 幽灵方按钮 */ }
.table-actions .btn-danger:hover:not(:disabled) { /* 柔和红，仅 hover */ }
```

要点：选择器特异性 (0,2,0) **刻意高于**后加载的全局层 `.btn-danger` (0,1,0)，因此不受层序影响。

覆盖页面：订阅者 / 资费 / 合同 / 余额 / 用户管理（5 处均使用 `.table-actions`）。

### 13.2 系统健康头部（截图 7）

| 项 | 修正前 | 修正后（参考） |
|---|---|---|
| eyebrow | 英文 `OPERATIONAL_GOVERNANCE` | `NOC / 诊断`（`eyebrow_noc_diagnostics`） |
| 描述 | 缺失 | `核心子系统健康矩阵`（`health_subsystems_title`） |
| 动作 | `Refresh` / `Recompute Analytics` / `Run Audit Scan` | `刷新` / `同步数据`（`sync_telemetry`，带 `sync_tooltip`）/ `全面诊断`（`health_btn_run`） |

### 13.3 工具栏主按钮

追加 `.action-toolbar .btn-primary { min-height: var(--control-height); padding: 0 1rem; }`，统一各页工具栏主按钮的高度与内边距（此前资费页与配置治理页的主按钮尺寸不一致）。

### 验证

`npx tsc -b` clean · `npm test` 96/96 · `npm run build` 通过 · `check:ui-parity` / `test-ui-restoration-contract` / `test-documentation-integrity` / `test-current-architecture-docs` 全 PASS。
截图复核：`.workbuddy-ai/tmp/fix-actions/current/`（订阅者、资费、余额、系统健康、用户管理）—— 行操作为幽灵图标按钮、删除项静默（hover 转柔和红）、系统健康头部为参考文案。

### 本次未处理（如仍需对齐请指出）

- 各页行操作的**图标集**与**顺序**仍与参考不同（参考为 详情/编辑/复制/启用禁用/删除 的组合，当前为 详情/编辑/复制/哈希/删除）。
- 订阅者页工具栏按钮集（参考含「数据枢纽」，属 `DO NOT PORT`）。
- 表头排序（`SortableTableHeader` 已移植，尚未接线）。
