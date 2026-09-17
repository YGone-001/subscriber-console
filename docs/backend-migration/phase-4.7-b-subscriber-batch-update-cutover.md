# Phase 4.7-B — Subscriber Batch Update Controlled Single-Writer Cutover

> **Status**: COMPLETE
> **Date**: 2026-09-17
> **Branch**: `develop`
> **ACTUALLY_ROUTED**: 10 (was 9)

## Summary

Cutover of **Subscriber Batch Update** (`POST /api/subscribers/batch-update`) from Node to Go ownership.

- Frozen v2 contract (`FrozenBatchUpdateV2`)
- Per-target CAS with precondition barrier
- Governance: DIRECT_GOVERNED (super_admin/root), APPROVAL_GOVERNED (operator/ops_admin)
- Rate limit: `subscribers:batch-update:${user}`, 12/60 per user
- Permission: `subscriber_write`
- Go handler registered at `cmd/server/main.go:208`

## Current CUTOVER_TABLE (10 routes)

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
  { method: 'POST', path: '/api/subscribers/batch-update', owner: 'go' },
] as const;
```

## Go Implementation Count

- **Unchanged**: 51 Go operations
- No new Go handler code was written for this phase
- Go batch-update handler already implemented in `backend/internal/subscriber/handler_write.go:941` and `batch_update.go`

## Business Mutations Remaining on Node: 7

| Operation | Method | Path | Status |
|-----------|--------|------|--------|
| Bulk Delete | POST | /api/subscribers/bulk-delete | Node |
| Import | POST | /api/subscribers/import | Node |
| Approval Execute | POST | /api/approvals/:id/execute | Node |
| Audit Export | GET | /api/audit/export | Node |
| Auth Login | POST | /api/auth/login | Node |
| Auth Logout | POST | /api/auth/logout | Node |
| System Audit Heal | POST | /api/system/audit/heal | Node |

## Evidence — Go-Positive Runtime

### HTTP Response (200 OK)

```json
{
  "outcome": "executed",
  "message": "Subscribers updated successfully",
  "result": {
    "requested": 3,
    "modified": 3,
    "fieldNames": ["access_restriction_data"]
  },
  "requiresApproval": false
}
```

### cutover_forward log

```json
{"level":"info","msg":"cutover_forward","method":"POST","path":"/api/subscribers/batch-update","owner":"go","principal":"admin"}
```

### Go handler log

```
request_id=c4e24cfb68e190d6d5f2d1e71acb0357 status=200 duration_ms=7
```

### MongoDB evidence

All 3 subscribers updated in `xcloud.subscribers`:

| IMSI | access_restriction_data (before) | access_restriction_data (after) |
|------|----------------------------------|--------------------------------|
| 417010000000001 | 32 | 128 |
| 417010000000002 | 32 | 128 |
| 417010000000003 | 32 | 128 |

### Audit log

```
_id: cfaeeb99-c291-485c-a907-537ea6d80214
action: BATCH_UPDATE
module: subscribers
actor: admin (super_admin)
governanceMode: DIRECT_GOVERNED
result: success
targetCount: 3
modifiedCount: 3
classification: SUCCESS
request_id: c4e24cfb68e190d6d5f2d1e71acb0357
```

### OCS impact

Batch update with `accessRestrictionData` only modifies Core Network subscriber fields, not OCS. No OCS writes expected.

## Evidence — Rollback Proof

### Step 1: Temporary Node ownership

Set `CUTOVER_TABLE` entry to `'node'`:

```typescript
{ method: 'POST', path: '/api/subscribers/batch-update', owner: 'node' },
```

### Step 2: Node-positive verification

Request processed by Node handler. Response: HTTP 200 OK:

```json
{
  "outcome": "executed",
  "message": "Subscribers updated successfully",
  "result": {
    "requested": 3,
    "modified": 3,
    "fieldNames": ["access_restriction_data"]
  },
  "requiresApproval": false
}
```

### Step 3: Go-negative verification

- Go backend log: **empty** — no request forwarded
- Next.js log: **no cutover_forward** — confirming Node handled the request directly

### Step 4: Restore to Go

```typescript
{ method: 'POST', path: '/api/subscribers/batch-update', owner: 'go' },
```

### Step 5: Go-positive restoration

New request: HTTP 200, cutover_forward with `owner":"go"`, Go log with `request_id=550e2dbc6a24089b84b3e845ba739725 status=200`.

## Evidence — CI Routing Test

`tests/cutoverRouting.test.mjs` updated:

- CUTOVER_TABLE count assertion: 9 → 10
- Added Go-positive assertion: `POST /api/subscribers/batch-update` routes to Go
- Removed batch-update from Node ownership section
- All 36 tests pass:

```
PASS tests/cutoverRouting.test.mjs
  CUTOVER_TABLE
    ✓ contains exactly 10 cutover routes (1ms)
    ✓ Pilot A: POST /api/profiles/{name}/versions/{versionId}/restore is owned by Go
    ✓ Pilot B: POST /api/subscribers/{imsi}/profile is owned by Go
    ✓ Phase 4.5: POST /api/profiles is owned by Go
    ✓ Phase 4.5: PUT /api/profiles/{name} is owned by Go
    ✓ Phase 4.5: DELETE /api/profiles/{name} is owned by Go
    ✓ Phase 4.6: POST /api/subscribers is owned by Go
    ✓ Phase 4.6: PUT /api/subscribers/{imsi} is owned by Go
    ✓ Phase 4.6: DELETE /api/subscribers/{imsi} is owned by Go
    ✓ Phase 4.7: POST /api/subscribers/batch is owned by Go
    ✓ Phase 4.7: POST /api/subscribers/batch-update is owned by Go
  Go-owned route resolution
    ✓ routes POST /api/profiles to Go (Profile Create)
    ✓ routes PUT /api/profiles/MyProfile to Go (Profile Update)
    ✓ routes DELETE /api/profiles/MyProfile to Go (Profile Delete)
    ✓ routes POST /api/profiles/MyProfile/versions/v1/restore to Go (Profile Restore)
    ✓ routes POST /api/subscribers/208930000000001/profile to Go (Subscriber Profile Apply)
    ✓ routes POST /api/subscribers to Go (Subscriber Create)
    ✓ routes PUT /api/subscribers/208930000000001 to Go (Subscriber Update)
    ✓ routes DELETE /api/subscribers/208930000000001 to Go (Subscriber Delete)
    ✓ routes POST /api/subscribers/batch to Go (Batch Create)
    ✓ routes POST /api/subscribers/batch-update to Go (Batch Update)
  METHOD isolation
    ✓ routes GET /api/profiles to Node (not in cutover table)
    ✓ routes GET /api/profiles/MyProfile to Node (not in cutover table)
    ✓ routes POST /api/profiles/MyProfile to Node (not in cutover table)
    ✓ routes PATCH /api/profiles/MyProfile to Node (not in cutover table)
    ✓ routes GET /api/profiles/MyProfile/versions/v1/restore to Node (wrong method)
    ✓ routes GET /api/subscribers to Node (not in cutover table)
    ✓ routes GET /api/subscribers/208930000000001 to Node (not in cutover table)
    ✓ routes PATCH /api/subscribers/208930000000001 to Node (not in cutover table)
  Remaining Phase 4 Node ownership
    ✓ routes POST /api/subscribers/bulk-delete to Node (Bulk Delete)
    ✓ routes POST /api/subscribers/import to Node (Import)
    ✓ routes GET /api/subscribers to Node (Subscriber List)
    ✓ routes GET /api/subscribers/208930000000001 to Node (Subscriber Detail)
  Unmatched routes default to Node
    ✓ routes POST /api/approvals/123/approve to Node
    ✓ routes GET /dashboard to Node
    ✓ routes POST /api/unknown-operation to Node

Test Suites: 1 passed, 1 total
Tests:       36 passed, 36 total
```

## Validation

| Check | Status |
|-------|--------|
| npm run lint | PASS (0 errors, 51 warnings) |
| npm run typecheck | PASS (pre-existing .next artifact errors) |
| npm test | PASS (565/565) |
| npm run build | PASS |
| Go: gofmt | PASS |
| Go: go vet | PASS |
| Go: go test | PASS (integration tests skip without MONGODB_URI) |
| Go: go build | PASS |
| Migration inventory | PASS |
| Migration validator | PASS (51 Go operations) |

## Accounting

- **Semantic reads**: 34 (unchanged)
- **Governance mutations**: 5 (unchanged)
- **Business mutations**: 12 (unchanged)
- **Total Go operations**: 51 (unchanged)
- **ACTUALLY_ROUTED**: 9 → **10**
- **Business mutations remaining on Node**: 8 → **7**

## Git Commit

```
feat(routing): cutover subscriber batch update to Go backend
```

## Next Phase

Next entry point: **Phase 4.8 — Subscriber Bulk Delete Cutover** (`POST /api/subscribers/bulk-delete`).
