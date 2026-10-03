# 页面模板

本规范定义 `frontend/src/app/(dashboard)/**` 下的三类页面模板：概览型、列表型和详情型。模板是结构契约——区块顺序、共享原语、断点行为和状态契约——不是脚手架代码。新增页面必须选择其中一类并保持其结构；存量页面触达即迁移。

模板建立在两个既有文档之上：视觉值与 token 规则见 [design-system-rules.md](design-system-rules.md)，令牌清单与主题值见 [design-tokens.md](design-tokens.md)。

## 0. 共同壳层

所有模板页都由 `(dashboard)` 布局提供统一壳层（`frontend/src/app/(dashboard)/layout.tsx`），页面本身不再实现壳层：

```text
skip-link -> #main-content（键盘首个焦点）
AppHeader（含侧栏开关）
AppSidebar（>= 981px 常驻；窄屏为抽屉，Escape 或背景点击关闭）
NavigationTabBar -> NavigationBreadcrumbs
main#main-content（tabIndex=-1，路由内容挂载点）
```

- 页面根容器使用全局 `.container`（`src/app/globals.css`）：水平内边距取 `--space-page`，`<= 980px` 收敛为 `1rem`。OCS 域使用 `ocs-container` 修饰符。
- 主要区块统一包在 `.dash-card` 内（`globals.css`）：面板背景、`--surface-border` 描边、软面板圆角与阴影。`prefers-reduced-motion` 下悬停位移被关闭。
- 区块间距默认 `20–24px`；页头与首个区块之间不插入额外容器。
- 响应式断点遵循 [design-system-rules.md](design-system-rules.md) 第 5 节：壳层在 `981px` 切换桌面/抽屉导航；页面内容按 `1180 / 980 / 900 / 768 / 640 / 560px` 逐级降级。

## 1. 概览型（仪表盘 / KPI）

用于回答“当前状态如何”：平台总览（`/` 的 AnalyticsCockpit）、系统健康（`/system-health`）、OCS 总览（`/ocs/dashboard`）等。

结构顺序：

```text
container
  -> PageHeader（eyebrow / icon / title / description；tone 表达整体健康）
  -> 只读或状态横幅（可选）
  -> MetricStrip variant="cards"（KPI 卡片行）
  -> 内容区（.dash-card 网格：面板、图表、工作台）
  -> 辅助表格或明细区（可选）
```

- KPI 行使用共享原语 `MetricStrip` 的 `cards` 变体（`src/components/ui/MetricStrip.tsx`）：
  - `columns` 写入 `--metric-card-count` 并设置 `data-columns`，网格随之响应：`<= 1180px` 三列、`<= 640px` 双列、`<= 560px` 单列。
  - `tone` 表达指标语义（`primary / success / warning / danger / muted`）；`accent` 仅为 KPI 身份色（`--metric-accent`）。
  - `indicator`、`detail`、`compactValue` 用于趋势指示、辅助说明和大数值压缩。
- 图表必须经可视化层实现：调色板与网格/tooltip 令牌来自 `src/components/ui/chartPrimitives.tsx`；每张图提供 `ChartDataTable` 等价数据表。分类色板 `--chart-*` 只允许出现在图表标记上，不得用于图标、徽章、药丸或文本（见 [design-system-rules.md](design-system-rules.md) 第 4 节）。
- 状态契约：加载时保留区块结构并使用骨架；空数据不绘制零值假图，数值缺失显示 `—`；错误态保留页头并提供重试。
- 代表页：`/`（AnalyticsCockpit 组合 KPI 条、工作台、OCS 卡片与图表）、`/system-health`（MetricStrip cards + 子系统卡片）、`/ocs/dashboard`。

## 2. 列表型（数据表格）

用于比较同构记录、筛选和批量操作。全部表格页属于此类。

结构顺序：

```text
container
  -> PageHeader
  -> MetricStrip variant="strip"（汇总与状态筛选入口，可选）
  -> 搜索 / 筛选 / 批量操作工具栏
  -> .dash-card 表格卡（表格 + 分页）
```

两种装配方式等价，按域选择：

- 页面自装配（`/subscribers`、`/users`）：汇总面板 + 工具栏 + `dash-card table-card`，分页直接置于卡片内。
- OCS 域统一壳 `OcsPageShell`（`src/components/ocs/OcsPageShell.tsx`）：`container ocs-container` -> `PageHeader`（只读状态徽章 + 刷新动作）-> 只读横幅 -> `kpiGrid` -> `controls` -> `dash-card ocs-table-card`（表格 + `pagination`）-> `children`。OCS 列表页只提供内容槽，不自行实现壳层。

汇总条使用 `MetricStrip` 的 `strip` 变体：`--metric-count` 控制列数，`<= 560px` 单列；条目可带 `onClick` / `active` / `aria-pressed` 作为状态筛选入口（如 `/subscribers` 的汇总面板与状态筛选联动）。

表格契约：

- 使用原生 `<table>` 结构；每张表有可见标题或读屏 `<caption>`。
- 每个 `<th>` / `<td>` 必须标注列优先级 `data-column-priority`：
  - `essential`：任何宽度都保留（主标识、状态、核心指标、操作）；
  - `important`：窄屏可隐藏；
  - `supplementary`：最早隐藏。
- 移动降级为三级（`globals.css`）：
  - `> 980px`：完整运营表格；
  - `<= 980px`：隐藏 `supplementary` 列；
  - `<= 768px`：再隐藏 `important` 列，且数据行转为记录卡；每个 `<td>` 另标 `data-label`（来自 i18n），由页面 CSS 的 `td[data-label]::before { content: attr(data-label) }` 渲染字段标签。
- 排序使用共享原语 `SortableTableHeader`：真实 `<button type="button">` 位于表头内，当前列设置 `aria-sort`。
- 表格状态行使用共享原语 `DataTableStateRow`（`loading / empty / error`，`role=status` 或 `role=alert` + `aria-live`）；禁止手写 `<tr><td>` 状态行或硬编码状态样式。
- 分页使用共享原语 `DataTablePagination`：范围摘要带 `aria-live="polite"`，默认页大小 `10 / 20 / 50 / 100`，上一页/下一页在边界禁用。筛选、排序或页大小变化后回到第一页。
- 内容规则：空值统一 `—`；数值右对齐并使用 `tabular-nums`；行操作右对齐；批量操作后反馈成功数与失败数。
- 代表页：`/subscribers`、`/users`、`/ocs/balances`、`/ocs/tariffs`、`/ocs/subscribers`。

## 3. 详情型（单对象）

用于单个对象的完整属性与操作：用户、套餐、合同、余额等。单条记录不得使用表格。

结构顺序：

```text
容器（ocs-container 或 page / container）
  -> 状态分支：loading（骨架或加载文本）/ not-found（空态）
  -> PageHeader（eyebrow = 导航域，title = 标识符，description，actions）
  -> 内容区
```

两种内容呈现：

- 只读描述网格（OCS 域，`ocs.css`）：`ocs-detail-grid` -> `ocs-detail-section`（`h3` + 图标分节）-> `ocs-detail-fields` -> `ocs-detail-field`（`ocs-detail-label` + `ocs-detail-value`）。标识符与数值使用 `ocs-mono`；关键值使用强化变体。空值 `—`，布尔语义以文字表达而非仅颜色。
- 可编辑表单（`/users/[username]`）：`formSection` 分节（`h3` + `<label>` + 表单控件，控件原语见 `src/components/ui/Field.tsx`）；编辑与只读通过页头动作切换，编辑态离开受 `UnsavedChangesGuard` 保护。

页头规则：

- 返回链接（图标按钮）+ 标题 + 徽章（当前用户、角色、状态）构成标题行；动作区按角色能力渲染。
- 生命周期动作（锁定 / 解锁 / 禁用 / 启用、删除等）使用对应按钮层级（`btn-ghost` / `btn-primary` / `btn-danger`），不可逆或高影响动作必须先经确认弹窗并展示影响摘要。
- 结果与错误通过页内提示反馈，成功后局部刷新数据而非整页跳转。

代表页：`/users/[username]`（可编辑）、`/ocs/tariffs/[planId]`、`/ocs/balances/[imsi]`、`/ocs/contracts/[imsi]`（只读网格，页面文件为薄包装，详情实现位于 `src/components/ocs/**`）；`/users/create` 是创建型的编辑变体。

## 4. 状态与反馈契约

三类模板共用同一状态词汇，不允许页面自造同义状态：

- 页面级三态必须分别表达：加载（保留结构，骨架优先）、空（解释原因并给出下一步）、错误（保留筛选或上下文，提供重试）。
- 内联提示使用 `InlineNotice`；操作结果使用通知/确认面板原语；破坏性操作统一走确认弹窗（`Dialog` 原语 + `useDialogFocus` 焦点管理）。
- 所有面向用户的文案必须同时提供英文与中文（`i18n` 词典），禁止在 TSX 内硬编码兜底串。
- 权限不足、只读与禁用状态必须可区分：只读使用只读说明与徽章（如 OCS 只读横幅），禁用只用于真正不可操作的情况。

## 5. 反模式

- 不新建与共享原语同义的组件：KPI 条、分页、表格状态行、页头必须复用现有实现。
- 不用卡片堆叠替代同构记录表格；不用表格展示单条详情。
- 不通过缩小字号塞入更多列；应使用列优先级降级。
- 不在页面代码中硬编码颜色、间距、字号或圆角字面量；一切视觉值走 token（见 [design-system-rules.md](design-system-rules.md) 第 1 节）。
- 不在可视化层之外引用 `--chart-*` 分类色板。
- 不跳过移动降级：每个 `<th>` / `<td>` 都必须标注 `data-column-priority`，可卡片化的单元格必须带 `data-label`。
- 不在页面里直接操作壳层（侧栏、页头、导航）；壳层由布局统一负责。

## 6. 新增页面检查清单

- [ ] 已选择模板类型，并保持其区块顺序与容器层级。
- [ ] 列表页：MetricStrip 汇总条、工具栏、`dash-card` 表格卡与 `DataTablePagination` 齐备；列标注 `data-column-priority`，卡片化单元格标注 `data-label`。
- [ ] 详情页：状态分支、页头徽章与动作、只读网格或表单分节齐备；危险动作有确认。
- [ ] 概览页：KPI 行使用 `MetricStrip cards`；图表使用 `chartPrimitives` 并提供 `ChartDataTable` 数据表。
- [ ] 在 `375 / 640 / 768 / 980 / 1180px` 验证降级行为（含表格卡片化与 KPI 列数）。
- [ ] 加载、空、错误三态均已实现；文案中英双语。
- [ ] 键盘可完成主要操作；表格排序与分页可访问。
- [ ] `npm run lint`、`npm run typecheck`、`npm test` 通过。