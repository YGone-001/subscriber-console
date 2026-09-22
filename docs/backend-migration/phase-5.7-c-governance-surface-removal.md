# Phase 5.7-C — Governance Surface Removal & Direct Operations Finalization

Status: Implementation complete; local acceptance passed
Date: 2026-09-23
Branch: `develop`

## Delivered scope

- Removed approval and audit-console pages, API routes, navigation, notification handling, repositories, executors, workflow/state-machine code, and obsolete tests.
- Preserved `/api/system/audit/*` as data-integrity diagnostics and healing, separate from the retired audit-log console.
- Reduced mutation authorization to canonical roles: `admin` and `operator` execute authorized operations directly; `viewer` receives HTTP 403.
- Removed `approval_review`, `approval_execute`, `audit_view`, and `audit_export` capabilities and retired approval/audit-console permissions.
- Converted Next.js operation logging to non-gating behavior and removed `503 AUDIT_UNAVAILABLE` response paths.
- Removed active `app_approvals` collection reads, writes, migrations, health checks, and index initialization. Historical data is not dropped.
- Retained append-only internal operation logs in `app_audit_logs`.
- Updated Mongo initialization, API inventory validation, CI naming/gates, RBAC acceptance, navigation tests, and direct-operation acceptance coverage.

## Routing invariants

| Invariant | Result |
| --- | --- |
| `CUTOVER_TABLE` | 26 |
| `ACTUALLY_ROUTED` | 26 |
| Cutover owners | 26/26 Go |
| Next.js route files | 52 |
| Next.js API operations | 76 |
| Removed `/api/approvals/*` | Confirmed |
| Removed `/api/audit/*` | Confirmed |
| Retained `/api/system/audit/*` | Confirmed |

## Verification evidence

| Gate | Result |
| --- | --- |
| Frontend lint | PASS — 0 errors, 22 non-blocking warnings |
| Frontend typecheck | PASS |
| Frontend tests | PASS — 437/437 |
| Frontend production build | PASS |
| Direct-operation contract | PASS |
| API inventory generation and validation | PASS |
| Mongo core acceptance | PASS; ephemeral databases removed |
| OCS management acceptance | PASS — 25 assertions |
| RBAC simplification acceptance | PASS — 27 assertions |
| RBAC migration acceptance | PASS — 20 assertions |
| Go format/diff check | PASS |
| Go vet | PASS |
| Go tests | PASS — all packages |
| Go build | PASS |
| Go race test | Not runnable on this Windows host: CGO is disabled and no C compiler is installed. The Linux CI race gate remains enabled. |

## Operational notes

- No destructive migration drops `app_approvals`; historical records remain available for offline retention decisions.
- No remote branch push or hosted CI run was performed as part of this local implementation.
- Phase 5.7-D and Phase 6 are intentionally out of scope.
