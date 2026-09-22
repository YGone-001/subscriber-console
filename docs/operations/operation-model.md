# Operational Model: Direct Operation & Governance Architecture

Status: PRODUCTION  
Phase: 5.7-A  
Baseline: `develop`  
Target Services: Next.js Frontend (:13333), Go Production Backend (:18888), MongoDB (`xcloud`, `xcloud_ops`)

---

## 1. Overview & Architectural Evolution

In Phase 5.7-A, the operational execution model was simplified from a multi-stage approval-blocking model into a **Direct Operation Workflow** suited for internal carrier operations (CNMS internal operations model).

### Prior Workflow (Phase 5.0 - Phase 5.6)
```text
User Operation
       │
       ▼
Permission Check
       │
       ▼
Approval Workflow  ──(Operator generates pending ticket in app_approvals)
       │
       ▼
Approval Execution ──(Super Admin reviews, approves, and executes)
       │
       ▼
Business Mutation
       │
       ▼
Audit Record
```

### Simplified Operational Workflow (Phase 5.7-A)
```text
User Operation
       │
       ▼
Authentication (JWT signature & session validation)
       │
       ▼
Permission Check (RBAC capability & fresh actor state revalidation)
       │
       ▼
Business Mutation (Direct execution with atomic CAS concurrency control)
       │
       ▼
Operation Log (Synchronous strict audit trail written to app_audit_logs)
```

Approval workflow is completely removed from the business execution path. Authorization and operation logging remain strictly enforced.

---

## 2. Core Principles of the Direct Operation Model

1. **Direct Immediate Execution**:
   Authorized operators (`root`, `super_admin`, `ops_admin`, `operator`) execute permitted business operations directly. Operations take effect in MongoDB immediately upon request completion.
2. **Zero Approval Dependency**:
   Business mutations no longer generate pending tickets in `app_approvals`. All mutation endpoints return HTTP 200/201 with `{"outcome": "success", "message": "operation completed"}`.
3. **Rigorous RBAC Capability Gates**:
   Role-based capability boundaries remain immutable:
   - `ocs.tariff.write`: Required for Tariff Plan mutations.
   - `ocs.subscriber.write`: Required for Contract Subscriber mutations.
   - `ocs.balance.adjust`: Required for Quota Balance adjustments.
   - Unauthorized roles (such as `viewer`) receive HTTP 403 Forbidden.
4. **Fresh Actor Revalidation**:
   Every mutation queries fresh user identity and session version (`sessionVersion`) from the primary database before execution to guarantee active status and prevent token revocation bypass.
5. **Optimistic Concurrency Control (CAS)**:
   Concurrent operations enforce atomic versioning (`version` precondition) to prevent lost updates or overwrite races.
6. **Strict Operation Logging**:
   Every state modification generates an immutable operational log in `app_audit_logs` containing actor identity, before/after state diffs, client IP, user agent, and mutation metadata.

---

## 3. Domain Execution Specifications

### 3.1 Tariff Management (`ocs_tariff_plans`)

| Operation | Endpoint | HTTP Method | Permitted Roles | Execution Mode | Response |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Create Plan | `/api/tariff-plans` | `POST` | `root`, `super_admin`, `ops_admin`, `operator` | Direct | `201 Created` (`outcome: success`) |
| Update Plan | `/api/tariff-plans/{id}` | `PUT` | `root`, `super_admin`, `ops_admin`, `operator` | Direct | `200 OK` (`outcome: success`) |
| Enable Plan | `/api/tariff-plans/{id}/enable` | `POST` | `root`, `super_admin`, `ops_admin`, `operator` | Direct | `200 OK` (`outcome: success`) |
| Disable Plan | `/api/tariff-plans/{id}/disable` | `POST` | `root`, `super_admin`, `ops_admin`, `operator` | Direct | `200 OK` (`outcome: success`) |
| Clone Plan | `/api/tariff-plans/{id}/clone` | `POST` | `root`, `super_admin`, `ops_admin`, `operator` | Direct | `201 Created` (`outcome: success`) |
| Delete Plan | `/api/tariff-plans/{id}` | `DELETE` | `root`, `super_admin`, `ops_admin`, `operator` | Direct | `200 OK` (`outcome: success`) |

### 3.2 Contract Subscriber Management (`ocs_subscribers`)

| Operation | Endpoint | HTTP Method | Permitted Roles | Execution Mode | Response |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Create Contract | `/api/ocs/subscribers` | `POST` | `root`, `super_admin`, `ops_admin`, `operator` | Direct | `201 Created` (`outcome: success`) |
| Change Tariff | `/api/ocs/subscribers/{imsi}` | `PATCH` | `root`, `super_admin`, `ops_admin`, `operator` | Direct | `200 OK` (`outcome: success`) |
| Suspend Contract | `/api/ocs/subscribers/{imsi}/suspend` | `POST` | `root`, `super_admin`, `ops_admin`, `operator` | Direct | `200 OK` (`outcome: success`) |
| Resume Contract | `/api/ocs/subscribers/{imsi}/resume` | `POST` | `root`, `super_admin`, `ops_admin`, `operator` | Direct | `200 OK` (`outcome: success`) |
| Terminate Contract | `/api/ocs/subscribers/{imsi}` | `DELETE` | `root`, `super_admin`, `ops_admin`, `operator` | Direct | `200 OK` (`outcome: success`) |

### 3.3 Balance Governance (`ocs_balances`)

| Operation | Endpoint | HTTP Method | Permitted Roles | Execution Mode | Response |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Adjust Balance | `/api/ocs/balances/{imsi}/adjust` | `POST` | `root`, `super_admin`, `ops_admin`, `operator` | Direct (CAS) | `200 OK` (`outcome: success`) |
| Reset Balance | `/api/ocs/balances/{imsi}/reset` | `POST` | *None* (All 6 roles) | Permanently Disabled | `400 Bad Request` (`BALANCE_RESET_DISABLED`) |

*Note: Hard balance resets remain permanently prohibited across all 6 roles to prevent arbitrary financial adjustments and maintain accounting integrity.*

---

## 4. Frontend Alignment

In alignment with direct operation semantics:
1. **Removed Governance Columns & Badges**: The `GovernanceBadge` column (Direct vs Approval required) has been eliminated from Tariff and Contract data tables.
2. **Removed Approval Redirect Links**: Operation feedback banners and notification toasts confirm completion directly and no longer include hyperlinks to `/approvals?id=...`.
3. **Removed Pending Balance Approvals Filter**: The Pending Adjustments card and approval status polling in `/ocs/balances` have been retired.
4. **Direct Error & Conflict Surfacing**: CAS concurrency conflicts (`BALANCE_PRECONDITION_CHANGED`) and business validation errors are presented in-place with retry prompts.

---

## 5. System Invariants & Guardrails

- **ACTUALLY_ROUTED = 26**: The production cutover routing inventory is strictly preserved. All 26 cutover endpoints are owned authoritatively by Go.
- **Single-Writer Ownership**: Go backend remains the single authoritative writer for OCS Management domains (`ocs_tariff_plans`, `ocs_subscribers`, `ocs_balances`).
- **Charging Plane Boundary**: Runtime charging collections (`ocs_sessions`, `ocs_reservations`, `ocs_usage_records`, `ocs_events`, `ocs_config`) and Diameter interfaces remain completely frozen and isolated from console operations.
- **Audit Persistence Guarantee**: If strict audit persistence fails during a direct operation, the handler returns `503 Service Unavailable` (`AUDIT_UNAVAILABLE`) with reconciliation details, ensuring non-repudiation.
