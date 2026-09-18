# subscriber-console

xCloud subscriber operations console built with Next.js, Go, React, and MongoDB.

It manages IMSI subscriber records, profile templates, OCS tariff plans, subscriber contracts, balance accounts, rating policies, traffic analytics, CSV import/export, audit logs, approval governance, local alerts, system health checks, and role-based access control.

## Architecture

```
subscriber-console/
├── frontend/          # Next.js + React UI
│   ├── src/
│   ├── public/
│   ├── tests/
│   └── package.json
├── backend/           # Go REST API
│   ├── cmd/
│   ├── internal/
│   └── go.mod
├── docs/              # Project documentation
│   ├── architecture/
│   ├── backend-migration/
│   ├── api/
│   ├── database/
│   └── operations/
├── scripts/           # Operational and migration scripts
├── CLAUDE.md
└── AI_CONTEXT.md
```

```
Browser → Nginx
           ├── /*         → Next.js :13333 (React UI)
           └── /api/*     → Go :18888 (REST API + MongoDB)
```

API routes are progressively migrating from Next.js to Go on a per-endpoint basis.

## Features

- Subscriber CRUD, pagination, search, single create, batch create, CSV import, and delete.
- xCloud-compatible MongoDB subscriber document generation.
- Profile template management with version history and restore.
- OCS management: tariff plans, subscriber contracts, balance accounts, dashboard.
- Rating group management for OCS policy templates.
- Analytics dashboard computed from MongoDB subscriber documents.
- Approval governance with maker-checker workflow, risk policy, and audit trail.
- Audit logs, alert acknowledgment, and system document consistency checks.
- JWT cookie authentication with `root`, `operator`, and `viewer` roles.
- Chinese/English UI, theme switching, command palette, and responsive dashboard layout.

## Tech Stack

### Frontend

- Next.js 16.2.2 App Router
- React 19.2.4
- TypeScript 5
- MongoDB Node.js driver
- SWR
- Recharts
- jose JWT
- bcryptjs
- lucide-react
- ESLint 9

### Backend

- Go 1.24+
- Standard library `net/http`
- `log/slog`
- `mongo-driver/v2`

## Quick Start

### Frontend

```bash
cd frontend
npm install
cp .env.example .env
npm run mongo:init
npm run dev
```

Open `http://localhost:3000`.

Set a strong `INITIAL_ADMIN_PASSWORD` in `.env` before running `npm run mongo:init`. The initialization script creates the initial `admin` account when it does not already exist.

### Backend

```bash
cd backend
go run ./cmd/server
```

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
# Frontend (from frontend/)
npm run dev                 # Start development server
npm run build               # Production build
npm run start               # Start production server
npm run lint                # Run ESLint
npm run typecheck           # Run TypeScript without emitting files
npm test                    # Run Node.js unit tests
npm run check               # Run lint, typecheck, tests, and build
npm run mongo:init          # Create MongoDB indexes
npm run mongo:migrate-app-db # Move app_* collections from xcloud to the app database
npm run mongo:test-core     # Run MongoDB core integration smoke test against a temporary DB
npm run mongo:perf          # Explain key MongoDB queries and flag slow scans
```

MongoDB operational scripts write JSON reports to `reports/ops/` by default. Set `OPS_REPORT_DIR` to override the location.

`xcloud` stores HSS subscriber data in `subscribers` and OCS preset data in `ocs_tariff_plans`, `ocs_subscribers`, and `ocs_balances`. Project-owned collections such as `app_users`, `app_profiles`, `app_audit_logs`, `app_alerts`, `app_rate_limits`, and `app_metrics` live in `MONGODB_APP_DB`.
`npm run mongo:init` creates indexes, seeds the default OCS tariff plan, imports legacy rating rules, and inserts missing OCS subscriber/balance rows without overwriting existing balances.

## Deployment

The application runs as two services behind Nginx: Next.js on `:13333` and Go on `:18888`.

```bash
# Frontend
cd frontend
npm ci
npm run mongo:init
npm run build
npm run start

# Backend
cd backend
go build ./cmd/server
./server
```

More detail is available in [Deployment](docs/operations/deployment.md).

## Documentation

| Document | Location |
| --- | --- |
| Architecture | `docs/architecture/` |
| Backend Migration | `docs/backend-migration/` |
| API Reference | `docs/api/` |
| Database | `docs/database/` |
| Operations | `docs/operations/` |
| Project Rules | `CLAUDE.md` |
| Current State | `AI_CONTEXT.md` |

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
