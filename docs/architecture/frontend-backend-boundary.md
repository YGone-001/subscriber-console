# Frontend-Backend Boundary

> Defines responsibility boundaries between frontend and backend.
> Detailed rules: `CLAUDE.md`. Current ownership: `AGENTS.md`.

## Frontend Responsibility

- UI rendering and state management
- API client (SWR hooks)
- User interaction and feedback
- Internationalization (en/zh)
- Responsive layout and design tokens
- UI-only navigation guard (`frontend/src/proxy.ts`)

The frontend does not know which process answers an API call.
API paths remain `/api/...` unchanged.

Location: `frontend/src/`

## Backend Responsibility

### Go Backend (API owner)

- Authentication verification (HS256) and session validation
- Authorization (capability + permission checks)
- All production read and write API operations
- Rate limiting
- Audit evidence writing
- Request identity, request ID and structured logging

Location: `backend/internal/`

The Next.js business API tree (`frontend/src/app/api/`) and business server layer
(`frontend/src/server/`) do not exist. The frontend holds no API handler, no business
repository, no MongoDB client and no JWT runtime. No route-owner table exists in
production source.

## Routing Boundary

Nginx is the sole public edge. It routes `/api` and `/api/*` to Go and `location /` to the
Next.js UI, and strips client identity headers at the edge.

Route ownership is per method + path. Route authority is the Go registration set parsed from
`backend/cmd/server/main.go` plus `backend/internal/remediation/handler.go`
(shared helper `scripts/lib/go-registrations.mjs`).

See `docs/operations/deployment.md` for the edge contract.
