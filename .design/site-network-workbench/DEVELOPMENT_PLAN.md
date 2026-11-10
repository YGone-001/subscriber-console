# 站点／网络分组工作台开发计划

日期：2026-11-10。状态：规划完成，业务实现待开始。

本文是未来开发方案，不修改当前架构权威。页面设计见 [DESIGN_BRIEF.md](DESIGN_BRIEF.md)，可执行清单见 [TASKS.md](TASKS.md)。用户已确认首版包含站点维护与主机归属调整。

## 1. 目标与交付边界

首版提供一个可按站点或逻辑网络查看运维证据的工作台，统一资源、采集节点、告警、配置与报表的范围语义。包含站点生命周期维护、逐资源网络声明、包含关系维护；保留既有权限、身份和业务 API。

先交付真实可用的单中心工作台，再用隔离的多网络／多站点样本验证共享与冲突。没有第二个实际 Agent 不阻塞代码与隔离验收；真实多主机部署、HTTPS 和实际归属核查作为独立的现场验收项。

## 2. 已核对的源码基线与缺口

subscriber-console：`develop`，`9069d21dc6ef276ce9870aa0be138f62520dc3d2`；CNMS 参考：`develop`，`ad0d032d7a037adaad3e217504ce7cd209e43dbb`。本计划编制时 subscriber-console 无既有未提交修改；CNMS 的 `build.sh`、`claude.sh` 修改仅观察，未改动。

| 能力 | 当前事实 | 本次需要补充 |
| --- | --- | --- |
| Inventory | 已有 site、host、PLMN、逻辑 NF、NF 实例等规范 UUID；支持有界 attributes 和 revision CAS；没有 operator/network 资源类型 | 站点专用维护体验、显式网络声明的受控解释和编辑 |
| Topology | 节点归 Inventory，边归 Topology；contains 可读写；唯一索引约束的是有向关系元组，不是“一个资源只能有一个父站点” | 有界分组范围解析、共享／冲突／环路提示，关系维护结果反馈 |
| Agent | networkKey、operatorName、siteResourceId、hostResourceId、PLMNs 是管理员维护的元数据；站点／主机分别校验类型和生命周期 | 精确分组投影与交叉校验；现有校验不证明站点与主机在 contains 图中一致 |
| 运维资源投影 | 已有按页解析的资源与监测关联；既有概要使用自身明确的范围 | 工作台使用统一范围服务，不能复用全局概要冒充站点概要 |
| NF Health | 有按 UUID 的权威目标解析；每批最多 50，未解析与无目标不同 | 全范围有界批量解析和明确的 L1/L2/L3 覆盖 |
| NF 告警 | 当前列表按状态／队列／严重级别等筛选，尚无站点／网络条件 | 新工作台的范围内告警查询与完整统计，不能依靠文本搜索模拟 |
| 配置快照 | 当前只读本地声明文件，来源可显式绑定 resourceId；未绑定来源不能归给站点 | 范围内来源投影、当前比较状态和覆盖提示；不增加远程文件采集 |
| 运维报表 | 支持资源、域、严重级别、最多七天时间窗，尚无站点／网络条件；Agent 是当前态 | 报表接口的加法式分组条件及统一范围解析，不能静默删除筛选 |
| 既有写入口 | 所检查的 Inventory／Topology mutation Handler 有会话、RBAC、限流及审计，但直接调用 repository，未见 Fresh Actor 重新鉴权 | 开放新维护入口前，补齐所复用写链的应用服务与 Fresh Actor；保持原 URL／payload／成功响应 |

事实入口：

- [Inventory model](../../backend/internal/inventory/model.go)、[validation](../../backend/internal/inventory/validation.go)、[handler](../../backend/internal/inventory/handler.go)。
- [Topology model](../../backend/internal/topology/model.go)、[repository](../../backend/internal/topology/repository.go)、[handler](../../backend/internal/topology/handler.go)。
- [Agent scope](../../backend/internal/agents/model.go)、[metadata validation](../../backend/internal/agents/validation.go)、[resource checks](../../backend/internal/agents/service.go)。
- [Operations resource projection](../../backend/internal/operationsview/resources.go)、[NF alert filters](../../backend/internal/nfalert/model.go)、[report filters](../../backend/internal/opsreports/model.go)。
- [配置快照权威](../../docs/architecture/configuration-snapshots.md)、[报表权威](../../docs/architecture/operations-reports.md)、[前端 UI 所有权](../../docs/architecture/frontend-ui-ownership.md)。

CNMS 只借鉴分组浏览方式。其 `Site.NFIds` 存的是进程名，不能作为 xCloud 资源关系或采集身份。

## 3. 数据模型决策

### 3.1 唯一身份与声明位置

| 对象 | 首版权威 | 规则 |
| --- | --- | --- |
| 站点／主机／网元 | Inventory resourceId | 不新增节点副本，不按显示名、IP 或进程名连接 |
| 站点包含成员 | 活动 Topology contains 边 | 按方向遍历；声明的组织关系不等于真实运行或网络连通 |
| 逻辑网络分组 | 显式 networkKey 的查询投影 | 无独立网络集合或伪造的 network UUID；同名不同键仍是不同组 |
| 资源的网络声明 | 拟新增 Inventory attributes.xcloudOperationalScopes | 使用既有资源更新接口、CAS 与审计；不修改 Agent 的管理元数据 |
| Agent 归属 | 既有 Agent.scope | 只由 admin 修改；采集报告不能更改；不作为 NF 归属的替代证据 |
| 运营商／PLMN | 各声明中的管理字段 | 不是租户、漫游协议或规范 PLMN 资源关联，不能据此推断业务签约 |

建议新增的资源管理属性如下，仅为拟议字段，不是现有 API 已实现契约：

```json
{
  "attributes": {
    "xcloudOperationalScopes": [
      {
        "networkKey": "lab-network-a",
        "operatorName": "Operator A",
        "plmns": ["00101", "001001"]
      }
    ]
  }
}
```

- site、host、network_function、network_function_instance 可声明，每个资源最多 8 条；同一资源内 networkKey 唯一。
- networkKey 复用 Agent 的 `^[a-z0-9][a-z0-9._-]{0,63}$` 规则；operatorName 去首尾空白、最多 128 Unicode 字符、拒绝控制字符；每条最多 16 个不重复五／六位 PLMN 字符串。
- 同一资源可显式属于多个网络；这是共享声明。operatorName 是名称和精确筛选值，不是稳定运营商 ID；同键出现多个名称时展示差异，不擅自选定一个权威名称。
- PLMN 不转整数，不丢前导零，不把五位和六位自动补齐为同一个值。
- 其他 labels、attributes、source 和已有字段按原契约保留。局部表单必须读取当前完整资源、合并所拥有的属性分支，再使用 expectedRevision 更新；并发失败不得覆盖重试。
- 既有无此属性的资源继续合法。畸形旧声明在读投影中标为 invalid，不导致整页失败；写侧只对新增或改变的受控分支施加新约束，不通过维护表单顺带清洗未知字段。
- 不自动 backfill。网络目录来自资源有效声明与 Agent networkKey 的并集；没有任何声明的网络不单独保存，最后一个声明删除后自然从目录消失。

### 3.2 范围解析与共享语义

1. **站点范围**：验证 site UUID 和 kind，从该站点沿活动 contains 边向外遍历，包含站点本身和非 retired 后代。主机范围同理；除非显式选择退役资源，默认不计 retired 资源。
2. **网络范围**：仅匹配资源自己的显式网络声明。站点或主机的声明不自动继承给后代，Agent 所在网络也不自动授予主机上的全部 NF。
3. **组合筛选**：网络／站点／主机／域／运营商名称／PLMN 求交集。资源的网络、名称、PLMN 必须在同一条声明中匹配，不能跨数组元素拼成假匹配。
4. **Agent 人口**：按其管理 scope 精确匹配，使用独立 Agent 分母。站点筛选下可以显示仅声明 siteResourceId 的 Agent，并标明 host 未绑定；不因此增加 Inventory 主机或 NF 数。
5. **去重与共享**：每个范围内按 resourceId／agentId 去重；一个资源可出现在多个站点或网络，组间计数不可直接求和。多父关系保留全部路径，不任意选第一个父站点。
6. **跨来源冲突**：Agent 声明的 site 与 host 的已解析站点不同、资源与 Agent 的网络声明不同、引用已退役或不存在时，并列显示证据并进入问题面板；不自动改任一来源。
7. **未知与未归属**：完整读取确认无关系才是 unassigned；读取失败、遍历受限或不合法声明是 unresolved／invalid。共享本身不是故障；同一范围内有环路或失效引用时说明具体影响。
8. **关系边界**：仅 contains 参与组织层级。runs_on、connects_to 等不扩大站点分组；绑定了 Agent 的主机不隐式产生 contains、运行映射或网络连接。

站点与主机分别有效，不等于二者已有关联。网络目录中某站点出现，只说明站点自身、其已解析成员或显式 Agent 声明与该网络有关；展开后仍按同一网络筛选，不把整个共享站点的所有 NF 纳入。

### 3.3 维护与并发

- 站点创建／编辑／退役继续写 `xcloud_ops.app_inventory_resources`；组织关系只写 `app_topology_edges`；无跨库写入。
- 新的应用服务承接所复用的 Inventory／Topology mutation，执行 Fresh Actor、原权限门、域校验、CAS／唯一约束和 best-effort 审计。不得把全局 Handler 直写 repository 的现状当作符合新维护需求的充分证据。
- admin/operator 可维护站点、资源声明和包含关系；viewer 403。Agent 的 scope、凭据、启停管理仍仅 admin 可写，operator 的站点编辑不能旁路修改 Agent。
- 新增包含关系使用原 POST；退役边携带原 expectedRevision 和原因。创建边没有“整个关系图版本”，不能承诺独占主站点或并发原子迁站。
- 首版提供明确的“新增关系”和“退役关系”动作；迁站向导只能显示带步骤状态的两个独立动作。第一步成功、第二步失败时显示当前双重或暂缺关系，重新读取后由用户完成，不自动补偿或删除其他边。
- 站点退役不硬删除、不级联退役成员、不改 Agent 配置、不关闭告警、不删除快照；既有引用转为可核查的管理问题。新增绑定拒绝已退役对象，历史仍可查。

## 4. API 与后端实现方向

建议在既有 `operationsview` 领域增加分组只读应用服务及明确的仓储接口，复用 Inventory／Topology／Agent／NF Health 等权威。不在浏览器下载所有页面后求全量，不通过 Go 内部 HTTP 自调用拼装。

拟新增且仅新增三个 GET 注册，均要求 `core.read`：

| 路由 | 用途 |
| --- | --- |
| GET /api/operations/groups | 站点／网络目录和有界的展开结果；groupBy=site\|network，搜索及游标分页 |
| GET /api/operations/groups/summary | 当前范围的指标与各来源覆盖；不受明细游标影响 |
| GET /api/operations/groups/members | 当前范围的分页明细；section=resources\|agents\|alerts\|config\|issues |

公共选择器拟定为 `networkKey`、`siteResourceId`、`hostResourceId`、`operatorName`、`plmn`、`domain`，另以 `includeRetired=0|1` 控制历史资源可见性，默认 0。domain 作用于 Inventory 资源；无法归属具体资源域的 Agent 分区返回 unsupported_filter，不以 Agent 的进程列表推断域。资源 kind、告警 severity 和搜索只对对应明细分区生效，不悄悄改变无关指标。响应回显每个分区实际使用的范围。

约束：

- 重复参数、未知参数、畸形 UUID／网络键／PLMN／游标返回 400；站点或主机 UUID 对应错误 kind 返回 400，不存在返回 404。
- 合法且无匹配的交集返回完整的空结果；范围解析失败不退回全局，也不返回“完整且零资源”。
- 每个分区返回 `completeness=complete|partial|unavailable`、reason、范围、读取时间；`not_configured` 等业务证据状态另列，不能混同数据读取失败。
- 响应只采用 xCloud 原生 envelope 和受控 DTO。列表为空保持数组；无法完整确定的统计为 null，可另列 observedCount，不把下限伪装成总数。
- 明细与摘要共享同一个范围解析模块。游标绑定选择器、排序和成员集合指纹；范围变更或成员集合变化时拒绝继续旧游标并引导重置，不拼接不同范围的数据。
- `includeRetired=1` 显示退役记录及其证据，数量按在用／退役分别列出；退役资源不进入当前 NF 健康覆盖分母。默认模式下不沿退役资源继续继承成员，相关有效后代保留为待核查的组织关系问题。
- 站点／网络筛选是管理查询，不是授权隔离。所有角色仍遵守当前全系统角色模型，不宣称跨运营商权限隔离。

## 5. 证据投影与时间口径

| 分区 | 展示与完整性规则 |
| --- | --- |
| 资源 | 主机、逻辑 NF、NF 实例分别计数；其他资源另列，不把组织节点抬高 NF 分母 |
| Agent | 重用服务器接收时间和原 online/stale/offline/pending/disabled；本地中心采集器单列，不假装是远端 Agent；凭据、会话和原始命令行不进入 DTO |
| NF Health | 规范 UUID 每批最多 50，确认无目标才是 unmonitored；失败是 unresolved；生命周期、进程存在、HTTP 成功均不能代替 L3 健康 |
| 主机测量 | 仅在明确 Agent↔host 绑定且测量存在时显示；多个 Agent 对同一主机不任意选值，提示多来源；CPU 缺失不补 0，根文件系统容量不改称整机磁盘容量 |
| 告警 | 同范围完整聚合当前 open 队列；无 resourceId 的告警不能按名称分派进站点；最新一页不作为告警总数 |
| 配置 | 按显式 source.resourceId 求交；最近尝试、成功快照、可比较基线分开；失败、无基线、不兼容、metadata-only 与无变化不可混同；GET 不触发采集 |

为 inventory、topology、agents、monitoring、alerts、config 分别记录完整性。不同读取最终一致，统一 generatedAt 只是汇总生成时刻，不宣称跨集合事务快照。刷新失败可保留带旧时间的上一次证据，但不得继续标为“已刷新”。

配置分区只显示当前中心已声明并绑定的本地来源；远端 Agent 的配置和日志仍不可用。EPC/5GC、IMS 路径继续由部署清单按实际环境声明，工作台不自动扫描目录或导入文件。

## 6. 报表与明细衔接

- 在既有四个 `/api/ops-reports/*` GET 接口及 `/ops-reports` UI 加法式支持分组选择器，资源／域／严重级别与时间窗的原行为保持兼容；不另造报表集合。
- 工作台域过滤使用 Inventory 的十个规范域；报表域参数从既有四个业务域加法式扩展为同一规范枚举，原四个值的行为不变，不能把新域静默去掉再查询全局。
- 显式 resourceId 与分组条件组合时求交；不属于该范围则为空，绝不忽略分组。各选择器的参数校验和范围上限复用工作台模块。
- 沿用 `[from,to)`、最多七天窗口和既有导出限制。跨页及导出固定绝对窗口；相对 period 只在首次生成时解析一次。
- 历史告警、测量和配置观测按当前资源归属筛选，明确显示“按当前归属筛选历史证据”；本期没有历史归属时间轴，不能称为事件发生时所属站点。
- 当前 Agent 状态与窗口内事件分别呈现；Agent 没有历史可用率。不能满足某个筛选的分区标为 unsupported_filter，不回退为全局 Agent 统计。
- 工作台的告警／配置明细由自己的 members 端点提供范围内分页。现有告警中心等页面若尚未接受组条件，只链接真实单条详情；“查看全部”留在工作台对应页签。
- Logs 仅按已有单资源来源进入；不提供跨站点、跨主机汇总日志或远端日志读取。

## 7. 查询边界与容量

以下是首版拟定的保护值，须在实现时成为服务端常量和验收用例，不是已经测出的生产容量：

| 项目 | 建议边界与越界行为 |
| --- | --- |
| 目录／成员分页 | 默认 50，最多 200；搜索最多 128 字符，转义正则元字符 |
| 一个范围的 Inventory 成员 | 最多 1000；超过返回 partial 与 scope_limit，摘要总数为 null |
| 包含图遍历 | 最多 5000 条边、8 层；有向访问去重与环路检测；超限不把未遍历资源判成未归属 |
| NF 目标解析 | 每批最多 50 个规范 UUID；有界批次数及并发，不逐资源 N+1 |
| 单次读取 | 总预算建议 5 秒，继承请求取消；所有仓储读取及聚合受预算约束 |
| 工作台读取限流 | 建议每用户每端点 120 次／60 秒；取消后台标签页轮询及重复刷新 |
| 报表导出 | 保留原 10000 行／10MiB 上限及截断说明，不自动扩大 |

目录先查询分组键／站点，不为全部站点计算 NF 健康。只对所选范围补充证据，分区懒加载；SWR key 含完整选择器和页签参数。

核对实际 explain 与合成数据后再决定索引。候选方向为资源网络键、Agent scope 与 Topology 两端的组合读取；使用 `scripts/init-mongo-indexes.mjs` 的既有定义权威统一维护。不能在 GET 中建索引，不为计划编制连接生产库实施索引；缺失时记录 PERFORMANCE_FINDING。对 attributes 数组避免未经验证的复合多键索引设计。

## 8. 验收矩阵与完成定义

| 类别 | 必须验证的结果 |
| --- | --- |
| 真实空数据 | 无站点、只有站点、没有 Agent／目标／基线，分别显示可解释空态，不伪造健康或 0 测量 |
| 管理模型 | 两个网络、三个站点、共享站点／主机、多 PLMN；UUID 去重，组间计数不假装可加 |
| 明确归属 | 站点标签不自动分配后代，Agent 网络不隐式分配 NF；未声明资源可定位和维护 |
| 关联问题 | Agent 站点／主机冲突、失效引用、多父、环路、无资源告警、无绑定配置来源可追溯 |
| 数据语义 | 五／六位 PLMN 保持区别；未知／未纳管／失效测量分开；进程与 L3 健康分开 |
| 范围一致 | 指标、明细、报表、CSV 使用同一筛选交集；空交集不退回全局 |
| 源故障 | 任一仓储失败、超时、遍历上限、目标批次失败时，受影响分区不输出完整总数 |
| 变更安全 | viewer 写 403；operator 不可写 Agent；写前账号禁用／角色／sessionVersion 变化被 Fresh Actor 拒绝；CAS 冲突无覆盖 |
| 多步关系 | 新增／退役仅部分成功时展示数据库实际关系；重试不制造重复边，不自动宣称迁站完成 |
| URL 与竞态 | 切换范围中断旧读、旧游标失效、刷新失败保留旧时间、浏览器前进后退恢复筛选 |
| 资源隔离 | 原资源 labels／attributes／未知字段保留；无 xcloud 业务写、无 Agent 协议变化、无远程采集扩展 |
| 界面 | 中英文、暗／亮主题、规定分辨率与缩放、键盘对话框和目录、截断标识均有人可核查的证据 |

实现时运行相关 Go／React 测试、前端 lint/typecheck/build、Go test/race/vet/build 以及仓库的 API、架构、文档与运行时边界门禁。新增路由以精确注册集合更新 contract、测试与计数；不能只改文档数字。预计增量是三个 Go GET 注册、一个 SPA 路由，实际集合由实现门禁确认。

隔离 Linux Mongo／HTTP 验收使用测试自有数据库、进程和端口，不操作生产服务。浏览器验证同时保存完整、空、部分失败、冲突和窄屏状态；合成多主机数据只证明隔离场景，不替代真实多主机联调。

交付分别报告：源码与自动化通过、隔离 UI 验收、真实单主机核查、真实多主机核查。第二台 Agent／HTTPS 尚未准备时，最后一项保持未执行，不能据此虚报现场完成。

## 9. 开发顺序、工作量与交付

| 顺序 | 可评审的结果 | 对应任务 |
| --- | --- | --- |
| 1 | 站点最小工作台，先确认范围、左目录和主内容布局 | SG01 |
| 2 | 网络投影、显式成员规则；站点维护的安全写链和表单 | SG02–SG04 |
| 3 | 包含关系维护及归属问题闭环 | SG05 |
| 4 | Agent、NF Health、告警、配置按相同范围接入 | SG06–SG09 |
| 5 | 报表／导出与导航上下文贯通 | SG10–SG11 |
| 6 | 响应式、权限／故障／容量验收和当前权威文档交接 | SG12–SG13 |

初步估计约 9–14 个专注开发人日，含联动验证，不含等待实际节点、证书和用户现场验收。范围解析、写链补齐和历史报表口径是优先验证的风险；若实测超出查询边界，先明确 partial 或缩小范围，再另行决定容量扩展。

实施中每个垂直任务至少形成可运行、可检查的增量；后端与 UI 分开提交。先完成只读闭环，再启用维护，最后贯通跨模块报表。实现完成后把当前事实移入 architecture／operations 文档并同步必要的 AGENTS／CLAUDE；依仓库规则从 HEAD 移除已完成计划，保留 Git 历史。

本次交付只有本计划及配套设计／任务文档；不触发业务写入、生产索引、服务重启、部署或 Git push。
