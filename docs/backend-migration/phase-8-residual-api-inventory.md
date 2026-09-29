# Phase 8.0 — Residual API Inventory

Authoritative evidence table for the Phase 8.0 Next.js backend removal freeze.
Derived from current source at the frozen baseline (`CUTOVER_TABLE = 47`, `ACTUALLY_ROUTED = 47`).

- Validator: `scripts/test-phase-8-backend-removal-readiness.mjs`
- Architecture: `docs/architecture/phase-8-backend-removal-architecture.md`

Paths are shown in canonical Go-mux form (`{param}`); the matching Next.js file
uses `[param]` directory syntax.

---

## Totals

```text
api route files          = 54
api operations           = 78
GO_PRODUCTION_OWNED      = 37
NODE_PRODUCTION_OWNED    = 33   (residual; removal blocker)
LEGACY_ALIAS             = 2
RETIRED_SURFACE          = 6
TEST_ONLY                = 0
UNRESOLVED               = 0
frontend_api_callers_unmapped = 0
unknown_production_owner = 0
go_registered_operations = 73
go_native_cutover        = 10
backend_removal_ready    = false
```

---

## Full 78-operation inventory

`Owner` = real production owner at runtime. `Go` = exact `METHOD+PATH` registered
by the production Go binary source. `Callers` = confirmed frontend `/api/` callers
(repository-wide scan); `—` = none found.

### alerts / analytics

| METHOD | PATH (canonical) | Node file | Owner | Go | Callers |
| --- | --- | --- | --- | --- | --- |
| GET | /api/alerts | api/alerts/route.ts | GO | yes | AnalyticsCockpit.tsx:36, NocSentinel.tsx:70 |
| POST | /api/alerts/acknowledge | api/alerts/acknowledge/route.ts | GO | yes | — |
| POST | /api/alerts/workflow | api/alerts/workflow/route.ts | GO | yes | NocSentinel.tsx:141 |
| POST | /api/analytics/init | api/analytics/init/route.ts | GO | yes | CommandPalette.tsx:208, TopConsumerChart.tsx:129, PlmnDistributionChart.tsx:77 |
| GET | /api/analytics/metrics | api/analytics/metrics/route.ts | NODE | yes | AnalyticsCockpit.tsx:34, navigationPrefetch.ts:12 |
| GET | /api/analytics/sparkline | api/analytics/sparkline/route.ts | NODE | yes | AnalyticsCockpit.tsx:35 |

### auth

| METHOD | PATH (canonical) | Node file | Owner | Go | Callers |
| --- | --- | --- | --- | --- | --- |
| POST | /api/auth/login | api/auth/login/route.ts | GO | yes | LoginForm.tsx:48 |
| POST | /api/auth/logout | api/auth/logout/route.ts | GO | yes | UserMenu.tsx:21 |
| GET | /api/auth/me | api/auth/me/route.ts | GO | yes | useAuth.ts:19 |
| GET | /api/auth/permissions | api/auth/permissions/route.ts | GO | yes | — |
| GET | /api/auth/users | api/auth/users/route.ts | LEGACY | yes | — |
| POST | /api/auth/users | api/auth/users/route.ts | RETIRED | no | — |
| GET | /api/auth/users/{username} | api/auth/users/[username]/route.ts | LEGACY | yes | — |
| PUT | /api/auth/users/{username} | api/auth/users/[username]/route.ts | RETIRED | no | — |
| PATCH | /api/auth/users/{username} | api/auth/users/[username]/route.ts | RETIRED | no | — |
| DELETE | /api/auth/users/{username} | api/auth/users/[username]/route.ts | RETIRED | no | — |

### notifications / ocs (read)

| METHOD | PATH (canonical) | Node file | Owner | Go | Callers |
| --- | --- | --- | --- | --- | --- |
| GET | /api/notifications/stream | api/notifications/stream/route.ts | GO | yes | — |
| GET | /api/ocs/balances | api/ocs/balances/route.ts | NODE | yes | OcsBalancesPanel, navigationPrefetch.ts:21 |
| GET | /api/ocs/reservations | api/ocs/reservations/route.ts | NODE | yes | — |
| GET | /api/ocs/sessions | api/ocs/sessions/route.ts | NODE | yes | — |
| GET | /api/ocs/usage | api/ocs/usage/route.ts | NODE | yes | — |

### profiles

| METHOD | PATH (canonical) | Node file | Owner | Go | Callers |
| --- | --- | --- | --- | --- | --- |
| GET | /api/profiles | api/profiles/route.ts | NODE | yes | useSubscriberForm.ts:170, profile/page.tsx:68, subscribers/page.tsx:111, navigationPrefetch.ts:15 |
| POST | /api/profiles | api/profiles/route.ts | GO | yes | — |
| GET | /api/profiles/{name} | api/profiles/[name]/route.ts | NODE | yes | useSubscriberForm.ts:244 |
| PUT | /api/profiles/{name} | api/profiles/[name]/route.ts | GO | yes | — |
| DELETE | /api/profiles/{name} | api/profiles/[name]/route.ts | GO | yes | — |
| GET | /api/profiles/{name}/stats | api/profiles/[name]/stats/route.ts | NODE | yes | — |
| GET | /api/profiles/{name}/versions | api/profiles/[name]/versions/route.ts | NODE | yes | — |
| POST | /api/profiles/{name}/versions/{versionId}/restore | api/profiles/[name]/versions/[versionId]/restore/route.ts | GO | yes | — |

### ratings

| METHOD | PATH (canonical) | Node file | Owner | Go | Callers |
| --- | --- | --- | --- | --- | --- |
| GET | /api/ratings | api/ratings/route.ts | NODE | yes | useSubscriberForm.ts:210, ProfileModal.tsx:269, useRatingManagement.tsx:23 |
| POST | /api/ratings | api/ratings/route.ts | NODE | no | useRatingManagement.tsx:306 |
| GET | /api/ratings/{id} | api/ratings/[id]/route.ts | NODE | yes | useRatingManagement.tsx |
| PUT | /api/ratings/{id} | api/ratings/[id]/route.ts | NODE | no | useRatingManagement.tsx:337 |
| DELETE | /api/ratings/{id} | api/ratings/[id]/route.ts | NODE | no | useRatingManagement.tsx:369 |

### search / subscribers

| METHOD | PATH (canonical) | Node file | Owner | Go | Callers |
| --- | --- | --- | --- | --- | --- |
| GET | /api/search | api/search/route.ts | NODE | yes | CommandPalette.tsx:133 |
| GET | /api/subscribers | api/subscribers/route.ts | NODE | yes | useSubscriberForm.ts:144, subscribers/page.tsx:90, navigationPrefetch.ts:14 |
| POST | /api/subscribers | api/subscribers/route.ts | GO | yes | useSubscriberForm.ts:406 |
| GET | /api/subscribers/{imsi} | api/subscribers/[imsi]/route.ts | NODE | yes | useSubscriberForm.ts:109, useSubscriberForm.ts:291 |
| PUT | /api/subscribers/{imsi} | api/subscribers/[imsi]/route.ts | GO | yes | useSubscriberForm.ts:455 |
| DELETE | /api/subscribers/{imsi} | api/subscribers/[imsi]/route.ts | GO | yes | useSubscriberForm.ts:354, subscribers/page.tsx:176 |
| POST | /api/subscribers/{imsi}/profile | api/subscribers/[imsi]/profile/route.ts | GO | yes | — |
| POST | /api/subscribers/{imsi}/traffic-adjustments | api/subscribers/[imsi]/traffic-adjustments/route.ts | NODE | no | TrafficAdjustmentModal.tsx:108 |
| POST | /api/subscribers/batch | api/subscribers/batch/route.ts | GO | yes | BatchCreateModal.tsx:103 |
| POST | /api/subscribers/batch-update | api/subscribers/batch-update/route.ts | GO | yes | — |
| POST | /api/subscribers/batch/precheck | api/subscribers/batch/precheck/route.ts | NODE | yes | BatchCreateModal.tsx:71 |
| POST | /api/subscribers/bulk-delete | api/subscribers/bulk-delete/route.ts | GO | yes | subscribers/page.tsx:158 |
| POST | /api/subscribers/import | api/subscribers/import/route.ts | GO | yes | DataHub.tsx:264 |
| POST | /api/subscribers/policy | api/subscribers/policy/route.ts | NODE | no | BulkPolicyModal.tsx:73 |

### system

| METHOD | PATH (canonical) | Node file | Owner | Go | Callers |
| --- | --- | --- | --- | --- | --- |
| GET | /api/system/health | api/system/health/route.ts | GO | yes | navigationPrefetch.ts:24 |
| GET | /api/system/mongo/health | api/system/mongo/health/route.ts | GO | yes | — |
| GET | /api/system/audit/status | api/system/audit/status/route.ts | GO | yes | — |
| POST | /api/system/audit/scan | api/system/audit/scan/route.ts | GO | yes | — |
| POST | /api/system/audit/heal | api/system/audit/heal/route.ts | GO | yes | — |
| POST | /api/system/audit/batch-heal | api/system/audit/batch-heal/route.ts | GO | yes | — |

### tariff-plans

| METHOD | PATH (canonical) | Node file | Owner | Go | Callers |
| --- | --- | --- | --- | --- | --- |
| GET | /api/tariff-plans | api/tariff-plans/route.ts | NODE | yes | useSubscriberForm.ts:177, BatchCreateModal.tsx:26, OcsTariffGovernancePanel.tsx:40 |
| POST | /api/tariff-plans | api/tariff-plans/route.ts | GO | yes | TariffPlanModal.tsx:73 |
| GET | /api/tariff-plans/{planId} | api/tariff-plans/[planId]/route.ts | NODE | yes | useSubscriberForm.ts:209, ocsTariffApi.ts |
| PUT | /api/tariff-plans/{planId} | api/tariff-plans/[planId]/route.ts | GO | yes | TariffPlanModal.tsx |
| DELETE | /api/tariff-plans/{planId} | api/tariff-plans/[planId]/route.ts | GO | yes | OcsTariffGovernancePanel.tsx |
| POST | /api/tariff-plans/{planId}/clone | api/tariff-plans/[planId]/clone/route.ts | GO | yes | OcsTariffGovernancePanel.tsx:61 |
| GET | /api/tariff-plans/{planId}/export | api/tariff-plans/[planId]/export/route.ts | NODE | yes | — |
| GET | /api/tariff-plans/{planId}/migrate | api/tariff-plans/[planId]/migrate/route.ts | NODE | yes | TariffPlanList.tsx:113 |
| POST | /api/tariff-plans/{planId}/migrate | api/tariff-plans/[planId]/migrate/route.ts | NODE | no | useRatingManagement.tsx:276 |
| GET | /api/tariff-plans/{planId}/rules | api/tariff-plans/[planId]/rules/route.ts | NODE | yes | OcsTariffDetail.tsx:25, ocsTariffApi.ts:37 |
| POST | /api/tariff-plans/{planId}/rules | api/tariff-plans/[planId]/rules/route.ts | NODE | no | TariffRuleModal.tsx:150 |
| PUT | /api/tariff-plans/{planId}/rules/{ruleId} | api/tariff-plans/[planId]/rules/[ruleId]/route.ts | NODE | no | TariffRuleModal.tsx:149 |
| PATCH | /api/tariff-plans/{planId}/rules/{ruleId} | api/tariff-plans/[planId]/rules/[ruleId]/route.ts | NODE | no | TariffPlanList.tsx:198 |
| DELETE | /api/tariff-plans/{planId}/rules/{ruleId} | api/tariff-plans/[planId]/rules/[ruleId]/route.ts | NODE | no | TariffPlanList.tsx:214 |
| GET | /api/tariff-plans/{planId}/subscribers | api/tariff-plans/[planId]/subscribers/route.ts | NODE | yes | — |
| POST | /api/tariff-plans/import | api/tariff-plans/import/route.ts | NODE | no | TariffPlanImportModal.tsx:69 |

### users

| METHOD | PATH (canonical) | Node file | Owner | Go | Callers |
| --- | --- | --- | --- | --- | --- |
| GET | /api/users | api/users/route.ts | GO | yes | useUsersPage.ts:40, navigationPrefetch.ts:23 |
| POST | /api/users | api/users/route.ts | GO | yes | lib/api/users.ts |
| GET | /api/users/{username} | api/users/[username]/route.ts | GO | yes | useUserDrawer.ts:26, users/[username]/page.tsx:32 |
| PATCH | /api/users/{username} | api/users/[username]/route.ts | GO | yes | lib/api/users.ts |
| PUT | /api/users/{username} | api/users/[username]/route.ts | RETIRED | no | — |
| DELETE | /api/users/{username} | api/users/[username]/route.ts | RETIRED | no | — |
| POST | /api/users/{username}/disable | api/users/[username]/disable/route.ts | GO | yes | lib/api/users.ts |
| POST | /api/users/{username}/password-reset | api/users/[username]/password-reset/route.ts | GO | yes | lib/api/users.ts |

---

## Go-native cutover operations (10, no Node route file)

These are production-owned by Go via `CUTOVER_TABLE` but have no Next.js route
file. They are the approved compatibility mapping for the 47 → 78 reconciliation.

| METHOD | PATH |
| --- | --- |
| GET | /api/ocs/subscribers |
| POST | /api/ocs/subscribers |
| POST | /api/ocs/subscribers/{imsi}/suspend |
| POST | /api/ocs/subscribers/{imsi}/resume |
| PATCH | /api/ocs/subscribers/{imsi} |
| DELETE | /api/ocs/subscribers/{imsi} |
| POST | /api/ocs/balances/{imsi}/adjust |
| POST | /api/ocs/balances/{imsi}/reset |
| POST | /api/tariff-plans/{planId}/enable |
| POST | /api/tariff-plans/{planId}/disable |

Cutover reconciliation: `37 (in 78) + 10 (Go-native) = 47`.

---

## NODE_PRODUCTION_REMAINDER (33)

Each residual operation with reason, Go status, cutover readiness, decision and required phase.

| METHOD | PATH | Reason still Node-owned | Go status | Cutover readiness | Decision | Phase |
| --- | --- | --- | --- | --- | --- | --- |
| GET | /api/analytics/metrics | Go shadow exists; not production-routed | PRESENT | CANDIDATE | MIGRATE_TO_GO | 8.2 |
| GET | /api/analytics/sparkline | Go shadow exists; not production-routed | PRESENT | CANDIDATE | MIGRATE_TO_GO | 8.2 |
| GET | /api/ocs/balances | Go shadow exists; not production-routed | PRESENT | CANDIDATE | MIGRATE_TO_GO | 8.2 |
| GET | /api/ocs/reservations | Go shadow exists; not production-routed | PRESENT | CANDIDATE | MIGRATE_TO_GO | 8.2 |
| GET | /api/ocs/sessions | Go shadow exists; not production-routed | PRESENT | CANDIDATE | MIGRATE_TO_GO | 8.2 |
| GET | /api/ocs/usage | Go shadow exists; not production-routed | PRESENT | CANDIDATE | MIGRATE_TO_GO | 8.2 |
| GET | /api/profiles | Go shadow exists; not production-routed | PRESENT | CANDIDATE | MIGRATE_TO_GO | 8.2 |
| GET | /api/profiles/{name} | Go shadow exists; not production-routed | PRESENT | CANDIDATE | MIGRATE_TO_GO | 8.2 |
| GET | /api/profiles/{name}/stats | Go shadow exists; not production-routed | PRESENT | CANDIDATE | MIGRATE_TO_GO | 8.2 |
| GET | /api/profiles/{name}/versions | Go shadow exists; not production-routed | PRESENT | CANDIDATE | MIGRATE_TO_GO | 8.2 |
| GET | /api/ratings | Go shadow exists; not production-routed | PRESENT | CANDIDATE | MIGRATE_TO_GO | 8.2 |
| GET | /api/ratings/{id} | Go shadow exists; not production-routed | PRESENT | CANDIDATE | MIGRATE_TO_GO | 8.2 |
| GET | /api/search | Go shadow exists; not production-routed | PRESENT | CANDIDATE | MIGRATE_TO_GO | 8.2 |
| GET | /api/subscribers | Go shadow exists; not production-routed | PRESENT | CANDIDATE | MIGRATE_TO_GO | 8.2 |
| GET | /api/subscribers/{imsi} | Go shadow exists; not production-routed | PRESENT | CANDIDATE | MIGRATE_TO_GO | 8.2 |
| GET | /api/tariff-plans | Go shadow exists; not production-routed | PRESENT | CANDIDATE | MIGRATE_TO_GO | 8.2 |
| GET | /api/tariff-plans/{planId} | Go shadow exists; not production-routed | PRESENT | CANDIDATE | MIGRATE_TO_GO | 8.2 |
| GET | /api/tariff-plans/{planId}/export | Go shadow exists; not production-routed | PRESENT | CANDIDATE | MIGRATE_TO_GO | 8.2 |
| GET | /api/tariff-plans/{planId}/migrate | Go shadow exists; not production-routed | PRESENT | CANDIDATE | MIGRATE_TO_GO | 8.2 |
| GET | /api/tariff-plans/{planId}/rules | Go shadow exists; not production-routed | PRESENT | CANDIDATE | MIGRATE_TO_GO | 8.2 |
| GET | /api/tariff-plans/{planId}/subscribers | Go shadow exists; not production-routed | PRESENT | CANDIDATE | MIGRATE_TO_GO | 8.2 |
| POST | /api/subscribers/batch/precheck | Go shadow exists; not production-routed | PRESENT | CANDIDATE | MIGRATE_TO_GO | 8.2 |
| POST | /api/ratings | No Go implementation | ABSENT | REQUIRES_GO_IMPLEMENTATION | MIGRATE_TO_GO | 8.1 |
| PUT | /api/ratings/{id} | No Go implementation | ABSENT | REQUIRES_GO_IMPLEMENTATION | MIGRATE_TO_GO | 8.1 |
| DELETE | /api/ratings/{id} | No Go implementation | ABSENT | REQUIRES_GO_IMPLEMENTATION | MIGRATE_TO_GO | 8.1 |
| POST | /api/subscribers/policy | No Go implementation | ABSENT | REQUIRES_GO_IMPLEMENTATION | MIGRATE_TO_GO | 8.1 |
| POST | /api/subscribers/{imsi}/traffic-adjustments | No Go implementation | ABSENT | REQUIRES_GO_IMPLEMENTATION | MIGRATE_TO_GO | 8.1 |
| POST | /api/tariff-plans/import | No Go implementation | ABSENT | REQUIRES_GO_IMPLEMENTATION | MIGRATE_TO_GO | 8.1 |
| POST | /api/tariff-plans/{planId}/migrate | No Go implementation | ABSENT | REQUIRES_GO_IMPLEMENTATION | MIGRATE_TO_GO | 8.1 |
| POST | /api/tariff-plans/{planId}/rules | No Go implementation | ABSENT | REQUIRES_GO_IMPLEMENTATION | MIGRATE_TO_GO | 8.1 |
| PUT | /api/tariff-plans/{planId}/rules/{ruleId} | No Go implementation | ABSENT | REQUIRES_GO_IMPLEMENTATION | MIGRATE_TO_GO | 8.1 |
| PATCH | /api/tariff-plans/{planId}/rules/{ruleId} | No Go implementation | ABSENT | REQUIRES_GO_IMPLEMENTATION | MIGRATE_TO_GO | 8.1 |
| DELETE | /api/tariff-plans/{planId}/rules/{ruleId} | No Go implementation | ABSENT | REQUIRES_GO_IMPLEMENTATION | MIGRATE_TO_GO | 8.1 |

---

## Legacy / Retired surfaces

| METHOD | PATH | Classification | Decision | Evidence |
| --- | --- | --- | --- | --- |
| GET | /api/auth/users | LEGACY_ALIAS | KEEP_COMPAT | documented read alias (AGENTS §7); Go-registered |
| GET | /api/auth/users/{username} | LEGACY_ALIAS | KEEP_COMPAT | documented read alias (AGENTS §7); Go-registered |
| POST | /api/auth/users | RETIRED_SURFACE | RETIRE_BEFORE_NODE_REMOVAL | not canonical; no caller; not Go-registered |
| PUT | /api/auth/users/{username} | RETIRED_SURFACE | RETIRE_BEFORE_NODE_REMOVAL | not canonical; no caller; not Go-registered |
| PATCH | /api/auth/users/{username} | RETIRED_SURFACE | RETIRE_BEFORE_NODE_REMOVAL | not canonical; no caller; not Go-registered |
| DELETE | /api/auth/users/{username} | RETIRED_SURFACE | RETIRE_BEFORE_NODE_REMOVAL | not canonical; no caller; not Go-registered |
| PUT | /api/users/{username} | RETIRED_SURFACE | RETIRE_BEFORE_NODE_REMOVAL | canonical update is PATCH; no caller |
| DELETE | /api/users/{username} | RETIRED_SURFACE | RETIRE_BEFORE_NODE_REMOVAL | delete policy is soft-delete via POST disable; no caller |

Already-removed surface still referenced by stale frontend code:

| Caller | Target | Decision |
| --- | --- | --- |
| frontend/src/components/SubscriberTraceModal.tsx:78 | /api/audit?target=… | RETIRE_BEFORE_NODE_REMOVAL |
| frontend/src/components/ocs/balances/OcsBalanceDetail.tsx:38 | /api/audit?q=… | RETIRE_BEFORE_NODE_REMOVAL |

`/api/audit/*` was retired in Phase 5.7-C; these calls now return 404 against the
current backend and are non-blocking for Phase 8.0.

---

## Node runtime dependency consumers

| Module | Total | Classifications | Notes |
| --- | --- | --- | --- |
| mongodb | 14 | BACKEND_ONLY=13, BUILD_ONLY=1 | BUILD_ONLY = `types/xcloud.ts` (`import type`); `lib/xcloudSubscriber.ts` is backend-only in practice |
| jose | 2 | BACKEND_ONLY=2 | `proxy.ts` + `app/api/auth/login/route.ts` |
| bcryptjs | 4 | BACKEND_ONLY=4 | `app/api/auth/login`, `app/api/auth/users*` |

```text
FRONTEND_REQUIRED runtime consumers = 0
UNRESOLVED consumers = 0
```

---

## Proxy responsibilities (frontend/src/proxy.ts)

| Responsibility | Present |
| --- | --- |
| public API route gate (`/api/auth/login`, `/api/auth/logout`) | yes |
| API prefix gate (`startsWith('/api/')`) | yes |
| route ownership resolution (`resolveRouteOwner`) | yes |
| Go forwarding (`forwardToGo` / `GO_BACKEND_URL`) | yes |
| fail-closed 502 (`GO_BACKEND_UNREACHABLE`) | yes |
| cutover telemetry (`cutover_forward`) | yes |
| Node passthrough (`NextResponse.next()`) | yes |

---

## Historical vs current reconciliation

Historical migration documentation recorded a larger cumulative Go HTTP
operation count (e.g. a historical "90 HTTP operations" figure) driven by
successive phase deltas. That figure is a **historical baseline**, not the
current authoritative API contract.

```text
historical baseline              : phase-by-phase cumulative Go operation counts (see docs/operations/dev-log.md)
current authoritative inventory  : 54 route files / 78 Next.js operations (this document, regenerated from source)
retired operations               : /api/approvals/*, /api/audit/* (retired Phase 5.7-C; absent from the 78)
```

The 78-operation figure is the count of Next.js route operations that currently
exist in source; the 47-route figure is the production Go cutover ownership.
These are different measures and must not be conflated. Historical phase evidence
is preserved as-is.