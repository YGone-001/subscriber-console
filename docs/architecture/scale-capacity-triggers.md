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

Measurement on 2026-10-30, before the projection and typed-decode iterations
below:

| Dataset | Time per list request | Allocations |
|---|---:|---:|
| 1,000 subscribers | ~38.8 ms | ~21.7 MB, ~226k allocs |
| 10,000 subscribers | ~307 ms | ~218.6 MB, ~2.26M allocs |

The benchmark seeds one subscriber, one active OCS contract and one balance per
IMSI, creates the declared production indexes, and calls
`ListSubscriberRowsFiltered` with `limit=50`. It excludes HTTP transport but
includes the fetch-all, enrichment, facet and in-memory pagination cost. At the
original baseline the 10k result sat on the warning line; the current path
(~233 ms, ~187 MB) is back inside it, but the headroom is still one doubling of
the subscriber population away.

### Aggregation prototype gate (2026-10-30)

A first Mongo aggregation implementation matched the golden fixture field for
field, including filters, facets, pagination and MSISDN fallback, and reduced
allocation from ~218 MB to ~0.86 MB per request. It was **not adopted**: 10k
latency was ~536 ms versus ~307 ms for the current path, which fails the B4
performance gate. Profiling showed the per-subscriber OCS lookups (especially
the balance lookup) dominate; the plan lookup was replaced with a small plan
snapshot, but the result remained slower than the baseline. The prototype is
archived outside the repository; the next design must use bounded batch reads
or a different enrichment strategy and beat the baseline before replacing the
read path.

### Compact batch projection (2026-10-30)

The read path stopped loading full subscriber, contract and balance documents
for every match and projects only the fields the row and filters read. Measured
at 10k: ~262 ms, ~191 MB, ~1.71M allocs (original ~307 ms / ~218 MB / ~2.26M
allocs). The golden baseline passed unchanged. This iteration also dropped
`msisdnList` from the subscriber projection, which would have hidden the MSISDN
of a document that carries only the list form; the typed iteration restored it.

### Typed list documents (2026-10-30, current path)

The list now decodes the projected subscriber, contract, balance and plan
documents into fixed structs instead of `bson.M` maps, and one typed row builder
(`toSubscriberRow` in `backend/internal/subscriber/list_typed.go`) replaces the
map-based row, MSISDN, binding and last-active helpers. Fields stay loose (`any`,
or `bson.RawValue` where absent and explicit null must stay distinguishable) so
an unexpected stored type degrades to the same projection the map reader
produced instead of failing the whole list. Cursors are decoded into slices with
a known upper bound instead of `cursor.All`, which grows its result through
reflection and reallocates the whole slice repeatedly at this scale.

| Dataset | Original | Compact projection | Typed documents |
|---|---:|---:|---:|
| 1,000 subscribers | ~38.8 ms, ~21.7 MB, ~226k allocs | — | ~27.4 ms, ~18.1 MB, ~105k allocs |
| 10,000 subscribers | ~307 ms, ~218.6 MB, ~2.26M allocs | ~262 ms, ~191 MB, ~1.71M allocs | ~207 ms, ~185 MB, ~1.04M allocs |

Two correctness defects were fixed on the way, both confirmed against live data:

- `lastActive` dropped every stored BSON date. The driver decodes a date into
  int64 milliseconds, and the previous reader only accepted `time.Time` and RFC
  3339 strings, so the row silently fell back to the document identifier's
  creation instant or to empty. Live `xcloud` holds both shapes (8 subscribers
  with string timestamps, 2 with dates; 3 contracts and 1 balance with dates),
  and one live subscriber reported activity 38 days older than its balance
  account's own `updated_at`. Timestamps are now read as `bson.RawValue`, so a
  date is a date and an unrelated number is still not evidence.
- The legacy `msisdnList: [{msisdn}]` form never resolved. An embedded document
  inside an array decodes as `bson.D`, which the MSISDN reader did not accept, so
  such a subscriber showed the contract number instead of its own. No live
  document uses that form today; the reader now accepts it as documented.

The golden baseline was re-recorded for these two fixes and extended with a
`msisdnList`-only subscriber, a subscriber whose only MSISDN is on the contract,
an explicit-null `access_restriction_data`, a contract with an empty `plan_id`
and a balance without `data_available`. Every other row field is byte-identical
to the previous baseline.

Allocation floor: a memory profile attributes ~78% of the residual 10k bytes to
driver-internal decode buffers. `mongo.getDecoder` → `bson.NewDocumentReader` →
`bufio.NewReader` allocates a 4 KiB reader per decoded document, and one list
request decodes ~30k documents (10k subscribers + 10k contracts + 10k balances),
so ~144 MB of the ~185 MB is fixed by the decoded-document count and not by the
row structs (~8 MB) or the filters. The ~64 MB per-request target is therefore
unreachable through any client-side decoding change; it requires returning fewer
documents, which is the server-side aggregation rewrite the trigger table
already owns. That rewrite stays gated: at the current population the measured
latency and allocation are inside the warning line (~207 ms < 300 ms, ~185 MB <
200 MB), and the remaining byte headroom is documented as driver-owned rather
than row-owned.

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

The index-only migration is separate from the full initializer because
`init-mongo-indexes.mjs` also provisions OCS rows and backfills balances:

```bash
npm run mongo:indexes                 # dry-run: create / exists / equivalent / conflict
npm run mongo:indexes -- --json       # machine-readable plan
npm run mongo:indexes -- --apply      # maintenance window: create missing indexes only
```

It never performs a business write, refuses unique indexes when duplicate values
exist, and treats a same-key/different-name index as equivalent unless
`--replace-conflicting` is explicitly requested. The shared index definition is
`scripts/lib/mongo-business-indexes.mjs`; `init-mongo-indexes.mjs` consumes the
same spec.

Audit on 2026-10-30 (lab):

- `xcloud.subscribers`, `xcloud.ocs_subscribers`, `xcloud.ocs_balances` had only
  the `_id_` index.
- `xcloud_ops.app_profiles` had `uniq_profile_name` and
  `profile_updated_at_desc`.
- No duplicate values existed for `subscribers.imsi`, `ocs_subscribers.imsi`,
  `ocs_balances.imsi` or `app_profiles.name`.
- The index-only dry-run reported seven creates and no conflicts.
- The seven indexes were applied on 2026-10-30; a second dry-run reports
  `actions=0` (idempotent). `mongo:perf` now shows `IXSCAN` on
  `subscribers.page.sort_imsi`, `subscribers.search.imsi_prefix` and
  `subscribers.lookup.msisdn` (`subscriber_msisdn`).
- `subscribers.filter.profile` still uses `uniq_imsi`: the four-field template
  attribution predicate has no dedicated index. B0 will decide whether the
  aggregation path needs one; do not add it opportunistically.

`mongo:perf` before the migration reported `COLLSCAN` for subscriber page,
MSISDN lookup and profile filter queries. This is an operational finding, not a
reason to add indexes in a read path. Do not create indexes from request
handlers.

## Non-goals before a trigger

- Do not replace the subscriber list with aggregation or cursor pagination early.
- Do not materialize template counts before the template/subscriber trigger.
- Do not turn template bulk actions into a server batch early.
- Do not extend the 30s template-count cache as a substitute for materialization.
- Do not add ad-hoc indexes as part of an unrelated read-path change.
