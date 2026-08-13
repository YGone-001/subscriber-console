---
name: "xCloud"
description: "面向电信运营与核心网运维的冷静、高密度、可信操作界面"
colors:
  signal-teal-day: "#087f8c"
  signal-teal-day-hover: "#046670"
  signal-cyan-night: "#42c3c9"
  signal-cyan-night-hover: "#68d8dc"
  healthy-green-day: "#16856b"
  caution-amber-day: "#b96c16"
  critical-red-day: "#c83d4c"
  operational-info-day: "#176f91"
  chart-violet-day: "#7656a8"
  chart-neutral-day: "#6f7f84"
  command-canvas-day: "#f3f6f7"
  panel-white-day: "#ffffff"
  panel-hover-day: "#edf3f4"
  divider-day: "#d8e1e3"
  command-ink-day: "#102b34"
  secondary-ink-day: "#36545d"
  muted-ink-day: "#61777e"
  command-canvas-night: "#09191f"
  panel-deep-night: "#10262d"
  panel-hover-night: "#17323a"
  command-ink-night: "#eef7f7"
  healthy-green-night: "#46c7a5"
  caution-amber-night: "#f2a94b"
  critical-red-night: "#ff6b78"
  operational-info-night: "#68b6d4"
typography:
  display:
    fontFamily: "Sora, Aptos Display, Segoe UI, sans-serif"
    fontSize: "clamp(1.65rem, 2vw, 2.2rem)"
    fontWeight: 650
    lineHeight: 1.05
    letterSpacing: "-0.035em"
  body:
    fontFamily: "Noto Sans SC, Microsoft YaHei UI, PingFang SC, Segoe UI, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "normal"
  label:
    fontFamily: "Noto Sans SC, Microsoft YaHei UI, PingFang SC, Segoe UI, sans-serif"
    fontSize: "0.78rem"
    fontWeight: 750
    lineHeight: 1.25
    letterSpacing: "0.035em"
  data:
    fontFamily: "Cascadia Mono, SFMono-Regular, Consolas, monospace"
    fontSize: "0.8rem"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "normal"
rounded:
  small: "7px"
  control: "8px"
  panel: "10px"
  soft-panel: "12px"
  pill: "999px"
spacing:
  compact: "8px"
  control-inline: "12px"
  item: "16px"
  section: "20px"
  page: "24px"
components:
  button-primary:
    backgroundColor: "{colors.signal-teal-day}"
    textColor: "{colors.panel-white-day}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "8px 14px"
    height: "36px"
  button-primary-hover:
    backgroundColor: "{colors.signal-teal-day-hover}"
    textColor: "{colors.panel-white-day}"
    rounded: "{rounded.control}"
  button-outline:
    backgroundColor: "transparent"
    textColor: "{colors.command-ink-day}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "8px 14px"
    height: "36px"
  field:
    backgroundColor: "{colors.panel-white-day}"
    textColor: "{colors.command-ink-day}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
    height: "36px"
  status-chip:
    backgroundColor: "{colors.panel-hover-day}"
    textColor: "{colors.signal-teal-day}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "7px 11px"
    height: "36px"
  icon-action:
    backgroundColor: "transparent"
    textColor: "{colors.command-ink-day}"
    rounded: "{rounded.control}"
    height: "44px"
    width: "44px"
  panel:
    backgroundColor: "{colors.panel-white-day}"
    textColor: "{colors.command-ink-day}"
    rounded: "{rounded.panel}"
    padding: "20px"
---

# Design System: xCloud

## Overview

**Creative North Star: "电信运营舰桥"**

xCloud 的界面像一座持续运行的电信运营舰桥：冷静、结构化、面向态势与处置。它不追求消费级产品的轻松感，也不以炫技表达技术复杂度；视觉系统首先帮助专业用户判断网络与业务状态、定位风险、执行受控变更并确认结果。

整体采用高信息密度但清楚分层的操作界面。冷调青绿是交互与系统信号的共同主色，浅色模式适合日间办公与长时间阅读，深色模式适合 NOC 与低照度值守环境。品牌通过精确的字体、状态语义、数据排版和边界反馈出现，而不是通过大面积装饰。

**Key Characteristics:**

- 冷静的青绿信号色与蓝灰中性表面
- 适合持续值守和高密度数据操作的明暗双主题
- 清晰区分交互选中、健康、警告和严重故障
- 用紧凑控件、表格和指标条服务专家效率
- 用焦点、审批、恢复和审计反馈建立操作可信度

**The Operational Truth Rule.** 视觉优先级必须反映真实运营优先级：当前态势、风险、影响和结果高于装饰与模块数量。

## Colors

颜色语言来自冷调海洋青绿与核心网设备环境中的低饱和蓝灰；它应像仪表信号一样克制、明确且可持续阅读。

### Primary

- **日间信号青**（#087f8c）：浅色模式中的主操作、当前选择、焦点与可交互强调。
- **日间信号青深态**（#046670）：日间主操作的 hover 与加强态。
- **夜间信号青光**（#42c3c9）：深色模式中的主操作与聚焦信号，亮度足以从深色面板上清楚分离。
- **夜间信号青亮态**（#68d8dc）：深色模式 hover 与高可见反馈。

### Secondary

- **健康链路绿**（#16856b）：健康、完成、可用和成功结果；它不表示普通选中。
- **处置警戒琥珀**（#b96c16）：需要关注、等待确认或存在非致命风险的状态。
- **严重故障红**（#c83d4c）：破坏性动作、严重告警和失败；避免用于一般品牌强调。
- **运营信息蓝**（#176f91）：非故障的运行信息、图表第二序列和中性诊断提示；它不表示当前选择。

### Neutral

- **日间指挥画布**（#f3f6f7）：浅色模式的全局背景，用于拉开工作区和面板层级。
- **日间面板白**（#ffffff）：表格、指标条、弹层和主要工作容器。
- **日间悬停雾面**（#edf3f4）：悬停、弱选择和工具区表面。
- **日间结构分隔**（#d8e1e3）：边框、分隔线和表格结构。
- **日间指挥墨色**（#102b34）：主要文字与高重要性数据。
- **夜间指挥画布**（#09191f）：深色模式的全局背景。
- **夜间深层面板**（#10262d）：深色模式的主要容器。
- **夜间悬停面板**（#17323a）：深色模式的悬停和抬升表面。
- **夜间主文字**（#eef7f7）：深色模式的主要文字。
- **夜间语义色**：健康绿（#46c7a5）、警戒琥珀（#f2a94b）、严重故障红（#ff6b78）和运营信息蓝（#68b6d4）必须保持与日间模式相同的含义，只调整亮度与对比度。

**The Signal Rarity Rule.** 青绿主色只用于交互、当前状态和关键系统信号；大面积背景保持中性，稀缺性让信号色有意义。

**The Semantic Separation Rule.** 选择态使用主色，健康使用绿，警告使用琥珀，故障与破坏性动作使用红；不要用同一种彩色侧边条表达所有含义。

## Typography

**Display Font:** Sora（with Aptos Display, Segoe UI, sans-serif）
**Body Font:** Noto Sans SC（with Microsoft YaHei UI, PingFang SC, Segoe UI, sans-serif）
**Label/Mono Font:** Cascadia Mono（with SFMono-Regular, Consolas, monospace）

**Character:** Sora 提供精确、现代但不过度未来化的标题轮廓；Noto Sans SC 保证中英文运营界面的连续阅读；等宽字体只承担 IMSI、代码、协议字段和测量数据，不作为“技术感”装饰。

### Hierarchy

- **Display** (650, 1.65–2.2rem, line-height 1.05): 页面主标题与关键态势名称，使用紧凑字距强化指挥层级。
- **Headline** (650, 1rem, line-height 1.2): 分区标题和紧凑面板标题。
- **Title** (650, 1.18rem, line-height 1.2): 品牌锁定区、弹层标题和重要对象名称。
- **Body** (400, 1rem, line-height 1.55): 表单、说明和任务文案；长说明控制在约 65–75ch。
- **Label** (750, 0.72–0.78rem, letter-spacing 0.035em): 指标标签、状态与短操作提示；只在短标签中使用大写。
- **Data** (600, 0.8rem, line-height 1.4): IMSI、数值、单位、接口字段与结构化标识，使用表格数字和禁用连字。

**The Data Earns Mono Rule.** 只有机器标识、代码、协议、测量和对齐数字使用等宽字体；导航、标题与普通说明始终使用界面字体。

## Layout

xCloud 使用固定 64px 顶部栏、桌面侧栏、工作区导航和可滚动主内容组成操作壳层。桌面侧栏在展开与收起状态间切换，主内容必须保持 `min-width: 0`，避免高密度表格把整个壳层撑开。页面水平留白以 24px 为基准，主要分区之间使用 20px 节奏；桌面表单控件通常为 36px，图标操作和移动/粗指针环境中的交互目标至少为 44×44px，典型桌面表格行高为 54px。

页面内部优先使用“页面标题 → 态势/指标条 → 工具区 → 主要数据或任务”的垂直顺序。指标条在宽屏按等分网格排列，在 900px 以下转为两列，在 560px 以下转为单列。操作组允许换行，但主要动作与其对象应保持在同一视觉区域。

980px 以下，侧栏转为 off-canvas 抽屉并使用背景遮罩，内容区不再为侧栏预留宽度；桌面 workspace tabs 与 breadcrumbs 收起为单一当前页面提示，避免把三套定位系统压进移动首屏。页面级复合布局通常在 900px、768px、640px 和 560px 继续收敛；这些断点是当前系统的响应式词汇，不应为单个组件随意增加相邻断点。

高密度数据表在约 760px 以下不能依赖整表横向滚动。优先保留对象身份、状态、主要数值和行操作，并转换为带持久字段标签的记录卡；排序与全选移入表格上方的移动控制条，溢出操作使用受控菜单或底部操作面。桌面宽度恢复标准表头、行列对应和批量扫描效率。

**The One Operational Spine Rule.** 每个页面必须有一条可快速扫描的主任务轴；附加导航和工具不得与页面态势、主要任务争夺首屏中心。

## Elevation & Depth

系统采用“结构边界优先、低幅阴影辅助”的混合层级。大部分容器依靠背景色差、1px 分隔和空间关系建立深度；阴影只用于面板轻微分离、popover、drawer 和 modal。深色模式提高阴影不透明度，但仍保持扩散、低边缘感。模糊仅服务于 modal、drawer、command palette 等真实覆盖层的背景遮罩，并控制在 2–8px；普通卡片、工具条、登录卡和持久工作面不使用 backdrop blur。

### Shadow Vocabulary

- **面板低层阴影** (`0 14px 36px -32px rgba(15, 43, 52, 0.7)`): 浅色模式中指标条与主要面板的轻微分离。
- **浮层结构阴影** (`0 20px 44px -28px rgba(15, 43, 52, 0.72)`): 菜单、popover 与临时工具浮层。
- **抽屉方向阴影** (`-24px 0 48px -32px rgba(15, 43, 52, 0.48)`): 从右侧进入的详情与操作抽屉。
- **夜间浮层阴影** (`0 20px 44px -24px rgba(0, 0, 0, 0.9)`): 深色模式中保持弹层与深色画布分离。

**The Structural Depth Rule.** 默认面板以色面、边界和间距分层；只有真实覆盖、浮起或方向移动的界面才获得更明显阴影。

**The Compositor Motion Rule.** 状态动画只过渡 transform、opacity、颜色、边界和阴影；不得过渡 width、height、max-height、padding 或 margin。进度与利用率使用 `scaleX()`，抽屉使用 `translateX()`，折叠内容采用即时布局切换配合短 opacity 反馈。

## Shapes

形状语言紧凑而工程化。小型导航与标签使用 7px 圆角，输入与按钮使用 8px，主要面板使用 10px，少量柔和内容卡使用 12px；999px 胶囊只属于短状态、计数和紧凑切换，不用于大型按钮或容器。边框通常为 1px，并从主题的结构分隔色取得。

状态和选择可使用底部短线、图标色、背景 tint 或紧凑标记组合表达。装饰性粗侧边条不是默认容器语言；页面标题现有的分段状态轨是特殊态势标记，应避免复制到普通卡片。

**The Compact Geometry Rule.** 圆角表达可操作性和层级，不表达可爱；组件越大，越应避免胶囊和夸张曲面。

## Components

### Buttons

- **Shape:** 紧凑控制圆角（8px），最小高度 36px，内边距 8px 14px。
- **Touch Target:** 图标按钮固定为 44×44px；在 980px 以下或 `pointer: coarse` 环境中，主要交互目标的命中区域不得小于 44×44px，图标视觉尺寸可以保持 16–20px。
- **Primary:** 使用当前主题主信号色与白色文字，只承载页面或弹层的主要提交动作。
- **Hover / Focus:** hover 使用同色更强状态；focus 使用主色 2px 轮廓或 3px 混色 focus ring；active 可缩放至 0.97，但不得导致布局移动。
- **Secondary / Outline:** 透明背景、结构边框和主文字；hover 才引入弱主色与悬停表面。
- **Danger:** 只用于不可逆或高风险动作，并与确认、影响说明或审批约束配对。

### Chips

- **Style:** 胶囊或紧凑控制圆角，采用语义色的低比例 tint 与同色文字；文字必须保留状态名称。
- **State:** 选中、健康、警告和严重性使用不同语义；不能仅靠颜色区分。

### Cards / Containers

- **Corner Style:** 主要面板 10px；现有内容卡允许 12px。
- **Background:** 使用主题 surface，与全局 canvas 形成稳定色阶。
- **Shadow Strategy:** 默认使用低层阴影或无阴影；popover、drawer、modal 使用对应结构阴影。
- **Border:** 1px 主题结构边界；避免同时使用强边框和强阴影。
- **Internal Padding:** 常规 20–24px；高密度指标项可收敛至 14–16px。

### Inputs / Fields

- **Style:** 主题 surface、1px 结构边框、8px 圆角、36px 最小高度；字段名称必须持续可见或拥有等价的明确可访问名称。
- **Mobile:** 移动与粗指针环境中字段和相邻图标操作至少 44px 高；后缀图标必须扩大命中区域，不能只放大 SVG。
- **Focus:** 边框转为主信号色，并显示统一 focus ring。
- **Error / Disabled:** 错误使用严重故障语义并关联具体恢复说明；disabled 降低对比但保持可读。

### Navigation

- **Style:** 顶部栏承载品牌与全局工具，侧栏承载主信息架构，工作区列表承载已打开页面，面包屑只解释层级路径。
- **States:** active 使用主色文字、弱 tint 和明确位置标记；hover 使用中性悬停表面；所有可关闭页面保持导航链接和关闭按钮为相邻独立控件。
- **Mobile:** 980px 以下侧栏变为 off-canvas；关闭侧栏后主内容必须占满可用宽度。

### Metric Strip

指标条是当前系统最具代表性的态势组件。多个指标共享一个连续面板，用内部结构线而不是独立浮动卡组织；值使用 display 字体和表格数字，标签紧凑，状态色只修改对应指标的语义 tone。可点击指标以底部 inset 标记表示当前筛选。

### Status Encoding

- **Selection:** 主信号青与弱 tint，只表达当前位置、焦点和用户选择。
- **Information:** 运营信息蓝，表达非故障信息、诊断提示和图表辅助序列。
- **Success / Healthy:** 健康绿，表达可用、完成、恢复和健康链路。
- **Warning:** 警戒琥珀，表达等待确认、容量压力或非致命风险。
- **Danger:** 严重故障红，表达失败、严重告警与不可逆动作。
- **Neutral:** 中性文字与表面，表达停用、未知或没有额外风险的状态。

所有状态必须同时提供文字、图标、形状或结构语义之一，不能只用颜色。状态背景采用同色低比例 tint，边界与文字使用对应语义 token；图表序列复用 chart tokens，但不得改变上述运营含义。

### Dense Data Tables

桌面表格保留列对齐、排序表头、批量选择和紧凑扫描。窄屏记录卡通过 `data-label` 持久呈现字段名，身份与状态优先，次要字段按行分隔，操作区保持 44px 触控目标。移动排序条只暴露高频排序字段，不复制完整桌面表头。

### Dialog

Dialog 用于需要中断、确认或保护焦点的任务。它必须有可感知标题，必要时关联描述；打开后背景 inert、焦点受约束，Escape 可关闭，关闭后焦点返回触发控件。高风险 Dialog 必须把对象、影响、确认条件和执行结果放在同一流程中。

### Motion & Reduced Motion

默认反馈使用 150–350ms 的平滑减速曲线。`prefers-reduced-motion` 下移除循环运动、位移和缩放，保留短 opacity、颜色与边界变化，让层级和状态仍可感知；加载旋转可以停止为静态进度标记，但不能隐藏加载文案。

## Do's and Don'ts

### Do:

- **Do** 让首屏先呈现网络与业务态势，再呈现模块入口和次要工具。
- **Do** 使用统一语义 token 表达选择、健康、警告、故障和不可逆动作。
- **Do** 为 IMSI、时间、流量、余额和协议字段使用表格数字或等宽字体。
- **Do** 保持桌面 36px 控件、54px 表格行和 20–24px 页面节奏，同时让图标操作与移动/粗指针命中区域至少达到 44×44px。
- **Do** 让每次高风险操作都呈现影响、权限、恢复与审计结果。
- **Do** 同时验证明暗主题、中英文、键盘操作和 980px 以下的 off-canvas 壳层。
- **Do** 让窄屏高密度表格切换为带字段标签、移动排序和明确行操作的记录卡。
- **Do** 使用 transform 和 opacity 表达进度、抽屉与短暂状态变化，并在减少运动模式下保留非运动反馈。

### Don't:

- **Don't** 把 Open5GS 的视觉或名称置于 xCloud 产品身份之前；集成参考不是品牌主体。
- **Don't** 重新引入动画模糊光团、大面积 glass/blur 或把 backdrop blur 用在持久工作面；登录页只允许静态、低饱和的背景色面。
- **Don't** 用同一种彩色侧边条同时表达选中、严重性、类型和变更。
- **Don't** 把等宽字体、网格背景、辉光或玻璃效果当作通用“技术感”装饰。
- **Don't** 在桌面侧栏、工作区页面和面包屑之间重复同等权重的当前位置表达。
- **Don't** 以静默失败处理权限清理、持久化失败或关键操作错误。
- **Don't** 动画化 width、height、max-height、padding 或 margin，也不要让窄屏用户依赖整表横向滚动来对应字段与操作。
