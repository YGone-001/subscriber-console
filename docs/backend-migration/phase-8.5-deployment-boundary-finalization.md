# Phase 8.5 - Proxy / Deployment Boundary Finalization

Evidence document for the Phase 8.5 finalization of the production boundary between
the Nginx edge, the Go API and the Next.js UI runtime.

Status: IMPLEMENTED / NOT SELF-FROZEN (independent Phase 8.5 acceptance pending).

This document records the **post-finalization current state**. The Phase 8.3
evidence (`docs/backend-migration/phase-8.3-next-backend-removal.md`) and the
Phase 8.4 evidence (`docs/backend-migration/phase-8.4-frontend-dependency-cleanup.md`)
are **not rewritten**; they remain the authoritative historical record of the
pre-finalization state. In particular, Phase 8.3/8.4 statements that described the
Next.js proxy as an ownership/forwarding layer and that treated `CUTOVER_TABLE` as the
route authority are superseded here.

- Acceptance suite: `scripts/test-phase-8-deployment-boundary.mjs`
- Superseded predecessor suites (historical evidence, no longer the current
  production-boundary acceptance):
  `scripts/test-phase-8-frontend-dependency-cleanup.mjs`,
  `scripts/test-phase-8-next-backend-removal.mjs`
- Architecture references: `docs/operations/deployment.md`, `deploy/nginx/xcloud.conf`,
  `deploy/nginx/setup.sh`

---

## 1. Scope and Final Invariants

Phase 8.5 moves the production API boundary to the edge, reduces the Next.js runtime
to a UI renderer plus a UI navigation guard, retires the Next.js API reverse-proxy
mechanism and its supporting session/Mongo chain, and makes the frozen Go route
registration set the sole routing authority.

```text
nginx_api_router                       = true
nginx_upstream_next                    = 127.0.0.1:13333
nginx_upstream_go                      = 127.0.0.1:18888
nginx_exact_api_location               = true
nginx_sse_location                     = true
nginx_identity_headers_stripped        = true
nginx_client_max_body_size             = 10m

next_proxy_api_forwarding              = false
next_proxy_jwt_verification            = false
next_proxy_mongo_access                = false
next_proxy_identity_header_injection   = false
next_proxy_ui_navigation_guard         = true

CUTOVER_TABLE                          = retired
resolve_route_owner_present            = false
go_registered_operations               = 84
go_route_authority                     = true

frontend_direct_dependencies_before    = 19
frontend_direct_dependencies_after     = 16
frontend_direct_dependencies_removed   = 3   (jose, mongodb, jiti)

backend_production_changes             = 0
root_package_json_changed              = false
root_package_lock_changed              = false
next_business_backend_removed          = true
```

Explicit architectural statement:

```text
Next.js business backend removed      = YES
Go production API registrations       = 84 (unchanged)
CUTOVER_TABLE                         = retired
Next.js proxy runtime                 = UI navigation guard ONLY
Go owns API auth identity             = YES
Nginx owns API routing                = YES
```

---

## 2. Responsibility Migration Matrix (Before -> After)

| Responsibility | Before Phase 8.5 (owner) | After Phase 8.5 (owner) |
| --- | --- | --- |
| Production API routing | Next.js middleware (`proxy.ts` + `CUTOVER_TABLE`) | Nginx edge (`/api`, `/api/*`, SSE) |
| Route authority | `CUTOVER_TABLE` (`cutover-routing.ts`) | frozen Go registration set (84 exact METHOD+PATH) |
| API authentication / session authority | Go `GET /api/auth/me` (proxied by Next.js) | Go `GET /api/auth/me` (proxied by Nginx) |
| API identity derivation | Go from `auth_token` cookie | Go from `auth_token` cookie (unchanged) |
| Trusted identity headers | injected by Next.js proxy | never injected; stripped by Nginx, ignored by Go |
| Fail-closed behaviour when Go is down | Next.js proxy returns 502 `GO_BACKEND_UNREACHABLE` | Nginx forwards to Go; Go/edge returns 502/503; the UI guard fails closed for pages |
| UI page protection | Next.js proxy (JWT verify + Mongo lookup + forward) | Next.js UI navigation guard (`GET /api/auth/me` only) |
| Mongo access from Next.js | read-only `app_users` session lookup | none |
| JWT verification from Next.js | HS256 verify in `proxy.ts` | none (Go only) |
| Frontend dependency set | UI + `jose` + `mongodb` + `jiti` | UI only |

No API path, no HTTP method, no response shape, no status code and no Mongo schema
changed as part of this responsibility move.

---

## 3. Deleted Next.js Proxy / Session Surface

```text
frontend/src/lib/cutover-routing.ts        CUTOVER_TABLE + resolveRouteOwner
frontend/src/lib/accountSession.ts         Node-era account/session resolution
frontend/src/lib/sessionAccountStore.ts    read-only app_users session lookup
frontend/src/lib/sessionMongo.ts           minimal session Mongo module
frontend/tests/cutoverRouting.test.mjs     route-ownership unit test
```

```text
CUTOVER_TABLE              = retired
resolve_route_owner_present = false
frontend_mongo_runtime      = removed
frontend_jwt_runtime        = removed
```

`frontend/src/lib/security.ts` keeps only the UI password policy
(`isPasswordStrong`, `PASSWORD_POLICY_MESSAGE`); `getJwtSecretKey` was removed.
`frontend/src/proxy.ts` remains, but only as the UI navigation guard (section 5).

---

## 4. Nginx Edge Contract

`deploy/nginx/xcloud.conf`:

```nginx
upstream xcloud_next { server 127.0.0.1:13333; keepalive 16; }
upstream xcloud_go   { server 127.0.0.1:18888; keepalive 32; }
```

| Location | Upstream | Notes |
| --- | --- | --- |
| `location = /api` | `xcloud_go` | exact `/api` must not reach the UI upstream |
| `location /api/` | `xcloud_go` | all API traffic |
| `location = /api/notifications/stream` | `xcloud_go` | SSE: `proxy_buffering off`, `proxy_cache off`, `proxy_read_timeout 3600s`, `proxy_send_timeout 3600s` |
| `location /` | `xcloud_next` | UI pages and static assets |

Every API location:

- sets `Host`, `X-Real-IP`, `X-Forwarded-For`, `X-Forwarded-Proto`;
- clears client identity headers: `proxy_set_header X-User ""; X-Role ""; X-Permissions "";`;
- uses HTTP/1.1 with a cleared `Connection` header for upstream keepalive;
- applies `limit_req zone=xcloud_api burst=20 nodelay` (10 req/s per IP).

Global:

- `client_max_body_size 10m;` (unchanged 10 MiB upload boundary);
- Nginx-level security headers (`X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`).

Response cookies are not rewritten, so Go's `Set-Cookie` passes through unchanged.

### 4.1 Installation

`deploy/nginx/setup.sh [listen_port]` (default `80`) substitutes the `listen`
directive, links the site, runs `nginx -t`, then reloads (`set -euo pipefail`).
The configuration is portable: it contains no developer-machine absolute paths and
no per-prefix `/api/subscribers -> golang` templates.

### 4.2 Trust Boundary

```text
Public origin        : Nginx listener only
Loopback-internal    : Next.js 127.0.0.1:13333, Go 127.0.0.1:18888
Unsupported origins  : http://127.0.0.1:13333, http://127.0.0.1:18888
```

### 4.3 Cookie Contract

```text
name      : auth_token
HttpOnly  : true
Path      : /
SameSite  : Lax
Secure    : driven by X-Forwarded-Proto (true over HTTPS)
```

---

## 5. UI-Only Proxy Guard Semantics

`frontend/src/proxy.ts` no longer decodes or verifies a JWT, never reads MongoDB,
never injects identity headers and never forwards an API request. Its `config.matcher`
is `['/((?!api|_next/static|_next/image|images/|favicon.ico).*)']`, so `/api` is
explicitly excluded from the guard.

Decision table for a protected page:

| Condition | Result |
| --- | --- |
| no `auth_token` cookie | redirect to `/login?from=<pathname>` (cookie untouched) |
| cookie present, Go `GET /api/auth/me` -> 200 | allow (and `/login` redirects to `/`) |
| cookie present, Go -> 401 | redirect to `/login` and expire `auth_token` |
| cookie present, Go -> 503 | fail closed HTTP 503 `{"code":"AUTH_UNAVAILABLE"}` (cookie preserved) |
| Go unreachable / unexpected answer | fail closed HTTP 503 `{"code":"AUTH_SERVICE_UNAVAILABLE"}` |

Failure-mode invariants:

```text
guard_never_renders_protected_page_on_authority_failure = true
guard_never_invalidates_cookie_on_service_outage        = true
guard_fail_closed_response_has_no_store                 = true
```

Go remains the only API authentication authority; it distinguishes HTTP 401
(uniform `Invalid credentials`) from HTTP 503 `AUTH_UNAVAILABLE` for the API surface,
and the UI guard mirrors that distinction for page navigation.

---

## 6. Go Registration as Route Authority

The former `CUTOVER_TABLE` ownership table is retired. The authoritative route set is
now the frozen Go registration set, parsed from source:

```text
backend/cmd/server/main.go
backend/internal/remediation/handler.go
```

A new shared helper derives it:

```text
scripts/lib/go-registrations.mjs
```

`scripts/migration/validate-inventory.mjs` and the migration/test scripts derive their
route expectations from this helper instead of from the retired table.

```text
go_registered_operations = 84
go_route_authority       = true
CUTOVER_TABLE            = retired
```

The 84 registrations are unchanged by Phase 8.5: no route was added, removed or
re-owned.

---

## 7. Frontend Dependency Delta

```text
frontend_direct_dependencies_before  = 19
frontend_direct_dependencies_after   = 16
removed                              = jose, mongodb, jiti
```

- `jose` / `mongodb` lost their last consumers when the proxy/session chain was
  deleted (no JWT verification, no Mongo access remain in Next.js).
- devDependency `jiti` was test tooling for the removed route-ownership test.
- `frontend/next.config.ts` drops `serverExternalPackages: ['mongodb']`.
- Root `package.json` / `package-lock.json` are byte-identical
  (`root_package_json_changed = false`, `root_package_lock_changed = false`).

---

## 8. Acceptance Suite and Real Topology

`scripts/test-phase-8-deployment-boundary.mjs` supersedes the Phase 8.4 suite as the
current production-boundary acceptance suite and runs on a real topology:

```text
real Nginx            (edge routing exercised end to end)
real Go binary        (:18888)
real next build       + real next start (:13333)
real MongoDB          (service / container)
real TCP connections  (no source inference, no direct function calls)
```

It proves the edge contract (`/api` and `/api/*` -> Go, `/` -> Next.js, SSE unbuffered),
identity header stripping, the UI guard decision matrix and its fail-closed responses,
the 84-route Go authority, the absence of `CUTOVER_TABLE` / `resolveRouteOwner`, and the
frontend dependency delta on the real build. A CI job runs it.

---

## 9. Security Invariants Preserved

```text
forged identity headers ignored / stripped   = true
no forwarded-identity trust                  = true
fail-closed on auth authority outage         = true
no dual write                                = true
uniform 401 credential privacy               = true
auth_token cookie HttpOnly / SameSite=Lax    = true
JWT verification only in Go                  = true
frontend business Mongo access               = none
charging plane untouched                     = true
```

---

## 10. Phase State

```text
Phase 8.0: PASS / FROZEN
Phase 8.1: PASS / FROZEN
Phase 8.2: PASS / FROZEN
Phase 8.3: PASS / FROZEN
Phase 8.4: IMPLEMENTED / NOT SELF-FROZEN (independent acceptance pending)

Phase 8.5: IMPLEMENTED / NOT SELF-FROZEN (independent acceptance pending)

Phase 8.6: NOT AUTHORIZED YET

STOP
```

---

## 11. Rollback

Rollback is a source-level revert of the Phase 8.5 commit:

- `frontend/src/proxy.ts` returns to the ownership/forwarding proxy;
- `frontend/src/lib/cutover-routing.ts`, `accountSession.ts`,
  `sessionAccountStore.ts` and `sessionMongo.ts` return;
- `jose`, `mongodb`, `jiti` return to `frontend/package.json`;
- `deploy/nginx/xcloud.conf` / `setup.sh` return to the previous model.

No Mongo schema, no Go production source, no API path and no route registration
changed in Phase 8.5, so a revert cannot corrupt data or break the Go-owned
production API surface.
