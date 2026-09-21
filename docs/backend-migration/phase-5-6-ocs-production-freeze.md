# Phase 5.6 — OCS Production Freeze & Documentation Closure

Status: FROZEN

## 1. Executive Summary

Phase 5.6 formally freezes the **OCS Management Plane** following the completion and verification of Phase 5.5-A.
All production ownership, maker-checker governance workflows, CAS version preconditions, strict audit accounting, and single-writer cutover routing tables are permanently established and verified.

The OCS Management Plane encompasses exactly three operational domains:
1. **Tariff Plans** (`ocs_tariff_plans`, `/ocs/tariffs`)
2. **Contract Subscribers** (`ocs_subscribers`, `/ocs/contracts`)
3. **Balance Management** (`ocs_balances`, `/ocs/balances`)

The runtime **Charging Plane** remains strictly **FROZEN** and excluded from all administrative mutations.

---

## 2. Phase 5 Evolution Timeline

| Milestone | Scope & Deliverables | Routing / Ownership Impact | Status |
|---|---|---|---|
| **Phase 5.0** | OCS domain architecture freeze, inventory categorization, boundary separation | Routing baseline established | COMPLETE |
| **Phase 5.1** | OCS read API migration to Go, initial management UI layout | Pure read endpoints migrated | COMPLETE |
| **Phase 5.2** | Tariff plan governance in Go: Create, Update, Delete, Clone, Enable, Disable | 6 routes cut over to Go (`ACTUALLY_ROUTED = 18`) | COMPLETE |
| **Phase 5.3** | OCS subscriber contract governance in Go: Create, Update Tariff, Suspend, Resume, Terminate | 5 routes cut over to Go (`ACTUALLY_ROUTED = 23`) | COMPLETE |
| **Phase 5.3-B** | Tariff management UI consolidation, navigation deduplication, dashboard metrics correction | Routing table untouched (`ACTUALLY_ROUTED = 24`) | COMPLETE |
| **Phase 5.4** | OCS balance governance implementation: CAS versioning, strict audit, disabled reset | Shadow implementation in Go | COMPLETE |
| **Phase 5.4-B** | OCS balance controlled production cutover: adjust & reset routes | 2 routes cut over to Go (`ACTUALLY_ROUTED = 26`) | COMPLETE |
| **Phase 5.5-A** | OCS management final alignment & UI polish, dedicated balance detail view, suite consolidation | Routing table untouched (`ACTUALLY_ROUTED = 26`) | COMPLETE |
| **Phase 5.6** | Production baseline freeze, runbook publication, documentation closure | Baseline frozen (`ACTUALLY_ROUTED = 26`) | **FROZEN** |

---

## 3. Final Production Architecture

```text
Browser (Chrome / Edge / Firefox)
   │
   │  HTTPS / HTTP :13333
   ▼
Frontend (Next.js 16 App Router + React 19)
   │
   │  Reverse Proxy / Ingress Filter (proxy.ts)
   │  - Resolves route against CUTOVER_TABLE
   │  - Validates session & role from JWT cookie
   │  - Forwards cutover requests directly to Go
   ▼
Go Backend (:18888, Go 1.24+ standard library ServeMux)
   │
   │  - Middleware: Auth, CORS, RequestID, RateLimiter, Recovery
   │  - Governance: Fresh Actor revalidation, Maker-Checker evaluator
   │  - Invariants: Execution CAS versioning, Replay protection
   │  - Audit: Strict synchronous audit logging (WriteStrict)
   ▼
MongoDB (Two databases on one client)
   ├── xcloud       (Core telecommunications & OCS data)
   └── xcloud_ops   (Governance, users, approvals, audit logs)
```

---

## 4. Managed Collections Specification

### 4.1 `ocs_tariff_plans` (xcloud)
- **Purpose**: Master tariff plan templates governing charging parameters, quota grants, validity windows, and rating rules.
- **Key Fields**:
  - `plan_id` (string, unique key, e.g. `plan_default_10gb`)
  - `name` (string, localized plan title)
  - `description` (string, operational notes)
  - `status` (string, `active` | `disabled`)
  - `version` (int64, incremented on every governed change)
  - `quota_per_grant` (int64, bytes allocated per grant cycle)
  - `validity_time` (int64, validity duration in seconds)
  - `volume_threshold` (int64, warning threshold in bytes)
  - `created_at`, `updated_at`, `updated_by`

### 4.2 `ocs_subscribers` (xcloud)
- **Purpose**: Subscriber billing contracts establishing binding between an IMSI/MSISDN identity and an active tariff plan.
- **Separation**: Completely separate from `xcloud.subscribers` (which manages HSS/EPC network authentication vectors and AMBR).
- **Key Fields**:
  - `imsi` (string, 15-digit E.212 identity, unique key)
  - `msisdn` (string, E.164 phone identity)
  - `plan_id` (string, foreign key referencing `ocs_tariff_plans.plan_id`)
  - `status` (string, `active` | `suspended` | `terminated`)
  - `created_at`, `updated_at`, `updated_by`

### 4.3 `ocs_balances` (xcloud)
- **Purpose**: Subscriber resource balances tracking real-time allocated quotas across data, voice, and SMS buckets.
- **Conservation Invariant**:
  - Data: `data_total == data_used + data_reserved + data_available`
  - Voice: `voice_total == voice_used + voice_reserved + voice_available`
  - SMS: `sms_total == sms_used + sms_available`
- **Key Fields**:
  - `imsi` (string, unique key)
  - `data_total`, `data_used`, `data_reserved`, `data_available` (int64 bytes)
  - `voice_total`, `voice_used`, `voice_reserved`, `voice_available` (int64 seconds)
  - `sms_total`, `sms_used`, `sms_available` (int64 count)
  - `version` (int64, atomic CAS precondition token)
  - `status` (string, `active` | `frozen`)
  - `created_at`, `updated_at`

---

## 5. Frozen Charging Plane Boundary

The runtime Charging Plane is strictly **FROZEN** and excluded from all console management operations:

| Resource / Protocol | Status | Justification |
|---|---|---|
| `ocs_sessions` | FROZEN | Runtime Gy/Ro active session state machine |
| `ocs_reservations` | FROZEN | Ephemeral quota reservation leases held by PCEF/NEF |
| `ocs_usage_records` | FROZEN | High-frequency CDR / CCR charging event stream |
| `ocs_events` | FROZEN | Real-time signaling event bus |
| `ocs_config` | FROZEN | Diameter protocol stack configuration |
| Diameter Gy / Ro | FROZEN | 3GPP RFC 4006 / TS 32.299 network protocol interfaces |
| Rating Engine | FROZEN | Real-time rating matrix calculations |
| Reservation Engine | FROZEN | Quota reservation lifecycle management |

Active console navigation and UI routes are permanently barred from displaying or mutating runtime charging entities.

---

## 6. Frozen OCS API Inventory

All production OCS endpoints are cataloged below with their authoritative owner, governance mode, permission, and storage target:

| Endpoint | Method | Owner | Governance Mode | Required Permission | Collection Impact |
|---|---|---|---|---|---|
| `/api/tariff-plans` | GET | Node | Read | `ocs.tariff.read` | `ocs_tariff_plans` |
| `/api/tariff-plans/{planId}` | GET | Go | Read | `ocs.tariff.read` | `ocs_tariff_plans` |
| `/api/tariff-plans/{planId}/operations` | GET | Go | Read | `ocs.tariff.read` | `app_audit_logs` |
| `/api/tariff-plans` | POST | **Go** | DIRECT (root, super_admin) / APPROVAL (operator, ops_admin) | `ocs.tariff.write` | `ocs_tariff_plans` |
| `/api/tariff-plans/{planId}` | PUT | **Go** | DIRECT (root, super_admin) / APPROVAL (operator, ops_admin) | `ocs.tariff.write` | `ocs_tariff_plans` |
| `/api/tariff-plans/{planId}` | DELETE | **Go** | DIRECT (root, super_admin) / APPROVAL (operator, ops_admin) | `ocs.tariff.write` | `ocs_tariff_plans` |
| `/api/tariff-plans/{planId}/clone` | POST | **Go** | DIRECT (root, super_admin) / APPROVAL (operator, ops_admin) | `ocs.tariff.write` | `ocs_tariff_plans` |
| `/api/tariff-plans/{planId}/enable` | POST | **Go** | DIRECT (root, super_admin) / APPROVAL (operator, ops_admin) | `ocs.tariff.write` | `ocs_tariff_plans` |
| `/api/tariff-plans/{planId}/disable` | POST | **Go** | DIRECT (root, super_admin) / APPROVAL (operator, ops_admin) | `ocs.tariff.write` | `ocs_tariff_plans` |
| `/api/ocs/subscribers` | GET | **Go** | Read | `ocs.subscriber.read` | `ocs_subscribers` |
| `/api/ocs/subscribers` | POST | **Go** | DIRECT (root, super_admin) / APPROVAL (operator, ops_admin) | `ocs.subscriber.write` | `ocs_subscribers` |
| `/api/ocs/subscribers/{imsi}` | PATCH | **Go** | DIRECT (root, super_admin) / APPROVAL (operator, ops_admin) | `ocs.subscriber.write` | `ocs_subscribers` |
| `/api/ocs/subscribers/{imsi}/suspend` | POST | **Go** | DIRECT (root, super_admin) / APPROVAL (operator, ops_admin) | `ocs.subscriber.write` | `ocs_subscribers` |
| `/api/ocs/subscribers/{imsi}/resume` | POST | **Go** | DIRECT (root, super_admin) / APPROVAL (operator, ops_admin) | `ocs.subscriber.write` | `ocs_subscribers` |
| `/api/ocs/subscribers/{imsi}` | DELETE | **Go** | DIRECT (root, super_admin) / APPROVAL (operator, ops_admin) | `ocs.subscriber.write` | `ocs_subscribers` |
| `/api/ocs/balances` | GET | Node | Read | `ocs.balance.read` | `ocs_balances` |
| `/api/ocs/balances/{imsi}` | GET | Go | Read | `ocs.balance.read` | `ocs_balances` |
| `/api/ocs/balances/{imsi}/adjust` | POST | **Go** | DIRECT (root, super_admin) / APPROVAL (operator, ops_admin) | `ocs.balance.adjust` | `ocs_balances` |
| `/api/ocs/balances/{imsi}/reset` | POST | **Go** | PERMANENTLY DISABLED (HTTP 400 `BALANCE_RESET_DISABLED`) | Any | Zero Mongo Write |

---

## 7. Routing & Single-Writer Invariant Accounting

The production routing table in `frontend/src/lib/cutover-routing.ts` has been verified via automated validator `scripts/migration/validate-inventory.mjs`:

```text
CUTOVER_TABLE Route Count:
  Before Phase 5.6: 26
  After Phase 5.6:  26
  Change:           NO (Strictly 0 changes)
```

Every mutation endpoint in `CUTOVER_TABLE` is assigned `owner: 'go'`. No dual writers exist, and no fallback to Node is permitted upon backend failure (fail-fast HTTP 502 `GO_BACKEND_UNREACHABLE`).

---

## 8. Permanent Freeze Declaration

> [!IMPORTANT]
> **OCS Management Plane is frozen.**
>
> Managed domains:
> - **Tariff Plans** (`ocs_tariff_plans`)
> - **Contract Subscribers** (`ocs_subscribers`)
> - **Balance Management** (`ocs_balances`)
>
> Charging Plane remains frozen and excluded.
> No further OCS management redesign or business capabilities may be added.
