# 指标阈值告警、历史聚合与异常趋势开发计划

日期：2026-11-21
状态：实施中；T01–T08 已实现指标阈值闭环与小时/日聚合、保留期和有界补算，后续未勾选项仍为提案。当前事实见 docs/architecture/metric-threshold-alerts.md 与 docs/architecture/metric-history.md。
依据：[开发范围](DESIGN_BRIEF.md)；基线 develop / 90bc35ea。

## 交付策略与工作量

| 交付 | 可验收结果 | 建议投入 | 依赖 |
|---|---|---|---|
| 语义核验 | 指标资格、身份、质量、预算及向后兼容合同 | 2–3 人日 | 无 |
| 阈值告警 | 规则配置、持续触发、迟滞恢复、证据与既有通知 | 7–10 人日 | 语义核验 |
| 历史聚合 | 小时/日统计、历史图与报表、补算和质量说明 | 7–10 人日 | 语义核验；建议在阈值交付后进入 |
| 异常趋势观察 | 每小时分析、可解释基线、事件详情与调查入口 | 5–7 人日 | 历史聚合 |
| 验收及告警接入 | 故障回放、部署验收、显式订阅与回退 | 3–5 人日 | 前述交付 |

总计约 24–35 人日，是单人有效投入估算，不含现场数据积累和外部评审等待。先交付 gauge 闭环；counter rate 扩展预留 3–5 人日，单列验收。首次异常分析至少积累约 48 小时兼容数据；建议观察一周并复核误报后，才启用异常通知。

每个编号是可独立评审的工作包；实现时按后端与前端分别小提交，工作包验收覆盖端到端行为。出现身份不可验证、指标语义不明时收缩可选指标，界面显示原因，不伪造可用性。

## 现有能力复用

| 现有模块/组件 | 处理方式 | 计划变更 |
|---|---|---|
| nfhealth 注册表、原始样本、window_identity/service_window | 复用并扩展 | 单一 series/质量适配器，不复制另一套计数器算法 |
| nfalert evaluator/repository/hook | 修改 | 新增 metric_threshold 分支及持久化评估状态，旧规则兼容 |
| notify outbox/worker/升级规则 | 复用；必要时加字段 | 新证据安全摘要和投递去重，不新增通知平台 |
| NfAlertRuleDialog、NfAlertEvidenceDrawer、NfAlertsPage | 修改 | 指标表单、恢复条件、规则版本与质量原因 |
| NfHealthDetailPage、ServiceWindowPanel、BusinessRulePanel | 前者修改；后两者复用 | 聚合图和分析入口；业务过程观测继续只读 |
| PageHeader、Field、Dialog、StatePanel、OperationFeedback、ChartDataTable | 原样复用 | 不另建页框、表单或图表无障碍组件 |
| SWR、共享请求客户端、现有 locale/tokens/图表样式 | 原样复用 | URL 状态、取消请求、双语与明暗主题沿用现状 |
| opsreports、investigation | 加法式修改 | 聚合/分析引用入口；不把当前台账充当历史事实 |
| metric aggregation/analysis 后台任务 | 新增 | 使用现有 Go 进程与 Ops 数据库，不引入外部时序库 |

## 语义核验与最小体验

- [x] **T01 指标能力目录与规则选择预览**：修改 NF Health meta、指标注册表和规则表单，逐项登记类型、单位、来源、归属、scope、比较资格及原因；先让目标/指标/单位/不可用原因可审查。单 target 单 series，服务端拒绝类型不符、未知指标、歧义序列和客户端自报身份。验收：exporter RSS 不冒充 NF 内存，累计 CPU 秒数不冒充百分比，process_only 不出现虚构 HTTP 指标。复用 Field/StatePanel。依赖：无。
- [x] **T02 规则与质量合同冻结**：新增纯函数评估模型和测试，修改表单校验与错误反馈，定义 satisfied/recovered/indeterminate，以及 pending/firing/recovering 的时间语义。固定指标资格、缺口、过期、重复和乱序策略、服务端预算及错误码。验收：用固定采样序列演示触发、保持、恢复；新规则的 indeterminate 永不进入既有 false→恢复逻辑；旧 state/run_failed 合同测试保持。依赖：T01。

## 阈值告警闭环

- [x] **T03 单样本阈值闭环**：扩展现有规则 CRUD、meta、规则列表和证据抽屉，新增 conditionType=metric_threshold 和独立 metricCondition。支持 gt/gte/lt/lte；触发/恢复阈值按方向校验，单位由服务端推导。起步 duration=0 也只按有效证据执行。验收：配置 gauge 阈值后手动及定时采集均能开警，重复回放不重复开警，正常值可恢复，缺失值保持不确定。复用既有告警生命周期和唯一索引。依赖：T02。
- [x] **T04 持续触发、迟滞与重启恢复**：新增 app_nf_metric_rule_states，状态由 ruleId/targetId/series/规则评估版本确定。记录 lastSampleId、lastObservedAt、firstBreachAt、firstRecoveryAt、lastEvaluationQuality 等；CAS/串行化和确定性评估 ID 保证重复与乱序不推进状态。跨评估状态、告警与通知意图的写入采用可重放 pendingTransition 日志及幂等应用，不能先标已处理再丢失开警；复用通知已有 outbox，不假设部署支持 Mongo 多文档事务。修改表单加入持续时间、恢复阈值和恢复持续时间。缺口打断 pending/recovery 累积；firing 告警保留，等待新鲜有效证据恢复。验收：进程重启、并发手动/定时采集、规则更新、停用再启用均不继承不兼容计时。依赖：T03。
- [x] **T05 评估失败可见与有界补偿**：扩展采集后 observer，状态仅在采样成功持久化后推进；失败不阻塞采集。新增有界恢复扫描和进度记录，捕捉 hook 丢失；单 target 顺序处理。live 通知只针对新鲜证据，补偿历史不发送过时开警；中间发生的观测用回放诊断说明。保留失败、积压、最新处理时间可见性；缺历史无法恢复时明确 incomplete。验收：模拟样本已落库而 hook 失败，恢复后状态一致，无重复投递、无无限扫描。依赖：T04。
- [x] **T06 通知、调查与规则编辑闭环**：扩展现有通知安全摘要、证据详情和调查上下文；告警保存触发时不可变规则配置/版本与决定性证据引用，最近观测另存，避免编辑规则改写历史解释。规则编辑/停用时只处理新型指标规则的待计时状态；开放告警按显式 configuration_changed/rule_disabled 原因闭合，不标成实测恢复。删除沿用既有 rule_deleted。验收：通知幂等、升级规则有效、viewer 403、编辑冲突保留草稿、调查可看到指标条件而不依赖可过期的原始样本。依赖：T05。

建议参数：触发/恢复持续时间各 0–3600 秒，缺省 0；正值需至少两个不同观测时间的有效样本。maxGap 复用现有按采集间隔推导的规则，不允许长时间失联后按墙钟直接满足持续条件。迟滞带内保持当前状态并打断尚未完成的触发/恢复计时。gt/gte 的恢复阈值须不高于触发阈值；lt/lte 反向。相等时明确互补恢复比较，不能出现同一值既触发又恢复。

## 历史聚合

- [x] **T07 小时聚合与趋势读取**：新增 Go 聚合模块、app_nf_metric_aggregates 和 NF Health 详情的小时趋势选项。复用已验证 series 身份、类型、配置绑定及 incarnation；不同身份 epoch 分桶，不跨重启/重置拼接。只汇总已接受的 gauge，保存 count/sum/min/max、观测边界、质量及有效覆盖。首版均值明确为样本均值，不冒称时间均值；覆盖按有界有效相邻间隔并集计算，不以 count 冒充。验收：小时桶 [from,to) 为 UTC，重复 worker 不重复计数，未知 scope 不合桶，缺口断线。依赖：T02；按交付顺序在 T06 后实施。
- [x] **T08 日汇总、保留与有界补算**：扩展聚合 worker、详情 7d/30d/90d 视图及运维元信息。日统计从小时的 sum/count 加权合并，min/max 合并；不平均小时均值、不合并小时 P95。默认小时保留 30 天、日保留 90 天，原始样本保留政策不变。worker 只处理闭合桶，建议预留 5 分钟迟到宽限；聚合桶可在原始证据仍存在时重算，版本条件写替换而非增量重复累加；小时桶变更须带动受影响日桶重算，并标记所引用分析结果过期。验收：跨日、迟到、补算、空桶、源样本 TTL 后无法重算及 worker 中断均显式报告，不产生“零流量”。依赖：T07。
- [ ] **T09 统计分位与报表复用**：新增小时原始 gauge 的精确 P95（有界排序）及 sample_count，修改 opsreports 和 ChartDataTable 显示单位、分辨率、质量和算法版本。超过排序/扫描预算时返回不完整，不偷偷采样；日 P95 暂不提供。验收：确定性样本校验结果；CSV 正确转义；原始、聚合分区不可混算；历史资源名称/当前归属按已有报表规则清楚标识。依赖：T08。
- [ ] **T10 counter 区间扩展（独立可延期）**：复用 service_window 和 window_identity 的兼容性验证，新增注册批准的 counter 增量/速率聚合及单位解释，必要时抽取共享纯函数。区间按时间边界切分，累计总数不求均值；重启、重置、重复时刻、超长间隔、标签塌缩一律排除。速率使用有效 delta 总和 / coveredSeconds，不平均 interval rate；默认不加入阈值候选。验收：边界区间不双计、重置不负增量、零流量与缺测不同；业务完成比例仍 observation_only。依赖：T08。

聚合 API 提案：新增 GET /api/nf-health/targets/{targetId}/metric-history，参数 metric、from、to、resolution=1h|1d、series、cursor；旧 history 接口保持。返回单位、metricType、bucket 边界、value/count/min/max/quality/coverage、数据水位、分页和完整性，不回传私有 scope 材料。小时最多查 30 天、日最多查 90 天，单次最多 200 桶、limit+1 检出截断；跨页 series 和截止水位绑定，发现聚合版本变化则提示重新读取，不声称跨页事务快照。

初始资源预算提案：最多 2 个聚合 worker；按目标/series/时间分片，每查询 2 秒 deadline、最多 10000 样本、单片最多 1 小时；读取前一边界点仅供判断，不重复归属。超限分片或显式 incomplete，不能把截断样本当完整桶。索引/TTL 通过独立 dry-run/apply CLI 创建，不在 GET 或普通启动中暗建。是否可承受以上预算由 T01 数据量核验和负载测试决定，可降低并发，不放宽正确性。

## 异常趋势检测

- [ ] **T11 基线与异常分析卡片**：新增版本化纯函数分析器和 app_nf_metric_analysis，修改 NF Health 详情新增分析区。以当前已闭合小时桶与此前 48 小时同身份同单位同算法数据比较，当前桶排除在训练集外；至少 80% 合格基线桶且每桶覆盖达 80%，否则 insufficient_data。首版采用 median/MAD 稳健偏离评分，阈值与单位化最小绝对变化由显式服务端策略确定；MAD=0 时使用该最小变化门槛，不除零。只有正向登记的指标可分析。验收：离群峰值、平稳低噪声、冷启动、身份切换、数据过期都有确定性说明，不给“故障概率”。依赖：T08；若使用 P95 输入则另依赖 T09。
- [ ] **T12 持续趋势与事件目录**：新增最近 8 个小时桶的趋势计算（至少 7 个合格且末两桶连续），使用线性斜率加可配置最小绝对变化量、方向和拟合质量；拟合优度用于诊断，不当作故障置信度。连续两次合格评估确认后才形成事件。扩展现有 NF Health 页面 URL 筛选/分页及详情，显示基线/分析窗口、实际变化、样本覆盖、策略版本和排除原因；可引用资源进入既有调查工作台。验收：上升、下降、一次尖峰、断续数据、迟到重算、长期低覆盖和重启冷启动结果明确。依赖：T11。
- [ ] **T13 影子观察与显式告警接入**：先记录和显示分析结果至少一周，复核离群结果、漏检样例和资源成本；不得默认发通知。通过验证后，在现有规则表单增加 metric_analysis 类型，用户显式选择指标/策略/方向和严重度，经现有权限、去重、通知、升级链处理。分析不可用不清除开放告警，恢复需连续两次有效正常分析，最长保持不等于自动恢复。验收：同一 target/series/bucket/算法/策略版本的事件幂等；历史回放不发通知；用户可停用分析通知而保留阈值告警与历史曲线。依赖：T12、T06。

首版分析事件表达 statistical_anomaly / rising / falling，仅说明测量变化；不修改 overall/L3、不称为根因、不生成容量 ETA。没有够长兼容数据时，显示冷启动而不是“正常”。所有数值默认值在 T01/T02 后冻结，用户策略更新有 CAS 与版本，不偷偷自学习改变阈值。

## 数据与接口合同

提案只新增 Ops 内部集合：

| 集合 | 用途与关键约束 |
|---|---|
| app_nf_metric_rule_states | 唯一 ruleId/targetId/series；版本化评估状态、样本去重、水位/补偿状态；无无条件 TTL，清理仅针对已废弃规则版本 |
| app_nf_metric_aggregates | 唯一 targetId/series/identityEpoch/metric/period/bucketStart/algorithmVersion；BSON Date 桶时间与 expiresAt TTL；CAS 发布版本 |
| app_nf_metric_analysis | 唯一 targetId/series/metric/bucketStart/algorithmVersion/policyVersion；基线及证据摘要，建议 90 天 TTL |

不新建 NF 身份库或第二个告警集合；分析结果是证据，告警仍归 nfalert。新规则、聚合和分析中的 source/epoch 仅留安全、不透明标识；不存原始 labels、命令行、endpoint、订阅者标识或凭据。过期原始样本不能作为长期事件解释的唯一材料，事件保留必要的安全数值摘要与规则快照，明确 rawEvidenceExpired。聚合重算后的新分析保留新版本和 supersedes 关联，历史已发通知的触发证据不得覆盖。

复用现有 /api/nf-alerts/meta 和 rules CRUD，加法式新增 metricCondition/analysisCondition、metricCapabilities 和质量原因；ConditionType 的新增值不能导致旧记录不可读。新条件类型在旧二进制回滚时不能静默当 false 导致恢复，部署回退前须先暂停新规则评估。

分析查询提案：GET /api/nf-health/targets/{targetId}/metric-analysis，提供有界时间窗、游标和质量过滤。分析策略首版由部署配置显式声明、经过校验，运行时只读；如需要 UI 编辑再独立增加受治理写接口，避免把算法阈值隐藏在前端。

新增路由最终以 Go 实际注册为准；同步共享注册集合/契约普查，不预先硬编码路由数。所有新读接口需 core.read；策略和规则变更需 core.configure、Fresh Actor、CAS 和 best-effort 审计，现有端点专属权限及限流继续保留。

## 验收与回退

- [ ] **T14 端到端与容量验收**：扩展 Go、前端语义测试及 Playwright 验收，覆盖创建→采样→pending→触发→通知→迟滞→恢复、失败/缺失保持、重启补偿、乱序/重复、并发规则编辑、数据过期、聚合迟到重算、基线冷启动与显式通知。后端包测试与 race 验证新状态机/worker；前端验证键盘、焦点、双语、明暗主题、冲突草稿、URL 返回上下文与图表数据表。负载至少包含 100 目标 × 10 series × 30 天每分钟样本的离线回放及有界真实 Mongo 查询；报告 p95、扫描量、桶数、积压恢复速度和内存，query explain 应命中预期索引；查询超时不得返回假完整。依赖：按每个交付分别执行，不积压到最后。
- [ ] **T15 文档、部署与回退演练**：每项功能通过后更新对应 architecture/operations/database 与 AGENTS/CLAUDE（只登记已实施事实）；UI 与后端分开 commit，Conventional Commits 使用内容描述。检查 Go 路由、变更合同、索引、权限与文档一致性。部署默认关闭新 worker/新规则类型；先建索引，再启聚合和 shadow 分析，再由操作员启用规则。回退先暂停新型规则/通知与 worker、保持旧告警能力，保留新集合与历史，不自动删库、不伪造恢复；不承诺直接回滚旧二进制兼容新增枚举。依赖：各交付完成时执行。

对应代码门禁：Go go test ./...、go test -race ./...、go vet ./...、go build ./...；frontend npm run check；根目录架构、文档、API ownership、前后端边界、agent-docs-parity 门禁；变更端点运行对应真实 Mongo 合同测试及 acceptance:nf-alerts，补充聚合/分析场景。纯计划提交只运行文档完整性与配对检查，不以通过文档门禁声称功能已验收。

每次交付必须提供：实际实现范围、合同变化、Ops 读写集合、测试结果、未覆盖现场条件、回退结果和工作区状态。没有真实部署验证时，只报告“源码/隔离验证通过”。

## 首个开发工作包

从 T01–T03 开始，先完成“一条已验证 gauge 的阈值告警”纵向闭环，审查真实指标归属与缺测行为后，再进入持续时间和历史 worker。T10 counter 扩展可延期，不阻塞 gauge 聚合与异常观察。容量预测与 RCA 保持后续独立需求。


## 当前实施边界

T01–T03 的源码闭环已实现：单目标、单无标签 exporter RSS gauge、gt/gte/lt/lte、立即触发/恢复与迟滞、不可变触发证据和独立恢复证据、双语表单和服务端预览。提前引入了 T04 所需的持久化水位与可重放发布日志，避免首次交付依赖易失内存去重；持续触发/恢复、身份与版本隔离、缺口重置和重启续算已完成；有界后台补偿扫描已实现；历史聚合和异常趋势仍未实现。指标条件现可按 CAS 编辑；编辑/停用按显式配置原因关闭旧告警，不冒称实测恢复。


T04 已实现：触发/恢复持续秒数各 0–3600，旧规则缺省为 0；正时长需至少两个单调观测及已验证 exporter 连续身份。按观测时刻计算进度，失败/缺测/迟滞/超限间隔重置；元数据编辑、停用/启用、目标配置版本和 exporter incarnation 隔离计时。精确时间采用 RFC3339Nano BSON 字符串，兼容旧 Date 水位。表单、进度与证据双语呈现，持续条件现可按 CAS 编辑。T05 的后台补偿扫描已实现，范围和限制见当前架构文档。


T05 已实现：live callback 与后台 worker 共用受控顺序重放；每 30 秒扫描最多 16 条规则，每规则最多 128 条运行及关联样本，最长回看两小时。旧记录只重建观测计时，不补发历史告警；完全追上后仅最新新鲜观测可发布。记录中间态、样本 TTL 缺口、密集时间桶、规则版本和数据源失败均显式报告；源读取失败不能绕过补偿直接评估新样本。计时/水位仍为单控制器 CAS，诊断复用现有状态集合与规则页，无新路由、集合或自动索引。超窗口和迟到写入不做无限回溯，当前读取也不宣称历史完整。

T06 已实现：通知 outbox/webhook 与调查上下文携带安全的触发条件、版本和数值证据；原始样本过期不影响告警摘要解释。metricLatest 与不可变触发/恢复证据分开。指标条件可经 Fresh Actor + CAS 编辑，规则类型和目标不变；规则修订以 configuration_changed、停用以 rule_disabled 关闭旧告警，不伪造实测恢复。规则 CAS 原子记录私有关闭意图，后台包含待收尾的停用规则；通知仍遵循既有 best-effort 和幂等键语义。T07 小时聚合已实现；日汇总和补算仍未实现。

T07 已实现：独立默认关闭 NF_METRIC_AGGREGATES_ENABLED；复用采集发布/身份/连续性证明，只汇总无标签 exporter RSS gauge。一个 UTC 小时文档原子保留最多 32 个身份/缺口分段，保存 count/sum/min/max/样本均值及相邻有效区间覆盖；最多扫描 10000 条记录，超限不发布截断统计。每分钟最多访问 16 个目标，仅生成最新闭合小时（5 分钟宽限），重复已完成小时不写；当前不补算停机/历史缺口。只读 metric-history 接口支持 30 天范围和每页 200 桶、版本绑定分页；详情页复用共享控件和 ChartDataTable，提供 24h/7d/30d 小时视图、缺失说明、分段质量与覆盖。Ops 新增 app_nf_metric_aggregates，独立 dry-run/apply CLI 管理索引；日聚合、TTL、迟到重算和有界补算留给 T08。

T08 已实现：日桶只由已发布小时桶派生，count/sum 相加、min/max 扩展、均值按总量重算，不平均小时均值也不推导分位；同一身份且跨小时边界间隔在采集容许内才合并分段，缺小时、换身份或超限间隔另起分段，日覆盖为已裁剪小时覆盖之和。小时桶保留 30 天、日桶保留 90 天，经 expiresAt 与 ttl_nf_metric_bucket 由 MongoDB TTL 监控删除，原始样本保留期不变；日桶记录参与小时数与缺失小时数，未闭合日发布但标为 day_not_closed，并保存所消费小时 revision 的 sourceDigest 作为后续分析过期句柄（当前无分析集合）。worker 每目标每 tick 先闭合最新小时，再在 48 小时窗口内自新向旧补算最多 3 个缺失或不完整小时；超出原始保留期或无任何记录的槽位不发布，读取侧计为缺失/不可重算，绝不补零；每次小时变更按 CAS 重算所属日桶，统计未变则不写。读取接口新增 resolution=1d（90 天、日对齐、含当前未闭合日），返回 missingBuckets/incompleteBuckets/expiredBuckets/retentionDays；详情页提供 24h/7d/30d 小时与 7d/30d/90d 日视图。索引迁移显式把 uniq_nf_metric_hour 替换为 uniq_nf_metric_bucket 并新建 TTL 索引，仅执行 dry-run。
