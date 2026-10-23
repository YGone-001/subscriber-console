# 拓扑接口词表与契约变更草案

> 状态：DRAFT（评审用，不是当前运行时契约，也未写入代码）。
> 范围：核心网网元之间的接口，EPC / 5GC / IMS / Charging，同时收录参考点与 SBI 服务接口。
> 原则：接口名只能来自服务端受控词表，不允许自由输入，不从两端网元推断。

## 1. 已确认的决策

1. `/topology` 是核心网网元（NF）之间的拓扑，不是通用资源图。
2. 默认只展示 `network_function` / `network_function_instance`。`network_element` 与 host / site / IP 等支撑资源默认隐藏，并显式显示隐藏数量；role 不参与 NF 可见性判断。当前真实 Inventory 的 21 条资源全部是 `network_function`，没有 `network_element`。
3. 同一能力可以有多个网元身份（负载均衡场景）：节点身份始终是 `resourceId`，不按名称合并；`role` 只用于分列/可选聚合。
4. 关系边新增可选的 `interfaceNames: string[]`。数组是为了在保持现有活动边唯一索引 `(fromResourceId, toResourceId, relationshipType)` 不变的前提下，为未来同一对网元的多接口留出空间。
5. 接口名由服务端受控词表校验；旧边可以没有接口名，界面必须把“未标注接口”显性化，绝不推断。
6. 视图同时支持：全部叠加、单域、跨域互通。

## 2. 服务端接口目录条目结构

建议 `/api/topology/meta` 新增：

```json
{
  "interfaceCatalog": [
    {
      "name": "N11",
      "category": "reference_point",
      "domains": ["5gc"],
      "plane": "control",
      "scope": "nf_nf",
      "endpoints": [["amf", "smf"]],
      "spec": "3GPP TS 23.501 4.2",
      "description": "AMF 与 SMF 之间的参考点"
    }
  ],
  "interfaceCategories": ["reference_point", "sbi"],
  "interfaceScopes": ["nf_nf", "external"],
  "interfacePlanes": ["control", "user", "both"]
}
```

字段说明：

| 字段 | 说明 |
|---|---|
| `name` | 规范名称，大小写敏感，去首尾空白后精确匹配 |
| `category` | `reference_point` 或 `sbi` |
| `domains` | 适用域：`5gc` / `epc` / `ims` / `charging`，可多个 |
| `plane` | `control` / `user` / `both` |
| `scope` | `nf_nf`（网元到网元）或 `external`（接入网/数据网/UE/AAA 等非网元端点） |
| `endpoints` | 建议的规范角色对；用于表单建议，不作为 v1 的强制校验 |
| `producerRole` | 仅 SBI：服务生产者角色；消费者可以是任何被授权 NF |
| `spec` | 3GPP 规范来源，新增条目必须填写 |
| `description` | 中文说明 |

SBI 的 `endpoints` 不表示固定点对点关系：`Nsmf` 的生产者是 SMF，消费者可以是 AMF、SMF、PCF 等被授权 NF，因此 SBI 条目不参与端点配对校验。

### 2.1 Role token 与显示标签

API 中的 `endpoints` 和 `producerRole` 使用 Inventory 的真实存储 token，例如 `sgwc`、`sgwu`、`pgwc`、`pgwu`、`pcscf`、`icscf`、`scscf`。界面显示使用 3GPP 规范写法：`SGW-C`、`SGW-U`、`PGW-C`、`PGW-U`、`P-CSCF`、`I-CSCF`、`S-CSCF`；`AMF`、`SMF`、`UPF`、`PCF` 等 5GC 网元以及 `SMSC` 保持不带连字符。下表为便于阅读使用显示标签，实际词表数据使用存储 token。

## 3. V1 受控词表（仅录当前已纳管网元之间的接口）

### 3.1 5GC 参考点（NF ↔ NF）

| Name | Category | Domains | Plane | Endpoints | Spec | Notes |
|---|---|---|---|---|---|---|
| N4 | reference_point | 5gc | control | SMF ↔ UPF | TS 23.501 4.2 | PFCP |
| N7 | reference_point | 5gc | control | SMF ↔ PCF | TS 23.501 4.2 | |
| N8 | reference_point | 5gc | control | AMF ↔ UDM | TS 23.501 4.2 | |
| N9 | reference_point | 5gc | user | UPF ↔ UPF | TS 23.501 4.2 | 5G LAN / ULCL 等场景 |
| N10 | reference_point | 5gc | control | SMF ↔ UDM | TS 23.501 4.2 | |
| N11 | reference_point | 5gc | control | AMF ↔ SMF | TS 23.501 4.2 | |
| N12 | reference_point | 5gc | control | AMF ↔ AUSF | TS 23.501 4.2 | |
| N13 | reference_point | 5gc | control | UDM ↔ AUSF | TS 23.501 4.2 | |
| N14 | reference_point | 5gc | control | AMF ↔ AMF | TS 23.501 4.2 | |
| N15 | reference_point | 5gc | control | PCF ↔ AMF | TS 23.501 4.2 | 现有参考架构误标为 N8 |
| N16 | reference_point | 5gc | control | SMF ↔ SMF | TS 23.501 4.2 | |
| N19 | reference_point | 5gc | user | UPF ↔ UPF | TS 23.501 4.2 | 5G LAN PSA |
| N22 | reference_point | 5gc | control | AMF ↔ NSSF | TS 23.501 4.2 | 现有参考架构用 Nnssf（SBI）表示该关系，建议分开标注 |
| N24 | reference_point | 5gc | control | PCF ↔ PCF | TS 23.501 4.2 | 漫游 vPCF ↔ hPCF |
| N26 | reference_point | 5gc + epc | control | AMF ↔ MME | TS 23.501 4.2 | 5GC / EPC 互通 |
| N27 | reference_point | 5gc | control | NRF ↔ NRF | TS 23.501 4.2 | 漫游 vNRF ↔ hNRF |
| N31 | reference_point | 5gc | control | NSSF ↔ NSSF | TS 23.501 4.2 | 漫游 vNSSF ↔ hNSSF |
| N35 | reference_point | 5gc | control | UDM ↔ UDR | TS 23.501 4.2 | 现有参考架构用 Nudr（SBI）表示该关系 |
| N36 | reference_point | 5gc | control | PCF ↔ UDR | TS 23.501 4.2 | 现有参考架构误标为 N5 |
| N43 | reference_point | 5gc | control | PCF ↔ PCF | TS 23.503 | 同 PLMN PCF 间策略交互 |

### 3.2 5GC SBI 服务接口

| Name | Category | Domains | Plane | Producer | Spec | Notes |
|---|---|---|---|---|---|---|
| Nnrf | sbi | 5gc | control | NRF | TS 23.501 / TS 29.500 | 所有 NF 向 NRF 注册/发现 |
| Namf | sbi | 5gc | control | AMF | TS 23.501 / TS 29.500 | |
| Nsmf | sbi | 5gc | control | SMF | TS 23.501 / TS 29.500 | |
| Nudm | sbi | 5gc | control | UDM | TS 23.501 / TS 29.500 | |
| Nausf | sbi | 5gc | control | AUSF | TS 23.501 / TS 29.500 | |
| Npcf | sbi | 5gc | control | PCF | TS 23.501 / TS 29.500 | |
| Nnssf | sbi | 5gc | control | NSSF | TS 23.501 / TS 29.500 | |
| Nbsf | sbi | 5gc | control | BSF | TS 23.501 / TS 29.500 | |
| Nudr | sbi | 5gc | control | UDR | TS 23.501 / TS 29.500 | |

注意：

- SCP 是 SBI 代理，不是 SBI 生产者，词表不新增 `Nscp`。经过 SCP 的调用仍标注目标 NF 的 SBI 名称。
- DRA 是 Diameter 代理，不新增接口名。S6a / Gx / Gy 等经过 DRA 的段仍使用原接口名，并在关系说明中体现代理路径。
- 词表不通过两端角色反推 SBI；例如 AMF 访问 SMF 的服务应标 `Nsmf`，访问 UDM 的服务应标 `Nudm`。

### 3.3 EPC 参考点（NF ↔ NF）

| Name | Category | Domains | Plane | Endpoints | Spec | Notes |
|---|---|---|---|---|---|---|
| S5 | reference_point | epc | both | SGW-C ↔ PGW-C；SGW-U ↔ PGW-U | TS 23.401 4.2 | Intra-PLMN，同一运营商/归属地内部 |
| S8 | reference_point | epc | both | SGW-C ↔ PGW-C；SGW-U ↔ PGW-U | TS 23.401 4.2 | Inter-PLMN 漫游变体，与 S5 同族但独立受控名称 |
| S6a | reference_point | epc | control | MME ↔ HSS | TS 23.401 4.2 | |
| S10 | reference_point | epc | control | MME ↔ MME | TS 23.401 4.2 | |
| S11 | reference_point | epc | control | MME ↔ SGW-C | TS 23.401 4.2 | |
| Sxa | reference_point | epc | control | SGW-C ↔ SGW-U | TS 23.401 CUPS | |
| Sxb | reference_point | epc | control | PGW-C ↔ PGW-U | TS 23.401 CUPS | |
| Gx | reference_point | epc + charging | control | PCRF ↔ PGW-C | TS 23.203 | PCC 策略与计费规则 |
| Gy | reference_point | epc + charging | control | PGW-C ↔ OCS | TS 32.240 / TS 32.299 | 在线计费 |
| Sy | reference_point | epc + charging | control | PCRF ↔ OCS | TS 32.240 | 策略与在线计费联动 |
| Gxc | reference_point | epc | control | PCRF ↔ SGW-C | TS 23.203 | PMIP / BBERF 场景 |
| S9 | reference_point | epc | control | PCRF ↔ PCRF | TS 23.203 | 漫游 hPCRF ↔ vPCRF |

### 3.4 IMS 参考点（当前已纳管 IMS 角色：P-CSCF / I-CSCF / S-CSCF）

| Name | Category | Domains | Plane | Endpoints | Spec | Notes |
|---|---|---|---|---|---|---|
| Mw | reference_point | ims | control | P-CSCF ↔ I-CSCF；I-CSCF ↔ S-CSCF；P-CSCF ↔ S-CSCF | TS 23.228 / TS 24.229 | SIP |
| Cx | reference_point | ims | control | I-CSCF ↔ HSS；S-CSCF ↔ HSS | TS 29.228 / TS 29.229 | Diameter |
| Rx | reference_point | ims + epc | control | P-CSCF ↔ PCRF | TS 29.214 | Diameter，策略 |
| Gq | reference_point | ims | control | P-CSCF ↔ PCRF（PDF） | TS 23.228（legacy） | 旧网元可能使用 PDF |
| Ro | reference_point | ims + charging | control | IMS 计费触发点 ↔ OCS | TS 32.240 / TS 32.299 | 端点角色随部署不同，v1 不做端点强制校验 |

### 3.5 外部接口（v1 不进入 catalog / 表单）

这些接口的至少一端不是核心网网元。v1 保持 46 条 `nf_nf`，以下 external 名称只作为未来候选，不进入 `interfaceCatalog` 或默认 NF 边表单：

```text
N1, N2, N3, N5, N6, S1-MME, S1-U, S12, SGi, S6b, S2a, S2b, S2c, Gm, Ut
```

### 3.6 暂不进入 v1 的候选（未来按需评审）

```text
5GC: N17, N23, N28, N29, N30, N32, N33, N34, N37, N38, N40, N41, N42,
     N51, N52, N55, N56, N57, N58, N59, N60, N80, N81 ...
EPC: S3, S4, S6d, S13, SGs, Sv, Gn/Gp, Gr
IMS: Dx, Sh, ISC, Ma, Si, Dh, Mg, Mi, Mj, Mk, Mm, Mr, Mp, Mx, Rf
SBI: Nchf, Nnef, Nsmsf, Nnwdaf, N5g-eir, Nudsf, Nlmf ...
```

进入词表的前置条件：有明确 3GPP 规范来源，明确 category / domains / plane / scope，并通过评审。不允许“先自定义、后补规范”。

CHF 当前未出现：`N28 / N40 / N41 / N42 / Nchf` 为 reserved，不映射到 OCS；等 Inventory 出现 `chf` 角色后再按规范增量加入。

### 3.7 跨域共享节点与代理节点

单域视图如果只按 Inventory `domain` 过滤，会误伤两类节点：

- 共享网元：HSS、PCRF、OCS 等。Inventory 只能有一个 domain，但它们在真实网络中参与多个域（例如 HSS 同时服务 EPC 和 IMS，PCRF/OCS 同时参与 EPC/IMS/Charging）。
- 代理网元：SCP（SBI 代理）、DRA（Diameter 代理）。它们是真实节点，但不是接口的逻辑端点。

建议语义：

1. 共享网元在单域视图中作为“边界节点”保留：当且仅当它与所选域存在已声明关系时出现；只显示与所选域相关的边；视觉上标记“共享 / 跨域”，单独计数，不计入该域的 NF 数量。
2. 边界节点默认显示，可切换隐藏；隐藏时显示“跨域边界节点 N / 关系 M”，避免被误读为不存在。
3. 代理网元作为“代理节点”显示，使用低对比度样式；其边上的 `interfaceNames` 表示被代理的逻辑接口段，详情中必须注明 `via DRA` / `via SCP`，不能伪装成逻辑端点之间的直连。
4. 不通过跨两条边拼接出“逻辑直连”，不推断未声明的关系。
5. 共享网元的健康状态正常叠加，但在域汇总中单独计数。

## 4. 现有参考架构需要纠正的标签（确认与本批同批修正）

`frontend/src/features/topology/reference-architecture.ts` 中：

| 连接 | 当前标签 | 应改为 | 依据 |
|---|---|---|---|
| AMF → PCF | N8 | N15 | N8 是 AMF ↔ UDM；AMF ↔ PCF 是 N15 |
| PCF → UDR | N5 | N36 | N5 是 PCF ↔ AF；PCF ↔ UDR 是 N36 |
| AMF → NSSF | Nnssf | N22（参考点）或双标 N22 / Nnssf | N22 是参考点，Nnssf 是 SBI |
| UDM → UDR | Nudr | N35（参考点）或双标 N35 / Nudr | N35 是参考点，Nudr 是 SBI |

现有参考图混合了参考点和 SBI 名称。建议参考图统一采用一个优先级：
1. 存在点对点参考点时显示参考点（如 N15、N22、N35、N36）；
2. 只有服务化接口时显示 SBI（如 Nnrf、Nbsf）；
3. 需要同时表达时使用双标（如 N22 / Nnssf）。

静态参考图仍是“架构知识”，不是部署事实；它不能替代实际关系边上的 `interfaceNames`。

## 5. 契约变更清单

### 5.1 后端

```text
backend/internal/topology/catalog.go       新增：受控接口目录、校验、按名称查找
backend/internal/topology/model.go         TopologyEdge / 创建 / 更新输入增加 InterfaceNames []string
backend/internal/topology/dto.go           JSON 字段 interfaceNames，响应始终返回数组
backend/internal/topology/mapper.go        读写映射，旧文档缺省为空数组
backend/internal/topology/handler.go       meta 下发 interfaceCatalog；创建/更新校验
backend/internal/topology/service.go       校验失败不落库；审计记录包含 interfaceNames
backend/internal/topology/repository.go    持久化可选数组；不改索引
```

规则：

```text
interfaceNames 可选，最多 8 个，去重后保存；
每个值 trim 后必须与词表 name 完全匹配；
未知值返回 400 INVALID_INTERFACE_NAME；
空数组合法，表示“尚未标注”；
不从关系类型或端点角色推断接口；
v1 只强制词表成员与结构校验；端点兼容性只做表单建议和非阻塞提示，不做硬拒绝
（DRA/SCP 代理、漫游、共享 HSS/PCRF 场景下强校验会误伤）；
meta 的 endpoints / producerRole 仅用于建议，meta 新增 catalogVersion。
```

API 影响：

```text
GET /api/topology/meta              响应新增 interfaceCatalog 等字段（向后兼容）
GET /api/topology/edges             每条边新增 interfaceNames: []（向后兼容）
GET /api/topology/edges/{edgeId}    同上
POST /api/topology/edges            请求新增可选 interfaceNames
PUT  /api/topology/edges/{edgeId}   请求新增可选 interfaceNames
路由注册数量不变（157）；权限、限流、生命周期、CAS、退役语义不变
MongoDB 不新增集合、不迁移；app_topology_edges 文档新增可选数组字段
活动边唯一索引保持 (fromResourceId, toResourceId, relationshipType)
```

### 5.2 前端

- `topology-types.ts`：`TopologyEdge`、`CreateEdgeRequest`、`UpdateEdgeRequest`、`TopologyMetaResponse` 增加接口字段和目录类型。
- `TopologyEdgeForm`：按域/类别分组的受控多选，支持搜索；未选择时不伪造。
- `TopologyEdgeDetail` / 关系台账：展示全部接口名，旧边显示“未标注接口”。
- 实际拓扑画布：标签优先显示接口名（多个用 ` / ` 连接），没有接口名时回退关系类型；仍只在聚焦/悬停时显示。
- 实际拓扑工具栏：接口筛选、未标注接口数量、已标注覆盖率。
- 域视图：叠加 / 单域 / 跨域互通；单域模式显式显示被隐藏的跨域关系数量。
- 参考架构：按第 4 节纠正标签。
- 中英文 locale 同步。

### 5.3 词表治理

- 词表是服务端代码，不是运行时管理界面；新增/变更走代码评审。
- 每条必须填写 3GPP 规范号与条款；无规范来源的条目不接收。
- 双签：核心网负责人做领域确认，后端维护者做代码评审。
- `GET /api/topology/meta` 返回 `catalogVersion`；新增为增量；重命名/删除必须保留旧名称可读并经过弃用期。
- CI 校验：名称唯一、category/domains/plane/scope 合法、spec 非空、SBI producer 合法。
- 已持久化的边引用旧名称时，旧名称必须继续可读；禁止静默改名。

### 5.4 文档与测试

- `docs/architecture/topology-dependency-model.md`：补充 `interfaceNames` 契约、受控词表、代理/共享节点语义、无推断规则。
- 后端：catalog 唯一性/字段合法性/校验失败/round-trip/meta 测试。
- 前端：表单多选、旧边兼容、标签优先级、筛选、参考图标签纠正测试。
- 运行门禁与当前流程一致；不新增 API 路由。

## 6. 已确认事项

1. `S5`、`S8` 拆成两个受控名称：S5 为 Intra-PLMN，S8 为 Inter-PLMN。
2. 参考架构两处确定性错误（AMF–PCF 的 N8、PCF–UDR 的 N5）与本批同批修正。
3. 接口名只能来自服务端受控词表；v1 为 46 条 `nf_nf`，external 不进入 catalog / 表单。
4. v1 端点兼容性只做建议，不做硬校验。服务端强制词表成员与结构；UI 根据 endpoints/domains 给出建议，不匹配时显示非阻塞提示。
5. 共享网元作为“边界节点”，代理网元作为“代理节点”，语义见 3.7。边界节点默认显示，可切换隐藏。
6. 词表治理采用“领域确认 + 代码评审”：新增条目必须带 3GPP 规范号和条款，由 `admin` / 核心网负责人做领域确认，由后端维护者做代码评审；词表是代码，不提供运行时编辑界面；meta 带 catalogVersion；重命名/删除必须保留旧名称可读并经过弃用期。
7. NF 默认视图只按 kind：`network_function` / `network_function_instance`；`network_element` 默认隐藏且不计入 NF；role 只用于分组、标签和接口建议。
8. OCS 不承担 CHF；`N28 / N40 / N41 / N42 / Nchf` reserved，等 `chf` 角色出现后再加入。
9. 存储/匹配/endpoints 使用紧凑 role token；显示标签使用 `SGW-C` / `P-CSCF` 等 3GPP 规范形式。

## 7. 参考来源

- 3GPP TS 23.501：5G 系统架构与参考点（N1–N60 系列）。
- 3GPP TS 23.503：5G 策略与计费控制框架（N28、N43 等）。
- 3GPP TS 23.401：EPC 架构与参考点（S5/S8、S6a、S10、S11、Sxa/Sxb 等）。
- 3GPP TS 23.228 / TS 24.229：IMS 架构与 SIP 接口（Mw、Gm、ISC 等）。
- 3GPP TS 29.228 / TS 29.229：Cx / Dx；TS 29.214：Rx。
- 3GPP TS 32.240 / TS 32.299：计费参考点（Gy、Ro、Rf、N40–N42 等）。
- Web 交叉核对（非规范性，仅用于确认名称与端点）：
  - https://www.txrjy.com/thread-1414506-1-1.html
  - https://www.360doc.cn/article/79743650_1165719958.html
  - https://m.blog.csdn.net/yifei800327/article/details/128888836
  - https://blog.csdn.net/qq_44390640/article/details/135164785
