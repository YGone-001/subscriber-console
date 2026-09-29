# Phase 8.1 - Residual API Go Implementation and Shadow Parity

Evidence document for the Phase 8.1 residual Go shadow implementation freeze.

Status: IMPLEMENTED / NOT SELF-FROZEN (independent Phase 8.1 acceptance pending).
This document records **post-Phase-8.0 / Phase-8.1 current state**. The Phase 8.0
frozen evidence (`docs/backend-migration/phase-8-residual-api-inventory.md`, frozen
baseline `3babf1c6ad9b2ebf683b9156f9d3e64a09c9321b`) reported 22 pre-existing Go
shadows plus 11 operations without a Go implementation. That history is not
rewritten here; the delta is this document plus the additive Go registrations.

- Parity suite: `scripts/test-phase-8-residual-api-parity.mjs`
- Readiness validator: `scripts/test-phase-8-backend-removal-readiness.mjs` (P8-I21)
- Architecture: `docs/architecture/phase-8-backend-removal-architecture.md`

---

## 1. Scope and Invariants

Phase 8.1 implements the 11 missing Go shadow operations and freezes all 33
canonical Node migration remainder operations in shadow parity state.

```text
canonical_node_migration_remainder = 33
canonical_node_with_go_shadow      = 33
canonical_node_missing_go          = 0

CUTOVER_TABLE  = 47   (unchanged)
ACTUALLY_ROUTED = 47  (unchanged)
```

Production ownership did NOT change: every residual operation is still executed
by the Next.js Node route handler (`runtime_owner=node`), while each has an exact,
production-capable Go registration that is deliberately NOT reachable through the
production cutover path until Phase 8.2.

Phase 8.2 is not started. No Node route was deleted, no dependency was removed,
no MongoDB schema was altered, no fallback or dual execution was introduced.

---

## 2. Authoritative Node Contract Source

Node remains the authoritative behavioral contract. The suite executes the real
Node route modules through a test HTTP server (jiti direct invocation) against an
isolated Node Mongo database pair, and compares them byte-for-byte with the
spawned Go production binary against an isolated Go Mongo database pair. The two
engines never share a database.

```text
Node DB pair: xcloud_p81_node_<suffix>      + xcloud_ops_p81_node_<suffix>
Go   DB pair: xcloud_p81_go_<suffix>        + xcloud_ops_p81_go_<suffix>
```

Authoritative Node sources (26 route files backing the 33 operations):

```text
frontend/src/app/api/analytics/metrics/route.ts
frontend/src/app/api/analytics/sparkline/route.ts
frontend/src/app/api/ocs/balances/route.ts
frontend/src/app/api/ocs/reservations/route.ts
frontend/src/app/api/ocs/sessions/route.ts
frontend/src/app/api/ocs/usage/route.ts
frontend/src/app/api/profiles/route.ts
frontend/src/app/api/profiles/[name]/route.ts
frontend/src/app/api/profiles/[name]/stats/route.ts
frontend/src/app/api/profiles/[name]/versions/route.ts
frontend/src/app/api/ratings/route.ts
frontend/src/app/api/ratings/[id]/route.ts
frontend/src/app/api/search/route.ts
frontend/src/app/api/subscribers/route.ts
frontend/src/app/api/subscribers/[imsi]/route.ts
frontend/src/app/api/subscribers/[imsi]/traffic-adjustments/route.ts
frontend/src/app/api/subscribers/policy/route.ts
frontend/src/app/api/subscribers/batch/precheck/route.ts
frontend/src/app/api/tariff-plans/route.ts
frontend/src/app/api/tariff-plans/[planId]/route.ts
frontend/src/app/api/tariff-plans/[planId]/export/route.ts
frontend/src/app/api/tariff-plans/[planId]/migrate/route.ts
frontend/src/app/api/tariff-plans/[planId]/rules/route.ts
frontend/src/app/api/tariff-plans/[planId]/rules/[ruleId]/route.ts
frontend/src/app/api/tariff-plans/[planId]/subscribers/route.ts
frontend/src/app/api/tariff-plans/import/route.ts
```

Shared Node contract machinery referenced by these routes:

```text
frontend/src/server/ocsGovernanceRegistry.ts     disabled write contracts (*_NOT_SUPPORTED gates)
frontend/src/server/repositories/ocsBillingRepository.ts
frontend/src/server/repositories/subscriberRepository.ts
frontend/src/lib/tariffPlanOperations.ts         rule validation + export normalization
frontend/src/lib/audit.ts                        best-effort audit evidence
frontend/src/lib/authz.ts                        authorization denial evidence
```

---

## 3. Eleven Newly Implemented Go Operations

All 11 were registered directly by the production Go server
(`backend/cmd/server/main.go`) and are absent from `CUTOVER_TABLE`.

| METHOD | PATH (canonical) | Go implementation | Node contract observed |
| --- | --- | --- | --- |
| POST | /api/ratings | `backend/internal/rating/handler_write.go` | 409 `OCS_RATING_CREATE_NOT_SUPPORTED` |
| PUT | /api/ratings/{id} | `backend/internal/rating/handler_write.go` | 409 `OCS_RATING_UPDATE_NOT_SUPPORTED` |
| DELETE | /api/ratings/{id} | `backend/internal/rating/handler_write.go` | 409 `OCS_RATING_DELETE_NOT_SUPPORTED` |
| POST | /api/subscribers/policy | `backend/internal/ocs/handler_residual.go` | 409 `OCS_PLAN_ASSIGN_NOT_SUPPORTED` |
| POST | /api/subscribers/{imsi}/traffic-adjustments | `backend/internal/ocs/handler_residual.go` | 200 routed acknowledgement + rate limit |
| POST | /api/tariff-plans/import | `backend/internal/tariff/handler_write_residual.go` | 409 `OCS_TARIFF_CREATE_NOT_SUPPORTED` |
| POST | /api/tariff-plans/{planId}/migrate | `backend/internal/tariff/handler_write_residual.go` | 409 `OCS_PLAN_MIGRATION_NOT_SUPPORTED` |
| POST | /api/tariff-plans/{planId}/rules | `backend/internal/tariff/handler_write_residual.go` | 409 `OCS_TARIFF_RULE_CREATE_NOT_SUPPORTED` |
| PUT | /api/tariff-plans/{planId}/rules/{ruleId} | `backend/internal/tariff/handler_write_residual.go` | 409 `OCS_TARIFF_RULE_UPDATE_NOT_SUPPORTED` |
| PATCH | /api/tariff-plans/{planId}/rules/{ruleId} | `backend/internal/tariff/handler_write_residual.go` | 409 `OCS_TARIFF_RULE_TOGGLE_NOT_SUPPORTED` |
| DELETE | /api/tariff-plans/{planId}/rules/{ruleId} | `backend/internal/tariff/handler_write_residual.go` | 409 `OCS_TARIFF_RULE_DELETE_NOT_SUPPORTED` |

The Node authority for 10 of the 11 operations is the frozen disabled-write gate
(`{ error: CODE, code: CODE }` with HTTP 409, evaluated after authentication,
authorization, and the Node-parity rate limit). The Go shadows mirror that gate
exactly, including the authorization ordering: the capability check
(`ocs.rating.write` / `ocs.plan.assign` / `ocs.tariff.write` / `ocs.balance.adjust`)
precedes body parsing, so malformed JSON observes the same contract.

`POST /api/subscribers/{imsi}/traffic-adjustments` is the single executable
residual write: Node answers `{"error":"Routed to Go backend","imsi":"<imsi>"}`
with HTTP 200 after the Node-parity rate limit `traffic-adjustments:<user>`
(30/60s); the Go shadow reproduces the same status, body, and rate-limit
consumption.

---

## 4. Twenty-Two Pre-Existing Go Shadows (Preserved)

All 22 pre-existing shadows were preserved without production cutover:
analytics metrics/sparkline, OCS balances/reservations/sessions/usage, profiles
list/detail/stats/versions, ratings list/detail, search, subscribers
list/detail, batch precheck, and the tariff read set (list, detail, export,
migrate dry-run GET, rules, subscribers). Their registrations are unchanged; the
parity suite re-proves each with an unauthenticated denial scenario and an
authorized scenario against the isolated databases.

---

## 5. Full 33-Operation Parity Matrix

Every operation executed real HTTP scenarios on both engines; response bodies
were compared with `assert.deepStrictEqual` after explicit normalization of only
truly non-deterministic fields (metrics `timestamp`, sparkline jitter series,
export `exported_at` - each validated for freshness/structure before sentinel
replacement). Missing keys vs null vs zero are preserved exactly.

| METHOD | PATH (canonical) | Category | Scenarios | Scenario set |
| --- | --- | --- | --- | --- |
| GET | /api/analytics/metrics | existing_shadow | 2 | unauth-401, authorized-read |
| GET | /api/analytics/sparkline | existing_shadow | 2 | unauth-401, authorized-read |
| GET | /api/ocs/balances | existing_shadow | 2 | unauth-401, authorized-read |
| GET | /api/ocs/reservations | existing_shadow | 2 | unauth-401, authorized-read |
| GET | /api/ocs/sessions | existing_shadow | 2 | unauth-401, authorized-read |
| GET | /api/ocs/usage | existing_shadow | 2 | unauth-401, authorized-read |
| GET | /api/profiles | existing_shadow | 2 | unauth-401, authorized-read |
| GET | /api/profiles/{name} | existing_shadow | 2 | unauth-401, authorized-read |
| GET | /api/profiles/{name}/stats | existing_shadow | 2 | unauth-401, authorized-read |
| GET | /api/profiles/{name}/versions | existing_shadow | 2 | unauth-401, authorized-read |
| GET | /api/ratings | existing_shadow | 2 | unauth-401, authorized-read |
| GET | /api/ratings/{id} | existing_shadow | 2 | unauth-401, authorized-read |
| GET | /api/search | existing_shadow | 2 | unauth-401, authorized-read |
| GET | /api/subscribers | existing_shadow | 2 | unauth-401, authorized-read |
| GET | /api/subscribers/{imsi} | existing_shadow | 2 | unauth-401, authorized-read |
| GET | /api/tariff-plans | existing_shadow | 2 | unauth-401, authorized-read |
| GET | /api/tariff-plans/{planId} | existing_shadow | 2 | unauth-401, authorized-read |
| GET | /api/tariff-plans/{planId}/export | existing_shadow | 2 | unauth-401, authorized-read |
| GET | /api/tariff-plans/{planId}/migrate | existing_shadow | 2 | unauth-401, authorized-read |
| GET | /api/tariff-plans/{planId}/rules | existing_shadow | 2 | unauth-401, authorized-read |
| GET | /api/tariff-plans/{planId}/subscribers | existing_shadow | 2 | unauth-401, authorized-read |
| POST | /api/subscribers/batch/precheck | existing_shadow | 2 | unauth-401, authorized-precheck |
| POST | /api/ratings | new_shadow | 5 | authorized, authorized-malformed-json, authorized-missing-field, viewer-denied, unauth-401 |
| PUT | /api/ratings/{id} | new_shadow | 4 | authorized, authorized-unknown-id, viewer-denied, unauth-401 |
| DELETE | /api/ratings/{id} | new_shadow | 3 | authorized, viewer-denied, unauth-401 |
| POST | /api/subscribers/policy | new_shadow | 3 | authorized, viewer-denied, unauth-401 |
| POST | /api/subscribers/{imsi}/traffic-adjustments | new_shadow | 4 | authorized, authorized-allow-body, viewer-denied, unauth-401 |
| POST | /api/tariff-plans/import | new_shadow | 3 | authorized, viewer-denied, unauth-401 |
| POST | /api/tariff-plans/{planId}/migrate | new_shadow | 3 | authorized, viewer-denied, unauth-401 |
| POST | /api/tariff-plans/{planId}/rules | new_shadow | 3 | authorized, viewer-denied, unauth-401 |
| PUT | /api/tariff-plans/{planId}/rules/{ruleId} | new_shadow | 3 | authorized, viewer-denied, unauth-401 |
| PATCH | /api/tariff-plans/{planId}/rules/{ruleId} | new_shadow | 3 | authorized, viewer-denied, unauth-401 |
| DELETE | /api/tariff-plans/{planId}/rules/{ruleId} | new_shadow | 3 | authorized, viewer-denied, unauth-401 |

Machine-readable evidence emitted by the suite:

```text
phase81_residual_expected=33
phase81_residual_executed=33
phase81_residual_missing=0
phase81_residual_duplicate=0

phase81_existing_shadow_expected=22
phase81_new_shadow_expected=11
phase81_existing_shadow_executed=22
phase81_new_shadow_executed=11

phase81_go_registered=33
phase81_cutover_count=0
phase81_runtime_node=33
phase81_scenarios_executed=81
phase81_scenarios_failed=0
phase81_result=PASS
```

The gate is fail-closed: the run aborts on the first failed scenario or
assertion, and the summary reports `missing`/`duplicate`/`not executed`/
`not Go-registered`/`accidentally cut over` as explicit counters.

---

## 6. Go Registration Evidence

Registration source of truth: `backend/cmd/server/main.go` (production mux),
cross-checked by the readiness validator scan of
`backend/cmd/server/main.go` + `backend/internal/remediation/handler.go`.

```text
go_registered_operations=84        (73 at the Phase 8.0 frozen baseline + 11)
go_registered_classified=84
go_registered_unclassified=0
go_registration_negative_sentinel=true
go_registered_unrouted_reads=2     (frozen allowlist, NOT expanded)
```

The two frozen Phase 8.0 Go-native unrouted reads remain exactly:

```text
GET /api/tariff-plans/{planId}/operations
GET /api/ocs/balances/{imsi}
```

All 11 Phase 8.1 registrations are ordinary inventory operations: every one maps
1:1 to a current Next.js route file, so the non-tautological P8-I11 classifier
accepts them automatically and the curated allowlist was not touched.

---

## 7. Runtime Ownership and cutover=false Evidence

```text
cutover_routes=47
actually_routed=47
inventory_runtime_go=37
inventory_runtime_node=41
inventory_runtime_unreachable=0
runtime_owner_unknown=0
```

Runtime ownership is derived executably: both the suite and the readiness
validator invoke the production routing function `resolveRouteOwner` from
`frontend/src/lib/cutover-routing.ts` (the function `frontend/src/proxy.ts`
executes) with concrete instance paths. Since none of the 33 residual routes is
in `CUTOVER_TABLE` and each is backed by an executable Node route file, all 33
resolve to `runtime_owner=node`. The suite asserts, per operation:

```text
go_registered=true
cutover=false
runtime_owner=node
```

---

## 8. Persistent-State Parity Status

Tracked business collections (both isolated xcloud DBs):
`subscribers`, `ocs_subscribers`, `ocs_balances`, `ocs_sessions`,
`ocs_usage_records`, `ocs_reservations`, `ocs_tariff_plans`,
`ocs_rating_policies`.

```text
PASS  Node test DB xcloud collections byte-stable across all scenarios
PASS  Go test DB xcloud collections byte-stable across all scenarios
PASS  cross-engine document counts identical for all tracked collections
PASS  rate-limit write parity: RATELIMIT:traffic-adjustments:admin_user:<window>
      count=2 on both engines (two admin requests, shared Node-parity key)
PASS  authorization.denied audit evidence persisted by both engines
      (viewer denial of POST /api/ratings, permission ocs.rating.write,
      xcloud_ops_p81_* .app_audit_logs)
```

This matches the frozen contract: 10 of the 11 new shadows observe disabled
write gates (no business mutation), and the single executable residual write
(traffic-adjustments) mutates only the rate-limit collection plus best-effort
audit evidence - both reproduced identically by Go in its own isolated database.

Note for the harness: Node persists scheduled audit evidence through
next/server `after()`, which throws outside a real Next.js request scope. The
suite installs the same `runAfter`/`drainAfter` shim used by the Phase 7 parity
suites and drains pending writes before asserting evidence, so Node's
best-effort audit path is exercised for real rather than silently dropped.

---

## 9. Remaining Blockers (Phase 8.2+)

```text
backend_removal_ready=false
backend_removal_blockers=4
  CANONICAL_NODE_MIGRATION_REMAINDER=33     (awaiting Phase 8.2 cutover)
  RETIRED_SURFACES_PENDING_DELETION=6
  LEGACY_ALIASES_PENDING_CLOSURE=2
  STALE_CALLERS_TO_RETIRED_SURFACES=2
```

Implementation readiness after Phase 8.1:

```text
existing_go_shadow=33
missing_go_implementation=0
```

Phase 8.1 does not claim the backend is removable, does not plan the Phase 8.2
cutover, and does not remove any blocker listed above.

---

## 10. Rollback Boundary

The phase is additive and production-inert:

- no Node route, repository, or dependency was deleted or modified for behavior;
- no `CUTOVER_TABLE` entry was added; `ACTUALLY_ROUTED` is unchanged;
- no production request path changes hands: all 33 residual operations are
  still Node-owned at runtime, and the Go shadows are unreachable through the
  production proxy;
- rollback = revert the Phase 8.1 commit; the only artifacts it adds are the Go
  handler files/registrations, the parity suite, the readiness validator update,
  this document, and the CI step.

---

## 11. Reproduction

```bash
node scripts/test-phase-8-residual-api-parity.mjs
node scripts/test-phase-8-backend-removal-readiness.mjs
```

The parity suite requires a reachable MongoDB and a Go toolchain; it compiles
the production binary, seeds both isolated database pairs, starts the Node test
server and the Go production server, and fails closed on the first divergence.