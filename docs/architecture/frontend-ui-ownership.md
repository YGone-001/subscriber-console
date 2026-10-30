# Frontend UI Ownership

Status: active policy for the business console surfaces.

## Layers

1. **Design tokens** — `frontend/src/styles/tokens.css`, `base.css`, `shell.css`.
   No component may introduce hardcoded `#hex`, `rgb()`, `rgba()` or spacing
   values; use the token variables.
2. **Shared primitives** — `frontend/src/components/ui/*`:
   `PageHeader`, `MetricStrip`, `ViewSwitch`, `DataTablePagination`,
   `DataTableState`, `SortableTableHeader`, `Dialog`, `Field`, `RefreshButton`,
   `SectionHeader`, `OperationFeedback`, `StatePanel`, `UnsavedChangesGuard`,
   chart primitives.
3. **Domain presentations** — `components/ocs/*`, `components/analytics/*`,
   `features/subscribers/*`, `features/profiles/*`, `features/retention/*`.
   They compose shared primitives and add domain-specific badges, toolbars,
   table cells and detail layouts.
4. **Domain stylesheets** — `styles/ocs.css`, `styles/subscribers.css`,
   `styles/pages.css` and the CSS modules under `styles/modules/`. These are
   imported by the application shell; components do not import stylesheets
   directly.

## Current OCS ownership

The OCS surfaces compose the shared primitives where the primitive exists:

| Surface | Shared primitives |
|---|---|
| OCS page shell | `PageHeader`, `RefreshButton` |
| Contract / balance / tariff lists | `MetricStrip`, `DataTablePagination`, `DataTableState`, `SortableTableHeader` |
| All OCS dialogs | `Dialog` (through `ConfirmDialog` or the dialog-specific form) |
| OCS feedback / empty states | `OperationFeedback` where the generic feedback contract fits; OCS-specific detail states remain domain-local |

## Current operations ownership

The operations surfaces compose the same primitives as the rest of the console:

| Surface | Shared primitives |
|---|---|
| Operations page frame | `OperationsPageFrame` (one title, one refresh entry) |
| In-page views (`/`, `/inventory`, `/topology`, `/discovery`, `/nf-health`, `/nf-alerts`) | `ViewSwitch` |
| Operations KPI rows | `MetricStrip` `cards` variant with the shared scope detail |
| List states / dialogs / feedback | `OperationFeedback`, `StatePanel`, `Dialog`, `Field` |

- Every page-level view switch is the shared `ViewSwitch`; the active value is
  persisted in the URL by `useOperationsUrlState`. A page never draws its own
  switch markup or a second set of switch styles.
- The topology workspace additionally exposes an evidence-source switch and a
  runtime-scope switch inside its graph bar. Both reuse the same primitive and
  are evidence selectors for the running graph, not a second navigation level.
- A page-scoped count is never shown in a KPI card. Missing summary counts are
  rendered as unavailable through the shared detail helper; the scope tag
  states that the number describes the full collection.
- The legacy `view=list` value remains readable for `/inventory`, but the
  switch never emits it: the visible ledger option always writes `view=assets`.

Domain-specific OCS components are intentional:

- `OcsStatusBadge` and `OcsInvariantBadge` encode lifecycle and conservation
  semantics that no other surface owns.
- `OcsToolbar` preserves the shared search/filter/reset vocabulary used by all
  three OCS lists.
- `OcsDetailState` adds the back-to-list action and forbidden/not-found
  semantics used by OCS details.
- The table markup stays local because the shared layer owns sorting,
  pagination and state rows, not a generic table renderer.

## Why `ocs.css` is not split piecemeal

`styles/ocs.css` is a **shared business stylesheet**, not an OCS-page-only
stylesheet. Its classes are consumed by:

- `components/analytics/OcsHealthPanel.tsx`,
  `components/analytics/TariffPlanDistributionChart.tsx`,
  `components/analytics/SkeletonDashboard.tsx`, `components/AnalyticsCockpit.tsx`
- `components/TrafficAdjustmentModal.tsx`
- `features/subscribers/components/subscriber/SubscriberViewMode.tsx`,
  `features/subscribers/SubscriberDetailPage.tsx`
- `features/profiles/components/ProfileViewMode.tsx`,
  `features/profiles/components/ProfileEditMode.tsx`,
  `features/profiles/ProfileDetailPage.tsx`
- `features/retention/RetentionPage.tsx`

Moving only the OCS components to a CSS module would force duplicate
definitions for every shared class or leave those consumers pointing at a
stylesheet with no owner. A correct split must migrate **all consumers in one
pass**; that is a visual-system project, not an OCS-page refactor. Until then,
`ocs.css` stays the shared business layer and new surfaces may compose its
existing classes rather than introduce a second table/toolbar vocabulary.

## Rules for new UI work

- A new page starts from `PageHeader`, `MetricStrip`, the shared pagination and
  data-state primitives, `Dialog`, and `OperationFeedback`.
- Add a domain component only when the vocabulary is domain-specific (status,
  invariant, lifecycle). Do not create a second generic pagination, sort
  header, dialog, empty state or error state.
- No component imports a global stylesheet directly; the application shell
  imports the domain stylesheets and CSS modules.
- UI changes keep the shared primitives' `aria-*`, focus and keyboard behavior.
- Render-level tests pin OCS shared components (`ocs-shared-components.test.tsx`)
  and source guardrails pin the primitive composition and stylesheet ownership
  (`ui-primitives.test.ts`).

## Deferred follow-up

When the analytics, subscriber, profile and retention surfaces migrate their
own styles to CSS modules, `ocs.css` can be split in the same pass. That split
must preserve the current class vocabulary during the migration and delete the
global sheet only after every consumer has moved. It is not a prerequisite for
the business console's functional acceptance.
