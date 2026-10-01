# Phase 8.6 - Production Freeze & Final Certification

Evidence document for the Phase 8.6 final certification of the frozen production
architecture: the Nginx public edge, the Go business API, and the loopback-only
Next.js UI runtime.

Status: IMPLEMENTED / NOT SELF-FROZEN (independent Phase 8.6 acceptance pending).
Phase 8.6 is certification-only; it does not change production behavior.

- Certification harness: `scripts/test-phase-8-production-freeze.mjs`
- Runtime acceptance (unchanged, authoritative runtime proof):
  `scripts/test-phase-8-deployment-boundary.mjs`
- Readiness analysis re-run by the certification (unchanged):
  `scripts/test-phase-8-backend-removal-readiness.mjs`
- Route authority: `scripts/lib/go-registrations.mjs`
- Edge configuration: `deploy/nginx/xcloud.conf`

Historical Phase 8.0-8.5 evidence documents are **not rewritten**. They remain the
authoritative record of how the frozen state was reached.

---

## 1. Baseline and Certification Provenance

```text
authoritative_starting_sha = 6970e929250e51fa47a09fa3f9bccb1b86f2f46e
final_certification_sha    = the commit that introduces this document
                             (recorded in the Phase 8.6 final report and CI run metadata)
```

The certification harness asserts that the baseline commit object exists locally and is
an ancestor of `HEAD` before deriving anything else. It never rewrites, rebases or
amends history.

## 2. Frozen Production Architecture

```text
External Client
      |
      v
+------------------+
|      Nginx       |   sole public edge (deploy/nginx/xcloud.conf)
+--------+---------+
         |
         +------------------------------+
         | /api, /api/*                 | everything else
         v                              v
127.0.0.1:18888                  127.0.0.1:13333
   Go API                            Next.js UI
```

```text
public_edge                     = nginx
edge_api_owner                  = nginx->go
edge_ui_owner                   = nginx->next
go_internal_listener            = 127.0.0.1:18888  (HTTP_ADDR production default)
next_internal_listener          = 127.0.0.1:13333  (next start -H 127.0.0.1 -p 13333)
authentication_authority        = go
authorization_authority         = go
session_authority               = go (xcloud_ops.app_users + security.sessionVersion)
database_business_access        = go only
next_runtime_responsibility     = UI rendering + protected-page navigation guard
next_local_jwt_verification     = none
next_local_mongo_access         = none
fourth_production_authority     = none
```

Next.js production start model is unique and canonical: `next start -H 127.0.0.1 -p 13333`
(`npm run start`). The repository supports no standalone-server deployment path;
`scripts/deploy-standalone.sh` does not exist and `frontend/next.config.ts` does not enable
`output: 'standalone'`.

## 3. Go API Surface

Derived from the production registration site plus `backend/internal/remediation/handler.go`;
never from a migration artifact and never from a count-only comparison.

```text
baseline_go_registrations  = 84
current_go_registrations   = 84
go_registration_missing    = 0
go_registration_added      = 0
go_registration_duplicates = 0
go_registration_set_changed= false
```

The comparison is an exact sorted METHOD+PATH set equality against the baseline commit
(`git show <baseline_sha>:<router source>`), so replacing one route with another while the
total stays 84 fails certification. A synthetic key
(`GET /api/__phase86_unknown_sentinel__`) is asserted absent from both sets to keep the
comparison falsifiable.

## 4. Next.js Business Backend Removal

Re-derived from the current tree, not inferred from historical reports.

```text
next_api_route_files          = 0
next_api_operations           = 0
next_server_tree_present      = false
next_business_api_operations  = 0
```

`frontend/src/app/api/**` and `frontend/src/server/**` are absent and must not be
recreated.

## 5. Retired Migration Runtime

```text
cutover_runtime_present           = false   (frontend/src/lib/cutover-routing.ts absent)
cutover_table_present             = false
production_route_resolvers        = 0       (resolveRouteOwner)
next_api_reverse_proxy_functions  = 0
node_api_fallback                 = 0
```

Historical text in documentation or in test assertions is not a production consumer; the
harness classifies live executable code only (comments are blanked before scanning).

## 6. Nginx Public Edge

```text
location = /api                      -> xcloud_go
location /api/                       -> xcloud_go
location = /api/notifications/stream -> xcloud_go
location /                           -> xcloud_next

xcloud_go   -> 127.0.0.1:18888
xcloud_next -> 127.0.0.1:13333

nginx_identity_headers_stripped = true   (X-User / X-Role / X-Permissions)
nginx_body_limit_10m            = true
nginx_sse_buffering_disabled    = true
```

`Host`, `X-Real-IP`, `X-Forwarded-For` and `X-Forwarded-Proto` are generated at the edge.

## 7. Internal Listener Boundary

The Phase 8.5 listener correction is frozen: the services bind loopback themselves, so the
boundary does not depend on firewall documentation.

```text
next_listener_expected          = 127.0.0.1:13333
go_listener_expected            = 127.0.0.1:18888
standalone_next_production_path = false
next_loopback_reachable         = true    (run by the Phase 8.5 runtime suite)
go_loopback_reachable           = true
next_nonloopback_reachable      = false
go_nonloopback_reachable        = false
next_loopback_only              = true
go_loopback_only                = true
direct_next_external_bypass     = false
direct_go_external_bypass       = false
```

The Go listener is proven to come from the production default (`addr_source=production_default`)
rather than a certification-only override.

## 8. Runtime Ownership, Fail-Closed and Transport

Proven by the unchanged Phase 8.5 runtime suite, which the certification job depends on so
both execute in the same run:

```text
api_routes_expected             = 84
api_routes_executed             = 84
api_go_hits                     = 84
api_next_hits                   = 0
unknown_api_owner               = go
retired_surfaces_active         = 0
retired_business_mutations      = 0
go_down_edge_result             = 502/504
go_down_next_hits               = 0
node_fallback_hits              = 0
header_spoofing_rejected        = true
ui_guard_consults_go_auth       = true
ui_guard_local_jwt_fallback     = 0
ui_guard_local_mongo_fallback   = 0
sse_streaming                   = true
request_body_integrity          = true
```

## 9. Compatibility Provenance

```text
canonical_residual_expected = 33
canonical_residual_present  = 33
legacy_aliases_present      = 2
```

These are compatibility provenance classifications, not Node ownership. All surviving
production execution is Go-owned.

## 10. Charging-Plane Exclusion

```text
charging_reads    = permitted (Go-owned management reads over HTTP)
charging_mutations= 0
```

No runtime charging-plane protocol work (Gy / Ro / CCR / CCA) exists or was added.

## 11. Dependency / Runtime Closure

```text
frontend package mongodb = absent
frontend package jose    = absent
frontend package jiti    = absent

frontend_jwt_verifiers        = 0
next_business_mongo_readers   = 0
next_business_mongo_writers   = 0
backend_removal_ready         = true
backend_removal_blockers      = 0
```

The certification re-runs the existing readiness analysis unmodified and requires its exit
code to be zero. Source-level tokens in frozen, non-production-reachable files are not
treated as production dependencies and are not opportunistically cleaned in this phase.

## 12. Source Freeze Against Phase 8.5

Changed files between the baseline SHA and `HEAD` (including working-tree changes) are
classified into four buckets, and production runtime change must be zero:

```text
PRODUCTION_RUNTIME  = 0
CERTIFICATION_TEST  = certification harness and shared derivation lib
CI                  = the Phase 8.6 certification job
DOCUMENTATION       = this document
UNEXPECTED          = 0
```

The classifier is falsification-tested: known production paths must classify as
`PRODUCTION_RUNTIME`, so an empty result can never be produced by a broken classifier.

## 13. CI Evidence

The final push run must be new (not a reuse of Run #165 / ID 36807992753), on `develop`,
with `head_sha` equal to the final certification SHA, `status = completed`,
`conclusion = success`, and every required job green:

```text
Node quality gates
Go backend quality gates                        (go test -race -count=1 ./...)
Direct operations integration
User management HTTP integration
Authentication controlled cutover
Phase 8.5 proxy / deployment boundary finalization   (real Nginx/Next/Go runtime proof)
Phase 8.6 production freeze certification            (this phase)
```

The Phase 8.6 job depends on all six upstream jobs, so it cannot become green while a
Phase 8 production gate is failing.

## 14. Certification Result

```text
phase86_invariants_failed = 0
phase86_result            = PASS
```

Machine-readable output is emitted by `scripts/test-phase-8-production-freeze.mjs`.
