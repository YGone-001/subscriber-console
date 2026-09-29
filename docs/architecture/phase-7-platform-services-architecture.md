# Phase 7 - Alerts, Notifications & Platform Services Architecture Freeze

> Authoritative architecture freeze for Phase 7: Alerts, Notifications, System Health,
> System Integrity Audit & Self-Healing, and Analytics Platform Actions.
> This document defines the boundary, contracts, and migration roadmap for Phase 7.1+.
> Stable rules: `CLAUDE.md`. Current state: `AGENTS.md`.

---

## 1. Executive Summary & Phase 7 Scope Definition

Phase 7 encompasses the platform infrastructure, diagnostic, alerting, and notification services
supporting the xCloud operational console. Following the completion of Subscriber/Profile CRUD (Phase 4),
OCS Management Governance (Phase 5), and Authentication & User Management (Phase 6), Phase 7 plans
the controlled transition of the remaining operational platform and real-time event mechanisms into
the canonical Go backend.

### 1.1 In-Scope Domains

Phase 7 exclusively owns and governs:

1. **Alert Domain**:
   - Querying operational alerts from MongoDB (`GET /api/alerts`).
   - Acknowledging alert entries (`POST /api/alerts/acknowledge`).
   - Updating alert workflow lifecycle status, assignment, and notes (`POST /api/alerts/workflow`).
2. **Notification Streaming Domain**:
   - Real-time Server-Sent Events (SSE) telemetry stream (`GET /api/notifications/stream`).
   - Client event broadcasting (`init`, `alerts_update`, `session_expired`) and comments (`:ping`, `:transient_retry`).
3. **System Health Domain**:
   - Deep comprehensive system health evaluation across Database, OCS Engine, HSS Core, and Security (`GET /api/system/health`).
   - Deep MongoDB connection pool and collection diagnostic report (`GET /api/system/mongo/health`).
4. **System Integrity Audit & Self-Healing Domain**:
   - System integrity status check (`GET /api/system/audit/status`).
   - Read-only diagnostic anomaly scan across Subscribers, OCS, and Tariffs (`POST /api/system/audit/scan`).
   - Targeted subscriber/OCS document self-healing mutation (`POST /api/system/audit/heal`).
   - Batch anomaly self-healing mutation (`POST /api/system/audit/batch-heal`).
5. **Analytics Platform Action**:
   - On-demand analytics recomputation trigger (`POST /api/analytics/init`).

### 1.2 Out-of-Scope & Excluded Domains

Phase 7 strictly excludes and will not touch:
- **OCS Charging Plane**: Low-level session, reservation, usage event processing, and quota engines (`ocs_sessions`, `ocs_reservations`, `ocs_usage`, `ocs_events`, `ocs_config`).
- **External Message Brokers**: No introduction of Kafka, Redis Pub/Sub, RabbitMQ, NATS, or WebSockets. The system remains a self-contained, carrier internal-network architecture.
- **Approval Workflows**: Approval mechanisms were retired in Phase 5.7-A and remain completely removed from the execution path. All mutations execute via Direct Execution.
- **Legacy Audit Console**: Retired governance surfaces (`/api/approvals/*`, `/api/audit/*`) remain eliminated. Only system integrity diagnostics (`/api/system/audit/*`) are active.

---

## 2. Authoritative Baseline & Status

### 2.1 Commit Baseline

- **Authoritative Baseline SHA**: `f3feaf69bfc0ed10cc67d5740c224ada3d8a5217`
- **Branch**: `develop`
- **Baseline State**: Clean working directory, all tests passing.

### 2.2 Operational Baseline

- **CUTOVER_TABLE**: Exactly 36 routes.
- **ACTUALLY_ROUTED**: Exactly 36 routes.
- **API Inventory**: Exactly 54 route files, 78 HTTP operations (GET=32, POST=29, PUT=7, PATCH=3, DELETE=7; non-GET=46).
- **Go HTTP Endpoints**: 58 operations implemented in Go.
- **Phase 7 Candidate Status**: Exactly 11 endpoints, currently 100% owned by Next.js/Node runtime (`CUTOVER_TABLE` = unlisted / owner `node`). Zero Phase 7 endpoints currently registered in Go backend.

---

## 3. Phase 7 Candidate Endpoint Inventory

The 11 candidate endpoints for Phase 7 migration with exact source-derived attributes:

| # | Endpoint | Method | Path | Current Owner | Target Owner | Semantics | Auth Guard | Rate Limit Key | Rate Limit |
|---|----------|--------|------|---------------|--------------|-----------|------------|----------------|------------|
| 1 | Alert List | `GET` | `/api/alerts` | Node | Go | Read | `requireAuth` | `alerts:list:<user>` | 120 / 60s |
| 2 | Alert Acknowledge | `POST` | `/api/alerts/acknowledge` | Node | Go | Mutation | `requireAnyRole(['root', 'operator'])` | `alerts:acknowledge:<user>` | 60 / 60s |
| 3 | Alert Workflow | `POST` | `/api/alerts/workflow` | Node | Go | Mutation | `requireAnyRole(['root', 'operator'])` | `alerts:workflow:<user>` | 120 / 60s |
| 4 | Notification Stream | `GET` | `/api/notifications/stream` | Node | Go | SSE Stream | `requireAuth` | None (stream-scoped) | None |
| 5 | System Health | `GET` | `/api/system/health` | Node | Go | Deep Read | `requireAuth` | `system:health:<user>` | 30 / 60s |
| 6 | Mongo Health | `GET` | `/api/system/mongo/health` | Node | Go | Deep Read | `requireAuth` | `system:mongo-health:<user>` | 30 / 60s |
| 7 | Audit Status | `GET` | `/api/system/audit/status` | Node | Go | Read | `requireAuth` | `system:audit-status:<user>` | 60 / 60s |
| 8 | Audit Scan | `POST` | `/api/system/audit/scan` | Node | Go | Semantic Read | `requireAnyRole(['root', 'operator'])` | `system:audit-scan:<user>` | 30 / 60s |
| 9 | Audit Heal | `POST` | `/api/system/audit/heal` | Node | Go | Mutation | `requireCapability('system_heal')` | `system:audit-heal:<user>` | 20 / 60s |
| 10 | Audit Batch Heal | `POST` | `/api/system/audit/batch-heal` | Node | Go | Mutation | `requireCapability('system_heal')` | `system:audit-batch-heal:<user>` | 10 / 60s |
| 11 | Analytics Init | `POST` | `/api/analytics/init` | Node | Go | Semantic Read | `requireAnyRole(['root', 'operator'])` | `analytics:init:<user>` | 3 / 300s |

---

## 4. Routing Architecture & Invariants

### 4.1 Request Flow

The operational request flow remains consistent with the target architecture:

```text
Browser -> Nginx
             |
             v
       Next.js (:3000)
             |
        (proxy.ts)
             |
             +---> [Path in CUTOVER_TABLE && owner == 'go'] ---> Go Backend (:18888)
             |                                                          |
             |                                                          v
             |                                                       MongoDB
             |                                                 (xcloud / xcloud_ops)
             |
             +---> [Default fallback: owner == 'node'] --------> Next.js Route Handlers
                                                                        |
                                                                        v
                                                                     MongoDB
                                                               (xcloud / xcloud_ops)
```

### 4.2 Invariant Guarantees

1. **Routing Invariant**: `CUTOVER_TABLE` remains strictly at 36 routes during Phase 7.0. No Phase 7 candidate is cut over in this phase.
2. **Reverse Proxy Invariant**: `frontend/src/proxy.ts` performs JWT session revalidation, actor extraction, and conditional forwarding. When forwarding to Go, failures must fail closed with HTTP 502 `GO_BACKEND_UNREACHABLE` and zero Node fallback.
3. **Path Preservation**: No API path, query parameter, or payload contract will be renamed or restructured during migration.

---

## 5. Alert Domain Architecture & Contract

### 5.1 Storage Model & Actual Schema

- **Database**: `xcloud_ops` (`getAppCollection`)
- **Collection**: `app_alerts`
- **Source Model**: `AlertDocument` in `frontend/src/server/repositories/alertRepository.ts`

#### Current Persisted Fields

The actual fields defined and persisted by `alertRepository.ts` are:

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Unique identifier for the alert |
| `timestamp` | `string` | ISO timestamp of the alert event |
| `level` | `SyslogLevel` | Severity level (`CRITICAL`, `WARNING`, `INFO`, etc.) |
| `imsi` | `string` | Associated IMSI or identifier |
| `reason` | `string` | Reason or description of the alert |
| `is_acknowledged` | `boolean` | Primary boolean acknowledgement flag |
| `workflow_status` | `AlertWorkflowStatus` (optional) | Workflow state (`acknowledged`, `assigned`, `recovering`, `resolved`) |
| `assigned_to` | `string` (optional) | Operator username assigned to handle the alert |
| `handling_note` | `string` (optional) | Operational note or resolution remark |
| `workflow_updated_at` | `string` (optional) | ISO timestamp of last workflow modification |

Nonexistent fields such as `alertId`, `severity`, `title`, `description`, `metadata`, `assignedTo`, `note`, `createdAt`, `updatedAt`, `acknowledgedAt`, `acknowledgedBy`, `resolvedAt`, or `resolvedBy` are **NOT** part of the current production alert document model.

### 5.2 Alert Retention Contract

- **Retention Limit**: `ALERT_LIMIT = 10000`
- **Source Mechanism**: `appendAlert()` in `alertRepository.ts`:
  1. Inserts the new alert document (`insertOne`).
  2. Queries all documents sorted by `timestamp: -1`, skipping the first 10,000 (`skip(10000)`).
  3. Deletes all IDs exceeding the 10,000 threshold (`deleteMany({ id: { $in: staleIds } })`).
  4. Notice: Retention trims all alerts beyond 10,000 based strictly on `timestamp` order; it does **not** restrict trimming to acknowledged alerts.

### 5.3 Alert Indexes Contract

Source-derived expected indexes from `frontend/src/server/repositories/mongoHealthRepository.ts`:

1. `alerts_timestamp_desc`: `{ timestamp: -1 }`
2. `alerts_active_by_level`: `{ is_acknowledged: 1, level: 1, timestamp: -1 }`
3. `alerts_imsi_timestamp`: `{ imsi: 1, timestamp: -1 }`

Nonexistent indexes such as `{ status, severity, createdAt }`, `{ alertId } unique`, or `{ imsi, status }` are **NOT** declared in the production schema.

---

### 5.4 Endpoint Contracts

#### `GET /api/alerts`

##### CURRENT FROZEN CONTRACT
- **Route Handler**: `frontend/src/app/api/alerts/route.ts`
- **Access**: `requireAuth(request)` (any authenticated role: `admin`, `operator`, `viewer`).
- **Rate Limit**: Key `alerts:list:<user>`, **120 requests / 60 seconds**.
- **Query Parameters**: **NONE**. The route handler does not parse `limit`, `status`, or `severity`.
- **Repository Invocation**: Calls `listAlerts(101)` with a hard-coded limit of 101.
- **Data Transformation**: Strips `_id` via `stripMongoId`.
- **Response `200 OK`**:
  ```json
  {
    "alerts": [
      {
        "id": "alert-uuid",
        "timestamp": "2026-09-25T01:00:00.000Z",
        "level": "CRITICAL",
        "imsi": "460020000000001",
        "reason": "Balance exhausted",
        "is_acknowledged": false,
        "workflow_status": "assigned",
        "assigned_to": "operator1",
        "handling_note": "Investigating",
        "workflow_updated_at": "2026-09-25T01:05:00.000Z"
      }
    ],
    "activeCriticalCount": 2,
    "activeWarningCount": 3,
    "activeCount": 5
  }
  ```
  Note: `totalCount` is **not** returned by current production source.
- **Error Response `500 Internal Server Error`**:
  ```json
  { "error": "Alert fetch failed" }
  ```
- **Audit Logging**: None.

##### TARGET GO MIGRATION REQUIREMENTS (PHASE 7.1)
- Go shadow handler must match exact 120/60s rate limit and `listAlerts(101)` fixed query behavior.

---

#### `POST /api/alerts/acknowledge`

##### CURRENT FROZEN CONTRACT
- **Route Handler**: `frontend/src/app/api/alerts/acknowledge/route.ts`
- **Access**: `requireAnyRole(request, ['root', 'operator'])`. In canonical RBAC, accessible by `admin` and `operator`; `viewer` receives HTTP 403.
- **Rate Limit**: Key `alerts:acknowledge:<user>`, **60 requests / 60 seconds**.
- **Request Body Schema**:
  ```json
  {
    "id": "string (optional)",
    "ids": ["string"] // optional
  }
  ```
- **Processing Logic**:
  - `rawIds = Array.isArray(body.ids) ? body.ids : [body.id]`
  - Filters `typeof value === 'string'`, applies `.trim()`, drops empty values, deduplicates via `Set`.
  - Max IDs constant: `MAX_ACK_IDS = 200`.
- **Validation Errors (`400 Bad Request`)**:
  - If deduplicated `alertIds.length === 0`:
    ```json
    { "error": "Alert ID(s) required" }
    ```
  - If `alertIds.length > 200`:
    ```json
    { "error": "At most 200 alerts can be acknowledged at once" }
    ```
- **Repository Mutation**:
  - Executes `updateMany({ id: { $in: ids }, is_acknowledged: false }, { $set: { is_acknowledged: true } })`.
  - Persists **only** `is_acknowledged: true`.
  - Does **not** write `status`, `acknowledgedAt`, `acknowledgedBy`, or `note`.
- **Success Response `200 OK`**:
  ```json
  {
    "success": true,
    "acknowledged": 2,
    "requested": 2,
    "skipped": 0
  }
  ```
- **Error Response `500 Internal Server Error`**:
  ```json
  { "error": "Failed to acknowledge alert" }
  ```
- **Audit Logging**: None in current source.

##### TARGET GO MIGRATION REQUIREMENTS (PHASE 7.2)
- Replicate `MAX_ACK_IDS = 200`, `id`/`ids` dual input extraction, and `{ success: true, acknowledged, requested, skipped }` response.
- Best-effort audit logging to `xcloud_ops.app_audit_logs` may be added if required by Phase 7.2 governance alignment.

---

#### `POST /api/alerts/workflow`

##### CURRENT FROZEN CONTRACT
- **Route Handler**: `frontend/src/app/api/alerts/workflow/route.ts`
- **Access**: `requireAnyRole(request, ['root', 'operator'])`. In canonical RBAC, accessible by `admin` and `operator`; `viewer` receives HTTP 403.
- **Rate Limit**: Key `alerts:workflow:<user>`, **120 requests / 60 seconds**.
- **Request Body Schema**:
  ```json
  {
    "id": "alert-uuid", // required
    "status": "acknowledged | assigned | recovering | resolved", // required
    "assignedTo": "string (optional)",
    "note": "string (optional)"
  }
  ```
- **Field Name**: Primary identifier field is **`id`** (not `alertId`).
- **Allowed Workflow Statuses**: Exactly `['acknowledged', 'assigned', 'recovering', 'resolved']`. (`active` is **not** an accepted workflow status).
- **Text Cleaning Semantics (`cleanText`)**:
  - Value must be `string`. Trimmed. Empty string becomes `undefined`.
  - Truncated to a maximum of 80 characters via `slice(0, 80)`.
- **Validation Errors**:
  - Missing or empty `id` (`400 Bad Request`):
    ```json
    { "error": "Alert ID required" }
    ```
  - Invalid `status` value (`400 Bad Request`):
    ```json
    { "error": "Invalid alert workflow status" }
    ```
  - Alert not found (`404 Not Found`, when `matched === 0`):
    ```json
    { "error": "Alert not found" }
    ```
- **Repository Mutation & Persistence**:
  - Executes `updateOne({ id }, { $set })` on `xcloud_ops.app_alerts`.
  - Persisted `$set` fields:
    - `workflow_status`: `update.status`
    - `workflow_updated_at`: `new Date().toISOString()`
    - `assigned_to`: `update.assignedTo` (if defined)
    - `handling_note`: `update.note` (if defined)
    - `is_acknowledged`: `true` when `status === 'resolved'`
  - Filter: Matches strictly on `{ id }`. No optimistic version/CAS matching on `updatedAt`, `status`, or `_id`.
- **Success Response `200 OK`**:
  ```json
  {
    "success": true,
    "matched": 1,
    "modified": 1
  }
  ```
  Note: Returns `matched` and `modified` counts; does **not** return the updated Alert entity.
- **Error Response `500 Internal Server Error`**:
  ```json
  { "error": "Failed to update alert workflow" }
  ```
- **Audit Logging**: None in current source.

##### TARGET GO MIGRATION REQUIREMENTS (PHASE 7.2)
- Replicate 80-character text clamping, status set, and `{ success: true, matched, modified }` response.
- Concurrency hardening (e.g. CAS versioning) may be evaluated in Phase 7.2 if separately approved.

---

## 6. Notification Streaming Architecture & Contract

### 6.1 Server-Sent Events (SSE) Protocol

- **Endpoint**: `GET /api/notifications/stream`
- **Route Handler**: `frontend/src/app/api/notifications/stream/route.ts`
- **Access**: `requireAuth(request)`. All authenticated roles permitted (`admin`, `operator`, `viewer`).
- **Rate Limit**: **NONE**. No route-level fixed-window rate limiter exists on `/api/notifications/stream`.
- **Required Response Headers**:
  ```http
  Content-Type: text/event-stream; charset=utf-8
  Cache-Control: no-cache, no-transform
  Connection: keep-alive
  X-Accel-Buffering: no
  ```

### 6.2 Connection Lifecycle & Event Specification

#### CURRENT FROZEN CONTRACT

1. **Connection Initialization (`init` event)**:
   - Queries `listAlerts(15)` for initial snapshot.
   - Emits `event: init`:
     ```text
     event: init
     data: {"timestamp":"2026-09-25T01:00:00.000Z","user":"admin","role":"admin","alerts":{"activeCriticalCount":2,"activeWarningCount":3,"activeCount":5,"recent":[...]}}
     ```
2. **Periodic Check & Polling Loop**:
   - Polling interval: exactly **4000ms** (`setInterval`).
   - Session Revalidation: evaluates `validateCurrentAccount({ username: user, role: auth.auth.role, sv: auth.auth.sessionVersion })`. If invalid or revoked, emits `session_expired` event and closes the connection:
     ```text
     event: session_expired
     data: {}
     ```
   - Alert Update Detection: evaluates `listAlerts(10)`. If `alertData.activeCount !== lastAlertsCount`, updates internal counter and emits `alerts_update`:
     ```text
     event: alerts_update
     data: {"timestamp":"2026-09-25T01:00:04.000Z","activeCriticalCount":2,"activeWarningCount":3,"activeCount":5,"latestAlerts":[...]}
     ```
3. **Heartbeat & Transient Error Protocol**:
   - `lastHeartbeat` timer semantics: `lastHeartbeat` is initialized at stream start (`Date.now()`) and is updated **only** when a `:ping` comment is emitted. Alert updates do **not** reset `lastHeartbeat`.
   - Ping condition: If no alert update occurred in the polling interval (`!hasUpdate`) and elapsed time since the last heartbeat is at least 12,000ms (`now - lastHeartbeat >= 12000`), the handler updates `lastHeartbeat = now` and emits `:ping\n\n`.
   - Transient database error comment: Emits `:transient_retry\n\n` on MongoDB read errors during polling to keep client connection alive.
4. **Connection Teardown & Resource Cleanup**:
   - Client disconnect listener on `request.signal.addEventListener('abort', cleanup)` and `cancel()`.
   - Clears `intervalId` and closes `controller`. Zero resource leakage.

##### TARGET GO MIGRATION REQUIREMENTS (PHASE 7.3)
- Replicate 4s polling, 12s `:ping` heartbeat, `:transient_retry` comment, and exact event schemas.
- Use `http.Flusher` and `r.Context()` cancellation in a per-connection goroutine.

---

## 7. System Health Architecture & Contract

### 7.1 Separation from Container Probes

The system maintains two distinct health layers:

| Layer | Endpoints | Purpose | Dependencies | Consumers |
|-------|-----------|---------|--------------|-----------|
| **Orchestration Probes** | `/healthz`, `/readyz` | Liveness & Readiness for Docker / K8s / Systemd | `/healthz`: None (instant 200)<br>`/readyz`: Mongo ping | K8s kubelet, load balancer, systemd watchdog |
| **Platform Health Console** | `/api/system/health`<br>`/api/system/mongo/health` | Deep business & database telemetry diagnostics | Mongo collections, invariant aggregations, credential checks, slice audits | NOC Sentinel, Admin Dashboard, Health UI |

Container orchestration probes remain decoupled from deep diagnostic checks.

---

### 7.2 Endpoint Contracts

#### `GET /api/system/health`

##### CURRENT FROZEN CONTRACT
- **Route Handler**: `frontend/src/app/api/system/health/route.ts`
- **Access**: `requireAuth(request)` (`admin`, `operator`, `viewer`).
- **Rate Limit**: Key `system:health:<user>`, **30 requests / 60 seconds**.
- **Repository Invocation**: Calls `getComprehensiveSystemHealth()`.
- **Response `200 OK`**:
  ```json
  {
    "status": "healthy | degraded | critical",
    "score": 98,
    "checkedAt": "2026-09-25T01:00:00.000Z",
    "subsystems": {
      "database": {
        "status": "healthy",
        "latencyMs": 1.2,
        "xcloudDb": "xcloud",
        "appDb": "xcloud_ops",
        "ready": true,
        "totalCollections": 11,
        "existingCollections": 11,
        "missingCollectionsCount": 0,
        "missingIndexesCount": 0,
        "report": { /* ... */ }
      },
      "ocsEngine": { /* ... */ },
      "hssCore": { /* ... */ },
      "security": { /* ... */ }
    },
    "summary": {
      "totalAnomaliesDetected": 0,
      "actionableItemsCount": 0,
      "recommendations": []
    }
  }
  ```
- **Error Response `500 Internal Server Error`**:
  ```json
  {
    "status": "critical",
    "score": 0,
    "checkedAt": "2026-09-25T01:00:00.000Z",
    "error": "Comprehensive system health check failed"
  }
  ```

---

#### `GET /api/system/mongo/health`

##### CURRENT FROZEN CONTRACT
- **Route Handler**: `frontend/src/app/api/system/mongo/health/route.ts`
- **Access**: `requireAuth(request)` (`admin`, `operator`, `viewer`).
- **Rate Limit**: Key `system:mongo-health:<user>`, **30 requests / 60 seconds**.
- **Repository Invocation**: Calls `getMongoHealthReport()`.
- **Success Response `200 OK`**:
  Matches the authoritative `MongoHealthReport` type from `frontend/src/server/repositories/mongoHealthRepository.ts`:
  ```json
  {
    "ok": true,
    "database": "xcloud / xcloud_ops",
    "databases": {
      "xcloud": "xcloud",
      "app": "xcloud_ops"
    },
    "checkedAt": "2026-09-25T01:00:00.000Z",
    "latencyMs": 1.45,
    "collections": [
      {
        "database": "xcloud",
        "name": "subscribers",
        "exists": true,
        "documentCount": 100,
        "missingIndexes": []
      },
      {
        "database": "xcloud_ops",
        "name": "app_profiles",
        "exists": true,
        "documentCount": 10,
        "missingIndexes": []
      }
    ],
    "missingCollections": [],
    "missingIndexes": []
  }
  ```
- **Success Schema Invariants**:
  - `database`: String combining xcloud and app database names: `"${databases.xcloud} / ${databases.app}"` (default `"xcloud / xcloud_ops"`). Never `"xcloud"` alone.
  - `databases`: Object with string properties `xcloud` and `app` mapping role to configured DB name (`databases.xcloud` is a string, `databases.app` is a string). Never boolean/object maps like `{ "xcloud": { "ok": true } }`.
  - `collections`: Array of `CollectionHealth` items with `database` (string), `name` (string), `exists` (boolean), `documentCount` (number or null), `missingIndexes` (string[]).
  - `missingCollections`: Array of missing collection strings (format: `${databases[database]}.${collection}`).
  - `missingIndexes`: Array of objects with `collection` (string, format: `${databases[database]}.${collection}`) and `index` (string, the expected index name).
- **Failure Behavior**: On exception, the route handler returns HTTP **200 OK** (not 500) with diagnostic payload:
  ```json
  {
    "ok": false,
    "database": null,
    "databases": null,
    "checkedAt": "2026-09-25T01:00:00.000Z",
    "latencyMs": null,
    "collections": [],
    "missingCollections": [],
    "missingIndexes": [],
    "error": "MongoDB health check failed"
  }
  ```

---

## 8. System Audit & Self-Healing Architecture & Contract

### 8.1 System Integrity Diagnostics vs Retired Audit Console

Phase 5.7-C retired the user-facing audit inspection console (`/api/audit/*`).
The remaining `/api/system/audit/*` endpoints perform **System Integrity Diagnostics & Self-Healing** (HSS subscriber data structure repair, OCS balance reconciliation, and dangling profile cleanup).

---

### 8.2 Endpoint Contracts

#### `GET /api/system/audit/status`

##### CURRENT FROZEN CONTRACT
- **Route Handler**: `frontend/src/app/api/system/audit/status/route.ts`
- **Access**: `requireAuth(request)` (`admin`, `operator`, `viewer`).
- **Rate Limit**: Key `system:audit-status:<user>`, **60 requests / 60 seconds**.
- **Success Response `200 OK`**:
  ```json
  { "lastSaveTime": 1727226000 }
  ```
- **Error Response `500 Internal Server Error`**:
  ```json
  { "error": "Failed to retrieve system status" }
  ```

---

#### `POST /api/system/audit/scan`

##### CURRENT FROZEN CONTRACT
- **Route Handler**: `frontend/src/app/api/system/audit/scan/route.ts`
- **Access**: `requireAnyRole(request, ['root', 'operator'])`. `viewer` denied with HTTP 403.
- **Rate Limit**: Key `system:audit-scan:<user>`, **30 requests / 60 seconds**.
- **Semantics**: Strictly **READ-ONLY** despite using HTTP POST (due to complex cursor payload).
- **Read Dependency Inventory**:
  `scanSubscriberDocuments()` directly or indirectly reads across seven distinct data stores:
  1. `xcloud.subscribers` (HSS subscriber documents, authentication credentials, slice configs)
  2. `xcloud.ocs_subscribers` (OCS contract assignments and plan IDs)
  3. `xcloud.ocs_balances` (OCS balance records and data/voice/SMS quotas)
  4. `xcloud.ocs_reservations` (OCS active and released quota reservations)
  5. `xcloud.ocs_sessions` (OCS Gy/Ro charging sessions)
  6. `xcloud.ocs_tariff_plans` (OCS tariff plan definitions and rules)
  7. `xcloud_ops.app_profiles` (Profile template definitions obtained via `listProfiles()`, reading the profile repository collection)
- **Phase Dependency Matrix**:
  - `phase = reservation`: Reads `xcloud.ocs_reservations` and `xcloud.ocs_sessions`. Identifies orphaned quota reservations missing active sessions.
  - `phase = tariff`: Reads `xcloud.ocs_subscribers` and `xcloud.ocs_tariff_plans`. Identifies subscribers assigned to nonexistent or invalid tariff plans.
  - `phase = ocs`: Reads `xcloud.subscribers`, `xcloud.ocs_subscribers`, `xcloud.ocs_balances`, and `xcloud.ocs_tariff_plans`. Identifies missing configurations and data/voice/SMS balance invariant mismatches (`total != used + reserved + available`).
  - `phase = sub`: Reads `xcloud.subscribers` and profiles via `listProfiles()` (`xcloud_ops.app_profiles`). Identifies missing HSS authentication/slice configs and dangling profile references.
- **Read-Only Invariant**: All phases are strictly read-only. `scanSubscriberDocuments()` performs zero write, insert, update, or delete operations (`insertOne`, `insertMany`, `updateOne`, `updateMany`, `deleteOne`, `deleteMany`, `replaceOne`, `findOneAndUpdate`, `findOneAndDelete`, `findOneAndReplace`, `drop`).
- **Request Body**:
  ```json
  { "cursor": "0", "phase": "sub | ocs | tariff | reservation" }
  ```
  Defaults: `cursor = '0'`, `phase = 'sub'`.
- **Success Response `200 OK`**:
  ```json
  {
    "nextCursor": "1000",
    "scannedCount": 1000,
    "anomalies": [
      {
        "imsi": "460020000000001",
        "type": "missing_config | balance_mismatch | orphan_ocs | orphan_reservation | invalid_tariff | dangling_profile",
        "details": "string description",
        "severity": "critical | warning | info",
        "category": "hss | ocs | reservation | tariff | profile"
      }
    ]
  }
  ```
- **Error Response `500 Internal Server Error`**:
  ```json
  { "error": "Audit scan failed" }
  ```

---

#### `POST /api/system/audit/heal`

##### CURRENT FROZEN CONTRACT
- **Route Handler**: `frontend/src/app/api/system/audit/heal/route.ts`
- **Access**: `requireCapability(request, 'system_heal')` (`admin` or `operator`). `viewer` denied with HTTP 403.
- **Rate Limit**: Key `system:audit-heal:<user>`, **20 requests / 60 seconds**.
- **Request Body Schema**:
  ```json
  {
    "imsi": "460020000000001", // required, 15 digits or "UNKNOWN"
    "type": "string", // required (recognized repair types below)
    "profileName": "default (optional)"
  }
  ```
- **HTTP Boundary Validation**:
  - Missing `imsi` or `type` (`400 Bad Request`):
    ```json
    { "error": "imsi and type are required" }
    ```
  - Invalid IMSI format (`!/^\d{15}$|^UNKNOWN$/.test(String(imsi))`):
    ```json
    { "error": "IMSI must be exactly 15 digits or UNKNOWN" }
    ```
  - **Type Validation Distinction**: The HTTP route does **not** enforce an enum validator on `type`. Any non-empty string is accepted at the HTTP boundary. The anomaly types (`orphan_ocs`, `missing_config`, `balance_mismatch`, `invalid_tariff`, `dangling_profile`, `orphan_reservation`) describe the set of **Recognized repair types** handled by `healSubscriberDocument()`, **NOT** a strict route-enforced enum. An unrecognized `type` performs a no-op and returns HTTP 200.
- **Repository Mutation**: Calls `healSubscriberDocument(String(imsi), String(type), profileName)`.
- **Audit Logging**: Emits audit log via `logAudit('HEAL', String(imsi), null, { type, profileName }, request)`.
  Notice action string is **`HEAL`**.
- **Success Response `200 OK`**:
  ```json
  { "message": "Successfully applied targeted self-healing for 460020000000001" }
  ```
- **Error Response `500 Internal Server Error`**:
  ```json
  { "error": "Self-healing execution failed" }
  ```

---

#### `POST /api/system/audit/batch-heal`

##### CURRENT FROZEN CONTRACT
- **Route Handler**: `frontend/src/app/api/system/audit/batch-heal/route.ts`
- **Access**: `requireCapability(request, 'system_heal')` (`admin` or `operator`).
- **Rate Limit**: Key `system:audit-batch-heal:<user>`, **10 requests / 60 seconds**.
- **Request Body Schema**:
  ```json
  {
    "anomalies": [ /* array of anomaly objects */ ], // required, non-empty
    "profileName": "default (optional)"
  }
  ```
- **HTTP Boundary Validation**:
  - Validates solely that `anomalies` is an array and `anomalies.length > 0`. If missing or empty array, returns `400 Bad Request`:
    ```json
    { "error": "anomalies list is required and cannot be empty" }
    ```
  - The HTTP route does **not** perform strict per-item schema validation on elements within the `anomalies` array.
- **Repository Mutation & Execution**:
  - Calls `batchHealSubscriberDocuments(anomalies, profileName)`.
  - Repository iterates sequentially, applying `healSubscriberDocument(item.imsi, item.type, profileName)` to each item and returns:
    `{ successCount: number, failedCount: number, errors: string[] }`.
- **Audit Logging**: Emits audit log via `logAudit('HEAL', 'batch:${anomalies.length}', null, { count: anomalies.length, result, profileName }, request)`.
  Notice action string is **`HEAL`** (not `HEAL_BATCH`).
- **Success Response `200 OK`**:
  ```json
  {
    "message": "Successfully healed 15 of 15 anomalies",
    "successCount": 15,
    "failedCount": 0,
    "errors": []
  }
  ```
  Note: Field name is **`failedCount`** (derived from `systemAuditRepository.ts`). Fictional field `failureCount` does **not** exist in the current frozen contract.
- **Error Response `500 Internal Server Error`**:
  ```json
  { "error": "Batch self-healing execution failed" }
  ```

---

## 9. Analytics Init Platform Action Architecture & Contract

### 9.1 Endpoint Contract: `POST /api/analytics/init`

#### CURRENT FROZEN CONTRACT
- **Route Handler**: `frontend/src/app/api/analytics/init/route.ts`
- **Access**: `requireAnyRole(request, ['root', 'operator'])`.
- **Rate Limit**: Key `analytics:init:<user>`, **3 requests / 300 seconds**.
- **Semantics**: Strictly **READ-ONLY** on-demand aggregation. Despite HTTP POST, it creates zero database mutations.
- **Repository Call**: Calls `computeAnalyticsMetrics()`, the identical aggregation engine used by `GET /api/analytics/metrics`.
- **Success Response `200 OK`**:
  Matches the authoritative `AnalyticsMetrics` type from `frontend/src/server/repositories/analyticsRepository.ts`:
  ```json
  {
    "message": "MongoDB analytics are computed from subscriber documents on demand.",
    "metrics": {
      "totalTraffic": 10737418240,
      "plmnDist": [
        { "name": "46000", "value": 10 }
      ],
      "ratesDist": [
        { "name": "100Mbps", "value": 10 }
      ],
      "top5": [
        {
          "imsi": "460020000000001",
          "balance": 10737418240,
          "voiceBalance": 100,
          "smsBalance": 100
        }
      ],
      "timestamp": 1727226000000,
      "ocsBalances": {
        "totalSubscribers": 100,
        "totalDataAllocated": 1073741824000,
        "totalDataUsed": 107374182400,
        "totalDataReserved": 0,
        "totalDataAvailable": 966367641600,
        "dataUtilizationRate": 10.0,
        "totalVoiceAllocated": 10000,
        "totalVoiceUsed": 1000,
        "totalVoiceReserved": 0,
        "totalVoiceAvailable": 9000,
        "totalSmsAllocated": 10000,
        "totalSmsUsed": 500,
        "totalSmsAvailable": 9500,
        "validInvariantCount": 100,
        "brokenInvariantCount": 0,
        "allInvariantsOk": true
      },
      "ocsSessions": {
        "totalSessions": 5,
        "activeSessions": 5,
        "closingSessions": 0,
        "closedSessions": 0,
        "totalGrantedOctets": 524288000,
        "totalUsedOctets": 104857600,
        "interfaceGyCount": 5,
        "interfaceRoCount": 0,
        "apnDistribution": [
          { "apn": "default", "count": 5 }
        ]
      },
      "ocsReservations": {
        "totalReservations": 2,
        "activeReservations": 2,
        "settledReservations": 0,
        "releasedReservations": 0,
        "orphanedReservations": 0,
        "totalReservedOctets": 10485760,
        "totalReleasedOctets": 0,
        "totalUsedOctets": 0
      },
      "tariffPlanDist": [
        {
          "planId": "standard_postpaid",
          "name": "Standard Postpaid Plan",
          "subscriberCount": 100,
          "percentage": 100.0,
          "status": "active"
        }
      ],
      "ocsUsage": {
        "totalRecords": 500,
        "chargedRecords": 500,
        "totalInputOctets": 52428800,
        "totalOutputOctets": 52428800,
        "totalOctets": 104857600
      }
    }
  }
  ```
- **Top-Level `AnalyticsMetrics` Schema Keys**:
  - `totalTraffic`: number (aggregate data volume in bytes)
  - `plmnDist`: Array of `{ name: string, value: number }` (PLMN distribution)
  - `ratesDist`: Array of `{ name: string, value: number }` (rate tier distribution)
  - `top5`: Array of `{ imsi: string, balance: number, voiceBalance: number, smsBalance: number }` (top balance consumers)
  - `timestamp`: number (calculation epoch timestamp)
  - `ocsBalances`: `OcsBalanceMetrics` (balance pool invariant metrics)
  - `ocsSessions`: `OcsSessionMetrics` (active charging sessions telemetry)
  - `ocsReservations`: `OcsReservationMetrics` (quota reservation state counters)
  - `tariffPlanDist`: `TariffPlanDistItem[]` (plan distribution breakdown)
  - `ocsUsage`: `OcsUsageMetrics` (aggregate charging usage records)
- **Nested Schema Specifications**:
  - `ocsBalances`:
    - `totalSubscribers`: number
    - `totalDataAllocated`: number
    - `totalDataUsed`: number
    - `totalDataReserved`: number
    - `totalDataAvailable`: number
    - `dataUtilizationRate`: number
    - `totalVoiceAllocated`: number
    - `totalVoiceUsed`: number
    - `totalVoiceReserved`: number
    - `totalVoiceAvailable`: number
    - `totalSmsAllocated`: number
    - `totalSmsUsed`: number
    - `totalSmsAvailable`: number
    - `validInvariantCount`: number
    - `brokenInvariantCount`: number
    - `allInvariantsOk`: boolean
  - `ocsSessions`:
    - `totalSessions`: number
    - `activeSessions`: number
    - `closingSessions`: number
    - `closedSessions`: number
    - `totalGrantedOctets`: number
    - `totalUsedOctets`: number
    - `interfaceGyCount`: number
    - `interfaceRoCount`: number
    - `apnDistribution`: `Array<{ apn: string, count: number }>`
  - `ocsReservations`:
    - `totalReservations`: number
    - `activeReservations`: number
    - `settledReservations`: number
    - `releasedReservations`: number
    - `orphanedReservations`: number
    - `totalReservedOctets`: number
    - `totalReleasedOctets`: number
    - `totalUsedOctets`: number
  - `tariffPlanDist` items:
    - `planId`: string
    - `name`: string
    - `subscriberCount`: number
    - `percentage`: number
    - `status`: string
  - `ocsUsage`:
    - `totalRecords`: number
    - `chargedRecords`: number
    - `totalInputOctets`: number
    - `totalOutputOctets`: number
    - `totalOctets`: number
- **Nonexistent Fields Disclaimed**:
  Fictional fields such as `subscriberCount`, `activeSubscriberCount`, `balanceMetrics`, `sessionMetrics`, and `tariffDistribution` do **not** exist in the current production source.
- **Audit Logging**: None in current source.

##### TARGET GO MIGRATION REQUIREMENTS (PHASE 7.1)
- Replicate 3/300s rate limit and reuse existing Go `computeAnalyticsMetrics` implementation.

---

## 10. Background Processing & Scheduler Audit

An exhaustive audit of the codebase confirms:

1. **Daemon Cron Jobs**: Zero cron jobs, background task runners, or external queue workers exist in either Node or Go.
2. **Periodic Timers**:
   - `frontend/src/app/api/notifications/stream/route.ts`: Per-connection 4000ms polling timer inside active SSE stream handler. Terminated on connection close.
   - `frontend/src/app/login/LoginForm.tsx`: Per-browser UI cooldown countdown timer (`setInterval`) for rate-limited login attempts.
   - `frontend/src/components/ToastContainer.tsx`: Per-browser UI toast auto-dismiss timer.
3. **Backend Goroutines**:
   - `backend/internal/audit/writer.go`: Async worker pool for non-gating operation logging.
   - `backend/cmd/server/main.go`: Signal handler for graceful shutdown.
4. **Migration Requirement**: When migrating SSE to Go, use a per-request goroutine with `http.Flusher` and `context.Context` cancellation. Do not spawn global unmanaged goroutines.

---

## 11. Security, Authorization & RBAC Canonical Alignment

Phase 7 candidate authorization aligns with the canonical three-role model established in Phase 5.7-B:

| Domain / Action | Endpoint | `admin` | `operator` | `viewer` | Required Capability / Guard |
|-----------------|----------|:-------:|:----------:|:--------:|:---------------------------:|
| Alert Read | `GET /api/alerts` | ALLOW | ALLOW | ALLOW | `authenticated` |
| Alert Acknowledge | `POST /api/alerts/acknowledge` | ALLOW | ALLOW | DENY | `role: admin, operator` |
| Alert Workflow | `POST /api/alerts/workflow` | ALLOW | ALLOW | DENY | `role: admin, operator` |
| Notifications SSE | `GET /api/notifications/stream` | ALLOW | ALLOW | ALLOW | `authenticated` |
| System Health | `GET /api/system/health` | ALLOW | ALLOW | ALLOW | `authenticated` |
| Mongo Health | `GET /api/system/mongo/health` | ALLOW | ALLOW | ALLOW | `authenticated` |
| Audit Status | `GET /api/system/audit/status` | ALLOW | ALLOW | ALLOW | `authenticated` |
| Audit Scan | `POST /api/system/audit/scan` | ALLOW | ALLOW | DENY | `role: admin, operator` |
| Audit Heal | `POST /api/system/audit/heal` | ALLOW | ALLOW | DENY | `system_heal` |
| Audit Batch Heal | `POST /api/system/audit/batch-heal` | ALLOW | ALLOW | DENY | `system_heal` |
| Analytics Init | `POST /api/analytics/init` | ALLOW | ALLOW | DENY | `role: admin, operator` |

### 11.1 Fresh Actor Revalidation
Every mutation and the SSE stream polling cycle must perform fresh actor revalidation against `xcloud_ops.app_users` (`status == active`, `locked == false`, `sessionVersion == token.sessionVersion`).

### 11.2 Direct Execution Principle
Zero approval tickets (`app_approvals`) will be generated. All permitted mutations execute immediately upon validation.

---

## 12. Audit Logging & Evidence Contract

### 12.1 CURRENT FROZEN CONTRACT

- **Alert Mutations**:
  - `POST /api/alerts/acknowledge`: **Zero** audit records emitted in current Node implementation.
  - `POST /api/alerts/workflow`: **Zero** audit records emitted in current Node implementation.
- **System Integrity Mutations**:
  - `POST /api/system/audit/heal`: Emits action **`HEAL`** with target `imsi` via `logAudit('HEAL', String(imsi), null, { type, profileName }, request)`.
  - `POST /api/system/audit/batch-heal`: Emits action **`HEAL`** with target `batch:<count>` via `logAudit('HEAL', 'batch:${anomalies.length}', null, { count: anomalies.length, result, profileName }, request)`.
- **Authorization Denials**:
  - Middleware and route guards emit `AUTHORIZATION_DENIED` on forbidden attempts (HTTP 403).

### 12.2 TARGET GO MIGRATION REQUIREMENTS (PHASE 7.2 / 7.4)

- **Alert Domain (Phase 7.2)**: Go implementation may introduce best-effort internal operation logging to `xcloud_ops.app_audit_logs` (`ALERT_ACKNOWLEDGE`, `ALERT_WORKFLOW`) to align with the platform governance standard.
- **Self-Healing Domain (Phase 7.4)**: Go implementation will preserve `HEAL` action semantics with exact metadata payloads.

---

## 13. Concurrency Control & State Management

### 13.1 CURRENT FROZEN CONTRACT

- **Alert Workflow Concurrency**:
  - Uses standard `updateOne({ id }, { $set })` filter without optimistic versioning or CAS matching on `updatedAt`, `status`, or `_id`.
- **Alert Acknowledge Concurrency**:
  - Atomic bulk `updateMany({ id: { $in: ids }, is_acknowledged: false }, { $set: { is_acknowledged: true } })`.
- **Self-Healing Document Mutations**:
  - Updates to subscriber or balance documents during healing verify document existence and apply atomic MongoDB update operators (`$set`, `$setOnInsert`).

### 13.2 TARGET GO MIGRATION REQUIREMENTS (PHASE 7.2)

- Phase 7.2 may evaluate optimistic state matching on workflow status updates if approved during subphase specification.

---

## 14. Error Code & Contract Canonical Catalog

Source-derived exact error responses across all Phase 7 candidate endpoints:

| HTTP Status | Error JSON Shape | Originating Handler | Trigger Condition |
|-------------|------------------|---------------------|-------------------|
| 400 | `{"error": "Alert ID(s) required"}` | `alerts/acknowledge` | Empty or non-string alert IDs |
| 400 | `{"error": "At most 200 alerts can be acknowledged at once"}` | `alerts/acknowledge` | Alert IDs count exceeds 200 |
| 400 | `{"error": "Alert ID required"}` | `alerts/workflow` | Missing or empty `id` field |
| 400 | `{"error": "Invalid alert workflow status"}` | `alerts/workflow` | Status not in allowed set |
| 400 | `{"error": "imsi and type are required"}` | `system/audit/heal` | Missing `imsi` or `type` |
| 400 | `{"error": "IMSI must be exactly 15 digits or UNKNOWN"}` | `system/audit/heal` | Regex failure on IMSI |
| 400 | `{"error": "anomalies list is required and cannot be empty"}` | `system/audit/batch-heal` | Anomalies list is missing or empty array |
| 401 | `{"error": "Unauthorized"}` / `{"code": "AUTH_INVALID_TOKEN"}` | `requireAuth` | Missing or invalid auth token |
| 403 | `{"error": "Forbidden"}` / `{"code": "PERMISSION_DENIED"}` | `requireAnyRole` / `requireCapability` | Insufficient role or missing capability |
| 404 | `{"error": "Alert not found"}` | `alerts/workflow` | `matched === 0` on workflow update |
| 429 | `{"error": "Rate limit exceeded"}` | `enforceRateLimit` | Rate limit window exceeded |
| 500 | `{"error": "Alert fetch failed"}` | `alerts` | Exception in `listAlerts` |
| 500 | `{"error": "Failed to acknowledge alert"}` | `alerts/acknowledge` | Exception in `acknowledgeAlerts` |
| 500 | `{"error": "Failed to update alert workflow"}` | `alerts/workflow` | Exception in `updateAlertWorkflow` |
| 500 | `{"error": "Comprehensive system health check failed"}` | `system/health` | Exception in `getComprehensiveSystemHealth` |
| 200 (Fail) | `{"ok": false, "database": null, ..., "error": "MongoDB health check failed"}` | `system/mongo/health` | Exception in `getMongoHealthReport` (returns HTTP 200) |
| 500 | `{"error": "Failed to retrieve system status"}` | `system/audit/status` | Exception in status query |
| 500 | `{"error": "Audit scan failed"}` | `system/audit/scan` | Exception in `scanSubscriberDocuments` |
| 500 | `{"error": "Self-healing execution failed"}` | `system/audit/heal` | Exception in `healSubscriberDocument` |
| 500 | `{"error": "Batch self-healing execution failed"}` | `system/audit/batch-heal` | Exception in `batchHealSubscriberDocuments` |
| 502 | `{"code": "GO_BACKEND_UNREACHABLE"}` | `proxy.ts` | Reverse proxy failed to connect to Go backend |

---

## 15. Backward Compatibility & Migration Strategy

1. **Zero Frontend Path Changes**: Frontend SWR hooks and API clients continue using `/api/alerts`, `/api/notifications/stream`, etc.
2. **Safe Migration Phasing**:
   - Subphase 7.1: Go shadow implementation for read-only endpoints (Health, Audit Status, Scan, Analytics Init).
   - Subphase 7.2: Go implementation for Alert operational mutations.
   - Subphase 7.3: Go implementation for Notification SSE streaming.
   - Subphase 7.4: Go implementation for System Self-Healing mutations.
   - Subphase 7.5: Controlled cutover and production freeze.
3. **Fail-Closed Forwarding**: Next.js proxy forwards cutover routes to Go with zero silent fallback to Node.

---

## 16. Phase 7 Subphase Execution Roadmap

```text
Phase 7.0 (Current): Architecture Freeze & Contract Inventory
  |
  v
Phase 7.1: Platform Health & Diagnostic Read Parity
  - Go shadow: GET /api/system/health, GET /api/system/mongo/health,
               GET /api/system/audit/status, POST /api/system/audit/scan,
               POST /api/analytics/init, GET /api/alerts
  |
  v
Phase 7.2: Alert Domain Governance & Mutations
  - Go implementation: POST /api/alerts/acknowledge, POST /api/alerts/workflow
  - Direct execution, CAS concurrency, best-effort audit logging
  |
  v
Phase 7.3: Notification Streaming (SSE) Migration
  - Go SSE handler: GET /api/notifications/stream
  - http.Flusher streaming, 12s ping heartbeat, 4s polling loop, session revalidation
  |
  v
Phase 7.4: System Integrity Self-Healing Mutations
  - Go implementation: POST /api/system/audit/heal, POST /api/system/audit/batch-heal
  - Direct execution, role boundary (system_heal), audit evidence logging
  |
  v
Phase 7.5: Controlled Platform Services Cutover & Freeze
  - Update CUTOVER_TABLE from 36 to 47
  - ACTUALLY_ROUTED = 47
  - Final freeze documentation and production runbook
```

---

## 17. Testing & Verification Framework

Each subphase requires dedicated cross-engine test suites:
- `scripts/test-phase-7-architecture-freeze.mjs`: Validates 7.0 freeze invariants, candidate inventory, and doc reconciliation.
- Contract parity validation between Node and Go outputs (JSON shape, HTTP status codes, error messages).
- Real MongoDB integration tests against live replica set.
- Concurrency and connection leak validation for SSE streaming.

---

## 18. Quality Gates & Acceptance Criteria

To achieve completion of Phase 7.0:
1. `docs/architecture/phase-7-platform-services-architecture.md` created with complete 20 sections.
2. `scripts/test-phase-7-architecture-freeze.mjs` created and passing all assertions.
3. `AGENTS.md`, `docs/operations/todo.md`, `docs/operations/dev-log.md`, and `docs/backend-migration/migration-routing-matrix.md` reconciled.
4. CI workflow (`.github/workflows/ci.yml`) updated with Phase 7.0 freeze check.
5. Invariants preserved: `CUTOVER_TABLE = 36`, `ACTUALLY_ROUTED = 36`, zero runtime code changes.
6. All 14 regression test scripts pass.
7. Remote CI runs green on final SHA.

---

## 19. Frozen Boundary Declarations & Exclusions

- **OCS Charging Plane Exclusion**: Absolutely no modification or routing of charging plane collections (`ocs_sessions`, `ocs_reservations`, `ocs_usage`, `ocs_events`, `ocs_config`).
- **No External Message Broker**: WebSockets, Redis Pub/Sub, Kafka, and RabbitMQ remain strictly forbidden.
- **No Approval Workflow Reintroduction**: Approval tickets will not be reintroduced.
- **Pure ASCII Constraint**: All code, comments, and identifiers must remain pure ASCII.

---

## 20. Sign-off & Architecture Freeze Commitment

Phase 7.0 definitively freezes the contract, scope, and migration architecture for Platform Services.
No implementation code will be written until this freeze is committed, pushed, and verified via remote CI.

- **Baseline SHA**: `f3feaf69bfc0ed10cc67d5740c224ada3d8a5217`
- **Architecture Freeze Document**: `docs/architecture/phase-7-platform-services-architecture.md`
- **Validation Script**: `scripts/test-phase-7-architecture-freeze.mjs`
- **Target Cutover Table**: Unchanged at 36 routes (`ACTUALLY_ROUTED = 36`).
