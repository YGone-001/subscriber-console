# 核心网网元拓扑开发计划（换机交接版）

> 状态：5 项决策已确认；阶段 1、阶段 2 已完成，阶段 3 待开始。
> 基线：`develop` 分支，commit `d2e0dbf`（feat(frontend): make declared topology the primary topology view）。
> 配套文档：`docs/analysis/topology-interface-catalog-draft-2026-10-23.md`（接口词表与契约草案）。
> 用途：换机后在新 Qoder CN 会话中按本计划继续实施。

---

## 0. 换机前须知

- 当前仓库工作区：`\\10.10.0.139\agent-dev\project\linux-subscriber-console`（Linux 主机共享）。
- 已提交：`d2e0dbf` 实际拓扑视图、关系标签、监测健康叠加。
- 工作区已安全对齐到 `d2e0dbf`；`docs/analysis/` 两份文档已入库。
- `frontend/package-lock.json` **不要混入任何提交**。
- 不要 push；由用户手动推送。
- 多 Agent 共享同一个工作区，开始前先 `git status`、`git branch --show-current`、`git log --oneline -10`，确认没有其他会话正在改同一批文件。

---

## 1. 目标与范围

`/topology` 是**核心网网元之间的拓扑**，不是通用资源图。本轮目标：

1. 默认只显示 NF 类资源（含 EPC 常见的 `network_element`）。
2. 关系边支持受控的接口名（参考点 + SBI），不允许自由输入，不允许从两端网元推断。
3. 提供全部叠加、单域、跨域互通三种查看方式。
4. 保留并强化已有能力：实际拓扑默认、参考架构独立、分域布局、一跳聚焦、曲线标签、监测/健康叠加、完整性语义。
5. 修正参考架构中两处确定的 3GPP 标签错误。

非目标：

- 不做通用 CMDB 资源拓扑、机房/主机/虚拟机拓扑。
- 不做 3GPP 协议级连通性探测；接口名是“声明的关系”，不是实测结果。
- 不自动回填旧边的接口名，不根据端点角色推断接口。
- 不新增 API 路由，不改 MongoDB 集合和唯一索引。
- 不做小地图、自由力导向布局、任意资源图折叠。

---

## 2. 已确认决策

| 项目 | 决策 |
|---|---|
| 拓扑范围 | 严格核心网网元；host/site/IP 等支撑资源默认隐藏，并显示隐藏数量 |
| NF 判定 | 仅 `network_function` / `network_function_instance`；`network_element` 默认隐藏，不计入 NF；role 不参与可见性 |
| NF 角色 token | 存储、匹配、接口 endpoints 使用真实紧凑值 `sgwc / sgwu / pgwc / pgwu / pcscf / icscf / scscf / smsc`；显示标签统一使用 3GPP 规范写法 `SGW-C / SGW-U / PGW-C / PGW-U / P-CSCF / I-CSCF / S-CSCF / SMSC` |
| 多网元同能力 | 节点身份永远是 `resourceId`，不按名称合并；`role` 只用于分列/可选聚合 |
| 接口名 | 服务端受控词表，参考点与 SBI 都收录并分类；禁止自由输入；v1 只收 46 条 `nf_nf`，external 不进入表单 |
| 接口字段 | `interfaceNames: string[]`，保持现有活动边唯一索引不变 |
| S5 / S8 | 拆成两个受控名称：S5 Intra-PLMN，S8 Inter-PLMN |
| 端点兼容性 | v1 只做表单建议和非阻塞提示，不做硬校验 |
| 边界节点 | 共享网元（HSS/PCRF/OCS 等）默认作为边界节点显示，单独计数，可切换隐藏 |
| 代理节点 | DRA/SCP 作为代理节点低对比度显示，注明 `via DRA/SCP`，不拼出逻辑直连 |
| 旧边兼容 | 旧边 `interfaceNames` 为空，显示“未标注接口”，不推断、不回填 |
| 参考架构错误 | 本批修正：AMF–PCF `N8 → N15`；PCF–UDR `N5 → N36` |
| 领域确认 | 默认由 `admin` 角色持有人/核心网平台管理员组做领域确认；后端维护者做代码评审 |
| 词表治理 | 词表在代码中；新增必须带 3GPP 规范号与条款；`catalogVersion`；旧名称保留可读 |
| 验收环境 | 前端检查在 Linux 主机执行；Windows 侧共享 `node_modules` 可能只读 |

---

## 3. 5 个决策点（已确认）

> 以下决策已确认，直接按此实施。

### 3.1 NF 判定与真实 role 取值（已确认）

确认结果：v1 默认视图**只按 kind 判定 NF**，不引入 `network_element` + role 白名单。

- `network_function` / `network_function_instance` 默认显示；role 不参与可见性判断。
- `network_element` 与 host/site 等支撑资源默认隐藏并计数；可在“显示支撑资源”开关中查看，但不计入 NF。
- role 只用于分组、显示标签、接口端点建议。
- 2026-10-23 在 10.10.0.139 只读查询 `xcloud_ops.app_inventory_resources`：21 条全部为 `network_function`、`lifecycle=planned`、`source=discovered`；0 条 `network_element`、0 条 `network_function_instance`、0 条拓扑边。
- 真实 role：5gc `amf, ausf, bsf, nrf, nssf, pcf, scp, smf, udm, udr, upf`；epc `hss, mme, pcrf, sgwc, sgwu`；ims `icscf, pcscf, scscf, smsc`；charging `ocs`。
- `role` 是自由文本（最长 64），不是枚举；规范化只用于分组/别名，不改变存储值。
- 接口词表端点、参考架构绑定与匹配使用真实紧凑 token：`sgwc / sgwu / pgwc / pgwu / pcscf / icscf / scscf`；显示标签统一使用 `SGW-C / SGW-U / PGW-C / PGW-U / P-CSCF / I-CSCF / S-CSCF` 等规范连字符形式。
- 当前实际拓扑为 0 条边；验收需要 fixture 或测试边。

存储 token 与显示标签的固定映射：

| 存储 token | 显示标签 |
|---|---|
| `sgwc` / `sgwu` | `SGW-C` / `SGW-U` |
| `pgwc` / `pgwu` | `PGW-C` / `PGW-U` |
| `pcscf` / `icscf` / `scscf` | `P-CSCF` / `I-CSCF` / `S-CSCF` |
| `smsc` | `SMSC` |
| 其余 NF token | 直接大写（`AMF`、`SMF`、`UPF`、`PCF`、`HSS`、`PCRF`、`OCS`、`DRA` 等） |

### 3.2 OCS 是否承担 5GC 的 CHF 角色（已确认）

确认结果：**不承担**。v1 词表不包含 `N28/N40/N41/N42/Nchf`，不把 OCS 映射为 CHF；保留未来 `chf` 角色的扩展位，等 Inventory 出现 `chf` 后再按规范增量加入。OCS 只保留 Gy / Sy / Ro。

### 3.3 IMS 词表范围（已确认）

v1 只收录当前已纳管角色的接口：`Mw, Cx, Rx, Gq, Ro`。MGCF、BGCF、MRFC、MRFP、SLF、AS 相关接口（Mg/Mi/Mj/Mk/Mr/Mp/Mx、Dx、Sh/ISC/Ma、Rf 等）不进入 v1。
external 接口（含 `Gm`）不进入 v1 `interfaceCatalog` 或表单；v1 保持 46 条 `nf_nf`。未来需要时再增量加入并单独评审。

### 3.4 新关系是否强制填写接口名（已确认）

**v1 可选**，所有关系类型统一；界面显示已标注覆盖率，例如“14 条关系中 9 条已标注接口”。等数据质量稳定后，再考虑仅对 `connects_to` / `registers_with` 强制。`contains` / `runs_on` 等关系没有接口；DRA/SCP 代理段、漫游、非规范扩展会误伤。

### 3.5 接口名默认显示方式（已确认）

保持“聚焦/悬停显示”，并增加“显示全部接口名”开关；工具栏显示已标注覆盖率。接口名是核心语义，但全量显示会重新造成标签密集；聚焦/悬停与开关兼顾可读性与可查性。

---

## 4. 实施阶段

### 阶段 1：后端接口词表与边契约（优先）

目标：服务端拥有权威词表；边可以保存受控接口名；旧数据零迁移、零破坏。

任务：

- [x] 新增 `backend/internal/topology/catalog.go`
  - `InterfaceEntry`、`InterfaceCategory`、`InterfacePlane`、`InterfaceScope`。
  - v1 词表 46 条，全部 `nf_nf`：5GC 参考点 20、5GC SBI 9、EPC 12（含 S5/S8 拆分）、IMS 5；external 不进入 v1。
  - endpoints 使用真实紧凑 role token（`sgwc`、`pgwc`、`pcscf` 等），不使用显示标签。
  - `CatalogVersion`，初值 `"2026-10-23.1"`。
  - `ValidateInterfaceNames(names []string) ([]string, error)`：trim、去重、最多 8 个、空数组合法、逐项 membership 校验。
  - `validateInterfaceCatalog()`：名称唯一、category/domain/plane/scope 合法、spec/description 非空、SBI producer 合法、端点角色为紧凑 token。
- [x] 修改 `backend/internal/topology/model.go`
  - `Edge.InterfaceNames []string`，JSON 始终输出数组，BSON 空值可省略。
  - `CreateEdgeRequest.InterfaceNames`、`MutableEdge.InterfaceNames`；update 用指针区分“未提供（保留）”与“显式空数组（清除）”。
  - `MetaResponse` 增加 `catalogVersion`、`interfaceCategories`、`interfaceScopes`、`interfacePlanes`、`interfaceCatalog`。
- [x] 修改 `backend/internal/topology/validation.go`
  - 新增 `ErrInvalidInterfaceName`。
  - `ValidateCreateRequest` / `ValidateUpdateRequest` 调用词表校验。
  - `writeValidationError` 将错误映射为 `400 INVALID_INTERFACE_NAME`。
- [x] 修改 `backend/internal/topology/handler.go`
  - `Meta` 返回词表。
  - 创建/更新路径无需新路由；审计 `After` 自动包含新字段。
- [x] 修改 `backend/internal/topology/repository.go`
  - `Create` 写入 `interfaceNames`；`Update` 仅在 `interfaceNames` 显式出现时写入 `$set`，未提供时保留旧值。
  - `GetByID` / `List` / `Neighbors` / `Create` / `Update` 把 nil 规范化为 `[]string{}`，保证响应始终是数组。
  - 不改索引、不新增集合。
- [x] 测试
  - 词表唯一性、字段合法性、SBI producer 合法、spec 非空、46 条计数、端点使用紧凑 token。
  - 创建/更新 round-trip；未知名称 400；空数组；去重；超过 8 个；旧文档无字段读取为 `[]`。
  - 旧客户端 update 未提供 `interfaceNames` 时保留原值；显式空数组清除。
  - meta 契约测试。
- [x] 文档
  - 更新 `docs/architecture/topology-dependency-model.md`：接口名契约、词表、无推断、代理/共享节点语义。

验收：

```text
cd backend && gofmt -w . && go test ./... && go vet ./... && go build ./...
GET /api/topology/meta 返回 catalogVersion 与 46 条 interfaceCatalog
POST/PUT 边可保存 interfaceNames，旧边返回 []
旧客户端 update 未提供 interfaceNames 时保留原值
未知接口名返回 400 INVALID_INTERFACE_NAME
路由注册数仍为 157；MongoDB 无迁移；唯一索引不变
```

### 阶段 2：NF-only 默认视图

目标：默认只显示核心网 `network_function` / `network_function_instance`，不引入 role 白名单；支撑资源默认隐藏且计数可见。

任务：

- [x] 新增前端集中式 NF 判定模块（`frontend/src/features/topology/nf-classification.ts`）：
  - kind-only：`network_function`、`network_function_instance` 为 NF；
  - `network_element` 归入 support，默认隐藏，可切换查看，但不计入 NF；
  - role token 规范化仅用于分组、显示标签和接口建议，兼容 `sgwc` / `sgw-c` / `sgw_c` 等历史写法；
  - 显示标签使用规范形式（`SGW-C`、`P-CSCF` 等），存储匹配仍用紧凑 token。
- [x] 修改 `actual-topology-model.ts`：
  - 过滤非 NF 端点及其边；
  - 统计被隐藏的支撑资源与关系数；
  - NF 分组使用真实紧凑 role，并新增 `ims` 分组（`icscf` / `pcscf` / `scscf` / `smsc`）。
- [x] 修改 `ActualTopologyView.tsx`：
  - 显示“已隐藏 N 个支撑资源 / M 条关系”；
  - 提供“显示支撑资源”开关（包含 `network_element`，但不计入 NF）；
  - 空图与不可用状态保持现有诚实语义。
- [x] 测试：NF 过滤、`network_element` 默认隐藏、host/site 隐藏、`network_function` 未知 role 仍显示、`network_function_instance` 显示、隐藏计数、开关、空态。

实现记录（fixture 浏览器验收）：默认 5 个 NF 节点、4 条关系，2 个支撑资源隐藏；切换后 7 个节点、6 条关系，`network_element(role=mme)` 保持在 `support` 分组并显示 `MME / Support resource`。未解析端点始终保留。

验收：

```text
network_function(role=mme) 显示；
network_function(role=smsc) 显示，不因 role 白名单消失；
network_element(role=mme) 默认隐藏并计入支撑资源；
host/site 默认隐藏且计数可见；
network_function_instance 仍显示；
现有 45 条拓扑测试不回退。
```

### 阶段 3：域视图与边界/代理节点

目标：支持全部叠加、单域、跨域互通；共享节点不消失，代理节点不伪装。

任务：

- [ ] 增加域筛选：`全部` / `5gc` / `epc` / `ims` / `charging` / `跨域互通`。
- [ ] 叠加模式采用“域带”布局：每个域一条带，带内再按接入/会话/发现/数据/策略/用户面分列。
- [ ] 单域模式：
  - 只显示该域 NF；
  - 共享网元作为边界节点显示（与所选域有已声明关系时），只保留与所选域相关的边；
  - 边界节点单独计数，可切换隐藏；隐藏时显示数量；
  - 跨域关系数量显式显示，不静默消失；
  - 未知 domain 单独一档“未分类”。
- [ ] 代理节点：DRA/SCP 低对比度显示，详情注明 `via DRA/SCP`；不跨两条边拼接逻辑直连。
- [ ] 测试：三种模式的节点/边计数、边界节点、代理节点、未分类、隐藏提示。

验收：

```text
全部模式可看到 5GC/EPC/IMS/Charging 及互通边；
单域模式不丢共享网元，边界节点计数正确；
跨域互通模式只显示跨域边及两端网元；
没有推断或拼接出来的关系。
```

### 阶段 4：接口 UI、筛选与参考架构修正

任务：

- [ ] `topology-types.ts`：边/请求/meta 增加接口字段和目录类型。
- [ ] `TopologyEdgeForm`：受控多选（按域/类别分组、可搜索），不回显词表外名称；端点建议按真实紧凑 role token 匹配，显示规范标签。
- [ ] `TopologyEdgeTable` / `TopologyEdgeDetail`：展示全部接口名；旧边显示“未标注接口”。
- [ ] `ActualTopologyCanvas`：标签优先接口名（多个用 ` / ` 连接），否则回退关系类型；默认聚焦/悬停显示。
- [ ] `ActualTopologyView`：接口筛选、已标注覆盖率、“显示全部接口名”开关。
- [ ] 参考架构修正：
  - AMF–PCF：`N8 → N15`；
  - PCF–UDR：`N5 → N36`；
  - `role` / `roleTokens` 与 Inventory 真实紧凑 token 对齐，显示标签保持 `SGW-C` / `P-CSCF` 等规范形式；
  - 增加映射测试，防止回归。
- [ ] 中英文 locale 同步。

验收：

```text
新建边只能选择词表接口；
旧边不显示伪造接口；
画布标签可区分接口名与关系类型；
参考架构两处标签正确且有测试保护；
900px 窄屏、空态、不可用态、聚焦态无回归。
```

### 阶段 5：验证、文档与提交

- [ ] 后端门禁：`gofmt -w .`、`go test ./...`、`go test -race ./...`、`go vet ./...`、`go build ./...`。
- [ ] 前端门禁：`npm run lint`、`npm run typecheck`、`npm test`、`npm run build`、`npm run check:fonts`。
- [ ] 文档门禁：`node scripts/test-current-architecture-docs.mjs`、`test-documentation-integrity.mjs`、`test-api-ownership-invariants.mjs`、`test-agent-docs-parity.mjs` 等。
- [ ] 浏览器验收：构建到临时目录 + fixture server + Playwright；覆盖默认、单域、互通、聚焦、接口筛选、旧边未标注、窄屏。
- [ ] 文档：更新 `docs/architecture/topology-dependency-model.md`；把词表草案转为当前事实文档或保留在 analysis 并标注已实现。
- [ ] 提交：按阶段拆分 commit；不 push；不包含 `frontend/package-lock.json`。

已知既有失败（不要在本轮顺手修，除非用户明确要求）：

```text
frontend/tests/system-health-operational.test.ts  business mutation route count 12 vs 11
frontend/tests/ui-primitives.test.ts              PageHeader import form
scripts/test-topology-contract.mjs                business mutation endpoints expected 29, actual 33
scripts/test-repository-normalization.mjs         go_routes_added expected 52, actual 73
scripts/test-frontend-runtime-dependencies.mjs    unexpected runtime deps react-markdown, remark-gfm
```

---

## 5. 契约细节

### 5.1 Meta 响应（新增字段，向后兼容）

```json
{
  "schemaVersion": 1,
  "relationshipTypes": ["..."],
  "lifecycleStates": ["active", "retired"],
  "catalogVersion": "2026-10-23.1",
  "interfaceCategories": ["reference_point", "sbi"],
  "interfaceScopes": ["nf_nf", "external"],
  "interfacePlanes": ["control", "user", "both"],
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
    },
    {
      "name": "Nsmf",
      "category": "sbi",
      "domains": ["5gc"],
      "plane": "control",
      "scope": "nf_nf",
      "producerRole": "smf",
      "spec": "3GPP TS 23.501 / TS 29.500",
      "description": "SMF 的服务化接口"
    }
  ]
}
```

### 5.2 边字段

```json
{
  "interfaceNames": ["N11"]
}
```

规则：

```text
可选；空数组合法；最多 8 个；trim 后去重；
每个值必须与词表 name 完全匹配；
未知值 400 INVALID_INTERFACE_NAME；
旧文档缺省读取为 []；
不从 relationshipType / 端点角色推断；
update 未提供 interfaceNames 时保留原值；显式 [] 清除；
v1 不做端点配对硬校验；
v1 词表 46 条全部 nf_nf，external 不进入表单；
endpoints 使用紧凑存储 token，显示标签使用规范连字符名。
```

### 5.3 API 与数据层

```text
GET  /api/topology/meta                响应新增词表字段
GET  /api/topology/edges              每条边新增 interfaceNames
GET  /api/topology/edges/{edgeId}     同上
POST /api/topology/edges              请求新增可选 interfaceNames
PUT  /api/topology/edges/{edgeId}     请求新增可选 interfaceNames；未提供则保留
路由注册数不变（157）；权限、限流、CAS、退役语义不变
MongoDB 不新增集合、不迁移；唯一索引保持
(fromResourceId, toResourceId, relationshipType)
```

### 5.4 词表治理

```text
词表在服务端代码中，不提供运行时编辑界面；
每条必须有 3GPP 规范号与条款；
新增 = 领域确认（admin/核心网负责人）+ 代码评审（后端维护者）；
meta 带 catalogVersion；
新增是增量；重命名/删除必须保留旧名称可读并经过弃用期；
CI 校验名称唯一、字段合法、spec/description 非空、SBI producer 合法、端点角色为紧凑 token、v1 共 46 条。
```

---

## 6. 文件地图

后端：

```text
backend/internal/topology/catalog.go        新增：词表与校验
backend/internal/topology/model.go          Edge / 请求 / MetaResponse
backend/internal/topology/validation.go     词表校验与错误
backend/internal/topology/handler.go        Meta / 创建 / 更新
backend/internal/topology/repository.go     字段持久化与 nil 规范化
backend/internal/topology/*_test.go         契约与回归测试
```

前端：

```text
frontend/src/features/topology/topology-types.ts
frontend/src/features/topology/topology-api.ts
frontend/src/features/topology/TopologyPage.tsx
frontend/src/features/topology/actual-topology-model.ts
frontend/src/features/topology/ActualTopologyView.tsx
frontend/src/features/topology/components/ActualTopologyCanvas.tsx
frontend/src/features/topology/components/TopologyEdgeForm.tsx
frontend/src/features/topology/components/TopologyEdgeTable.tsx
frontend/src/features/topology/components/TopologyEdgeDetail.tsx
frontend/src/features/topology/reference-architecture.ts
frontend/src/features/topology/nf-classification.ts     新增
frontend/src/lib/locales/en.ts
frontend/src/lib/locales/zh.ts
frontend/src/styles/modules/architecture.module.css
frontend/tests/topology.test.ts
frontend/tests/topology-views.test.tsx
frontend/tests/architecture.test.ts
```

文档：

```text
docs/architecture/topology-dependency-model.md
docs/analysis/topology-interface-catalog-draft-2026-10-23.md
docs/analysis/topology-nf-development-plan-2026-10-23.md
```

---

## 7. 验证环境与命令

前端检查优先在 Linux 主机执行（共享 `node_modules` 在 Windows 侧可能只读）：

```bash
ssh xcloud
cd ~/project/subscriber-console/frontend
npm run lint
npm run typecheck
npm test
npm run build
npm run check:fonts
```

如果 `npm run typecheck` 因 `node_modules/.tmp` 无写权限失败，使用：

```bash
npx tsc -p tsconfig.app.json --noEmit --composite false --incremental false
npx tsc -p tsconfig.node.json --noEmit --composite false --incremental false
```

后端：

```bash
cd backend
gofmt -w .
go test ./...
go test -race ./...
go vet ./...
go build ./...
```

浏览器验收建议沿用现有 fixture 方式：`npx vite build --outDir /tmp/subs-dist --emptyOutDir`，用 `frontend/tests/topology-fixtures.mjs` 启动 fixture server，再用 Playwright 打开 `/topology`。临时脚本验证完删除，不留在仓库。

---

## 8. 验收清单

- [ ] 默认只显示 `network_function` / `network_function_instance`；支撑资源隐藏计数可见，可切换。
- [ ] `network_function(role=mme)` 与 `network_function(role=smsc)` 均显示；`network_element` 默认隐藏并计入支撑资源。
- [ ] 接口名只能从 46 条 `nf_nf` 词表选择；未知名称 400；external 不进入表单。
- [ ] 旧边兼容，响应 `interfaceNames: []`，界面显示“未标注接口”；旧客户端 update 不丢已标注接口。
- [ ] 接口标签优先于关系类型，默认聚焦/悬停显示，可切换全部显示。
- [ ] 全部 / 单域 / 跨域互通三种模式可用；边界节点与代理节点语义正确。
- [ ] 参考架构 N15 / N36 修正并有测试；显示标签为 `SGW-C` / `P-CSCF` 等规范形式。
- [ ] 监测健康叠加、关系标签防重叠、缩放/全屏、搜索、空态/部分/不可用态无回归。
- [ ] 后端与前端门禁通过；已知既有失败保持不变。
- [ ] 未 push；未提交 `package-lock.json`。

---

## 9. Git 与提交

- 每个阶段一个逻辑 commit，保持可构建、可回滚。
- Conventional Commits；标题一句话；正文可一小段；禁止阶段编号/阶段词（`P0`、`P1`、`phase` 等）出现在 commit message。
- 禁止签名 trailer（`Co-Authored-By`、`Signed-off-by`）。
- 不 push，不 rebase 公共历史，不 reset --hard。
- `frontend/package-lock.json` 不纳入提交。
- 建议提交顺序：
  1. `docs(topology): add interface catalog and development plan`（如需先保存文档）
  2. `feat(backend): add controlled topology interface catalog`
  3. `feat(frontend): show only network functions by default`
  4. `feat(frontend): add domain views and boundary nodes`
  5. `feat(frontend): surface interface names on topology relationships`
  6. `fix(frontend): correct reference architecture interface labels`

---

## 10. 风险与注意事项

1. **NF 判定已确认 kind-only**：`network_element` 默认隐藏；将来若确实承载 EPC 网元，再单独评审开关或分类，不把 role 白名单套到 `network_function`。
2. **OCS/CHF 已确认不映射**：v1 不收录 N28/N40/N41/N42/Nchf；等 `chf` role 出现再增量加入。
3. **Display label 与存储 token 分离**：存储/匹配/endpoints 使用 `sgwc`、`pgwc`、`pcscf` 等；界面显示使用 `SGW-C`、`PGW-C`、`P-CSCF` 等规范形式，禁止混用。
4. **DRA/SCP 代理语义**：接口名表示逻辑接口段，详情必须注明代理；不要拼逻辑直连。
5. **共享节点计数**：边界节点不计入当前域 NF 总数，但必须可见、可解释。
6. **参考架构混用参考点与 SBI**：本次只修两处事实错误；`Nnssf/Nudr` 等分类统一留到词表落地后处理。
7. **旧边无接口名**：这是已知数据缺口，不是错误；用覆盖率呈现，不猜测。
8. **多 Agent 共享工作区**：开始前检查 git status；不要覆盖其他会话未提交的改动；提交前确认 diff。
9. **前端 node_modules 只读**：Windows 侧可能无法执行构建；优先在 Linux 主机验证。
10. **既有测试失败**：`system-health-operational` 路由计数、`ui-primitives` PageHeader 导入形态，与本计划无关，不要顺手改。`scripts/test-topology-contract.mjs` 还有一处既有失败：business mutation endpoints 期望 29、基线实际 33；已在 `d2e0dbf` 复现，与本计划无关，不要顺手改。

---

## 11. 新会话启动提示词（可直接粘贴到新 Qoder CN）

```text
你在 subscriber-console 仓库（develop 分支）继续实施核心网网元拓扑开发计划。

先读：
1. AGENTS.md / CLAUDE.md
2. docs/analysis/topology-nf-development-plan-2026-10-23.md
3. docs/analysis/topology-interface-catalog-draft-2026-10-23.md

基线 commit：d2e0dbf。工作区可能还有未提交的文档和 frontend/package-lock.json；不要提交 package-lock.json。

任务：按计划第 4 节从阶段 1 开始：后端受控接口词表 + 边 interfaceNames 契约。
约束：
- NF 默认视图只按 kind；network_element 不计入 NF；role 不参与可见性；
- 接口名只能来自服务端词表，参考点和 SBI 都收录并分类；v1 46 条 nf_nf，external 不进入表单；
- 存储/匹配/endpoints 使用真实紧凑 token；显示标签使用 SGW-C / P-CSCF 等规范形式；
- S5/S8 是两个独立名称；未知名称返回 400 INVALID_INTERFACE_NAME；
- 不新增路由、不改集合/唯一索引、不自动回填旧边；
- v1 端点兼容性只做建议，不做硬校验；
- 参考架构错误在本批修正：AMF–PCF N8→N15，PCF–UDR N5→N36；
- 不 push；每个阶段一个 Conventional Commit，标题一句话，禁止阶段编号/阶段词和签名 trailer。

开始前先执行 git status / branch / log；计划第 3 节决策已确认，按文档实施，不再重新确认默认值。

验证环境：前端检查优先在 Linux 主机执行；Windows 侧 node_modules 可能只读。后端执行 gofmt / go test / go vet / go build。
```

---

## 12. 参考

- 3GPP TS 23.501：5G 系统架构与参考点。
- 3GPP TS 23.503：5G 策略与计费控制。
- 3GPP TS 23.401：EPC 架构与参考点。
- 3GPP TS 23.228 / TS 24.229：IMS 架构与 SIP 接口。
- 3GPP TS 29.228 / TS 29.229：Cx / Dx；TS 29.214：Rx。
- 3GPP TS 32.240 / TS 32.299：计费参考点。
- 仓库文档：`docs/architecture/topology-dependency-model.md`。
- 接口词表草案：`docs/analysis/topology-interface-catalog-draft-2026-10-23.md`。
