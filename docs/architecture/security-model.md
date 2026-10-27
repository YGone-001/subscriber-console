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

The five template read endpoints (`GET /api/profiles`, `GET /api/profiles/meta`,
`GET /api/profiles/{name}`, `GET /api/profiles/{name}/stats`,
`GET /api/profiles/{name}/versions`) require the `profiles.read` permission; a
refusal returns 403 `PERMISSION_DENIED` and records `authorization.denied` audit
evidence via `RequirePermissionWithAudit`. `meta` is gated like any other read
because it carries the `credentialVisibility` decision.
`POST /api/profiles/{name}/versions/{versionId}/restore` passes the same read gate
before its `profile_rollback` capability check, because a restore reads a stored
snapshot that carries credential material.

Template write refusals (`POST /api/profiles`, `PUT /api/profiles/{name}`,
`DELETE /api/profiles/{name}`) keep their existing 403 `Insufficient permissions`
body and now also record `authorization.denied` evidence through
`audit.RecordPermissionDenied`, so a refused write leaves the same refusal trail a
refused read does without changing the response contract.

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

Server-side projections rewrite decoded documents through the profile package's
`fieldOf`/`setFieldOf` accessors, the single authority for the decoded shapes.
`asDocument` returns a rebuilt map for a `bson.D` input, so it is read-only by
contract: writing through its result mutates nothing the response marshals. A
regression test replays the driver's own BSON round-trip, so an assumption about
the decoded shape fails in the suite instead of passing against a hand-built map.

The masking sentinel `[MASKED]` is never valid write input: `PUT /api/profiles/{name}`
rejects it inside `auth.k` / `auth.op` / `auth.opc` with 400
`INVALID_PROFILE_UPDATE`. Echoing a read projection back would store the sentinel as
real authentication material, and the governed subscriber apply copies template `auth`
into `security.k`, so the write path closes that loop.

Template creation applies a stricter key policy than path resolution:
`POST /api/profiles` rejects an empty key, one longer than 64 characters, one with
leading or trailing whitespace or an embedded tab or newline, and the reserved key
`new` (case-insensitive), which would shadow the `/profile/new` SPA route and make
that template unreachable from the UI. The historical read pattern stays permissive so
an existing odd-named template remains reachable.

## Template Write Concurrency and Actor Revalidation

Every `app_profiles` document carries a monotonic `revision` counter (created at
1, advanced by each update and restore) and the read endpoints project it
unchanged. `PUT /api/profiles/{name}` and
`DELETE /api/profiles/{name}?expectedRevision=` accept an optional precondition:
a mismatch returns `409 PROFILE_REVISION_CONFLICT` with
`currentRevision` and `committed: false` and performs no write. An absent
precondition keeps the previous behaviour, so clients that predate the counter
are unaffected, and `revision` is outside the write allow-list, so no client can
set it directly.

All four template write endpoints revalidate the actor against `app_users` after
their permission or capability gate: a disabled, locked, re-roled or
session-revoked account is refused with `AUTH_USER_DISABLED`,
`AUTH_USER_LOCKED`, `AUTH_ROLE_MISMATCH` or `SESSION_REVOKED`, and an
unreachable account store fails closed with 503 rather than trusting token
claims. `profile/fresh_actor.go` is the third per-domain copy of this helper
(alongside `subscriber` and `balance`); consolidating the three is tracked
separately and was not done as part of this change.

## Rate Limiting

MongoDB fixed window per endpoint:

- Per-user scope
- Standard headers: X-RateLimit-Limit, X-RateLimit-Remaining
- 429 + Retry-After on limit exceeded
