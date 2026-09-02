# API Contract Baseline

> **Phase 0 Baseline** — Frozen from source code on 2026-08-31
> Branch: `develop` | Commit: `1f1cb3fb27c680cc280e898801ca219d445788bb`

## Purpose

This document freezes the current API behavior. The Go backend must implement compatible contracts. This is NOT a redesign — it is a snapshot.

## Common Patterns

### Authentication

All routes (except login/logout) require JWT cookie `auth_token`:
- Verified by `proxy.ts` middleware (jose `jwtVerify`)
- Sets headers: `x-user`, `x-user-role`, `x-user-id`, `x-user-session-version`
- Route handlers additionally call `requireAuth()`, `requireCapability()`, or `requirePermission()`

### Error Shape

```json
{
  "error": "Human-readable message",
  "code": "MACHINE_READABLE_CODE"
}
```

Some routes also include:
```json
{
  "error": "...",
  "code": "...",
  "capability": "subscriber_write",
  "decision": "deny",
  "requiresApproval": false
}
```

### Rate Limiting

- Per-user, per-endpoint, fixed-window (MongoDB-backed)
- Response headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`
- Exceeded: `429 Too Many Requests` with `Retry-After` header

### Pagination

```json
{
  "data": [...],
  "total": 100,
  "page": 1,
  "limit": 50,
  "totalPages": 2
}
```

Query params: `page` (default 1), `limit` (default 50, max 200)

---

## Subscriber APIs

### GET /api/subscribers

**Query params**: `detail` (boolean), `page`, `limit`, `q`, `status` (all|active|restricted|lowTraffic), `sortField`, `sortDirection` (asc|desc), `msisdn`, `excludeImsi`

**Response (detail=false)**:
```json
{
  "subscribers": ["460001234567890", ...],
  "total": 100,
  "page": 1,
  "limit": 50
}
```

**Response (detail=true)**:
```json
{
  "subscribers": [{
    "imsi": "460001234567890",
    "status": "Active",
    "ard": 32,
    "plmn": "46000",
    "profile": "default",
    "policy": "plan_default_10gb",
    "policyName": "Default 10GB",
    "policyStatus": "active",
    "traffic": { "total": 10737418240, "used": 5368709120, "balance": 5368709120 },
    "sms": { "total": 100, "used": 50, "balance": 50 },
    "lastActive": "2026-08-31T12:00:00.000Z"
  }],
  "total": 100, "page": 1, "limit": 50,
  "summary": { "total": 100, "active": 80, "restricted": 10, "lowTraffic": 5 }
}
```

**MSISDN lookup** (when `msisdn` param present):
```json
{ "exists": true, "imsi": "460001234567890", "source": "xcloud" }
```

### POST /api/subscribers

**Request**:
```json
{ "imsi": "460001234567890", "msisdn": "13800138000", "planId": "plan_default_10gb" }
```

**Success**: `201` `{ "outcome": "executed", "message": "Subscriber created successfully", "imsi": "..." }`
**Conflict**: `409` `{ "error": "Subscriber already exists" }`
**Validation**: `400` `{ "error": "..." }`

### GET /api/subscribers/:imsi

**Response**: Full legacy subscriber state object (sub4G, auth4G, ocsTraffic, ocsImsi, ocsTariffPlan)
**Not found**: `404` `{ "error": "Subscriber not found" }`

### PUT /api/subscribers/:imsi

**Request**: `{ "sub4G": {...}, "auth4G": {...}, "ocsTraffic": {...} }`
**Success**: `202` `{ "outcome": "approval_required", "message": "...", "approval": {...} }`
**Not found**: `404`
**Sensitive change**: `422` `{ "error": "SENSITIVE_SUBSCRIBER_CHANGE_NOT_SUPPORTED" }`

### DELETE /api/subscribers/:imsi

**Success**: `202` `{ "outcome": "approval_required", "approval": {...} }`
**Not found**: `404`

---

## Approval APIs

### GET /api/approvals

**Query params**: `page`, `pageSize`, `q`, `status`, `risk`, `action`, `resourceType`, `requester`, `reviewer`, `fromTime`, `toTime`

**Response**:
```json
{
  "approvals": [{ "id": "...", "changeId": "CHG-20260831-00001", "action": "SUBSCRIBER_UPDATE", "status": "pending", ... }],
  "pagination": { "page": 1, "pageSize": 20, "total": 50, "totalPages": 3 },
  "summary": { "canReview": 5, "awaiting": 10, "todayApproved": 3, "highRiskPending": 2 },
  "total": 50, "pending": 10,
  "sla": { "ok": 5, "warning": 3, "danger": 2, "oldestHours": 72 }
}
```

### POST /api/approvals/:id/approve

**Request**: `{ "comment": "Looks good" }` (optional)
**Success**: `200` `{ "approval": {...} }`
**Conflict**: `409` `{ "error": "APPROVAL_STATE_CONFLICT" }`
**Forbidden**: `403` `{ "error": "MAKER_CHECKER_VIOLATION" }`

### POST /api/approvals/:id/execute

**Success**: `200` `{ "message": "Execution completed", "approval": {...} }`
**Failed**: `409` `{ "message": "Execution failed", "approval": {...} }`
**Forbidden**: `403` / `409`

---

## Auth APIs

### POST /api/auth/login

**Request**: `{ "username": "admin", "password": "..." }`
**Success**: `200` `{ "success": true, "username": "admin" }` + `Set-Cookie: auth_token=...`
**Rate limited**: `429` `{ "error": "Too many login attempts..." }`
**Invalid**: `401` `{ "error": "Invalid credentials" }`

### GET /api/auth/me

**Response**: `{ "username": "...", "role": "operator", "status": "active", ... }` (no passwordHash)

---

## OCS APIs

### GET /api/ocs/balances

**Response**: Array of balance records with `data_*`, `voice_*`, `sms_*` fields, `version`, invariant checks

---

## Error Status Codes

| Code | Meaning | Used By |
|------|---------|---------|
| 400 | Validation failure | All routes |
| 401 | Authentication failure | All protected routes |
| 403 | Permission denied | All permission-checked routes |
| 404 | Resource not found | Detail routes |
| 409 | Conflict / state mismatch | Approval, subscriber, OCS |
| 422 | Unprocessable entity | Subscriber sensitive change |
| 429 | Rate limit exceeded | All routes |
| 500 | Internal server error | All routes |
| 503 | Service unavailable | Auth (MongoDB down), audit |

---

## Notes for Go Implementation

1. **Error shape must match**: `{ "error": "...", "code": "..." }` — frontend SWR hooks parse this.
2. **202 for approval-required**: Write routes return 202 (not 200) when approval is created.
3. **Pagination envelope**: Must include `total`, `page`, `limit` at minimum.
4. **Cookie name**: `auth_token`, httpOnly, sameSite=lax, path=/
5. **JWT claims**: `{ username, role, sv }` — `sv` is sessionVersion for revocation.
6. **Rate limit headers**: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `Retry-After`
