# Build Tasks: 站点／网络分组工作台

Generated from: [DESIGN_BRIEF.md](DESIGN_BRIEF.md) and [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md)

Date: 2026-11-10。状态：全部待实施。每个编号是可构建、可评审的垂直增量，不表示当前功能已经存在。

## Foundation

- [ ] **SG01 — 可选择站点的最小工作台**：增加 `/inventory/groups` 视图、站点目录、当前范围与资源明细；接通分组 GET 和有界 contains 解析，其他证据分区明确尚不可用。延续紧凑、平静的既有运维视觉。_Reuses: OperationsPageFrame、MetricStrip、StatePanel、CursorPagination；modifies: InventoryViewSwitch、router/navigation；new: GroupDirectory、GroupScopeBar、分组只读应用服务。_ 验证：站点存在／为空／图读取失败，选择节点与复制 URL 得到同一范围；目录不预取所有组的健康数据；1000 成员、5000 边、8 层上限生效。

- [ ] **SG02 — 显式网络分组与共享范围**：增加网络目录、运营商名称／PLMN 过滤，读取受控资源声明并与 Agent networkKey 生成逻辑目录。_Depends on: SG01。Modifies: GroupDirectory、GroupScopeBar、范围解析服务；new: 受控管理属性解析器。_ 验证：两个同名不同键网络不合并，共享站点不复制身份，资源自身声明不继承给后代；同一声明内求交，五／六位 PLMN 保持原样；畸形声明只影响对应条目。

## Core UI and Maintenance

- [ ] **SG03 — 安全的站点生命周期维护**：复用 Inventory API 完成创建、编辑、退役站点；先为本功能复用的 Inventory／Topology 六个 mutation 入口补齐应用服务及 Fresh Actor，保留原 contract 和 repository 公共入口。_Depends on: SG01。Reuses: Field、Dialog、UnsavedChangesGuard、OperationFeedback、既有资源 builders；new: SiteEditor；modifies: 所复用写链与依赖注入。_ 验证：admin/operator 成功，viewer 403，写前账号／角色／会话变化拒绝；CAS 冲突无覆盖；站点退役不级联处理成员、Agent、告警或快照；原始属性不丢失。

- [ ] **SG04 — 逐资源网络声明编辑**：在工作台为站点、主机和 NF 提供网络键、运营商名称、PLMN 的显式编辑与共享声明。_Depends on: SG02、SG03。Reuses: Dialog、Field、资源 CAS 更新；new: ResourceScopeEditor；modifies: Inventory 受控属性分支校验和表单合并。_ 验证：新受控字段的数量／字符边界有效，既有缺省数据不受影响；不修改其他 attributes／labels，不自动改后代或 Agent，不以覆盖重试解决 409；最后一个声明删除后空网络组消失。

- [ ] **SG05 — 包含关系维护与归属检查闭环**：通过原 Topology API 新增／退役站点与主机的 contains 关系，展示多父、共享、环路、失效引用及跨来源差异。_Depends on: SG01、SG03。Reuses: TopologyResourcePicker、Dialog、OperationFeedback；new: ContainmentEditor、AssignmentIssueList；modifies: 问题投影。_ 验证：退役边需要 revision 和原因，禁止自指；非 contains 不参与分组；两个独立动作部分成功时呈现实际关系，重复提交不制造重复边；未解析不能标为未归属。

- [ ] **SG06 — Agent 分组证据**：接入当前范围的远端 Agent、服务器接收时效与明确主机绑定；本地中心采集器单列，管理员进入原 Agent 管理页。_Depends on: SG01、SG02。Reuses: Agent 状态／测量投影、CursorPagination、StatePanel；modifies: GroupEvidenceTabs、分组 Agent 仓储读接口。_ 验证：online/stale/offline/pending/disabled 原规则保持；同主机多 Agent 不任取测量；站点／主机冲突可见，operator 无 Agent 修改入口且后端仍拒绝；无凭据／会话或原始命令行输出，Agent 协议不变。

- [ ] **SG07 — NF 关联与监测覆盖**：资源页签显示逻辑 NF／实例及规范监测关联，概览展示全范围覆盖和分区完整性。_Depends on: SG01、SG02。Reuses: 运维资源 DTO、NF Health 权威解析及详情组件；modifies: 分组 summary、GroupEvidenceTabs。_ 验证：每批最多 50，失败批次为 unresolved，确认无目标才为 unmonitored；组织节点不增加 NF 数；L1 不冒充 L3、生命周期不冒充健康、缺失测量不补 0；分页不改变摘要总数。

- [ ] **SG08 — 范围内告警队列**：在工作台分页展示同范围未关闭告警、严重级别与真实详情入口，摘要对完整范围统计。_Depends on: SG01、SG07。Reuses: 既有告警状态／风险展示、CursorPagination；modifies: 分组告警仓储接口、GroupEvidenceTabs。_ 验证：active/acknowledged/assigned/recovering 口径明确；无 resourceId 的告警不按名称分组，合法空范围不退回全局；状态变更不扩展为站点批量关闭／压制。

- [ ] **SG09 — 范围内配置证据**：按显式 resourceId 接入配置来源、最新尝试／成功、基线与变化状态；显示中心本地文件采集覆盖。_Depends on: SG01。Reuses: 配置来源状态投影、StatePanel、CursorPagination；modifies: 有界来源读投影、GroupEvidenceTabs。_ 验证：未绑定配置不分给站点，metadata-only／无基线／失败不当作无变化；远端 Agent 不伪装已有配置采集；GET 不采集、不暴露路径或私有指纹、不读取原配置正文。

- [ ] **SG10 — 分组报表与 CSV**：扩展原四个报表 GET 及报表页的分组条件，统一范围解析、绝对时间窗和当前归属口径。_Depends on: SG02、SG06–SG09。Reuses: opsreports 页面、窗口校验、CSV 输出与原限制；modifies: 报表 query／仓储 scope、筛选表单。_ 验证：摘要、分页和 CSV 使用相同交集；显示按当前归属筛选历史；Agent 仅当前态；不支持的筛选分区明确不可用；保留 7 天、10000 行、10MiB 及 CSV 安全转义。

## Interactions and States

- [ ] **SG11 — URL、返回路径与刷新竞态**：固定 groupBy、networkKey、siteResourceId、hostResourceId、operatorName、plmn、domain、includeRetired、tab 与各页签独立游标的 URL 约定，补齐可分享链接与错误恢复。_Depends on: SG01–SG10。Reuses: useOperationsUrlState、SWR、return-to、单一刷新注册；modifies: GroupScopeBar、GroupEvidenceTabs 和各详情链接。_ 验证：切换范围重置旧游标，旧响应不覆盖新范围；成员变更使旧游标失效；前进／后退恢复范围；Inventory 合法 returnTo 生效，跨实体不放宽白名单；失败保留旧数据的原时间并提示。

## Responsive and Polish

- [ ] **SG12 — 响应式与可访问性核查**：完成双栏／收窄目录／窄屏目录面板、自适应表列、键盘操作、对话框焦点和中英文文案。_Depends on: SG11。Reuses: 现有语义 tokens、Field、Dialog 焦点控制；modifies: 工作台域样式、locale、目录与明细布局。_ 验证：1920×1080 80%／100%、1366×768、390px 以及 200% 重排；亮／暗主题无全页水平溢出；颜色之外有状态文字，普通文本 4.5:1，对话框焦点正确返回，viewer 不可提交维护表单。

## Review and Acceptance

- [ ] **SG13 — 证据与契约交付**：按 brief 评审完整流程，完成关联语义、源故障、权限、CAS、多步失败和上限的自动化及隔离浏览器验收，更新精确路由集合与当前系统文档。_Depends on: SG01–SG12。Reuses: 既有 Go／前端测试框架、契约／架构门禁；modifies: 必要 contract、测试、architecture／operations 以及同步的 AGENTS／CLAUDE。_ 验证：先运行相关测试，再完成 Go test/race/vet/build、前端 check 与仓库相关门禁；合成网络／站点数据和真实部署证据分开；真实第二 Agent／HTTPS 未具备时列为未执行，源码完成不能代替现场完成；实施结束按规则从 HEAD 移除已完成计划并保留 Git 历史。

## Execution Notes

- 每个任务先交付最小可运行结果；后端与 UI 分开 Conventional Commit，不把整批任务压成一次提交。
- SG03 的写安全是维护功能开放前置条件；SG04、SG05 不可先只接 UI 绕开它。
- SG01 先评审布局和范围，SG02 先验证网络／共享语义；不能用临时假健康数据占位。
- 若范围超过保护值，先正确显示 partial／unavailable，再决定容量扩展；不在 GET 偷建索引或拉全量绕过。
- 本任务清单不授权部署、生产数据填充、服务启停、Git push 或自动修改 Agent 采集行为。
