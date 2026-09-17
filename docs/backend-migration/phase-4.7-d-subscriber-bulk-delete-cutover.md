# Phase 4.7-D — Subscriber Bulk Delete Cutover

## Route

`POST /api/subscribers/bulk-delete`

## Date

2026-09-17

## Contract Freeze

**Node:** `src/app/api/subscribers/bulk-delete/route.ts`

- Permission: `subscriber_write`
- Rate limit: `subscribers:bulk-delete:${user}`, 10/60 per user
- Request: `{imsiList: string[]}` — only `imsiList` allowed as top-level key
- Output: `{success, message, outcome, requiresApproval, result: {deleted, deletedImsis, ocsCleanupFailedImsis, requested}}`

**Go:** `backend/internal/subscriber/handler_write.go` line 1393

- Permission: `subscriber_write` (same)
- Rate limit: `subscribers:bulk-delete:${username}`, 10/60 (same)
- Request: `ValidateBulkDeleteRequest` — only allows `imsiList` (same)
- Output: FrozenBulkDeleteV2 contract (same)

**Differences:** None significant. Both use DIRECT_GOVERNED for super_admin/root.

## Go-Positive Evidence

- HTTP 200: `{"message":"Subscribers deleted successfully","outcome":"executed","result":{"deleted":1}}`
- Go log: `POST /api/subscribers/bulk-delete status=200 request_id=cd1b4923040034e7ad1c504df64dc415`
- MongoDB: subscriber deleted (count=0)
- OCS: cleaned up (count=0)
- Audit: action=subscriber.batch.delete, outcome=direct_governed, status=success

## Rollback Proof

- Temporarily set CUTOVER_TABLE entry to `owner: 'node'`
- Node-positive verified: HTTP 200 via Node
- Go-negative verified: zero Go log entries for bulk-delete
- Restored to `owner: 'go'`
- Go-positive restored: HTTP 200 via Go, Go log confirmed

## Final State

- CUTOVER_TABLE: 12 routes total, bulk-delete = 'go'
- Routing test: 38/38 passing
- Migration matrix: ACTUALLY_ROUTED=1
