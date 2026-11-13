# 配置漂移告警闭环开发计划

日期：2026-11-12。状态：待实施。基线：develop / c8bd2d6955b17007df07a6c0b5cc587cc35c7434。
此计划不表示接口/集合已存在；本轮不改运行源码、真实配置、服务、安装权限或 Agent 协议。

## 目标与实例

合法来源 S 和资源 R，人工基线为 A。策略启用后采集 B，创建漂移告警；重复 B/C 更新同一开启事件；采集回 A 记录恢复。支持确认、版本差异、投递结果和人工排障。确认只表示已知悉；结案不清除漂移；重新设基线是接受参照，不是文件恢复。

## 现有依据

- [配置观测架构](../../docs/architecture/configuration-snapshots.md)：部署声明来源，最多 128 来源/16 个互不重叠根，私有 HMAC、基线 CAS、source lease 和持久化发布 journal。
- [Compare](../../backend/internal/configsnapshots/diff.go)：no_baseline/incompatible/unchanged/visible_changed/unprojected_changed。
- [NF 告警模型](../../backend/internal/nfalert/model.go)：仅 NF Health state/run_failed；不能拿配置 sourceId 代替健康 targetId。
- [投递模型](../../backend/internal/notify/model.go)及 [worker](../../backend/internal/notify/worker.go)：已有渠道、升级、幂等 ledger、后台发送；目前绑定 NF alertId。
- [排障架构](../../docs/architecture/alert-investigations.md)：当前锚点为 NF alert；必须加法扩展，不把配置 ID 填成旧 alertId。

## 默认与范围

1. 用户于 2026-11-12 确认首版按这批 deb 的 /etc/xCloud 布局实现，默认配置根为 /etc/xCloud。EPC/5GC 按包内 gnc/gdm/gdg/gpc/gsp 分组，CSCF/SMSC 按 gcc 分组，IPSMGW 按实际包的 gnc/ipsmgw 路径。继续使用 CONFIG_SNAPSHOT_MANIFEST 中的中心本机声明及文件读取/投影/HMAC/generation 边界；只采集清单中明确登记的文件，不递归扫描根目录，路径不可由浏览器任意提交。
2. 每 sourceId 一个 enabled/severity 策略，默认关闭，默认级别 warning；人工基线继续复用现有接口。无基线显示待设置，缺资源绑定显示待关联。
3. 开启后首个新的成功兼容观测开始评估，不补造过去的告警或通知。无定时来源仍可显式采集；需要持续观测时配置现有固定采集间隔。
4. 同一 source/generation/基线周期最多一条开启事件；重复观测不重发开启通知，真实恢复后再漂移新开事件。
5. 不做字段级规则、自由表达式、配置写回、自动选最新版本作基线；deb 安装台后续单独实施。

## 状态机

| 输入 | 评估状态 | 告警处理 |
|---|---|---|
| 无基线 | not_armed | 不新开；清除基线以 baseline_removed 结束旧周期 |
| 成功且等于基线 | in_sync | 当前周期按 returned_to_baseline 恢复 |
| 成功且不同于基线 | drifted | 新开或更新当前开启事件 |
| 未投影内容不同 | drifted，字段内容不可展示 | 不推断秘密字段，不返回原文 |
| 缺文件/读取失败/读取中变化/pending | evaluation_unavailable | 保留最近已验证事实，不自动恢复 |
| generation/profile/key 不兼容 | comparison_unavailable | 停止比较，不伪报漂移或恢复 |
| 替换基线 | 新比较周期 | 旧周期 baseline_superseded；新周期等新观测 |
| 策略关闭/来源撤回/资源退役 | 显式停止原因 | 行政结束，不能标真实恢复 |

告警生命周期为 active/acknowledged/resolved，结束原因单独保存。采集结果、评估状态、证据新鲜度、告警生命周期分别投影；旧 active 不能伪装成当前新鲜测量。策略级别变更作用新事件，已有事件保留创建时级别与 policyRevision。

## 持久化与崩溃恢复

Observation.changed 仍表示相邻观测变化，不能当作基线漂移。新增独立相对基线输入字段：baselineId、baselineRevision/epoch、referenceComparison、evaluationSequence、输入版本，在 source lease 内计算并绑定 generation/profile/keyVersion/resourceId。

复用并扩展 configsnapshots 的持久化发布 journal：只有完全发布的观测可评估；基线/策略控制事件与所属状态变化在同一单文档原子写中留下可重放输入。每来源单调顺序与周期栅栏；旧周期事件不能恢复新周期。内存回调仅加速，不能承担可靠性。

实现前固定 journal 边界，并用写后崩溃、发布后回调失败、并发采集/基线、重启、乱序/重复输入证明无漏报、无错恢复。跨集合采用最终一致和幂等补偿，不假设事务快照；GET 不写库/修复/采集/建索引。

拟新增 backend/internal/configdrift，继续复用单一 Mongo Client/Ops handle：

- app_config_drift_sources：策略、revision、输入处理进度和积压/worker 状态。
- app_config_drift_alerts：固定来源/资源/generation/基线周期、触发/最近证据、生命周期、结束原因与 CAS revision。
- app_config_drift_events：不可变状态事实和受保护的待消费/投递意图引用，不复制配置内容。

唯一约束/CAS 保护单一开启事件；sourceId+sequence/eventId 幂等。告警转移与投递意图需有持久化 journal/outbox，不能在多文档之间留下无补偿崩溃窗口。

列表默认 50、最多 200；请求体上限 16KiB；单查询 2 秒、组合详情 8 秒；worker 每轮最多 32 输入/并发 2 来源。积压与处理时间可见，失败不变成空列表。保留先对齐配置观测 90 天，开启事件、未消费输入及未完投递不被普通清理删除；缺失旧版本明确标证据不可用，容量限制不能静默丢弃输入。索引由显式 dry-run/apply CLI 管理。

## 拟新增 API 与权限

规划新增 7 条 Go 路由，实施时核对实际注册集合，不预先改当前 198 条事实。

| Method | Path | 权限 |
|---|---|---|
| GET | /api/config-drift/meta | core.read |
| GET | /api/config-drift/sources/{sourceId}/policy | core.read |
| PUT | /api/config-drift/sources/{sourceId}/policy | core.configure/Fresh Actor/CAS |
| GET | /api/config-drift/alerts | core.read |
| GET | /api/config-drift/alerts/{driftAlertId} | core.read |
| POST | /api/config-drift/alerts/{driftAlertId}/acknowledge | core.configure/Fresh Actor/CAS |
| GET | /api/config-drift/alerts/{driftAlertId}/events | core.read |

读 120/min、写 30/min；严格有界输入、no-store、安全投影及 best-effort 审计；不记录配置内容或指纹。仅 Ops 写，不改变 subscriber/OCS/NF 配置/Inventory/Topology。复用 cookie、三角色、Fresh Actor、CAS，无审批工单。

## 统一告警、通知与排障

原 /api/nf-alerts、规则和健康目标契约保留。现有告警页面增加配置告警视图，按视图调用正确域 API；摘要独立报告来源完整性。共享 ResolveGroupScope，未解析站点/网络范围不扩大查询。

通知渠道/sender/worker 复用，新增 subjectKind/subjectId/resourceId/sourceId 和版本化配置载荷。缺失 kind 的旧记录按 nf_alert；旧 alertId/targetId 只代表 NF，不造健康目标。旧订阅默认仍只处理 NF，配置类别须显式启用；ruleIds 保留 NF 含义，配置来源另用 sourceIds 过滤。

开启/真实恢复按事件与渠道唯一键投递；行政结束不冒充恢复。仅后台 worker 网络发送；kind+id 查询真实生命周期，读失败/未知不能当 resolved；恢复后迟到升级跳过。递送至少一次，支持接收端幂等，不宣称网络端恰好一次。

排障 context/create/list 加法支持 anchorKind=nf_alert|config_drift 和 anchorId；旧 alertId 参数/记录保留，混用冲突拒绝。旧列表请求默认保持 NF 范围，新 UI 显式选配置/全部；配置 ID 不写入旧 AlertID。配置锚点绑定事件的资源及周期，提供基线/触发/最近观测与安全 diff 链接，沿用有界窗口、覆盖、草稿和 CAS。结案不改漂移。

## 前端交付

- 配置来源详情：策略、基线/周期、评估/新鲜度、告警和通知链接；基线替换说明影响。
- 告警页新增配置视图和可筛选列表/详情，来源/资源/站点网络范围、URL 游标、确认和结束原因。
- 详情查看安全证据、事件、投递并进入人工排障；保留安全 returnTo。
- 复用共享字段/确认/反馈/分页/加载错误状态、SWR 与 locale；切换范围取消旧读，失败隐藏旧证据，冲突保留草稿。

## 开发顺序与估计

估计为工程工作量，不是上线承诺；真实安装平台不在估计内。

| 切片 | 可验收结果 | 估计 |
|---|---|---|
| 契约与故障路径验证 | 状态表、journal/顺序、兼容方案和故障测试固定 | 0.5-1 天 |
| 漂移最小闭环 | 策略、评估、列表/详情、确认、恢复及 Mongo 并发/重启证据 | 1.5-2.5 天 |
| 既有工作台集成 | 配置和告警入口、范围、基线影响、错误状态可演示 | 1-1.5 天 |
| 通知与排障集成 | subject 兼容、迟到升级和新锚点记录可演示 | 1.5-2 天 |
| 完整验收交付 | 全量检查、主题/缩放、内嵌 SPA 构建、文档和分离提交 | 1-1.5 天 |

合计约 5.5-8.5 个工程工作日，发布恢复/兼容问题可能调整估计。

## 必须通过的验收

- 基线 A、B/C 漂移、重复不重开、A 恢复、再 B 新开；确认/结案不改变实测结果。
- 相邻版本未变化仍识别基线漂移；缺文件/失败/pending/不兼容不假恢复；metadata-only 不泄露内容。
- 更换/清除基线、关闭策略、移除来源/退役资源有非恢复原因。
- CAS、并发、写后崩溃、回调失败、重启/乱序/重复输入不漏有效事件或重复开启/投递意图。
- 原 NF 告警、通知 payload 和排障旧契约回归；viewer 403，Fresh Actor 拒绝，审计无敏感内容。
- 范围/分页/部分/失效引用，1280/768/375 明暗、键盘与实际 80%/200% 缩放、错误/草稿。
- Go race/原生 Mongo、前端 lint/typecheck/测试/构建、契约/安全/文档门禁；隔离与真实环境证据分别记录。

## 交付约定

后端与界面分离提交、明确白名单、不 push。实施完成才更新当前架构/操作说明、AGENTS/CLAUDE、API 注册计数和 parity。完成计划及验收记录退出 HEAD，保留 Git 历史/artifacts。现有服务与特权部署由环境拥有者执行。

相关：[设计说明](DESIGN_BRIEF.md)、[任务](TASKS.md)、[deb 自动登记](PACKAGE_REGISTRATION.md)。

## 首批 deb 样本补充

已检查 [26 个实际包](EXISTING_DEB_PACKAGES.md)。本期保持只做漂移闭环与登记契约；后续安装平台首批兼容这些已有包，通过受控适配器生成候选，不强制要求全部重打包。用户已确认本次按包内 /etc/xCloud 布局确定默认路径和样例；本轮计划修订不迁移文件或改写现有运行来源。正式安装前补基础依赖、实际启动参数与服务定义核验，不从安装提示文字推断调用链。
