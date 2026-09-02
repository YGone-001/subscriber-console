# CNMS Reuse Matrix

> **Phase 0 Baseline** — Generated from source code scan on 2026-08-31
> Branch: `develop` | Commit: `1f1cb3fb27c680cc280e898801ca219d445788bb`

## CNMS Access Status

**Local clone**: NOT FOUND at `../CNMS`
**GitHub fetch**: FAILED (network restriction)
**Verification status**: UNVERIFIED — all classifications below are based on project documentation references (`CLAUDE.md`, `CNMS_REUSE.md`) and require source code verification when CNMS becomes available.

## Classification Legend

| Status | Meaning |
|--------|---------|
| `IMPLEMENTED_VERIFIED` | Code exists, tested, production-ready |
| `IMPLEMENTED_NEEDS_ADAPTATION` | Code exists but needs modification for subscriber-console |
| `IMPLEMENTED_UNVERIFIED` | Code exists but not verified against real data/tests |
| `REFERENCE_ONLY` | Architecture/pattern reference only |
| `SHELL` | Stub/interface exists, no real implementation |
| `DEFERRED` | Not yet built in CNMS |

## Capabilities (Per Documentation)

### Go Foundation

**CNMS Paths**: `main.go`, `internal/config/config.go`, `internal/mongo/client.go`, `internal/router/router.go`, `internal/middleware/ratelimit.go` (VERIFIED)

| Capability | CNMS Status | subscriber-console Relevance | Notes |
|-----------|-------------|------------------------------|-------|
| Config management | JSON file (`config.Load()`) | Phase 1 reference | sub-console should use env vars, not JSON file |
| MongoDB client lifecycle | `mongo-driver/v2`, single DB, `Connect` + `Ping` + `Close` | Phase 1 reference | sub-console needs **two DB handles** (xcloud + xcloud_ops) |
| HTTP handler structure | `net/http` + `ServeMux` switch | Phase 1 reference | sub-console: same approach, no framework |
| Rate limiting middleware | Token bucket, per-IP, in-memory `sync.Map` | Phase 1 reference | sub-console uses MongoDB-backed fixed-window |
| JSON response standardization | `{"status":"error","message":"..."}` | Phase 1 reference | sub-console uses `{"error":"...","code":"..."}` — **different shape** |
| Graceful shutdown | **NOT PRESENT** — bare `http.ListenAndServe` | Phase 1 | Must implement `signal.NotifyContext` + `server.Shutdown` |
| Health / Readiness endpoints | `/api/health` (basic) | Phase 1 reference | sub-console needs `/healthz` (no Mongo) + `/readyz` (pings Mongo) |

> **Verified**:
> - CNMS uses `go.mongodb.org/mongo-driver/v2` — same version sub-console should use
> - CNMS uses `net/http` standard library — correct approach for sub-console Phase 1
> - CNMS has NO graceful shutdown — must be implemented from scratch
> - CNMS has NO request ID middleware — must be implemented from scratch
> - CNMS has NO structured access logging — must be implemented from scratch

### Authentication

**CNMS Path**: `internal/auth/jwt.go` (VERIFIED)

| Capability | CNMS Status | subscriber-console Relevance | Notes |
|-----------|-------------|------------------------------|-------|
| JWT signing (HS256) | **Manual** (`crypto/hmac` + `base64`) | Phase 6 reference | Claims differ: CNMS=`{username,role,exp}`, sub-console=`{username,role,sv}` |
| JWT middleware | **Bearer token** (Authorization header) | Phase 6 reference | sub-console uses **cookie-based** (`auth_token`), completely different |
| JWT claims validation | **Expiry only** | Phase 6 reference | sub-console validates `sv` (sessionVersion) against MongoDB on every request |
| Password hashing | Not in JWT module | Phase 6 | Go `golang.org/x/crypto/bcrypt`, 72-byte limit compatible |
| Role authorization | `RequireRole("admin", "operator")` | Phase 6 reference | sub-console has capability + permission dual system |
| Session version / revocation | **NOT PRESENT** | N/A | sub-console has `security.sessionVersion`. CNMS lacks this entirely. |
| Account lock/disable | **NOT PRESENT** | N/A | sub-console has `locked`, `status` fields. CNMS lacks this. |

> **Verified differences**:
> - CNMS JWT Claims have `exp` (expiry), no `sv` (sessionVersion)
> - CNMS uses `Authorization: Bearer` header, sub-console uses `auth_token` cookie
> - CNMS has no session version validation or account lock checking
> - **CNMS Auth must NOT be copied.** Reference the middleware pattern only; re-implement session management.

### Subscriber Management

| Capability | CNMS Status | subscriber-console Relevance | Notes |
|-----------|-------------|------------------------------|-------|
| Subscriber CRUD | UNVERIFIED | Handler style reference only | CNMS subscriber model ≠ xCloud subscriber BSON. Data model is fundamentally different. |
| Subscriber list/pagination | UNVERIFIED | Pattern reference | subscriber-console joins 3 collections for list view |
| Subscriber import | UNVERIFIED | Pattern reference | subscriber-console has CSV import with OCS provisioning |
| Subscriber batch | UNVERIFIED | Pattern reference | subscriber-console has frozen payload governance |

**CRITICAL**: CNMS Subscriber API is NOT a direct replacement. subscriber-console works with xCloud subscription BSON (security, ambr, slice, session). CNMS subscriber is a monitoring/management view.

### OCS / Billing

| Capability | CNMS Status | subscriber-console Relevance | Notes |
|-----------|-------------|------------------------------|-------|
| OCS integration | UNVERIFIED | Likely DEFERRED | subscriber-console has full OCS billing integration |
| Balance management | UNVERIFIED | Likely DEFERRED | subscriber-console has CAS-based balance governance |
| Tariff plan CRUD | UNVERIFIED | Likely DEFERRED | subscriber-console has full tariff plan management |

### Governance / Approval

| Capability | CNMS Status | subscriber-console Relevance | Notes |
|-----------|-------------|------------------------------|-------|
| Approval workflow | UNVERIFIED | Likely DEFERRED | subscriber-console has full maker-checker governance |
| Risk policy | UNVERIFIED | Likely DEFERRED | subscriber-console has 24-action risk catalog |
| Executor registry | UNVERIFIED | Likely DEFERRED | subscriber-console has frozen payload executors |

### Notification

| Capability | CNMS Status | subscriber-console Relevance | Notes |
|-----------|-------------|------------------------------|-------|
| Webhook notifications | UNVERIFIED | Phase 7 reference | Need to verify: real webhook dispatch or stub |
| Email notifications | UNVERIFIED | Phase 7 reference | Need to verify |
| Notification log | UNVERIFIED | Phase 7 reference | Need to verify |
| SSE streaming | UNVERIFIED | Phase 7 reference | subscriber-console has `/api/notifications/stream` |

### Scheduler

| Capability | CNMS Status | subscriber-console Relevance | Notes |
|-----------|-------------|------------------------------|-------|
| Scheduler engine | UNVERIFIED | Phase 7 reference | Need to verify: cron-like, persistent tasks |
| Task persistence | UNVERIFIED | Phase 7 reference | Need to verify: MongoDB-backed or in-memory |
| Error recovery | UNVERIFIED | Phase 7 reference | Need to verify |

### Monitoring / Signaling / AIOps

| Capability | CNMS Status | subscriber-console Relevance | Notes |
|-----------|-------------|------------------------------|-------|
| Metrics collection | UNVERIFIED | NOT RELEVANT | Stays in CNMS |
| WebSocket streaming | UNVERIFIED | NOT RELEVANT | Stays in CNMS |
| HEP signaling | UNVERIFIED | NOT RELEVANT | Stays in CNMS |
| tshark/PCAP | UNVERIFIED | NOT RELEVANT | Stays in CNMS |
| AIOps (Z-score, trend, RCA) | UNVERIFIED | NOT RELEVANT | Stays in CNMS |
| NF auto-discovery | UNVERIFIED | NOT RELEVANT | Stays in CNMS |

**These capabilities belong to CNMS, NOT subscriber-console.** Phase 9 (CNMS Integration) is outside the scope of the backend separation.

## Summary

| Status | Count | Notes |
|--------|------:|-------|
| IMPLEMENTED_VERIFIED | 0 | Cannot verify without CNMS source access |
| IMPLEMENTED_NEEDS_ADAPTATION | 0 | Cannot verify |
| IMPLEMENTED_UNVERIFIED | 0 | Cannot verify |
| REFERENCE_ONLY | 0 | Cannot verify |
| SHELL | 0 | Cannot verify |
| DEFERRED | 0 | Cannot verify |
| **NEEDS_SOURCE_ACCESS** | **all** | **CNMS not available locally or via GitHub** |

## Action Required

1. Clone CNMS repository locally: `git clone https://github.com/YGone-001/CNMS.git ../CNMS`
2. Verify each capability against actual source code
3. Update this matrix with verified classifications
4. Pay special attention to Auth JWT claims comparison

## Previous Documentation References

- `CLAUDE.md` mentions CNMS reuse assets (P0-P3 classification)
- `CNMS_REUSE.md` (if exists) may have detailed reuse analysis
- These documents may be stale — source code verification is required
