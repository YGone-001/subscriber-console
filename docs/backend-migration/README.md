# Backend Migration Documentation

> **Current Phase: 5.1 COMPLETE**
> Branch: `develop`

## Target Architecture

```
Browser → Nginx
           ├── /*         → Next.js :13333 (React UI)
           └── /api/*     → Go :18888 (REST API + MongoDB)
```

Progressive route-by-route cutover. Frontend SWR paths unchanged.

## Phase Status

| Phase | Name | Status |
|-------|------|--------|
| 0 | Baseline Freeze & Inventory | ✅ COMPLETE |
| 1 | Go Backend Foundation | ✅ COMPLETE |
| 2A | Analytics + Audit + Ratings Read | ✅ COMPLETE |
| 2B | Profiles + OCS + Tariff Read | ✅ COMPLETE |
| 2C | Subscriber + Search Read | ✅ COMPLETE |
| 2D | Auth + User Read | ✅ COMPLETE |
| 3A | Security Audit Evidence Writer | ✅ COMPLETE |
| 3B | Audit Writer Lifecycle | ✅ COMPLETE |
| 3C | Approval Governance Read Foundation | ✅ COMPLETE |
| 3D | Explicit Approval Decision Endpoints | ✅ COMPLETE |
| 4.1 | Subscriber Single-Write Contract Gate | ✅ COMPLETE |
| 4.2-A | Subscriber Batch Create Governance | ✅ COMPLETE |
| 4.3 | Subscriber Single CRUD Cutover | ✅ COMPLETE |
| 4.4 | Subscriber Profile Apply Cutover | ✅ COMPLETE |
| 4.5 | Profile CRUD Cutover | ✅ COMPLETE |
| 4.6 | Subscriber Single CRUD Confirmed | ✅ COMPLETE |
| 4.7 | Subscriber Batch Cutover | ✅ COMPLETE |
| 5.0 | OCS Management Domain Architecture Freeze | ✅ COMPLETE |
| 5.1 | OCS Read API Migration & Management UI | ✅ COMPLETE |
| 5.2 | OCS Write Governance | ⬜ NOT STARTED |
| 6 | Auth + User Management | ⬜ NOT STARTED |
| 7 | Alerts + Notifications | ⬜ NOT STARTED |
| 8 | Remove Next.js Backend | ⬜ NOT STARTED |

## Current Metrics

```text
Go HTTP operations    = 52
  Semantic reads      = 35
  Governance mutations = 5
  Business mutations  = 12
CUTOVER_TABLE routes  = 12 (all ACTUALLY_ROUTED=1)
OCS writes            = NONE (read-only)
```

## Documents

| Document | Description |
|----------|-------------|
| [API Baseline](api-baseline.md) | Executive summary, findings, risks, readiness |
| [Write Operation Inventory](write-operation-inventory.md) | All mutations classified by governance mode |
| [Migration Routing Matrix](migration-routing-matrix.md) | Every API mapped to migration phase and owner |
| [OCS Domain Architecture Freeze](phase-5-0-ocs-domain-architecture-freeze.md) | OCS management vs charging plane boundary |
| [OCS API Inventory](phase-5-0-ocs-api-inventory.md) | 27 OCS endpoints (13 read, 14 write) |
| [OCS UI Design](phase-5-0-ocs-ui-design.md) | Dashboard, tariff, subscriber, balance UI |
| [Phase 4.5 Profile CRUD Cutover](phase-4.5-profile-crud-cutover.md) | Profile create/update/delete cutover |
| [Phase 4.6 Subscriber CRUD Cutover](phase-4.6-subscriber-crud-cutover.md) | Subscriber single CRUD cutover |
| [Phase 4.7 Batch Create Cutover](phase-4.7-subscriber-batch-create-cutover.md) | Subscriber batch create cutover |
| [Phase 4.7-B Batch Update Cutover](phase-4.7-b-subscriber-batch-update-cutover.md) | Subscriber batch update cutover |
| [Phase 4.7-C Import Cutover](phase-4.7-c-subscriber-import-cutover.md) | Subscriber import cutover |
| [Phase 4.7-D Bulk Delete Cutover](phase-4.7-d-subscriber-bulk-delete-cutover.md) | Subscriber bulk delete cutover |
| [Generated API Routes JSON](generated/api-routes.json) | Machine-readable route inventory |

## Scanner Tools

```bash
node scripts/migration/inventory-api.mjs      # scan all API routes
node scripts/migration/validate-inventory.mjs  # validate Go ↔ matrix consistency
```

Output: `docs/backend-migration/generated/api-routes.json`.
