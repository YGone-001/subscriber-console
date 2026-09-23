# Authentication Model

> Operational authentication model for xCloud subscriber-console.
> Architecture: `docs/architecture/phase-6-auth-architecture.md`.
> Stable rules: `CLAUDE.md`. Current state: `AGENTS.md`.

## 1. Overview

```text
Username + Password
  -> bcrypt verification
  -> JWT issue (HS256, 24h)
  -> auth_token cookie
  -> every request: cookie -> JWT verify -> app_users validate -> Principal
```

## 2. Login

Endpoint: `POST /api/auth/login` (Node owner).

Rate limit: 5 attempts / 60s per IP.

Flow:

1. Parse `username`, `password` from JSON body.
2. Validate input (non-empty, username <= 100 chars, password <= 72 bytes).
3. Look up `xcloud_ops.app_users` by username.
4. Verify password with `bcrypt.compare` (cost 10).
5. Check `status == 'active'`, `locked != true`, role normalizable.
6. Record successful login (`security.lastLoginAt`, `security.lastLoginIp`, reset `failedLoginAttempts`).
7. Issue JWT: `{ username, role, sv }`, exp = 24h.
8. Set `auth_token` cookie (httpOnly, sameSite=lax, path=/, maxAge=86400).
9. Audit `auth.login` success.

On failure: audit `auth.login` failed, return 401 `Invalid credentials`.
Do not distinguish between unknown user and wrong password.

## 3. Token Format

```text
Header:  { alg: "HS256", typ: "JWT" }
Payload: { username: string, role: string, sv: number, exp: number }
```

- `username` — account identifier
- `role` — raw role as stored in `app_users.role` (legacy values allowed)
- `sv` — sessionVersion at issue time
- `exp` — unix timestamp, 24h after issue

Signing: HS256 with shared `JWT_SECRET` (>= 32 bytes, no placeholder).
Cookie: `auth_token`, httpOnly, sameSite=lax, `secure` flag set only over HTTPS.

## 4. Token Expiration & Refresh

Expiration: 24 hours. Hard expiry via `exp` claim.
No refresh token. No silent renewal.
On expiry: 401 `AUTH_INVALID_TOKEN` -> `handleSessionExpiry` -> redirect to `/login`.

## 5. Logout

Endpoint: `POST /api/auth/logout` (Node owner).

Rate limit: 30 / 60s per IP.

Behavior:

1. Clear `auth_token` cookie (`maxAge: 0`).
2. Return `{ success: true }`.

SessionVersion is NOT incremented on logout (token is stateless; expiry handles it).
To force-invalidate all existing tokens, change password or role (triggers `sessionVersion++`).

## 6. Session Invalidation

Triggered by `$inc: { "security.sessionVersion": 1 }` on:

| Trigger | Effect |
|---------|--------|
| password change | all existing tokens rejected (`SESSION_REVOKED`) |
| role change | all existing tokens rejected |
| status change (disable/enable/lock/unlock) | all existing tokens rejected |
| lock account | all existing tokens rejected |

Mechanism:

```text
JWT contains sv = sessionVersion at issue time
Every request: compare JWT.sv == app_users.security.sessionVersion
Mismatch -> SESSION_REVOKED (401)
```

## 7. Fresh Actor Validation

Every protected request revalidates against `xcloud_ops.app_users`:

```text
auth_token cookie
  -> HS256 verify (JWT_SECRET)
  -> extract username / role / sv / exp
  -> app_users.find({ username })
  -> ACCOUNT_NOT_FOUND   if no document
  -> ACCOUNT_LOCKED      if locked == true or status == 'locked'
  -> ACCOUNT_DISABLED    if status != 'active'
  -> SESSION_REVOKED     if sv mismatch or normalized role mismatch
  -> Principal { username, role, normalizedRole, sessionVersion, userId }
```

The Node proxy (`proxy.ts`) performs this validation before forwarding to Go.
The Go backend (`backend/internal/auth/middleware.go`) independently revalidates
from the `auth_token` cookie. Neither side trusts forwarded identity headers.

## 8. Security Boundary

Never trust as final identity:

```text
x-user
x-user-role
x-user-id
x-user-session-version
```

These headers are set by the Node proxy after validation and consumed only as
convenience context. Both Node and Go independently verify the `auth_token` cookie.

Password storage: bcrypt cost 10. Never exposed via API (`stripPassword` on all responses).
`passwordHash` is never returned by any endpoint.

JWT secret: shared `JWT_SECRET` environment variable (>= 32 bytes).
Must be identical across Node and Go processes (mismatch causes `AUTH_INVALID_TOKEN` loops).

## 9. Interoperability

Node (`jose`) and Go (`golang.org/x/crypto` / custom HS256 verifier) must produce
and verify identical JWT signatures from the same `JWT_SECRET`.
Cross-language verification is covered by `backend/internal/auth/verifier_cross_lang_test.go`.
