# Go Backend

This directory contains the Go backend for xCloud subscriber-console.

## Phase 1 — Foundation

- Config from environment variables
- MongoDB client with dual-database support (open5gs + xcloud_ops)
- Health endpoints: `/healthz` (liveness), `/readyz` (readiness with Mongo ping)
- Middleware: RequestID, Recovery, AccessLog, Security
- JSON response helpers matching existing error shape `{"error":"...","code":"..."}`
- Graceful shutdown on SIGINT/SIGTERM
- Structured logging via `log/slog`

## Quick Start

```bash
# Set environment variables
export MONGODB_URI="mongodb://127.0.0.1:27017"
export MONGODB_OPEN5GS_DB="open5gs"
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
| `HTTP_ADDR` | `:8080` | Listen address |
| `HTTP_READ_TIMEOUT` | `15s` | HTTP read timeout |
| `HTTP_WRITE_TIMEOUT` | `30s` | HTTP write timeout |
| `HTTP_IDLE_TIMEOUT` | `120s` | HTTP idle timeout |
| `HTTP_SHUTDOWN_TIMEOUT` | `10s` | Graceful shutdown timeout |
| `MONGODB_URI` | `mongodb://127.0.0.1:27017` | MongoDB connection URI |
| `MONGODB_OPEN5GS_DB` | `open5gs` | HSS/OCS database name |
| `MONGODB_APP_DB` | `xcloud_ops` | Operations database name |

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /healthz` | Liveness probe (no dependencies) |
| `GET /readyz` | Readiness probe (pings MongoDB) |

## Module Path

`github.com/YGone-001/subscriber-console/backend`
