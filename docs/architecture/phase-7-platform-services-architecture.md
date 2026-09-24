# Phase 7 - Alerts, Notifications & Platform Services Architecture Freeze

> Authoritative architecture freeze for Phase 7: Alerts, Notifications, System Health,
> System Integrity Audit & Self-Healing, and Analytics Platform Actions.
> This document defines the boundary, contracts, and migration roadmap for Phase 7.1+.
> Stable rules: `CLAUDE.md`. Current state: `AGENTS.md`.

---

## 1. Executive Summary & Phase 7 Scope Definition

Phase 7 encompasses the platform infrastructure, diagnostic, alerting, and notification services
supporting the xCloud operational console. Following the completion of Subscriber/Profile CRUD (Phase 4),
OCS Management Governance (Phase 5), and Authentication & User Management (Phase 6), Phase 7 migrates
the remaining operational platform and real-time event mechanisms into the canonical Go backend.

### 1.1 In-Scope Domains

Phase 7 exclusively owns and governs:

1. **Alert Domain**:
   - Querying active and acknowledged operational alerts (`GET /api/alerts`).
   - Acknowledging alert entries (`POST /api/alerts/acknowledge`).
   - Updating alert workflow lifecycle status, assignment, and notes (`POST /api/alerts/workflow`).
2. **Notification Streaming Domain**:
   - Real-time Server-Sent Events (SSE) telemetry stream (`GET /api/notifications/stream`).
   - Client event broadcasting (`init`, `alerts_update`, `session_expired`) and heartbeats (`:ping`, `:transient_retry`).
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

- **Authoritative Baseline SHA**: `a25a6b1c1289881406c048eea750c4a6150bb923`
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

The 11 candidate endpoints for Phase 7 migration:

| # | Endpoint | Method | Path | Current Owner | Target Owner | Semantics | Auth & Capability |
|---|----------|--------|------|---------------|--------------|-----------|-------------------|
| 1 | Alert List | `GET` | `/api/alerts` | Node | Go | Read | `admin`, `operator`, `viewer` |
| 2 | Alert Acknowledge | `POST` | `/api/alerts/acknowledge` | Node | Go | Mutation | `admin`, `operator` |
| 3 | Alert Workflow | `POST` | `/api/alerts/workflow` | Node | Go | Mutation | `admin`, `operator` |
| 4 | Notification Stream | `GET` | `/api/notifications/stream` | Node | Go | SSE Stream | `admin`, `operator`, `viewer` |
| 5 | System Health | `GET` | `/api/system/health` | Node | Go | Deep Read | `admin`, `operator`, `viewer` |
| 6 | Mongo Health | `GET` | `/api/system/mongo/health` | Node | Go | Deep Read | `admin`, `operator`, `viewer` |
| 7 | Audit Status | `GET` | `/api/system/audit/status` | Node | Go | Read | `admin`, `operator`, `viewer` |
| 8 | Audit Scan | `POST` | `/api/system/audit/scan` | Node | Go | Semantic Read | `admin`, `operator` |
| 9 | Audit Heal | `POST` | `/api/system/audit/heal` | Node | Go | Mutation | `admin`, `operator` (`system_heal`) |
| 10 | Audit Batch Heal | `POST` | `/api/system/audit/batch-heal` | Node | Go | Mutation | `admin`, `operator` (`system_heal`) |
| 11 | Analytics Init | `POST` | `/api/analytics/init` | Node | Go | Semantic Read | `admin`, `operator` |

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

### 5.1 Storage Model

- **Database**: `xcloud_ops`
- **Collection**: `app_alerts`
- **Cap / Retention**: Fixed rolling window of 10,000 documents (`ALERT_MAX_DOCS = 10000`). When exceeded, oldest acknowledged alerts are trimmed.
- **Indexes**:
  - `{ status: 1, severity: 1, createdAt: -1 }`
  - `{ alertId: 1 }` (unique)
  - `{ imsi: 1, status: 1 }`

### 5.2 Document Schema

```json
{
  "_id": "ObjectId",
  "alertId": "string (UUID / nanoId)",
  "imsi": "string (15 digits | null)",
  "type": "string (balance_exhaustion | rapid_drain | invariant_violation | subscriber_anomaly)",
  "severity": "critical | warning | info",
  "status": "active | acknowledged | assigned | recovering | resolved",
  "title": "string",
  "description": "string",
  "metadata": "object",
  "assignedTo": "string | null",
  "note": "string | null",
  "createdAt": "ISO date string",
  "updatedAt": "ISO date string",
  "acknowledgedAt": "ISO date string | null",
  "acknowledgedBy": "string | null",
  "resolvedAt": "ISO date string | null",
  "resolvedBy": "string | null"
}
```

### 5.3 Endpoint Contracts

#### `GET /api/alerts`
- **Access**: `requireAuth(request)` (any authenticated role: `admin`, `operator`, `viewer`).
- **Rate Limit**: 60 requests / 60 seconds.
- **Query Parameters**:
  - `limit`: integer, 1 to 100 (default: 50).
  - `status`: `all | active | acknowledged | resolved` (default: `active`).
  - `severity`: `all | critical | warning | info` (default: `all`).
- **Response `200 OK`**:
  ```json
  {
    "alerts": [ /* array of alert items */ ],
    "activeCount": 5,
    "activeCriticalCount": 2,
    "activeWarningCount": 3,
    "totalCount": 12
  }
  ```

#### `POST /api/alerts/acknowledge`
- **Access**: `requireAnyRole(request, ['admin', 'operator'])` (`root`/`super_admin`/`ops_admin` normalized). `viewer` denied with HTTP 403.
- **Rate Limit**: 30 requests / 60 seconds.
- **Payload**:
  ```json
  {
    "alertIds": ["string"], // required, non-empty array
    "note": "string (optional)"
  }
  ```
- **Operation**: Atomic bulk update of `app_alerts` setting `status = 'acknowledged'`, `acknowledgedAt = now`, `acknowledgedBy = currentUser.username`.
- **Response `200 OK`**:
  ```json
  {
    "success": true,
    "acknowledgedCount": 2
  }
  ```

#### `POST /api/alerts/workflow`
- **Access**: `requireAnyRole(request, ['admin', 'operator'])`. `viewer` denied with HTTP 403.
- **Rate Limit**: 30 requests / 60 seconds.
- **Payload**:
  ```json
  {
    "alertId": "string", // required
    "status": "active | acknowledged | assigned | recovering | resolved", // required
    "assignedTo": "string (optional)",
    "note": "string (optional)"
  }
  ```
- **Response `200 OK`**:
  ```json
  {
    "success": true,
    "alert": { /* updated alert item */ }
  }
  ```

---

## 6. Notification Streaming Architecture & Contract

### 6.1 Server-Sent Events (SSE) Protocol

- **Endpoint**: `GET /api/notifications/stream`
- **Access**: `requireAuth(request)`. All authenticated roles permitted.
- **Transport**: HTTP/1.1 or HTTP/2 chunked transfer stream.
- **Required Response Headers**:
  ```http
  Content-Type: text/event-stream; charset=utf-8
  Cache-Control: no-cache, no-transform
  Connection: keep-alive
  X-Accel-Buffering: no
  ```
- **Proxy Buffering**: `X-Accel-Buffering: no` ensures Nginx does not buffer stream chunks.

### 6.2 Connection Lifecycle & Event Specification

1. **Connection Initialization**:
   - Server sends `init` event immediately upon stream establishment:
     ```text
     event: init
     data: {"timestamp":"2026-09-25T01:00:00.000Z","alerts":{"activeCount":5,"activeCriticalCount":2,"activeWarningCount":3}}
     ```
2. **Periodic Check & Polling Loop**:
   - Connection loop evaluates changes every 4000ms.
   - Actor revalidation: evaluates `validateCurrentAccount({ username, role, sessionVersion })`. If invalid, sends `session_expired` event and terminates connection.
   - Alert count change: if `activeCount` changes from previous cycle, emits `alerts_update`:
     ```text
     event: alerts_update
     data: {"timestamp":"2026-09-25T01:00:04.000Z","activeCriticalCount":2,"activeWarningCount":3,"activeCount":5,"latestAlerts":[...]}
     ```
3. **Heartbeat Protocol**:
   - If no event payload is sent for 12000ms, server emits an SSE comment:
     ```text
     :ping
     ```
   - On transient database read errors during polling, server emits:
     ```text
     :transient_retry
     ```
4. **Client Termination**:
   - On client abort or tab close, `request.signal` abort listener clears polling interval and releases connection resources. Zero connection leak.

### 6.3 Architectural Boundary Declaration

The notification stream is intentionally designed without external pub/sub infrastructure (no Redis, no Kafka).
It operates as a lightweight, polling-backed SSE stream suited for on-premise carrier operations with concurrent operator consoles (<100 active connections).

---

## 7. System Health Architecture & Contract

### 7.1 Separation from Container Probes

The system maintains two distinct health layers:

| Layer | Endpoints | Purpose | Dependencies | Consumers |
|-------|-----------|---------|--------------|-----------|
| **Orchestration Probes** | `/healthz`, `/readyz` | Liveness & Readiness for Docker / K8s / Systemd | `/healthz`: None (instant 200)<br>`/readyz`: Mongo ping | K8s kubelet, load balancer, systemd watchdog |
| **Platform Health Console** | `/api/system/health`<br>`/api/system/mongo/health` | Deep business & database telemetry diagnostics | Mongo collections, invariant aggregations, credential checks, slice audits | NOC Sentinel, Admin Dashboard, Health UI |

These two layers serve distinct operational purposes and will remain separate. Container probes will not perform comprehensive business aggregations.

### 7.2 Endpoint Contracts

#### `GET /api/system/health`
- **Access**: `requireAuth(request)` (`admin`, `operator`, `viewer`).
- **Rate Limit**: 30 requests / 60 seconds.
- **Telemetry Subsystems**:
  1. `database`: Latency, existing collections, missing indexes report.
  2. `ocsEngine`: Allocated/used/reserved octets, utilization rate, balance invariants integrity, active sessions, orphaned reservations.
  3. `hssCore`: Subscriber counts, credentials validation, slice validity, profile attachment integrity.
  4. `security`: Admin configuration, active user counts, unacknowledged alerts, critical alerts.
- **Response `200 OK`**:
  ```json
  {
    "status": "healthy | degraded | critical",
    "score": 98,
    "checkedAt": "2026-09-25T01:00:00.000Z",
    "subsystems": {
      "database": { /* ... */ },
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

#### `GET /api/system/mongo/health`
- **Access**: `requireAuth(request)` (`admin`, `operator`, `viewer`).
- **Rate Limit**: 30 requests / 60 seconds.
- **Response `200 OK`**:
  ```json
  {
    "ok": true,
    "database": "xcloud",
    "databases": { "xcloud": { "ok": true }, "xcloud_ops": { "ok": true } },
    "checkedAt": "2026-09-25T01:00:00.000Z",
    "latencyMs": 1.45,
    "collections": [ /* list of collections with document counts */ ],
    "missingCollections": [],
    "missingIndexes": []
  }
  ```

---

## 8. System Audit & Self-Healing Architecture & Contract

### 8.1 System Integrity vs User-Facing Audit Console

Phase 5.7-C retired the user-facing audit inspection console (`/api/audit/*`).
The remaining `/api/system/audit/*` endpoints perform **System Integrity Diagnostics & Self-Healing** (HSS subscriber data structure repair, OCS balance reconciliation, and dangling profile cleanup).

### 8.2 Endpoint Contracts

#### `GET /api/system/audit/status`
- **Access**: `requireAuth(request)` (`admin`, `operator`, `viewer`).
- **Rate Limit**: 60 requests / 60 seconds.
- **Response `200 OK`**:
  ```json
  { "lastSaveTime": 1727226000 }
  ```

#### `POST /api/system/audit/scan`
- **Access**: `requireAnyRole(request, ['admin', 'operator'])`. `viewer` denied with HTTP 403.
- **Rate Limit**: 30 requests / 60 seconds.
- **Semantics**: Strictly **READ-ONLY** despite using HTTP POST (due to complex cursor payload).
- **Verification Proof**: Scans `xcloud.subscribers`, `xcloud.ocs_balances`, `xcloud.ocs_reservations`, and `xcloud.ocs_subscribers` via cursor paging. Performs zero write, insert, update, or delete operations.
- **Payload**:
  ```json
  { "cursor": "0", "phase": "sub | ocs | tariff | reservation" }
  ```
- **Response `200 OK`**:
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

#### `POST /api/system/audit/heal`
- **Access**: `requireCapability(request, 'system_heal')` (`admin` or `operator`). `viewer` denied with HTTP 403.
- **Rate Limit**: 20 requests / 60 seconds.
- **Payload**:
  ```json
  {
    "imsi": "460020000000001", // 15 digits or "UNKNOWN"
    "type": "missing_config | balance_mismatch | orphan_ocs | orphan_reservation | invalid_tariff | dangling_profile",
    "profileName": "default (optional)"
  }
  ```
- **Operation**: Direct execution repair of the subscriber record or balance document. Records operation audit log (`HEAL`).
- **Response `200 OK`**:
  ```json
  { "message": "Successfully applied targeted self-healing for 460020000000001" }
  ```

#### `POST /api/system/audit/batch-heal`
- **Access**: `requireCapability(request, 'system_heal')`.
- **Rate Limit**: 10 requests / 60 seconds.
- **Payload**:
  ```json
  {
    "anomalies": [ /* array of anomaly objects */ ],
    "profileName": "default (optional)"
  }
  ```
- **Response `200 OK`**:
  ```json
  {
    "message": "Successfully healed 15 of 15 anomalies",
    "successCount": 15,
    "failureCount": 0,
    "errors": []
  }
  ```

---

## 9. Analytics Init Platform Action Architecture & Contract

### 9.1 Endpoint Contract: `POST /api/analytics/init`

- **Access**: `requireAnyRole(request, ['admin', 'operator'])`.
- **Rate Limit**: 3 requests / 300 seconds.
- **Semantics**: Strictly **READ-ONLY** on-demand aggregation. Despite HTTP POST, it creates zero database mutations.
- **Behavior**: Calls the shared `computeAnalyticsMetrics()` engine across subscribers, OCS balances, sessions, and tariff plans.
- **Response `200 OK`**:
  ```json
  {
    "message": "MongoDB analytics are computed from subscriber documents on demand.",
    "metrics": {
      "subscriberCount": 1500,
      "activeSubscriberCount": 1420,
      "balanceMetrics": { /* ... */ },
      "sessionMetrics": { /* ... */ },
      "tariffDistribution": [ /* ... */ ]
    }
  }
  ```

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

Phase 7 adopts the canonical three-role model established in Phase 5.7-B:

| Domain / Action | Endpoint | `admin` | `operator` | `viewer` | Required Capability |
|-----------------|----------|:-------:|:----------:|:--------:|:-------------------:|
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

- **Target Collection**: `xcloud_ops.app_audit_logs`.
- **Mode**: Non-business-gating, best-effort internal operation logging.
- **Operations Logged**:
  - `POST /api/alerts/acknowledge`: Action `ALERT_ACKNOWLEDGE`
  - `POST /api/alerts/workflow`: Action `ALERT_WORKFLOW`
  - `POST /api/system/audit/heal`: Action `HEAL`
  - `POST /api/system/audit/batch-heal`: Action `HEAL_BATCH`
  - Authorization denials (HTTP 403) across all endpoints: Action `AUTHORIZATION_DENIED`
- **Fields**: `action`, `actor`, `actorRole`, `target`, `timestamp`, `metadata`, `clientIp`, `userAgent`.

---

## 13. Concurrency Control & State Management

1. **Alert Workflow Concurrency**:
   - Alert workflow updates use optimistic matching (`_id` and `updatedAt` / `status`) to prevent clobbering concurrent assignments.
2. **Self-Healing Document Mutations**:
   - Updates to subscriber or balance documents during healing verify document existence and apply atomic MongoDB update operators (`$set`, `$setOnInsert`).

---

## 14. Error Code & Contract Canonical Catalog

| HTTP Status | Error Code / JSON Shape | Trigger Condition |
|-------------|-------------------------|-------------------|
| 400 | `{"error": "imsi and type are required"}` | Missing required fields in heal request |
| 400 | `{"error": "IMSI must be exactly 15 digits or UNKNOWN"}` | Regex validation failure on IMSI |
| 400 | `{"error": "anomalies list is required and cannot be empty"}` | Empty batch anomalies list |
| 400 | `{"error": "alertIds must be a non-empty array"}` | Missing or empty alert IDs |
| 401 | `{"error": "Unauthorized"}` / `{"code": "AUTH_INVALID_TOKEN"}` | Missing or invalid auth token |
| 403 | `{"error": "Forbidden"}` / `{"code": "PERMISSION_DENIED"}` | Insufficient RBAC capability |
| 404 | `{"error": "Alert not found"}` | Target alert ID not found in database |
| 429 | `{"error": "Rate limit exceeded"}` | Fixed-window rate limit hit |
| 500 | `{"error": "Internal server error"}` | Unhandled database or operational error |
| 502 | `{"code": "GO_BACKEND_UNREACHABLE"}` | Reverse proxy failed to connect to Go backend |

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

- **Baseline SHA**: `a25a6b1c1289881406c048eea750c4a6150bb923`
- **Architecture Freeze Document**: `docs/architecture/phase-7-platform-services-architecture.md`
- **Validation Script**: `scripts/test-phase-7-architecture-freeze.mjs`
- **Target Cutover Table**: Unchanged at 36 routes (`ACTUALLY_ROUTED = 36`).
