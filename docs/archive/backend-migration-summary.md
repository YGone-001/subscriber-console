# Backend Migration Summary

> HISTORICAL SUMMARY - NOT CURRENT ARCHITECTURE AUTHORITY
>
> This is the only maintained historical summary of the completed Node/Next.js to
> Go backend migration. It is intentionally short. It is not current architecture
> authority: see `docs/README.md` for the current documentation model and
> `docs/architecture/` for the current architecture.

## Previous Architecture

```text
Browser -> Nginx
   |-- /api, /api/* -> Next.js App Router route handlers + Next.js server layer
   |                   (business API, JWT verification, MongoDB access,
   |                    route-owner routing decisions)
   `-- /*           -> Next.js UI
```

The Next.js runtime owned the business API: it verified JWTs, read and wrote
MongoDB, and forwarded individual operations according to a route-owner routing
table. A parallel Go implementation was grown operation by operation.

## Current Architecture

```text
Browser -> Nginx  (sole public edge)
   |-- /api, /api/* -> Go  127.0.0.1:18888   (business API + auth identity)
   `-- /*           -> Next.js 127.0.0.1:13333   (UI runtime only)
```

## What Changed

- The Node/Next.js business backend was migrated to Go. Every production API
  operation is now Go-owned.
- Next.js now serves the UI only: it renders pages and runs a UI-only navigation
  guard. It no longer decodes JWTs, accesses MongoDB, injects identity headers or
  forwards API requests.
- Nginx routes API traffic (`/api`, `/api/*`) to Go and all other traffic to the
  Next.js UI.

## Migration Milestone Invariants

```text
Go exact METHOD+PATH registrations = 84
Next.js API route handlers         = 0
Node backend business execution    = 0
Nginx routes /api and /api/* to Go
Go is the production API authority
Next.js was the UI runtime only at this migration milestone
```

## Retrieving Detailed Migration Documents

Detailed migration working papers are preserved in Git history and are not
maintained in the current tree. Retrieve them from history:

```bash
git log --all -- docs/backend-migration/
git log --all -- docs/architecture/
git show <commit>:docs/backend-migration/<historical-file>
```
