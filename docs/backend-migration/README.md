# Backend Migration Documentation

> **Phase 0 — Baseline Freeze & Inventory**
> Branch: `develop` | Commit: `1f1cb3fb27c680cc280e898801ca219d445788bb` | Date: 2026-08-31

## Target Architecture

```
Browser → Nginx
           ├── /          → Next.js :3000 (React UI)
           └── /api/*     → Go Backend :8080 (REST API + MongoDB)
```

## Phase Plan

| Phase | Name | Scope |
|-------|------|-------|
| **0** | **Baseline Freeze** | **Inventory, documentation, contract freeze (THIS)** |
| 1 | Go Backend Foundation | Config, Mongo, health, HTTP, middleware |
| 2 | Read-only API Migration | 40 GET endpoints |
| 3 | Governance + Approval | Approval workflow, risk policy, executors |
| 4 | Subscriber + Profile Writes | 11 mutation endpoints |
| 5 | OCS + Tariff + Rating Writes | 14 mutation endpoints |
| 6 | Auth + User Management | 10 mutation endpoints |
| 7 | Alerts + Notifications | 7 mutation endpoints |
| 8 | Remove Next.js Backend | Clean up Node API layer |

## Documents

| Document | Description |
|----------|-------------|
| [Phase 0 Report](phase-0-report.md) | Executive summary, findings, risks, readiness |
| [API Inventory](api-inventory.md) | Complete route table: 63 files, 89 operations |
| [API Contract Baseline](api-contract-baseline.md) | Frozen request/response contracts |
| [Write Operation Inventory](write-operation-inventory.md) | All 48 mutations classified by governance mode |
| [Governance Inventory](governance-inventory.md) | Registry, risk policy, executor mapping |
| [Approval Chain](approval-chain.md) | Complete create→review→execute→audit flow |
| [MongoDB Collection Map](mongo-collection-map.md) | 20 collections across 2 databases |
| [Migration Routing Matrix](migration-routing-matrix.md) | Every API mapped to migration phase |
| [CNMS Reuse Matrix](cnms-reuse-matrix.md) | CNMS capability classification (UNVERIFIED) |
| [Generated API Routes JSON](generated/api-routes.json) | Machine-readable route inventory |

## Scanner Tool

```bash
node scripts/migration/inventory-api.mjs
```

Outputs `docs/backend-migration/generated/api-routes.json` with stable, sorted results.
Zero external dependencies — uses only Node.js built-ins.
