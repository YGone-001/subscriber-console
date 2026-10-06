# UI Forward-Port Manifest

Generated from the reference checkout by `npm run ui:port-manifest`. Do not edit by hand:
edit the disposition rules in `scripts/generate-ui-port-manifest.mjs` and regenerate.

- Reference: `C:/Users/YGone/Desktop/subscriber-console/frontend/src` (commit 2c40903, last pure-Next.js state)
- Target: `frontend/src`
- Reference source files covered: **224**

## Dispositions

| Disposition | Meaning |
| --- | --- |
| `reuse-current` | 81 files. The current checkout already owns an equivalent; nothing is copied. |
| `forward-port` | 70 files. Historical presentation is copied and adapted during the named task. |
| `exclude` | 73 files. Intentionally not ported. Every exclusion carries one of the four reasons below. |

### Exclusion reasons

The reason vocabulary is defined once, in `scripts/lib/ui-parity-scope.mjs`, and is shared with the parity gate:

| Reason | Meaning |
| --- | --- |
| `retired` | The historical surface was deliberately retired by the brief. |
| `charging-plane` | Charging-plane rating console; outside the operator console boundary. |
| `current-runtime-replaced` | The current checkout already owns this runtime concern, or the surface is superseded by the one its route renders. |
| `unsupported-contract` | The referenced operation has no authoritative contract here and is on the absolute denylist. |

## Hard boundaries

The port preserves the current authority of `frontend/package.json`, `frontend/vite.config.ts`,
`frontend/index.html`, `frontend/src/main.tsx`, `frontend/src/app/App.tsx`, the React Router route
table, the authentication and session providers, the read and mutation clients, the Go API contracts,
the three-role RBAC model, and the Inventory feature. `npm run check:ui-forward-port-boundaries`
enforces this mechanically.

## Foundation: shared UI, style layers and shared types

Files: 84

| Reference path | Disposition | Reason | Target | Task | Note |
| --- | --- | --- | --- | --- | --- |
| `app/(dashboard)/components/AppHeader.tsx` | `reuse-current` | - | `frontend/src/app/components/AppHeader.tsx` | - | - |
| `app/(dashboard)/components/AppSidebar.tsx` | `reuse-current` | - | `frontend/src/app/components/AppSidebar.tsx` | - | - |
| `app/(dashboard)/components/NotificationCenter.tsx` | `reuse-current` | - | `frontend/src/app/components/NotificationCenter.tsx` | - | - |
| `app/(dashboard)/components/UserMenu.tsx` | `reuse-current` | - | `frontend/src/app/components/UserMenu.tsx` | - | - |
| `app/(dashboard)/layout.css` | `reuse-current` | - | `frontend/src/styles/shell.css` | - | - |
| `app/(dashboard)/ocs/ocs.css` | `reuse-current` | - | `frontend/src/styles/ocs.css` | - | - |
| `app/(dashboard)/profile/profile.css` | `reuse-current` | - | `frontend/src/styles/profile.css` | - | - |
| `app/(dashboard)/subscribers/subscribers.css` | `reuse-current` | - | `frontend/src/styles/subscribers.css` | - | - |
| `app/(dashboard)/system-health/system-health.css` | `reuse-current` | - | `frontend/src/styles/system-health.css` | - | - |
| `app/(dashboard)/users/components/UserDrawer.module.css` | `reuse-current` | - | `frontend/src/styles/modules/UserDrawer.module.css` | - | - |
| `app/(dashboard)/users/components/UsersTable.module.css` | `reuse-current` | - | `frontend/src/styles/modules/UsersTable.module.css` | - | - |
| `app/(dashboard)/users/components/UsersToolbar.module.css` | `reuse-current` | - | `frontend/src/styles/modules/UsersToolbar.module.css` | - | - |
| `app/(dashboard)/users/users.module.css` | `reuse-current` | - | `frontend/src/styles/modules/users.module.css` | - | - |
| `app/globals.css` | `reuse-current` | - | `frontend/src/styles/globals.css` | - | - |
| `app/login/LoginForm.css` | `reuse-current` | - | `frontend/src/styles/login.css` | - | - |
| `components/AnalyticsCockpit.tsx` | `reuse-current` | - | `frontend/src/components/AnalyticsCockpit.tsx` | - | - |
| `components/CommandPalette.css` | `reuse-current` | - | `frontend/src/styles/command-palette.css` | - | - |
| `components/LanguageSwitcher.tsx` | `reuse-current` | - | `frontend/src/app/components/LanguageSwitcher.tsx` | - | - |
| `components/NavigationBreadcrumbs.tsx` | `reuse-current` | - | `frontend/src/app/components/NavigationBreadcrumbs.tsx` | - | - |
| `components/NavigationTabBar.tsx` | `reuse-current` | - | `frontend/src/app/components/NavigationTabBar.tsx` | - | - |
| `components/NocSentinel.css` | `reuse-current` | - | `frontend/src/styles/noc-sentinel.css` | - | - |
| `components/NocSentinel.tsx` | `reuse-current` | - | `frontend/src/app/components/NocSentinel.tsx` | - | - |
| `components/OperationFeedback.css` | `reuse-current` | - | `frontend/src/styles/feedback.css` | - | - |
| `components/OperationFeedback.tsx` | `reuse-current` | - | `frontend/src/components/ui/OperationFeedback.tsx` | - | - |
| `components/SubscriberModal.css` | `reuse-current` | - | `frontend/src/styles/modals.css` | - | - |
| `components/ThemeSwitcher.tsx` | `reuse-current` | - | `frontend/src/app/components/ThemeSwitcher.tsx` | - | - |
| `components/analytics.css` | `reuse-current` | - | `frontend/src/styles/analytics.css` | - | - |
| `components/analytics/CountUpNumber.tsx` | `reuse-current` | - | `frontend/src/components/analytics/CountUpNumber.tsx` | - | - |
| `components/analytics/EmptyChartState.tsx` | `reuse-current` | - | `frontend/src/components/analytics/EmptyChartState.tsx` | - | - |
| `components/analytics/KpiCard.tsx` | `reuse-current` | - | `frontend/src/components/analytics/KpiCard.tsx` | - | - |
| `components/analytics/OcsBalanceCapacityCard.tsx` | `reuse-current` | - | `frontend/src/components/analytics/OcsBalanceCapacityCard.tsx` | - | - |
| `components/analytics/OcsResourceStrip.tsx` | `reuse-current` | - | `frontend/src/components/analytics/OcsResourceStrip.tsx` | - | - |
| `components/analytics/OcsSessionTelemetryCard.tsx` | `reuse-current` | - | `frontend/src/components/analytics/OcsSessionTelemetryCard.tsx` | - | - |
| `components/analytics/PlmnDistributionChart.tsx` | `reuse-current` | - | `frontend/src/components/analytics/PlmnDistributionChart.tsx` | - | - |
| `components/analytics/SkeletonDashboard.tsx` | `reuse-current` | - | `frontend/src/components/analytics/SkeletonDashboard.tsx` | - | - |
| `components/analytics/TariffPlanDistributionChart.tsx` | `reuse-current` | - | `frontend/src/components/analytics/TariffPlanDistributionChart.tsx` | - | - |
| `components/analytics/TopConsumerChart.tsx` | `reuse-current` | - | `frontend/src/components/analytics/TopConsumerChart.tsx` | - | - |
| `components/analytics/WorkbenchPanel.tsx` | `reuse-current` | - | `frontend/src/components/analytics/WorkbenchPanel.tsx` | - | - |
| `components/analytics/types.ts` | `reuse-current` | - | `frontend/src/components/analytics/types.ts` | - | - |
| `components/analytics/utils.ts` | `reuse-current` | - | `frontend/src/components/analytics/utils.ts` | - | - |
| `components/health/SubsystemCard.tsx` | `reuse-current` | - | `frontend/src/components/health/SubsystemCard.tsx` | - | - |
| `components/iam/iam.module.css` | `reuse-current` | - | `frontend/src/styles/modules/iam.module.css` | - | - |
| `components/modals.css` | `reuse-current` | - | `frontend/src/styles/modals.css` | - | - |
| `components/ocs/OcsPageShell.tsx` | `reuse-current` | - | `frontend/src/components/ocs/OcsPageShell.tsx` | - | - |
| `components/profile/profile.css` | `reuse-current` | - | `frontend/src/styles/profile.css` | - | - |
| `components/subscriber/rating-rule-link-panel.css` | `reuse-current` | - | `frontend/src/styles/subscribers.css` | - | - |
| `components/subscriber/subscriber.css` | `reuse-current` | - | `frontend/src/styles/subscribers.css` | - | - |
| `components/ui/ChartDataTable.module.css` | `reuse-current` | - | `frontend/src/styles/modules/ChartDataTable.module.css` | - | - |
| `components/ui/ChartDataTable.tsx` | `reuse-current` | - | `frontend/src/components/ui/ChartDataTable.tsx` | - | - |
| `components/ui/ConsolePrimitives.module.css` | `reuse-current` | - | `frontend/src/styles/modules/ConsolePrimitives.module.css` | - | - |
| `components/ui/DataTablePagination.module.css` | `reuse-current` | - | `frontend/src/styles/modules/DataTablePagination.module.css` | - | - |
| `components/ui/DataTablePagination.tsx` | `reuse-current` | - | `frontend/src/components/ui/DataTablePagination.tsx` | - | - |
| `components/ui/DataTableState.module.css` | `reuse-current` | - | `frontend/src/styles/modules/DataTableState.module.css` | - | - |
| `components/ui/DataTableState.tsx` | `reuse-current` | - | `frontend/src/components/ui/DataTableState.tsx` | - | - |
| `components/ui/Dialog.tsx` | `reuse-current` | - | `frontend/src/components/ui/Dialog.tsx` | - | - |
| `components/ui/Field.module.css` | `reuse-current` | - | `frontend/src/styles/modules/Field.module.css` | - | - |
| `components/ui/Field.tsx` | `reuse-current` | - | `frontend/src/components/ui/Field.tsx` | - | - |
| `components/ui/IconButton.tsx` | `reuse-current` | - | `frontend/src/components/ui/IconButton.tsx` | - | - |
| `components/ui/InlineNotice.module.css` | `reuse-current` | - | `frontend/src/styles/modules/InlineNotice.module.css` | - | - |
| `components/ui/InlineNotice.tsx` | `reuse-current` | - | `frontend/src/components/ui/InlineNotice.tsx` | - | - |
| `components/ui/MetricStrip.tsx` | `reuse-current` | - | `frontend/src/components/ui/MetricStrip.tsx` | - | - |
| `components/ui/PageHeader.tsx` | `reuse-current` | - | `frontend/src/components/ui/PageHeader.tsx` | - | - |
| `components/ui/RefreshButton.tsx` | `reuse-current` | - | `frontend/src/components/ui/RefreshButton.tsx` | - | - |
| `components/ui/SectionHeader.tsx` | `reuse-current` | - | `frontend/src/components/ui/SectionHeader.tsx` | - | - |
| `components/ui/SortableTableHeader.module.css` | `reuse-current` | - | `frontend/src/styles/modules/SortableTableHeader.module.css` | - | - |
| `components/ui/SortableTableHeader.tsx` | `reuse-current` | - | `frontend/src/components/ui/SortableTableHeader.tsx` | - | - |
| `components/ui/UnsavedChangesGuard.module.css` | `reuse-current` | - | `frontend/src/styles/modules/UnsavedChangesGuard.module.css` | - | - |
| `components/ui/UnsavedChangesGuard.tsx` | `reuse-current` | - | `frontend/src/components/ui/UnsavedChangesGuard.tsx` | - | - |
| `components/ui/chartPrimitives.tsx` | `reuse-current` | - | `frontend/src/components/ui/chartPrimitives.tsx` | - | - |
| `components/ui/useDialogFocus.ts` | `reuse-current` | - | `frontend/src/components/ui/useDialogFocus.ts` | - | - |
| `lib/auth-ui.ts` | `reuse-current` | - | `frontend/src/lib/auth-ui.ts` | - | - |
| `lib/fetcher.ts` | `reuse-current` | - | `frontend/src/lib/fetcher.ts` | - | - |
| `lib/locales.ts` | `reuse-current` | - | `frontend/src/lib/locales/locales.ts` | - | - |
| `lib/locales/en.ts` | `reuse-current` | - | `frontend/src/lib/locales/en.ts` | - | - |
| `lib/locales/zh.ts` | `reuse-current` | - | `frontend/src/lib/locales/zh.ts` | - | - |
| `lib/permissions.ts` | `reuse-current` | - | `frontend/src/lib/permissions.ts` | - | - |
| `lib/security.ts` | `reuse-current` | - | `frontend/src/lib/security.ts` | - | - |
| `lib/unitParser.ts` | `reuse-current` | - | `frontend/src/lib/unitParser.ts` | - | - |
| `lib/userManagementPolicy.ts` | `reuse-current` | - | `frontend/src/lib/userManagementPolicy.ts` | - | - |
| `types/governance.ts` | `reuse-current` | - | `frontend/src/types/governance.ts` | - | - |
| `types/iam.ts` | `reuse-current` | - | `frontend/src/types/iam.ts` | - | - |
| `types/platformHealth.ts` | `forward-port` | - | `frontend/src/types/platformHealth.ts` | T05 | Port only the shapes the ported components actually consume. |
| `types/subscriber.ts` | `forward-port` | - | `frontend/src/types/subscriber.ts` | T05 | Port only the shapes the ported components actually consume. |
| `types/xcloud.ts` | `forward-port` | - | `frontend/src/types/xcloud.ts` | T05 | Port only the shapes the ported components actually consume. |

## Shell: command palette

Files: 1

| Reference path | Disposition | Reason | Target | Task | Note |
| --- | --- | --- | --- | --- | --- |
| `components/CommandPalette.tsx` | `forward-port` | - | `frontend/src/app/components/CommandPalette.tsx` | T18 | Restore reference result grouping and geometry; keep the current router and /api/search. |

## Login and system health

Files: 1

| Reference path | Disposition | Reason | Target | Task | Note |
| --- | --- | --- | --- | --- | --- |
| `app/login/LoginForm.tsx` | `forward-port` | - | `frontend/src/auth/LoginPage.tsx` | T19 | Reference geometry for icons, fields and card; current auth flow is retained. |

## OCS domain (tariffs, contracts, balances)

Files: 11

| Reference path | Disposition | Reason | Target | Task | Note |
| --- | --- | --- | --- | --- | --- |
| `components/ocs/OcsDetailDrawer.tsx` | `forward-port` | - | `frontend/src/components/ocs/OcsDetailDrawer.tsx` | T06 | - |
| `components/ocs/balances/AdjustBalanceModal.tsx` | `forward-port` | - | `frontend/src/components/ocs/balances/AdjustBalanceModal.tsx` | T09 | - |
| `components/ocs/balances/OcsBalanceDetail.tsx` | `forward-port` | - | `frontend/src/components/ocs/balances/OcsBalanceDetail.tsx` | T09 | - |
| `components/ocs/balances/OcsBalancePlaceholder.tsx` | `forward-port` | - | `frontend/src/components/ocs/balances/OcsBalancePlaceholder.tsx` | T09 | - |
| `components/ocs/common/ConfirmDialog.tsx` | `forward-port` | - | `frontend/src/components/ocs/common/ConfirmDialog.tsx` | T06 | - |
| `components/ocs/common/OcsStatusBadge.tsx` | `forward-port` | - | `frontend/src/components/ocs/common/OcsStatusBadge.tsx` | T06 | - |
| `components/ocs/contracts/OcsContractDetail.tsx` | `forward-port` | - | `frontend/src/components/ocs/contracts/OcsContractDetail.tsx` | T08 | - |
| `components/ocs/contracts/OcsContractsPanel.tsx` | `forward-port` | - | `frontend/src/components/ocs/contracts/OcsContractsPanel.tsx` | T08 | - |
| `components/ocs/tariffs/OcsTariffDetail.tsx` | `forward-port` | - | `frontend/src/components/ocs/tariffs/OcsTariffDetail.tsx` | T07 | - |
| `components/ocs/tariffs/OcsTariffGovernancePanel.tsx` | `forward-port` | - | `frontend/src/components/ocs/tariffs/OcsTariffGovernancePanel.tsx` | T07 | - |
| `components/ocs/tariffs/TariffPlanModal.tsx` | `forward-port` | - | `frontend/src/components/ocs/tariffs/TariffPlanModal.tsx` | T07 | - |

## User management domain

Files: 30

| Reference path | Disposition | Reason | Target | Task | Note |
| --- | --- | --- | --- | --- | --- |
| `app/(dashboard)/users/components/BulkActionBar.tsx` | `forward-port` | - | `frontend/src/features/users/components/BulkActionBar.tsx` | T11 | - |
| `app/(dashboard)/users/components/BulkProgressModal.tsx` | `forward-port` | - | `frontend/src/features/users/components/BulkProgressModal.tsx` | T11 | - |
| `app/(dashboard)/users/components/PasswordResetModal.tsx` | `forward-port` | - | `frontend/src/features/users/components/PasswordResetModal.tsx` | T11 | - |
| `app/(dashboard)/users/components/PasswordStrengthBar.tsx` | `forward-port` | - | `frontend/src/features/users/components/PasswordStrengthBar.tsx` | T11 | - |
| `app/(dashboard)/users/components/UserBasicInfo.tsx` | `forward-port` | - | `frontend/src/features/users/components/UserBasicInfo.tsx` | T11 | - |
| `app/(dashboard)/users/components/UserConfirmDialogs.tsx` | `forward-port` | - | `frontend/src/features/users/components/UserConfirmDialogs.tsx` | T11 | - |
| `app/(dashboard)/users/components/UserCreateForm.tsx` | `forward-port` | - | `frontend/src/features/users/components/UserCreateForm.tsx` | T11 | - |
| `app/(dashboard)/users/components/UserDrawer.tsx` | `forward-port` | - | `frontend/src/features/users/components/UserDrawer.tsx` | T11 | - |
| `app/(dashboard)/users/components/UserEditForm.tsx` | `forward-port` | - | `frontend/src/features/users/components/UserEditForm.tsx` | T11 | - |
| `app/(dashboard)/users/components/UserLoginHistory.tsx` | `forward-port` | - | `frontend/src/features/users/components/UserLoginHistory.tsx` | T11 | - |
| `app/(dashboard)/users/components/UserPasswordResetForm.tsx` | `forward-port` | - | `frontend/src/features/users/components/UserPasswordResetForm.tsx` | T11 | - |
| `app/(dashboard)/users/components/UserPermissions.tsx` | `forward-port` | - | `frontend/src/features/users/components/UserPermissions.tsx` | T11 | - |
| `app/(dashboard)/users/components/UsernameField.tsx` | `forward-port` | - | `frontend/src/features/users/components/UsernameField.tsx` | T11 | - |
| `app/(dashboard)/users/components/UsersSummaryPanel.tsx` | `forward-port` | - | `frontend/src/features/users/components/UsersSummaryPanel.tsx` | T11 | - |
| `app/(dashboard)/users/components/UsersTable.tsx` | `forward-port` | - | `frontend/src/features/users/components/UsersTable.tsx` | T11 | - |
| `app/(dashboard)/users/components/UsersToolbar.tsx` | `forward-port` | - | `frontend/src/features/users/components/UsersToolbar.tsx` | T11 | - |
| `app/(dashboard)/users/components/types.ts` | `forward-port` | - | `frontend/src/features/users/components/types.ts` | T11 | - |
| `app/(dashboard)/users/hooks/useUserCrud.ts` | `forward-port` | - | `frontend/src/features/users/hooks/useUserCrud.ts` | T11 | Port only the presentational state hooks; the current read and mutation clients stay authoritative. |
| `app/(dashboard)/users/hooks/useUserDrawer.ts` | `forward-port` | - | `frontend/src/features/users/hooks/useUserDrawer.ts` | T11 | Port only the presentational state hooks; the current read and mutation clients stay authoritative. |
| `app/(dashboard)/users/hooks/useUserFilters.ts` | `forward-port` | - | `frontend/src/features/users/hooks/useUserFilters.ts` | T11 | Port only the presentational state hooks; the current read and mutation clients stay authoritative. |
| `app/(dashboard)/users/hooks/useUserPagination.ts` | `forward-port` | - | `frontend/src/features/users/hooks/useUserPagination.ts` | T11 | Port only the presentational state hooks; the current read and mutation clients stay authoritative. |
| `app/(dashboard)/users/hooks/useUserSelection.ts` | `forward-port` | - | `frontend/src/features/users/hooks/useUserSelection.ts` | T11 | Port only the presentational state hooks; the current read and mutation clients stay authoritative. |
| `app/(dashboard)/users/hooks/useUserSort.ts` | `forward-port` | - | `frontend/src/features/users/hooks/useUserSort.ts` | T11 | Port only the presentational state hooks; the current read and mutation clients stay authoritative. |
| `app/(dashboard)/users/hooks/useUsersPage.ts` | `forward-port` | - | `frontend/src/features/users/hooks/useUsersPage.ts` | T11 | Port only the presentational state hooks; the current read and mutation clients stay authoritative. |
| `app/(dashboard)/users/types.ts` | `forward-port` | - | `frontend/src/features/users/types.ts` | T11 | - |
| `app/(dashboard)/users/utils.ts` | `forward-port` | - | `frontend/src/features/users/utils.ts` | T11 | - |
| `components/iam/PasswordField.tsx` | `forward-port` | - | `frontend/src/components/iam/PasswordField.tsx` | T11 | - |
| `components/iam/RoleBadge.tsx` | `forward-port` | - | `frontend/src/components/iam/RoleBadge.tsx` | T11 | - |
| `components/iam/StatusBadge.tsx` | `forward-port` | - | `frontend/src/components/iam/StatusBadge.tsx` | T11 | - |
| `lib/userAccessManagement.ts` | `forward-port` | - | `frontend/src/lib/userAccessManagement.ts` | T11 | - |

## Subscriber domain

Files: 18

| Reference path | Disposition | Reason | Target | Task | Note |
| --- | --- | --- | --- | --- | --- |
| `app/(dashboard)/subscribers/components/SubscriberSummaryPanel.tsx` | `forward-port` | - | `frontend/src/features/subscribers/components/SubscriberSummaryPanel.tsx` | T15 | - |
| `app/(dashboard)/subscribers/components/SubscriberTable.tsx` | `forward-port` | - | `frontend/src/features/subscribers/components/SubscriberTable.tsx` | T15 | - |
| `app/(dashboard)/subscribers/components/SubscriberToolbar.tsx` | `forward-port` | - | `frontend/src/features/subscribers/components/SubscriberToolbar.tsx` | T15 | - |
| `app/(dashboard)/subscribers/types.ts` | `forward-port` | - | `frontend/src/features/subscribers/types.ts` | T15 | - |
| `components/BatchCreateModal.tsx` | `forward-port` | - | `frontend/src/components/BatchCreateModal.tsx` | T15 | - |
| `components/SubscriberBatchUpdateModal.tsx` | `forward-port` | - | `frontend/src/components/SubscriberBatchUpdateModal.tsx` | T15 | Owns POST /api/subscribers/batch-update, which the Go router registers. |
| `components/SubscriberModal.tsx` | `forward-port` | - | `frontend/src/components/SubscriberModal.tsx` | T15 | - |
| `components/TrafficAdjustmentModal.tsx` | `forward-port` | - | `frontend/src/components/TrafficAdjustmentModal.tsx` | T15 | - |
| `components/subscriber/RatingRuleLinkPanel.tsx` | `forward-port` | - | `frontend/src/features/subscribers/components/subscriber/RatingRuleLinkPanel.tsx` | T16 | - |
| `components/subscriber/SubscriberEditMode.tsx` | `forward-port` | - | `frontend/src/features/subscribers/components/subscriber/SubscriberEditMode.tsx` | T16 | - |
| `components/subscriber/SubscriberViewMode.tsx` | `forward-port` | - | `frontend/src/features/subscribers/components/subscriber/SubscriberViewMode.tsx` | T16 | - |
| `components/subscriber/utils.tsx` | `forward-port` | - | `frontend/src/features/subscribers/components/subscriber/utils.tsx` | T16 | - |
| `hooks/useSubscriberForm.ts` | `forward-port` | - | `frontend/src/features/subscribers/useSubscriberForm.ts` | T16 | - |
| `lib/csv.ts` | `forward-port` | - | `frontend/src/lib/csv.ts` | T15 | - |
| `lib/subscriberDefaults.ts` | `forward-port` | - | `frontend/src/features/subscribers/lib/subscriberDefaults.ts` | T15 | Port only the helpers the ported presentational components call. |
| `lib/tariffPlanOperations.ts` | `forward-port` | - | `frontend/src/features/subscribers/lib/tariffPlanOperations.ts` | T15 | Port only the helpers the ported presentational components call. |
| `lib/typeGuards.ts` | `forward-port` | - | `frontend/src/features/subscribers/lib/typeGuards.ts` | T15 | Port only the helpers the ported presentational components call. |
| `lib/xcloudSubscriber.ts` | `forward-port` | - | `frontend/src/features/subscribers/lib/xcloudSubscriber.ts` | T15 | Port only the helpers the ported presentational components call. |

## Profile domain

Files: 6

| Reference path | Disposition | Reason | Target | Task | Note |
| --- | --- | --- | --- | --- | --- |
| `components/ProfileModal.tsx` | `forward-port` | - | `frontend/src/components/ProfileModal.tsx` | T17 | - |
| `components/profile/ProfileEditMode.tsx` | `forward-port` | - | `frontend/src/features/profiles/components/ProfileEditMode.tsx` | T17 | - |
| `components/profile/ProfilePccRuleEditor.tsx` | `forward-port` | - | `frontend/src/features/profiles/components/ProfilePccRuleEditor.tsx` | T17 | - |
| `components/profile/ProfileSessionEditor.tsx` | `forward-port` | - | `frontend/src/features/profiles/components/ProfileSessionEditor.tsx` | T17 | - |
| `components/profile/ProfileSliceEditor.tsx` | `forward-port` | - | `frontend/src/features/profiles/components/ProfileSliceEditor.tsx` | T17 | - |
| `components/profile/ProfileViewMode.tsx` | `forward-port` | - | `frontend/src/features/profiles/components/ProfileViewMode.tsx` | T17 | - |

## Excluded: retired runtime, providers and retired consoles

Files: 73

| Reference path | Disposition | Reason | Target | Task | Note |
| --- | --- | --- | --- | --- | --- |
| `app/(dashboard)/layout.tsx` | `exclude` | `current-runtime-replaced` | - | - | Historical layout entry point. |
| `app/(dashboard)/ocs/balances/[imsi]/page.tsx` | `exclude` | `current-runtime-replaced` | - | - | Historical route entry. The current React Router table owns routing; any page-level composition it contained is adapted into the matching file under frontend/src/features/. |
| `app/(dashboard)/ocs/balances/page.tsx` | `exclude` | `current-runtime-replaced` | - | - | Historical route entry. The current React Router table owns routing; any page-level composition it contained is adapted into the matching file under frontend/src/features/. |
| `app/(dashboard)/ocs/contracts/[imsi]/page.tsx` | `exclude` | `current-runtime-replaced` | - | - | Historical route entry. The current React Router table owns routing; any page-level composition it contained is adapted into the matching file under frontend/src/features/. |
| `app/(dashboard)/ocs/contracts/page.tsx` | `exclude` | `current-runtime-replaced` | - | - | Historical route entry. The current React Router table owns routing; any page-level composition it contained is adapted into the matching file under frontend/src/features/. |
| `app/(dashboard)/ocs/dashboard/page.tsx` | `exclude` | `current-runtime-replaced` | - | - | Historical route entry. The current React Router table owns routing; any page-level composition it contained is adapted into the matching file under frontend/src/features/. |
| `app/(dashboard)/ocs/page.tsx` | `exclude` | `current-runtime-replaced` | - | - | Historical route entry. The current React Router table owns routing; any page-level composition it contained is adapted into the matching file under frontend/src/features/. |
| `app/(dashboard)/ocs/sessions/page.tsx` | `exclude` | `current-runtime-replaced` | - | - | Historical route entry. The current React Router table owns routing; any page-level composition it contained is adapted into the matching file under frontend/src/features/. |
| `app/(dashboard)/ocs/subscribers/page.tsx` | `exclude` | `current-runtime-replaced` | - | - | Historical route entry. The current React Router table owns routing; any page-level composition it contained is adapted into the matching file under frontend/src/features/. |
| `app/(dashboard)/ocs/tariffs/[planId]/page.tsx` | `exclude` | `current-runtime-replaced` | - | - | Historical route entry. The current React Router table owns routing; any page-level composition it contained is adapted into the matching file under frontend/src/features/. |
| `app/(dashboard)/ocs/tariffs/page.tsx` | `exclude` | `current-runtime-replaced` | - | - | Historical route entry. The current React Router table owns routing; any page-level composition it contained is adapted into the matching file under frontend/src/features/. |
| `app/(dashboard)/ocs/usage/page.tsx` | `exclude` | `current-runtime-replaced` | - | - | Historical route entry. The current React Router table owns routing; any page-level composition it contained is adapted into the matching file under frontend/src/features/. |
| `app/(dashboard)/page.tsx` | `exclude` | `current-runtime-replaced` | - | - | Historical route entry. The current React Router table owns routing; any page-level composition it contained is adapted into the matching file under frontend/src/features/. |
| `app/(dashboard)/profile/page.tsx` | `exclude` | `current-runtime-replaced` | - | - | Historical route entry. The current React Router table owns routing; any page-level composition it contained is adapted into the matching file under frontend/src/features/. |
| `app/(dashboard)/rating/page.tsx` | `exclude` | `current-runtime-replaced` | - | - | Historical route entry. The current React Router table owns routing; any page-level composition it contained is adapted into the matching file under frontend/src/features/. |
| `app/(dashboard)/rating/plans/page.tsx` | `exclude` | `current-runtime-replaced` | - | - | Historical route entry. The current React Router table owns routing; any page-level composition it contained is adapted into the matching file under frontend/src/features/. |
| `app/(dashboard)/rating/rules/page.tsx` | `exclude` | `current-runtime-replaced` | - | - | Historical route entry. The current React Router table owns routing; any page-level composition it contained is adapted into the matching file under frontend/src/features/. |
| `app/(dashboard)/roles/page.tsx` | `exclude` | `current-runtime-replaced` | - | - | Historical route entry. The current React Router table owns routing; any page-level composition it contained is adapted into the matching file under frontend/src/features/. |
| `app/(dashboard)/subscribers/page.tsx` | `exclude` | `current-runtime-replaced` | - | - | Historical route entry. The current React Router table owns routing; any page-level composition it contained is adapted into the matching file under frontend/src/features/. |
| `app/(dashboard)/system-health/page.tsx` | `exclude` | `current-runtime-replaced` | - | - | Historical route entry. The current React Router table owns routing; any page-level composition it contained is adapted into the matching file under frontend/src/features/. |
| `app/(dashboard)/users/[username]/page.tsx` | `exclude` | `current-runtime-replaced` | - | - | Historical route entry. The current React Router table owns routing; any page-level composition it contained is adapted into the matching file under frontend/src/features/. |
| `app/(dashboard)/users/create/page.tsx` | `exclude` | `current-runtime-replaced` | - | - | Historical route entry. The current React Router table owns routing; any page-level composition it contained is adapted into the matching file under frontend/src/features/. |
| `app/(dashboard)/users/page.tsx` | `exclude` | `current-runtime-replaced` | - | - | Historical route entry. The current React Router table owns routing; any page-level composition it contained is adapted into the matching file under frontend/src/features/. |
| `app/layout.tsx` | `exclude` | `current-runtime-replaced` | - | - | Historical layout entry point. |
| `app/login/page.tsx` | `exclude` | `current-runtime-replaced` | - | - | Historical route entry. The current React Router table owns routing; any page-level composition it contained is adapted into the matching file under frontend/src/features/. |
| `components/BulkPolicyModal.tsx` | `exclude` | `unsupported-contract` | - | - | Its mutation is on the project absolute denylist, so the surface must not be ported. |
| `components/DataHub.tsx` | `exclude` | `retired` | - | - | Retired data hub surface. |
| `components/GlobalErrorBoundary.tsx` | `exclude` | `current-runtime-replaced` | - | - | The current providers own runtime state, data fetching, theming and errors. |
| `components/I18nProvider.tsx` | `exclude` | `current-runtime-replaced` | - | - | The current providers own runtime state, data fetching, theming and errors. |
| `components/NotificationProvider.tsx` | `exclude` | `current-runtime-replaced` | - | - | The current providers own runtime state, data fetching, theming and errors. |
| `components/RatingManagementPage.tsx` | `exclude` | `charging-plane` | - | - | Charging-plane rating console is outside the current OCS boundary. |
| `components/SWRProvider.tsx` | `exclude` | `current-runtime-replaced` | - | - | The current providers own runtime state, data fetching, theming and errors. |
| `components/SubscriberTraceModal.tsx` | `exclude` | `retired` | - | - | Signalling trace capture has no current authoritative API contract. |
| `components/ThemeProvider.tsx` | `exclude` | `current-runtime-replaced` | - | - | The current providers own runtime state, data fetching, theming and errors. |
| `components/ToastContainer.tsx` | `exclude` | `current-runtime-replaced` | - | - | The current providers own runtime state, data fetching, theming and errors. |
| `components/VisualDiffViewer.tsx` | `exclude` | `retired` | - | - | Retired visual diff surface. |
| `components/datahub.css` | `exclude` | `retired` | - | - | Retired data hub surface. |
| `components/diff-viewer.css` | `exclude` | `retired` | - | - | Retired visual diff surface. |
| `components/governance/EventTimeline.tsx` | `exclude` | `retired` | - | - | Retired governance/approval surface. |
| `components/governance/governance.module.css` | `exclude` | `retired` | - | - | Retired governance/approval surface. |
| `components/ocs/OcsBalancesPanel.tsx` | `exclude` | `current-runtime-replaced` | - | - | Superseded: the /ocs/balances route renders OcsBalancePlaceholder. |
| `components/ocs/OcsSessionsPanel.tsx` | `exclude` | `current-runtime-replaced` | - | - | No current route or API contract for sessions/usage panels. |
| `components/ocs/OcsSubscribersPanel.tsx` | `exclude` | `current-runtime-replaced` | - | - | Superseded by the contract panel the /ocs/contracts route renders. |
| `components/ocs/OcsTariffsPanel.tsx` | `exclude` | `current-runtime-replaced` | - | - | Superseded: the /ocs/tariffs route renders OcsTariffGovernancePanel. |
| `components/ocs/OcsUsagePanel.tsx` | `exclude` | `current-runtime-replaced` | - | - | No current route or API contract for sessions/usage panels. |
| `components/rating/PccRuleList.tsx` | `exclude` | `charging-plane` | - | - | Charging-plane rating console is outside the current OCS boundary. |
| `components/rating/RatingManagementShared.tsx` | `exclude` | `charging-plane` | - | - | Charging-plane rating console is outside the current OCS boundary. |
| `components/rating/RatingModals.tsx` | `exclude` | `charging-plane` | - | - | Charging-plane rating console is outside the current OCS boundary. |
| `components/rating/TariffPlanCloneModal.tsx` | `exclude` | `charging-plane` | - | - | Charging-plane rating console is outside the current OCS boundary. |
| `components/rating/TariffPlanImportModal.tsx` | `exclude` | `charging-plane` | - | - | Charging-plane rating console is outside the current OCS boundary. |
| `components/rating/TariffPlanList.tsx` | `exclude` | `charging-plane` | - | - | Charging-plane rating console is outside the current OCS boundary. |
| `components/rating/TariffRuleModal.tsx` | `exclude` | `charging-plane` | - | - | Charging-plane rating console is outside the current OCS boundary. |
| `components/rating/hooks/useRatingManagement.tsx` | `exclude` | `charging-plane` | - | - | Charging-plane rating console is outside the current OCS boundary. |
| `components/rating/rating.css` | `exclude` | `charging-plane` | - | - | Charging-plane rating console is outside the current OCS boundary. |
| `components/rating/types.tsx` | `exclude` | `charging-plane` | - | - | Charging-plane rating console is outside the current OCS boundary. |
| `components/subscriber-trace-modal.css` | `exclude` | `retired` | - | - | Signalling trace capture has no current authoritative API contract. |
| `hooks/useAuth.ts` | `exclude` | `current-runtime-replaced` | - | - | The current authentication and session providers own identity and capability state. |
| `hooks/usePermissions.ts` | `exclude` | `current-runtime-replaced` | - | - | The current authentication and session providers own identity and capability state. |
| `lib/api/ocs/index.ts` | `exclude` | `current-runtime-replaced` | - | - | The current read client and mutation client own the Go contract. |
| `lib/api/ocs/ocsContractApi.ts` | `exclude` | `current-runtime-replaced` | - | - | The current read client and mutation client own the Go contract. |
| `lib/api/ocs/ocsTariffApi.ts` | `exclude` | `current-runtime-replaced` | - | - | The current read client and mutation client own the Go contract. |
| `lib/api/users.ts` | `exclude` | `current-runtime-replaced` | - | - | The current read client and mutation client own the Go contract. |
| `lib/diffEngine.ts` | `exclude` | `retired` | - | - | Retired visual diff surface. |
| `lib/governance/display.ts` | `exclude` | `retired` | - | - | Retired governance/approval surface. |
| `lib/navigationPrefetch.ts` | `exclude` | `current-runtime-replaced` | - | - | Historical navigation table; frontend/src/lib/navigation.ts is authoritative. |
| `lib/navigationRoutes.ts` | `exclude` | `current-runtime-replaced` | - | - | Historical navigation table; frontend/src/lib/navigation.ts is authoritative. |
| `lib/soundEffects.ts` | `exclude` | `retired` | - | - | Non-essential audio surface. |
| `lib/subscriberValidation.ts` | `exclude` | `current-runtime-replaced` | - | - | Subscriber validation is owned by the current Inventory validation and the Go API. |
| `lib/userQuery.ts` | `exclude` | `current-runtime-replaced` | - | - | The current users surface keeps query state in the URL through the router. |
| `proxy.ts` | `exclude` | `current-runtime-replaced` | - | - | Historical Node API proxy. The Go service owns the production API surface. |
| `types/audit.ts` | `exclude` | `retired` | - | - | Retired user-facing audit console type. |
| `types/ocs.ts` | `exclude` | `current-runtime-replaced` | - | - | The ported OCS features declare the shapes they consume. |
| `types/plmn.ts` | `exclude` | `current-runtime-replaced` | - | - | The PLMN record shape is declared by the ported subscribers feature. |

## Verification

```bash
npm run ui:port-manifest          # regenerate; fails if any reference file is unclassified
npm run check:ui-forward-port-boundaries
```
