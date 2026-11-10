# Operations Reports

Status: implemented in source. `/ops-reports` is a read-only evidence workspace.
It does not create a telemetry warehouse or background report job.

## Ownership and query

`backend/internal/opsreports` reads only the Ops handle from the existing Mongo
client. It composes Inventory references, NF alert instances, accepted NF Health
samples, configuration observation metadata and remote Agent latest records.
It does not contact NFs, collect files, expose configuration content or mutate
any collection. Browser identity remains the existing cookie session.

The four Go-owned GET APIs are `/api/ops-reports/summary`, `/alerts`, `/metrics`
and `/export`. They require `core.read`, have per-user rate limits and share a
ten-second request context. Export supports alerts, metrics or config sections.

Queries default to the last 24 hours. Relative `period=1h|24h|7d` windows are
anchored to the server clock and cannot be combined with `from` or `to`. The
response returns resolved timestamps; detail and export requests reuse those
timestamps. Explicit windows use `[from,to)`, positive duration, a maximum of
seven days and no future end. API times are UTC; the UI
formats them in the client's locale/time zone. Queries may use a canonical
resource UUID, current Inventory domain and alert severity. An unsupported filter
makes a section explicitly unavailable; it never introduces unfiltered platform
counts inside a resource-scoped report. Domain lookup is bounded to 1000 UUIDs.
Domains describe current Inventory association, not historical ownership.

## Statistical meaning

- New alerts use `firstTriggeredAt`; confirmations use `acknowledgedAt`; closures
  use `resolvedAt`. An instance's cumulative `triggerCount` is not a window count.
- Trigger-to-acknowledgement delay and trigger-to-close delay use valid timestamps
  with explicit sample counts. Closure durations are separated by reason. Manual
  closure and rule deletion are not assertions of measured network recovery.
- Current unresolved alerts are labelled as the queue at generation time. The
  implementation cannot reconstruct a past end-of-window queue.
- Monitoring statistics retain target, resource, metric, type, unit, category and
  approved label scope. Unknown label scopes are excluded rather than merged.
  Finite counter values retain cumulative last/min/max meaning; their mean is
  null. Gauge means apply only within the same metric scope.
- Samples expose count and first/last time, not a fabricated continuous coverage
  ratio. NF Health retention still defaults to seven days. The report neither
  extends retention nor interprets missing samples as healthy or zero.
- Configuration events use collection/observation time, not an unknown actual
  modification time. Their rows contain metadata, not configuration fields.
- Agent counts describe remote collectors now and exclude the local controller.
  Latest records do not establish historical uptime or historical operator scope.

Each section has `complete|partial|unavailable`, a scope, reason and nullable data.
Invalid/missing timestamps and excluded metric observations are counted explicitly.
An empty successful query means no matching retained evidence; it does not prove
service health. A failed source never becomes a zero-filled section.

## Pagination, export and consistency

Summaries are collection-wide for their filter and do not come from a browser
page. Detail uses stable row identities and cursors, with 50 rows by default and
200 maximum. Materialised detail is bounded to 10000 records/series; an exceeded
budget requires narrower filters and is not silently truncated.

CSV is buffered and checked before response headers, with maximum 10000 rows and
10 MiB. It shares query/field semantics with the JSON report, preserves nulls,
escapes quotes/newlines/Unicode, and protects spreadsheet formula prefixes,
including prefixes preceded by whitespace/control characters. Typed numeric
measurements remain numeric. Generation time, resolved window, source scope,
coverage reason and all three active filters accompany each exported row.
Cancellation is
propagated. Unavailable sources are rejected instead of producing a fake empty
download. An empty valid export includes its scope and no-matching-records marker.

Cross-collection reads are eventually consistent. A CSV request is generated
independently and records its own generation time and window. It is not claimed
to be the identical database snapshot used by a previous screen refresh.

`PERFORMANCE_FINDING`: alert/sample timestamps currently include legacy strings.
The aggregations convert them without changing existing collections or creating
indexes during reads. This can scan a scoped collection rather than use a native
date range index. Ten-second execution, 1000-resource and detail/export budgets
bound the request; representative production query latency and execution plans
remain deployment validation inputs. The implementation does not claim a
production-scale performance benchmark from the isolated fixtures.

## Exclusions

No SLA/service-availability percentage, network MTTR, AI prediction, automatic
root cause, roaming agreement, historical tenant ownership or historical Agent
availability is computed. The feature does not change subscribers, OCS, alert
lifecycle, Inventory, NF Health, notification delivery or Agent machine protocols.
