# OCS Usage Record Write Contract

> Current-system integration contract for the OCS charging engine. The charging
> plane remains frozen and excluded from the xCloud management-plane APIs; this
> document only defines the storage projection required by business analysis.

## 1. Why this contract exists

The business-analysis page reads:

```text
xcloud.ocs_usage_records   per-request usage evidence (trend, Top 5)
xcloud.ocs_sessions        live session state and cumulative used_total
xcloud.ocs_balances        quota and balance invariants
```

A live OCS element can be processing Gy/Ro traffic while `ocs_usage_records`
remains stale. In that state `ocs_sessions.used_total` is current, but a 24-hour
trend and a time-window Top 5 cannot be reconstructed because the session
documents do not carry historical timestamps. The charging engine must persist
usage detail at the time each volume-bearing CCR is processed.

## 2. Collection

```text
database: xcloud
collection: ocs_usage_records
```

## 3. Required document fields

| Field | Type | Required | Semantics |
|---|---|---|---|
| `created_at` | BSON Date (UTC) or ISO-8601 string | yes | Observation/event time used for bucketing and window filters; the analytics projection normalizes both forms |
| `imsi` | string | yes | Subscriber identity |
| `session_id` | string | yes | Charging session identity |
| `apn` | string | no | APN for session distribution |
| `total_octets` | int64 | yes | Data volume reported by this CCR; non-negative |
| `input_octets` | int64 | no | Uplink volume if separately known |
| `output_octets` | int64 | no | Downlink volume if separately known |
| `cc_request_type` | string | no | `INITIAL`, `UPDATE`, `TERMINATION`, `EVENT` |
| `cc_request_number` | number | no | CCR sequence number |
| `charged` | boolean | no | Whether the record produced a charge |
| `rating_group` | number | no | Rating group |
| `service_identifier` | number | no | Service identifier |

`total_octets` must be the volume associated with the individual CCR, not the
session's cumulative total. Cumulative values belong on `ocs_sessions`.

The OCS engine documentation describes `created_at` as an ISO-8601 string while
the existing test fixtures store a BSON Date. The analytics projection accepts
both and excludes null or unparseable timestamps from the trailing window.

## 4. Write semantics

- Write on each volume-bearing `CCR-U` and `CCR-T`, not only when a session
  closes. Long-lived sessions otherwise produce no trend data.
- Use the charging engine's event time for `created_at`; do not use ingestion
  time unless event time is unavailable, and never write future timestamps.
- Do not write zero-value placeholders merely to keep the collection warm.
- Do not write subscriber credentials, MSISDN, SIP URI, or message payloads.

## 5. Idempotency and indexes

Recommended unique key:

```text
{ session_id: 1, cc_request_number: 1, cc_request_type: 1 }
```

Recommended indexes for the analytics reads:

```text
{ created_at: -1 }
{ imsi: 1, created_at: -1 }
```

Without the `created_at` index the 24-hour aggregation degrades to a collection
scan.

## 6. Verification

Run the read-only diagnostic from the repository root on the Linux host:

```bash
node scripts/check-ocs-usage-pipeline.mjs
```

The script checks both authorities:

- OCS Metrics HTTP at `OCS_METRICS_URL` (default `http://127.0.0.17:9090`):
  `/ocs-info`, `/usage-info?interface_type=gy|ro` (pager and latest record on
  the page), per-active-IMSI `/usage-info` samples, and usage/CCR metric lines;
- MongoDB `xcloud.ocs_usage_records` and `xcloud.ocs_sessions`, including the
  latest record, trailing-window count, active-session usage and Top 5.

Healthy output:

```text
usage_records_last_24h=<non-zero>
diagnosis=OK
```

If live sessions exist but the last 24 hours contain no usage records:

```text
diagnosis=NO_RECENT_USAGE_RECORDS
hint=Live sessions carry used_total, but the charging engine is not persisting CCR-U/T detail into ocs_usage_records.
```

The business-analysis page intentionally falls back to the live-session
authority in that state. It labels the result "当前会话用量" and does not claim a
24-hour trend. The fallback is not a substitute for the write contract.
