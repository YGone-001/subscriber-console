# Phase 5.2 — OCS Tariff Plan Governance

Status: COMPLETE
Commit: `78b016c`

## Summary

6 tariff plan write operations migrated to Go with approval governance.

## Operations

| Operation | Method | Path | Governance |
|---|---|---|---|
| Create | POST | /api/ocs/tariff-plans | APPROVAL → super_admin DIRECT |
| Update | PUT | /api/ocs/tariff-plans/{planId} | APPROVAL → super_admin DIRECT |
| Delete | DELETE | /api/ocs/tariff-plans/{planId} | APPROVAL → super_admin DIRECT |
| Clone | POST | /api/ocs/tariff-plans/{planId}/clone | APPROVAL → super_admin DIRECT |
| Enable | POST | /api/ocs/tariff-plans/{planId}/enable | APPROVAL → super_admin DIRECT |
| Disable | POST | /api/ocs/tariff-plans/{planId}/disable | APPROVAL → super_admin DIRECT |

## Implementation

- Tariff governance registry (5 operations, APPROVAL_GOVERNED base)
- Fresh actor revalidation before every mutation
- Rate limits: create=20/60, update=30/60, delete=20/60, clone=20/60, enable/disable=20/60
- Capability: `ocs.tariff.write`
- Error codes: TARIFF_PLAN_EXISTS, TARIFF_PLAN_NOT_FOUND, DEFAULT_TARIFF_PLAN_PROTECTED, TARIFF_PLAN_DISABLE_IN_USE, INVALID_PLAN_ID
- CUTOVER_TABLE: 12 → 18 routes

## Frontend

- Tariff list UI (`/ocs/tariffs`)
- KPI cards, table, enable/disable/clone/delete actions
- 14 i18n keys (en + zh)

## Validation

- Backend: gofmt, go vet, go build, go test all pass
- Cutover routing: all tests pass
- Migration inventory + validator: 0 errors
