# 配置漂移告警闭环开发任务

日期：2026-11-12。来源：[设计说明](DESIGN_BRIEF.md)与[开发计划](DEVELOPMENT_PLAN.md)。
方向：Functionalist + 现有 xCloud 运维工作台。除计划文档外均为未实施任务。

- [x] **确认配置路径**：按用户指定统一本次默认根为 /etc/xCloud，使用 26 个样包中的实际文件路径；首版不采用旧源码目录作为默认或自动回退。示例清单使用 MME 的已核查 YAML/Diameter 路径。
- [x] **真实 deb 只读核查**：检查指定目录 26 个包的 control/conffiles/载荷/静态脚本线索，记录实际路径、缺少的依赖包和服务定义边界；原包摘要前后相同。复用自有样包，未执行安装。
- [x] **计划及软件包衔接说明**：完成状态/兼容边界和自有 deb 清单/基线策略设计；只产出文档，不实现安装器。复用现有架构/源码事实。
- [ ] **策略与来源可用状态切片**：新增 configdrift 策略读写、CAS 和来源状态，配置详情展示开关/级别/缺基线/缺关联；确认 viewer 与 Fresh Actor。修改 ConfigSnapshotsPage，复用 configsnapshots/Field/Dialog/OperationFeedback。
- [ ] **单来源漂移事件切片**：基线 A、成功 B 形成一条可查看的配置告警；同 B/C 更新开启事件，详情显示固定基线/证据与确认。新建 configdrift 仓储/列表详情，复用 source lease/Compare/分页/状态组件。
- [ ] **恢复与比较周期切片**：A 真实恢复，再 B 新开；基线更换/清除、关闭策略、来源撤回/资源退役展示独立非恢复原因。修改上述模块，复用现有基线治理和确认框。
- [ ] **持久化与重启一致性切片**：扩展 published 观测/控制 journal 和顺序栅栏，worker 可补偿崩溃/重复/乱序；原生临时 Mongo 验证 CAS、唯一约束、积压保护及跨周期安全。修改 configsnapshots/configdrift，复用测试所有权模式。
- [ ] **统一告警入口切片**：NfAlertsPage 增加配置告警视图、URL 筛选/游标、站点网络范围与详情入口；原 NF 查询/规则不变，读取失败隐藏旧范围。修改告警导航与 API/locale，复用 ResolveGroupScope/工作台组件。
- [ ] **通知闭环切片**：kind+id、明确订阅、版本化配置 payload、开启/真实恢复幂等意图、迟到升级跳过；已有 NF 渠道和 payload 回归。修改 notify/NotificationSettingsDialog，复用 sender/worker/ledger，不新增发送工具或同步网络请求。
- [ ] **人工排障切片**：新增配置锚点 context/create/list 和 UI，旧 alertId/记录保持；从配置告警建记录、保存结论和知识关联，结案不影响漂移。修改 investigation/InvestigationsPage，复用有界证据/草稿/CAS。
- [ ] **异常、权限与交互切片**：覆盖缺文件/失败/pending/metadata-only/不兼容/过期证据、冲突和禁用角色；明暗/中英文/1280/768/375/实际 80%/200%、键盘和焦点。复用共享组件和独立浏览器夹具，不使用真实源测试数据。
- [ ] **设计审查与工程交付**：运行页面截图并审查，完整 Go race/原生 Mongo/前端/契约/文档门禁；后端/界面分离提交、内嵌 SPA 二进制/校验、操作文档/AGENTS/CLAUDE/路由数/parity。归档证据并移除完成计划，不 push。
- [ ] **真实环境验收**：由环境拥有者部署、核对真实声明来源/基线/变更/恢复与通知接收；现场与 fixture 证据分开，未执行时记 NOT_RUN。

后续独立待办：用真实自有 deb 验证 PACKAGE_REGISTRATION.md 的清单/动态配置/多实例/升级保留基线规则，再设计安装执行器和登记接入。当前任务不安装包，不增加 Agent 命令权限。
