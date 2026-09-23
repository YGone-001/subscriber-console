# Direct Operation Model

Status: Production
Phase: 5.7-C
Baseline: `develop`

## Execution contract

All supported business writes execute immediately after authentication, fresh-account validation, RBAC authorization, input validation, and concurrency checks.

| Canonical role | Read | Authorized writes | Approval workflow |
| --- | --- | --- | --- |
| `admin` | Allowed | Direct | Removed |
| `operator` | Allowed | Direct | Removed |
| `viewer` | Allowed | Denied with HTTP 403 | Removed |

Legacy role names continue to normalize at runtime: `root` and `super_admin` map to `admin`; `ops_admin` maps to `operator`; `auditor` maps to `viewer`.

## Operation logging

Business mutations append an internal operation record to `xcloud_ops.app_audit_logs`. Logging is best-effort and non-gating: queue saturation or MongoDB failure is logged diagnostically but never changes a committed business response into `503 AUDIT_UNAVAILABLE`.

The audit log is an internal operations facility. User-facing audit browsing/export APIs and pages are removed. `/api/system/audit/*` remains available because it diagnoses and heals data consistency; it is not an audit-log console.

## Removed surfaces

- Approval APIs, pages, navigation, notifications, repositories, executors, and workflow/state-machine code.
- Audit-console list/detail/export APIs, pages, navigation, and permission capabilities.
- Active readers, writers, migrations, and index initialization for `app_approvals`.

Historical `app_approvals` data is not dropped. It is left untouched for retention or offline archival policy.

## Invariants

- `CUTOVER_TABLE = 32`.
- `ACTUALLY_ROUTED = 32`; every cutover route is owned by Go.
- Go remains the authoritative writer for cutover operations.
- Runtime charging-plane boundaries are unchanged.
- Direct writes preserve validation, CAS/precondition checks, idempotency where applicable, and safe before/after operation-log snapshots.

Run `npm run test:direct-operations` at the repository root to verify the surface-removal and routing contract.
