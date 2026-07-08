# subscriber-console

Open5GS subscriber operations console built with Next.js, React, and MongoDB.

It manages IMSI subscriber records, profile templates, rating policies, traffic analytics, CSV import/export, audit logs, local alerts, system health checks, and role-based access control.

## Features

- Subscriber CRUD, pagination, search, single create, batch create, CSV import, and delete.
- Open5GS-compatible MongoDB subscriber document generation.
- Profile template management with version history and restore.
- Rating group management for OCS policy templates.
- Analytics dashboard computed from MongoDB subscriber documents.
- Audit logs, alert acknowledgment, and system document consistency checks.
- JWT cookie authentication with `root`, `operator`, and `viewer` roles.
- Chinese/English UI, theme switching, command palette, and responsive dashboard layout.

## Tech Stack

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

## Quick Start

```bash
npm install
cp .env.example .env
npm run mongo:init
npm run dev
```

Open `http://localhost:3000`.

Set a strong `INITIAL_ADMIN_PASSWORD` in `.env` before first login. The app creates the `admin` account on first successful bootstrap login when it does not already exist.

## Environment

| Variable | Description |
| --- | --- |
| `MONGODB_URI` | MongoDB connection URI, usually the Open5GS database |
| `MONGODB_DB` | MongoDB database name, default `open5gs` |
| `MONGODB_MAX_POOL_SIZE` | Optional connection pool max size |
| `MONGODB_MIN_POOL_SIZE` | Optional connection pool min size |
| `MONGODB_SERVER_SELECTION_TIMEOUT_MS` | Optional MongoDB selection timeout |
| `JWT_SECRET` | JWT signing secret, at least 32 bytes |
| `INITIAL_ADMIN_PASSWORD` | Optional first admin password |

## Scripts

```bash
npm run dev                 # Start development server
npm run build               # Production build
npm run start               # Start production server
npm run lint                # Run ESLint
npm run typecheck           # Run TypeScript without emitting files
npm test                    # Run Node.js unit tests
npm run check               # Run lint, typecheck, tests, and build
npm run mongo:init          # Create MongoDB indexes
npm run mongo:migrate-redis # One-time legacy data migration
```

## Legacy Migration

Older deployments may still have data in Redis. Use the one-time migration script before cutting over:

```bash
REDIS_URL=redis://127.0.0.1:6379/0 npm run mongo:migrate-redis -- --dry-run
REDIS_URL=redis://127.0.0.1:6379/0 npm run mongo:migrate-redis
```

See [Legacy Redis To MongoDB Migration](docs/redis-to-mongo-migration.md).

## Deployment

Run the app as a Node.js service. It is not a static export.

```bash
npm ci
npm run mongo:init
npm run build
npm run start
```

More detail is available in [Deployment](docs/deployment.md).

## Checks

Before committing, run:

```bash
npm run check
```

## License

MIT License. See [LICENSE](LICENSE).
