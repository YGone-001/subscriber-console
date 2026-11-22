# 指标保障验收记录

日期：2026-11-22
范围：`docs/architecture/metric-history.md`、`metric-analysis.md`、`operations-reports.md`
结论：源码与隔离 Mongo 验收通过；Playwright 现场验收与 10 series 形状未执行。

## 已执行的验收

| 项 | 命令 | 结果 |
|---|---|---|
| 后端全量 | `go test ./... -count=1` | PASS |
| 竞态 | `go test -race ./internal/nfhealth/ ./internal/opsreports/ ./internal/nfalert/` | PASS |
| 静态检查 | `go build ./...`、`go vet ./...` | PASS |
| 前端 | `npm run check`（lint、tsc、875 项测试、字体、构建） | PASS |
| 契约与文档 | api-ownership、nf-health 契约、架构文档、文档完整性、直接操作、索引迁移 | PASS |

## 端到端链路（隔离 Mongo）

`TestMetricPipelineEndToEnd` 覆盖：采集证据 → 小时桶 → 日汇总 → 基线偏离记录 → 持续趋势记录 → 分析告警 sink。

- 48 小时线性基线 + 当前小时同斜率：基线记录为 `ok`（稳定爬升相对自身基线不是离群），趋势记录为 `rising` 且 `confirmed`。两条记录对同一数据给出不同但正确的结论，这正是分成两类记录的意义。
- 重复 tick 不重发记录。
- 修补基线小时后，已发布的记录**不被静默改写**（`baselineDigest` 保持旧值），重算不属于本版本能力。

`TestAnalysisRuleFiresHoldsAndRecovers` 覆盖告警侧：首个事件开警并通知；同一小时重放幂等且静默；`insufficient_data` 保持（不清除开放告警）；单次正常不关闭；连续两次正常才关闭并发出恢复通知；超过 2 小时的事件只落记录不通知；规则不会评估其他目标的记录。

## 容量回放（真实 MongoDB）

`NF_METRIC_LOAD_TEST=1 go test ./internal/nfhealth/ -run MetricHistoryLoadBudget`

```text
targets=100 hours=720 docs=72000 p50=68.9ms p95=94.1ms index=true heap_delta_kb=2803
```

- 形状：100 目标 × 30 天小时桶 = 72,000 文档，单次读取 30 天窗口、`limit=200`。
- 读取分页稳定：每页 200 桶、`missingBuckets=0`、`hasMore=true`。
- 索引：explain 命中 `uniq_nf_metric_bucket`。
- `totalDocsExamined` 未能从该驱动的 explain 结构解析（记录为 0），因此扫描量上限断言在未解析时不生效；索引命中是硬断言。

## 与计划的偏差

- 计划形状为「100 目标 × 10 series × 30 天」。当前实现只聚合注册批准的**单个无标签 series**（`process_resident_memory_bytes`），计数器也只有一个 family，因此回放按 1 series 执行。多 series 需要先扩展指标白名单，不是本次验收可以虚构的。
- Playwright 现场验收未执行：18888 上运行的是旧二进制，且验收需要已登录的现场栈。前端语义（键盘、焦点、双语、明暗主题、冲突草稿、URL 上下文、图表数据表）由 875 项组件与契约测试覆盖，但没有真实浏览器录制。

## 浏览器验收（Playwright + 真实栈）

现场默认关闭态（`http://192.168.64.128:13333`，admin 会话）：

- `/nf-health/<targetId>` 正常渲染，控制台无错误，**不出现**历史/偏离/趋势三个面板。
- `/nf-alerts` → 规则 → 添加规则：条件类型下拉只有 `["state","run_failed"]`，`metric_analysis` 未提供。
- 这与服务端一致：`meta.metricHistory.enabled=false`、`metric_analysis` 建规则返回 400 `NF_ALERT_ANALYSIS_DISABLED`。

启用态（确定性重放：录制现场 6 个真实响应，仅替换 meta 开关、指标历史与分析负载，并把目标采集配置置为 `http_metrics`）：

- 11 项断言全部通过：历史面板、P95 列、基线偏离面板、持续趋势面板、偏离行、已确认事件、待确认行、"不是故障概率"说明、两套策略版本号、weak_fit 原因；页面无异常。
- 截图：`detail-enabled.png`（历史表含 P95 列；偏离表显示 26.31 与"高于基线"；趋势区显示"已确认事件 1"）。

现场限制：本环境 23 个目标全部是 `process_only`，没有 `http_metrics` 目标，聚合 worker 不会访问它们，因此**无法用真实 exporter 数据**展示面板；启用态验收使用的是确定性重放负载，不是真实测量。

## 未覆盖的现场条件

真实 exporter 数据量、Mongo 部署规格（索引是否已 apply）、Nginx 边缘、以及聚合开关打开后的长时间运行表现。

## 现场演示环境（一次性，可回滚）

为验证真实采集→聚合链路，在本地栈上搭了一套演示环境：

- exporter：`.runtime/demo-exporter/exporter.py`，监听 `0.0.0.0:9101`，只暴露自身进程的 `process_resident_memory_bytes`、`process_start_time_seconds`、`process_open_fds`（真读 `/proc`）。
- `.env`：新增 `NF_HEALTH_ALLOWED_TARGETS=192.168.64.128:9101` 与 `NF_METRIC_AGGREGATES_ENABLED=true`；原文件备份为 `.env.bak.metric-demo`。
- Inventory：新增 `DEMO-EXPORTER`（network_function / 5gc / amf，labels.purpose=metric-assurance-acceptance）。原因是每个资源只能挂一个监测目标，且平台类资源不支持监测关联。
- 目标：`DEMO-EXPORTER RSS`（`ad205224-9d90-4982-8773-2959df664a9b`，http_metrics，60s，endpoint `http://192.168.64.128:9101/metrics`）。

现场结果：采集成功（sample 含三个指标，`thresholdPreview=measured`），worker 产出小时桶/日桶/counter 桶与分析记录；详情页三个面板正常渲染，分析显示 `insufficient_data / current_bucket_incomplete`（该小时无样本），趋势显示 `0 / 8` 与「待确认」。原始趋势图可见 15:09 起的真实采样点。

时间预期：第一个带真实样本的小时桶在 16:05 左右出现（15:00 小时闭合 + 5 分钟宽限）；基线偏离需要 48 小时中的 39 个合格小时，趋势需要连续两次同向评估，因此短期内仍是「数据不足」，这是设计预期而非故障。

回滚：`cp .env.bak.metric-demo .env`，停掉 exporter 进程，删除目标与 `DEMO-EXPORTER` 资源（或 retire），重启本地栈。

## 索引迁移执行记录

- 2026-11-22 15:2x，在本地 `xcloud_ops` 执行 `node scripts/migrate-nf-metric-aggregate-indexes.mjs --apply`：`READY` 三个集合，`ABSENT uniq_nf_metric_hour`（该库从未创建过旧索引），`NF_METRIC_AGGREGATE_INDEXES_READY`。
- 结果索引：`app_nf_metric_aggregates` = `_id_`, `uniq_nf_metric_bucket`(unique), `ttl_nf_metric_bucket`(ttl=0)；`app_nf_metric_analysis` = `_id_`, `nf_metric_analysis_read`, `ttl_nf_metric_analysis`(ttl=0)；`app_nf_health_targets` = `nf_metric_aggregate_targets`。
- 验证：同一读查询 `plan_index=uniq_nf_metric_bucket`，`examined=2 returned=2`；迁移后 worker 继续正常写入（5 个聚合文档 / 2 条分析记录）。

## 收尾验收（2026-11-22）

### 积压恢复（隔离 Mongo，确定性）

`TestMetricAggregateBacklogRecovery`：48 小时窗口内留出 12 小时连续缺口，其余 36 小时有真实采集证据。

```text
BACKLOG seeded=36 published=36 ticks=16 max_per_tick=3
```

- 每 tick 最多补 3 个小时，实测 `max_per_tick=3`，未越过预算。
- 16 tick 收敛：36 小时的理论下限是 12 tick，多出的 4 次是缺口槽位首次被尝试并标记（每次重试消耗一轮预算）。
- 修复前该测试无法收敛：永久缺口会一直占用预算，缺口之后的小时永远修不到。现在"无记录证据"的槽位被记忆 10 分钟并从规划中跳过。

### 分析读容量（真实 MongoDB）

`TestMetricAnalysisLoadBudget`：100 目标 × 720 小时 = 72,000 条分析记录，30 天窗口、`limit=200`。

```text
ANALYSIS_LOAD targets=100 hours=720 docs=72000 p50=78.2ms p95=115.6ms scanned=720 index=true
```

- 修复前 `kind: {$in: [...]}` 使查询退化为 COLLSCAN + 阻塞排序：`scanned=72000`。
- 改为精确 `kind` 后命中 `nf_metric_analysis_read`，只扫描窗口内的 720 条。

### 前端键盘、双语与主题（Playwright + 真实构建产物）

| 检查 | 结果 |
|---|---|
| 指标选择器可 Tab 到达 | ✅ `nf-metric-history-metric` |
| 下一站是范围选择器 | ✅ `nf-metric-history-range` |
| 焦点可见 | ✅ `box-shadow` 焦点环 + 主色描边（`rgb(11,109,122)`） |
| 数据表可键盘展开 | ✅ `details.open = true` |
| 中英切换 | ✅ 文案从「指标基线偏离」切到 "Metric baseline deviation" |
| 主题切换 | ✅ light → dark，面板仍渲染 |
| 控制台错误 | ✅ 无 |

### 仍未覆盖（环境或范围限制）

- 计划中的「100 目标 × 10 series」：实现只聚合单个无标签 series，多 series 需先扩指标白名单。
- 真实 exporter 的长周期表现（≥1 周影子观察、内存随时间的走势）：需要时间累积。
