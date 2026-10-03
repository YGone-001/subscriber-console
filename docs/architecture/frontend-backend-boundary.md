# Frontend-Backend Boundary

> Defines responsibility boundaries between frontend and backend.
> Detailed rules: `CLAUDE.md`. Current ownership: `AGENTS.md`.

## Current Production Boundary

The following boundary describes the deployed production runtime. Nginx routes
non-API traffic to Next.js on `127.0.0.1:13333` and all `/api` traffic to Go on
`127.0.0.1:18888`.

### Frontend Responsibility

- UI rendering and state management
- API client (SWR hooks)
- User interaction and feedback
- Internationalization (en/zh)
- Responsive layout and design tokens
- UI-only navigation guard (`frontend/src/proxy.ts`)

The frontend does not know which process answers an API call.
API paths remain `/api/...` unchanged.

Location: `frontend/src/`

### Backend Responsibility

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

### Routing Boundary

Nginx is the sole public edge. It routes `/api` and `/api/*` to Go and `location /` to the
Next.js UI, and strips client identity headers at the edge.

Route ownership is per method + path. Route authority is the Go registration set parsed from
`backend/cmd/server/main.go` plus `backend/internal/remediation/handler.go`
(shared helper `scripts/lib/go-registrations.mjs`).

See `docs/operations/deployment.md` for the edge contract.

## Short-Term Target Boundary

The planned target is a consolidated application runtime, not a current deployment:

```text
Browser -> Nginx -> Go 127.0.0.1:18888
                     |-- API
                     `-- static React SPA
```

After a separately governed implementation and transition, Go would host the static
SPA as well as the API, and the production Next.js runtime and port `13333` would be
retired. Nginx would remain the public edge, and MongoDB `xcloud` plus `xcloud_ops`
would remain the existing source of truth. This target does not authorize a Next.js
rewrite, API handler, forwarding middleware, or browser-direct Go API base URL in
the current runtime.

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
