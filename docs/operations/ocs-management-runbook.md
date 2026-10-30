# OCS Management Plane Operations Runbook

Status: PRODUCTION / DIRECT EXECUTION (MANAGEMENT PLANE OPEN TO GOVERNED CORRECTION; CHARGING PLANE EXCLUDED)
Version: 2.0.0 (Direct Execution / Production Baseline)  
Target Components: Go Backend (:18888, API + embedded static React SPA), Nginx Edge (:80), MongoDB (`xcloud`, `xcloud_ops`)

---

## 1. Overview & Operational Scope

The **OCS Management Plane** governs administrative operations for commercial telecommunication offerings, subscriber billing contracts, and quota balances. It operates strictly separated from the runtime **Charging Plane** (Gy/Ro/CCR/Diameter rating and session management).

### Operational Invariants
1. **Single-Writer Production Invariant**: All mutations are executed authoritatively by Go backend (`:18888`). The Nginx edge routes `/api` and `/api/*` straight to Go (`GoRegistered = 166`); Go serves UI pages via embedded static React SPA. No fallback backend exists.
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
           │  HTTPS / HTTP :80  (Nginx public origin)
           ▼
Nginx Edge Router (deploy/nginx/xcloud.conf)
   - location /*, /api, /api/*, = /api/notifications/stream  -> Go backend
   - Strips client identity headers (X-User / X-Role / X-Permissions);
     never authenticates and never forwards to a second hop
           │
           │  HTTP Keep-Alive :18888
           ▼
Go Backend Service (backend/cmd/server)
   - Serves embedded static React SPA (production UI)
   - Authenticates the auth_token cookie
     and re-evaluates fresh DB permissions
   - Validates domain preconditions and
     atomic CAS version
   - Executes mutation directly to MongoDB
   - Appends non-gating operational log
     entry to app_audit_logs
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
   - `DELETE /api/tariff-plans/{planId}` removes the plan document only when no
     contract references it. The server refuses the default plan with
     `DEFAULT_TARIFF_PLAN_PROTECTED` and refuses a bound plan with
     `TARIFF_PLAN_DELETE_IN_USE` (HTTP 409); a dangling `plan_id` cannot be
     created through this endpoint, including by a concurrent binding race.
   - The console also refuses the delete while `subscriberCount > 0` and states
     the bound count on the control. Unbind or migrate the contracts first.

### 3.3 Console Surface (`/ocs/tariffs`)
- List: search by plan id/name, status filter, sortable columns, and a KPI strip
  over the whole collection. Filters, sort and paging are carried in the URL, so
  a refresh or a bookmark restores the same view.
- List columns report the identifiers the API actually emits: plan id, name,
  status (plus a `default` marker), rule count, data quota, validity window, bound
  contract count and last update. The historical "version" and "updated by"
  columns were removed because the plan projection never supplies them.
- Row actions: view, export JSON, edit, enable/disable, clone (the target id is
  requested, not generated), delete (guarded as above).
- Detail page: quota fields, the rating rule inventory with detected conflicts,
  the bound contracts (bounded read), and the governance history from
  `GET /api/tariff-plans/{planId}/operations`.
- **Rule maintenance is read-only here.** Rule create/update/toggle/delete,
  plan import and plan migration are disabled by policy and answer with
  `OCS_TARIFF_RULE_*_NOT_SUPPORTED` / `OCS_PLAN_MIGRATION_NOT_SUPPORTED`. The
  dry-run preview `GET /api/tariff-plans/{planId}/migrate` remains available and
  writes nothing.

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
1. **Contract Provisioning (existing subscriber)**:
   - Submit `POST /api/ocs/subscribers` with `imsi`, an explicit `plan_id`, optional `ocsTraffic` and `reason`.
   - The subscriber identity must exist in `xcloud.subscribers`; the contract's MSISDN is the subscriber's primary number (an optional `msisdn` must match it).
   - The selected `plan_id` must exist in `xcloud.ocs_tariff_plans` and be in `active` state. There is no default plan.
   - The contract is created `active`; the endpoint accepts no client-chosen lifecycle status and is insert-only. An existing contract answers `409 OCS_CONTRACT_EXISTS`; retained terminated history answers `409 OCS_CONTRACT_RETAINED`.
   - The same call creates the balance account. Only the supplied quota buckets are written; a pre-existing account is adopted untouched (its buckets are never rewritten), and its plan/status must be compatible or the call answers `OCS_BALANCE_PLAN_MISMATCH` / `OCS_BALANCE_STATUS_INCONSISTENT`.
   - The console entry points are the "Provision contract" button on `/ocs/contracts` and the action shown on a subscriber detail page whose contract is missing.
2. **Lifecycle propagation**:
   - Suspend, resume, terminate and plan reassignment update the contract first-class record and mirror status/plan into `xcloud.ocs_balances` (with a version increment).
   - Balance reads prefer the contract's status/plan over the account's cached copies; the adjust endpoint refuses a terminated contract even if the cached account status is stale.
3. **Plan Reassignment**:
   - Submit `PATCH /api/ocs/subscribers/{imsi}` with new `plan_id`.
4. **Contract Suspension**:
   - Submit `POST /api/ocs/subscribers/{imsi}/suspend`.
   - Sets status to `suspended`. Rating engine halts usage grants for suspended contracts.
5. **Contract Resumption**:
   - Submit `POST /api/ocs/subscribers/{imsi}/resume`.
   - Allowed only from `suspended`; a terminated contract answers
     `CONTRACT_TERMINATED` and is never resurrected.
6. **Contract Termination**:
   - Submit `PATCH /api/ocs/subscribers/{imsi}` with `{"status":"terminated"}`.
   - Moves the contract to the terminal `terminated` state and preserves both the
     contract and its balance records. `DELETE /api/ocs/subscribers/{imsi}` is a
     compatibility alias for the same soft transition; it no longer removes
     records.
   - A terminated contract is terminal in the console and in the API: suspend,
     resume, tariff reassignment, termination and balance adjustment are all
     refused. Physical cleanup belongs to the data-retention operation, not this
     route.
   - Deleting the subscriber identity is refused while the contract is active or
     suspended (`SUBSCRIBER_ACTIVE_CONTRACT_EXISTS`). After termination the
     subscriber record may be deleted, but the OCS contract and balance are
     retained as billing history for the retention operation; they are not
     cascade-deleted.

### 4.3 Console Surface (`/ocs/contracts`)
- KPI strip: all / active / suspended / terminated. The counts come from the
  list envelope's `summary` block and describe the collection, not the current
  page or the active filters. If the summary aggregation is unavailable the
  counts render as em dashes; they are never fabricated as zero.
- Filters: IMSI (digits only), MSISDN (digits only), status and tariff plan.
  Sort, page and page size live in the URL.
- The toolbar exposes "Provision contract" for operators with
  `ocs.plan.assign`; it opens the shared provisioning dialog (subscriber
  lookup, explicit plan, optional quota buckets and a reason). The same dialog
  is available from a subscriber detail page whose contract is missing.
- The pager derives its page count from `total`. The list envelope's `totalPages`
  is `floor(total/limit) + 1`, which advertises a trailing empty page whenever the
  total is an exact multiple of the page size.
- Suspend, resume and terminate each require a confirmation with a reason
  (at least 3 characters); the reason is recorded in the audit record.
- Tariff reassignment lists active plans plus the contract's current plan, and
  previews the current and target quota/validity before applying. The change
  takes effect immediately and does not recalculate quota already granted. A
  disabled plan is never offered: the API rejects it with `OCS_TARIFF_DISABLED`.
- Detail page: identity, billing (plan name, quota, status), timestamps, the
  bounded operation history (last 20 audit projections: operation, actor, role,
  status/plan change, reason, result) and the same lifecycle actions with
  confirmation. Lifecycle audit snapshots store only identity and
  plan/status fields, never raw BSON/time/ObjectID; older records without a
  change field render an em dash. If the audit read is unavailable the page
  says so explicitly; it never presents an unreadable history as "no
  operations". A missing identifier renders the "not found" state; it never
  falls back to a neighbouring record.
- The detail page reads one contract by its exact identifier with
  `GET /api/ocs/subscribers/{imsi}` (`ocs.read`). A malformed identifier answers
  `400 OCS_INVALID_IMSI`, an absent contract `404 OCS_SUBSCRIBER_NOT_FOUND`;
  neither path can return a different contract whose IMSI merely contains the
  requested fragment.

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
1. Navigate to `/ocs/balances` and locate the subscriber by IMSI (digits only),
   optionally filtering by status or tariff plan.
2. Click **Adjust Balance** (or open the detail page `/ocs/balances/{imsi}` and
   use the header action).
3. Specify one bucket (`data` | `voice` | `sms`), one operation
   (`credit` | `debit`), the amount in the chosen unit, a required `reason`
   (max 200 characters) and an optional `ticketId` (max 100 characters). The
   console sends the record's `version` as the CAS precondition.
4. Execution:
   - **admin**: Direct authorized adjustment.
   - **operator**: Direct authorized adjustment.
   - **viewer**: Denied with HTTP 403.
5. A concurrent write answers `BALANCE_PRECONDITION_CHANGED`; refetch the record
   and retry. A broken conservation invariant blocks the write with
   `BALANCE_INVARIANT_VIOLATION`, which is why the invariant state is shown in
   both the list and the detail page. A record whose bucket fields or version
   are not reported is refused with `BALANCE_FIELDS_MISSING` or
   `BALANCE_VERSION_MISSING`; unknown values are never coerced to zero.
   Every console adjustment entry point (balance list, balance detail and both
   subscriber surfaces) sends the record version.

### 5.2.1 Console Surface (`/ocs/balances`)
- KPI strip: account count, data allocated, data used and data available, read
  from the `summary` block of the list envelope. The summary describes the
  current filter result set, not the whole collection, and is computed in the
  same aggregation as the page and `total`.
- Filters: IMSI (digits only), status and tariff plan; sortable IMSI / available
  data / last update. Page, filters and sort live in the URL. The optional
  `invariantStatus=valid|broken` filter is applied before pagination; records
  whose bucket operands are missing are `unknown` and belong to neither subset.
- The table shows the plan name, the three available buckets, the money balance,
  the conservation-invariant badge and the last update. A value the API did not
  report renders as an em dash, never as `0`.
- The detail page reads `GET /api/ocs/balances/{imsi}` (exact record), shows the
  billing cycle window, the record version and the links to the charging contract
  and the subscriber record.
- The adjustment trail comes from `GET /api/ocs/balances/{imsi}/adjustments`
  (bounded `page`/`limit`, newest first). It projects the `BALANCE_ADJUST`
  operation-log records for that account: time, actor, role, result, reason,
  bucket, operation, amount, ticket id and the before/after version. Readers
  need `ocs.read`; the record is read-only and never exposes the raw audit
  document.

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
- Edge Health Check: `GET http://localhost/api/system/health`
  - Verifies edge forwarding and MongoDB connectivity.

### 7.2 Routing Diagnostics
To confirm a request reached the Go backend:
- Inspect HTTP response headers:
  - `X-Request-ID: <uuid>` (emitted by the Go request-ID middleware)
- Inspect the Nginx access log for the `/api` location and upstream `xcloud_go`.

### 7.3 Common Error Codes & Actions

| Error Code | HTTP Status | Cause | Operational Action |
|---|---|---|---|
| `BALANCE_RESET_DISABLED` | 400 | Attempted hard reset on balance | Instruct operator to use delta adjustment (`/adjust`) with CAS version. |
| `BALANCE_PRECONDITION_CHANGED` | 409 | Document version modified concurrently | Reload record to fetch current version and resubmit request. |
| `BALANCE_FIELDS_MISSING` | 409 | The balance record omits fields needed to verify or adjust the bucket | Inspect the stored document; do not treat missing fields as zero. |
| `BALANCE_VERSION_MISSING` | 409 | The balance record does not report a version | Reconcile the record before adjusting; CAS cannot be enforced without it. |
| `BALANCE_INVARIANT_VIOLATION` | 409 | Conservation equation is broken | Repair the record before any adjustment. |
| `GO_BACKEND_UNREACHABLE` | 502 | Go process (:18888) is down | Check Go service process and restart if necessary. |
| `PLAN_NOT_FOUND` | 404 | Referenced `plan_id` does not exist | Verify plan exists in `/ocs/tariffs` before assigning to contract. |
| `INSUFFICIENT_BALANCE` | 422 | Negative adjustment exceeds available quota | Adjust delta to not violate conservation invariant (`available >= 0`). |
| `TARIFF_PLAN_EXISTS` | 409 | Tariff plan with this ID already exists | Choose a distinct `plan_id` for creation or cloning. |
| `TARIFF_PLAN_DELETE_IN_USE` | 409 | Tariff plan is still bound to contracts | Unbind or migrate the contracts before deleting the plan. |
| `CONTRACT_TERMINATED` | 409 | Resume/suspend/tariff/adjust attempted on a terminated contract | Terminated contracts are read-only; no lifecycle resurrection. |
| `CONTRACT_NOT_SUSPENDED` | 409 | Resume attempted from a state other than suspended | Only `suspended -> active` is allowed. |
| `CONTRACT_NOT_ACTIVE` | 409 | Suspend attempted from a state other than active | Only `active -> suspended` is allowed. |
| `CONTRACT_NOT_TERMINATABLE` | 409 | Termination attempted from an undefined state | Inspect the contract status before terminating. |
| `CONTRACT_REASON_REQUIRED` | 400 | Suspend/resume/terminate omitted the required reason | Provide a reason with at least 3 characters; it is recorded in the audit trail. |
| `OCS_CONTRACT_EXISTS` | 409 | Contract provisioning attempted for an IMSI that already has a contract | Open the existing contract; create is insert-only. |
| `OCS_CONTRACT_RETAINED` | 409 | IMSI still has terminated contract history inside the retention window | Purge the retained history through Data Retention before reusing the IMSI. |
| `SUBSCRIBER_NOT_FOUND` | 404 | Contract provisioning requested for an IMSI without a subscriber identity | Create the subscriber first. |
| `OCS_PLAN_ID_REQUIRED` | 400 | Contract provisioning omitted `plan_id` | Select an explicit active plan; there is no default plan. |
| `MSISDN_MISMATCH` | 400 | Requested `msisdn` differs from the subscriber primary number | Omit `msisdn` or send the subscriber's primary number. |
| `OCS_BALANCE_PLAN_MISMATCH` | 409 | Existing balance account belongs to another plan | Reconcile the account before provisioning the contract. |
| `OCS_BALANCE_STATUS_INCONSISTENT` | 409 | Existing balance account is not active | Reconcile the account before provisioning the contract. |
| `OCS_CONTRACT_CREATE_PARTIAL_WRITE` | 500 | Contract provisioning failed and compensation could not remove the inserted contract | Inspect `ocs_subscribers`/`ocs_balances` for the IMSI and reconcile. |
| `OCS_CONTRACT_CREATE_FAILED` | 500 | Contract provisioning failed; no contract remains | Retry after checking the service logs. |

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

## 8. Management Plane Governance

The OCS management plane is open to governed lifecycle, data-truthfulness and UI
correction under the current API, RBAC, Fresh Actor, rate-limit and audit
boundaries. The charging plane remains excluded. Production routing invariant
`GoRegistered = 166` is strictly maintained; new fields or endpoints are additive
and require the associated contract and documentation updates.

---

## 9. Terminated-Contract Data Retention

Physical cleanup is a data-retention operation, separate from contract
termination.

- Policy: `OCS_TERMINATED_RETENTION_DAYS` (default `365`, `0` disables cleanup).
- Admin surface: `/system/retention`; API `GET /api/system/retention/ocs` and
  `POST /api/system/retention/ocs/purge`. Both require the `admin` role and
  `core.configure`; apply additionally revalidates the fresh actor.
- Eligibility: only `status=terminated` contracts whose stored `updated_at` is at
  or before the cutoff. A contract without a parseable timestamp is not eligible;
  active and suspended contracts are never touched.
- Apply requires a reason and the exact confirmation phrase
  `PURGE TERMINATED OCS`. The UI and API require a dry run first.
- Cascade: `ocs_balance_adjustments` -> `ocs_balances` -> `ocs_subscribers`.
  `xcloud_ops.app_audit_logs` and the subscriber identity record are retained.
- Each purged contract writes a `PURGE` audit record with the reason, actor and
  deleted counts. Audit write failures are reported as warnings after the write.
- CLI (same service):
  ```bash
  go run ./cmd/ocs-retention                       # dry-run preview
  go run ./cmd/ocs-retention --apply \
    --reason "retention policy" --confirm "PURGE TERMINATED OCS"
  ```
  `--imsi <imsi>` is an explicit CLI-only maintenance escape hatch for one
  already-terminated contract; it is not exposed over HTTP.
