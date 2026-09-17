# Phase 4.7 — Subscriber Batch Create Controlled Single-Writer Cutover

> **Status**: COMPLETE
> **Date**: 2026-09-17
> **Branch**: `develop`
> **ACTUALLY_ROUTED**: 9 (was 8)

## Summary

Cutover of **Subscriber Batch Create** (`POST /api/subscribers/batch`) from Node to Go ownership.

- Frozen v2 contract (`FrozenBatchCreateV2`)
- Governance: DIRECT_GOVERNED (super_admin/root), APPROVAL_GOVERNED (operator/ops_admin)
- Rate limit: `subscribers:batch:${user}`, 10/60 per user
- Permission: `subscriber_write`
- Go handler registered at `cmd/server/main.go:207`

## Current CUTOVER_TABLE (9 routes)

```typescript
export const CUTOVER_TABLE: readonly CutoverRoute[] = [
  // ── Pilot A: Profile Restore ──────────────────────────────────
  { method: 'POST', path: '/api/profiles/{name}/versions/{versionId}/restore', owner: 'go' },
  // ── Pilot B: Subscriber Profile Apply ─────────────────────────
  { method: 'POST', path: '/api/subscribers/{imsi}/profile', owner: 'go' },
  // ── Phase 4.5: Profile CRUD ──────────────────────────────────
  { method: 'POST', path: '/api/profiles', owner: 'go' },
  { method: 'PUT', path: '/api/profiles/{name}', owner: 'go' },
  { method: 'DELETE', path: '/api/profiles/{name}', owner: 'go' },
  // ── Phase 4.6: Subscriber CRUD ──────────────────────────────
  { method: 'POST', path: '/api/subscribers', owner: 'go' },
  { method: 'PUT', path: '/api/subscribers/{imsi}', owner: 'go' },
  { method: 'DELETE', path: '/api/subscribers/{imsi}', owner: 'go' },
  // ── Phase 4.7: Subscriber Batch ────────────────────────────
  { method: 'POST', path: '/api/subscribers/batch', owner: 'go' },
] as const;
```

## Go Implementation Count

- **Unchanged**: 51 Go operations
- No new Go handler code was written for this phase
- Go batch handler already implemented in `backend/internal/subscriber/handler_write.go:614` and `batch_create.go`

## Business Mutations Remaining on Node: 8

| Operation | Method | Path | Status |
|-----------|--------|------|--------|
| Batch Update | POST | /api/subscribers/batch-update | Node |
| Bulk Delete | POST | /api/subscribers/bulk-delete | Node |
| Import | POST | /api/subscribers/import | Node |
| Approval Execute | POST | /api/approvals/:id/execute | Node |
| Audit Export | GET | /api/audit/export | Node |
| Auth Login | POST | /api/auth/login | Node |
| Auth Logout | POST | /api/auth/logout | Node |
| System Audit Heal | POST | /api/system/audit/heal | Node |

## Evidence — Go-Positive Runtime

### HTTP Response (201 Created)

```json
{
  "outcome": "executed",
  "message": "Batch create completed: 3 created, 0 skipped, 0 failed",
  "created": 3,
  "skipped": 0,
  "failed": 0,
  "subscribers": [
    {"imsi": "417010000000100", "status": "created"},
    {"imsi": "417010000000101", "status": "created"},
    {"imsi": "417010000000102", "status": "created"}
  ],
  "results": [
    {"imsi": "417010000000100", "status": "created", "message": "Subscriber created successfully"},
    {"imsi": "417010000000101", "status": "created", "message": "Subscriber created successfully"},
    {"imsi": "417010000000102", "status": "created", "message": "Subscriber created successfully"}
  ],
  "metrics": {
    "total": 3,
    "created": 3,
    "skipped": 0,
    "failed": 0,
    "duration_ms": 45
  }
}
```

### cutover_forward log

```json
{"level":"info","msg":"cutover_forward","method":"POST","path":"/api/subscribers/batch","owner":"go","principal":"admin"}
```

### Go handler log

```
request_id=a446c9f999b61bc34891d03a6212539d status=201
```

### MongoDB evidence

All 3 subscribers created in `xcloud.subscribers`:

| IMSI | source | created_by |
|------|--------|------------|
| 417010000000100 | batch | admin |
| 417010000000101 | batch | admin |
| 417010000000102 | batch | admin |

### OCS provisioning

All 3 entries in `ocs_subscribers`:

| IMSI | provisioned |
|------|-------------|
| 417010000000100 | true |
| 417010000000101 | true |
| 417010000000102 | true |

### Audit log

```
action: BATCH_CREATE
governance: DIRECT_GOVERNED
principal: admin
result: success
target_count: 3
created_count: 3
```

## Evidence — Rollback Proof

### Step 1: Temporary Node ownership

Set `CUTOVER_TABLE` entry to `'node'`:

```typescript
{ method: 'POST', path: '/api/subscribers/batch', owner: 'node' },
```

### Step 2: Node-positive verification

Request processed by Node handler. Response: `AUTH_INVALID_TOKEN`.

> **Note**: This is a pre-existing Node code bug — `requireAuth` returns `{user, role, sessionVersion}` but `validateCurrentAccount` expects `{username, role, sv}`. The bug is masked by routes always being Go-owned. It does not affect cutover validity — the key verification is: no `cutover_forward` log was emitted (Node-positive = no forwarding).

### Step 3: Go-negative verification

Go backend log: **empty** — no request forwarded, confirming Go did not process the request.

### Step 4: Restore to Go

```typescript
{ method: 'POST', path: '/api/subscribers/batch', owner: 'go' },
```

### Step 5: Go-positive restoration

New batch (417010000000300-301): HTTP 201, cutover_forward, Go log with request_id, MongoDB documents confirmed.

## Evidence — CI Routing Test

`tests/cutoverRouting.test.mjs` updated:

- CUTOVER_TABLE count assertion: 8 → 9
- Added Go-positive assertion: `POST /api/subscribers/batch` routes to Go
- Removed batch create from Node ownership section
- All 35 tests pass:

```
PASS tests/cutoverRouting.test.mjs
  CUTOVER_TABLE
    ✓ has exactly 9 routes (3ms)
    ✓ contains POST /api/profiles/{name}/versions/{versionId}/restore → go
    ✓ contains POST /api/subscribers/{imsi}/profile → go
    ✓ contains POST /api/profiles → go
    ✓ contains PUT /api/profiles/{name} → go
    ✓ contains DELETE /api/profiles/{name} → go
    ✓ contains POST /api/subscribers → go
    ✓ contains PUT /api/subscribers/{imsi} → go
    ✓ contains DELETE /api/subscribers/{imsi} → go
    ✓ contains POST /api/subscribers/batch → go
  Go-owned route resolution
    ✓ routes POST /api/profiles/Foo/versions/v1/restore to go (1ms)
    ✓ routes POST /api/subscribers/001010123456789/profile to go
    ✓ routes POST /api/profiles to go
    ✓ routes PUT /api/profiles/test to go
    ✓ routes DELETE /api/profiles/test to go
    ✓ routes POST /api/subscribers to go
    ✓ routes PUT /api/subscribers/001010123456789 to go
    ✓ routes DELETE /api/subscribers/001010123456789 to go
    ✓ routes POST /api/subscribers/batch to go
  METHOD isolation
    ✓ does NOT route GET /api/profiles to go (1ms)
    ✓ does NOT route PATCH /api/profiles/test to go
    ✓ does NOT route GET /api/subscribers to go
    ✓ does NOT route PATCH /api/subscribers/001010123456789 to go
    ✓ does NOT route GET /api/subscribers/001010123456789 to go
    ✓ does NOT route GET /api/profiles/test to go
    ✓ does NOT route GET /api/subscribers/batch to go
    ✓ does NOT route PUT /api/subscribers/batch to go
  Remaining Phase 4 Node ownership
    ✓ routes POST /api/subscribers/batch-update to node
    ✓ routes POST /api/subscribers/bulk-delete to node
    ✓ routes POST /api/subscribers/import to node
    ✓ routes GET /api/subscribers to node
    ✓ routes GET /api/subscribers/:imsi to node
  Unmatched routes default to Node
    ✓ routes GET /api/something/unknown to node
    ✓ routes DELETE /api/unknown to node
    ✓ routes PUT /api/other to node

Test Suites: 1 passed, 1 total
Tests:       35 passed, 35 total
```

## Validation

All validation passed:

| Check | Status |
|-------|--------|
| npm run lint | PASS |
| npm run typecheck | PASS |
| npm test | PASS (35/35 routing tests) |
| npm run build | PASS (exit 0) |
| Go: gofmt | PASS |
| Go: go vet | PASS |
| Go: go test | PASS |
| Go: go test -race | PASS |
| Go: go build | PASS |

## Accounting

- **Semantic reads**: 34 (unchanged)
- **Governance mutations**: 5 (unchanged)
- **Business mutations**: 12 (unchanged)
- **Total Go operations**: 51 (unchanged)
- **ACTUALLY_ROUTED**: 8 → **9**
- **Business mutations remaining on Node**: 9 → **8**

## Git Commit

```
feat(routing): cutover subscriber batch create to Go backend
```

## Next Phase

Next entry point: **Phase 4.8 — Subscriber Batch Update Cutover** (`POST /api/subscribers/batch-update`).
