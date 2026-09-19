# Phase 5.0 — OCS UI Design Freeze

Date: 2026-09-17
Baseline: 8b2fa7a

---

## 1. Dashboard

### Display

- Active OCS subscriber count (from `ocs_subscribers.count({status:'active'})`)
- Tariff plan count (from `ocs_tariff_plans.count()`)
- Pending approval count (OCS-related approvals)
- Recent governance actions (last 10 OCS audit entries)
- Balance adjustment summary (total data allocated, used, available across all subscribers)

### Do NOT Display

- CCR session count (runtime data)
- Reservation state (runtime data)
- Usage event volume (runtime data)
- Real-time charging throughput

### Data Source

- `GET /api/ocs/balances` (summary aggregation)
- `GET /api/tariff-plans` (plan count)
- `GET /api/approvals` (pending count, filtered by OCS actions)

---

## 2. Tariff Management UI

### 2.1 Tariff Plan List Page

**Route:** `/ocs/tariff-plans`

**Table columns:**

| Column | Source | Sortable |
|---|---|---|
| Plan ID | `plan_id` | Y |
| Name | `name` | Y |
| Status | `status` (`active`/`disabled`) | Y |
| Rules Count | `rulesCount` | Y |
| Subscriber Count | `subscriberCount` | Y |
| Updated Time | `updated_at` | Y (default) |
| Actions | view, clone, edit, enable/disable, version history | N |

**Filters:**
- Status (active / disabled / all)
- Search by plan_id or name

**Actions:**
- **View** → navigate to plan detail
- **Clone** → modal: target plan_id, name, description → approval
- **Edit** → navigate to plan edit form
- **Enable/Disable** → confirmation → approval
- **Version History** → navigate to operations tab

### 2.2 Tariff Plan Detail Page

**Route:** `/ocs/tariff-plans/{planId}`

**Tabs:**

1. **Overview** — plan metadata, status, quota defaults
2. **Rules** — embedded rule table
3. **Subscribers** — subscribers bound to this plan
4. **Operations** — audit history for this plan

**Rules sub-table:**

| Column | Source | Sortable |
|---|---|---|
| Rule ID | `rule_id` | N |
| APN | `apn` | N |
| Rating Group | `rating_group_id` | Y |
| Charging Type | `charging_type` | N |
| Quota/Grant | `quota_per_grant` | N |
| Validity | `validity_time` | N |
| Status | `status` | N |
| Actions | edit, toggle, delete | N |

**Rule actions:**
- **Edit** → inline or modal form
- **Toggle** → toggle active/disabled → approval
- **Delete** → confirmation → approval
- **Add Rule** → form: apn, rating_group_id, charging_type, quota_per_grant, validity_time, priority → approval

### 2.3 Tariff Plan Edit Form

**Route:** `/ocs/tariff-plans/{planId}/edit`

**Fields:**
- Name (text input)
- Description (textarea)
- Status (select: active / disabled)
- Quota per grant (number, bytes)
- Validity time (number, seconds)
- Volume threshold (number, bytes)

**Submit** → approval request

### 2.4 Tariff Plan Import

**Route:** `/ocs/tariff-plans/import` (modal or page)

**Fields:**
- JSON upload or paste
- Validation preview (conflicts, errors)
- Submit → approval request

### 2.5 Tariff Plan Migration

**Route:** `/ocs/tariff-plans/{planId}/migrate`

**Fields:**
- Target plan (select from active plans)
- Preview (dry-run: subscriber count, active/suspended breakdown)
- Submit → approval request

---

## 3. OCS Subscriber UI

### 3.1 OCS Subscriber List Page

**Route:** `/ocs/subscribers`

**Table columns:**

| Column | Source | Sortable |
|---|---|---|
| IMSI | `imsi` | Y |
| MSISDN | `msisdn` | N |
| Tariff Plan | `plan_id` | Y |
| Billing Status | `status` | Y |
| Data Balance | `data_available` / `data_total` | Y |
| Voice Balance | `voice_available` / `voice_total` | N |
| SMS Balance | `sms_available` / `sms_total` | N |
| Updated Time | `updated_at` | Y (default) |

**Filters:**
- IMSI search
- Plan filter (select from tariff plans)
- Status (active / suspended / all)

**Actions per row:**
- **View Balance** → navigate to balance detail
- **Change Tariff** → modal: select target plan → approval
- **Suspend** → confirmation → approval
- **Resume** → confirmation → approval

### 3.2 OCS Subscriber Detail Page

**Route:** `/ocs/subscribers/{imsi}`

**Sections:**

1. **Contract** — IMSI, MSISDN, plan, status, timestamps
2. **Balance Summary** — data/voice/sms totals, used, reserved, available (with progress bars)
3. **Active Sessions** — from `/api/ocs/sessions?imsi={imsi}` (read-only view)
4. **Recent Usage** — from `/api/ocs/usage?imsi={imsi}` (read-only view)

---

## 4. Balance UI

### 4.1 Balance List Page

**Route:** `/ocs/balances`

**Table columns:**

| Column | Source | Sortable |
|---|---|---|
| IMSI | `imsi` | Y |
| Plan | `plan_id` | N |
| Data Total | `data_total` | Y |
| Data Available | `data_available` | Y |
| Data Used | `data_used` | Y |
| Voice Total | `voice_total` | N |
| Voice Available | `voice_available` | N |
| SMS Total | `sms_total` | N |
| SMS Available | `sms_available` | N |
| Status | `status` | N |
| Invariant | `invariant_ok` (valid/broken) | N |
| Updated Time | `updated_at` | Y (default) |

**Filters:**
- IMSI search
- Plan filter
- Status filter
- Invariant filter (all / valid / broken)

**Summary bar (top):**
- Total subscribers
- Total data allocated
- Total data used
- Total data available

### 4.2 Balance Adjustment Form

**Triggered from:** Balance detail page → "Adjust Balance" button

**Form fields:**

| Field | Type | Required | Validation |
|---|---|---|---|
| Operation | select: `credit` / `debit` | Y | |
| Bucket | select: `data` / `voice` | Y | |
| Amount | number | Y | Positive integer |
| Reason | textarea | Y | 1-200 chars |
| Ticket ID | text | N | Max 100 chars |
| Maintenance Window Start | datetime | N | ISO 8601 |
| Maintenance Window End | datetime | N | ISO 8601 |

**Preview section:**
- Before snapshot (current balance)
- Expected after snapshot
- Delta visualization

**Submit** → approval request (HTTP 202)

**Root/Super Admin:** Direct execution (no approval required, but still shows preview).

---

## 5. Rating Management UI

### 5.1 Rating List Page

**Route:** `/ocs/ratings`

**Table columns:**

| Column | Source | Sortable |
|---|---|---|
| Rating Group ID | `rating_group_id` | Y |
| Plan | `plan_id` | N |
| APN | `apn` | N |
| Charging Type | `charging_type` | N |
| Currency | `currency` | N |
| Rates | `rates` | N |
| Status | `status` | N |
| Actions | edit, delete | N |

**Actions:**
- **Create** → form: rating_group_id, plan_id, apn, charging_type, quota_per_grant, etc. → approval
- **Edit** → modal form → approval
- **Delete** → confirmation → approval

---

## 6. Approval Center (OCS Integration)

The existing Approval Center at `/approvals` already handles OCS approvals. No new UI needed.

**OCS approval actions displayed:**
- `TARIFF_PLAN_CREATE`, `TARIFF_PLAN_UPDATE`, `TARIFF_PLAN_DELETE`
- `TARIFF_PLAN_RULE_CREATE`, `TARIFF_PLAN_RULE_UPDATE`, `TARIFF_PLAN_RULE_DELETE`, `TARIFF_PLAN_RULE_TOGGLE`
- `TARIFF_PLAN_MIGRATE`
- `RATING_CREATE`, `RATING_UPDATE`, `RATING_DELETE`
- `TRAFFIC_ADJUSTMENT`
- `POLICY_CHANGE`

---

## 7. Navigation Structure

```
OCS Management
├── Dashboard          /ocs/dashboard
├── Tariff Plans       /ocs/tariff-plans
│   ├── List           /ocs/tariff-plans
│   ├── Detail         /ocs/tariff-plans/{planId}
│   ├── Edit           /ocs/tariff-plans/{planId}/edit
│   ├── Import         /ocs/tariff-plans/import
│   └── Migrate        /ocs/tariff-plans/{planId}/migrate
├── OCS Subscribers    /ocs/subscribers
│   ├── List           /ocs/subscribers
│   └── Detail         /ocs/subscribers/{imsi}
├── Balances           /ocs/balances
│   ├── List           /ocs/balances
│   └── Adjust         /ocs/balances/{imsi}/adjust
└── Ratings            /ocs/ratings
    ├── List           /ocs/ratings
    └── Detail         /ocs/ratings/{id}
```

---

## 8. Design Constraints

- No new hardcoded `#hex` / `rgb()` / `rgba()` values
- Use existing Tailwind design tokens
- 4px spacing baseline
- State semantics: `active` = green, `disabled` = gray, `suspended` = amber
- Balance invariant broken = red indicator
- All user-visible text in Chinese and English (locale sync)
- Responsive: minimum 1024px viewport for tables

---

## 9. Phase 5.3-B-Correction-2 Scope Consolidation (Tariff Management)

**Date:** 2026-09-19  
**Decision:** Consolidate OCS frontend from broad "OCS Operations Governance" into narrow "Tariff Management" console.

### Final Information Architecture

The Tariff Management frontend consists of **exactly three primary management surfaces**:

```text
Tariff Management (Tariff 管理)
├── 1. Tariff Plans (/ocs/tariffs)           -> backs ocs_tariff_plans
├── 2. Contract Subscribers (/ocs/contracts) -> backs ocs_subscribers
└── 3. Balance Management (/ocs/balances)    -> backs ocs_balances
```

### Key Clarifications:
1. **Global Governance Unchanged**: Approvals (`/approvals`) and Audit Logs (`/audit-logs`) remain platform-wide capabilities within Operations Governance. They are not duplicate OCS/Tariff pages. Tariff operations link inline to `/approvals` upon approval request creation.
2. **Charging Plane UI Frozen**: Runtime sessions (`ocs_sessions`), reservations (`ocs_reservations`), usage records (`ocs_usage`), Gy/Ro CCR state, and rating-engine navigation are removed from product navigation and remain internal/frozen. Legacy routes redirect cleanly to `/ocs/tariffs`.
3. **Balance Mutations Read-Only Until Phase 5.4**: Governed balance mutations are scheduled for Phase 5.4.

