# Architecture

## Project Goal

`subscriber-console` provides a web-based operations console for 4G/5G/OCS subscriber data. It focuses on practical operator workflows: provisioning IMSI records, managing reusable profile templates, configuring rating policies, observing traffic metrics, auditing changes, and repairing Redis data inconsistencies.

## Module Breakdown

### App Router UI

- `src/app/(dashboard)` contains authenticated dashboard routes.
- `src/app/login` contains the login surface.
- `src/components` contains shared UI, modals, cockpit charts, command palette, language and theme controls.

### API Layer

- `src/app/api/auth` handles login, logout, current user, and user administration.
- `src/app/api/subscribers` handles subscriber CRUD, import, batch precheck, and batch creation.
- `src/app/api/profiles` handles profile templates and version restore flows.
- `src/app/api/ratings` handles OCS rating group templates.
- `src/app/api/analytics` provides metric initialization, snapshots, and sparklines.
- `src/app/api/audit` exposes audit log search.
- `src/app/api/system/audit` scans and repairs Redis data consistency.
- `src/app/api/alerts` exposes local alert data and acknowledgment.

### Domain Services

- `src/lib/redis.ts` centralizes Redis access.
- `src/lib/audit.ts` records operator actions and change details.
- `src/lib/analytics.ts` updates aggregate metrics after data mutations.
- `src/lib/authz.ts` enforces API role authorization.
- `src/lib/security.ts` validates secret and password policy requirements.
- `src/lib/sentinel.ts` evaluates abnormal traffic events and local alerts.
- `src/lib/csv.ts` parses and emits CSV data.

### Data Model

The application stores and reads domain data from Redis keys for subscriber definitions, OCS account data, profile templates, rating groups, audit records, alerts, and derived statistics. TypeScript interfaces under `src/types` describe subscriber, session, slice, QoS, rating, and PLMN-related data.

## Data Flow

1. A user logs in through `/api/auth/login`.
2. The proxy verifies the JWT cookie and forwards user context through request headers.
3. Dashboard pages call API Route Handlers through SWR.
4. API handlers validate authorization, read/write Redis, and record audit events.
5. Audit writes update analytics and may trigger Sentinel checks.
6. UI components refresh affected SWR resources and show updated operational state.

## Key Dependencies

- Next.js App Router and Route Handlers
- React client components
- Redis through ioredis
- jose for JWT signing and verification
- bcryptjs for password hashing
- SWR for client data fetching
- Recharts for dashboard visualization
- lucide-react for icons

## Extension Directions

- Add automated tests for Redis data contracts and API authorization.
- Introduce typed validation schemas for API request bodies.
- Add OpenAPI documentation generation for Route Handlers.
- Add container deployment artifacts and health probes.
- Support external identity providers or SSO.
- Add structured observability for logs, metrics, and traces.
- Add data migration scripts for Redis key schema changes.
