# Scale Capacity Triggers

Status: active policy. The subscriber list, template counters and OCS list
projections keep their current implementations until one of the triggers below
is reached. This document is the authority for when a structural rewrite starts;
it does not authorize a rewrite early.

## Why triggers instead of an immediate rewrite

The subscriber list currently reads every matching subscriber, enriches the full
set with OCS contract/balance/plan data, then applies filters, facets and
pagination in memory. The template list caches its subscriber-count aggregation
for 30 seconds, and template bulk export/archive is a bounded client loop.
These implementations are accepted at the current ~10k subscriber population,
but they are O(N) per request and must not be carried indefinitely.

## Measured baseline

Benchmark (repository level, local MongoDB, Linux host Intel i5-9600K):

```bash
cd backend
GOTOOLCHAIN=go1.24.0 go test -run '^$' -bench BenchmarkSubscriberListRows \
  -benchtime=10x ./internal/subscriber
```

Measurement on 2026-10-30:

| Dataset | Time per list request | Allocations |
|---|---:|---:|
| 1,000 subscribers | ~38.8 ms | ~21.7 MB, ~226k allocs |
| 10,000 subscribers | ~307 ms | ~218.6 MB, ~2.26M allocs |

The benchmark seeds one subscriber, one active OCS contract and one balance per
IMSI, creates the declared production indexes, and calls
`ListSubscriberRowsFiltered` with `limit=50`. It excludes HTTP transport but
includes the fetch-all, enrichment, facet and in-memory pagination cost. The
10k result is already at the warning line: the current implementation is usable
at the current population but has little headroom.

## Trigger table

| Surface | Warning | Hard trigger | Required action when hard trigger is reached |
|---|---|---|---|
| Subscriber list | 10,000 subscribers, p95 detail-list latency > 300 ms, or > 200 MB allocated/request | 20,000 subscribers, p95 > 800 ms, or > 400 MB allocated/request | Replace the fetch-all path with server-side aggregation + keyset pagination; compute rows, facets and `summary` in the same filtered pipeline; keep `page`/`limit` as a compatibility path and add cursor fields. |
| Template subscriber counts | 500 templates or count aggregation p95 > 300 ms | 1,000 templates or p95 > 800 ms | Materialize or incrementally maintain per-template subscriber counts; do not extend the 30s cache window as the fix. |
| Template bulk export/archive | 500 templates or a selected batch > 100 | 1,000 templates or a selected batch > 250 | Move to a bounded server-side bulk operation with per-item result reporting; keep the current per-item failure report semantics. |
| Contract list summary | 100,000 contracts or p95 > 300 ms | 200,000 contracts or p95 > 800 ms | Cache the collection-wide lifecycle counts or maintain counters; keep the summary independent of list filters. |
| Balance list aggregation | 100,000 accounts or p95 > 300 ms | 200,000 accounts or p95 > 800 ms | Review the aggregation plan and the contract-status/plan index; consider a maintained effective-status field rather than a lookup per page. |
| Contract operation history | 100 operations/detail read or p95 > 200 ms | 500 operations/detail read or p95 > 500 ms | Move history to a paginated endpoint; the detail response keeps only the most recent bounded preview or drops the array. |

The latency and allocation thresholds require the benchmark above (for the
subscriber list) or an equivalent production measurement. Count thresholds are
checked by the read-only capacity script:

```bash
npm run check:scale
node scripts/check-scale-triggers.mjs --json
```

The script only reads collection counts; it never writes, creates indexes or
changes data. It exits `1` when a hard count trigger is reached and `2` when the
check itself cannot run.

## Index verification

The declared index set lives in `scripts/init-mongo-indexes.mjs`:

- `xcloud.subscribers`: unique `imsi`, `msisdn`
- `xcloud.ocs_subscribers`: unique `imsi`, `plan_id`, `msisdn`
- `xcloud.ocs_balances`: unique `imsi`, `updated_at` descending
- `xcloud_ops.app_profiles`: unique `name`

Run the read-only diagnosis before a scale test:

```bash
node scripts/check-mongo-query-performance.mjs
```

Observed on the 2026-10-30 lab database: the `subscribers` checks reported
`COLLSCAN` / `indexes=none`, which means the lab database had not been
initialized with the declared indexes. That is an operational finding, not a
reason to add indexes opportunistically in a read path. Apply the index
initialization during a maintenance window (it also performs OCS backfill) after
confirming its writes, or create the missing indexes through the approved
migration path. Do not create indexes from request handlers.

## Non-goals before a trigger

- Do not replace the subscriber list with aggregation or cursor pagination early.
- Do not materialize template counts before the template/subscriber trigger.
- Do not turn template bulk actions into a server batch early.
- Do not extend the 30s template-count cache as a substitute for materialization.
- Do not add ad-hoc indexes as part of an unrelated read-path change.
