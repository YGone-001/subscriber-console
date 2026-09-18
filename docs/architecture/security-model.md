# Security Model

> Authentication, authorization, and data protection boundaries.
> Full security policy: `docs/operations/security.md`. Rules: `CLAUDE.md` §12–13.

## Authentication Chain

```text
auth_token cookie
  → HS256 verify
  → username / role / sv / exp
  → xcloud_ops.app_users
  → enabled + unlocked + sessionVersion match + role consistency
  → Principal
```

Node `jose` → Go verifier interoperability is verified.

## Headers Never Trusted as Authority

```text
x-user
x-user-role
x-user-id
x-user-session-version
```

Go always validates the JWT and looks up `app_users` directly.

## Authorization

Each endpoint checks:

- `requireAuth` — valid session
- `requireCapability` — feature flag
- `requirePermission` — role-based access

Go copies the observable Node permission contract.
CNMS RBAC is NOT used.

## Data Protection

- Sensitive fields (passwordHash, _id, security secrets) never returned in API responses
- Payload sanitizer: secret redaction, depth/bounds checks
- Unknown xCloud fields preserved during reads (bson.M)
- Binary/Buffer: never emit Go base64 if Node uses hex/string

## Rate Limiting

MongoDB fixed window per endpoint:

- Per-user scope
- Standard headers: X-RateLimit-Limit, X-RateLimit-Remaining
- 429 + Retry-After on limit exceeded
