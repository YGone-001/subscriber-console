# subscriber-console

xCloud subscriber operations console built with React, Vite, Go, and MongoDB.

It manages IMSI subscriber records, profile templates, OCS tariff plans, subscriber contracts, balance accounts, rating policies, traffic analytics, CSV import/export, operation logs, local alerts, system health checks, and role-based access control.

## Architecture

```
subscriber-console/
├── frontend/          # Canonical React + TypeScript + Vite SPA source
├── backend/           # Go REST API + embedded static SPA hosting
│   ├── cmd/
│   ├── internal/
│   └── go.mod
├── deploy/            # Nginx production configuration
├── docs/              # Project documentation
│   ├── architecture/
│   ├── database/
│   ├── operations/
│   ├── archive/
│   └── README.md      # Documentation authority / index
├── scripts/           # Acceptance tests and operational scripts
├── README.md
├── CLAUDE.md
└── AGENTS.md
```

### Production Architecture

```
Browser → Nginx (only public origin)
           └── /*, /api/* → Go 127.0.0.1:18888 (API + embedded static React SPA)
```

The Nginx edge routes all public production traffic to the single Go upstream (`127.0.0.1:18888`).
The Go backend owns every production API operation (84 exact METHOD+PATH registrations),
session authentication, and embedded static React SPA hosting.
Next.js runtime is completely retired. Production Node.js runtime required = NO.

### Development Architecture

```
Browser → Vite dev server 127.0.0.1:13333
           └── /api/* → Go 127.0.0.1:18888
```

In local development, the Vite dev server runs at `127.0.0.1:13333` and proxies `/api/*` to the Go backend at `127.0.0.1:18888`.
Local development does not require Nginx.

## Features

- Subscriber CRUD, pagination, search, single create, batch create, CSV import, and delete.
- xCloud-compatible MongoDB subscriber document generation.
- Profile template management with version history and restore.
- OCS management: tariff plans, subscriber contracts, balance accounts, dashboard.
- Rating group management for OCS policy templates.
- Analytics dashboard computed from MongoDB subscriber documents.
- Direct execution operation model with RBAC, operation logging, and CAS concurrency control.
- Audit logs, alert acknowledgment, and system document consistency checks.
- Hardened JWT authentication with dual rate limits (IP + username), automatic lockout after 10 failed attempts, response privacy, and canonical `admin`, `operator`, and `viewer` roles (with legacy alias normalization), authoritatively governed by the Go backend (all 84 registrations Go-owned; routed by the Nginx edge).
- User lifecycle management: create, update, admin unlock, soft delete, password reset, session invalidation via `sessionVersion`.
- Chinese/English UI, theme switching, command palette, and responsive dashboard layout.

## OCS Management Plane Status

OCS Management Plane is frozen.
Managed domains:
- Tariff Plans
- Contract Subscribers
- Balance Management

Charging Plane remains frozen and excluded.

## Tech Stack

### Canonical Frontend (SPA)

- React 19.2.4
- Vite 8
- React Router 7
- TypeScript 5
- Tailwind CSS 4
- Lucide React

Static assets are built from `frontend/` and embedded directly into the Go backend binary.

### Backend

- Go 1.24+
- Standard library `net/http`
- `log/slog`
- `mongo-driver/v2`

### Edge & Storage

- Nginx (single public edge upstream `xcloud_go`)
- MongoDB (databases `xcloud` + `xcloud_ops`)

### Legacy Frontend

- Retired (Next.js App Router retired; numeric port 13333 reassigned to Vite development).

## Quick Start

The production application is served by the Nginx edge fronting Go `127.0.0.1:18888`.
In local development, the application runs on Vite `127.0.0.1:13333` proxying to Go `127.0.0.1:18888`.

```text
MongoDB     xcloud + xcloud_ops
Go backend  127.0.0.1:18888   internal application service (API + embedded static SPA)
Vite dev    127.0.0.1:13333   local frontend development server (/api proxy to Go)
Nginx edge  production public browser entry, default http://localhost
```

Local development workflow:

```text
1. npm run local:preflight    inspect ports/process ownership (read-only)
2. start MongoDB
3. npm run local:dev          start managed Go + Vite development processes
4. npm run local:doctor       verify the dev topology
5. browse http://localhost:13333
```

### 1. Install dependencies

```bash
# From the repository root: install dependencies used by scripts/.
npm ci
cp .env.example .env
# Edit .env with the intended local values before continuing.

# Install frontend dependencies:
cd frontend
npm ci
cd ..
```

Set the same strong `JWT_SECRET` and `INITIAL_ADMIN_PASSWORD` in root `.env` before running `npm run mongo:init`. The initialization script creates the initial `admin` account when it does not already exist.

### 2. Initialize MongoDB

```bash
npm run mongo:init
```

### 3. Inspect the canonical ports

```bash
npm run local:preflight
```

Read-only. It classifies the owner of ports 13333, 18888 and 27017 before anything starts.
Never resolve canonical port contamination by changing 13333/18888; diagnose the owner.

### 4. Start the required services

Start MongoDB yourself (it is never started automatically).

Then start the project-owned Go and Vite development processes:

```bash
npm run local:dev
```

This builds and runs Go on `127.0.0.1:18888` and Vite on `127.0.0.1:13333`, and records process ownership.
Local development does not require Nginx.

### 5. Verify

```bash
npm run local:status
npm run local:doctor
```

`local:doctor` prints `FULL_STACK_READY` when the full topology is up.

### 6. Open

Open the local application at:

```text
http://localhost:13333
```

### 7. Stop

```bash
npm run local:stop
```

Stops only the Go and Vite processes that `local:dev` launched, after verifying their
ownership records. It does not stop MongoDB, the system Nginx, or foreign processes.

## Environment

| Variable | Description |
| --- | --- |
| `MONGODB_URI` | MongoDB connection URI, usually the xCloud MongoDB host |
| `MONGODB_DB` | xCloud data database name, default `xcloud` |
| `MONGODB_XCLOUD_DB` | Optional explicit xCloud database override; falls back to `MONGODB_DB` |
| `MONGODB_APP_DB` | Application operations database for `app_*` collections, default `xcloud_ops` |
| `MONGODB_MAX_POOL_SIZE` | Optional connection pool max size |
| `MONGODB_MIN_POOL_SIZE` | Optional connection pool min size |
| `MONGODB_SERVER_SELECTION_TIMEOUT_MS` | Optional MongoDB selection timeout |
| `JWT_SECRET` | JWT signing secret, at least 32 bytes |
| `INITIAL_ADMIN_PASSWORD` | Optional first admin password |

## Scripts

```bash
# Repository-root operational scripts (run `npm ci` at the repository root first)
npm run mongo:init          # Create MongoDB indexes
npm run mongo:migrate-app-db # Move app_* collections from xcloud to the app database
npm run mongo:test-core     # Run MongoDB core integration smoke test against a temporary DB
npm run mongo:perf          # Explain key MongoDB queries and flag slow scans
npm run local:preflight     # Inspect canonical port ownership before starting anything
npm run local:dev           # Start managed Go + Vite development processes
npm run local:status        # Report component and topology state
npm run local:doctor        # Diagnose the running local full-stack topology
npm run local:stop          # Stop only the processes started by local:dev

# Frontend (from frontend/)
npm run dev                 # Start the local Vite development server
npm run build               # Build the production static SPA
npm run preview             # Preview the built SPA locally; not a production runtime
npm run lint                # Run ESLint
npm run typecheck           # Run TypeScript checks without emitting files
npm test                    # Run frontend tests
npm run check               # Run lint, typecheck, tests, and build
```

Production does not start a frontend server.
The production SPA is built from frontend/, staged for Go embedding,
compiled into the Go binary, and served through Nginx -> Go.


MongoDB operational scripts write JSON reports to `reports/ops/` by default. Set `OPS_REPORT_DIR` to override the location.

Use Node.js 20.19.0 or newer. Install dependencies separately at the repository root and in `frontend/`; never share or copy `node_modules` between them or between operating systems.

`xcloud` stores HSS subscriber data in `subscribers` and OCS preset data in `ocs_tariff_plans`, `ocs_subscribers`, and `ocs_balances`. Project-owned collections such as `app_users`, `app_profiles`, `app_audit_logs`, `app_alerts`, `app_rate_limits`, and `app_metrics` live in `MONGODB_APP_DB`.
`npm run mongo:init` creates indexes, seeds the default OCS tariff plan, imports legacy rating rules, and inserts missing OCS subscriber/balance rows without overwriting existing balances.

## Deployment

Production runs as a single loopback-internal Go application service behind the Nginx edge:
Go on `127.0.0.1:18888` serving both the API and the embedded static React SPA.
The Nginx edge routes all public traffic (`/*`, `/api`, `/api/*`) directly to Go; install it with
`sudo ./deploy/nginx/setup.sh [listen_port]` (the script validates with `nginx -t`).
The full-stack browser entry is the Nginx edge URL (default `http://localhost`), never
an internal component port.

Production build and deployment pipeline:

```bash
# 1. Build production static SPA
cd frontend
npm ci
npm run build
cd ..

# 2. Stage SPA static assets for Go binary embedding
node scripts/stage-spa-for-go.mjs

# 3. Compile bundled Go server binary
cd backend
go build -o bin/server ./cmd/server
cd ..

# 4. Initialize database indexes
npm run mongo:init

# 5. Start Go application service (loopback-internal)
./backend/bin/server

# 6. Configure and activate public Nginx edge router
sudo ./deploy/nginx/setup.sh
```

More detail is available in [Deployment](docs/operations/deployment.md).

## Documentation

| Document | Location |
| --- | --- |
| Documentation index / authority | [docs/README.md](docs/README.md) |
| Architecture | `docs/architecture/` |
| Database | `docs/database/` |
| Operations | `docs/operations/` |
| Archive (concise historical summary only) | `docs/archive/` |
| Project Rules | `CLAUDE.md` |
| Current State | `AGENTS.md` |

## Checks

Before committing, run:

```bash
# Frontend
cd frontend && npm run check

# Backend
cd backend && go vet ./... && go build ./...
```

## License

MIT License. See [LICENSE](LICENSE).
