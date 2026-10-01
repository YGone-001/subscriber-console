# System Architecture

> Overview of the xCloud subscriber-console production architecture.
> Detailed rules: `CLAUDE.md`. Current state: `AGENTS.md`.
> Documentation authority: `docs/README.md`.

## Components

```text
Browser
   |
   v
Nginx  (sole public edge)
   |--------------------------------|
   |                                |
   v                                v
Next.js  127.0.0.1:13333        Go  127.0.0.1:18888
UI / rendering                  Business API (owner)
UI navigation guard             Auth identity + session validation
(no JWT, no MongoDB,            Read + write APIs
 no identity headers,           (84 exact METHOD+PATH registrations)
 no API forwarding)
   |                                |
   +---------------+----------------+
                   |
                   v
                MongoDB
           xcloud + xcloud_ops
```

## Routing

Nginx owns production API routing:

```text
/api                      -> Go 127.0.0.1:18888
/api/*                    -> Go 127.0.0.1:18888
/api/notifications/stream -> Go 127.0.0.1:18888 (unbuffered SSE)
/* (non-API)              -> Next.js 127.0.0.1:13333
```

Both application services bind loopback only and are reachable exclusively through
Nginx. Route authority is the derived Go registration set (84 exact METHOD+PATH
registrations parsed from `backend/cmd/server/main.go` plus
`backend/internal/remediation/handler.go`, shared helper
`scripts/lib/go-registrations.mjs`).

## Frontend

- Next.js 16.3.8 App Router
- React 19.2.4
- TypeScript 5.x
- Tailwind CSS 4
- SWR for data fetching
- Recharts for visualization
- Lucide React for icons

Location: `frontend/`

The Next.js runtime renders the UI and runs a UI-only navigation guard
(`frontend/src/proxy.ts`). It holds no business API handler, no JWT runtime, no
MongoDB client, and injects no identity headers.

## Go Backend

- Go 1.24+
- Standard library `net/http`
- Modern ServeMux method/path routing
- `log/slog` structured logging
- `mongo-driver/v2`

Location: `backend/`

## Database

Same Mongo URI, two databases:

- `xcloud` - subscriber, profile, OCS and tariff data
- `xcloud_ops` - operational data (`app_users`, `app_profiles`, `app_audit_logs`,
  `app_alerts`, `app_rate_limits`, `app_metrics`)

Go uses one `mongo.Client` with two database handles.

## Platform Services

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

## Domain Boundaries

```text
subscriber-console
  -> subscriber / profile / OCS / tariff / governance

CNMS (reference only)
  -> monitoring / signaling / capture / RCA / AIOps / NF
```

CNMS is a reference repository, not a merge target.
