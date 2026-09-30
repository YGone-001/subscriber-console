# Phase 8.3 - Next.js Business Backend Physical Removal

Evidence document for the Phase 8.3 physical removal of the dormant Next.js business backend.

Status: IMPLEMENTED / NOT SELF-FROZEN (independent Phase 8.3 acceptance pending).

This document records the **post-removal current state**. The Phase 8.0 frozen
inventory (`docs/backend-migration/phase-8-residual-api-inventory.md`), the
Phase 8.1 shadow parity evidence
(`docs/backend-migration/phase-8.1-residual-go-parity.md`) and the Phase 8.2
cutover evidence (`docs/backend-migration/phase-8.2-residual-production-cutover.md`)
are **not rewritten**; they remain the authoritative record of the pre-removal
state and of the historical parity boundary.

- Acceptance suite: `scripts/test-phase-8-next-backend-removal.mjs`
- Readiness / removal-completion validator: `scripts/test-phase-8-backend-removal-readiness.mjs`
- Architecture: `docs/architecture/phase-8-backend-removal-architecture.md`

---

## 1. Scope and Final Invariants

Phase 8.3 deletes the now-unreachable Next.js App Router business backend, extracts
the single minimal read-only session account lookup that `proxy.ts` genuinely
requires, and evolves the inventory, the removal validator, the affected tests and
the CI coverage so that current production behaviour stays covered without any
Node business backend.

```text
next_api_route_files      = 0   (was 54)
next_api_operations       = 0   (was 72)
node_server_tree_files    = 0   (was 33)
active_server_imports     = 0

CUTOVER_TABLE             = 84  (byte-frozen, unchanged)
ACTUALLY_ROUTED           = 84
go_registered_operations  = 84
go_registered_unclassified = 0
go_registered_unrouted    = 0
cutover_without_go_registration = 0

next_business_mongo_readers = 0
next_business_mongo_writers = 0
proxy_session_store_read_only = true
proxy_session_validation_present = true

frontend_api_callers_unmapped = 0
backend_removal_ready         = true
next_business_backend_removed = true

unexplained_test_coverage_loss = 0
ci_coverage_gaps               = 0
```

Explicit architectural statement:

```text
Next.js business backend removed = YES
All Node.js server execution removed = NO
```

The Next.js server process intentionally remains: it serves the UI, it runs
`frontend/src/proxy.ts`, and that proxy performs the account/session validation
lookup against `xcloud_ops.app_users` before forwarding to Go. What was removed is
the dormant business backend (API route modules, business repositories and
business governance code) that no longer received any production traffic after the
Phase 8.2 controlled cutover.

---

## 2. Authoritative Starting SHA

```text
starting SHA : 6a8352dc3892957e12751f14182328f054fc42ff
starting tree: 40fe9901a08a3d14f69cc02312bf7ba9f9dfd360
branch       : develop
```

This SHA is the Phase 8.2 acceptance-correction merge commit and is the frozen
Phase 8.2 boundary that Phase 8.3 departs from.

---

## 3. Pre-Deletion Manifest

Derived from the starting tree (source-derived, not hand-counted):

```text
phase83_start_api_route_files = 54   (frontend/src/app/api/**/route.ts)
phase83_start_api_support_files = 6  (frontend/src/app/api/**/handler.ts)
phase83_start_api_files_total = 60
phase83_start_api_operations = 72

pre_phase83_server_files = 33
  frontend/src/server/repositories/**            (14 files)
  frontend/src/server/__tests__/**               (10 files)
  frontend/src/server/*.ts (business governance)  (9 files)

pre_phase83_backend_only_lib_files = 7
```

Every one of those files was already dormant in production: `proxy.ts` matches only
the exact METHOD+PATH pairs present in `CUTOVER_TABLE`, and all 84 pairs have
`owner=go`, so no request could reach a Next.js route handler.

---

## 4. Deleted Next.js App Router API Tree

`frontend/src/app/api/**` was deleted in full: 60 files (54 `route.ts` modules and
6 colocated `handler.ts` modules).

```text
alerts/{route.ts, acknowledge/route.ts, workflow/route.ts}
analytics/{init/route.ts, metrics/route.ts, sparkline/route.ts}
auth/{login,logout,me,permissions}/route.ts
auth/users/route.ts
auth/users/[username]/route.ts
notifications/stream/route.ts
ocs/{balances,reservations,sessions,usage}/route.ts
profiles/route.ts
profiles/[name]/{route.ts, stats/route.ts, versions/route.ts}
profiles/[name]/versions/[versionId]/restore/{route.ts, handler.ts}
ratings/route.ts
ratings/[id]/route.ts
search/route.ts
subscribers/route.ts
subscribers/[imsi]/{route.ts, profile/route.ts, profile/handler.ts}
subscribers/[imsi]/traffic-adjustments/route.ts
subscribers/batch/{route.ts, handler.ts, precheck/route.ts}
subscribers/batch-update/{route.ts, handler.ts}
subscribers/bulk-delete/{route.ts, handler.ts}
subscribers/import/{route.ts, handler.ts}
subscribers/policy/route.ts
system/audit/{status,scan,heal,batch-heal}/route.ts
system/health/route.ts
system/mongo/health/route.ts
tariff-plans/route.ts
tariff-plans/import/route.ts
tariff-plans/[planId]/{route.ts, clone/route.ts, export/route.ts, migrate/route.ts, subscribers/route.ts}
tariff-plans/[planId]/rules/route.ts
tariff-plans/[planId]/rules/[ruleId]/route.ts
```

No proxy forwarding stub, catch-all and no replacement route module was created
under `app/api`.

Because the tree is gone, unmatched `/api/*` requests are answered by the Next.js
runtime itself (404 for an unknown path, 405 for a known path without the requested
method export) - they are never answered by a surviving Node business handler. See
sections 12 and 13.

### 4.1 Runtime proof that no API route module survives

```text
next_api_route_files = 0
next_api_operations  = 0
```

`scripts/migration/inventory-api.mjs` scans the App Router tree at its real
location; after removal it reports `Routes=0 Operations=0` and exits `0`. The
Phase 8.3 suite independently re-derives the same fact from the filesystem.

---

## 5. Deleted `frontend/src/server/**` Tree

`frontend/src/server/**` was deleted in full: 33 files.

```text
repositories/ (14)  alertRepository, analyticsRepository, auditRepository,
                    mongoHealthRepository, ocsBillingRepository,
                    ocsOperationsRepository, profileRepository,
                    rateLimitRepository, ratingRepository,
                    subscriberRepository, systemAuditRepository,
                    systemHealthRepository, userRepository
__tests__/ (10)     batch-create-fixtures.{json,ts,test.ts},
                    batch-update-fixtures.{json,ts,test.ts},
                    bulk-delete-fixtures.ts, profile-apply-fixtures.{json,ts},
                    profile-crud-fixtures.ts, profileApplyAuthWiring.test.ts
business governance (9) ocsGovernanceRegistry, profileRestoreGovernance,
                    subscriberBatchGovernance, subscriberGovernanceRegistry,
                    subscriberOperationPolicy, subscriberProfileApplyGovernance,
                    subscriberSingleGovernance, userManagement,
                    userManagementLock
```

```text
node_server_tree_files = 0
active_server_imports  = 0
```

`active_server_imports` counts live (non-comment, non-historical) imports that
resolve into the deleted tree from surviving source: components, pages, hooks,
lib modules, scripts and tests. It is `0`.

---

## 6. Proxy-Session Extraction

### 6.1 The dependency that had to survive

`frontend/src/lib/accountSession.ts` previously resolved the current account by
importing the deleted user repository. `proxy.ts` depends on that resolution to
validate a request's session before forwarding to Go, so the dependency could not
simply be deleted.

### 6.2 New minimal read-only session account store

```text
new file     : frontend/src/lib/sessionAccountStore.ts
export       : getSessionAccount(username)
collection   : xcloud_ops.app_users
read ops     : 1  (collection.findOne with an explicit projection)
write ops    : 0
```

The projection is limited to exactly the fields session validation needs:

```text
username
role
status
locked
security.sessionVersion
```

No `updateOne`, `updateMany`, `insertOne`, `deleteOne`, `findOneAndUpdate`,
`bulkWrite`, `$set`, transaction or aggregation with a write stage exists in this
module. It reuses the existing shared Mongo client module
(`frontend/src/lib/mongo.ts`), which is preserved byte-identical (section 8).

### 6.3 Semantic preservation

```text
accountSession semantics changed = NO (behaviourally)
proxy.ts changed                 = NO
```

`frontend/src/lib/accountSession.ts` was edited only to redirect the account
lookup at the new read-only store; the exported surface, the return shape and
every validation decision are unchanged. The full session regression matrix
(section 14) is exercised against a real running Next.js server.

---

## 7. Behaviourally Frozen Files

These files are byte-identical to the Phase 8.2 baseline:

```text
frontend/src/proxy.ts
frontend/src/lib/cutover-routing.ts
frontend/src/lib/mongo.ts
frontend/src/lib/security.ts
```

`proxy.ts` keeps the exact forward/fail-closed contract: per-request
`process.env.GO_BACKEND_URL` resolution, HTTP 502
`{"error":"Backend temporarily unavailable","code":"GO_BACKEND_UNREACHABLE"}` when
Go is unreachable with **zero** Node fallback, HTTP 401 `AUTH_INVALID_TOKEN` for
invalid credentials, and HTTP 503 `AUTH_UNAVAILABLE` for non-auth session
validation outages. `cutover-routing.ts` still exports the 84-entry
`CUTOVER_TABLE` and `resolveRouteOwner(method, pathname)`.

---

## 8. Backend-Only Library Cleanup

Seven `frontend/src/lib` modules existed only to serve the deleted backend and were
removed:

```text
frontend/src/lib/analytics.ts
frontend/src/lib/audit.ts
frontend/src/lib/audit/record.ts
frontend/src/lib/authz.ts
frontend/src/lib/rateLimit.ts
frontend/src/lib/sentinel.ts
frontend/src/lib/syslog.ts
```

Shared/UI libraries that surviving components still use were **not** removed. Two
UI-facing type modules that lived inside the deleted repository layer were moved out
so that surviving consumers keep compiling:

```text
frontend/src/types/ocs.ts            (OCS UI view types)
frontend/src/types/platformHealth.ts (system health UI types)
```

Surviving consumers touched by the removal:

```text
frontend/src/lib/accountSession.ts          (session lookup redirect)
frontend/src/lib/navigationRoutes.ts        (retired governance entries)
frontend/src/app/(dashboard)/system-health/page.tsx
frontend/src/components/ocs/OcsBalancesPanel.tsx
frontend/src/components/ocs/OcsSessionsPanel.tsx
frontend/src/components/ocs/OcsUsagePanel.tsx
```

No API path changed: every surviving frontend caller still calls the same
`/api/...` URL, which is now answered by Go through the unchanged proxy.

```text
frontend_api_callers_unmapped = 0
```

---

## 9. Preserved 84-Route Go Ownership

```text
CUTOVER_TABLE                   = 84
ACTUALLY_ROUTED                 = 84
go_registered_operations        = 84
go_registered_unclassified      = 0
go_registered_unrouted          = 0
cutover_without_go_registration = 0
```

Each of the 84 `CUTOVER_TABLE` METHOD+PATH pairs has `owner=go`. The suite derives
the Go registration set from the Go source (`backend/cmd/server/main.go` plus the
remediation handler registration) and asserts exact set equality with the
`CUTOVER_TABLE` set in both directions, with a negative sentinel that proves the
comparison cannot trivially pass.

Removing the Node API tree did not change a single route owner, route path, route
method or Go registration.

---

## 10. Test Supersession Matrix

```text
unexplained_test_coverage_loss = 0
```

### 10.1 Current frontend tests (ADAPT_TO_CURRENT_RUNTIME)

Seven files asserted behaviour by importing deleted Node route modules or deleted
repositories. Each was adapted to keep its still-valid assertions and drop only the
assertions that structurally required the deleted backend.

| Test file | Deleted dependency | Action | Remaining coverage |
| --- | --- | --- | --- |
| `frontend/tests/profileNavigationPerformance.test.mjs` | `summarizeProfiles` from deleted profile repository | ADAPT_TO_CURRENT_RUNTIME | prefetch / navigation performance assertions kept |
| `frontend/tests/systemHealthDiagnostics.test.mjs` | deleted system health + system audit repositories | ADAPT_TO_CURRENT_RUNTIME | system-health page + locale assertions kept |
| `frontend/tests/userManagementUx.test.mjs` | deleted `users/[username]` route source | ADAPT_TO_CURRENT_RUNTIME | user management UX assertions kept |
| `frontend/tests/xcloudSubscriber.test.mjs` | `prepareSubscriberLegacyUpdate` from deleted server tree | ADAPT_TO_CURRENT_RUNTIME | subscriber helper assertions kept |
| `frontend/tests/authSecurity.test.mjs` | deleted auth route source | ADAPT_TO_CURRENT_RUNTIME | auth security assertions kept |
| `frontend/tests/userAccessManagement.test.mjs` | deleted user repository + Mongo fixture harness | ADAPT_TO_CURRENT_RUNTIME | access-management assertions kept |
| `frontend/tests/realtimeNotifications.test.mjs` | deleted SSE route existence check | ADAPT_TO_CURRENT_RUNTIME | notification client assertions kept |

Result after adaptation: `npm test` -> 291 pass / 0 fail.

### 10.2 Removed Node implementation unit tests (REMOVE_DELETED_NODE_IMPLEMENTATION_UNIT_TEST)

Eleven frontend test files tested the deleted Node implementation itself: each one
imported `../src/server/**` fixtures, business governance/policy modules, or loaded
deleted route modules through `tests/helpers/loadModule.mjs`. They have no meaning
without the deleted implementation and were removed.

| Test file | Deleted Node dependency | Action | Equivalent current coverage |
| --- | --- | --- | --- |
| `batchUpdateFixtures.test.mjs` | `src/server/__tests__/batch-update-fixtures.ts` | REMOVE_DELETED_NODE_IMPLEMENTATION_UNIT_TEST | Go batch-update tests in `backend/internal/subscriber` |
| `bulkDeleteFixtures.test.mjs` | `src/server/__tests__/bulk-delete-fixtures.ts` | REMOVE_DELETED_NODE_IMPLEMENTATION_UNIT_TEST | Go bulk-delete tests in `backend/internal/subscriber` |
| `profileRestore.test.mjs` | `src/server/profileRestoreGovernance.ts` | REMOVE_DELETED_NODE_IMPLEMENTATION_UNIT_TEST | Go `TestRestore*` suite in `backend/internal/profile` |
| `profileRestoreFixtures.test.mjs` | `src/server/profileRestoreGovernance.ts` | REMOVE_DELETED_NODE_IMPLEMENTATION_UNIT_TEST | Go `TestRestore*` suite in `backend/internal/profile` |
| `subscriberBatchCrossRuntime.test.mjs` | `src/server/__tests__/batch-create-fixtures.ts` | REMOVE_DELETED_NODE_IMPLEMENTATION_UNIT_TEST | Frozen cross-language fixture relocated to Go `testdata` (section 10.3) |
| `subscriberBatchExecution.test.mjs` | deleted Node batch route module | REMOVE_DELETED_NODE_IMPLEMENTATION_UNIT_TEST | Go batch-create handler tests + `P83-R` real runtime routing |
| `subscriberBatchUpdateCrossRuntime.test.mjs` | `src/server/__tests__/batch-update-fixtures.ts` | REMOVE_DELETED_NODE_IMPLEMENTATION_UNIT_TEST | Go batch-update tests |
| `subscriberBatchUpdateIntegrity.test.mjs` | `src/server/subscriberOperationPolicy.ts` | REMOVE_DELETED_NODE_IMPLEMENTATION_UNIT_TEST | Go batch-update validation tests |
| `subscriberImportFrozenInvariant.test.mjs` | deleted Node import route module | REMOVE_DELETED_NODE_IMPLEMENTATION_UNIT_TEST | Go import tests |
| `subscriberOperationPolicy.test.mjs` | deleted Node subscriber operation policy | REMOVE_DELETED_NODE_IMPLEMENTATION_UNIT_TEST | Go capability/authorization tests |
| `subscriberProfileApplyCrossRuntime.test.mjs` | `src/server/__tests__/profile-apply-fixtures.ts` | REMOVE_DELETED_NODE_IMPLEMENTATION_UNIT_TEST | Go profile-apply tests |

No removal silently dropped coverage: every removed file tested a Node artifact that
no longer exists, and the same domain is covered by the Go test suite plus the
current-runtime routing/ownership evidence in `scripts/test-phase-8-next-backend-removal.mjs`.

```text
unexplained_test_coverage_loss = 0
```

### 10.3 Go cross-language fixture (ADAPT_TO_CURRENT_RUNTIME)

| Test | Deleted dependency | Action | Replacement evidence |
| --- | --- | --- | --- |
| `backend/internal/subscriber/batch_create_fixture_test.go` | `frontend/src/server/__tests__/batch-create-fixtures.json` | ADAPT_TO_CURRENT_RUNTIME | frozen expected values relocated to `backend/internal/subscriber/testdata/fixture_node_batch_create.json` (recorded as a byte-identical rename: `frontend/src/server/__tests__/batch-create-fixtures.json` -> `backend/internal/subscriber/testdata/fixture_node_batch_create.json`, `R100`) |

This is the **only** change under `backend/**` and it is test-only: no production Go
file, registration, handler, contract or algorithm was touched. The fixture content
is the frozen Node-derived expected value set, preserved as package `testdata` so the
Go algorithm stays locked to the pre-removal cross-language baseline. Production Go
tree freeze remains intact for all non-test files.

`P83-S06` / `P83-S07` assert exactly this: `frontend/package.json` and
`frontend/package-lock.json` are unchanged versus the starting SHA, and every changed
`backend/**` path is test-scoped (`*_test.go` or `testdata/**`). Any change to a
production Go file fails the suite:

```text
backend_production_changes = 0
```

Because the assertion diffs against the starting SHA, the CI clone must contain that
commit: the `next-backend-removal` job checks out with `fetch-depth: 0`. On a shallow
clone the probe reports `baseline commit ... must be present locally` instead of
aborting the suite, so every later P83 group still runs and reports.

### 10.4 Historical parity suites (RETIRE_AS_HISTORICAL_PARITY)

Twelve scripts were structurally bound to the deleted Node backend (they imported
deleted route modules or deleted repositories through `jiti` / `readFileSync`). Their
behavioural claims are historical Phase 2/6/7/8.1/8.2 parity claims and remain
recorded in the frozen phase documents listed in section 11.

```text
scripts/test-auth-go-parity.mjs                     (Node route import)
scripts/test-auth-security-hardening.mjs            (Node route import)
scripts/test-phase-7-architecture-freeze.mjs        (Node source read)
scripts/test-phase-7-read-parity.mjs                (Node route import)
scripts/test-phase-7-alert-mutation-parity.mjs      (Node repository import)
scripts/test-phase-7-notification-stream-parity.mjs (Node route import)
scripts/test-phase-7-system-heal-parity.mjs         (Node route import)
scripts/test-phase-7-platform-cutover.mjs           (Node route import)
scripts/test-phase-8-residual-api-parity.mjs        (Node route import)
scripts/test-phase-8-residual-cutover.mjs           (Node route import)
scripts/instrumented-account-session.mjs            (deleted session module)
scripts/instrumented-alert-repository.mjs           (deleted alert repository)
```

Their current-runtime replacement is `scripts/test-phase-8-next-backend-removal.mjs`,
which re-proves 84/84 real forwarding, 84/84 fail-closed, unknown-API behaviour,
retired-surface behaviour and the session regression matrix against a real Next.js
production runtime and the real Go binary.

### 10.5 Replacement suite (REPLACE_WITH_CURRENT_RUNTIME_SUITE)

```text
scripts/test-phase-8-next-backend-removal.mjs
```

Groups: `P83-S` source-removal invariants, `P83-A` API route absence, `P83-B` server
business tree absence, `P83-P` proxy/session preservation, `P83-R` 84-route Go
routing integrity, `P83-F` fail-closed/no-fallback, `P83-U` unknown API behaviour,
`P83-D` retired API behaviour, `P83-C` CI/test supersession integrity, `P83-G` Go
registration equality, `P83-M` Mongo session-store read-only boundary.

It uses the existing Node/Next tooling only (`next build` / `next start` plus the
already-approved repository script dependencies). No new framework was installed.

---

## 11. Historical Parity Boundary

Historical parity evidence is **not** re-run and its suites are **not** modified in
place. It stays frozen in:

```text
docs/backend-migration/phase-4.*                       (subscriber/profile cutovers)
docs/backend-migration/phase-5.*                       (OCS governance + freeze)
docs/backend-migration/phase-8-residual-api-inventory.md   (Phase 8.0)
docs/backend-migration/phase-8.1-residual-go-parity.md     (Phase 8.1, 81 scenarios)
docs/backend-migration/phase-8.2-residual-production-cutover.md (Phase 8.2)
```

Phase 8.3 adds current-runtime evidence only. No historical phase document was
rewritten, and no historical claim was retroactively weakened.

---

## 12. Real Next.js Production Runtime Evidence

The suite never calls `proxy()` directly and never infers routing from source. It
performs a real `next build` and starts the real production server
(`next start`) on loopback, so `proxy.ts` participates exactly as in production and
the App Router dispatcher produces the actual HTTP response.

```text
phase83_cutover_expected       = 84
phase83_cutover_executed       = 84
phase83_cutover_missing        = 0
phase83_cutover_duplicate      = 0
phase83_exactly_once_forwarded = 84
phase83_fallback_count         = 0
phase83_node_handler_executions = 0
```

For each of the 84 `CUTOVER_TABLE` pairs the suite issues the request through the
Next.js server with a capture proxy in front of Go and asserts exactly one Go
forwarding, zero duplicates, zero Node handler executions and zero fallback.

### 12.1 Production build requirement

`next build` succeeds and its route manifest contains **no** `/api/*` entry: only UI
pages and the `Proxy (Middleware)` entry remain. An `app/api` route manifest entry
would fail the suite.

---

## 13. Fail-Closed, Unknown API and Retired Surface Behaviour

### 13.1 Fail-closed (Go unreachable)

```text
phase83_fail_closed_expected = 84
phase83_fail_closed_executed = 84
phase83_fail_closed_failures = 0
```

With Go unreachable, all 84 routes return HTTP 502
`GO_BACKEND_UNREACHABLE` from the proxy, with zero Node fallback and zero business
mutation. Removing the Node API tree did not introduce any fallback path.

### 13.2 Unknown API behaviour

```text
unknown_api_runtime_evidence = true
```

A sentinel path with no Go registration and no Node handler is requested against the
real running server. The observed status is assigned directly from
`response.status`; no expected-status constant, route-source parse or
`CUTOVER_TABLE` membership is used to derive it. The request produces zero Go
forwardings, proving the response came from the Next.js runtime itself.

### 13.3 Retired surface behaviour

```text
phase83_retired_expected       = 6
phase83_retired_executed       = 6
phase83_retired_go_forward_count = 0
phase83_retired_business_mutations = 0
```

The six non-canonical mutation methods retired in Phase 8.2
(`POST /api/auth/users`, `PUT|PATCH|DELETE /api/auth/users/{username}`,
`PUT|DELETE /api/users/{username}`) are re-probed against the real server. Each is
assigned its status directly from the runtime response, with zero Go forwarding and
zero `app_users` mutation. No retired endpoint was reintroduced.

---

## 14. Authentication / Session Regression Matrix

Exercised end-to-end against the real running Next.js server with the read-only
session store in place:

| Scenario | Expected session decision |
| --- | --- |
| active matching account | accepted, request forwarded to Go |
| missing account | rejected (`AUTH_INVALID_TOKEN`, 401) |
| disabled account | rejected (401) |
| locked account | rejected (401) |
| session revoked (`sessionVersion` mismatch) | rejected (401) |
| role mismatch | rejected (401) |
| malformed claims | rejected (401) |
| Mongo unavailable | `AUTH_UNAVAILABLE` (503), never fail-open |

```text
proxy_session_validation_present = true
proxy_session_store_read_only    = true
```

The store is asserted read-only both statically (no write API usage in the module)
and at runtime (`P83-M`: `next_business_mongo_readers = 0`,
`next_business_mongo_writers = 0`).

---

## 15. Remaining Node.js Runtime Responsibilities

Node.js still runs, deliberately:

```text
next start                 UI rendering / App Router
frontend/src/proxy.ts      exact METHOD+PATH ownership decision + Go forwarding
frontend/src/lib/accountSession.ts + sessionAccountStore.ts
                           read-only account/session validation lookup
```

Node no longer performs any business API execution, any business Mongo access, or
any business mutation.

---

## 16. Dependency Deferral to Phase 8.4

```text
frontend/package.json      unchanged
frontend/package-lock.json unchanged
root package.json          unchanged
root package-lock.json     unchanged
mongodb                    still present
jose                       still present
bcryptjs                   still present
```

No dependency was added or removed. `mongodb`, `jose` and `bcryptjs` remain required
by the retained proxy/session runtime. Dependency cleanup belongs to Phase 8.4 and
was not started.

---

## 17. Proxy / Deployment Deferral to Phase 8.5

Nginx topology, the `/api/*` forwarding rule, the `/*` UI rule and the deployment
model are unchanged. Proxy removal and deployment simplification belong to
Phase 8.5 and were not started.

---

## 18. Rollback Boundary

Rollback is source-level and additive; no data migration is involved:

```text
- restore frontend/src/app/api/** and frontend/src/server/** from
  6a8352dc3892957e12751f14182328f054fc42ff
- restore the retired scripts / CI jobs from the same SHA
```

No Mongo schema, collection name, route path, route owner or API contract changed in
Phase 8.3, so no data-level rollback is required.

---

## 19. Machine-Readable Output

Source-derived values confirmed locally at the exact final tree:

```text
phase83_start_api_route_files=54
phase83_start_api_operations=72

next_api_route_files=0
next_api_operations=0
node_server_tree_files=0
active_server_imports=0

go_registered_operations=84
go_cutover_operations=84
go_registered_unclassified=0
go_registered_unrouted=0
cutover_without_go_registration=0

phase83_fallback_count=0
phase83_node_handler_executions=0

next_business_mongo_readers=0
next_business_mongo_writers=0
proxy_session_store_read_only=true
proxy_session_validation_present=true

frontend_api_callers_unmapped=0

backend_removal_ready=true
next_business_backend_removed=true

unexplained_test_coverage_loss=0
ci_coverage_gaps=0
```

Runtime-derived values (`phase83_cutover_*`, `phase83_fail_closed_*`,
`unknown_api_runtime_evidence`, `phase83_retired_*`, `phase83_result`,
`phase83_invariants_failed`) are emitted by the Phase 8.3 suite from a real
production Next.js runtime plus the real Go binary and are only reproducible on an
environment with MongoDB available (CI).

---

## 20. CI Supersession Matrix

```text
ci_coverage_gaps = 0
```

No CI job was removed merely because it failed after source deletion. Each affected
job/step received exactly one explicit action, and current production behaviour
stays covered.

| OLD JOB / STEP | NODE BACKEND DEPENDENCY | ACTION | REPLACEMENT CURRENT EVIDENCE |
| --- | --- | --- | --- |
| `node` job: Lint / Typecheck / Test / Build | none (frontend unit tests only) | ADAPT_TO_CURRENT_RUNTIME | Same steps; 7 test files adapted to the post-removal runtime (section 10.1) |
| `node` job: Migration inventory | scanned Next API tree | ADAPT_TO_CURRENT_RUNTIME | `inventory-api.mjs` reports `Routes=0 Operations=0`; `validate-inventory.mjs` keeps `CUTOVER_TABLE=84 / ACTUALLY_ROUTED=84` |
| `node` job: Phase 8 backend removal readiness | source scan of Node API/server tree | ADAPT_TO_CURRENT_RUNTIME | Validator evolved from removal *readiness* to removal *completion* (`next_business_backend_removed=true`, `phase83_acceptance=PASS`) |
| `go` job: Format / Vet / Test(race) / Build | none | KEEP_UNCHANGED | Unchanged; fixture relocation is transparent to this job |
| `direct-operations` job: Governance surface removal contract | none (Go runtime) | KEEP_UNCHANGED | `scripts/test-direct-operations.mjs` |
| `direct-operations` job: OCS management suite | none (Go runtime) | KEEP_UNCHANGED | `scripts/test-ocs-management-suite.mjs` |
| `direct-operations` job: RBAC simplification acceptance | none (Go runtime) | KEEP_UNCHANGED | `scripts/test-rbac-simplification.mjs` |
| `direct-operations` job: RBAC role migration acceptance | none (Go runtime) | KEEP_UNCHANGED | `scripts/test-rbac-role-migration.mjs` |
| `direct-operations` job: User management controlled cutover | none (Go runtime) | KEEP_UNCHANGED | `scripts/test-user-management-cutover.mjs` |
| `direct-operations` job: Authentication controlled cutover | none (Go runtime) | KEEP_UNCHANGED | `scripts/test-auth-cutover.mjs` |
| `direct-operations` job: Auth & User Management UI integration | none (Go runtime) | KEEP_UNCHANGED | `scripts/test-auth-user-ui-integration.mjs` |
| `direct-operations` job: Platform services architecture freeze | read deleted Node platform sources | RETIRE_AS_HISTORICAL_PARITY | Frozen in `docs/architecture/phase-7-platform-services-architecture.md`; current behaviour covered by `next-backend-removal` |
| `user-management-e2e` job: User management HTTP E2E | none (Go runtime) | KEEP_UNCHANGED | `scripts/test-user-management-e2e.mjs` |
| `auth-security` job: Authentication security integration | imported deleted auth route modules | RETIRE_AS_HISTORICAL_PARITY | Frozen in `docs/operations/authentication-model.md`; current auth behaviour covered by `auth-cutover` + session matrix (section 14) |
| `auth-go-parity` job: Authentication Go contract parity | imported deleted Node auth routes | RETIRE_AS_HISTORICAL_PARITY | Frozen in Phase 6.3-A evidence; current auth behaviour covered by `auth-cutover` job and `P83-P` session regression |
| `auth-cutover` job: Authentication controlled cutover | none (Go runtime) | KEEP_UNCHANGED | `scripts/test-auth-cutover.mjs` |
| `platform-read-parity` job: Platform services Go read parity | imported deleted Node platform routes | RETIRE_AS_HISTORICAL_PARITY | Frozen in Phase 7.1 evidence; current routing covered by `next-backend-removal` |
| `platform-read-parity` job: Alert domain mutation parity | imported deleted alert repository | RETIRE_AS_HISTORICAL_PARITY | Frozen in Phase 7.2 evidence; current routing covered by `next-backend-removal` |
| `platform-read-parity` job: Notification streaming SSE parity | imported deleted SSE route | RETIRE_AS_HISTORICAL_PARITY | Frozen in Phase 7.3 evidence (Run #140); current routing covered by `next-backend-removal` |
| `platform-read-parity` job: System integrity controlled remediation parity | imported deleted remediation routes | RETIRE_AS_HISTORICAL_PARITY | Frozen in Phase 7.4 evidence (RS01-RS05); current routing covered by `next-backend-removal` |
| `platform-read-parity` job: Controlled platform services cutover | imported deleted Node platform routes | RETIRE_AS_HISTORICAL_PARITY | Frozen in Phase 7.5 evidence; current routing covered by `next-backend-removal` |
| `residual-api-parity` job: Phase 8.1 residual API parity | imported deleted residual Node routes | RETIRE_AS_HISTORICAL_PARITY | Frozen in `docs/backend-migration/phase-8.1-residual-go-parity.md` |
| `residual-api-parity` job: Build frontend for real Next.js retired-surface HTTP runtime verification | Next API tree had to exist | REPLACE_WITH_CURRENT_RUNTIME_SUITE | `next-backend-removal` builds the frontend the same way, now proving absence |
| `residual-api-parity` job: Phase 8.2 residual production cutover | imported deleted Node route modules | REPLACE_WITH_CURRENT_RUNTIME_SUITE | `scripts/test-phase-8-next-backend-removal.mjs` (`P83-R`, `P83-F`, `P83-D`) re-proves 84/84 routing, fail-closed and retired surfaces |
| (new) `next-backend-removal` job | none | ADDED | `Phase 8.3 Next.js business backend removal acceptance` runs `scripts/test-phase-8-next-backend-removal.mjs` on a real build with MongoDB and Go (checkout uses `fetch-depth: 0` so the baseline-SHA diff is computable; package manifests unchanged, only test-scoped Go changes allowed) |

The `next-backend-removal` job is a visible, first-class Phase 8.3 job: it checks out
the exact SHA, installs the existing dependencies, runs `npm run build` in
`frontend/`, then executes the Phase 8.3 acceptance suite against a real production
Next.js runtime with a MongoDB service container and a real Go binary. No coverage
was dropped without an enumerated replacement.

---

## 21. Phase State

```text
Phase 8.0: PASS / FROZEN
Phase 8.1: PASS / FROZEN
Phase 8.2: PASS / FROZEN

Phase 8.3: IMPLEMENTED / NOT SELF-FROZEN (independent acceptance pending)

Phase 8.4: NOT STARTED
Phase 8.5: NOT STARTED

STOP
```
