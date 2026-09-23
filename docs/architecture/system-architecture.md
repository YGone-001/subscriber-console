# System Architecture

> Overview of xCloud subscriber-console architecture.
> Detailed rules: `CLAUDE.md`. Current state: `AGENTS.md`.

## Components

```text
Browser
   |
   v
Nginx
   |-----------------------------|
   v                             v
Next.js :13333                Go :18888
UI / Rendering               Business API
Legacy writes during         Auth validation
migration                    Read migration
   |                             |
   +-------------+---------------+
                 |
                 v
              MongoDB
         xcloud + xcloud_ops
```

Target:

```text
Browser -> Nginx
           ├─ /*      -> Next.js :13333
           └─ /api/*  -> Go :18888
```

## Frontend

- Next.js 16.2.2 App Router
- React 19.2.4
- TypeScript 5.x
- Tailwind CSS 4
- SWR for data fetching
- Recharts for visualization
- Lucide React for icons

Location: `frontend/`

## Go Backend

- Go 1.24+
- Standard library `net/http`
- Modern ServeMux method/path routing
- `log/slog` structured logging
- `mongo-driver/v2`

Location: `backend/`

## Database

Same Mongo URI, two databases:

- `xcloud` — subscriber, profile, OCS, tariff data
- `xcloud_ops` — operational data (users, approvals, audit, rate limits, sequences)

Go uses one `mongo.Client` with two database handles.

## Domain Boundaries

```text
subscriber-console
  → subscriber / profile / OCS / tariff / governance

CNMS (reference only)
  → monitoring / signaling / capture / RCA / AIOps / NF
```

CNMS is a reference repository, not a merge target.
