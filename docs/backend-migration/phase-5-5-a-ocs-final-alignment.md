# Phase 5.5-A — OCS Management Final Alignment & UI Polish

Status: COMPLETE

## 1. Summary

Phase 5.5-A performs the final architectural alignment and UI polish for the OCS Management Plane across the three core operational domains:
1. **Tariff Plans** (`ocs_tariff_plans`, `/ocs/tariffs`)
2. **Contract Subscribers** (`ocs_subscribers`, `/ocs/contracts`)
3. **Balance Management** (`ocs_balances`, `/ocs/balances`, `/ocs/balances/[imsi]`)

This phase ensures complete maker-checker governance, CAS versioning, strict audit lineage, and pristine UI UX across all three management domains while keeping the Charging Plane strictly frozen.

---

## 2. Core Three-Domain Architecture

| Domain | Collection | Primary Route | Detail Route | Write Operations |
|---|---|---|---|---|
| **Tariff Plans** | `ocs_tariff_plans` | `/ocs/tariffs` | `/ocs/tariffs/[planId]` | Create, Update, Enable, Disable, Clone, Delete |
| **Contract Subscribers** | `ocs_subscribers` | `/ocs/contracts` | `/ocs/contracts/[imsi]` | Create, Update Tariff, Suspend, Resume, Terminate |
| **Balance Management** | `ocs_balances` | `/ocs/balances` | `/ocs/balances/[imsi]` | Adjust (Credit/Debit), Reset (Permanently Disabled) |

### Charging Plane Boundary (Strictly Frozen)
The following runtime charging resources and protocols remain strictly FROZEN with zero mutations or schema extensions:
- `ocs_sessions`
- `ocs_reservations`
- `ocs_usage_records`
- Diameter Gy / Ro protocol interfaces (`CCR`/`CCA`)
- Real-time rating engine

---

## 3. Production Ownership & Cutover Routing Invariant

The single-writer cutover routing table remains strictly preserved at:
```text
ACTUALLY_ROUTED = 26
```
No routes were added or modified in `CUTOVER_TABLE` in `frontend/src/lib/cutover-routing.ts`.
All 26 cutover routes remain authoritatively owned by Go (`owner: 'go'`).

### Governed Writers in Go:
- **Tariff Plan Governance (6 routes)**:
  - `POST /api/tariff-plans`
  - `PUT /api/tariff-plans/{planId}`
  - `DELETE /api/tariff-plans/{planId}`
  - `POST /api/tariff-plans/{planId}/clone`
  - `POST /api/tariff-plans/{planId}/enable`
  - `POST /api/tariff-plans/{planId}/disable`
- **OCS Subscriber Contract Governance (6 routes)**:
  - `GET /api/ocs/subscribers`
  - `POST /api/ocs/subscribers`
  - `PATCH /api/ocs/subscribers/{imsi}`
  - `POST /api/ocs/subscribers/{imsi}/suspend`
  - `POST /api/ocs/subscribers/{imsi}/resume`
  - `DELETE /api/ocs/subscribers/{imsi}`
- **OCS Balance Governance (2 routes)**:
  - `POST /api/ocs/balances/{imsi}/adjust`
  - `POST /api/ocs/balances/{imsi}/reset` (permanently disabled HTTP 400 `BALANCE_RESET_DISABLED`)

---

## 4. UI Polish & Component Enhancements

### 4.1 Tariff Plan Management (`/ocs/tariffs`)
- Added `TariffPlanModal.tsx` for creating new plans and editing existing plans.
- Integrated Create Plan action into `OcsTariffGovernancePanel.tsx`.
- Added inline row edit action (`Pencil` icon) in table.
- Connected `OcsTariffDetail.tsx` to `/api/tariff-plans/${planId}/operations` for operator and audit reference link.

### 4.2 Contract Subscriber Management (`/ocs/contracts`)
- Enforced canonical terminology: **Contract Subscriber** / **签约用户**.
- Added `Created Time` (`created_at`) column to `OcsContractsPanel.tsx`.
- Linked `OcsContractDetail.tsx` to `/api/audit?q=${imsi}&limit=1` for last action, operator, and audit link.
- Verified 0 forbidden runtime session/network charging fields displayed.

### 4.3 Balance Management & Detail View (`/ocs/balances`)
- Added `Version` column and detail link (`Eye` icon) to `OcsBalancePlaceholder.tsx`.
- Created dedicated route page `/ocs/balances/[imsi]` rendering `OcsBalanceDetail.tsx`.
- Visualized Data Bucket (Total, Used, Reserved, Available), Voice Bucket, and SMS Bucket.
- Displayed Governance Metadata: Version, Last Adjustment Time, Operator, Audit Reference link.
- Preserved strict invariant: zero trace of a Balance Reset button.

### 4.4 Localization (i18n)
- Added 28 new keys to both `frontend/src/lib/locales/zh.ts` and `frontend/src/lib/locales/en.ts`.
- Verified strict 1:1 key parity via `tests/i18nCompleteness.test.mjs`.

---

## 5. Acceptance Test Suite

Consolidated end-to-end acceptance suite: `scripts/test-ocs-management-suite.mjs`.
Verifies 20 critical assertions across 4 sections:
1. **Tariff Plan Governance Matrix**: Direct creation, Operator approval required, Update, Disable, Enable, Clone, Delete, Operations read.
2. **Contract Subscriber Governance Matrix**: Direct creation, Operator approval required, Suspend, Resume, Tariff change, Read & boundary integrity.
3. **Balance Governance Matrix**: Direct adjustment, Operator approval required, Reset disabled across 6 roles (root, super_admin, ops_admin, operator, auditor, viewer), Detail bucket & version read.
4. **System Invariants & Production Cutover Integrity**: `ACTUALLY_ROUTED = 26`, all cutover routes owned by Go.
