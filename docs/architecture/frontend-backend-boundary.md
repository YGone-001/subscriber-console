# Frontend-Backend Boundary

> Defines responsibility boundaries between frontend and backend.
> Detailed rules: `CLAUDE.md`. Current ownership: `AGENTS.md`.

## Frontend Responsibility

- UI rendering and state management
- API client (SWR hooks)
- User interaction and feedback
- Internationalization (en/zh)
- Responsive layout and design tokens

Frontend does NOT know whether API calls go to Node or Go.
API paths remain `/api/...` regardless of backend owner.

Location: `frontend/src/`

## Backend Responsibility

### Node (Next.js API Routes) — Legacy

- Authentication (login/logout)
- Write endpoints not yet migrated
- Approval execute
- Audit export (stateful GET)

Location: `frontend/src/app/api/`

### Go Backend — Migrated

- Authentication verification (HS256)
- Authorization (capability + permission checks)
- Read API implementations (shadow)
- Governed write operations
- Rate limiting
- Audit evidence writing

Location: `backend/internal/`

## Migration Boundary

Ownership is per method + path, not per prefix.

```text
ACTUALLY_ROUTED = 1  →  production traffic goes to Go
ACTUALLY_ROUTED = 0  →  Go implements but Node serves production
```

CUTOVER_TABLE defines authoritative ownership.
See `docs/backend-migration/migration-routing-matrix.md`.
