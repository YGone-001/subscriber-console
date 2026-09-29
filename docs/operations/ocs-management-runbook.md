# OCS Management Plane Operations Runbook

Status: PRODUCTION / FROZEN  
Version: 2.0.0 (Phase 5.7 Direct Execution / Phase 6.1-D Production Baseline)  
Target Components: Next.js Frontend (:13333), Go Backend (:18888), MongoDB (`xcloud`, `xcloud_ops`)

---

## 1. Overview & Operational Scope

The **OCS Management Plane** governs administrative operations for commercial telecommunication offerings, subscriber billing contracts, and quota balances. It operates strictly separated from the runtime **Charging Plane** (Gy/Ro/CCR/Diameter rating and session management).

### Operational Invariants
1. **Single-Writer Production Invariant**: All mutations are executed authoritatively by Go backend (`:18888`). The Next.js reverse proxy routes requests strictly according to `CUTOVER_TABLE` (`ACTUALLY_ROUTED = 36`). Node fallback is disabled.
2. **Canonical RBAC & Direct Execution**:
   - `admin`: System administration, user management, and direct business mutations.
   - `operator`: Core operational mutations (subscribers, balances, profiles, tariffs, rating) execute directly without approval. No user administration.
   - `viewer`: Read-only inspection; all mutations denied with HTTP 403.
   No authorized OCS mutation requires human approval. Zero approval records are created on normal business operations.
3. **Optimistic Concurrency (CAS)**: All balance and plan mutations enforce atomic version checks (`version` precondition) to eliminate race conditions.
4. **Permanent Reset Prohibition**: Hard balance resets via `/api/ocs/balances/{imsi}/reset` are permanently disabled (`BALANCE_RESET_DISABLED`, HTTP 400) to protect billing integrity and audit accounting.
5. **Charging Plane Isolation**: Console operations NEVER directly interact with `ocs_sessions`, `ocs_reservations`, `ocs_usage_records`, `ocs_events`, or `ocs_config`.

---

## 2. Architecture & Service Topology

```text
Operator / Admin Browser
           │
           │  HTTPS / HTTP :13333
           ▼
Next.js Reverse Proxy (frontend/src/proxy.ts)
   - Inspects auth token cookie (JWT)
   - Matches route against CUTOVER_TABLE (ACTUALLY_ROUTED = 36)
   - Appends X-Request-ID, X-Actor-ID, X-Actor-Role
   - Dispatches to Go backend (:18888)
           │
           │  HTTP Keep-Alive :18888
           ▼
Go Backend Service (backend/cmd/server)
   - Authenticates request and re-evaluates fresh database permissions
   - Validates domain preconditions and atomic CAS version
   - Executes mutation directly to MongoDB
   - Appends non-gating operational log entry to app_audit_logs
           │
           ▼
MongoDB Infrastructure
   ├── Database: xcloud
   │     ├── ocs_tariff_plans       (Commercial plans)
   │     ├── ocs_subscribers        (Billing contracts)
   │     └── ocs_balances           (Subscriber balances)
   └── Database: xcloud_ops
         ├── app_audit_logs         (Internal operational audit logs)
         └── app_approvals          (Historical collection; retired from production execution)
```

---

## 3. Domain 1: Tariff Plan Operations

Console Route: `/ocs/tariffs`  
API Prefix: `/api/tariff-plans`  
Target Collection: `xcloud.ocs_tariff_plans`

### 3.1 Plan Structure & Quota Parameters
- `plan_id`: Unique identifier (e.g. `plan_standard_5g_50gb`). Immutable once created.
- `name`: Display name.
- `quota_per_grant`: Allocation chunk size in bytes (e.g. `5368709120` for 5 GB).
- `validity_time`: Duration in seconds for plan validity (e.g. `2592000` for 30 days).
- `volume_threshold`: Low balance threshold in bytes triggering notifications (e.g. `1073741824` for 1 GB).
- `status`: `active` or `disabled`.

### 3.2 Standard Procedures
1. **Create Plan**:
   - Submit `POST /api/tariff-plans`.
   - Authorized `admin` and `operator` execute directly and immediately.
2. **Update Plan**:
   - Submit `PUT /api/tariff-plans/{planId}` with updated quota or validity parameters.
   - Enforces CAS version check; triggers atomic version increment `version += 1`.
3. **Enable / Disable Plan**:
   - `POST /api/tariff-plans/{planId}/enable` or `POST /api/tariff-plans/{planId}/disable`.
   - Disabling a plan prevents new subscriber contracts from adopting it; existing contracts remain valid until expiration or explicit migration.
4. **Clone Plan**:
   - `POST /api/tariff-plans/{planId}/clone` creates a duplicate template with a new `target_plan_id`.
5. **Delete Plan**:
   - `DELETE /api/tariff-plans/{planId}`. Removes the plan if no active contracts reference it.

---

## 4. Domain 2: Contract Subscriber Operations

Console Route: `/ocs/contracts`  
API Prefix: `/api/ocs/subscribers`  
Target Collection: `xcloud.ocs_subscribers`

### 4.1 Boundary Distinction
> [!NOTE]
> `xcloud.ocs_subscribers` represents **commercial billing contracts** linking an IMSI to a Tariff Plan.
> It is strictly decoupled from `xcloud.subscribers` (which manages 3GPP network SIM provisioning, OPc/K keys, and HSS/EPC AMBR speed limits).

### 4.2 Standard Procedures
1. **Contract Provisioning**:
   - Submit `POST /api/ocs/subscribers` with `imsi`, `msisdn`, and `plan_id`.
   - The selected `plan_id` must exist in `xcloud.ocs_tariff_plans` and be in `active` state.
2. **Plan Reassignment**:
   - Submit `PATCH /api/ocs/subscribers/{imsi}` with new `plan_id`.
3. **Contract Suspension**:
   - Submit `POST /api/ocs/subscribers/{imsi}/suspend`.
   - Sets status to `suspended`. Rating engine halts usage grants for suspended contracts.
4. **Contract Resumption**:
   - Submit `POST /api/ocs/subscribers/{imsi}/resume`.
   - Restores status to `active`.
5. **Contract Termination**:
   - Submit `DELETE /api/ocs/subscribers/{imsi}`.
   - Moves contract to `terminated` or removes record after balance reconciliation.

---

## 5. Domain 3: Balance Management Operations

Console Route: `/ocs/balances` and `/ocs/balances/[imsi]`  
API Prefix: `/api/ocs/balances`  
Target Collection: `xcloud.ocs_balances`

### 5.1 Balance Conservation Invariants
For all balances in `ocs_balances`, the following conservation equations must hold true at all times:
- **Data (Bytes)**: `data_total == data_used + data_reserved + data_available`
- **Voice (Seconds)**: `voice_total == voice_used + voice_reserved + voice_available`
- **SMS (Count)**: `sms_total == sms_used + sms_available`

### 5.2 Balance Adjustment Procedure
To adjust quota for a subscriber:
1. Navigate to `/ocs/balances` and locate the subscriber by IMSI.
2. Click **Adjust Balance** (or open detail page `/ocs/balances/[imsi]`).
3. Specify:
   - `delta_bytes` (positive to add quota, negative to reduce quota)
   - `delta_voice_seconds`
   - `delta_sms_count`
   - `expected_version` (CAS version precondition)
   - `reason` (audit trail explanation)
4. Execution:
   - **admin**: Direct authorized adjustment.
   - **operator**: Direct authorized adjustment.
   - **viewer**: Denied with HTTP 403.

### 5.3 Permanent Reset Prohibition
> [!CAUTION]
> Hard balance resets are permanently forbidden in production.
> Any call to `POST /api/ocs/balances/{imsi}/reset` returns:
> ```json
> {
>   "error": "BALANCE_RESET_DISABLED",
>   "message": "Direct balance reset is permanently disabled to preserve quota integrity and audit history. Use balance adjustment instead."
> }
> ```
> Operators must always use delta adjustments (`/api/ocs/balances/{imsi}/adjust`) with an audited justification.

---

## 6. Direct Operation Flow & Security Controls

Normal business operations execute directly without intermediate gating workflows or multi-person handoffs.

### 6.1 Operation Flow Diagram
```text
Authorized User
       │
       ▼
Authentication (JWT signature & session validation)
       │
       ▼
Fresh Actor Validation (active account check & sessionVersion)
       │
       ▼
RBAC / Permission Check (admin / operator capability gates)
       │
       ▼
Domain & CAS Precondition Check (expected_version vs live document)
       │
       ▼
Direct Database Mutation (atomic commit in MongoDB)
       │
       ▼
Best-Effort Operation Log (app_audit_logs append)
```

Permission determines whether an operation executes; approval is not part of execution.

### 6.2 Key Security Controls
1. **Optimistic Concurrency Control (CAS)**: All balance and plan modifications validate `expected_version` against the live document version in MongoDB. If modified concurrently, the mutation fails with HTTP 409 `CAS_CONFLICT`.
2. **Fresh Actor Revalidation**: Before executing any mutation, fresh user identity and session version (`sessionVersion`) are revalidated from `xcloud_ops.app_users` to prevent token revocation bypass.
3. **Non-Gating Operation Logging**: State modifications record operational evidence to `xcloud_ops.app_audit_logs`. Logging is best-effort: queue or storage issues are logged diagnostically and never cause a successfully committed mutation to fail with `503 AUDIT_UNAVAILABLE`.
4. **Historical `app_approvals` Collection**: The collection `xcloud_ops.app_approvals` is historical only. It is not part of active product execution and has no normal business readers or writers. It does not require an automatic destructive drop and may remain for retention or archival purposes.

---

## 7. Diagnostics, Troubleshooting & Recovery

### 7.1 Health Checks
- Go Backend: `GET http://127.0.0.1:18888/healthz` (liveness) and `GET /readyz` (MongoDB readiness)
  - Expected: HTTP 200 `{"status":"ok"}`
- Ingress Proxy: `GET http://127.0.0.1:13333/api/system/health`
  - Verifies proxy forwarding and MongoDB connectivity.

### 7.2 Routing Diagnostics
To confirm whether a request is routed to Go:
- Inspect HTTP response headers:
  - `X-Cutover-Owner: go`
  - `X-Proxied-By: next-proxy`
  - `X-Request-ID: <uuid>`

### 7.3 Common Error Codes & Actions

| Error Code | HTTP Status | Cause | Operational Action |
|---|---|---|---|
| `BALANCE_RESET_DISABLED` | 400 | Attempted hard reset on balance | Instruct operator to use delta adjustment (`/adjust`) with CAS version. |
| `CAS_CONFLICT` | 409 | Document version modified concurrently | Reload record to fetch current version and resubmit request. |
| `GO_BACKEND_UNREACHABLE` | 502 | Go process (:18888) is down | Check Go service process and restart if necessary. |
| `PLAN_NOT_FOUND` | 404 | Referenced `plan_id` does not exist | Verify plan exists in `/ocs/tariffs` before assigning to contract. |
| `INSUFFICIENT_BALANCE` | 422 | Negative adjustment exceeds available quota | Adjust delta to not violate conservation invariant (`available >= 0`). |
| `TARIFF_PLAN_EXISTS` | 409 | Tariff plan with this ID already exists | Choose a distinct `plan_id` for creation or cloning. |

### 7.4 Internal Operation Log Inquiries
All operations append internal operational records to `xcloud_ops.app_audit_logs` for troubleshooting, traceability, and operational evidence.  
Querying operation logs for a specific subscriber:
```javascript
db.app_audit_logs.find({
  "resource_type": "ocs_balance",
  "resource_id": "460110000000001"
}).sort({ created_at: -1 })
```

---

## 8. Permanent Freeze Sign-Off

The OCS Management Plane is in permanent maintenance mode.  
No further architectural modifications, new management routes, or Charging Plane couplings are permitted.  
Production routing invariant `ACTUALLY_ROUTED = 36` is strictly maintained.
