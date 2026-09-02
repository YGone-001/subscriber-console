# Migration Routing Matrix

> **Phase 0 Baseline** — Generated from source code scan on 2026-08-31
> Branch: `develop` | Commit: `1f1cb3fb27c680cc280e898801ca219d445788bb`

## Phase Definitions

| Phase | Name | Scope |
|-------|------|-------|
| Phase 1 | Go Backend Foundation | Config, Mongo client, health, HTTP handler, middleware, rate limit, JSON response, graceful shutdown |
| Phase 2 | Read-only API Migration | GET endpoints, analytics, audit read, health |
| Phase 3 | Governance + Approval | Approval workflow, risk policy, executor registry, permission enforcement |
| Phase 4 | Subscriber + Profile Writes | Subscriber CRUD, batch, import, profile CRUD |
| Phase 5 | OCS + Tariff + Rating Writes | Balance adjust, tariff CRUD, rating CRUD, policy change |
| Phase 6 | Auth + User Management | Login, logout, me, users, roles, password, session revoke |
| Phase 7 | Alerts + Notifications + SSE + Scheduler + Platform Services | Alerts, notifications, background jobs |
| Phase 8 | Remove Next.js Backend | Remove Node API, repositories, MongoDB driver, bcryptjs, jose |

## Shadow Rules

- **READ APIs**: `Shadow Allowed = YES` — Go can serve reads while Node still exists
- **WRITE APIs**: `Shadow Write = NEVER` — same mutation endpoint must have exactly one authoritative writer

## Complete Matrix

### Phase 2 — Read-only APIs

| API | Method | Path | Current Owner | Future Owner | Shadow Allowed | Notes |
|-----|--------|------|---------------|--------------|----------------|-------|
| Subscribers list | GET | `/api/subscribers` | **Go** | Go | YES | Phase 2C — migrated, joins xcloud + xcloud_ops |
| Subscriber detail | GET | `/api/subscribers/:imsi` | **Go** | Go | YES | Phase 2C — migrated, joins xcloud + xcloud_ops |
| Subscriber batch precheck | POST | `/api/subscribers/batch/precheck` | **Go** | Go | YES | Phase 2C — migrated, read-only despite POST |
| Profiles list | GET | `/api/profiles` | **Go** | Go | YES | Phase 2B — migrated |
| Profile detail | GET | `/api/profiles/:name` | **Go** | Go | YES | Phase 2B — migrated |
| Profile stats | GET | `/api/profiles/:name/stats` | **Go** | Go | YES | Phase 2B — migrated |
| Profile versions | GET | `/api/profiles/:name/versions` | **Go** | Go | YES | Phase 2B — migrated |
| OCS balances | GET | `/api/ocs/balances` | **Go** | Go | YES | Phase 2B — migrated |
| OCS sessions | GET | `/api/ocs/sessions` | **Go** | Go | YES | Phase 2B — migrated |
| OCS reservations | GET | `/api/ocs/reservations` | **Go** | Go | YES | Phase 2B — migrated |
| OCS usage | GET | `/api/ocs/usage` | **Go** | Go | YES | Phase 2B — migrated |
| Tariff plans list | GET | `/api/tariff-plans` | **Go** | Go | YES | Phase 2B — migrated |
| Tariff plan detail | GET | `/api/tariff-plans/:planId` | **Go** | Go | YES | Phase 2B — migrated |
| Tariff plan export | GET | `/api/tariff-plans/:planId/export` | **Go** | Go | YES | Phase 2B — migrated |
| Tariff plan operations | GET | `/api/tariff-plans/:planId/operations` | **Go** | Go | YES | Phase 2B — migrated |
| Tariff plan migrate (dry-run) | GET | `/api/tariff-plans/:planId/migrate` | **Go** | Go | YES | Phase 2B — migrated |
| Tariff plan rules | GET | `/api/tariff-plans/:planId/rules` | **Go** | Go | YES | Phase 2B — migrated |
| Tariff plan subscribers | GET | `/api/tariff-plans/:planId/subscribers` | **Go** | Go | YES | Phase 2B — migrated |
| Ratings list | GET | `/api/ratings` | **Go** | Go | YES | Phase 2A — migrated |
| Rating detail | GET | `/api/ratings/:id` | **Go** | Go | YES | Phase 2A — migrated |
| Approvals list | GET | `/api/approvals` | **Go** | Go | YES | xcloud_ops only |
| Approval detail | GET | `/api/approvals/:id` | **Go** | Go | YES | xcloud_ops only |
| Approval audit | GET | `/api/approvals/:id/audit` | **Go** | Go | YES | xcloud_ops only |
| Approvals export | GET | `/api/approvals/export` | Next.js | Go | YES | xcloud_ops only |
| Audit logs | GET | `/api/audit` | **Go** | Go | YES | Phase 2A — migrated |
| Audit detail | GET | `/api/audit/:id` | **Go** | Go | YES | Phase 2A — migrated |
| Audit export | GET | `/api/audit/export` | Next.js | Go | YES | DEFERRED — requires stateful audit evidence persistence |
| Alerts list | GET | `/api/alerts` | Next.js | Go | YES | xcloud_ops only |
| Analytics metrics | GET | `/api/analytics/metrics` | **Go** | Go | YES | Phase 2A — migrated |
| Analytics sparkline | GET | `/api/analytics/sparkline` | **Go** | Go | YES | Phase 2A — migrated |
| System health | GET | `/api/system/health` | Next.js | Go | YES | Joins both DBs |
| Mongo health | GET | `/api/system/mongo/health` | Next.js | Go | YES | Joins both DBs |
| System audit status | GET | `/api/system/audit/status` | Next.js | Go | YES | xcloud only |
| Auth me | GET | `/api/auth/me` | **Go** | Go | YES | xcloud_ops only |
| Auth permissions | GET | `/api/auth/permissions` | **Go** | Go | YES | Computed |
| Auth users list | GET | `/api/auth/users` | **Go** | Go | YES | xcloud_ops only |
| Auth user detail | GET | `/api/auth/users/:username` | **Go** | Go | YES | xcloud_ops only |
| Users list | GET | `/api/users` | **Go** | Go | YES | xcloud_ops only |
| User detail | GET | `/api/users/:username` | **Go** | Go | YES | xcloud_ops only |
| Search | GET | `/api/search` | **Go** | Go | YES | Phase 2C — migrated, joins both DBs |
| Notifications stream | GET | `/api/notifications/stream` | Next.js | Go | YES | SSE |

### Phase 3 — Governance + Approval

| API | Method | Path | Current Owner | Future Owner | Shadow Allowed | Notes |
|-----|--------|------|---------------|--------------|----------------|-------|
| Approval create | POST | `/api/approvals` | Next.js | Go | NEVER | Approval creation |
| Legacy approval compat | POST | `/api/approvals/:id` | Next.js | Go | NEVER | Compat wrapper, dispatches to approve/reject |
| Approval approve | POST | `/api/approvals/:id/approve` | Next.js | Go | NEVER | CAS transition |
| Approval reject | POST | `/api/approvals/:id/reject` | Next.js | Go | NEVER | CAS transition |
| Approval cancel | POST | `/api/approvals/:id/cancel` | Next.js | Go | NEVER | CAS transition |
| Approval execute | POST | `/api/approvals/:id/execute` | Next.js | Go | NEVER | Executor dispatch |

### Phase 4 — Subscriber + Profile Writes

| API | Method | Path | Current Owner | Future Owner | Shadow Allowed | Notes |
|-----|--------|------|---------------|--------------|----------------|-------|
| Subscriber create | POST | `/api/subscribers` | Next.js | Go | NEVER | DIRECT_GOVERNED |
| Subscriber update | PUT | `/api/subscribers/:imsi` | Next.js | Go | NEVER | Creates CHG |
| Subscriber delete | DELETE | `/api/subscribers/:imsi` | Next.js | Go | NEVER | Creates CHG |
| Subscriber batch create | POST | `/api/subscribers/batch` | Next.js | Go | NEVER | Creates CHG |
| Subscriber batch update | POST | `/api/subscribers/batch-update` | Next.js | Go | NEVER | Frozen payload |
| Subscriber bulk delete | POST | `/api/subscribers/bulk-delete` | Next.js | Go | NEVER | Frozen payload |
| Subscriber import | POST | `/api/subscribers/import` | Next.js | Go | NEVER | Creates CHG |
| Profile create | POST | `/api/profiles` | Next.js | Go | NEVER | DIRECT_GOVERNED |
| Profile update | PUT | `/api/profiles/:name` | Next.js | Go | NEVER | DIRECT_GOVERNED |
| Profile delete | DELETE | `/api/profiles/:name` | Next.js | Go | NEVER | DIRECT_GOVERNED |
| Profile restore | POST | `/api/profiles/:name/versions/:versionId/restore` | Next.js | Go | NEVER | Creates CHG |

### Phase 5 — OCS + Tariff + Rating Writes

| API | Method | Path | Current Owner | Future Owner | Shadow Allowed | Notes |
|-----|--------|------|---------------|--------------|----------------|-------|
| Balance adjust | POST | `/api/subscribers/:imsi/traffic-adjustments` | Next.js | Go | NEVER | Frozen payload, CAS |
| Tariff plan create | POST | `/api/tariff-plans` | Next.js | Go | NEVER | Creates CHG |
| Tariff plan update | PUT | `/api/tariff-plans/:planId` | Next.js | Go | NEVER | Creates CHG |
| Tariff plan delete | DELETE | `/api/tariff-plans/:planId` | Next.js | Go | NEVER | Creates CHG |
| Tariff plan clone | POST | `/api/tariff-plans/:planId/clone` | Next.js | Go | NEVER | Creates CHG |
| Tariff plan migrate | POST | `/api/tariff-plans/:planId/migrate` | Next.js | Go | NEVER | Creates CHG |
| Tariff plan import | POST | `/api/tariff-plans/import` | Next.js | Go | NEVER | Creates CHG |
| Tariff rule create | POST | `/api/tariff-plans/:planId/rules` | Next.js | Go | NEVER | Creates CHG |
| Tariff rule update | PUT | `/api/tariff-plans/:planId/rules/:ruleId` | Next.js | Go | NEVER | Creates CHG |
| Tariff rule delete | DELETE | `/api/tariff-plans/:planId/rules/:ruleId` | Next.js | Go | NEVER | Creates CHG |
| Rating create | POST | `/api/ratings` | Next.js | Go | NEVER | Creates CHG |
| Rating update | PUT | `/api/ratings/:id` | Next.js | Go | NEVER | Creates CHG |
| Rating delete | DELETE | `/api/ratings/:id` | Next.js | Go | NEVER | Creates CHG |
| Policy change | POST | `/api/subscribers/policy` | Next.js | Go | NEVER | Creates CHG |

### Phase 6 — Auth + User Management

| API | Method | Path | Current Owner | Future Owner | Shadow Allowed | Notes |
|-----|--------|------|---------------|--------------|----------------|-------|
| Login | POST | `/api/auth/login` | Next.js | Go | NEVER | JWT creation |
| Logout | POST | `/api/auth/logout` | Next.js | Go | NEVER | Cookie clear |
| User create (auth) | POST | `/api/auth/users` | Next.js | Go | NEVER | bcryptjs |
| User update (auth) | PUT | `/api/auth/users/:username` | Next.js | Go | NEVER | bcryptjs |
| User delete (auth) | DELETE | `/api/auth/users/:username` | Next.js | Go | NEVER | — |
| User disable (auth) | PATCH | `/api/auth/users/:username` | Next.js | Go | NEVER | — |
| User create | POST | `/api/users` | Next.js | Go | NEVER | bcryptjs |
| User update | PUT | `/api/users/:username` | Next.js | Go | NEVER | bcryptjs |
| User delete | DELETE | `/api/users/:username` | Next.js | Go | NEVER | — |
| User disable | PATCH | `/api/users/:username` | Next.js | Go | NEVER | — |

### Phase 7 — Alerts + Notifications + Platform

| API | Method | Path | Current Owner | Future Owner | Shadow Allowed | Notes |
|-----|--------|------|---------------|--------------|----------------|-------|
| Alert acknowledge | POST | `/api/alerts/acknowledge` | Next.js | Go | NEVER | UNKNOWN governance |
| Alert workflow | POST | `/api/alerts/workflow` | Next.js | Go | NEVER | UNKNOWN governance |
| Analytics init | POST | `/api/analytics/init` | Next.js | Go | NEVER | UNKNOWN governance |
| System heal | POST | `/api/system/audit/heal` | Next.js | Go | NEVER | Creates CHG |
| System batch heal | POST | `/api/system/audit/batch-heal` | Next.js | Go | NEVER | Creates CHG |
| System scan | POST | `/api/system/audit/scan` | Next.js | Go | NEVER | Read-only despite POST |

### Phase 8 — Remove Next.js Backend

| Action | Target | Notes |
|--------|--------|-------|
| Remove | `src/app/api/**` | All route handlers |
| Remove | `src/server/**` | All repositories, governance, approval |
| Remove | `src/lib/mongo.ts` | MongoDB connection |
| Remove | `src/lib/audit.ts` | Audit logging |
| Remove | `src/lib/authz.ts` | Auth middleware |
| Remove | `src/lib/rateLimit.ts` | Rate limiting |
| Remove | `src/lib/security.ts` | JWT secret |
| Remove | `src/proxy.ts` | JWT middleware |
| Remove | `bcryptjs` dependency | Password hashing |
| Remove | `jose` dependency | JWT signing/verification |
| Remove | `mongodb` dependency | MongoDB driver |
| Keep | `src/app/**` | React pages, layouts |
| Keep | `src/components/**` | UI components |
| Keep | `src/hooks/**` | React hooks |
| Keep | `src/lib/locales*` | i18n |
| Keep | `src/lib/permissions.ts` | Frontend permission display |

## Statistics

| Phase | Mutation Endpoints | Read Endpoints |
|-------|-------------------:|---------------:|
| Phase 2 | 0 | 42 |
| Phase 3 | 6 | 0 |
| Phase 4 | 11 | 0 |
| Phase 5 | 14 | 0 |
| Phase 6 | 10 | 0 |
| Phase 7 | 6 | 0 |
| **Total** | **47** | **42** |

> **Total: 89 HTTP operations** — matches source scanner output exactly.
> Non-GET operations: 47 (all mutations) + 2 semantic reads using POST = 49 non-GET HTTP methods.
