# Deployment

## Architecture

```
Browser
   |
   v
Nginx (TLS termination, reverse proxy)
   |-----------------------------|
   v                             v
Next.js :13333                Go :18888
UI / Rendering               Business API
Legacy writes during         Auth validation
migration                    Read APIs
   |                             |
   +-------------+---------------+
                 |
                 v
              MongoDB
         xcloud + xcloud_ops
```

`/api/*` routes are progressively migrating from Next.js to Go behind Nginx.
Frontend SWR paths remain unchanged — the routing layer is transparent to the UI.

## Environment Requirements

- Node.js 20 or newer (`.nvmrc`)
- Go 1.24 or newer
- MongoDB reachable from both Next.js and Go
- Nginx (or equivalent reverse proxy) for production
- TLS termination in front of Nginx

## Build Steps

### Next.js

```bash
npm ci
npm run mongo:init
npm run build
```

### Go Backend

```bash
cd backend
go build ./cmd/server
```

The Go binary is a single static executable with no external runtime dependencies.

## Configuration

### Next.js Environment Variables

| Variable | Description | Default |
| --- | --- | --- |
| `MONGODB_URI` | MongoDB connection URI | `mongodb://127.0.0.1:27017` |
| `MONGODB_DB` | xCloud data database | `xcloud` |
| `MONGODB_XCLOUD_DB` | Explicit xCloud database override | falls back to `MONGODB_DB` |
| `MONGODB_APP_DB` | Application operations database | `xcloud_ops` |
| `MONGODB_MAX_POOL_SIZE` | Connection pool max size | `20` |
| `MONGODB_MIN_POOL_SIZE` | Connection pool min size | `0` |
| `MONGODB_SERVER_SELECTION_TIMEOUT_MS` | Selection timeout | `5000` |
| `JWT_SECRET` | JWT signing secret (≥32 bytes) | — |
| `INITIAL_ADMIN_PASSWORD` | Bootstrap admin password (≥8 chars) | — |

### Go Backend Environment Variables

| Variable | Description | Default |
| --- | --- | --- |
| `HTTP_ADDR` | Listen address | `:18888` |
| `MONGODB_URI` | MongoDB connection URI | `mongodb://127.0.0.1:27017` |
| `MONGODB_XCLOUD_DB` | xCloud data database | `xcloud` |
| `MONGODB_APP_DB` | Application operations database | `xcloud_ops` |

Go reuses the same MongoDB URI and database names as Next.js.
Both services connect to the same cluster using a single client per service.

## Nginx Configuration

```nginx
upstream nextjs {
    server 127.0.0.1:13333;
}

upstream golang {
    server 127.0.0.1:18888;
}

server {
    listen 443 ssl http2;
    server_name xcloud.example.com;

    # TLS config omitted — use certbot or your provider

    # Go-owned API routes (cutover table)
    location /api/subscribers {
        proxy_pass http://golang;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /api/profiles {
        proxy_pass http://golang;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # All other /api/* routes still go to Next.js during migration
    location /api/ {
        proxy_pass http://nextjs;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Everything else (UI pages, static assets) → Next.js
    location / {
        proxy_pass http://nextjs;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Route ownership is per method + path, not by prefix.
See [Migration Routing Matrix](backend-migration/migration-routing-matrix.md) for the current cutover list.

## Start Commands

### Development

```bash
# Terminal 1: Next.js
npm run dev

# Terminal 2: Go backend
cd backend
go run ./cmd/server
```

### Production

```bash
# Next.js
npm run start    # listens on :13333

# Go backend
cd backend
./server         # listens on :18888 (or HTTP_ADDR)
```

## Recommended Production Flow

1. Provision MongoDB or reuse the xCloud MongoDB host.
2. Configure environment variables for both Next.js and Go.
3. Build Next.js: `npm ci && npm run build`.
4. Build Go: `cd backend && go build ./cmd/server`.
5. Run `npm run mongo:init` to create indexes in both databases.
6. Start Next.js on `:13333` and Go on `:18888`.
7. Configure Nginx with the route split above.
8. Log in with the bootstrap `admin` account.
9. Create named operator/viewer accounts and store credentials securely.

## Health Checks

| Endpoint | Service | Description |
| --- | --- | --- |
| `GET /api/system/health` | Next.js | Application health |
| `GET /healthz` | Go | Liveness (no Mongo dependency) |
| `GET /readyz` | Go | Readiness (includes Mongo ping) |

## Common Issues

### Login fails with server error

Check that `JWT_SECRET` exists, is not a placeholder, and is at least 32 bytes.

### Admin account is not created

Ensure `INITIAL_ADMIN_PASSWORD` is set in `.env` (at least 8 characters) and run `npm run mongo:init` to bootstrap the root `admin` user.

### Dashboard or API data is empty

Confirm `MONGODB_URI`, `MONGODB_DB`, and `MONGODB_APP_DB` point to the expected databases, then run `npm run mongo:init`.

### Build succeeds but runtime APIs fail

Confirm production environment variables are available to the Node.js / Go process, not only during build.

### Go backend fails to start

Check that `MONGODB_URI` is reachable and the database names match. The Go backend logs to stderr with structured `slog` output.
