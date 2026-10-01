# Documentation

Permanent documentation entry point for the xCloud subscriber-console repository.

## Authority Model

Documentation authority is explicit and ordered:

```text
1. README.md
   Repository overview and entry point.

2. docs/README.md
   Documentation map and authority guide (this file).

3. docs/architecture/**
   Current production architecture and design authority.

4. docs/operations/**
   Current operating models, runbooks, deployment and administration guidance.

5. docs/database/**
   Current data and database operational documentation.

6. docs/archive/**
   Concise historical summaries only. NOT current architecture authority.
```

Where documentation and production source disagree, the running source and
configuration are authoritative:

```text
Nginx edge routing                -> deploy/nginx/xcloud.conf
Go API registration authority     -> backend/cmd/server/main.go
                                     backend/internal/remediation/handler.go
Next.js API absence               -> frontend/src/app/api
Next.js UI-only navigation guard  -> frontend/src/proxy.ts
```

## Architecture

- [System architecture](architecture/system-architecture.md)
- [Frontend-backend boundary](architecture/frontend-backend-boundary.md)
- [Security model](architecture/security-model.md)
- [Governance design](architecture/governance-design.md)
- [Product](architecture/product.md)
- [Repository conventions](architecture/repository-conventions.md)
- [Design tokens](architecture/design-tokens.md)
- [Design system rules](architecture/design-system-rules.md)

## Operations

- [Deployment](operations/deployment.md)
- [Authentication model](operations/authentication-model.md)
- [User management model](operations/user-management-model.md)
- [RBAC model](operations/rbac-model.md)
- [Operation model](operations/operation-model.md)
- [Direct operation model](operations/direct-operation-model.md)
- [OCS management runbook](operations/ocs-management-runbook.md)
- [Security](operations/security.md)

## Database

- [Core network operations inventory](database/core-network-operations-inventory.md)

## Archive

- [Backend migration summary](archive/backend-migration-summary.md)

`docs/archive/**` contains concise historical summaries only. It is not current
architecture authority. Detailed historical development evidence remains
available from Git history.
