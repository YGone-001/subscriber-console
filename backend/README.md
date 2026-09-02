# Go Backend

This directory contains the Go backend for xCloud subscriber-console.

## Quick Start

```bash
# Required
export JWT_SECRET="your-jwt-secret-at-least-32-bytes"

# Optional — defaults shown
export MONGODB_URI="mongodb://127.0.0.1:27017"
export MONGODB_XCLOUD_DB="xcloud"
export MONGODB_APP_DB="xcloud_ops"

# Run
go run ./cmd/server

# Test
go test -race ./...

# Build
go build -o server ./cmd/server
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `HTTP_ADDR` | `:18888` | Listen address |
| `HTTP_READ_TIMEOUT` | `15s` | HTTP read timeout |
| `HTTP_WRITE_TIMEOUT` | `30s` | HTTP write timeout |
| `HTTP_IDLE_TIMEOUT` | `120s` | HTTP idle timeout |
| `HTTP_SHUTDOWN_TIMEOUT` | `10s` | Graceful shutdown timeout |
| `MONGODB_URI` | `mongodb://127.0.0.1:27017` | MongoDB connection URI |
| `MONGODB_XCLOUD_DB` | `xcloud` | HSS/OCS database name |
| `MONGODB_APP_DB` | `xcloud_ops` | Operations database name |
| `JWT_SECRET` | — (required) | JWT signing secret, ≥32 bytes |

## Endpoints

### Health (no auth)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/healthz` | Liveness probe |
| GET | `/readyz` | Readiness probe (pings MongoDB) |

### Audit

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/audit` | List audit logs |
| GET | `/api/audit/{id}` | Get audit log detail |

### Analytics

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/analytics/metrics` | Dashboard metrics |
| GET | `/api/analytics/sparkline` | Sparkline data |

### Ratings

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/ratings` | List rating policies |
| GET | `/api/ratings/{id}` | Get rating policy detail |

### Profiles

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/profiles` | List profiles |
| GET | `/api/profiles/{name}` | Get profile detail |
| GET | `/api/profiles/{name}/stats` | Profile statistics |
| GET | `/api/profiles/{name}/versions` | Profile versions |

### OCS

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/ocs/balances` | OCS balances |
| GET | `/api/ocs/sessions` | OCS sessions |
| GET | `/api/ocs/usage` | OCS usage records |
| GET | `/api/ocs/reservations` | OCS reservations |

### Tariff Plans

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/tariff-plans` | List tariff plans |
| GET | `/api/tariff-plans/{planId}` | Get tariff plan detail |
| GET | `/api/tariff-plans/{planId}/export` | Export tariff plan |
| GET | `/api/tariff-plans/{planId}/operations` | Plan operations |
| GET | `/api/tariff-plans/{planId}/rules` | Plan rules |
| GET | `/api/tariff-plans/{planId}/subscribers` | Plan subscribers |
| GET | `/api/tariff-plans/{planId}/migrate` | Migration preview |

### Subscribers

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/subscribers` | List subscribers |
| GET | `/api/subscribers/{imsi}` | Get subscriber detail |
| GET | `/api/search` | Search subscribers |
| POST | `/api/subscribers/batch/precheck` | Batch precheck |

### Auth / Users

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/auth/me` | Current user info |
| GET | `/api/auth/permissions` | Current user permissions |
| GET | `/api/auth/users` | List users (legacy format) |
| GET | `/api/auth/users/{username}` | Get user detail |
| GET | `/api/users` | List users (query format) |
| GET | `/api/users/{username}` | Get user detail |

## Module Path

`github.com/YGone-001/subscriber-console/backend`
