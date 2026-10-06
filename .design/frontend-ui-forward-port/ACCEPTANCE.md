# Forward-port acceptance record

Date: 2026-10-06
Reference: `C:/Users/YGone/Desktop/subscriber-console` (commit 2c40903, last pure-Next.js state)
Target: `C:/Users/YGone/Desktop/program/subscriber-console/frontend`

## Verification results

| Check | Command | Result |
| --- | --- | --- |
| Frontend lint | `npm --prefix frontend run lint` | PASS |
| Frontend typecheck | `npm --prefix frontend run typecheck` | PASS |
| Frontend tests | `npm --prefix frontend test` | PASS — 183 tests, 0 failures |
| Frontend build | `npm --prefix frontend run build` | PASS |
| Reference parity | `npm run check:ui-parity` | PASS — 100.0% comparable coverage, 0 missing |
| Extractor contract | `npm run test:ui-parity-extractor` | PASS — 9 tests |
| Port boundaries | `npm run check:ui-forward-port-boundaries` | PASS |
| Agent docs parity | `npm run check:agent-docs-parity` | PASS |
| Port manifest | `npm run ui:port-manifest --check` | PASS — 224 files, 0 stale |
| UI restoration contract | `node scripts/test-ui-restoration-contract.mjs` | PASS |
| Frontend runtime boundary | `node scripts/test-frontend-runtime-boundary.mjs` | PASS |
| Frontend runtime dependencies | `node scripts/test-frontend-runtime-dependencies.mjs` | PASS — 0 banned imports |
| Frontend read contract | `node scripts/test-frontend-read-contract.mjs` | PASS |
| Frontend mutation contract | `node scripts/test-frontend-mutation-contract.mjs` | PASS — 29 enabled registered endpoints |
| Frontend shell contract | `node scripts/test-frontend-shell-contract.mjs` | PASS |
| OCS management suite | `node scripts/test-ocs-management-suite.mjs` | PASS |
| User management e2e | `node scripts/test-user-management-e2e.mjs` | PASS |
| Accessibility | `npm run ui:a11y` | PASS — 9 routes, 0 violations |
| Responsive layout | `npm run ui:capture --strict-layout` | PASS — 30/30 captures, 0px overflow, 0 undersized mobile targets |

## Parity measurement

`npm run check:ui-parity` scores SYMMETRIC reachability: both sides are walked through their own
import graph from their own entry points.

```
historical_entry_points=15     historical_reachable_files=121   current_reachable_files=164
comparable_reachable_classes=895   current_reachable_classes=1018
missing_symmetric=0   symmetric_coverage=100.0%
regression_floor=100.0%   acceptance_target=90%   max_missing=0
absolute_coverage=63.1%   (diagnostic only, never scored)
```

Historical entries are the routes that still have a comparable route in the current console: login,
dashboard layout, dashboard, subscribers, profile, OCS tariffs/contracts/balances and their detail
routes, users plus create/detail, system health. Nine redirect-only pages are recorded but are not
entries, so anything reachable only through them falls out of the denominator by construction.

## The two previously missing tokens: resolved at the source

Neither was silenced, and neither was covered by adding dead code.

**`ocs-feedback-` — a genuine tokeniser artefact, fixed in the extractor.**
`className={`ocs-feedback-${feedback.type}`}` only ever produces `ocs-feedback-success` or
`ocs-feedback-error` at runtime, and both are explicitly covered in the current markup. The tokeniser
is now syntax-aware: a token touching an interpolation boundary is incomplete and is dropped, while
the real concatenated classes are still detected.

The rule needs one tie-breaker. Two patterns are syntactically identical:

```
className={`subsystem-metric-val${metric.tone ? ` ${metric.tone}` : ""}`}   // complete class
className={`ocs-feedback-${feedback.type}`}                                  // fragment
```

so a boundary-touching token counts only when a stylesheet defines it. That keeps
`subsystem-metric-val` (defined in `system-health.css`) and drops `ocs-feedback-` (defined nowhere).

Fixing the extractor also removed 18 further tokens the old tokeniser had been counting: it split on
the interpolation marker, so it emitted **interpolation variable names** such as `status`, `tone`,
`danger`, `compact`, `pathname`, `selected`, `domain`, `enabled`, `accent` and `found` as if they
were classes. None of them can ever be rendered as a class, so the honest comparable vocabulary is
895, not 914.

**`success` — a token-scoped contract exclusion, not an artefact.**
The historical notification centre rendered `notif-type-icon success`. The current alert authority
only issues CRITICAL, WARNING and INFO, and the notification provider maps success to info. There is
no SUCCESS alert contract, so the branch cannot be reached and must not be added for coverage. It is
excluded precisely - one file, one token, reason `unsupported-contract` - in
`scripts/lib/ui-parity-scope.mjs`, and that exclusion participates in the scope digest. There is no
global `success` exclusion: the same word anywhere else still counts.

The extractor has its own fixed tests (`npm run test:ui-parity-extractor`, also run by
`check:ui-parity`), covering both cases above plus interpolation variable names, nested braces and
plain string literals.

## Intentional differences from the reference

These are deliberate, not gaps:

1. **Retired surfaces are not ported** and no entry point to them survives: the Data Hub, the
   signalling trace modal, the visual diff viewer, the governance console, the charging-plane rating
   console. The manifest records each with a reason (`retired`, `charging-plane`,
   `current-runtime-replaced`, `unsupported-contract`).
2. **The bulk policy surface is absent** because its mutation is on the project's absolute denylist.
3. **The runtime is the current one**: React Router, the current read and mutation clients, the
   current providers, the current stylesheet layers. The historical equivalents are not copied.
4. **`ProfileModal` and the system-health page have no approval hand-off**: remediation and restore
   execute directly, matching `docs/operations/direct-operation-model.md`.
5. **Eleven shared primitives remain unreferenced** (`analytics/KpiCard`,
   `analytics/OcsBalanceCapacityCard`, `analytics/OcsSessionTelemetryCard`,
   `analytics/PlmnDistributionChart`, `ocs/OcsDetailDrawer`, `ui/IconButton`, `ui/InlineNotice`,
   `ui/KpiCard`, `ui/StatusBadge`, `ConfirmDialog`). The historical application did not render them
   either — its `AnalyticsCockpit` uses `MetricStrip` and `OcsResourceStrip`, its balances route
   renders `OcsBalancePlaceholder`, and its sessions/usage routes redirect to tariffs. Wiring them in
   would introduce UI the historical application never showed.

## No backend, API, route or schema change

The port touched `frontend/` and the verification scripts only. No Go file, route registration,
request or response shape was modified. `npm run check:ui-forward-port-boundaries` enforces the
frontend boundary mechanically.
