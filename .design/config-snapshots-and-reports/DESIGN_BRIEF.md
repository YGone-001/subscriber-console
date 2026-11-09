# Design Brief: 配置观测快照与运维报表

日期：2026-11-09。状态：拟实施计划，尚未进入业务源码开发。

基线：subscriber-console `develop`，`84058779531162f17107929f2086ac484f7122c7`；CNMS 参考基线 `ad0d032`。后续开始实施前重新核对 Git 状态与真实调用链。

任务清单：[TASKS.md](TASKS.md)。本目录记录未来工作，不替代当前架构文档，不代表部署、API、数据集合或权限已经生效。功能完成后，将最终事实写入正式架构/运维文档，按仓库约定移除已完成的计划正文。

## Problem

当前控制台能展示资源、进程、监测、告警和日志，但运维人员仍难以回答：

1. 某个网元的配置与上次确认版本相比发生了什么变化？
2. 节点失联或采集失败时，页面显示的是当前事实，还是以前的观测？
3. 一个值班时间段内新增了哪些告警、完成了哪些处理、有哪些数据没有采集到？

用户已选择统一中心与多主机只读 Agent 的方向，但目前没有第二台实际 Agent，也没有已提供的远程 HTTPS 接入条件。本计划必须能先在现有单主机环境落地。

## Solution

按顺序交付两个功能：

| 交付 | 主要结果 | 发布依赖 |
| --- | --- | --- |
| A：配置观测快照 | 白名单来源、脱敏快照、版本历史、差异、基线、漂移提示、固定周期采集与保留边界 | 先完成现有 Linux 主机上批准配置清单的真实只读验收 |
| B：运维报表 | 告警与处理统计、可用监测样本汇总、当前待办、配置变化摘要及 CSV 导出 | A 发布验收后推进；复用现有数据库证据，不要求新增 Agent |

首版的“快照”是用于核查差异的脱敏观测记录，不是可以完整还原原始配置的灾备副本。配置文件本身保持只读；采集与设置基线会写入平台管理记录，因此按平台变更执行权限、Fresh Actor 与审计。

## Experience Principles

1. 每个结论都标注来源、时间与范围：最近观测不能冒充当前配置，当前待办不能冒充历史时点状态。
2. 先有明确身份再关联：Inventory UUID 仍是资源权威，Agent ID 仍是采集节点权威，名称/IP 仅用于显示和搜索。
3. 缺口明确可见：读取失败、未采集、无基线、格式不支持和确实无变化必须分开表达。

## Aesthetic Direction

- Philosophy：沿用 xCloud 的功能主义运维界面，以紧凑表格、证据摘要、版本差异为主要内容。
- Tone：克制、清晰，状态色只表达已定义的状态，不以整页绿色表示配置正确。
- Typography：复用现有 Noto Sans SC、系统界面字体和等宽数据字体。
- Colors / spacing：复用 `--sys-*` 语义变量、现有字号与 4px 间距基线，不新增独立主题。
- 布局：平台管理下新增“配置快照”“运维报表”；沿用现有页面框架，不改造现有运维工作台页签结构。

## Existing Patterns and Source Evidence

| 当前实现 | 本计划的使用方式 |
| --- | --- |
| [显式配置清单读取](../../backend/internal/livetopology/manifest.go) | 参考绝对路径与来源有界读取的原则；现有 loader 只服务拓扑投影，不能直接视为完整配置脱敏器，也不能借本任务改变其接口 |
| [Go 注册入口](../../backend/cmd/server/main.go) | 保持 Go 唯一 API owner，使用同一 Mongo client 与 Ops handle，按域接线 |
| [Agent 模型](../../backend/internal/agents/model.go)与[Agent 边界](../../docs/architecture/agent-management.md) | 复用身份语义；当前 Agent 只保存最新观测，不能据此生成历史在线率、远程配置或历史运营商归属 |
| [NF Health 模型](../../backend/internal/nfhealth/model.go)及[仓储](../../backend/internal/nfhealth/repository.go) | 复用真实样本；当前样本默认保留 7 天、最大配置窗口 30 天，报表不能扩写其保留策略 |
| [NF Alert 模型](../../backend/internal/nfalert/model.go)及[评估器](../../backend/internal/nfalert/evaluator.go) | 复用告警实例及时间字段；开放实例重复触发只累计计数，不能把该累计计数当作任意时间段内发生次数 |
| [共享 UI 所有权](../../docs/architecture/frontend-ui-ownership.md) | 使用共享页面、状态、表单、分页及图表组件，新增领域组件只承载新领域语义 |
| [URL/导航定义](../../frontend/src/lib/navigation.ts) | 加法式新增页面，保留列表上下文与现有 URL、SWR 路径 |

CNMS 只借鉴快照、摘要去重、版本比较和报表组织。其固定配置路径、原文落库、同一行号逐行比较、当前在线进程比例作为可用率的做法不移植；模拟诊断、模拟处置不作为可用引擎。

## Component Inventory

已核对共享组件目录：ChartDataTable、chartPrimitives、CursorPagination、DataTablePagination、DataTableState、Dialog、Field、LoadingSkeleton、MetricStrip、OperationFeedback、PageHeader、RefreshButton、SectionHeader、SortableTableHeader、StatePanel、UnsavedChangesGuard、useDialogFocus、ViewSwitch。

| 组件或模块 | 状态 | 计划用途 |
| --- | --- | --- |
| PageHeader / MetricStrip / RefreshButton / SectionHeader | Reuse | 标题、全量筛选统计、单一刷新入口与内容区段 |
| CursorPagination / SortableTableHeader / DataTableState | Reuse | 来源、观测记录和版本列表；不伪造总页数 |
| Dialog / Field / OperationFeedback / StatePanel | Reuse | 采集、设置基线、错误、冲突及不可用态 |
| ChartDataTable / chartPrimitives / Recharts | Reuse | 报表图表与等价数据表；沿用已安装依赖 |
| navigation / router / locales / read contracts / mutation contracts | Modify | 只登记最终实现的新页面与新接口，不改现有实体行为 |
| ConfigSourcesPage / ConfigSourceDetail / ConfigVersionDiff / ConfigEvidenceStatus | New | 配置领域页面、版本差异和多维证据状态 |
| OperationsReportPage / ReportCoverage / ReportSection | New | 报表筛选、时间范围、来源覆盖与分区失败 |
| `backend/internal/configsnapshots` | New | 受控采集、投影脱敏、历史、比较、基线及保留策略 |
| `backend/internal/opsreports` | New | 统一查询规范、集合级统计、分页明细与有界导出 |

## A. Configuration Snapshot Contract

### A1. 来源与身份

- 首版使用独立的服务端静态清单，拟名 `CONFIG_SNAPSHOT_MANIFEST`。浏览器仅提交 `sourceId`，不得提交文件路径、命令、远程 URL 或原始配置正文。
- 每个来源有稳定 UUID `sourceId`、显示名、格式、投影策略、绝对路径与可选显式 `resourceId`。本机采集节点标识由静态部署配置给定，不从主机名/IP 生成或推断 Inventory 身份。
- 现有 `NF_ETC_MANIFEST` 的路径可经维护人员核对后登记为新来源；不扫描目录、不自动导入，不改变旧清单语义。首版不提供浏览器编辑路径或新增来源的入口。
- 资源引用必须存在且未退役；没有明确绑定时标记“未关联资源”，仍可作为本机配置来源使用。不得据来源自动创建 Inventory、Topology 或 NF Health 记录。
- 路径、格式、采集节点、资源绑定或投影策略变化产生新的来源 generation。旧快照保留原归属；旧基线在新 generation 下显示不兼容，不静默延用。
- 首版明确拒绝远程来源，显示 `remote_collection_not_supported`；不通过 SSH、命令队列或既有 Agent 心跳偷偷读取远端文件。

### A2. 读取、脱敏与变化判定

- 使用文件白名单、受控目录、常规文件限制和打开后的文件描述符校验，拒绝符号链接、设备、FIFO、越界路径与采集中被替换的文件。错误响应不回显原文或敏感内容。
- 风险验证先于完整页面：用经批准的真实配置结构及合成密钥测试 parser、路径约束、日志脱敏和读取权限。
- 首版支持批准的 YAML/JSON 结构化投影策略。仅允许确认非敏感的字段进入快照；注释、未知字段、密钥、密码、鉴权材料、带凭据 URI 不落库、不进入 API、不进入日志。复杂标签、重复键、不能安全解释的结构退化为 metadata-only，不通过后缀猜安全性。
- freeDiameter、IMS cfg/XML 等尚无经过校验策略的格式，首版仅记录元数据与受保护的内容指纹，不展示原文或伪造空白 diff。
- 公开摘要只针对脱敏投影计算 SHA-256。原文变化指纹使用单独密钥的 HMAC-SHA256，仅服务端保存，永不返回；不保存原文，也不暴露原文 SHA-256。密钥不写进浏览器或清单，算法/密钥版本发生变化时不得据此制造漂移。
- 两次原文指纹一致且策略/generation 兼容时，追加观测时间但不重复生成内容版本。原文变化而投影相同时显示“未展示内容发生变化”，不推断一定是密钥变化。
- 版本由不可变 UUID 标识，按采集时间与 UUID 稳定排序；不使用“查询最大版本再加一”的并发实现。

### A3. 状态、差异和基线

- 分开返回本次采集结果、最近成功观测时间、内容可见范围、基线兼容性和比较结果，不使用一个绿色状态覆盖所有维度。
- 采集状态包括 not_collected、ok、unreadable、invalid_config、unsupported、changed_during_read、storage_unavailable。失败记录不能覆盖上次成功快照并伪装成当前结果。
- 比较结果至少区分 no_baseline、incompatible、unchanged、visible_changed、unprojected_changed、unavailable，并明确比较的是哪两个快照及覆盖哪些字段。
- 文本展示基于安全的规范化投影，使用有界的序列 diff；中间插行不得导致整个尾部误报。数组只在策略明确允许时排序，不改变有序配置语义。
- 元数据模式、策略版本不兼容、比较预算耗尽分别显示原因；不能显示为“无差异”。差异内容按纯文本渲染，不执行 HTML 或从配置加载资源。
- 设置/替换/清除基线使用 expectedRevision CAS，并保留主体、时间和引用的快照 ID。选中的快照必须属于同一 source/generation，存储完整且未进入清理状态。
- “基线”只表示运营确认的比较参照，不证明服务健康、配置已加载或配置正确；首次采集不自动设基线。

### A4. 拟新增存储与边界

只在 `xcloud_ops` 内拟新增以下平台集合；它们目前不存在于本功能实现中，不修改任何既有 xCloud 文档 schema：

| 集合拟名 | 内容 | 关键约束 |
| --- | --- | --- |
| `app_config_sources` | generation、revision、最近观测引用、基线引用和主体 | 来源身份不可变；所有管理状态更新 CAS |
| `app_config_snapshots` | 不可变脱敏投影、策略版本、内部指纹、采集主体和时间 | 不保存原文；引用归属可复验；内容版本不会被更新覆盖 |
| `app_config_observations` | 每次采集成功/失败/未变化及其 snapshotId | 请求幂等；失败与无变化也能查询；不含原文、私密路径或凭据 |

读取接口不创建集合、索引、来源记录或快照。新集合时间使用 BSON datetime，API 投影为 UTC RFC 3339；不顺带迁移既有集合时间字段。新集合约束通过独立显式初始化步骤提供；既有集合索引先检查执行计划，按仓库要求报告 PERFORMANCE_FINDING，不在报表读路径自动建索引。

手动采集与定时采集复用同一服务。定时采集仅支持服务端声明的固定间隔，默认关闭；不引入 cron 表达式、通用任务菜单、Shell 或远程命令。定时任务记录 system actor，浏览器操作记录经过重新校验的用户。

保留建议：观测记录 90 天；普通内容版本最多 90 天、每来源最多 100 个，任一门槛到达即清理最旧且不受保护的版本；当前基线和最近成功快照例外保留。清理由固定类型任务执行，基线设置与清理的并发必须有原子保护。达到硬容量上限时明确拒绝新增，不能静默删除受保护版本或返回采集成功。来源移出清单后仍可按同一保留规则读取历史，只拒绝新采集。

### A5. 权限与拟新增 API

读取使用 `core.read`；手动采集和基线变更使用 `core.configure` + Fresh Actor。admin/operator 可执行已登记来源的上述平台变更；viewer 的变更请求为 403。静态路径/策略清单由部署维护，不把管理员权限等同于任意文件读取权。

以下为候选契约，实施第一项任务时冻结最终请求/响应并登记，既有 API 路径不改：

| Method | 拟新增路径 | 目的 |
| --- | --- | --- |
| GET | `/api/config-snapshots/meta` | 格式、策略、状态、边界与权限提示 |
| GET | `/api/config-snapshots/sources` | 来源、基线摘要与全量筛选统计，游标分页 |
| GET | `/api/config-snapshots/sources/{sourceId}` | 来源详情；未采集不触发自动写入 |
| POST | `/api/config-snapshots/sources/{sourceId}/captures` | 服务端受控采集；请求幂等与并发保护 |
| GET | `/api/config-snapshots/sources/{sourceId}/observations` | 成功/失败/未变化的观测记录 |
| GET | `/api/config-snapshots/sources/{sourceId}/snapshots` | 内容版本列表，游标分页 |
| GET | `/api/config-snapshots/sources/{sourceId}/snapshots/{snapshotId}` | 脱敏投影或 metadata-only 说明 |
| GET | `/api/config-snapshots/sources/{sourceId}/diff` | left/right 两个同来源兼容版本的差异 |
| PUT | `/api/config-snapshots/sources/{sourceId}/baseline` | 设定/清除基线，携带 expectedRevision |

操作成功与拒绝记录 best-effort 审计，不加入审批依赖。配置原文、内部指纹、绝对路径和密钥都不能出现在审计 payload。跨来源版本引用、并发冲突、已退役资源、未知来源、超限和存储失败返回独立错误码。

## B. Operations Reporting Contract

### B1. 时间与数据口径

- 默认最近 24 小时，可选 1 小时、7 天和自定义范围，首版最大跨度 7 天。UTC 存储和查询，界面按客户端时区显示，导出携带 UTC 时间与时区说明；统一使用半开区间 `[from,to)`。
- 每次响应包含 generatedAt、查询条件、各分区的来源、保留窗口、已观测范围、排除记录数及 `complete|partial|unavailable`。查询成功与样本覆盖是不同维度。
- 数据来自现有权威集合：Inventory、NF Health targets/runs/samples、NF Alerts、Agent 最新记录，以及 A 的来源/观测元数据；不从前端分页结果累加平台总量，不二次请求外部网元，不读取配置正文。
- 跨集合读取是最终一致，不宣称同一数据库快照。摘要和导出共享查询规范；不同请求各自标注生成时间，不承诺期间发生变更时数值仍完全一致。

### B2. 首版统计

| 分区 | 可交付指标 | 明确限制 |
| --- | --- | --- |
| 告警 | 按首次触发时间统计新增实例；按 acknowledgedAt/resolvedAt 统计本窗口确认/关闭；按严重度、资源分组 | triggerCount 是实例累计值，不是窗口发生次数；关闭原因单列，规则删除不算网络恢复 |
| 处理用时 | 对本窗口已确认/关闭且时间字段合法的实例，统计触发至确认、触发至关闭用时，显示有效样本数和排除数 | 名称为告警处理用时；不是业务中断时长或 MTTR；手动关闭与自动恢复分开 |
| 当前待办 | 截至 generatedAt 的未闭环告警及其当前状态 | 单独标为当前队列，不能称所选历史时点的待办 |
| 监测 | 已接受样本数量、首末采样时间、按目标/指标的 last/min/max，以及有意义的 gauge 均值 | 保留期不足或断档明确标识；缺样本为 null；counter 不直接计算均值、百分比或成功率 |
| 配置 | 窗口内采集成功/失败、观测到变化的次数、当前无基线来源 | 观测时间不是实际修改时间；只读已存记录，不触发采集；无 A 数据时标未配置 |
| Agent | 当前在线/过期/离线/未接入数量和最新接收时间 | 只提供当前快照，不提供历史在线率、期间宕机时间或按历史运营商归属统计 |

首版无 SLA/服务可用率、无历史运营商漫游分析、无预测、无 AI 自动根因、无“重复故障次数”的伪时间窗统计。目标采样间隔的历史变化尚无完整记录，不用当前间隔倒推历史应有样本数；采样连续覆盖不能确定时保持 unknown，不以首末样本覆盖整个时间窗作为连续测量的证明。

筛选首版为时间、资源 UUID、可解析的资源域、告警严重度。每个分区声明实际支持的筛选维度；不能应用筛选的分区显示不支持或不参与，不能在某资源报表内混入全平台统计。Agent/networkKey/PLMN 仅有当前管理元数据，首版不作为其他分区的历史筛选维度。

### B3. API 与导出

| Method | 拟新增路径 | 目的 |
| --- | --- | --- |
| GET | `/api/ops-reports/summary` | 全量筛选统计和分区完整性 |
| GET | `/api/ops-reports/alerts` | 同条件的告警实例明细，游标分页 |
| GET | `/api/ops-reports/metrics` | 同条件的目标/指标聚合明细，游标分页 |
| GET | `/api/ops-reports/export` | section=alerts/metrics/config 的有界 CSV |

读取和导出均为 `core.read`，首版不创建报表集合、后台生成任务、定时报表推送或新遥测仓库。报表内容按已有权限过滤，不额外引入租户隔离。

CSV 复用同一查询规范、字段解释与 null 语义，包含生成时间、范围和来源说明；防止公式注入，正确处理换行、引号和 Unicode。超出导出上限时在写响应体前明确拒绝并提示缩小范围，不静默截断；来源不可用时不下载伪空报表。

## Key Interactions and Routes

候选 SPA 路由为 `/config-snapshots`、`/config-snapshots/:sourceId`、`/ops-reports`。共用现有 cookie 会话、SWR 读取与 mutation 客户端，浏览器不持有文件/数据库/机器认证能力。

配置来源列表：按来源、资源和观测状态筛选；卡片表示全量筛选结果。进入详情后查看观测记录/内容版本，选 left/right 比较；支持设置基线，发生 CAS 冲突时刷新后重新选择，不自动覆盖。最近读取失败时，将失败原因与历史成功快照并列显示。

报表：先选择范围和筛选再生成，展示每个分区的覆盖与失败原因，只有取得可用数据的分区才可导出。快速修改筛选时旧响应不得覆盖新结果；换条件重置游标；导出采用点击时冻结的条件，并明确独立生成时间。

列表/详情保留 returnTo，页签、筛选、版本选择与分页写入 URL。不能把原始配置、指纹或凭据放进 URL、localStorage、SWR 缓存或前端错误遥测。

## Responsive Behavior and Accessibility

- 桌面优先：1280/1440 视口使用表格与并排差异；窄屏切换统一差异视图，保留独立代码区滚动，页面本身不横向溢出。
- 390px 移动视口：筛选纵向排列，操作触达至少 44px，版本选择和基线操作可用。
- 使用现有 Dialog 焦点管理、可见焦点、表格标题和 aria-sort。状态不能只靠颜色；差异加减标记同时使用文本/符号；报告图表提供数据表。
- 加载、空、未配置、部分、失败、403、404、409、超限和长名称分别验收；中英文 locale 同步，不放硬编码业务文案。

## Resource Budgets

以下为实施起点，需在 Linux 夹具与首批批准配置上校验；调整必须记录依据，不能用删数据或静默截断达标。

| 项目 | 初始预算 |
| --- | --- |
| 配置来源 | 每控制器最多 128 个，每来源一个明确文件；多文件按多个来源登记 |
| 原文件 / 脱敏投影 | 原文件最多 1 MiB；投影最多 256 KiB；超限仅保留明确的失败/元数据说明 |
| 采集 | 全局并发 2、每来源并发 1；单次总预算 5 秒；POST 每用户 20 次/分钟 |
| 周期 | 默认关闭；启用后只接受 60 至 86400 秒固定间隔，不补跑无界历史任务 |
| 列表 | 默认 50、上限 200，稳定游标；摘要按全量筛选计算 |
| 差异 | 输入最多各 5000 行，总计算预算 2 秒，输出最多 10000 行；超限返回不可完整比较 |
| 报表 | 最大 7 天；查询总预算 10 秒；按用户 30 次/分钟；显式索引检查 |
| CSV | 每次最多 10000 行或 10 MiB；预检后生成，超限拒绝；客户端取消须停止工作 |
| 容量 | 配置内容持久化预算初值 1 GiB、观测记录预算独立配置；压力验证后确定硬门槛与拒绝错误码 |

## Verification and Release Gates

1. 隔离安全验证：读取白名单、符号链接/替换/特殊文件、二进制/非法编码、秘密注释/嵌套字段/URL、未知格式、重复键、超限；检查 DB/API/日志/导出均无合成密钥泄漏。
2. 并发与语义：同内容不重复版本、相同请求幂等、并发采集、CAS 冲突、基线与清理竞争、generation/策略/密钥轮换、失败不覆盖历史、资源退役。
3. 报表：窗口边界、跨窗口告警、关闭原因、缺失/非法时间、无样本、过期保留窗口、分区失败、分页总量、筛选维度与 CSV 公式注入。
4. 实现验证：Linux Go 单元/集成与 race/vet/build；React 类型/lint/测试/build；真实浏览器键盘、桌面/移动及错误态。已有测试通过数不作为未来实现的完成证据。
5. 契约验证：按最终注册集合更新唯一计数权威、SPA/read/mutation 契约、架构门与必要的 AGENTS/CLAUDE 配对；新增内容通过文档、归属、前端运行时及字体门禁。
6. 实际 Linux 验收只读取批准的文件；真实配置变化检测使用用户已完成的变更或隔离文件，不为验收修改网元配置、重启网元或注入故障。
7. 交付 A 和 B 各自可独立发布/回退；默认未配置或关闭时现有功能不受影响。只读数据库恢复/错误处理不得修改既有业务数据。

## Multi-Agent Extension

后续另开能力增量：节点本地声明配置白名单，Agent 在本地投影脱敏后主动推送；中心不下发文件路径或 Shell。新增机器接口与能力协商，保持现有 session/report 协议严格校验及旧 Agent 兼容；明确节点、来源 generation、资源绑定和传输预算。

开始真实远程验收前须有第二台 Linux、有效 HTTPS、独立机器凭据和批准清单。网络/运营商/PLMN 仍只作为当前归属，历史归属与租户隔离另行设计。没有这些条件不阻塞 A/B 的单主机交付，但不能宣称多主机配置验收完成。

## Out of Scope

- 信令追踪、MML，以及作为其配套扩展的抓包链路。
- 配置恢复/下发、任意文件下载、远程执行、网元/Agent 重启、自动修复和通用定时任务。
- 重建已有日志、告警、知识库或 Inventory/Topology；自动推断资源归属或业务影响。
- 原始秘密备份、可恢复灾备副本、完整配置编辑器和浏览器配置路径 CRUD。
- 多租户隔离、漫游协议、历史归属推断、SLA、计费面、AI 根因和容量预测。
- 未经实际服务发布而声称功能已上线；计划阶段不修改 Nginx、服务、数据库或业务配置。
