# Architecture

## Project Goal

`subscriber-console` provides a web-based operations console for xCloud 4G/5G/OCS subscriber data. It focuses on practical operator workflows: provisioning IMSI records, managing reusable profile templates, configuring rating policies, observing traffic metrics, auditing changes, and repairing MongoDB document consistency.

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
- `src/app/api/analytics` provides metric snapshots and sparklines from MongoDB.
- `src/app/api/audit` exposes audit log search.
- `src/app/api/system/audit` scans and repairs subscriber document consistency.
- `src/app/api/alerts` exposes local alert data and acknowledgment.

### Domain Services

- `src/lib/mongo.ts` centralizes MongoDB client access.
- `src/server/repositories` contains MongoDB persistence logic.
- `src/lib/xcloudSubscriber.ts` builds xCloud-compatible subscriber documents.
- `src/lib/audit.ts` records operator actions and change details.
- `src/lib/analytics.ts` handles event hooks for analytics and sentinel checks.
- `src/lib/authz.ts` enforces API role authorization.
- `src/lib/security.ts` validates secret and password policy requirements.
- `src/lib/sentinel.ts` evaluates abnormal traffic events and local alerts.
- `src/lib/csv.ts` parses and emits CSV data.

## Data Model

The xCloud database stores HSS subscriber documents in MongoDB `subscribers`, following the xCloud-compatible document shape without embedded OCS data. OCS operational preset data is stored alongside it in:

- `ocs_tariff_plans`
- `ocs_subscribers`
- `ocs_balances`

Console-owned collections use the `app_` prefix:

- `app_profiles`
- `app_profile_versions`
- `app_users`
- `app_audit_logs`
- `app_alerts`
- `app_rate_limits`

## Data Flow

1. A user logs in through `/api/auth/login`.
2. The proxy verifies the JWT cookie and forwards user context through request headers.
3. Dashboard pages call API Route Handlers through SWR.
4. API handlers validate authorization, read/write MongoDB through repositories, and record audit events.
5. Audit writes may trigger analytics hooks and Sentinel checks.
6. UI components refresh affected SWR resources and show updated operational state.

## Key Dependencies

- Next.js App Router and Route Handlers
- React client components
- MongoDB Node.js driver
- jose for JWT signing and verification
- bcryptjs for password hashing
- SWR for client data fetching
- Recharts for dashboard visualization
- lucide-react for icons

## Extension Directions

- Add automated tests for MongoDB repository contracts and API authorization.
- Introduce typed validation schemas for API request bodies.
- Add OpenAPI documentation generation for Route Handlers.
- Add container deployment artifacts and health probes.
- Support external identity providers or SSO.
- Add structured observability for logs, metrics, and traces.
- Add migration scripts for future xCloud document schema changes.
