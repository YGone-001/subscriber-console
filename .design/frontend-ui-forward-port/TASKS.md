# Build Tasks: Historical Frontend UI Forward Port

Generated from: `.design/frontend-ui-forward-port/DESIGN_BRIEF.md`

Date: 2026-10-06

## Status

**T01-T25 are complete.** T23's symmetric measurement reaches 100.0% comparable coverage. All gates pass, 183 frontend tests pass, and lint / typecheck / build are green.

### T23 - COMPLETE

**Measurement implementation: complete. Acceptance target: MET.**

Both sides are now walked through their own import graph from their own entry points
(`scripts/lib/ui-parity-graph.mjs`), resolving static imports, dynamic `import()`,
`export ... from`, relative paths, the `@/` alias, and `.ts` / `.tsx` / `.jsx` / `.js` /
`/index.*`.

- Historical side: the 15 confirmed route entry points (Login, dashboard layout, Dashboard,
  Subscribers, Profile, OCS tariffs/contracts/balances and their details, Users and its
  detail/create, System Health).
- Current side: `main.tsx`, `App.tsx`, `router/router.tsx`.
- Redirect-only pages (9 of them: the OCS index/dashboard/sessions/subscribers/usage, roles and
  the three rating pages) are recorded but are NOT entries. The historical application never
  rendered them either, so anything reachable only through them is an orphan inside the
  historical graph and falls out of the denominator by construction - it is not a hand-written
  exclusion.
- Exclusions come only from the import graph or the frozen scope. Nothing was added to reach a
  ratio.

Measured result:

```
historical_entry_points=15   historical_reachable_files=121   current_reachable_files=164
historical_reachable_classes=914   current_reachable_classes=1030
missing_symmetric=12   symmetric_coverage=98.7%   acceptance_target=90%   -> MET
absolute_coverage=63.5%   (diagnostic only)
```

Locked as the regression baseline: floor `0.9868` (the exact 902/914 ratio) and at most 12
missing classes. `P-04` enforces the 90% target unconditionally; there is no opt-out in the
standard command.

Verified: renaming one covered class raises `missing_reachable` to 13 and fails `P-03`; restoring
it passes again.

Remaining gap, grouped by historical route -> source file (the reporting format the brief asked
for):

| Historical route | Source file | Classes | Resolution |
| --- | --- | --- | --- |
| (shared) | `components/NocSentinel.tsx` | 9 `noc-*` classes | ported in T25 |
| (shared) | `components/ocs/contracts/OcsContractsPanel.tsx` | `ocs-feedback-` | extractor fix: incomplete interpolation prefix dropped |
| dashboard-shell | `app/(dashboard)/components/NotificationCenter.tsx` | `success` | file-scoped `unsupported-contract` exclusion |

T25 ported the reference NOC triage UI, closing all nine `NocSentinel` classes. The remaining two
were then resolved at the source. The extractor is now syntax-aware and stylesheet-settled, which
also removed 18 further tokens the old tokeniser had wrongly counted - interpolation VARIABLE names
such as `status`, `tone`, `danger`, `pathname` and `selected`. The comparable vocabulary is therefore
895, not 914, and 0 of them are missing.

Neither token was resolved by adding unreachable markup: no fake `ocs-feedback-` element and no
`success` branch that can never receive data.

**The 11 unreferenced shared primitives were NOT wired in.** `AnalyticsCockpit` in the historical
application uses `MetricStrip` and `OcsResourceStrip`; the balances route renders
`OcsBalancePlaceholder`; the sessions and usage routes redirect to tariffs. Under the symmetric
graph they are reference-side orphans, so they never entered the denominator and there was never a
gap to close by wiring them. Adding them would have introduced UI the historical application never
rendered.

### T24 - remediation boundary and denylist

Both remediation endpoints stay callable. They are direct data-consistency repair, the Go router
registers them, and each enforces authentication, the `system_heal` capability, its own rate limit
(20/60s single, 10/60s batch) and operation logging.

Implemented:

1. `frontend/src/features/system-health/system-health-api.ts` is the single frontend owner of both
   paths, plus the audit-scan cursor step and the analytics sync trigger. It calls the current
   mutation client with the existing request builders.
2. `SystemHealthPage.tsx` contains **no native `fetch` at all** (previously four).
3. The retired approval branch and its dictionary copy are gone - from the health page **and** from
   `ProfileModal`, which carried the same pattern on profile version restore. Restores and repairs
   execute directly.
4. Batch outcomes are classified three ways (`succeeded` / `partial` / `failed`), a partial run
   reports its counts and surfaces the server's `errors`, and only the targets the server repaired
   leave the anomaly list.
5. Remediation is gated on `system_heal`: a viewer sees no heal entry point at all. The server
   capability check remains final.
6. `disabled-operations.test.ts` no longer relies on call shape. It extracts **endpoint literals**
   and decides write-vs-read from the surrounding call text, so a generic argument, a native
   `fetch`, or a wrapper cannot evade it. The denylist now forbids WRITES only, so the legitimate
   `/api/ratings` read is no longer a false positive.
7. Positive ownership tests assert: the two paths appear only in `system-health-api.ts`; the page
   uses no raw fetch; requests go through the builders and the mutation client; no approval handling
   survives anywhere; a partial batch is never rendered as full success; remediation is capability
   gated.

## Execution rules

- Complete tasks in the listed order unless a task explicitly has no dependency.
- Keep every completed task buildable and testable; do not copy unresolved Next.js files into `frontend/src`.
- Copy presentation behavior in domain batches, then adapt imports and data before compiling that batch.
- Preserve current API paths, request bodies, permissions, mutation clients, and route authority.
- Do not modify the historical checkout.

## Foundation and safeguards

- [x] **T01 - Freeze the visual and contract baseline**: Preserve the current/reference screenshots for login, dashboard, subscribers, profiles, OCS lists/details, users, system health, and Inventory at 1440x900, 1024x768, and 390x844; extend `scripts/capture-ui-parity.mjs` and its package command so capture works on Node 20 and fails when a route cannot render. _Modifies: `scripts/capture-ui-parity.mjs`, root `package.json`; reuses: existing authenticated capture and `.workbuddy-ai/reports/ui-parity-audit-2026-10-06*`; verification: all manifest images are generated and the working tree contains no backend change._

- [x] **T02 - Add a protected-file and forbidden-import gate**: Add a deterministic test that rejects `next/*`, Node route handlers, browser-direct `127.0.0.1:18888`, retired approval/audit UI routes, and accidental replacement of the Vite/React Router entry files. _Creates: `scripts/test-ui-forward-port-boundaries.mjs`; modifies: root `package.json`; reuses: current route-contract and disabled-operation tests; verification: the test passes on current source and fails against one controlled forbidden fixture._

- [x] **T03 - Define the bulk-copy manifest**: Record source-to-target mappings for shared UI, OCS, users, subscribers, profiles, login, and system health, plus explicit exclusions for historical runtime/providers/routes. The manifest must classify each historical component as `reuse-current`, `forward-port`, or `exclude`. _Creates: `.design/frontend-ui-forward-port/PORT_MANIFEST.md`; reuses: current `frontend/src/components/ui/*`, analytics components, and styles; verification: every historical TSX/CSS file relevant to an active route has exactly one disposition._

- [x] **T04 - Establish the React Router compatibility surface**: Create small typed helpers for historical presentational components that need navigation, route parameters, local links, search parameters, or unsaved-change protection, then mechanically replace Next imports during each domain port. Do not emulate Server Components or Next data loading. _Creates: `frontend/src/lib/ui-compat/router.ts`, `frontend/src/lib/ui-compat/link.tsx`; modifies: `frontend/src/components/ui/UnsavedChangesGuard.tsx` only if needed; reuses: `react-router-dom`; verification: unit tests cover push/replace/back, raw dynamic parameters, local-only destinations, and no `next/*` import remains._

- [x] **T05 - Create typed response-to-view-model adapters**: Centralize unwrapping and presentation mapping for `{plan}`, `{ok,balance}`, `{records}`, `{items,stats}`, `{user,normalizedRole,...}`, `{profiles,summary}`, alerts, and system health while preserving missing/null/zero/empty distinctions. _Creates: `frontend/src/features/ocs/ocs-view-models.ts`, `frontend/src/features/users/user-view-models.ts`, `frontend/src/features/profiles/profile-view-models.ts`, `frontend/src/features/subscribers/subscriber-view-models.ts`, and adapter tests under `frontend/tests/`; reuses: current read-client result types and formatting utilities; verification: captured API envelopes, explicit zero, null, missing fields, empty arrays, ObjectId-safe strings, and invalid payloads are covered._

## OCS domain batch

- [x] **T06 - Forward-port the complete OCS shared component pack**: Adapt the historical status badge, confirmation dialog, page shell, detail drawer, common panels, and modal presentation as one coherent component set, retaining the historical DOM/class structure and replacing only navigation, data, and mutation dependencies. _Sources: historical `frontend/src/components/ocs/common/*`, `OcsPageShell.tsx`, `OcsDetailDrawer.tsx`; targets: current `frontend/src/components/ocs/**`; modifies: `frontend/src/styles/ocs.css` only for verified drift; depends on: T02-T05; verification: Story-like test fixtures render active, suspended, disabled, empty, loading, error, and forbidden states without API calls._

- [x] **T07 - Forward-port tariff list, detail, governance, and modals**: Bulk-adapt `OcsTariffsPanel`, `OcsTariffDetail`, `OcsTariffGovernancePanel`, and `TariffPlanModal`; replace current simplified list/detail composition while keeping current Go tariff reads and six governed mutation paths. _Sources: historical `frontend/src/components/ocs/OcsTariffsPanel.tsx`, `frontend/src/components/ocs/tariffs/*`; targets: `frontend/src/components/ocs/tariffs/*`, `frontend/src/features/ocs/tariffs/TariffsPage.tsx`, `TariffDetailPage.tsx`; reuses: T05 tariff adapter, current mutation client, `OcsPageShell`; depends on: T06; verification: list/detail screenshots match, `{plan}` is unwrapped, export headers remain browser-driven, and create/update/delete/clone/enable/disable preserve 403/409/429 behavior._

- [x] **T08 - Forward-port contract list and detail**: Bulk-adapt the historical contract panel and structured contract detail, including identity, billing-contract, history, status filtering, and supported suspend/resume/terminate/update actions. _Sources: historical `frontend/src/components/ocs/contracts/*`, `OcsSubscribersPanel.tsx`; targets: `frontend/src/components/ocs/contracts/*`, `frontend/src/features/ocs/contracts/ContractsPage.tsx`, `ContractDetailPage.tsx`; reuses: current `/api/ocs/subscribers` contracts and T05 adapters; depends on: T06; verification: populated/empty/404/forbidden/conflict states and desktop/mobile screenshots pass._

- [x] **T09 - Forward-port balance list, detail, and adjustment modal**: Bulk-adapt the historical balance panel, structured data/voice/SMS/governance detail, placeholder, read-only notice, and adjustment modal; permanently keep reset unavailable. _Sources: historical `frontend/src/components/ocs/balances/*`, `OcsBalancesPanel.tsx`; targets: `frontend/src/components/ocs/balances/*`, `frontend/src/features/ocs/balances/BalancesPage.tsx`, `BalanceDetailPage.tsx`; reuses: current adjustment mutation and T05 balance adapter; depends on: T06; verification: `{ok,balance}` is unwrapped, reset is absent, adjustment respects capabilities/rate limits, and three viewport screenshots match._

- [x] **T10 - Close OCS batch parity**: Align status filters, metric-strip geometry, action density, pagination visibility, read-only messaging, localization, and responsive tables across all three OCS domains. _Modifies: OCS files introduced in T06-T09 and `frontend/src/styles/ocs.css`; reuses: `MetricStrip`, `DataTablePagination`, `SortableTableHeader`, `InlineNotice`; depends on: T07-T09; verification: OCS reference/current image diff is within the approved threshold with dynamic data masked only._

## User-management domain batch

- [x] **T11 - Forward-port the historical user component pack**: Adapt the historical summary, toolbar, table, drawer, basic information, permissions, login history, create/edit/reset forms, confirmation dialogs, password strength, bulk progress, and bulk action presentation in one domain batch. _Sources: historical `frontend/src/app/(dashboard)/users/components/*`; targets: `frontend/src/features/users/components/*`; reuses: current UI primitives, security policy, mutation client, and existing user CSS modules; depends on: T02-T05; verification: all copied components compile without Next imports and render from fixture view models._

- [x] **T12 - Replace the users list with the historical composition**: Wire the summary from `stats`, role/status filters, clear-filter behavior, selection, normalized roles, avatar/identity cells, last-login mapping, sorting, pagination, row actions, and responsive card/table states. _Modifies: `frontend/src/features/users/UsersPage.tsx`; reuses: T11 components and T05 user adapters; depends on: T11; verification: admin sees contract-supported management actions, operator/viewer do not see user-management actions, and 1440/1024/390 screenshots match._

- [x] **T13 - Replace user detail and creation surfaces**: Restore the structured detail header, status/role badges, sections/tabs, permissions, activity, edit/reset/disable dialogs, and full-page create form; remove `login-card` reuse and hard-coded English copy. _Modifies: `frontend/src/features/users/UserDetailPage.tsx`, `UserCreatePage.tsx`, locale dictionaries; reuses: T11 components, password policy, canonical role options, `normalizedRole`, `actions`, and `assignableRoles`; depends on: T11; verification: active/locked/disabled users, last-active-admin protection, password validation, unsaved changes, and responsive screenshots pass._

- [x] **T14 - Restore safe user bulk interaction**: Retain the historical multi-selection and progress UI only by orchestrating existing single-user endpoints; report per-user success/failure and never invent a bulk API or bypass Fresh Actor revalidation. _Modifies: T11 bulk components and `UsersPage.tsx`; reuses: current mutation client and confirmation dialog; depends on: T12-T13; verification: partial failure, 403, 409, 429, cancellation-before-submit, and no automatic mutation retry are tested._

## Subscriber and profile domain batch

- [x] **T15 - Forward-port subscriber list composition as a domain pack**: Adapt the historical summary, toolbar, sortable table, mobile sorting, selection, copy action, row menu, traffic progress, pagination, and related visual states while keeping current query aliases and mutation builders. _Sources: historical subscriber page components and `subscribers.css`; targets: `frontend/src/features/subscribers/components/*`, `SubscribersPage.tsx`; reuses: current `MetricStrip`, `SortableTableHeader`, `DataTablePagination`, subscriber view-model adapter, and mutation contracts; depends on: T05; verification: documented list/search/MSISDN/status/sort/pagination cases and 390px no-overflow screenshots pass._

- [x] **T16 - Forward-port supported subscriber dialogs and detail presentation**: Adapt subscriber create/edit, batch create/update, import, bulk policy, traffic adjustment, trace, view/edit mode, and rating-link presentation only where current routes and request builders support them. _Sources: historical `SubscriberModal*`, `SubscriberBatchUpdateModal`, `BatchCreateModal`, `BulkPolicyModal`, `TrafficAdjustmentModal`, `SubscriberTraceModal`, `components/subscriber/*`; targets: current `frontend/src/features/subscribers/components/*`; reuses: current authoritative builders and mutation client; depends on: T15; verification: every action emits only the current approved method/path/body and preserves partial-failure semantics._

- [x] **T17 - Forward-port the profile domain pack**: Adapt historical profile list composition, domain filter chips, metric strip, empty state, modal, view/edit modes, PCC rule editor, session editor, and slice editor where supported by current profile contracts. _Sources: historical profile page, `ProfileModal.tsx`, and `components/profile/*`; targets: `frontend/src/features/profiles/components/*`, `ProfilesPage.tsx`; reuses: current `/api/profiles` contracts and T05 profile adapter; depends on: T05; verification: empty/populated/search/filter/create/edit/delete/restore states, localization, and three viewport screenshots pass._

## Shell, login, health, and current-only surfaces

- [x] **T18 - Finish shell interaction parity without replacing runtime authority**: Preserve the current AppShell, sidebar authority, visited tabs, breadcrumbs, session provider, theme, and language providers; add contract-backed global `/api/search` results to the command palette and align remaining focus/geometry differences. _Modifies: `frontend/src/app/components/CommandPalette.tsx`, `NavigationTabBar.tsx`, `NavigationBreadcrumbs.tsx`, related styles; reuses: current router and `/api/search`; depends on: T04-T05; verification: keyboard-only route/search navigation, subscriber-first/profile-second results, local-only destinations, and responsive shell screenshots pass._

- [x] **T19 - Align login and system health**: Correct login field icon spacing/card geometry and restore the historical system-health status pill and action ordering while retaining current authentication, no-store behavior, and live health data. _Modifies: current login component/styles, `frontend/src/features/system-health/SystemHealthPage.tsx`, `frontend/src/styles/login.css`, `system-health.css`; reuses: current auth flow and `SubsystemCard`; verification: invalid/session-expired/login success states and health available/degraded/unavailable states match reference presentation._

- [x] **T20 - Apply the restored design language to Inventory**: Keep Inventory as a current-only route, remove untranslated keys and hard-coded English copy, and align its page headers, filters, forms, state panels, dialogs, and responsive layout with the restored UI primitives. _Modifies: `frontend/src/features/inventory/*`, `frontend/src/lib/locales/*`, relevant page styles; reuses: current inventory validation/builders and shared UI primitives; depends on: T18; verification: create/detail/list, validation, CAS conflict, retired state, Chinese/English, light/dark, and 390px layouts pass._

## Responsive, accessibility, and acceptance

- [x] **T21 - Complete responsive parity for every active surface**: Review all comparable routes at 1440x900, 1024x768, and 390x844; correct grid collapse, table-to-card behavior, action wrapping, modal sizing, touch targets, sticky controls, and horizontal overflow. _Modifies: only the ported component/style files that fail comparison; reuses: existing breakpoints and historical CSS; depends on: T07-T20; verification: automated viewport captures plus manual overflow inspection report zero unexplained layout differences._

- [x] **T22 - Complete accessibility and interaction-state parity**: Verify semantic headings/tables/forms, labels, visible focus, dialog focus trap/restoration, Escape behavior, reduced motion, keyboard sorting/actions, live regions, contrast, and disabled/loading behavior. _Modifies: ported components and shared primitives as findings require; reuses: `Dialog`, `Field`, `IconButton`, `InlineNotice`, `OperationFeedback`, `useDialogFocus`; depends on: T21; verification: automated accessibility checks where available plus a documented keyboard walkthrough for each domain._

- [x] **T23 - Raise and enforce the parity gate**: Replace the temporary 30% class-coverage floor with staged thresholds ending at at least 90%, document justified exclusions for retired pages and current-only Inventory, and add route/state screenshot diff assertions for stable regions. _Modifies: `scripts/test-ui-parity-contract.mjs`, capture/diff scripts, `frontend/tests/ui-restoration.test.ts`, `frontend/tests/ui-primitives.test.ts`; depends on: T21-T22; verification: deleting a required historical class or component makes the gate fail._

- [x] **T24 - Final release acceptance**: Run the complete frontend and repository checks, compare all approved screenshots, confirm no backend/API/route/schema change, and record the remaining intentional differences. _Creates: `.design/frontend-ui-forward-port/ACCEPTANCE.md`; reuses: all earlier evidence; depends on: T23; verification: `npm --prefix frontend run lint`, `npm --prefix frontend run typecheck`, `npm --prefix frontend test`, `npm --prefix frontend run build`, `npm run check:ui-parity`, and `npm run check:agent-docs-parity` all pass._
- [x] **T25 - Close the NOC sentinel gap**: Restore the historical `noc-*` class vocabulary in the header NOC sentinel by porting the reference triage UI (critical ticker, activation card, monitor row, workflow summary, assignee row, action grid) over the current alert authority. _Modifies: `frontend/src/app/components/NocSentinel.tsx`; reuses: the current mutation client and `styles/noc-sentinel.css`; depends on: T23; verification: after the syntax-aware extractor correction, the symmetric gate reports 895/895 = 100.0% with zero missing comparable classes._

## Component disposition summary

### Reuse as-is unless a failing acceptance check proves otherwise

- Current `frontend/src/components/analytics/*` and `AnalyticsCockpit.tsx`
- Current `frontend/src/components/ui/*`
- Current `frontend/src/app/AppShell.tsx` and route/navigation authority
- Current read client, mutation client, authentication/session provider, subscriber mutation builders, and Inventory contract logic
- Current design tokens and restored global style layers

### Modify or replace with forward-ported historical presentation

- `frontend/src/components/ocs/**`
- `frontend/src/features/ocs/**`
- `frontend/src/features/users/**`
- `frontend/src/features/subscribers/**`
- `frontend/src/features/profiles/**`
- Command palette search presentation
- Login geometry and system-health header presentation
- Inventory copy and design-system alignment

### Create

- Typed response/view-model adapters
- React Router presentation compatibility helpers
- Forward-ported OCS/user/subscriber/profile component directories
- Boundary, adapter, interaction, and screenshot-diff tests
- Port manifest and final acceptance record

### Exclude

- Historical Next.js layouts/pages as runtime entry points
- Historical auth/session/API ownership logic
- Node route handlers and proxy behavior
- Retired approvals/audit UI
- Charging-plane UI or unsupported notification preferences
