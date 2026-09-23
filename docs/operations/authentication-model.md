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

Dual rate limit:
- IP-scoped: 5 requests / 60s per key `login:<ip>` (enforced upfront on all incoming requests)
- Account-scoped: 10 FAILED authentication attempts / 300s per key `login-user:<normalized-username>` (peeked before password verification; consumed only on failed authentication attempts)
- When exceeded: HTTP 429 with `Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Remaining: 0`, and `Cache-Control: no-store`.

Flow:

1. Extract client IP (prioritizing `x-real-ip`, then `x-forwarded-for`, falling back to `unknown`).
2. Enforce IP-scoped request rate limit (5 / 60s). If exceeded, return HTTP 429.
3. Parse and validate JSON request body (`username` non-empty <= 100 chars, `password` non-empty <= 72 bytes).
   - On malformed JSON, invalid body, missing username/password, or password over 72 bytes: return HTTP 400 `{"error": "Username and password required"}` with `Cache-Control: no-store`.
4. Pre-auth check on account failed-login limiter: peeks `login-user:<normalized-username>` (10 / 300s). If the failure budget is already exhausted (>= 10 failures in current window), return HTTP 429 immediately without performing password verification.
5. Look up `xcloud_ops.app_users` by username.
6. Verify password with `bcrypt.compare` (cost 10) or constant-shape dummy work for unknown users.
7. Validate account status: `status == 'active'`, `locked != true`, role normalizable.
8. On credential/account-state failure (unknown user, bad password, disabled, locked):
   - Atomically consume one failed-attempt unit on `login-user:<normalized-username>` (applies identically to existing and non-existing accounts).
   - If active unlocked account with wrong password: atomically increment `security.failedLoginAttempts`.
   - If `failedLoginAttempts >= 10` and account is not the last active admin: atomically transition to `status="locked"`, `locked=true`, `security.lockedAt`, `security.lockReason="excessive_failed_logins"`, and increment `security.sessionVersion` exactly once.
   - Schedule `auth.login` failed audit log (and `auth.account.locked` if newly locked).
   - Return uniform HTTP 401 `{"error": "Invalid credentials"}` with `Cache-Control: no-store` (strict response privacy for account and credential state).
9. Record successful login via atomic conditional update:
   - Does NOT consume account failed-login rate limit budget (`login-user:...` remains unincremented).
   - Sets `security.lastLoginAt` and `security.lastLoginIp`.
   - Resets persistent `security.failedLoginAttempts` to 0.
   - Validates that `sessionVersion`, `status`, and `passwordHash` have not changed concurrently during bcrypt computation.
10. Issue JWT: `{ username, role, sv }`, exp = 24h.
11. Set `auth_token` cookie (httpOnly, sameSite=lax, path=/, maxAge=86400, secure if HTTPS).
12. Return HTTP 200 `{"success": true, "username": "..."}` with `Cache-Control: no-store`.

## 3. Token Format

```text
Header:  { alg: "HS256", typ: "JWT" }
Payload: { username: string, role: string, sv: number, exp: number }
```

- `username` — account identifier
- `role` — raw role as stored in `app_users.role` (legacy values allowed)
- `sv` — sessionVersion at issue time
- `exp` — unix timestamp, 24h after issue

Signing: HS256 with shared `JWT_SECRET` (>= 32 UTF-8 bytes, no placeholder).
Cookie: `auth_token`, httpOnly=true, sameSite=lax, path=/, `secure` flag set when HTTPS (`x-forwarded-proto: https` or HTTPS request).

## 4. Token Expiration & Refresh

Expiration: 24 hours. Hard expiry via `exp` claim.
No refresh token. No silent renewal.
On expiry: 401 `AUTH_INVALID_TOKEN` -> `handleSessionExpiry` -> redirect to `/login`.

## 5. Logout

Endpoint: `POST /api/auth/logout` (Node owner).

Rate limit: 30 / 60s per IP.

Behavior:

1. Clear `auth_token` cookie with aligned attributes (`httpOnly: true`, `sameSite: lax`, `path: /`, `maxAge: 0`, `secure` aligned with HTTPS context).
2. Set response header `Cache-Control: no-store`.
3. Return `{ "success": true }`.

SessionVersion is NOT incremented on standard logout (token is stateless; cookie deletion suffices).
To force-invalidate all existing tokens across devices, change password, change role, or lock account (triggers `sessionVersion++`).

## 6. Session Invalidation

Triggered by `$inc: { "security.sessionVersion": 1 }` on:

| Trigger | Effect |
|---------|--------|
| password change | all existing tokens rejected (`SESSION_REVOKED`) |
| role change | all existing tokens rejected |
| status change (disable/enable) | all existing tokens rejected |
| automatic lockout (10 failed logins) | all existing tokens rejected |
| manual lock | all existing tokens rejected |
| admin unlock | all existing tokens rejected |

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

Password policy:
- Minimum: 8 Unicode code points after trimming surrounding whitespace (whitespace-only or trimmed < 8 rejected; supplementary characters/emoji counted as code points, not UTF-16 code units)
- Maximum: 72 UTF-8 bytes (bcrypt byte boundary)
- Must not contain the target username (case-insensitive substring check)
- Enforced identically by Node (`isPasswordStrong`) and canonical Go (`ValidatePassword`), verified by cross-language parity assertions.

JWT secret: shared `JWT_SECRET` environment variable (>= 32 UTF-8 bytes).
Must be identical across Node and Go processes (mismatch causes `AUTH_INVALID_TOKEN` loops).
Both Node (`frontend/src/lib/security.ts`) and Go (`backend/internal/auth/secret.go`) fail closed on startup
if `JWT_SECRET` is missing, shorter than 32 bytes, or matches common insecure placeholders
(`secret`, `jwt_secret`, `change-me`, `changeme`, `development`, `password`).

## 9. Interoperability

Node (`jose`) and Go (`golang.org/x/crypto` / custom HS256 verifier) must produce
and verify identical JWT signatures from the same `JWT_SECRET`.
Cross-language verification is covered by `backend/internal/auth/verifier_cross_lang_test.go`
and `scripts/test-auth-go-parity.mjs`.

## 10. Go Contract Parity Foundation (Phase 6.3-A)

Phase 6.3-A brought Go Authentication implementations into complete 1:1 parity with the frozen Node implementation:
- `POST /api/auth/login`: IP-scoped rate limiter (5/60s), account failed-login limiter peek (10/300s), dummy bcrypt for timing mitigation, uniform 401 response privacy, atomic lockout threshold (10 attempts, single sessionVersion bump), last-active-admin lockout protection, successful login conditional state update, and auth_token cookie issuance.
- `POST /api/auth/logout`: IP-scoped rate limiter (30/60s), exact cookie clearance (`Max-Age=0`), Cache-Control: no-store, and `{ success: true }` body.
- `GET /api/auth/me`: Rate limiter (60/60s), Cache-Control: no-store, exact role/capability/permission payload structure.
- `GET /api/auth/permissions`: Exact PERMISSION_CATALOG catalog ordering across all canonical and legacy roles.

Production Routing Invariant:
- Production authentication ownership remains with **Node**.
- `CUTOVER_TABLE = 32`, `ACTUALLY_ROUTED = 32`.
- Go authentication endpoints operate as verified shadow implementations ready for potential future controlled cutover.

