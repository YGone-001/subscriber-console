# Phase 6 — Authentication & User Management Architecture Freeze

> Architecture freeze for Phase 6.0. This document defines the authoritative boundary
> for Phase 6.1+ implementation. Do not expand scope beyond this freeze.
> Stable rules: `CLAUDE.md`. Current state: `AGENTS.md`.

## 1. Objective

Simplify authentication and user management to a carrier internal-network operation model.

```text
Operator Login
  -> Authentication
  -> Role Permission Check
  -> Direct Operation Access
  -> Operation Log
```

Phase 6 provides:

- user authentication
- user lifecycle management
- simple RBAC (three canonical roles)
- session / token management
- permission boundaries

Phase 6 does NOT introduce:

- approval workflows
- governance state machines
- enterprise IAM complexity
- external identity federation
- multi-tenant authorization
- policy engines

## 2. Scope Boundary

Phase 6 ONLY owns:

```text
Authentication
User Management
Role Management
Session Management
Permission Management
```

Phase 6 does NOT own:

```text
OCS
Subscriber
Profile
Tariff
Balance
Charging Plane
Monitoring
Signaling
CNMS integration
```

## 3. Operation Model (Frozen)

```text
User
  -> Authentication
  -> RBAC
  -> Capability Check
  -> Business Mutation
  -> Operation Log
```

No approval dependency.
No approval executor.
No approval state.
No maker-checker workflow.

## 4. Role Model

Three canonical roles only:

| Role | Purpose | Business Read | Business Write | User Management |
|------|---------|---------------|----------------|-----------------|
| `admin` | System administrator | yes | yes | yes |
| `operator` | Daily operation user | yes | yes | no |
| `viewer` | Read-only observation | yes | no | no |

Legacy role normalization (runtime only):

```text
root        -> admin
super_admin -> admin
ops_admin   -> operator
auditor     -> viewer
```

New users MUST only accept: `admin`, `operator`, `viewer`.
Write boundary: legacy roles rejected with HTTP 400 `INVALID_ROLE`.
UI role selection: exactly 3 options.

## 5. Authentication Design

```text
Username + Password
  -> bcrypt password verification
  -> JWT (HS256) / Session Token
  -> Authenticated Request
```

Token format:

```text
Header:  { alg: "HS256", typ: "JWT" }
Payload: { username, role, sv, exp }
Cookie:  auth_token (httpOnly, sameSite=lax, path=/, maxAge=86400)
```

Token expiration: 24 hours. No refresh token. Re-login required on expiration.

Logout: clear `auth_token` cookie. Rate limit 30/60s per IP.

Existing behavior preserved:

- `sessionVersion` (sv claim) — mandatory
- fresh actor validation against `app_users` — mandatory

## 6. Session Model

Login:

```text
username/password -> validate -> issue JWT (with current sessionVersion)
```

Logout:

```text
clear auth_token cookie
```

Session invalidation:

```text
$inc: { "security.sessionVersion": 1 }
```

Required for:

- password change
- role change
- status change (disable / enable / lock / unlock)

Every protected request validates:

```text
auth_token cookie
  -> HS256 verify
  -> username / role / sv / exp
  -> xcloud_ops.app_users lookup
  -> enabled / unlocked / sessionVersion match / role consistency
  -> Principal
```

Error codes:

| Code | Condition |
|------|-----------|
| `AUTH_INVALID_TOKEN` | missing/malformed token or claims |
| `ACCOUNT_NOT_FOUND` | user not in `app_users` |
| `ACCOUNT_LOCKED` | `locked=true` or `status=locked` |
| `ACCOUNT_DISABLED` | `status != active` |
| `SESSION_REVOKED` | sessionVersion mismatch or role mismatch |
| `AUTH_UNAVAILABLE` | database unavailable |

## 7. Permission Model

Static code-based permission map. No dynamic policy editor.

Canonical capabilities (`frontend/src/lib/permissions.ts`, `backend/internal/auth/claims.go`):

| Capability | admin | operator | viewer |
|------------|-------|----------|--------|
| `subscriber_write` | allow | allow | deny |
| `balance_adjust` | allow | allow | deny |
| `profile_rollback` | allow | allow | deny |
| `rating_publish` | allow | allow | deny |
| `system_heal` | allow | allow | deny |
| `user_admin` | allow | deny | deny |
| `policy_approve` | allow | allow | deny |

Permission catalog (`PERMISSION_CATALOG`):

```text
users.read, users.create, users.update, users.disable, users.delete,
users.role.change, users.reset-password, users.unlock,
subscribers.read, subscribers.write, subscribers.delete,
ocs.read, ocs.balance.adjust, ocs.balance.reset, ocs.tariff.write,
ocs.plan.assign, ocs.rating.write, ocs.runtime.execute,
profiles.read, profiles.write,
core.read, core.operate, core.configure
```

Forbidden:

- dynamic policy editor
- permission workflow
- approval-based permission changes

## 8. User Collection Design

Authoritative collection: `xcloud_ops.app_users`.
Single source of truth. Do not duplicate users into another collection.

```text
{
  username:       string,   // unique, required
  passwordHash:   string,   // bcrypt, required
  role:           string,   // admin | operator | viewer, required
  status:         string,   // active | disabled | locked, required
  security: {
    sessionVersion:      number,
    failedLoginAttempts: number,
    passwordChangedAt:   string (ISO, optional),
    lastLoginAt:         string (ISO, optional),
    lastLoginIp:         string (optional),
    lockedAt:            string (ISO, optional),
    lockReason:          string (optional)
  },
  createdAt:      string,   // ISO 8601, required
  updatedAt:      string,   // ISO 8601, required
  displayName:    string,   // optional
  email:          string,   // optional
  createdBy:      string,   // optional
  locked:         boolean   // optional, defaults false
}
```

## 9. User Lifecycle

### Create User

Permission: `users.create` (admin only).

Fields: `username`, `password`, `role`, `status`, `displayName`, `email`.
Role must be one of `admin`, `operator`, `viewer`.
Password must satisfy `isPasswordStrong` (>= 8 chars, <= 72 bytes, not containing username).
Password hash: bcrypt cost 10.

### Update User

Permission: `users.update` (admin only).

Allowed fields: `displayName`, `email`, `role`, `status`, `password`.

Sensitive changes (trigger `sessionVersion++`):

- role change
- password change
- status change

### Disable User

Permission: `users.disable` (admin only).

Effect: `status = disabled`. Existing sessions invalidated via `sessionVersion++`.

### Delete User

Decision: DO NOT hard delete.
`DELETE /api/users/{username}` performs soft delete: `status = disabled`.
Reason: retain operation traceability.

### Password Reset

Permission: `users.reset-password` (admin only).
Sets new bcrypt hash, updates `security.passwordChangedAt`, triggers `sessionVersion++`.

## 10. API Inventory (Frozen)

### Authentication

| Method | Path | Owner | Notes |
|--------|------|-------|-------|
| POST | `/api/auth/login` | Node | login, rate limit 5/60s per IP |
| POST | `/api/auth/logout` | Node | cookie clear, rate limit 30/60s per IP |
| GET | `/api/auth/me` | Node + Go shadow | session identity + permissions |
| GET | `/api/auth/permissions` | Node + Go shadow | capability map |

### Users (canonical paths)

| Method | Path | Owner | Notes |
|--------|------|-------|-------|
| GET | `/api/users` | Node + Go shadow | list (query mode + legacy) |
| POST | `/api/users` | Node | create user |
| GET | `/api/users/{username}` | Node + Go shadow | detail + activity |
| PUT | `/api/users/{username}` | Node | update user |
| PATCH | `/api/users/{username}` | Node | partial update |
| DELETE | `/api/users/{username}` | Node | soft delete (status=disabled) |
| POST | `/api/users/{username}/disable` | Node | explicit disable action (Phase 6.1) |
| POST | `/api/users/{username}/password-reset` | Node | explicit password reset (Phase 6.1) |

### Users (legacy alias paths — preserved)

| Method | Path | Owner | Notes |
|--------|------|-------|-------|
| GET | `/api/auth/users` | Node + Go shadow | alias to `/api/users` |
| POST | `/api/auth/users` | Node | alias to `/api/users` |
| GET | `/api/auth/users/{username}` | Node + Go shadow | alias |
| PUT | `/api/auth/users/{username}` | Node | alias |
| PATCH | `/api/auth/users/{username}` | Node | alias |
| DELETE | `/api/auth/users/{username}` | Node | alias |

This list is frozen. Do not add or remove endpoints during Phase 6.1+ implementation.

## 11. Frontend Scope

Phase 6 UI routes:

```text
/login              — authentication (exists)
/users              — user list (exists)
/users/create       — user creation (Phase 6.1)
/users/{username}   — user detail / update (Phase 6.1)
/profile            — optional self-service (exists)
```

Remove or avoid:

- approval user management
- governance user management
- audit user console

## 12. Database Impact

Allowed:

```text
xcloud_ops.app_users
```

Possible (session storage, if implemented):

```text
xcloud_ops.app_sessions   — NOT required at freeze; JWT stateless + sessionVersion sufficient
```

Not allowed:

```text
xcloud.subscribers
xcloud.ocs_*
xcloud_ops.app_profiles
xcloud_ops.app_profile_versions
xcloud_ops.app_ratings
xcloud_ops.app_audit_logs   — write only via operation log, not user management
xcloud_ops.app_rate_limits  — infrastructure only
```

## 13. Hard Prohibitions

DO NOT:

- recreate approval workflow
- recreate audit console
- introduce IAM framework
- introduce OAuth provider
- introduce SSO
- introduce LDAP integration
- introduce multi-factor authentication
- introduce tenant isolation
- modify OCS business logic
- modify `CUTOVER_TABLE`
- modify `ACTUALLY_ROUTED = 26`
- modify charging plane collections

## 14. Acceptance Gates

Architecture:

- user model defined
- role model defined
- API inventory defined and frozen
- collection ownership defined
- session model defined

Boundary:

- no approval dependency
- no governance dependency
- no OCS changes
- no business mutation changes

Validation:

- `npm test`, `npm run lint`, `npm run typecheck`, `npm run build`
- `go test ./...`, `go build ./...`
- `ACTUALLY_ROUTED = 26` unchanged
