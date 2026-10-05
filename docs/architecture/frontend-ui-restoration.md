# Frontend UI Restoration — Historical xCloud Presentation on the Current Runtime

Status: IMPLEMENTED (Stage 1-UI, presentation restoration only).

## 1. Dual authority

This document records how the historical xCloud operator UI was forward-ported onto
the current React/Vite + Go architecture. Two different commits are authoritative for
two different things, and they must never be confused.

| Role | Commit | Authoritative for |
|---|---|---|
| Current architecture authority | `11471af9d93fd4345f8d85a60f5c3fdfe821d93b` | React + Vite runtime, React Router, Go backend, REST ownership, authentication, RBAC, request contracts, Inventory, MongoDB, deployment, CI, the current route set |
| Historical UI reference authority | `e054d9349b26e29b2623c8ae42c57a4a973b22dd` | Visual language, layout, spacing, header and sidebar composition, navigation hierarchy, page composition, cards, tables, forms, modals, dashboard presentation, charts, loading/empty/error presentation, notifications, theme, language, responsive behaviour |

Rule applied throughout: the old UI decides **how it looks and feels**; the current
architecture decides **how it works**.

## 2. Classification vocabulary

| Classification | Meaning |
|---|---|
| `PORT` | Current functionality still exists, the historical component is presentation or interaction only, and the current API contract supports it. |
| `ADAPT` | The historical component is visually valuable but its data, auth or navigation implementation is obsolete. The visual design is retained and the implementation is rewritten against the current authority. |
| `DO NOT PORT` | The historical component represents architecture or product semantics that were intentionally retired. It is not restored. |

Every major historical presentation asset inspected below carries exactly one
classification. No asset is left unreviewed.

## 3. Restoration manifest

### 3.1 Shell and navigation

| Historical Asset | Historical Path | Current Target | Classification | Status | Reason / Adaptation |
|---|---|---|---|---|---|
| Dashboard layout | `frontend/src/app/(dashboard)/layout.tsx` | `frontend/src/app/AppShell.tsx` | ADAPT | Done | React Router `Outlet` replaces the App Router children slot; `usePathname`/`useRouter` replaced by `useLocation`/`useNavigate`; server navigation guard removed (backend remains the authority). |
| Shell stylesheet | `frontend/src/app/(dashboard)/layout.css` | `frontend/src/styles/shell.css` | ADAPT | Done | Header, sidebar, tab bar, breadcrumbs, notification centre and responsive geometry ported; retired approval-queue selectors dropped. |
| Global design tokens | `frontend/src/app/globals.css` | `frontend/src/styles/tokens.css`, `frontend/src/styles/base.css` | ADAPT | Done | Semantic palette, reference type scale, radii, spacing, shadows and motion recovered. Ant Design overrides and audit-diff selectors dropped. Legacy short token aliases kept so existing rules keep resolving. |
| Application header | `frontend/src/app/(dashboard)/components/AppHeader.tsx` | `frontend/src/app/components/AppHeader.tsx` | ADAPT | Done | `next/image` replaced by a Vite public asset `<img>`; palette state lifted to the shell orchestrator. |
| Application sidebar | `frontend/src/app/(dashboard)/components/AppSidebar.tsx` | `frontend/src/app/components/AppSidebar.tsx` | ADAPT | Done | Grouping now derives from `frontend/src/lib/navigation.ts`; prefetch hooks removed; 264/72 geometry, filter, active rail, tooltips and sub-navigation retained. |
| Notification centre | `frontend/src/app/(dashboard)/components/NotificationCenter.tsx` | `frontend/src/app/components/NotificationCenter.tsx` | ADAPT | Done | Historical notification provider replaced by the current SSE stream projection (`GET /api/notifications/stream`). Sound and desktop-notification preferences are not restored because no current authority exposes them. |
| User menu | `frontend/src/app/(dashboard)/components/UserMenu.tsx` | `frontend/src/app/components/UserMenu.tsx` | ADAPT | Done | `next/navigation` replaced by React Router; exposes current session facts and the current logout transport only. |
| Command palette | `frontend/src/components/CommandPalette.tsx` + `.css` | `frontend/src/app/components/CommandPalette.tsx` | ADAPT | Done | Route entries derive from the current navigation authority; historical IMSI/profile search results removed because no current search endpoint is part of the accepted read contract. |
| NOC sentinel | `frontend/src/components/NocSentinel.tsx` + `.css` | `frontend/src/app/components/NocSentinel.tsx` | ADAPT | Done | Visual shell retained; posture derives only from the current alert authority. Retired workflow mutation controls (acknowledge/assign/resolve actions) removed; an explicit neutral state is shown when the stream is unavailable. |
| Navigation tab bar | `frontend/src/components/NavigationTabBar.tsx` | `frontend/src/app/components/NavigationTabBar.tsx` | ADAPT | Done | Tab set derives from the current role-filtered navigation authority; no duplicated route array. |
| Breadcrumbs | `frontend/src/components/NavigationBreadcrumbs.tsx` | `frontend/src/app/components/NavigationBreadcrumbs.tsx` | ADAPT | Done | Crumbs derive from the current route authority with dynamic-segment support; recent-destination quick jump removed (no current persistence authority). |
| Theme switcher | `frontend/src/components/ThemeSwitcher.tsx` | `frontend/src/app/components/ThemeSwitcher.tsx` | PORT | Done | Now bound to the current `ThemeProvider` preference contract (system/light/dark). |
| Language switcher | `frontend/src/components/LanguageSwitcher.tsx` | `frontend/src/app/components/LanguageSwitcher.tsx` | PORT | Done | Bound to the current i18n provider; translation authority is not forked. |
| Toast container | `frontend/src/components/ToastContainer.tsx` | `frontend/src/providers/ToastProvider.tsx` | ADAPT | Done | Presentation-only toast transport; it announces backend-decided outcomes and never asserts success on its own. |
| Operation feedback | `frontend/src/components/OperationFeedback.tsx` + `.css` | `frontend/src/components/ui/OperationFeedback.tsx`, `frontend/src/providers/ToastProvider.tsx` | PORT | Done | Inline notice and toast presentation ported; obsolete operation-state authority not restored. |
| Notification provider | `frontend/src/components/NotificationProvider.tsx` | `frontend/src/providers/NotificationProvider.tsx` | ADAPT | Done | Rewritten against the current SSE stream. No polling infrastructure was introduced. |
| SWR provider | `frontend/src/components/SWRProvider.tsx` | `frontend/src/providers/AppProviders.tsx` | PORT | Done | Already present; unchanged cache semantics. |
| Global error boundary | `frontend/src/components/GlobalErrorBoundary.tsx` | `frontend/src/providers/GlobalErrorBoundary.tsx` | PORT | Done | Already present. |
| Navigation route model | `frontend/src/lib/navigationRoutes.ts` | `frontend/src/lib/navigation.ts` | ADAPT | Done | Historical route table replaced by the current authority, extended with restored sidebar grouping and navigation filtering helpers. |
| Navigation prefetch | `frontend/src/lib/navigationPrefetch.ts` | — | DO NOT PORT | Not restored | The historical prefetch helper depended on the retired provider key scheme; the current read client already caches per request key, so the optimisation is not required. |
| Brand asset | `frontend/public/images/xCloud_picture.png` | `frontend/public/images/xCloud_picture.png` | PORT | Done | Restored byte-identical from the historical Git blob `aaaa520147353d4f20127c58d9e9a8f3baf37695`; the plain character mark is no longer used as the final brand mark. |

### 3.2 Dashboard and analytics

| Historical Asset | Historical Path | Current Target | Classification | Status | Reason / Adaptation |
|---|---|---|---|---|---|
| Dashboard page | `frontend/src/app/(dashboard)/page.tsx` | `frontend/src/features/read/ReadPages.tsx` | ADAPT | Done | Restored as an operator cockpit driven by the current read contracts. |
| Analytics cockpit | `frontend/src/components/AnalyticsCockpit.tsx` | `frontend/src/features/read/ReadPages.tsx` | ADAPT | Done | Composition retained (KPI strip, charts, OCS panels, workbench); data sources replaced by the current endpoints. |
| Analytics stylesheet | `frontend/src/components/analytics.css` | `frontend/src/styles/pages.css` | ADAPT | Done | Card, work item, semantic badge and responsive patterns ported; unreferenced selectors dropped. |
| KPI card | `frontend/src/components/analytics/KpiCard.tsx` | `frontend/src/components/ui/KpiCard.tsx` | PORT | Done | Presentation ported onto current tokens. |
| Skeleton dashboard | `frontend/src/components/analytics/SkeletonDashboard.tsx` | `frontend/src/components/ui/LoadingSkeleton.tsx` | PORT | Done | Skeleton primitives generalised for pages, KPI strips, cards and tables. |
| Empty chart state | `frontend/src/components/analytics/EmptyChartState.tsx` | `frontend/src/components/ui/StatePanel.tsx` | ADAPT | Done | Generalised into structured empty/error/loading panels with no fabricated content. |
| Workbench panel | `frontend/src/components/analytics/WorkbenchPanel.tsx` | `frontend/src/features/read/ReadPages.tsx` | ADAPT | Done | Work items derive from unacknowledged alerts reported by the current alert authority. |
| PLMN distribution chart | `frontend/src/components/analytics/PlmnDistributionChart.tsx` | `frontend/src/features/read/ReadPages.tsx` | ADAPT | Done | Rendered from `plmnDist` on the current metrics contract using the existing charting library. |
| Tariff plan distribution chart | `frontend/src/components/analytics/TariffPlanDistributionChart.tsx` | `frontend/src/features/read/ReadPages.tsx` | ADAPT | Done | Rendered from `tariffPlanDist` on the current metrics contract. |
| Top consumer chart | `frontend/src/components/analytics/TopConsumerChart.tsx` | `frontend/src/features/read/ReadPages.tsx` | ADAPT | Done | Rendered from `top5` on the current metrics contract. |
| OCS balance capacity card | `frontend/src/components/analytics/OcsBalanceCapacityCard.tsx` | `frontend/src/features/read/ReadPages.tsx` | ADAPT | Done | Rendered from `ocsBalances`; no capacity value is inferred when the contract omits it. |
| OCS session telemetry card | `frontend/src/components/analytics/OcsSessionTelemetryCard.tsx` | `frontend/src/features/read/ReadPages.tsx` | ADAPT | Done | Rendered from `ocsSessions`. |
| OCS resource strip | `frontend/src/components/analytics/OcsResourceStrip.tsx` | `frontend/src/features/read/ReadPages.tsx` | ADAPT | Done | Reservation and usage metrics rendered from `ocsReservations` and `ocsUsage`. |
| Count-up number | `frontend/src/components/analytics/CountUpNumber.tsx` | — | DO NOT PORT | Not restored | Decorative animation only; the restored KPI cards read the authoritative value directly. |
| Analytics view model | `frontend/src/components/analytics/utils.ts`, `types.ts` | `frontend/src/features/read/dashboard-model.ts` | ADAPT | Done | Pure mapping extracted so the dashboard presentation is testable and cannot fabricate values. |

### 3.3 Business surfaces

| Historical Asset | Historical Path | Current Target | Classification | Status | Reason / Adaptation |
|---|---|---|---|---|---|
| Subscribers page | `frontend/src/app/(dashboard)/subscribers/page.tsx` | `frontend/src/features/subscribers/SubscribersPage.tsx` | ADAPT | Done | Current subscriber read and mutation contracts preserved; loading/empty/error presentation restored. |
| Subscriber table / toolbar / summary | `frontend/src/app/(dashboard)/subscribers/components/*` | `frontend/src/features/subscribers/SubscribersPage.tsx` | ADAPT | Done | Table shell, action toolbar and status badges restored; no business logic changed. |
| Subscriber stylesheet | `frontend/src/app/(dashboard)/subscribers/subscribers.css` | `frontend/src/styles/pages.css` | ADAPT | Done | Table, badge and responsive patterns ported. |
| Subscriber modal | `frontend/src/components/SubscriberModal.tsx` + `.css` | `frontend/src/features/subscribers/SubscribersPage.tsx`, `frontend/src/components/Modal.tsx` | ADAPT | Done | Modal shell and form presentation restored; request builders unchanged. |
| Subscriber trace modal | `frontend/src/components/SubscriberTraceModal.tsx` + `subscriber-trace-modal.css` | — | DO NOT PORT | Not restored | No current accepted endpoint exposes signalling trace data, so the presentation cannot be populated honestly. |
| Traffic adjustment modal | `frontend/src/components/TrafficAdjustmentModal.tsx` | `frontend/src/features/subscribers/SubscribersPage.tsx` | ADAPT | Done | Presentation restored; the routing-acknowledgement semantics of the current response are preserved and surfaced. |
| Batch create / batch update / bulk policy modals | `frontend/src/components/BatchCreateModal.tsx`, `SubscriberBatchUpdateModal.tsx`, `BulkPolicyModal.tsx` | `frontend/src/features/subscribers/SubscribersPage.tsx` | ADAPT | Done | Batch flows restored inside the page against the current batch contracts. |
| Profiles page | `frontend/src/app/(dashboard)/profile/page.tsx` | `frontend/src/features/profiles/ProfilesPage.tsx` | ADAPT | Done | Current profile contracts preserved; presentation restored. |
| Profile modal | `frontend/src/components/ProfileModal.tsx` | `frontend/src/features/profiles/ProfilesPage.tsx` | ADAPT | Done | Visual design retained; request builders unchanged. |
| Profile editors (PCC / session / slice) | `frontend/src/components/profile/*` | `frontend/src/features/profiles/ProfilesPage.tsx` | ADAPT | Done | Editor presentation folded into the current page structure; no new fields are written. |
| Profile stylesheet | `frontend/src/app/(dashboard)/profile/profile.css`, `frontend/src/components/profile/profile.css` | `frontend/src/styles/pages.css` | ADAPT | Done | Detail and section patterns ported. |
| OCS pages | `frontend/src/app/(dashboard)/ocs/**` | `frontend/src/features/ocs/**` | ADAPT | Done | Balances, contracts and tariffs keep their current contracts; presentation restored. |
| OCS shared panels and drawers | `frontend/src/components/ocs/**` | `frontend/src/features/ocs/**` | ADAPT | Done | Table, detail panel, status pill and section header presentation ported. |
| OCS stylesheet | `frontend/src/app/(dashboard)/ocs/ocs.css` | `frontend/src/styles/pages.css` | ADAPT | Done | Card, table, detail, status pill and metric layouts ported. |
| OCS balance adjustment modal | `frontend/src/components/ocs/balances/AdjustBalanceModal.tsx` | `frontend/src/features/ocs/balances/BalancesPage.tsx` | ADAPT | Done | Modal presentation restored; request payload unchanged. |
| OCS tariff plan modal | `frontend/src/components/ocs/tariffs/TariffPlanModal.tsx` | `frontend/src/features/ocs/tariffs/TariffsPage.tsx` | ADAPT | Done | Presentation restored. |
| Rating management | `frontend/src/app/(dashboard)/rating/**`, `frontend/src/components/rating/**`, `rating.css` | — | DO NOT PORT | Not restored | The current route contract redirects the rating routes; restoring the historical rating management surface would require routes and behaviour the current product does not expose. |
| System health page | `frontend/src/app/(dashboard)/system-health/page.tsx` | `frontend/src/features/system-health/SystemHealthPage.tsx` | ADAPT | Done | Operational behaviour (analytics init, scan, heal, batch heal, confirmation, partial-failure semantics, authorization, request contracts) is untouched; only presentation changed. |
| System health stylesheet | `frontend/src/app/(dashboard)/system-health/system-health.css` | `frontend/src/styles/utilities.css` | ADAPT | Done | Health card, scan strip and governed-action patterns ported. |
| Subsystem card | `frontend/src/components/health/SubsystemCard.tsx` | `frontend/src/features/system-health/SystemHealthPage.tsx` | ADAPT | Done | Card presentation ported onto current health contracts. |
| Users administration | `frontend/src/app/(dashboard)/users/**` | `frontend/src/features/users/**` | ADAPT | Done | HTTP contracts and canonical roles preserved; table and form styling restored. |
| Users CRUD hooks | `frontend/src/app/(dashboard)/users/hooks/**` | — | DO NOT PORT | Not restored | The historical hook suite duplicated state management that the current feature pages own directly; restoring it would change mutation orchestration. |
| IAM presentation primitives | `frontend/src/components/iam/**` | `frontend/src/components/ui/StatusBadge.tsx` | ADAPT | Done | Status and role presentation generalised; stale role models are not reintroduced. |
| Login surface | `frontend/src/app/login/LoginForm.tsx` + `.css` | `frontend/src/auth/LoginPage.tsx`, `frontend/src/styles/pages.css` | ADAPT | Done | Visual parity restored on the login canvas; the current Go auth flow is unchanged. |
| Root document | `frontend/src/app/layout.tsx`, `frontend/src/app/favicon.ico` | `frontend/index.html`, `frontend/public/favicon.ico` | ADAPT | Done | Document shell and repository-owned favicon restored for the Vite entry point. |
| Shared UI primitives | `frontend/src/components/ui/**` | `frontend/src/components/ui/**` | ADAPT | Done | Page header, section header, table state, pagination, dialog, field, inline notice and metric strip concepts re-expressed on the restored token set. |
| Modal stylesheet | `frontend/src/components/modals.css` | `frontend/src/styles/components.css` | PORT | Done | Modal shell, footer and form presentation ported. |

### 3.4 Retired semantics — explicitly not restored

| Historical Asset | Historical Path | Classification | Reason |
|---|---|---|---|
| Visual diff viewer | `frontend/src/components/VisualDiffViewer.tsx`, `frontend/src/components/diff-viewer.css`, `frontend/src/lib/diffEngine.ts` | DO NOT PORT | The original purpose depended on the retired approval / maker-checker flow. No current direct-operation surface uses a diff presentation. |
| Governance event timeline | `frontend/src/components/governance/**`, `frontend/src/lib/governance/display.ts` | DO NOT PORT | Belongs to the retired governance workflow. |
| Approval queue header controls | `frontend/src/app/(dashboard)/layout.css` approval selectors | DO NOT PORT | The approval queue no longer exists; the selectors were removed from the ported stylesheet rather than left dead. |
| Data hub | `frontend/src/components/DataHub.tsx`, `frontend/src/components/datahub.css` | DO NOT PORT | Its presentation maps to read/export operations that the current contract already exposes through dedicated routes; restoring it as a separate surface would require a new route. |
| Navigation guard module | `frontend/src/proxy.ts` (retired) | DO NOT PORT | A Next-era UI guard; route authorization is owned by the current auth gate and the backend. |
| Subscriber and platform type mirrors | `frontend/src/types/subscriber.ts`, `frontend/src/types/xcloud.ts`, `frontend/src/types/plmn.ts`, `frontend/src/types/platformHealth.ts` | DO NOT PORT | Historical client-side type mirrors of server models; the current pages read the accepted contract shapes directly. |
| Subscriber validation and defaults helpers | `frontend/src/lib/subscriberValidation.ts`, `frontend/src/lib/subscriberDefaults.ts` | DO NOT PORT | Historical client-side validation duplicated server validation; restoring it would create a second validation authority. |
| Miscellaneous historical helpers | `frontend/src/lib/csv.ts`, `unitParser.ts`, `imsQosPresets.js`, `soundEffects.ts`, `tariffPlanOperations.ts`, `userQuery.ts`, `userAccessManagement.ts` | DO NOT PORT | Not required by any current route or accepted operation. |

## 4. Intentional divergences

1. **Notification centre preferences.** The historical sound and desktop-notification
   preferences are not restored because no current authority exposes them. The
   presentation shell, tabs, unread badge and stream status are restored.
2. **NOC sentinel workflow controls.** Acknowledge, assign and resolve controls were
   removed. The current alert authority is read-only from the header; mutating an alert
   remains a system-health surface concern.
3. **Command palette search scope.** The historical palette searched subscribers, IMSIs
   and profiles. The restored palette searches current authorized navigation
   destinations only, because no accepted endpoint backs a global search contract.
4. **Breadcrumb recent destinations.** The historical quick-jump list required a
   persistence authority the current runtime does not expose.
5. **Rating surface.** The rating routes redirect in the current route contract, so the
   historical rating management presentation is not restored.
6. **Inventory.** Inventory has no historical equivalent. It is rendered with the
   restored shell, page header language, table/card language, forms, badges, dialogs and
   state patterns. All Stage 1 Inventory semantics are untouched.

## 5. Verification

The restoration is machine-verified by:

- `scripts/test-ui-restoration-contract.mjs` — shell component structure, header and
  sidebar composition, command palette, tab bar, breadcrumbs, theme and language
  switches, user menu, notification presentation, brand asset blob, dashboard
  presentation, Inventory integration, stylesheet architecture, Next absence, frozen
  route and registration counts, and this manifest's classification coverage.
- `frontend/tests/ui-restoration.test.ts` — shell geometry, role-aware sidebar grouping,
  navigation filtering, breadcrumb derivation, dashboard view model behaviour and
  honest unavailable states.
- The existing frontend quality gates, backend quality gates, embedded SPA hosting,
  Inventory, business contract and production architecture suites.
