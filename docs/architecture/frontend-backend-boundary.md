# Frontend-Backend Boundary

> Defines responsibility boundaries between frontend and backend.
> Detailed rules: `CLAUDE.md`. Current ownership: `AGENTS.md`.

## Current Production Boundary

The following boundary describes the deployed production runtime. Nginx routes all
application traffic (API and UI) to Go on `127.0.0.1:18888`. Go hosts the production
REST API and internally serves the embedded static React SPA.

### Frontend Responsibility

- UI rendering and state management (`frontend/src/`)
- API client (Fetch client / SWR)
- User interaction and feedback
- Internationalization (en/zh)
- Responsive layout and design tokens
- Client-side auth gate (`AuthGate`)

Location: `frontend/src/` (canonical React + Vite SPA source)
Legacy Next.js source is retired; numeric port 13333 is reassigned to Vite development.

The frontend does not know which process answers an API call.
API paths remain `/api/...` unchanged.

### Backend Responsibility

### Go Backend (API and SPA owner)

- Authentication verification (HS256) and session validation
- Authorization (capability + permission checks)
- All production read and write API operations (84 registrations)
- Static SPA hosting (assets, browser-history fallback, cache-control)
- Rate limiting
- Audit evidence writing
- Request identity, request ID and structured logging

Location: `backend/internal/`

The Next.js business API tree (`frontend/src/app/api/`) and business server layer
(`frontend/src/server/`) do not exist. The frontend holds no API handler, no business
repository, no MongoDB client and no JWT runtime. No route-owner table exists in
production source.

### Routing Boundary

Nginx is the sole public edge. It routes `/api`, `/api/*`, and `location /` to Go on
`127.0.0.1:18888`, and strips client identity headers at the edge.

Route ownership is per method + path. Route authority is the Go registration set parsed from
`backend/cmd/server/main.go` plus `backend/internal/remediation/handler.go`
(shared helper `scripts/lib/go-registrations.mjs`).

See `docs/operations/deployment.md` for the edge contract.

## Evolutionary Convergence
 
Runtime consolidation and frontend canonicalization are complete:

```text
Browser -> Nginx -> Go 127.0.0.1:18888
                     |-- API
                     `-- embedded static React SPA
```

The legacy Next.js runtime is retired (with numeric port 13333 reassigned to Vite development), and `frontend/` is the canonical React+Vite SPA source.

## Invariant Security Boundary

Across both the current and planned runtime shapes:

- The frontend never becomes the authentication authority.
- The frontend never becomes the authorization authority.
- The frontend never gains direct MongoDB access.
- The frontend never owns trusted identity headers.
- Go remains the server-side security authority for authentication, authorization,
  fresh actor validation, and protected API operations.

See the [architecture evolution roadmap](architecture-evolution-roadmap.md) for the
planned sequence and longer-term platform direction.
