# Phase 8.4 - Frontend Dependency & Residual Node Runtime Cleanup

Evidence document for the Phase 8.4 cleanup of the frontend dependency set and of the
residual Node-era runtime surface that survived the Phase 8.3 physical backend removal.

Status: IMPLEMENTED / NOT SELF-FROZEN (independent Phase 8.4 acceptance pending).

This document records the **post-cleanup current state**. The Phase 8.3 evidence
(`docs/backend-migration/phase-8.3-next-backend-removal.md`) and the Phase 8.0-8.2
inventory / parity / cutover evidence are **not rewritten**; they remain the
authoritative historical record of the pre-cleanup state.

- Acceptance suite: `scripts/test-phase-8-frontend-dependency-cleanup.mjs`
- Frozen predecessor suite (historical evidence, no longer run by CI):
  `scripts/test-phase-8-next-backend-removal.mjs`
- Removal-completion validator (still run by CI): `scripts/test-phase-8-backend-removal-readiness.mjs`

---

## 1. Authoritative Starting SHA

```text
phase84_start_sha = 342589aa5c00cb8152980c77bfc73f05b82ca64a
```

This is the independently accepted Phase 8.3 boundary. The Phase 8.4 branch tip at the
time the work started was `cc9a37e` (the boundary commit plus one docs-only commit that
recorded the independent acceptance freeze); the delta between the two commits touches
documentation only, so all boundary manifests and production sources referenced here are
byte-identical to the accepted boundary.

---

## 2. Scope and Final Invariants

Phase 8.4 removes every frontend dependency and every residual Node-era runtime
capability that no longer has a producer or a consumer, while preserving the exact
production guarantees established by Phase 8.3.

```text
frontend_dependencies_before    = 20   (9 dependencies + 11 devDependencies)
frontend_dependencies_after     = 19
frontend_dependencies_removed   = 1    (bcryptjs)
frontend_dependency_unclassified = 0
frontend_unused_direct_dependencies = 0

residual_lib_removed            = 5    (proven dead Node-era libs)
residual_lib_unclassified       = 0
dead_node_era_libs_remaining    = 0

frontend_business_collection_constants        = 0
frontend_xcloud_db_helpers                    = 0
frontend_generic_business_collection_helpers  = 0

proxy_session_mongo_collections = 1
proxy_session_mongo_collection  = app_users
proxy_session_mongo_readers     = 1
proxy_session_mongo_writers     = 0

go_registered_operations = 84
go_cutover_operations    = 84
CUTOVER_TABLE            = 84 (byte-frozen, unchanged)
ACTUALLY_ROUTED          = 84 (unchanged)

backend_production_changes    = 0
root_package_json_changed     = false
root_package_lock_changed     = false
next_business_backend_removed = true
backend_removal_ready         = true
```

Explicit architectural statement:

```text
Next.js business backend removed = YES
Next.js proxy/session runtime     = STILL PRESENT
Frontend Mongo business access    = NO
Frontend Mongo session access     = app_users READ-ONLY ONLY
```

---

## 3. Starting Dependency Manifest

At the boundary SHA `frontend/package.json` declared:

```text
dependencies (9):
  bcryptjs
  jose
  lucide-react
  mongodb
  next
  react
  react-dom
  recharts
  swr

devDependencies (11):
  @tailwindcss/postcss
  @types/node
  @types/react
  @types/react-dom
  eslint
  eslint-config-next
  jiti
  rimraf
  tailwindcss
  tsx
  typescript

total = 20
```

Note: the Phase 8.4 specification prose states "9 dependencies + 10 devDependencies =
19". The real boundary manifest contains 11 devDependencies (20 total). The acceptance
suite derives the before/after/removed triple from `git show 342589aa…:frontend/package.json`
rather than from the specification prose, so the recorded before value is 20.

---

## 4. Direct Dependency Classification

Every declared direct dependency is classified from a derived consumer graph (source
imports, test imports, config imports, package scripts, structural roles). Classes:

```text
KEEP_RUNTIME_UI              UI rendering / framework runtime
KEEP_RUNTIME_PROXY           proxy.ts runtime dependency
KEEP_RUNTIME_SESSION         account/session validation runtime dependency
KEEP_TEST_TOOLING            test harness dependency
KEEP_BUILD_TOOLING           build toolchain dependency
KEEP_PACKAGE_SCRIPT_TOOLING  declared tool invoked by package scripts
REMOVE_UNUSED                zero consumers
```

Result: 19 retained, all classified, `frontend_dependency_unclassified = 0`,
`frontend_unused_direct_dependencies = 0`.

---

## 5. Removed Dependencies

```text
bcryptjs  -> REMOVE_UNUSED
```

Evidence of zero consumption after Phase 8.3:

- no `frontend/src/**` import;
- no `frontend/tests/**` import;
- no build or lint configuration reference;
- no package script reference;
- password hashing is owned exclusively by the Go backend.

`bcryptjs` is removed from `frontend/package.json` and from
`frontend/package-lock.json`. Note that `bcryptjs` remains a **root** repository
dependency used by root-level operational scripts (`scripts/init-mongo-indexes.mjs`,
cross-engine test harnesses); the root manifest is out of scope and byte-unchanged.

---

## 6. Retained Dependencies and Consumers

The three dependencies whose retention is security-critical:

```text
jose       -> KEEP_RUNTIME_PROXY     consumed by frontend/src/proxy.ts (HS256 JWT verify)
mongodb    -> KEEP_RUNTIME_SESSION   consumed by frontend/src/lib/sessionMongo.ts (read-only)
jiti       -> KEEP_TEST_TOOLING      consumed by the frontend test harness loader
```

No retained dependency version was changed: `retained_dependency_versions_unchanged = true`.
Phase 8.4 is a removal phase, not an upgrade phase.

---

## 7. Frontend vs Root Package Boundary

- `frontend/package.json` / `frontend/package-lock.json`: the only manifests modified by
  Phase 8.4 (the single `bcryptjs` removal).
- `package.json` / `package-lock.json` (repository root): byte-unchanged vs the boundary
  SHA (`root_package_json_changed = false`, `root_package_lock_changed = false`).

Root dependencies (`@next/env`, `bcryptjs`, `jiti`, `jose`, `mongodb`) continue to serve
root-level acceptance suites and operational scripts. CI installs both the root and the
frontend dependency sets before the Phase 8.4 runtime verification.

---

## 8. Residual Node-Era Lib Classification

Every surviving file under `frontend/src/lib/**` was re-classified from a derived
consumer graph (runtime-reachable edges + explicit imports + test imports). Libs with
zero consumers and zero runtime reachability were deleted.

Deleted (proven dead after the Phase 8.3 removal):

```text
frontend/src/lib/profileAudit.ts          Node-era business audit helpers (zero consumers)
frontend/src/lib/subscriberContract.ts    Node-era subscriber contract helpers (zero consumers)
frontend/src/lib/audit/sanitize.ts        Node-era audit sanitizers (only consumer was ChangeDiff)
frontend/src/lib/plmnUtils.ts             never imported by any tracked revision (git history proof)
frontend/src/lib/plmn_db.ts               never imported by any tracked revision (git history proof)
```

The forced consumer of `audit/sanitize.ts` was also deleted:

```text
frontend/src/components/governance/ChangeDiff.tsx   zero consumers after backend removal
```

Retained libs are backed by live consumers (proxy/session chain, security helpers, UI
helpers, test-only helpers). `residual_lib_unclassified = 0`,
`dead_node_era_libs_remaining = 0`.

---

## 9. Minimal Session Mongo Architecture

Phase 8.3 retained `frontend/src/lib/mongo.ts` only because the proxy session store still
needs MongoDB, but that module still exposed generic business capabilities. Phase 8.4
collapses it into the minimal session-only contract:

```text
frontend/src/lib/sessionMongo.ts   (new, exactly two exports)

  getSessionUsersCollection()  -> read-only handle for xcloud_ops.app_users
  closeSessionMongoClient()    -> best-effort teardown for test harnesses
```

Session validation chain (unchanged semantics, narrowed runtime):

```text
frontend/src/proxy.ts
  -> frontend/src/lib/accountSession.ts      (byte-frozen)
    -> frontend/src/lib/sessionAccountStore.ts (import rewired to sessionMongo)
      -> frontend/src/lib/sessionMongo.ts      (app_users, findOne only)
```

The only collection literal in surviving Next.js runtime code is `app_users`. The chain
contains exactly one Mongo operation, `findOne`, with the projection
`username`, `role`, `status`, `locked`, `security.sessionVersion`.
`proxy_session_mongo_readers = 1`, `proxy_session_mongo_writers = 0`.

Test teardown paths were updated to close the client through `closeSessionMongoClient()`
(`scripts/test-ocs-management-suite.mjs`, `scripts/test-user-management-e2e.mjs`), and
the removal readiness validator now derives its session-store evidence from
`frontend/src/lib/sessionMongo.ts`.

---

## 10. Deleted Generic Mongo Capabilities

Deleted from surviving frontend runtime code:

```text
frontend/src/lib/mongo.ts
  mongoCollections            (19-key business collection map)
  xcloudDbName / getXcloudDb  (xcloud business database helpers)
  getMongoCollection / getAppCollection / getXcloudCollection
  generic business collection helpers and re-exports
```

The acceptance suite derives these identifiers from source and fails if any of them
reappears anywhere outside the minimal session contract:

```text
frontend_business_collection_constants        = 0
frontend_xcloud_db_helpers                    = 0
frontend_generic_business_collection_helpers  = 0
next_business_mongo_readers                   = 0
next_business_mongo_writers                   = 0
next_business_mongo_collection_capabilities   = 0
```

Remaining Next.js Mongo access is allowed only in `sessionMongo.ts` and
`sessionAccountStore.ts`.

---

## 11. Real Runtime Regression

The acceptance suite exercises the real production stack (real `next build` + `next start`,
real Go binary, test-side capture proxy, isolated Mongo databases):

```text
phase84_routes_expected              = 84
phase84_routes_executed              = 84
phase84_routes_missing               = 0
phase84_routes_duplicate             = 0
phase84_exactly_once_forwarded       = 84   (exactly one Go forward per route)
phase84_fail_closed_expected         = 84
phase84_fail_closed_executed         = 84
phase84_fail_closed_failures         = 0    (502 GO_BACKEND_UNREACHABLE contract)
phase84_fallback_count               = 0
phase84_session_regression           = true (AUTH_UNAVAILABLE 503 when Mongo unreachable)
phase84_unknown_runtime_evidence     = true (unknown /api/* never forwarded)
phase84_retired_expected             = 6
phase84_retired_executed             = 6
phase84_retired_go_forward_count     = 0
phase84_retired_business_mutations   = 0
frontend_api_callers_unmapped        = 0
```

Negative sentinels (pure in-memory, non-tautological) cover the dependency classifier,
the residual-lib classifier, the session Mongo boundary, the CI supersession predicate
and the Go registration classifier.

---

## 12. CI Supersession

```text
OLD JOB/STEP   job `next-backend-removal`
               name "Phase 8.3 Next.js business backend removal"
               step "Phase 8.3 Next.js business backend removal acceptance"
               run  "node scripts/test-phase-8-next-backend-removal.mjs"

ACTION         replaced

REPLACEMENT    job `frontend-dependency-cleanup`
               name "Phase 8.4 frontend dependency & residual Node runtime cleanup"
               step "Phase 8.4 frontend dependency & residual Node runtime cleanup acceptance"
               run  "node scripts/test-phase-8-frontend-dependency-cleanup.mjs"
               (fetch-depth 0, root + frontend npm ci, frontend build,
                Mongo service, Go toolchain)

HISTORICAL     the Phase 8.3 suite file remains on disk byte-frozen as historical
EVIDENCE       evidence; it is no longer run by CI. The Phase 8.4 suite re-proves
               every current production runtime guarantee it established.
```

Current CI jobs preserved (no coverage silently removed):

```text
Node quality gates
Go backend quality gates
Direct operations integration
User management HTTP integration
Authentication controlled cutover
Phase 8.4 frontend dependency & residual Node runtime cleanup
```

The Node quality job still runs the backend-removal readiness validator and the
migration inventory/validator on the updated frontend lockfile, proving a clean install.

---

## 13. Phase 8.5 Deferrals

Phase 8.4 intentionally does NOT perform:

```text
global /api/* -> Go routing
Nginx API direct-routing change
proxy removal
CUTOVER_TABLE removal
JWT verification removal from Next.js
Mongo current-account validation removal
direct browser -> Go rewrites
```

These belong to Phase 8.5.

---

## 14. Rollback

Rollback is a single-commit revert of the Phase 8.4 commit:

- `frontend/package.json` / `frontend/package-lock.json` restore `bcryptjs`;
- `frontend/src/lib/sessionMongo.ts` disappears and `frontend/src/lib/mongo.ts` returns;
- `frontend/src/lib/sessionAccountStore.ts` returns to the previous import;
- the deleted residual libs and `ChangeDiff.tsx` return;
- the CI job returns to the Phase 8.3 suite (which stayed on disk, so the revert is
  self-contained).

No Mongo schema, no Go production source, no API path and no routing table changed in
Phase 8.4, so a revert cannot corrupt data or break the Go-owned production surface.