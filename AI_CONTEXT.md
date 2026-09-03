# AI_CONTEXT.md — xCloud subscriber-console

> 当前项目快照，用于 Claude Code / MiMo / Codex 长会话续开发。
> **稳定规则看 `CLAUDE.md`；历史看 `DEV_LOG.md`；待办看 `TODO.md`。**
> 本文件可覆盖更新，不保存完整历史。

## 0. Minimal Bootstrap

新会话只做：

```text
1. Read CLAUDE.md
2. Read AI_CONTEXT.md
3. git status
4. git branch --show-current
5. git log --oneline -10
6. Read only task-relevant source
```

不要先扫描整个仓库。

---

## 1. Repository

Primary:

```text
https://github.com/YGone-001/subscriber-console.git
branch: develop
```

Reference only:

```text
https://github.com/YGone-001/CNMS.git
branch: develop
```

CNMS 不整仓合并。

Product = `xCloud`.

---

## 2. Current Architecture

```text
Browser
   |
   v
Nginx
   |----------------------|
   v                      v
Next.js :13333        Go :18888
UI                     Migrating API
Legacy writes          Auth validation
                       Read APIs
   |                      |
   +----------+-----------+
              |
              v
           MongoDB
      xcloud + xcloud_ops
```

Target:

```text
Browser -> Nginx
           ├─ /*      -> Next.js
           └─ /api/*  -> Go
```

Important:

```text
Production /api/* has NOT been globally cut over to Go.
Frontend API paths remain unchanged.
```

---

## 3. Stack

```text
Next.js 16.2.2
React 19.2.4
TypeScript 5.x
Node 20
MongoDB Node Driver 7.x
jose 6.2.2
```

Go:

```text
Go 1.24+
net/http
modern ServeMux
log/slog
mongo-driver/v2 v2.6.0
```

No Gin/Fiber/Echo/GORM.

---

## 4. Mongo

Same URI, two DBs:

```text
xcloud
xcloud_ops
```

Go:

```go
type Databases struct {
    Client  *mongo.Client
    xCloud *mongo.Database
    Ops     *mongo.Database
}
```

One client, two handles.

---

## 5. Migration Status

Latest verified logical status:

```text
Phase 0     COMPLETE
Phase 0.1   COMPLETE
Phase 1     COMPLETE
Phase 2A    COMPLETE
Phase 2A.1  COMPLETE
Phase 2B    COMPLETE
Phase 2B.1  COMPLETE
Phase 2C    COMPLETE
Phase 2C.1  COMPLETE
Phase 2D    COMPLETE
Phase 2D.1  COMPLETE

Phase 3     IN PROGRESS
Phase 3A    COMPLETE — security audit evidence writer + authorization denial integration
Phase 3B    COMPLETE — audit writer lifecycle closeout
Phase 3C    COMPLETE — approval governance read foundation
Phase 3D    COMPLETE — explicit approval decision endpoints + contract preflight
```

Exact HEAD is intentionally not stored here.

Always use Git for SHA/status.

---

## 6. Go Foundation

`backend/` includes:

- env config
- one Mongo client / two DB handles
- `/healthz`
- `/readyz`
- request ID
- recovery
- structured logging
- security middleware
- graceful shutdown
- HTTP timeouts
- Go CI
- security audit evidence writer (BestEffort + Strict modes)
- authorization denial guard (RequireCapabilityWithAudit, RequirePermissionWithAudit)
- payload sanitizer (secret redaction, depth/bounds)

`/healthz` does not require Mongo.
`/readyz` checks Mongo.

---

## 7. Auth Compatibility

Current chain:

```text
auth_token cookie
→ HS256 verify
→ username / role / sv / exp
→ xcloud_ops.app_users
→ enabled
→ unlocked
→ sessionVersion match
→ role consistency
→ Principal
```

Real Node `jose` → Go verifier interoperability is proven.

Never trust:

```text
x-user
x-user-role
x-user-id
x-user-session-version
```

as authority.

`app_users` = Phase 2 read-only.
Login/logout = Node owner.

---

## 8. Rate Limit

Go limiter:

```text
MongoDB fixed window
xcloud_ops.app_rate_limits
```

Preserve exact Node key/limit/window/headers/messages.

Current write invariant:

```text
Business-domain writes by Go = NONE
Infrastructure writes = app_rate_limits (allowed)
Governance writes = app_approvals (CAS transitions + ACCESS_REQUEST creation, Strict audit)
Sequence writes = app_sequences (approval change ID generation)
Security audit writes = app_audit_logs (authorization.denied, BestEffort only)
```

---

## 9. Current Go Read Implementations

34 semantic-read implementations (33 GET + 1 POST semantic read).

Phase 2A — 6:

```text
GET /api/audit
GET /api/audit/:id
GET /api/analytics/metrics
GET /api/analytics/sparkline
GET /api/ratings
GET /api/ratings/:id
```

Phase 2B — 15:

### Profiles

```text
GET /api/profiles
GET /api/profiles/:name
GET /api/profiles/:name/stats
GET /api/profiles/:name/versions
```

### OCS

```text
GET /api/ocs/balances
GET /api/ocs/sessions
GET /api/ocs/usage
GET /api/ocs/reservations
```

### Tariff

```text
GET /api/tariff-plans
GET /api/tariff-plans/:planId
GET /api/tariff-plans/:planId/export
GET /api/tariff-plans/:planId/operations
GET /api/tariff-plans/:planId/rules
GET /api/tariff-plans/:planId/subscribers
GET /api/tariff-plans/:planId/migrate
```

Phase 2C — 4:

```text
GET /api/subscribers
GET /api/subscribers/:imsi
GET /api/search
POST /api/subscribers/batch/precheck
```

Phase 2D — 6:

```text
GET /api/auth/me
GET /api/auth/permissions
GET /api/auth/users
GET /api/auth/users/:username
GET /api/users
GET /api/users/:username
```

Phase 3C — 3 (Approval governance read foundation):

```text
GET /api/approvals
GET /api/approvals/:id
GET /api/approvals/:id/audit
```

Phase 3D — 5 (Explicit approval decision endpoints + creation):

```text
POST /api/approvals              — ACCESS_REQUEST creation (viewer→operator)
POST /api/approvals/:id/approve  — CAS transition, comment optional
POST /api/approvals/:id/reject   — CAS transition, reason required
POST /api/approvals/:id/cancel   — CAS transition, reason optional
POST /api/approvals/:id          — legacy compat adapter (dispatches by decision=approve|reject)
```

Status:

```text
Implemented = 39
Response Parity = 39
Cutover Ready = 39
Cutover Blocked = 0
Actually Routed = 0 (Nginx not modified)
ready + blocked = implemented ✅
```

Production `/api/*` still routes to Next.js.

---

## 9.1 Approval Governance

Go owns:
- Approval list/detail/audit read views
- Risk policy (approval-risk-v1)
- Maker-checker policy (independent reviewer)
- Pure state machine (CanTransition)
- Action eligibility (canApprove/canReject/canCancel/canExecute)
- Approve/reject/cancel CAS transitions (FindOneAndUpdate only)
- Explicit POST /api/approvals/:id/approve, /reject, /cancel
- Legacy POST /api/approvals/:id decision wrapper (dispatches by decision=approve|reject)
- ACCESS_REQUEST creation (POST /api/approvals)
- Generic internal approval creator (reusable for future Subscriber/OCS)
- Strict audit for transitions and creation
- ISO 8601 millisecond boundaries for createdAt/todayApproved
- Workflow interfaces (DecisionStore, IdentityReader, StrictAuditWriter)

Go does NOT own:
- Approval execute
- Business executors

Approval execute remains with Node.

Audit Writer:
- Strict lifecycle foundation ready (WaitGroup, RWMutex, for-range queue)
- BestEffort uses lifecycleCtx, Strict uses merged request+lifecycle context
- Close timeout guarantees workers exit (lifecycle cancel aborts Mongo ops)

---

## 9.2 Super Admin Direct Governance Policy

Separate PERMISSION from GOVERNANCE MODE.

Governance modes:
```text
DIRECT_GOVERNED    — execute immediately, no approval
APPROVAL_GOVERNED  — requires approval workflow
DISABLED           — not available (no override)
RUNTIME_INTERNAL   — not available via HTTP (no override)
```

Effective decision order:
```text
1. DISABLED → always DISABLED (even super_admin)
2. RUNTIME_INTERNAL → always RUNTIME_INTERNAL (even super_admin)
3. super_admin + APPROVAL_GOVERNED + has executor → DIRECT_GOVERNED
4. base mode applies
```

Super Admin detection: `auth.IsSuperAdmin(Principal)` or `approval.IsSuperAdminRole(role)`.
Treats `root` (legacy) and `super_admin` as Super Admin.

Evaluator: `approval.EvaluateGovernance(operation, role)` → `GovernanceResult`.

Super Admin direct mutations:
- DO NOT create approval records
- DO require permission checks
- DO require session/account validation
- DO require input validation
- DO require strict audit (with `governanceMode=DIRECT_GOVERNED`)
- DO NOT bypass DISABLED/RUNTIME_INTERNAL

Risk and governance are separate: SUBSCRIBER_BULK_DELETE remains critical risk even when DIRECT_GOVERNED.

Existing pending approvals are NOT auto-approved/executed.

---

## 10. Deferred Stateful GET

Do not migrate/count:

```text
GET /api/audit/export
```

Reason:

```text
writes audit evidence to app_audit_logs
```

Node remains owner.

Do not add Go 501 placeholder.

---

## 11. Phase 2B Contract Findings — Do Not Regress

### Tariff export

Must preserve:

```text
Content-Type: application/json
Content-Disposition: attachment; filename="tariff-plan-{id}.json"
```

Response includes current Node-compatible:

```text
version
exported_at
plan_id
name
...
```

Rate limit:

```text
30 / 60s
```

### Tariff operations

Go = compatibility read view only.
Governance authority = Node.

### Tariff migrate GET

```text
GET /api/tariff-plans/:planId/migrate
```

= dry-run only.

No tariff/subscriber/balance/approval/audit business write.

### Numeric

OCS conversion already tested for:

```text
int32
int64
float64
Decimal128
```

including:

```text
0
2147483648
10737418240
9007199254740991
```

Decimal128 scientific-notation bug was fixed.

### Zero / Date / ObjectId

- explicit zero must not disappear through `omitempty`
- dates match Node ISO millisecond form
- do not expose `_id`, `$oid`, driver internals

---

## 12. Migration Validator

Validator is source-derived and METHOD+PATH aware.

Must maintain:

- Go router ↔ matrix cross-check (all HTTP methods)
- phantom detection
- missing route detection
- dynamic path canonicalization
- migrated count derived from artifacts/source
- GET reads vs POST semantic reads classification
- business mutations count (should be 0)

Never hard-code endpoint counts.

---

## 13. Phase 2C — Complete

All 4 endpoints migrated:

```text
GET /api/subscribers         — list/detail/MSISDN lookup
GET /api/subscribers/:imsi   — legacy state detail
GET /api/search              — subscriber/profile split
POST /api/subscribers/batch/precheck — semantic read, requires subscriber_write cap
```

Business writes: NONE.
Security audit writes: NONE (authorization.denied audit not implemented).
Production routing: still Node.

---

## 14. Subscriber List Contract

Node:

```text
src/app/api/subscribers/route.ts
```

Modes:

```text
detail=false → listSubscriberImsis()
detail=true  → listSubscriberRows()
msisdn set   → MSISDN lookup mode
```

Query aliases:

```text
detail
page
limit
q
status
sortField
sort
sortDirection
sortDir
order
msisdn
excludeImsi
```

Known statuses:

```text
all
active
restricted
lowTraffic
```

Do not redesign validation.

MSISDN lookup contract includes:

```json
{
  "exists": false,
  "imsi": null,
  "source": null
}
```

when not found.

---

## 15. Subscriber Detail

Node:

```text
src/app/api/subscribers/[imsi]/route.ts
```

Phase 2C only migrates:

```text
GET
```

Do not touch:

```text
PUT
DELETE
```

Detail uses:

```text
findSubscriberLegacyState(imsi)
```

Go must reproduce legacy API representation, not raw xCloud BSON.

---

## 16. Subscriber Writes Stay Node

Do not migrate in Phase 2C:

```text
POST /api/subscribers
PUT /api/subscribers/:imsi
DELETE /api/subscribers/:imsi
batch create/update
bulk delete
import
policy mutation
```

Subscriber governance/approval authority remains Node.

---

## 17. Search Contract

Node:

```text
src/app/api/search/route.ts
```

Behavior:

```text
q.trim()
query length < 2 → {"results":[]}
```

Limit:

```text
default 8
min 1
max 12
invalid 8
```

Subscriber search:
- digits-only query

Profile search:
- lowercase `name/title` includes

Split:

```text
subscriberLimit = ceil(limit / 2)
profileLimit = limit - subscriberLimit
```

Order:

```text
subscriber results first
profile results second
```

Shape:

```text
id
label
desc
type
path
```

Types:

```text
imsi
profile
```

Current paths:

```text
/subscribers
/profile
```

Do not improve/re-rank during migration.

---

## 18. Batch Precheck

Node:

```text
src/app/api/subscribers/batch/precheck/route.ts
```

HTTP = POST.
Potential semantic read.

Current security/contract:
- `subscriber_write` capability
- `subscribers:batch-precheck:{user}`
- 30/60s
- `startImsi`
- `count`
- `IMSI_RANGE_OVERFLOW`

Even if read-only, permission remains `subscriber_write`.

Must audit `precheckSubscriberRange()` before migration.

---

## 19. xCloud Subscriber Risk

Highest-risk collection:

```text
xcloud.subscribers
```

Potential structures:
- security
- AMBR
- slices
- sessions
- MSISDN
- policy
- unknown fields
- Binary
- int32/int64
- dates

Preferred read path:

```text
bson.M / bson.Raw
→ explicit mapper
→ legacy API DTO
```

Do not strict-decode entire document into one giant struct unless proven safe.

---

## 20. Compatibility Rules

Must preserve distinctions:

```text
missing
null
0
""
[]
```

Beware:

```text
Go nil slice → null
Node may return []
```

Binary/Buffer:
- do not accidentally emit Go base64 if Node uses hex/string.

Unknown xCloud fields:
- must not make read fail.

---

## 21. Cross-DB Reads

Phase 2C may compose:

```text
xcloud
xcloud_ops
```

No cross-DB writes.
No transaction required.

If reads span collections, treat result as eventually consistent unless current Node proves snapshot semantics.

---

## 22. Performance

Correctness first, but detect obvious N+1.

Do not replace batch lookups with N per-subscriber OCS/profile queries if avoidable.

If indexes appear missing:

```text
PERFORMANCE_FINDING
```

Do not create indexes during Phase 2C.

---

## 23. Phase 2C Minimum Tests

Subscriber list:
- empty/single/multiple
- detail false/true
- q
- status
- sort aliases
- asc/desc
- pagination
- MSISDN found/missing
- excludeImsi
- invalid MSISDN

Detail:
- found
- invalid IMSI
- 404
- optional fields missing
- full doc
- multi-slice
- multi-session
- unknown field
- sensitive field behavior
- Binary/hex behavior

Search:
- q < 2
- digits
- text
- default/min/max/invalid limit
- order
- shape

Precheck if migrated:
- valid
- invalid IMSI
- invalid count
- overflow
- permission
- rate limit
- no business writes

---

## 24. Routing

Do NOT route entire:

```text
/api/subscribers/
```

to Go because same prefix contains write APIs.

Ownership is method + path.

It is valid to report:

```text
Implemented = YES
Parity = PASS
Actually Routed = NO
```

---

## 25. Phase 2D / Phase 3

Phase 2D complete. Phase 3 may start next.

Phase 2D provides:
- auth/me with permission and role normalization
- auth/permissions with full capability map (CapabilitiesFor, supports raw `root` role)
- User list with two modes: legacy (/api/auth/users no query) and query (strict parser)
- User detail with activity, actions, assignable roles
- User management policy (read-only): assignableRoles, userManagementActions
- Strict query parser: rejects unknown keys, duplicates, invalid values (400 INVALID_QUERY)
- Regex escape for search input
- Status filters: locked = status=locked OR locked=true; active/disabled = status + locked!=true
- Pagination: totalPages=max(1,ceil), page clamp, stable _id tiebreaker sort
- Stats: global total (not filtered), active excludes locked, locked includes status=locked
- Empty arrays preserved as [] (not null)
- Sensitive field guard: passwordHash, _id, security secrets never returned
- Mongo write guard: user package is read-only
- CapabilitiesFor supports raw `root` role for auth/permissions endpoint

Phase 3:
- Governance — IN PROGRESS
- Approval read foundation — COMPLETE (list/detail/audit)
- Audit writer lifecycle — COMPLETE (strict lifecycle, bounded close)
- Explicit decision endpoints — COMPLETE (approve/reject/cancel + legacy compat)
- Contract preflight — COMPLETE (paramOrElse, ISO8601Millis, presenter bson.D)
- ACCESS_REQUEST creation — COMPLETE (POST /api/approvals)
- Approval execute — DEFERRED (crosses into business mutations)

Security audit blocker:
- RESOLVED — authorization.denied audit writer implemented (Phase 3A)

---

## 26. CNMS Boundary

Keep sibling roles:

```text
subscriber-console
→ subscriber / OCS / tariff / governance

CNMS
→ monitoring / signaling / capture / RCA / AIOps / NF
```

Future integration by API/SSO/unified UI/context links, not repo absorption.

---

## 27. Task Start Protocol

For Phase 2C start only with:

```text
src/app/api/subscribers/route.ts
src/app/api/subscribers/[imsi]/route.ts
src/app/api/search/route.ts
src/app/api/subscribers/batch/precheck/route.ts
src/server/repositories/subscriberRepository.ts
src/lib/xcloudSubscriber.ts
src/lib/subscriberValidation.ts
```

Expand only by actual imports/call-chain.

---

## 28. Task End Protocol

Go:

```bash
cd backend
gofmt -w .
go test ./...
go test -race ./...
go vet ./...
go build ./...
```

Node:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

If available:

```bash
npm run check:full
```

Migration:

```bash
node scripts/migration/inventory-api.mjs
node scripts/migration/validate-inventory.mjs
```

Run Node/Go parity where environment allows.

---

## 29. Git Protocol

After one logical feature:
- commit immediately
- concise Conventional Commit
- no phase/stage numbers in commit messages (describe what changed, not which phase)
- do not push unless explicitly requested
- do not amend completed phase history
- do not reset/discard user changes

Exact current SHA belongs to Git, not this file.

---

## 30. Context Budget Protocol

Keep active:

```text
current phase
current endpoint
current call-chain
current contract
current tests
current diff
current blocker
```

Do not repeatedly reload:
- all old phase reports
- all commits
- all docs
- all routes
- all repositories
- whole CNMS source

When context grows, create checkpoint:

```text
Confirmed
Implemented
Unresolved
Files touched
Tests
Next exact action
```

Persistent placement:

```text
Architecture/current ownership → AI_CONTEXT.md
Historical completed work      → DEV_LOG.md
Pending work                   → TODO.md
Stable rules                   → CLAUDE.md
```

Rule:

```text
Source code is memory.
Git is history.
AI_CONTEXT.md is the current map.
CLAUDE.md is the law.
```

---

## 31. Non-Negotiable

Never:
- trust forwarded identity headers
- dual-write business mutations
- change Mongo schema during language migration
- remove unknown xCloud fields
- change API paths/SWR paths
- move write ownership during Phase 2
- assume GET is pure
- assume POST is write
- hard-code migration counts
- claim cutover from handler existence
- copy CNMS auth model over subscriber-console

Always:

```text
verify source
preserve contract
preserve security
preserve data
test parity
commit small
keep rollback possible
```
