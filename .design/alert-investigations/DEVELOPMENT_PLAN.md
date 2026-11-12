# 告警排障工作台开发计划

日期：2026-11-12。状态：实施中。设计依据：DESIGN_BRIEF.md。

## 范围与契约

新增 Go 模块 investigation。五条加法式 API：

- GET /api/investigations/context：指定 alertId 以及可选 from / to，读取有界关联证据。
- GET /api/investigations：q、status、alertId、resourceId、cursor、limit。
- POST /api/investigations：幂等 requestId、告警、标题、固定时间窗。
- GET /api/investigations/{investigationId}。
- PATCH /api/investigations/{investigationId}：expectedRevision 与人工可变字段。

新增两个 SPA 路由。现有路径与响应不变。列表页不宣称平台总量。

## 数据与证据边界

唯一新增领域写为 xcloud_ops.app_investigations，使用已有 Ops 数据库 handle。原子保存记录、revision 与有界最近修改元数据；不存原始日志、指标、配置、认证信息或自动生成结论。保存的资源身份来自告警，不接受浏览器覆盖。幂等重复不同请求拒绝。

跨域仓储只读正向白名单投影：NF 告警、Inventory、active Topology 边、NF Health runs、published 配置 observations、知识标题元数据。时间查询保留实际字段类型，资源 UUID 批量连接，禁止名称／IP 推断。历史缺少 resourceId 的测量不补关联。当前拓扑及资产明确标注为读取时状态。

默认最多 20 条一跳边、21 个资源、128 条相关告警／128 次健康采集／128 次配置观测；每来源 limit+1 检测截断、独立失败与超时、整体 8 秒、单查询 2 秒、全局最多 4 个上下文读取。最终 JSON 有体积上限，超界保留部分语义，不返回精确总量。历史覆盖始终未知，不据空结果推断无变化或健康。

读需 core.read；写需 core.configure，加 Fresh Actor、CAS、严格 JSON、限流、best-effort 审计。所有响应 no-store。审计只记 ID、状态、revision，不写自由备注。GET 与启动不建索引。新增索引提供 dry-run / --apply CLI，绝不自动执行生产迁移。

## 顺序与完成条件

1. 原生正向投影与有界上下文：混合时间、独立来源失败、截断、缺失身份、当前关系、配置发布过滤均有测试。
2. 排障记录闭环：幂等创建、版本更新、重新鉴权、viewer 拒绝、人工结案、知识关联和游标验证均有测试。
3. 页面纵向闭环：从告警进入、查证据、保存／编辑／结案、回到原查询；复用共享组件与中英文文案。
4. 自有临时 Mongo 集成、浏览器 fixture、设计审查、全量 Go / 前端检查、契约与文档门禁。
5. 计划、后端和 UI 分开提交；当前文档与配对规则同步。完成后计划从 HEAD 移除，Git 保留历史，验收证据留 artifacts。

## 现场边界

不更新现有服务，不变更数据库权限／索引，不执行网元操作。隔离证明和真实现场验收分别报告；真实数据不足时保持 UNKNOWN / NOT_RUN。
