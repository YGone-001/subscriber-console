# Phase 5.0 — OCS API Inventory

Date: 2026-09-17
Baseline: 8b2fa7a

---

## Summary

Total OCS management endpoints: **27**
- Read endpoints: **13**
- Write endpoints: **14**
- Currently Node-owned: all 27 (none in CUTOVER_TABLE)

---

## Read Endpoints

| # | Method | Path | Purpose | Collection | Risk | Permission | Phase |
|---|---|---|---|---|---|---|---|
| 1 | GET | `/api/ocs/balances` | List OCS balances with pagination, filter, invariant check | ocs_balances, ocs_subscribers | low | requireAuth | 5.1 |
| 2 | GET | `/api/ocs/sessions` | List charging sessions with pagination, filter | ocs_sessions | low | requireAuth | 5.1 |
| 3 | GET | `/api/ocs/reservations` | List quota reservations with pagination, filter | ocs_reservations | low | requireAuth | 5.1 |
| 4 | GET | `/api/ocs/usage` | List usage/CDR records with pagination, filter | ocs_usage_records | low | requireAuth | 5.1 |
| 5 | GET | `/api/tariff-plans` | List all tariff plans with subscriber counts | ocs_tariff_plans, ocs_subscribers | low | requireAuth | 5.1 |
| 6 | GET | `/api/tariff-plans/{planId}` | Get single tariff plan detail with rules | ocs_tariff_plans, ocs_subscribers | low | requireAuth | 5.1 |
| 7 | GET | `/api/tariff-plans/{planId}/export` | Export tariff plan as JSON download | ocs_tariff_plans | low | requireAuth | 5.1 |
| 8 | GET | `/api/tariff-plans/{planId}/operations` | Tariff plan operations history (audit log) | ocs_tariff_plans, app_audit_logs | low | requireAuth | 5.1 |
| 9 | GET | `/api/tariff-plans/{planId}/rules` | List tariff rules with conflict detection | ocs_tariff_plans | low | requireAuth | 5.1 |
| 10 | GET | `/api/tariff-plans/{planId}/subscribers` | List subscribers on a tariff plan | ocs_subscribers | low | requireAuth | 5.1 |
| 11 | GET | `/api/tariff-plans/{planId}/migrate` | Dry-run migration preview | ocs_tariff_plans, ocs_subscribers | low | requireAuth | 5.1 |
| 12 | GET | `/api/ratings` | List rating policies (from tariff plan rules) | ocs_tariff_plans (via ratings) | low | requireAuth | 5.1 |
| 13 | GET | `/api/ratings/{id}` | Get single rating policy | ocs_tariff_plans (via ratings) | low | requireAuth | 5.1 |

### Read Endpoint Details

**Rate limits:**
- Balances: `ocs:balances:{user}`, 120/60
- Sessions: `ocs:sessions:{user}`, 120/60
- Reservations: `ocs:reservations:{user}`, 120/60
- Usage: `ocs:usage:{user}`, 120/60
- Tariff plans list: `tariff-plans:list:{user}`, 90/60
- Tariff plan detail: `tariff-plans:detail:{user}`, 120/60
- Tariff plan export: `tariff-plans:export:{user}`, 30/60
- Tariff plan operations: `tariff-plans:operations:{user}`, 90/60
- Tariff plan rules: `tariff-plans:rules:list:{user}`, 120/60
- Tariff plan subscribers: `tariff-plans:subscribers:{user}`, 120/60
- Tariff plan migrate preview: 120/60 (standard)
- Ratings list: `ratings:list:{user}`, 90/60
- Rating detail: `ratings:detail:{user}`, 120/60

**Auth:** All require `requireAuth` (valid JWT cookie).

**Response shapes:**
- Balances: `{ok, records[], total, page, limit, totalPages, summary}`
- Sessions: `{ok, records[], total, page, limit, totalPages, summary}`
- Reservations: `{ok, records[], total, page, limit, totalPages, summary}`
- Usage: `{ok, records[], total, page, limit, totalPages, summary}`
- Tariff plans list: `{plans: TariffPlanSummary[]}`
- Tariff plan detail: `{plan: TariffPlanSummary + rules}`
- Tariff plan export: `application/json` download
- Tariff plan operations: `{summary, history}`
- Tariff plan rules: `{plan_id, rules[], conflicts, count}`
- Tariff plan subscribers: `{total, subscribers[], hasMore}`
- Tariff plan migrate preview: `{preview: MigrationPreview}`
- Ratings list: `{ratings: RatingPolicy[]}`
- Rating detail: `{rating: RatingPolicy}`

---

## Write Endpoints

| # | Method | Path | Purpose | Collection | Risk | Permission | Governance | Phase |
|---|---|---|---|---|---|---|---|---|
| 14 | POST | `/api/tariff-plans` | Create tariff plan | ocs_tariff_plans | high | ocs.tariff.write | APPROVAL | 5.2 |
| 15 | PUT | `/api/tariff-plans/{planId}` | Update tariff plan | ocs_tariff_plans | high | ocs.tariff.write | APPROVAL | 5.2 |
| 16 | DELETE | `/api/tariff-plans/{planId}` | Delete tariff plan | ocs_tariff_plans | critical | ocs.tariff.write | APPROVAL | 5.2 |
| 17 | POST | `/api/tariff-plans/{planId}/clone` | Clone tariff plan | ocs_tariff_plans | high | ocs.tariff.write | APPROVAL | 5.2 |
| 18 | POST | `/api/tariff-plans/import` | Import tariff plan | ocs_tariff_plans | high | ocs.tariff.write | APPROVAL | 5.2 |
| 19 | POST | `/api/tariff-plans/{planId}/migrate` | Migrate subscribers between plans | ocs_subscribers, ocs_balances | critical | ocs.plan.assign | APPROVAL | 5.2 |
| 20 | POST | `/api/tariff-plans/{planId}/rules` | Create tariff rule | ocs_tariff_plans | high | ocs.tariff.write | APPROVAL | 5.2 |
| 21 | PUT | `/api/tariff-plans/{planId}/rules/{ruleId}` | Update tariff rule | ocs_tariff_plans | high | ocs.tariff.write | APPROVAL | 5.2 |
| 22 | PATCH | `/api/tariff-plans/{planId}/rules/{ruleId}` | Toggle tariff rule status | ocs_tariff_plans | high | ocs.tariff.write | APPROVAL | 5.2 |
| 23 | DELETE | `/api/tariff-plans/{planId}/rules/{ruleId}` | Delete tariff rule | ocs_tariff_plans | critical | ocs.tariff.write | APPROVAL | 5.2 |
| 24 | POST | `/api/ratings` | Create rating policy | ocs_tariff_plans (rules) | high | ocs.rating.write | APPROVAL | 5.2 |
| 25 | PUT | `/api/ratings/{id}` | Update rating policy | ocs_tariff_plans (rules) | high | ocs.rating.write | APPROVAL | 5.2 |
| 26 | DELETE | `/api/ratings/{id}` | Delete rating policy | ocs_tariff_plans (rules) | critical | ocs.rating.write | APPROVAL | 5.2 |
| 27 | POST | `/api/subscribers/{imsi}/traffic-adjustments` | Adjust balance | ocs_balances, ocs_balance_adjustments | high | ocs.balance.adjust | APPROVAL | 5.4 |

### Write Endpoint Details

**All write endpoints use the approval-governed pattern:**
1. Validate auth + permission
2. Rate limit
3. Validate request body
4. Create approval request with frozen payload
5. Audit log
6. Return `{outcome: 'approval_required', approval}` (HTTP 202)

**Exception:** `root` and `super_admin` bypass approval via DIRECT_GOVERNED mode.

**Governance operations:**
- Tariff plan CRUD: `OCS_TARIFF_PLAN_CREATE`, `OCS_TARIFF_PLAN_UPDATE`, `OCS_TARIFF_PLAN_DELETE`
- Tariff rule CRUD: `OCS_TARIFF_RULE_CREATE`, `OCS_TARIFF_RULE_UPDATE`, `OCS_TARIFF_RULE_DELETE`, `OCS_TARIFF_RULE_TOGGLE`
- Plan migration: `OCS_PLAN_MIGRATE`
- Rating CRUD: `OCS_RATING_CREATE`, `OCS_RATING_UPDATE`, `OCS_RATING_DELETE`
- Balance adjust: `OCS_BALANCE_ADJUST`

**Frozen payload schemas:**
- `ocs-tariff-plan-v1` — tariff plan create/update/delete
- `ocs-tariff-rule-v1` — tariff rule operations
- `ocs-balance-adjustment-v1` — balance adjustment (with CAS version)

---

## Source Files

| Route | Source File |
|---|---|
| `/api/ocs/balances` | `src/app/api/ocs/balances/route.ts` |
| `/api/ocs/sessions` | `src/app/api/ocs/sessions/route.ts` |
| `/api/ocs/reservations` | `src/app/api/ocs/reservations/route.ts` |
| `/api/ocs/usage` | `src/app/api/ocs/usage/route.ts` |
| `/api/tariff-plans` | `src/app/api/tariff-plans/route.ts` |
| `/api/tariff-plans/{planId}` | `src/app/api/tariff-plans/[planId]/route.ts` |
| `/api/tariff-plans/{planId}/clone` | `src/app/api/tariff-plans/[planId]/clone/route.ts` |
| `/api/tariff-plans/{planId}/export` | `src/app/api/tariff-plans/[planId]/export/route.ts` |
| `/api/tariff-plans/{planId}/operations` | `src/app/api/tariff-plans/[planId]/operations/route.ts` |
| `/api/tariff-plans/{planId}/rules` | `src/app/api/tariff-plans/[planId]/rules/route.ts` |
| `/api/tariff-plans/{planId}/rules/{ruleId}` | `src/app/api/tariff-plans/[planId]/rules/[ruleId]/route.ts` |
| `/api/tariff-plans/{planId}/subscribers` | `src/app/api/tariff-plans/[planId]/subscribers/route.ts` |
| `/api/tariff-plans/{planId}/migrate` | `src/app/api/tariff-plans/[planId]/migrate/route.ts` |
| `/api/tariff-plans/import` | `src/app/api/tariff-plans/import/route.ts` |
| `/api/ratings` | `src/app/api/ratings/route.ts` |
| `/api/ratings/{id}` | `src/app/api/ratings/[id]/route.ts` |
| `/api/subscribers/{imsi}/traffic-adjustments` | `src/app/api/subscribers/[imsi]/traffic-adjustments/route.ts` |

## Repository Files

| Repository | Purpose |
|---|---|
| `src/server/repositories/ocsBillingRepository.ts` | Tariff plans, OCS subscribers, balances, ratings, provisioning |
| `src/server/repositories/ocsOperationsRepository.ts` | Balance list, session list, usage list, reservation list |
| `src/server/ocsGovernanceRegistry.ts` | OCS operation definitions, governance modes |
| `src/server/ocsBalanceGovernance.ts` | Balance adjustment frozen payload, CAS execution |
| `src/server/repositories/ratingRepository.ts` | Legacy rating CRUD (thin wrapper over ocsBillingRepository) |
| `src/lib/tariffPlanOperations.ts` | Tariff plan utilities (validation, normalization, conflict detection) |
