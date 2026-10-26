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

## Template Read Gate and Credential Masking

The four template read endpoints (`GET /api/profiles`, `GET /api/profiles/{name}`,
`GET /api/profiles/{name}/stats`, `GET /api/profiles/{name}/versions`) require the
`profiles.read` permission; a refusal returns 403 `PERMISSION_DENIED` and records
`authorization.denied` audit evidence via `RequirePermissionWithAudit`.

`GET /api/profiles/{name}` and the versions detail branch replace non-empty
`auth.k` / `auth.op` / `auth.opc` values with `[MASKED]` for roles without the
`subscribers.write` permission. Key presence is preserved so a masked reader still
distinguishes configured from unconfigured; `amf` is not credential material and
stays plaintext. The masking handles every decoded document shape the MongoDB
driver can produce for nested documents (`bson.M`, `bson.D`, `map[string]any`).

The visibility predicate is the same one that drives the `credentialVisibility`
capability bit served by `GET /api/profiles/meta` (`plaintext` for
`subscribers.write` holders, `masked` otherwise), and matches the subscriber
detail policy that removes `auth4G.k/opc/op` for roles without the
`subscriber_write` capability. The only consumer of template plaintext outside
the template surface is the subscriber create form's template defaults, which is
itself behind the `subscribers.write` gate, so masking does not regress it.

## Rate Limiting

MongoDB fixed window per endpoint:

- Per-user scope
- Standard headers: X-RateLimit-Limit, X-RateLimit-Remaining
- 429 + Retry-After on limit exceeded
