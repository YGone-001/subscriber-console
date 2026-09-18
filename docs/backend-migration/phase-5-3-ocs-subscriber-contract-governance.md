# Phase 5.3 — OCS Subscriber Contract Governance

Status: COMPLETE
Commit: `c869f33`

## Summary

5 subscriber contract write operations migrated to Go with approval governance.

Collection: `ocs_subscribers` (NOT `xcloud.subscribers`)

## Operations

| Operation | Method | Path | Governance |
|---|---|---|---|
| Create contract | POST | /api/ocs/subscribers | APPROVAL → super_admin DIRECT |
| Update tariff | PATCH | /api/ocs/subscribers/{imsi} | APPROVAL → super_admin DIRECT |
| Suspend | POST | /api/ocs/subscribers/{imsi}/suspend | APPROVAL → super_admin DIRECT |
| Resume | POST | /api/ocs/subscribers/{imsi}/resume | APPROVAL → super_admin DIRECT |
| Terminate | DELETE | /api/ocs/subscribers/{imsi} | APPROVAL → super_admin DIRECT |

## Implementation

- Subscriber governance registry (5 operations, APPROVAL_GOVERNED base)
- Fresh actor revalidation before every mutation
- Tariff dependency validation: target tariff must exist and be active
- IMSI validation: 15-digit regex
- Rate limits: 20/60 each
- Capability: `ocs.subscriber.write`
- Error codes: OCS_SUBSCRIBER_EXISTS, OCS_SUBSCRIBER_NOT_FOUND, OCS_TARIFF_NOT_FOUND, OCS_TARIFF_DISABLED, OCS_INVALID_IMSI, OCS_PLAN_ID_REQUIRED
- Approval resource type: `ocs_subscriber`, payload schema: `ocs-subscriber-v1`
- CUTOVER_TABLE: 18 → 23 routes

## Frontend

- OCS Subscribers panel (`/ocs/subscribers`)
- Action buttons: Suspend, Resume, Change Tariff, Terminate
- Conditional display (Suspend for active, Resume for suspended)
- Confirmation dialogs, feedback banner
- 7 i18n keys (en + zh)

## Validation

- Backend: gofmt, go vet, go build, go test all pass
- Cutover routing: 64/64 tests pass
- Migration inventory + validator: 0 errors
- Frontend: typecheck, tests, build all pass
