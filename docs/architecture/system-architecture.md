# System Architecture

> Overview of the xCloud subscriber-console production architecture.
> Detailed rules: `CLAUDE.md`. Current state: `AGENTS.md`.
> Documentation authority: `docs/README.md`.

## Current Production Architecture

This section describes the deployed production topology today. It remains the
authority for current runtime behavior until a separately governed migration changes
the implementation.

### Components

```text
Browser
   |
   v
Nginx  (sole public edge)
   |
   v
Go  127.0.0.1:18888
   |-- Business API (owner)
   |-- Auth identity + session validation
   |-- Read + write APIs (90 exact METHOD+PATH registrations)
   `-- Embedded static React SPA (UI rendering, browser history routing, static assets)
   |
   v
MongoDB: xcloud + xcloud_ops
```

### Routing

Nginx owns production routing to the single application upstream:

```text
/api                      -> Go 127.0.0.1:18888
/api/*                    -> Go 127.0.0.1:18888
/api/notifications/stream -> Go 127.0.0.1:18888 (unbuffered SSE)
/* (non-API)              -> Go 127.0.0.1:18888 (embedded SPA shell / static assets)
```

The Go application service binds loopback only and is reachable exclusively through
Nginx. Route authority is the derived Go registration set (90 exact METHOD+PATH
registrations parsed from `backend/cmd/server/main.go` plus
`backend/internal/remediation/handler.go`, shared helper
`scripts/lib/go-registrations.mjs`).

### Frontend

- **Production UI**: `frontend/` (React 19, Vite 8, React Router, Tailwind CSS, Lucide React). Built to static assets and embedded directly into the Go binary.
- Legacy Next.js source is retired; numeric port 13333 is reassigned to Vite development.

The Next.js business backend (`frontend/src/app/api/**` and `frontend/src/server/**`) does not exist.

### Go Backend

- Go 1.24+
- Standard library `net/http`
- Modern ServeMux method/path routing
- `log/slog` structured logging
- `mongo-driver/v2`

Location: `backend/`

### Database

Same Mongo URI, two databases:

- `xcloud` - subscriber, profile, OCS and tariff data
- `xcloud_ops` - operational data (`app_users`, `app_profiles`, `app_audit_logs`,
  `app_alerts`, `app_rate_limits`, `app_metrics`, `app_inventory_resources`)

Go uses one `mongo.Client` with two database handles.

### Inventory Domain

Six inventory resource management operations are Go-owned at the edge:

```text
GET  /api/inventory/meta
GET  /api/inventory/resources
GET  /api/inventory/resources/{resourceId}
POST /api/inventory/resources
PUT  /api/inventory/resources/{resourceId}
POST /api/inventory/resources/{resourceId}/retire
```

- Authoritative collection: `xcloud_ops.app_inventory_resources` (zero in `xcloud`).
- Permissions: `core.read` for read endpoints, `core.configure` for mutations.
- Keyset cursor pagination (`updatedAt DESC, _id ASC`) and CAS concurrency (`revision`).
- Sensitive keys rejected recursively in attributes; server-owned fields protected.
- Detailed model specification: [Inventory Resource Model](inventory-resource-model.md).

### Platform Services

Eleven platform-service operations are Go-owned at the edge:

```text
GET  /api/alerts
POST /api/alerts/acknowledge
POST /api/alerts/workflow
GET  /api/notifications/stream
GET  /api/system/health
GET  /api/system/mongo/health
GET  /api/system/audit/status
POST /api/system/audit/scan
POST /api/system/audit/heal
POST /api/system/audit/batch-heal
POST /api/analytics/init
```

- Alerts are stored in `xcloud_ops.app_alerts`; acknowledge and workflow updates
  execute directly under RBAC control.
- `GET /api/notifications/stream` is a Server-Sent Events stream with a periodic
  `:ping` heartbeat. No external message broker is introduced (no Kafka, Redis
  Pub/Sub, RabbitMQ, NATS or WebSocket): the carrier on-premise single-instance
  deployment is served by this polling stream.
- `GET /api/system/health` and `GET /api/system/mongo/health` are authenticated
  application/database health reads, distinct from the container probes `/healthz`
  (liveness, no Mongo dependency) and `/readyz` (Mongo readiness).
- `GET /api/system/audit/status`, `POST /api/system/audit/scan`,
  `POST /api/system/audit/heal` and `POST /api/system/audit/batch-heal` provide
  data-integrity diagnostics and bounded remediation. They are distinct from the
  retired audit console: the user-facing `/api/audit/*` and `/api/approvals/*`
  governance surfaces do not exist.
- `POST /api/analytics/init` is a read-only on-demand analytics recomputation.

### Domain Boundaries

```text
subscriber-console
  -> subscriber / profile / OCS / tariff / governance

CNMS (reference only)
  -> monitoring / signaling / capture / RCA / AIOps / NF
```

CNMS is a reference repository, not a merge target.

## Development vs Production Architecture

```text
PRODUCTION
Browser -> Nginx -> Go 127.0.0.1:18888 (API + embedded static SPA) -> MongoDB

DEVELOPMENT
Browser -> Vite 127.0.0.1:13333 -> Go 127.0.0.1:18888 (/api proxy) -> MongoDB
```

In production, Nginx remains the sole public edge and Go serves both the API and the embedded static SPA. In local development, the Vite dev server on `127.0.0.1:13333` proxies `/api` calls directly to Go on `127.0.0.1:18888`, without requiring Nginx. The old Next.js runtime is retired, and port 13333 is reassigned to Vite development; port 13334 is retired.

## Evolution Authority

[Architecture evolution roadmap](architecture-evolution-roadmap.md) is the planned
architecture evolution authority. It defines the distinction between current,
short-term, medium-term, long-term, and future states. It does not override current
production deployment facts in this document or in
[Deployment](../operations/deployment.md).
