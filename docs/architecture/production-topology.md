# Production Topology

> Current deployment and request-path authority for the production runtime: the edge contract,
> the single-process composition, the artifact chain that puts the UI inside the Go binary, and the
> redeploy procedure.
> Related: [System architecture](system-architecture.md) (domain map and component inventory),
> [Frontend-backend boundary](frontend-backend-boundary.md) (who owns what behavior),
> [Security model](security-model.md) (identity, capability and denial evidence),
> [Deployment](../operations/deployment.md) (operator-facing steps).
> Documentation authority: `docs/README.md`.

## One-process rule

Production is **not** a frontend service plus a backend service. The deployed unit is a single Go
binary that owns the API surface and serves the browser application. There is no Node process, no
SSR renderer, no asset origin server and no second listener anywhere in the production path.

```text
                 artifact chain (build time, offline)

  frontend/  ──npm run build──▶  frontend/dist/  ──node scripts/stage-spa-for-go.mjs──▶
  backend/internal/spa/static/  ──go:embed all:static──▶  xcloud-server (one ELF)

                 runtime (production)

  Browser ──:80──▶ Nginx ──127.0.0.1:18888──▶ Go ──▶ MongoDB (xcloud + xcloud_ops)
```

| Stage | Command | Output | Authority |
|---|---|---|---|
| Bundle | `cd frontend && npm run build` (`tsc -b && vite build`) | `frontend/dist/` (hashed assets) | `frontend/src/**` is the canonical source |
| Stage | `node scripts/stage-spa-for-go.mjs` | `backend/internal/spa/static/` (gitignored, build-time only) | validates `index.html` + hashed JS/CSS before copying |
| Compile | `cd backend && go build -o <bin> ./cmd/server` | single binary with the UI embedded | `//go:embed all:static` in `backend/internal/spa/assets.go` |

Consequence: **a frontend change is invisible in production until all three stages run.** Serving a
stale bundle is indistinguishable at runtime from serving a fresh one, because both are the same
process on the same port. Prove which build is live by comparing the embedded asset identity, not
by reading a version banner:

```text
sha256( served / )                    == sha256( frontend/dist/index.html )
                                            == sha256( backend/internal/spa/static/index.html )
asset name referenced by that document == the hashed bundle produced by the latest build
```

## Edge contract (Nginx)

`deploy/nginx/xcloud.conf` is the only public origin. It defines exactly one application upstream:

```text
upstream xcloud_go { server 127.0.0.1:18888; }
listen 80;  server_name _;
```

All four proxy paths target that single upstream. There is no per-prefix backend selection and no
fallback origin:

| Location | Purpose |
|---|---|
| `location = /api` | bare `/api` request, proxied as-is |
| `location /api/` | the whole API surface |
| `location = /api/notifications/stream` | SSE: buffering disabled, long read timeout |
| `location = /api/runtime/stream` | SSE: same treatment as the notification stream |
| `location /` | browser routes and static assets, i.e. the embedded SPA |

Header handling is part of the security boundary, not cosmetics:

- **Removed on every proxied request**: `X-User`, `X-Role`, `X-Permissions`. Identity never travels
  as a client-supplied header; the only identity carrier is the `auth_token` cookie, verified by Go.
- **Set by the edge**: `Host`, `X-Real-IP`, `X-Forwarded-For`, `X-Forwarded-Proto`.
- `client_max_body_size 10m`.

`deploy/nginx/setup.sh [listen_port]` runs `nginx -t` before any reload, so an invalid edge
configuration never replaces a working one. Port `443` exists only inside the commented HTTPS
template; it is not enabled by the current configuration.

## Application listener

`HTTP_ADDR` defaults to `127.0.0.1:18888`. Loopback-only is enforced by the service definition
itself, not by a firewall rule, so the Go process is unreachable from a browser or from the network
except through the edge.

Unauthenticated container probes are served by the same process and are exempt from the auth
middleware: `/healthz` is liveness with no database dependency, `/readyz` reports MongoDB
readiness. The authenticated `GET /api/system/health` and `GET /api/system/mongo/health` are
application-level reads and are a different surface.

## Request path inside the process

The top-level handler is the SPA handler, which wraps the API mux
(`spa.NewHandler(mux, spa.EmbeddedFS())`, wired in `backend/cmd/server/main.go`). Classification is
its own layer with explicit guards:

| Guard | Behavior |
|---|---|
| `hasPathTraversal` | rejects backslashes and their percent-encoded forms in the request target; the response is HTTP 400, never a file read |
| `isApplicationRoute` | first-path-segment classification against the application-route table, so `/api/...`, `/healthz`, `/readyz` and dynamic parameter shapes reach the mux instead of being answered with a document |
| static file present | served from the embedded filesystem (hashed bundles, `favicon.ico`, images, font subsets) |
| browser route | `index.html` fallback with `Content-Type: text/html; charset=utf-8` and `Cache-Control: no-cache`, so a reloaded page always references the current bundle |

Verified behavior of this layer (`node scripts/test-go-spa-hosting-runtime.mjs`, which builds its
own binary, binds its own port and uses throwaway database names):

```text
GET /                       200 text/html; charset=utf-8, no-cache
GET /assets/index-<hash>.js 200 application/javascript, bytes identical to the staged file
GET /login, /profile,
GET /subscribers/{imsi},
GET /<unknown browser path> 200 SPA shell (client router resolves or renders its own not-found)
GET /api/profiles no cookie 401 {"code":"AUTH_INVALID_TOKEN"}  <- API prefix is never answered with HTML
GET /api/<unregistered>      404
GET /../backend/go.mod,
GET /assets/../../go.mod     400
GET /.env                    404
/healthz, /readyz            passthrough to the probe handlers
```

After classification, API requests run the middleware chain: request id → recovery → structured
logging → security headers → session authentication (cookie `auth_token`, HS256, resolved against
`xcloud_ops.app_users` with enabled / unlocked / session-version checks) → per-endpoint permission
or capability gate → fresh-actor revalidation on governed writes → fixed-window rate limit
(`xcloud_ops.app_rate_limits`) → domain validation and CAS precondition → handler → best-effort
operation log (`xcloud_ops.app_audit_logs`).

## API surface authority

The production surface is the derived METHOD+PATH registration set parsed from
`backend/cmd/server/main.go` plus `backend/internal/remediation/handler.go` by
`scripts/lib/go-registrations.mjs`. The expected total lives once, in that helper, as
`EXPECTED_GO_REGISTRATIONS`; gates assert against it instead of repeating literals, because
duplicated numbers drift independently and leave a gate red after an unrelated feature lands.

```text
measured total                     = 162 (GET 79 / POST 57 / PUT 13 / DELETE 10 / PATCH 3)
duplicate METHOD+PATH registrations = 0
```

Two properties of this set are load-bearing and must not be inferred from the verb alone:
`HTTP method != business semantics` (some `POST` routes are semantic reads, e.g.
`POST /api/subscribers/batch/precheck` and `POST /api/profiles/{name}/drift-precheck`), and a
handler existing in source is not route ownership - only the registration set grants it.

## Data layer placement

One `mongo.Client`, two database handles, same URI. Cross-database reads are allowed; cross-database
writes are not, and no transaction is used.

| Database | Collections with a current production code path |
|---|---|
| `xcloud` | `subscribers`, `ocs_subscribers`, `ocs_balances`, `ocs_tariff_plans` |
| `xcloud_ops` | `app_users`, `app_profiles`, `app_profile_versions`, `app_audit_logs`, `app_rate_limits`, `app_alerts`, `app_metrics`, `app_inventory_resources`, `app_topology_edges`, `app_discovery_sources`, `app_discovery_runs`, `app_nf_observations`, `app_nf_health_targets`, `app_nf_health_runs`, `app_nf_health_samples`, `app_nf_health_bindings`, `app_runtime_component_state`, `app_nf_notification_deliveries`, `ocs_balance_adjustments` |

Placement facts that are easy to get wrong and have cost a wasted probe:

- **User templates are an `xcloud_ops` concern**: `app_profiles` and `app_profile_versions` are
  reached through the application-database handle (`backend/internal/profile/repository.go`,
  `backend/internal/subscriber/repository.go:30`). The subscriber documents they provision live in
  `xcloud.subscribers`. A query against `xcloud.app_profiles` returns zero rows and looks like a
  lost write.
- `xcloud.profiles` also exists in the deployment. It is a core-side collection with **no reader or
  writer in this repository**, so it must never be used as a substitute for `app_profiles`, and no
  documented behavior depends on it.
- The charging-plane collections (`ocs_sessions`, `ocs_reservations`, `ocs_usage_records`,
  `ocs_events`, `ocs_config`) are present but out of scope for the management plane; their presence
  is not an invitation to couple to them.
- `xcloud_ops.app_approvals` is not present in the current deployment. Normal business execution
  creates no approval records; the approval workflow was removed, not merely bypassed.

## Development versus production

```text
PRODUCTION   Browser -> Nginx :80 -> Go 127.0.0.1:18888 (API + embedded SPA) -> MongoDB
DEVELOPMENT  Browser -> Vite 0.0.0.0:13333 -/api proxy-> Go 127.0.0.1:18888 -> MongoDB
```

`npm run local:dev` starts two owned processes: the Go server and a Vite **development server** on
`0.0.0.0:13333` that proxies `/api` to Go. It does **not** build `frontend/dist` and does not stage
or embed anything. That split has two consequences the operator must hold explicitly:

- `:13333` always reflects current `frontend/src`, so UI verification through the dev server is real
  but proves nothing about what the edge will serve.
- The canonical internal ports (`13333`, `18888`) are not configurable escapes; contamination is
  diagnosed with `npm run local:preflight`, never by rebinding a canonical port or by killing an
  arbitrary listener. `npm run local:stop` refuses to terminate a listener whose identity does not
  match its ownership record.

## Redeploy procedure

```bash
cd frontend && npm run build          # 1. bundle the SPA
cd ..                                 # 2. stage it into the embed directory
node scripts/stage-spa-for-go.mjs     #    (fails loudly on a missing or unhashed asset set)
cd backend && go build -o <path> ./cmd/server   # 3. embed and compile
# 4. restart the Go service, then reload the edge only if nginx configuration changed:
sudo ./deploy/nginx/setup.sh [listen_port]
```

Acceptance for a redeploy is the asset-identity comparison in the artifact-chain section, checked
through the edge (`:80`) rather than through the application listener, plus
`node scripts/test-go-spa-hosting-contract.mjs` and
`node scripts/test-go-spa-hosting-runtime.mjs` for the routing and fallback contract.

## Boundaries that define this topology

```text
no Node business API handler, repository or Mongo access anywhere
no Next.js runtime, no /api rewrite, no reverse proxy in the frontend
no browser-direct Go base URL in frontend code (same-origin /api only)
no second write owner for any production mutation
no external message broker for notifications (SSE with ping heartbeat from the Go process)
no independent static-asset origin or CDN
```

Removing any of these requires an architecture change, not a configuration change: the frontend has
no API authentication runtime, the edge strips identity headers, and the SPA is delivered by the
same process that authorizes its calls. The retired governance surfaces (`/api/approvals/*`,
`/api/audit/*`) stay retired; diagnostic endpoints under `/api/system/audit/*` remain the only
integrity tooling on the public path.
