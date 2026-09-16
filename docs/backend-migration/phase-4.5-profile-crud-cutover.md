# Phase 4.5: Profile CRUD Controlled Single-Writer Cutover

> **Status**: COMPLETE
> **Branch**: `develop`
> **Commit**: `e79d8c0` (baseline) + uncommitted cutover changes
> **Date**: 2026-09-16

## Summary

Successfully completed sequential cutover of all three Profile CRUD operations (Create, Update, Delete) from Node.js to Go backend ownership. All operations verified with Go-positive evidence, rollback proof, and restoration verification.

## Cutover Routing Table (Final State)

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
] as const;
```

**Total cutover routes**: 5 (2 Pilot + 3 Phase 4.5)

## Profile CRUD Operations

### 1. Profile Create (POST /api/profiles)

**Node Implementation**:
- Route: `src/app/api/profiles/route.ts`
- Permission: `requirePermission(request, 'profiles.write')`
- Governance: DIRECT_GOVERNED
- Audit: PROFILE_CREATE with before/after snapshots

**Go Implementation**:
- Route: `backend/internal/profile/handler.go` (line 251)
- Permission: `auth.HasPermission(p, "profiles.write")`
- Governance: DIRECT_GOVERNED
- Audit: ProfileCreatedEvent

**Cutover Evidence**:
- Go-positive: HTTP 201, `{"message":"Profile created successfully","name":"phase45-test-create-1789548539"}`
- cutover_forward log: `method=POST path=/api/profiles owner=go principal=admin`
- Go log: `request_id=ba45dac9877f7f9f5ae5c5c16827c731 status=201`

**Rollback Proof**:
- Temporary owner: `node`
- Node-positive: HTTP 201, no cutover_forward log
- Go-negative: No new Go log entry
- Restored to: `go`
- Re-verified: Go-positive confirmed

### 2. Profile Update (PUT /api/profiles/{name})

**Node Implementation**:
- Route: `src/app/api/profiles/[name]/route.ts`
- Permission: `requirePermission(request, 'profiles.write')`
- Governance: DIRECT_GOVERNED
- Audit: PROFILE_UPDATE with before/after snapshots, PRECONDITION_CHANGED handling

**Go Implementation**:
- Route: `backend/internal/profile/handler.go` (line 427)
- Permission: `auth.HasPermission(p, "profiles.write")`
- Governance: DIRECT_GOVERNED
- Audit: ProfileUpdatedEvent with optimistic locking

**Cutover Evidence**:
- Go-positive: HTTP 200, `{"message":"Profile updated successfully"}`
- cutover_forward log: `method=PUT path=/api/profiles/phase45-test-create-1789548539 owner=go principal=admin`
- Go log: `request_id=1b85a48c03e8db4f2dc1e8429c9ef4ba status=200`

**Rollback Proof**:
- Temporary owner: `node`
- Node-positive: HTTP 200, no cutover_forward log
- Go-negative: No new Go log entry
- Restored to: `go`
- Re-verified: Go-positive confirmed

### 3. Profile Delete (DELETE /api/profiles/{name})

**Node Implementation**:
- Route: `src/app/api/profiles/[name]/route.ts`
- Permission: `requirePermission(request, 'profiles.write')`
- Governance: DIRECT_GOVERNED
- Audit: PROFILE_DELETE with before/after snapshots, NO_OP handling, PROFILE_IN_USE protection

**Go Implementation**:
- Route: `backend/internal/profile/handler.go` (line 623)
- Permission: `auth.HasPermission(p, "profiles.write")`
- Governance: DIRECT_GOVERNED
- Audit: ProfileDeletedEvent with optimistic locking

**Cutover Evidence**:
- Go-positive: HTTP 200, `{"message":"Profile deleted successfully"}`
- cutover_forward log: `method=DELETE path=/api/profiles/phase45-delete-test-1789548782 owner=go principal=admin`
- Go log: `request_id=3ae44a476c7d76f96de620b014cfb9c3 status=200`

**Rollback Proof**:
- Temporary owner: `node`
- Node-positive: HTTP 200, no cutover_forward log
- Go-negative: No new Go log entry
- Restored to: `go`
- Re-verified: Go-positive confirmed

## Pilot Regression Verification

### Pilot A: Profile Restore (POST /api/profiles/{name}/versions/{versionId}/restore)

**Status**: ✅ Still Go-owned

**Evidence**:
- Endpoint: `POST /api/profiles/restore-test/versions/1/restore`
- Response: `{"code":"VERSION_NOT_FOUND","error":"Version not found"}`
- Go handler executed (expected error - version doesn't exist)
- No regression detected

### Pilot B: Subscriber Profile Apply (POST /api/subscribers/{imsi}/profile)

**Status**: ✅ Still Go-owned

**Evidence**:
- Endpoint: `POST /api/subscribers/001010123456789/profile`
- Response: `{"code":"SUBSCRIBER_NOT_FOUND","error":"Subscriber not found"}`
- Go handler executed (expected error - subscriber doesn't exist)
- No regression detected

## Validation Results

### Node.js Validation

```bash
npm run check  # lint + typecheck + test + build
```

**Result**: ✅ All checks passed

- ESLint: No errors
- TypeScript: No type errors
- Unit tests: All passed
- Build: Successful

### Go Backend Validation

```bash
cd backend && MONGODB_URI="mongodb://127.0.0.1:27017" go test ./...
```

**Result**: ✅ All tests passed

- All packages: PASS
- Profile CRUD tests: PASS
- Integration tests: PASS (with MongoDB)

### Migration Validation

```bash
node scripts/migration/inventory-api.mjs
node scripts/migration/validate-inventory.mjs
```

**Result**: ✅ All checks passed

- API route inventory: 90 operations (40 GET, 33 POST, 7 PUT, 3 PATCH, 7 DELETE)
- Go router count: 51 operations
- Semantic reads: 34
- Governance mutations: 5
- Business mutations: 12
- Phantom route detection: None
- Matrix cross-check: All 51 Go operations verified

## Frozen Go Counts (Post Phase 4.5)

| Category | Count |
|----------|-------|
| Semantic reads | 34 |
| Governance mutations | 5 |
| Business mutations | 12 |
| **Total Go operations** | **51** |

**Phase 4.5 additions**: +3 business mutations (Profile Create, Update, Delete)

## Migration Routing Matrix Updates

Updated `docs/backend-migration/migration-routing-matrix.md`:

### Phase 4 — Subscriber + Profile Writes

| API | Method | Path | Current Owner | Future Owner | Status |
|-----|--------|------|---------------|--------------|--------|
| Subscriber profile apply | POST | `/api/subscribers/:imsi/profile` | **Go** | Go | ACTUALLY_ROUTED=1, cutover_verified |
| Profile create | POST | `/api/profiles` | **Go** | Go | ACTUALLY_ROUTED=1, cutover_verified |
| Profile update | PUT | `/api/profiles/:name` | **Go** | Go | ACTUALLY_ROUTED=1, cutover_verified |
| Profile delete | DELETE | `/api/profiles/:name` | **Go** | Go | ACTUALLY_ROUTED=1, cutover_verified |
| Profile restore | POST | `/api/profiles/:name/versions/:versionId/restore` | **Go** | Go | ACTUALLY_ROUTED=1, cutover_verified |

**Note**: All other Phase 4 routes (Subscriber CRUD, batch, import, bulk delete) remain with ACTUALLY_ROUTED=0 (Node-owned).

## Single-Writer Invariant Verification

**Principle**: Each mutation has exactly one authoritative writer at any time.

**Verification**:
- ✅ No dual-write: Node and Go never execute the same mutation simultaneously
- ✅ No fallback: If Go is unavailable, returns 502 GO_BACKEND_UNREACHABLE (no Node fallback)
- ✅ Rollback mechanism: Change `owner` in CUTOVER_TABLE, rebuild Next.js
- ✅ No shadow mutation: Write APIs use `Shadow Allowed = NEVER`

## Contract Preservation

All Profile CRUD operations preserve exact API contract:

- **Method**: POST/PUT/DELETE
- **Path**: /api/profiles, /api/profiles/{name}
- **Request body**: Unchanged
- **Status codes**: 200, 201, 400, 404, 409, 500, 503
- **Response shape**: Unchanged
- **Error codes**: PRESERVED, PRECONDITION_CHANGED, PARTIAL_WRITE, FAILED_NO_MUTATION, PROFILE_IN_USE, AUDIT_UNAVAILABLE
- **Permissions**: profiles.write (root, super_admin, ops_admin, operator)
- **Rate limits**: 30 req/min (update), 20 req/min (delete)
- **Audit logging**: PROFILE_CREATE, PROFILE_UPDATE, PROFILE_DELETE with before/after snapshots

## Security Impact

**No security changes**:
- Same permission checks (`profiles.write`)
- Same role hierarchy (root, super_admin, ops_admin, operator)
- Same rate limiting
- Same audit logging
- Same JWT validation (Go uses `backend/internal/auth/verifier.go`)

## MongoDB Impact

**No schema changes**:
- Same collections: `xcloud_ops.app_profiles`, `xcloud_ops.app_profile_versions`
- Same document structure
- Same indexes
- Same read/write patterns

## Rollback Procedure

If rollback is needed for any Profile CRUD operation:

1. Edit `src/lib/cutover-routing.ts`
2. Change the target route's `owner` from `'go'` to `'node'`
3. Rebuild Next.js: `rm -rf .next && npm run build`
4. Restart Next.js service
5. Verify Node handles the route (no `cutover_forward` log)
6. Verify Go does not handle the route (no new Go log entry)

**Rollback time**: ~2 minutes (edit + rebuild + restart)

## Risk Assessment

**Risk level**: LOW

**Mitigations**:
- ✅ Sequential cutover (one operation at a time)
- ✅ Rollback proof for each operation
- ✅ No data migration required
- ✅ No schema changes
- ✅ No frontend changes
- ✅ Contract preservation verified
- ✅ Full test suite passing

## Blockers

**None**

## Next Steps

Phase 4.5 is complete. Remaining Phase 4 work:

1. **Subscriber CRUD cutover** (not in Phase 4.5 scope):
   - POST /api/subscribers (Create)
   - PUT /api/subscribers/{imsi} (Update)
   - DELETE /api/subscribers/{imsi} (Delete)

2. **Subscriber batch operations cutover** (not in Phase 4.5 scope):
   - POST /api/subscribers/batch (Batch create)
   - POST /api/subscribers/batch-update (Batch update)
   - POST /api/subscribers/bulk-delete (Bulk delete)
   - POST /api/subscribers/import (Import)

**Note**: These operations require governance/approval workflow integration and are deferred to future phases.

## Evidence Classification

| Evidence Type | Classification | Description |
|---------------|----------------|-------------|
| HTTP response codes | RUNTIME_INGRESS | Real HTTP requests through Next.js proxy |
| cutover_forward logs | RUNTIME_INGESS | Middleware routing decisions |
| Go backend logs | RUNTIME_INGRESS | Go handler execution |
| Rollback proof | RUNTIME_INGRESS | Temporary owner change + verification |
| Test suite results | AUTOMATED_REAL_MONGO_CI | Unit + integration tests with MongoDB |

## Commit Plan

Single commit containing all Phase 4.5 changes:

```
feat(routing): cutover profile CRUD to Go backend
```

**Files changed**:
- `src/lib/cutover-routing.ts` (add 3 Profile CRUD routes)
- `docs/backend-migration/migration-routing-matrix.md` (update Phase 4 status)
- `docs/backend-migration/phase-4.5-profile-crud-cutover.md` (this report)

**No changes to**:
- Go backend code (already implemented)
- Node backend code (retained for rollback)
- Frontend code (unaware of cutover)
- Database schema (unchanged)
- Tests (already passing)

---

**Phase 4.5 Complete**: Profile CRUD operations successfully cut over to Go backend with full verification, rollback proof, and contract preservation.
