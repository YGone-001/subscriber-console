# User Management Model

> Operational user lifecycle and role management model.
> Architecture: `docs/architecture/phase-6-auth-architecture.md`.
> Authentication: `docs/operations/authentication-model.md`.
> Stable rules: `CLAUDE.md`. Current state: `AGENTS.md`.

## 1. Collection Ownership

Authoritative collection: `xcloud_ops.app_users`.
Single source of truth. Do not duplicate users into another collection.

## 2. User Schema

```text
{
  username:       string,   // unique identifier, required
  passwordHash:   string,   // bcrypt cost 10, required, never exposed
  role:           string,   // admin | operator | viewer, required
  status:         string,   // active | disabled | locked, required
  locked:         boolean,  // optional, defaults false
  displayName:    string,   // optional
  email:          string,   // optional
  createdBy:      string,   // optional, username of creating admin
  createdAt:      string,   // ISO 8601, required
  updatedAt:      string,   // ISO 8601, required
  security: {
    sessionVersion:      number,   // required, monotonic, starts at 0
    failedLoginAttempts: number,   // required, starts at 0
    passwordChangedAt:   string,   // optional, ISO 8601
    lastLoginAt:         string,   // optional, ISO 8601
    lastLoginIp:         string,   // optional
    lockedAt:            string,   // optional, ISO 8601
    lockReason:          string   // optional
  }
}
```

Sensitive fields never returned by API: `passwordHash`, `_id`, security secrets.

## 3. Role Management

Canonical roles for new users: `admin`, `operator`, `viewer`.
Write boundary: only these three accepted. Legacy roles rejected with HTTP 400 `INVALID_ROLE`.

Legacy role normalization (read/runtime only):

| Legacy | Canonical |
|--------|-----------|
| `root` | `admin` |
| `super_admin` | `admin` |
| `ops_admin` | `operator` |
| `auditor` | `viewer` |

Assignable roles policy: an admin can assign any of the three canonical roles.
An admin cannot remove the last active admin (enforced in `userRepository.updateUser`).

## 4. User Lifecycle

### Create User

Permission: `users.create` (admin only).
Endpoint: `POST /api/users` (alias: `POST /api/auth/users`).

Fields: `username`, `password`, `confirmPassword`, `role`, `displayName`, `email`.
Validation:
- `username` matches `USERNAME_PATTERN`
- `password` satisfies `isPasswordStrong` (>= 8 chars, <= 72 bytes, not containing username)
- `role` must be one of `admin`, `operator`, `viewer`
- `confirmPassword` (optional) must match `password`

Rate limit: 15 / 60s per actor.
On success: audit `users.create`, return safe user (no `passwordHash`).

### Update User

Permission: `users.update` (admin only).
Endpoints: `PUT /api/users/{username}`, `PATCH /api/users/{username}`.
(aliases: `PUT /api/auth/users/{username}`, `PATCH /api/auth/users/{username}`)

Allowed fields: `displayName`, `email`, `role`, `status`, `password`, `action`, `reason`.
Unknown fields: HTTP 400 `INVALID_FIELD`.

Sensitive changes trigger `sessionVersion++`:
- `role` change
- `password` change
- `status` change
- `locked` change

Response includes `sessionRevoked: true` when any of the above occurred.

### Disable User

Permission: `users.disable` (admin only).
Endpoints: `DELETE /api/users/{username}` (soft delete) or `POST /api/users/{username}/disable` (Phase 6.1).

Effect: `status = disabled`. All existing sessions invalidated.
Message: `User disabled; account history was preserved`.

### Lock / Unlock User

Via `PUT /api/users/{username}` with `action: 'lock' | 'unlock' | 'enable'`.
Lock sets `status = 'locked'` and `locked = true`, records `security.lockedAt` and `security.lockReason`.
Unlock sets `status = 'active'`, clears lock metadata.

### Password Reset

Permission: `users.reset-password` (admin only).
Endpoint: `POST /api/users/{username}/password-reset` (Phase 6.1) or `PUT` with `password` field.

Validation: `isPasswordStrong`, optional `confirmPassword` match.
Effect: bcrypt hash updated, `security.passwordChangedAt` set, `sessionVersion++`.

### Delete User

Decision: DO NOT hard delete. Use `status = disabled`.
Reason: retain operation traceability and audit history.

## 5. Password Policy

Implemented by `isPasswordStrong(password, username)`:

- length >= 8 non-blank characters
- UTF-8 byte length <= 72 (bcrypt limit)
- must not contain the username (case-insensitive)

Hash: bcrypt cost 10. Never stored in plaintext. Never returned by API.

## 6. Session Invalidation Triggers

Every sensitive change increments `security.sessionVersion`:

```text
role change      -> $inc: { "security.sessionVersion": 1 }
password change  -> $inc: { "security.sessionVersion": 1 }
status change    -> $inc: { "security.sessionVersion": 1 }
lock / unlock    -> $inc: { "security.sessionVersion": 1 }
```

All existing JWTs carrying a stale `sv` claim are rejected with `SESSION_REVOKED` on next request.

## 7. Operation Logging

All user management operations are logged to `xcloud_ops.app_audit_logs`:

| Action | When |
|--------|------|
| `users.create` | user created |
| `users.update` | profile/role/status updated |
| `users.disable` | user disabled |
| `users.delete` | soft delete invoked |
| `users.role.change` | role changed |
| `users.reset-password` | password reset |
| `users.unlock` | lock removed |
| `auth.login` (success/failed) | login attempt |
| `authorization.denied` | permission check failed |

Log fields: `actor` (type/username/role), `module`, `action`, `result`, `resource`, `metadata`, request context (IP, user agent).

## 8. Permission Boundaries

| Operation | admin | operator | viewer |
|-----------|-------|----------|--------|
| Read user list/detail | yes | no | no |
| Create user | yes | no | no |
| Update user | yes | no | no |
| Disable user | yes | no | no |
| Reset password | yes | no | no |
| Change role | yes | no | no |
| Unlock user | yes | no | no |

Permission checks use `requirePermission(request, 'users.*')` or `authorizeUserOperation()`.
Denials are audited as `authorization.denied` with resource type `api`.
