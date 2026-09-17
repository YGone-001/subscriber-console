# Phase 4.7-C — Subscriber Import Controlled Single-Writer Cutover

> **Status**: COMPLETE
> **Date**: 2026-09-17
> **Branch**: `develop`
> **ACTUALLY_ROUTED**: 11 (was 10)

## Summary

Cutover of **Subscriber Import** (`POST /api/subscribers/import`) from Node to Go ownership.

- Frozen v2 contract (`FrozenImportV2`)
- Supports `?mode=precheck` (semantic read) and `?mode=import` (governed mutation)
- Governance: DIRECT_GOVERNED (super_admin/root), APPROVAL_GOVERNED (operator/ops_admin)
- Rate limit: `subscribers:import:${user}`, 12/60 per user
- Permission: `subscriber_write`
- Go handler registered at `cmd/server/main.go:210`

## Current CUTOVER_TABLE (11 routes)

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
  { method: 'POST', path: '/api/subscribers/import', owner: 'go' },
] as const;
```

## Go Implementation Count

- **Unchanged**: 51 Go operations
- No new Go handler code was written for this phase
- Go import handler already implemented in `backend/internal/subscriber/handler_write.go:1747` and `import.go`

## Business Mutations Remaining on Node: 6

| Operation | Method | Path | Status |
|-----------|--------|------|--------|
| Bulk Delete | POST | /api/subscribers/bulk-delete | Node |
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
  "message": "Subscribers imported successfully",
  "requiresApproval": false,
  "result": {
    "requested": 3,
    "imported": 3,
    "skipped": 0,
    "failed": 0,
    "importedImsis": ["417010000000604", "417010000000605", "417010000000606"],
    "failedImsis": [],
    "ocsProvisioningFailedImsis": []
  }
}
```

### cutover_forward log

```json
{"level":"info","msg":"cutover_forward","method":"POST","path":"/api/subscribers/import","owner":"go","principal":"admin"}
```

### Go handler log

```
request_id=079df8d1ced22458aa4e00ea78c6c624 status=200 duration_ms=8
```

### MongoDB evidence

All 3 subscribers created in `xcloud.subscribers`:

| IMSI |
|------|
| 417010000000604 |
| 417010000000605 |
| 417010000000606 |

### OCS provisioning

All 3 entries in `xcloud.ocs_subscribers`:

| IMSI | plan_id | status |
|------|---------|--------|
| 417010000000604 | default_plan | active |
| 417010000000605 | default_plan | active |
| 417010000000606 | default_plan | active |

### Audit log

```
_id: 3343820f-00da-4235-abd2-528020d74d24
action: subscriber.import
module: subscribers
actor: admin (super_admin)
governanceMode: DIRECT_GOVERNED
result: success
requested: 3
createdCount: 3
classification: SUCCESS
riskLevel: high
operationFingerprint: 7ef2808eeb574912479177112dcf747c5343075fc1db7551dacbb6bc76234536
```

## Evidence — Rollback Proof

### Step 1: Temporary Node ownership

Set `CUTOVER_TABLE` entry to `'node'`:

```typescript
{ method: 'POST', path: '/api/subscribers/import', owner: 'node' },
```

### Step 2: Node-positive verification

Request processed by Node handler. Response: HTTP 200 OK:

```json
{
  "outcome": "executed",
  "message": "Subscribers imported successfully",
  "result": {
    "requested": 1,
    "imported": 1,
    "skipped": 0,
    "failed": 0,
    "importedImsis": ["417010000000608"],
    "failedImsis": [],
    "ocsProvisioningFailedImsis": []
  }
}
```

### Step 3: Go-negative verification

- Go backend log: **0 import entries** — no request forwarded
- Next.js log: **0 cutover_forward entries** — confirming Node handled the request directly

### Step 4: Restore to Go

```typescript
{ method: 'POST', path: '/api/subscribers/import', owner: 'go' },
```

### Step 5: Go-positive restoration

New request: HTTP 200, cutover_forward with `owner":"go"`, Go log with `request_id=2efacb24227fcbae9e642f8dd7922076 status=200`.

## Evidence — CI Routing Test

`tests/cutoverRouting.test.mjs` updated:

- CUTOVER_TABLE count assertion: 10 → 11
- Added Go-positive assertion: `POST /api/subscribers/import` routes to Go
- Removed import from Node ownership section
- All 37 tests pass

## Validation

| Check | Status |
|-------|--------|
| npm run lint | PASS (0 errors, 51 warnings) |
| npm test | PASS (566/566) |
| npm run build | PASS |
| Go: gofmt | PASS |
| Go: go vet | PASS |
| Go: go build | PASS |
| Migration inventory | PASS |
| Migration validator | PASS (51 Go operations) |

## Accounting

- **Semantic reads**: 34 (unchanged)
- **Governance mutations**: 5 (unchanged)
- **Business mutations**: 12 (unchanged)
- **Total Go operations**: 51 (unchanged)
- **ACTUALLY_ROUTED**: 10 → **11**
- **Business mutations remaining on Node**: 7 → **6**

## Git Commit

```
feat(routing): cutover subscriber import to Go backend
```

## Next Phase

Next entry point: **Phase 4.8 — Subscriber Bulk Delete Cutover** (`POST /api/subscribers/bulk-delete`).
