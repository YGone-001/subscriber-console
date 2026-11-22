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

## 未覆盖的现场条件

真实 exporter 数据量、Mongo 部署规格（索引是否已 apply）、Nginx 边缘、以及聚合开关打开后的长时间运行表现。
