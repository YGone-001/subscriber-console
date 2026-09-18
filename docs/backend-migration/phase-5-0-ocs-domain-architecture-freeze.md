# Phase 5.0 — OCS Management Domain Architecture Freeze

Date: 2026-09-17
Baseline: 8b2fa7a (develop)
Type: Architecture documentation only. No production code changes.

---

## 1. OCS Scope Redefinition

### 1.1 Management Plane (Phase 5 scope)

Included:

- Tariff plan CRUD (templates, rules, versions)
- OCS subscriber contract (billing relationship binding)
- Balance governance (credit/debit adjustment via approval)
- Operator actions (suspend/resume, plan assignment, migration)
- Audit trail for all management operations
- Approval workflow for all governed mutations

### 1.2 Charging Plane (Frozen / Excluded from Phase 5)

Excluded:

- Gy CCR-I/U/T (Diameter credit control)
- Ro CCR-I/U/T (Diameter roaming)
- SMS charging events
- Quota reservation engine
- Runtime sessions (active/closing/closed lifecycle)
- Rating engine (real-time rating decisions)
- Usage record creation (CDR pipeline)
- Balance runtime mutation (consumption, reservation)

These belong to the charging runtime. No HTTP migration path exists or is planned.

---

## 2. Retained MongoDB Collections

### 2.1 ocs_tariff_plans (xcloud)

**Purpose:** Tariff template management.

**Schema (derived from source):**

| Field | Type | Mutable | Notes |
|---|---|---|---|
| `_id` | ObjectId | no | Auto-generated |
| `plan_id` | string | no (immutable after create) | Primary key, 3-80 chars `[a-zA-Z0-9_-]` |
| `name` | string | yes | Display name |
| `description` | string | yes | |
| `status` | string | yes | `active` \| `disabled` |
| `quota_per_grant` | Long | yes | Default data quota per grant (bytes) |
| `validity_time` | number | yes | Default grant validity (seconds) |
| `volume_threshold` | Long | yes | Default volume threshold (bytes) |
| `unit` | string | derived | Always `bytes` for plan-level |
| `rules` | OcsTariffRule[] | yes (via rule CRUD) | Embedded array of tariff rules |
| `created_at` | Date | no | Set on create |
| `updated_at` | Date | auto | Set on every mutation |

**Tariff Rule Schema (embedded in `rules[]`):**

| Field | Type | Notes |
|---|---|---|
| `rule_id` | string | Composite: `{apn}_rg{rating_group}_si{service_identifier}` |
| `apn` | string | APN name (e.g. `internet`, `ims`) |
| `rating_group` | Long | Numeric rating group ID |
| `service_identifier` | Long | Service identifier |
| `charging_type` | string | `data_volume` \| `voice_time` \| `sms_event` \| `free` |
| `unit` | string | `bytes` \| `seconds` \| `events` |
| `quota_per_grant` | Long | Quota per grant |
| `validity_time` | number | Grant validity in seconds |
| `volume_threshold` | Long | Threshold for grant renewal |
| `priority` | number | Rule priority |
| `status` | string | `active` \| `disabled` |
| `currency` | string | Default `USD` |
| `rates` | string | Rate value |
| `rates_type` | number | 1=voice, 2=data, 3=sms, 4=data |

**Versioning strategy:** No explicit version field. `updated_at` is the mutation timestamp. Plan-level changes use `replaceOne`. Rule-level changes modify the embedded `rules[]` array within the plan document.

**Immutable fields:** `plan_id`, `created_at`.

---

### 2.2 ocs_subscribers (xcloud)

**Purpose:** OCS subscriber contract — the billing relationship, NOT the telecom subscriber profile.

**Schema:**

| Field | Type | Mutable | Notes |
|---|---|---|---|
| `_id` | ObjectId | no | |
| `imsi` | string | no (key) | 15-digit IMSI |
| `msisdn` | string | yes | Phone number |
| `status` | string | yes | `active` \| `suspended` |
| `plan_id` | string | yes | FK to `ocs_tariff_plans.plan_id` |
| `created_at` | Date | no | |
| `updated_at` | Date | auto | |

**Relationship:**

```
xcloud.subscribers (telecom profile)
    |
    | 1:1 via IMSI
    v
ocs_subscribers (billing contract)
    |
    | N:1 via plan_id
    v
ocs_tariff_plans (tariff template)
```

`xcloud.subscribers` owns the telecom profile. `ocs_subscribers` owns the billing relationship. They share IMSI as the join key but are independent documents with independent lifecycles.

---

### 2.3 ocs_balances (xcloud)

**Purpose:** Financial/quota balance governance.

**Schema:**

| Field | Type | Mutable | Notes |
|---|---|---|---|
| `_id` | ObjectId | no | |
| `imsi` | string | no (key) | 15-digit IMSI |
| `data_total` | Long | yes | Total data allocation (bytes) |
| `data_used` | Long | yes | Consumed data (bytes) |
| `data_reserved` | Long | yes | Currently reserved (bytes) |
| `data_available` | Long | yes | Available = total - used - reserved |
| `voice_total` | Long | yes | Total voice allocation (seconds) |
| `voice_used` | Long | yes | Consumed voice (seconds) |
| `voice_reserved` | Long | yes | Currently reserved (seconds) |
| `voice_available` | Long | yes | Available voice (seconds) |
| `sms_total` | Long | yes | Total SMS allocation (events) |
| `sms_used` | Long | yes | Consumed SMS (events) |
| `sms_available` | Long | yes | Available SMS (events) |
| `money_balance` | Long | yes | Monetary balance |
| `plan_id` | string | yes | Current tariff plan reference |
| `status` | string | yes | Balance status |
| `version` | Long | yes | CAS version for optimistic concurrency |
| `created_at` | Date | no | |
| `updated_at` | Date | auto | |
| `cycle_start_at` | Date | yes | Billing cycle start |
| `cycle_reset_at` | Date | yes | Last cycle reset |

**Invariants:**

```
data_total = data_used + data_reserved + data_available
voice_total = voice_used + voice_reserved + voice_available
sms_total = sms_used + sms_available
```

**Allowed mutations (management plane):**

- `credit` — increase total + available
- `debit` — decrease total + available (must not go below used + reserved)
- `set_total` — set total (must be >= used + reserved)
- `set_available` — set available (total adjusted to maintain invariant)
- `reset` — zero used/reserved, restore available = total

**Forbidden:**

- Direct silent modification (all mutations go through approval)
- `OCS_BALANCE_RESET` operation is disabled in governance registry

---

## 3. Frozen / Excluded Collections

### ocs_sessions (xcloud)

**Reason:** Runtime charging state. Managed by Diameter Gy/Ro stack. Read-only access from management plane for operational visibility.

**No API migration planned.**

### ocs_reservations (xcloud)

**Reason:** Quota reservation engine state. Managed by charging runtime.

**No API migration planned.**

### ocs_usage_records (xcloud)

**Reason:** Usage analytics / CDR domain. Created by charging pipeline.

**No API migration planned.**

### ocs_events (xcloud)

**Reason:** Charging event pipeline. Internal to runtime.

**No API migration planned.**

### ocs_config (xcloud)

**Reason:** Runtime charging configuration. Managed by operations tooling.

**No API migration planned.**

### ocs_reconciliation_anomalies (xcloud)

**Reason:** Billing reconciliation domain. Separate concern.

**No API migration planned.**

### ocs_balance_adjustments (xcloud_ops)

**Reason:** Adjustment ledger for audit. Used internally by `executeFrozenOcsBalanceAdjustment`. Not a migration target — it is infrastructure for governance execution.

---

## 4. RBAC Design

### Roles

| Role | Level | Description |
|---|---|---|
| `root` | 0 | System root. Direct governance on all operations. |
| `super_admin` | 1 | Full administrative access. Direct governance. |
| `ops_admin` | 2 | Operations administrator. Approval-governed. |
| `operator` | 3 | Standard operator. Approval-governed. |
| `auditor` | 4 | Read-only + audit access. |
| `viewer` | 5 | Read-only access. |

### Permission Matrix

| Permission | root | super_admin | ops_admin | operator | auditor | viewer |
|---|---|---|---|---|---|---|
| `ocs.tariff.read` | Y | Y | Y | Y | Y | Y |
| `ocs.tariff.write` | Y(direct) | Y(direct) | Y(approval) | Y(approval) | N | N |
| `ocs.subscriber.read` | Y | Y | Y | Y | Y | Y |
| `ocs.subscriber.write` | Y(direct) | Y(direct) | Y(approval) | Y(approval) | N | N |
| `ocs.balance.read` | Y | Y | Y | Y | Y | Y |
| `ocs.balance.adjust` | Y(direct) | Y(direct) | Y(approval) | Y(approval) | N | N |
| `ocs.plan.assign` | Y(direct) | Y(direct) | Y(approval) | Y(approval) | N | N |
| `ocs.rating.read` | Y | Y | Y | Y | Y | Y |
| `ocs.rating.write` | Y(direct) | Y(direct) | Y(approval) | Y(approval) | N | N |
| `ocs.runtime.execute` | N/A | N/A | N/A | N/A | N/A | N/A |

`root` and `super_admin` use DIRECT_GOVERNED (no approval required).
`ops_admin` and `operator` use APPROVAL_GOVERNED.
`ocs.runtime.execute` is internal to the charging runtime — no human caller.

---

## 5. Governance Model

Reuses the existing Phase 4 governance framework. No new governance system.

### Reused Components

- Actor validation (auth cookie → JWT → user/role)
- `createApprovalRequest` — creates approval with frozen payload
- Approval execute — executes frozen payload after approval
- Audit logging (`logAudit`)
- Fingerprint (before/after snapshots)
- CAS (optimistic concurrency via `version` field)
- Frozen payload schemas (`ocs-balance-adjustment-v1`, `ocs-tariff-plan-v1`, `ocs-tariff-rule-v1`)

### Governance Rules

| Operation | root/super_admin | ops_admin/operator |
|---|---|---|
| Tariff plan create | Direct execute | Approval required |
| Tariff plan update | Direct execute | Approval required |
| Tariff plan delete | Direct execute | Approval required |
| Tariff plan clone | Direct execute | Approval required |
| Tariff plan import | Direct execute | Approval required |
| Tariff plan migrate | Direct execute | Approval required |
| Tariff rule create | Direct execute | Approval required |
| Tariff rule update | Direct execute | Approval required |
| Tariff rule delete | Direct execute | Approval required |
| Tariff rule toggle | Direct execute | Approval required |
| Rating create | Direct execute | Approval required |
| Rating update | Direct execute | Approval required |
| Rating delete | Direct execute | Approval required |
| Balance adjust | Direct execute | Approval required |
| Balance reset | DISABLED | DISABLED |
| Plan assign (via subscriber policy) | Direct execute | Approval required |

### Snapshot Strategies

| Strategy | Used By | Description |
|---|---|---|
| `none` | Create operations | No pre-snapshot needed |
| `resource-version` | Update/delete operations | Captures before-state of resource |
| `balance-version` | Balance operations | CAS via `version` field |
| `migration-precondition` | Plan migration | Validates source/target state |

---

## 6. Migration Strategy

### Phase 5.1: OCS Read APIs

Migrate read-only endpoints to Go:

- `GET /api/ocs/balances`
- `GET /api/ocs/sessions`
- `GET /api/ocs/reservations`
- `GET /api/ocs/usage`
- `GET /api/tariff-plans`
- `GET /api/tariff-plans/{planId}`
- `GET /api/tariff-plans/{planId}/export`
- `GET /api/tariff-plans/{planId}/operations`
- `GET /api/tariff-plans/{planId}/rules`
- `GET /api/tariff-plans/{planId}/subscribers`
- `GET /api/tariff-plans/{planId}/migrate` (dry-run)
- `GET /api/ratings`
- `GET /api/ratings/{id}`

**Dependency:** None. Pure reads. Can start immediately.

### Phase 5.2: Tariff Plan Governance

Migrate tariff plan write endpoints:

- `POST /api/tariff-plans` (create)
- `PUT /api/tariff-plans/{planId}` (update)
- `DELETE /api/tariff-plans/{planId}` (delete)
- `POST /api/tariff-plans/{planId}/clone`
- `POST /api/tariff-plans/import`
- `POST /api/tariff-plans/{planId}/migrate`
- `POST /api/tariff-plans/{planId}/rules` (create rule)
- `PUT /api/tariff-plans/{planId}/rules/{ruleId}` (update rule)
- `PATCH /api/tariff-plans/{planId}/rules/{ruleId}` (toggle rule)
- `DELETE /api/tariff-plans/{planId}/rules/{ruleId}` (delete rule)

**Dependency:** Phase 5.1 (read must be migrated first for contract verification).

### Phase 5.3: OCS Subscriber Contract Governance

Migrate subscriber contract write endpoints:

- `POST /api/subscribers/{imsi}/profile` (already Go-owned, may need OCS contract updates)
- Policy change operations (plan assign, suspend/resume)

**Dependency:** Phase 5.2 (tariff plans must exist in Go for plan assignment).

### Phase 5.4: Balance Governance

Migrate balance write endpoints:

- `POST /api/subscribers/{imsi}/traffic-adjustments`

**Dependency:** Phase 5.1 (balance read must be migrated for before/after verification). Requires frozen payload execution chain in Go.

### Phase 5.5: Production Cutover

- Route-by-route cutover using CUTOVER_TABLE
- Rollback proof for each route
- Full parity validation

### Dependency Chain

```
5.1 (reads) ──> 5.2 (tariff writes) ──> 5.3 (subscriber contract)
                                         ──> 5.4 (balance)
                                                  ──> 5.5 (cutover)
```

5.3 and 5.4 can proceed in parallel after 5.2.

---

## 7. Rollback Strategy

### Management API Rollback (Go → Node)

Standard CUTOVER_TABLE rollback:

1. Change route owner from `'go'` to `'node'` in `CUTOVER_TABLE`
2. Rebuild Next.js
3. Verify Node-positive (request succeeds via Node)
4. Verify Go-negative (zero Go log entries for the route)

**Rollback time:** < 5 minutes (Next.js rebuild + restart).

### Database Rollback

No schema changes. Go and Node read/write the same collections with the same document structure. No migration rollback needed.

### Approval Rollback

Approvals created by Go remain valid if rolled back to Node. The `app_approvals` collection stores frozen payloads with schema versions. Both Node and Go use the same approval execution chain. Rollback does not orphan pending approvals.

### Audit Preservation

Audit records are append-only. Rollback does not affect existing audit entries. New entries will use the Node audit format after rollback.

### OCS Balance Adjustment Ledger

The `ocs_balance_adjustments` ledger (xcloud_ops) is append-only. Rollback preserves all adjustment evidence. Node's existing `adjustOcsTrafficBalance` uses direct CAS without the ledger — this is acceptable for rollback but loses the governance evidence chain.

---

## 8. Acceptance Criteria

- [x] OCS boundary defined (Management Plane vs Charging Plane)
- [x] Management plane separated (tariff, subscriber contract, balance governance)
- [x] Charging plane frozen (sessions, reservations, usage, events, config)
- [x] Collections classified (included vs excluded)
- [x] API inventory complete (27 endpoints documented)
- [x] UI architecture documented
- [x] RBAC matrix documented
- [x] Governance model documented
- [x] Migration order documented (5.1 → 5.2 → 5.3/5.4 → 5.5)
- [x] Rollback strategy documented

---

## 9. Files

| File | Status |
|---|---|
| `docs/backend-migration/phase-5-0-ocs-domain-architecture-freeze.md` | Created |
| `docs/backend-migration/phase-5-0-ocs-api-inventory.md` | Created |
| `docs/backend-migration/phase-5-0-ocs-ui-design.md` | Created |

No production code changes.
