# IMS 注册观测设计说明

日期：2026-11-11。状态：开发计划，尚未实施。

## Problem

运维人员可以查看 EPC/5GC UE、IMS 网元进程和站点／网络归属，但无法从 xCloud 确认 IMS 注册绑定的观测结果、来源和有效期。HSS 中存在 SIP 身份、S-CSCF 进程存在和 UE 当前注册是不同的事实，页面需要让人看清证据边界。

## Solution

在既有 UE 信息工作区增加 IMS 注册观测视图。用户选择来源或站点／网络，查看公开身份、Contact 绑定、到期时间和来源状态，再进入证据抽屉检查单个身份。身份映射缺失、数据库同步延迟和来源故障保持可辨识。

用户已确认：首版接入中心可直接访问的多个 IMS 只读来源，关联站点／网络；远端 Agent 采集后续扩展。首版不修改 Agent 协议。

## Experience Principles

1. 先表达证据：SIP URI 只表示身份；注册结论必须有经验证的绑定与时间语义。
2. 明确分母：公开身份、Contact 绑定、私有身份分别计数，不推导真实人数或设备数。
3. 保留上下文：来源、分组、搜索和分页可以恢复；来源不可用时不将旧结果表示为当前在线。

## Aesthetic Direction

- 沿用现有 xCloud 运维工作台的紧凑信息布局、语义色和 4px 间距体系。
- 语气克制，以运维证据、可追溯性和可读性为主。
- 不增加新的主题、字体或独立侧栏域。

## Existing Patterns

- [OperationsPageFrame](../../frontend/src/features/operations/OperationsPageFrame.tsx)：共享页框和单一刷新入口。
- [UEInfoPage](../../frontend/src/features/ue-info/UEInfoPage.tsx)：URL 筛选、SWR 读取、来源状态与详情展开。
- `components/ui` 的 PageHeader、MetricStrip、分页、Dialog 和 OperationFeedback。
- `styles/tokens.css`、现有语义颜色及 Noto Sans SC／等宽数据字体。
- [站点／网络工作台](../../docs/architecture/site-network-workbench.md)：显式资源归属、包含关系和独立完整性。

## Component Inventory

| 组件 | 处理 | 作用 |
|---|---|---|
| OperationsPageFrame、共享 primitives | 复用 | 页框、刷新、计数、反馈与键盘交互 |
| UE 视图切换与运维导航匹配 | 修改 | EPC/5GC UE 与 IMS 注册视图互相切换 |
| IMS 来源状态条 | 新建 | 显示读取状态、证据模式、新鲜度和覆盖范围 |
| IMS 身份表和证据抽屉 | 新建 | 区分身份、Contact、有效期与可选 HSS 映射 |
| 分组筛选适配 | 修改／复用 | 以选中 IMS 来源的资源 UUID 解析组织范围 |
| 运维总览 IMS 指标 | 修改 | 使用带明确计数单位的新摘要，不改写旧字段含义 |

## Key Interactions

- 建议路由 `/ims-registrations`，从 UE 信息工作区进入；最终路由在接口契约冻结时确认。
- 筛选变化重置游标；返回、刷新和分享保留来源与分组上下文。
- 默认以公开身份为行，显示有效 Contact 数；抽屉展示有界绑定证据和身份映射来源。
- 数据库读取时间与注册证据时间分别显示；无源、失败、部分、陈旧和完整空结果各有反馈。
- 初始不自动轮询；手动刷新可合并并发请求。用户可选择 30 秒刷新，后台标签页暂停。
- 敏感原始报文、完整数据库错误、连接字符串和认证密钥不进入组件状态。

## Responsive Behavior

桌面保留身份表和主要筛选；窄屏将筛选折叠，身份行保留来源与状态，详情通过抽屉逐项读取。验证 1920、1366 和 390 CSS px 视口，以及桌面实际 80%／200% 缩放；320 CSS px 作为布局下限。

## Accessibility Requirements

状态同时提供文字和图形线索；表头与字段具备可访问名称。抽屉支持键盘关闭、初始焦点和关闭后焦点恢复；来源错误适度公告，自动刷新不抢焦点。沿用共享控件的对比度与焦点样式，中英文同步。

## Out of Scope

信令追踪、抓包、HEP/HOMER、MML、通用 RPC 控制台、注册／注销指令、强制下线、HSS 写入、网元重启、远端 Agent IMS 采集、成功率与失败原因推断、漫游协议、租户隔离及历史在线率。首版不持久化用户注册历史，不扩展日报和 CSV 为 IMS 历史报表。

实现顺序和证据门见 [开发计划](DEVELOPMENT_PLAN.md) 与 [任务清单](TASKS.md)。
