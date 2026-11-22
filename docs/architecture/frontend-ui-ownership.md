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
   owned by their presentation domains. The application shell imports global
   stylesheets; domain components import their scoped CSS modules.

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

- Every page-level view switch is the shared `ViewSwitch`. The established
  operations pages persist the active value through `useOperationsUrlState`;
  the configuration and investigation surfaces use their domain URL bindings
  described below. A page never draws its own switch markup or a second set of
  switch styles.
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

## Subscribers list state and navigation

`SubscribersPage` separates four state classes and does not let them leak into
each other:

| Class | Owner | Examples |
|---|---|---|
| Persistent list query | Browser URL through `useSubscriberListQuery` | page, size, sort, filters, profile drill-down |
| Transient interaction | Page-local state | search draft, invalid-input warning, open menu, copied IMSI, feedback |
| Selection | `useSubscriberSelection`, memory only | selected IMSIs, select-all, partial count |
| Mutation workflow | The owning dialog/action | delete confirmation, import, batch update, profile preview/apply, traffic adjustment |

The canonical Subscribers list URL is explicit and stable:

| Query parameter | Default | Accepted values / rule |
|---|---|---|
| `page` | `1` | Positive integer up to 1,000,000; zero, negatives, fractions and oversized values degrade to 1 |
| `size` | `10` | `10`, `20` or `50`; anything else degrades to 10 |
| `sort` | `imsi` | `status`, `imsi`, `policy`, `usage`, `lastActive` |
| `order` | `asc` | `asc` or `desc` |
| `access` | absent (`all`) | `active`, `restricted` |
| `contract` | absent (`all`) | `active`, `suspended`, `terminated`, `none` |
| `provisioning` | absent (`all`) | `complete`, `incomplete`, `missing_contract`, `missing_balance`, `missing_plan` |
| `plan` | absent | Trimmed plan id, at most 128 characters, no whitespace or control characters |
| `balance` | absent (`all`) | `exhausted`, `low`, `normal`, `available`, `missing` |
| `profile` | absent | Trimmed template name, at most 200 characters, no control characters |

Default values are omitted, so equivalent states serialize to the same URL.
Parsing never throws: unsupported values degrade to the documented default,
unknown parameters are dropped, and the canonical state is installed with
`replaceState` so a hand-edited link does not add history. A real filter, sort,
page-size or page transition is one `pushState` update. Any non-page change
resets `page` to 1 inside that same transition; the UI never navigates to page N
of a new filter and then corrects itself. `profile` is an ordinary list filter:
the template drill-down, its filter meaning, the clear action and `returnTo`
navigation all survive Back/Forward.

The search draft is deliberately **not** in the URL. A search term can be an
IMSI or MSISDN, so persisting it would place a subscriber identifier in browser
history, shared links and diagnostics. The editable draft, the debounced
committed term, the last valid term and the effective API query are distinct:

- invalid drafts show the existing warning and issue no API search;
- the last valid term stays effective until a valid term replaces it;
- a search change resets pagination with `replaceState`, never one history entry
  per keystroke;
- the URL never echoes search back into the input, so a late navigation cannot
  overwrite a newer draft.

The API mapping is owned by `buildSubscriberListApiUrl`: `size` → `limit`,
`sort` → `sortField`, `order` → `sortDirection`, `access` → `status`,
`contract` → `contractStatus`, `plan` → `planId`, `balance` → `balanceStatus`;
the row projection keeps `detail=true` and `searchBy=auto`. No URL value is
forwarded without validation.

Selection belongs to a query scope containing the raw search draft, filters,
sort, order, size and profile, but not page. Filter/sort/size/profile/search
changes therefore invalidate selection immediately, while pagination preserves
the established selection behavior. Selection is never serialized. While
`keepPreviousData` displays rows from a previous query, the page states that
they are provisional, refuses new selections and refuses row, toolbar and
queued workflow actions until the active URL is confirmed by a successful read.
Pending delete, batch update, profile apply and traffic adjustment targets are
closed when the query scope changes, and a queued destructive action carries the
scope it was created under.

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

## Configuration drift integration

Configuration drift extends the existing operations console and its tokens.
It adds no SPA route or separate visual system.

| Surface | Domain owner | Shared presentation |
|---|---|---|
| `/nf-alerts?view=config`, including `driftAlertId` detail | `features/config-drift/ConfigDriftWorkspace.tsx`, selected by `NfAlertsPage` | `OperationsPageFrame` and its `PageHeader`, `ViewSwitch`, `MetricStrip`, `Field`, `Dialog`, `CursorPagination`, `StatePanel`, `OperationFeedback` |
| Drift policy within `/config-snapshots/:sourceId` | `features/config-drift/DriftPolicyPanel.tsx`, hosted by `ConfigSnapshotsPage` | `Field`, `StatePanel`, `OperationFeedback`, `UnsavedChangesGuard`; the source page retains its `PageHeader` |
| Notification subject and source filters | Existing `features/nf-alerts/NotificationSettingsDialog.tsx` | `Dialog`, `Field`, `OperationFeedback`; NF and configuration subjects use the same channel and escalation UI |
| Configuration investigation anchor and directory category | Existing `features/investigations/InvestigationsPage.tsx` and `investigation-model.ts` | `OperationsPageFrame`, `Field`, `CursorPagination` and the existing investigation presentations |

The drift workspace binds `view`, its filters and list `cursor` directly with
React Router `useSearchParams`. Detail identity uses `driftAlertId`; event and
delivery pagination use independent `eventCursor` and `deliveryCursor` values.
Submitting filters drops the list cursor. Detail links carry the list URL in
`returnTo`, which the shared return-to resolver restricts to `/nf-alerts`.
The existing NF views retain `useOperationsUrlState`.

Investigation links use `anchorKind=config_drift` and `anchorId`, while legacy
NF links keep `alertId`. The directory keeps `q`, `status`, `anchorKind` and
`cursor` in the URL. Its filter form is keyed by the URL filter values so reset
and browser history restore the visible controls as well as the read query.
Configuration comparisons reuse the source page's `view=diff`, `left` and
`right` parameters, with the episode's fixed baseline and evidence versions.

`frontend/src/lib/api/use-bounded-read.ts` owns the shared `useBoundedRead`
SWR fetcher. It uses the existing signal-aware read client and scopes shared
request ownership to the SWR cache and key. StrictMode effect replays and other
active consumers preserve a deduplicated request; leaving the last consumer
cancels it after a microtask. A replacement read cancels its earlier request.
Cancellation must settle: an aborted fetcher resolves to the cache value already
held for that key (or no value when the cache is empty), never to a retained
never-settling Promise and never to an error. The hook disables the SWR dedupe
window so a remount can fetch a key whose cancelled read settled without data.
The cancellation itself is preserved by the read client, including cancellation
while the response body is being parsed.
`npm --prefix frontend run acceptance:bounded-read` verifies single-consumer,
shared-key, last-consumer, remount, refetch, rapid key transition, and
abort-then-HTTP-failure states against an owned Vite development fixture.
Previous-key data, focus revalidation and automatic error retries are disabled;
polling is explicit per caller.
`features/investigations/use-investigation-read.ts` keeps
`useInvestigationRead` as a compatibility re-export of this hook.
Drift presentations suppress cached scope evidence on failed reads; the policy
editor preserves its draft and requires an explicit current-revision retry
after a conflict.

`styles/modules/config-drift.module.css` owns the drift-specific presentation
and uses the existing token variables. User-facing drift copy belongs to the
existing bilingual locale layer through `lib/locales/config-drift.ts` and the
English and Chinese locale exports.

## Shared overlay interaction contract

`frontend/src/components/ui/Dialog.tsx` and
`frontend/src/components/ui/useDialogFocus.ts` are the single interaction
authority for modal surfaces. `frontend/src/components/Modal.tsx` is a
compatibility adapter over the same contract; it is not a second authority.

| Concern | Contract |
|---|---|
| Dismissal | `closeOnOverlay` and `closeOnEscape` are independent policies. A blocked topmost overlay consumes Escape without invoking `onClose` and never passes it to an underlying dialog. |
| Focus | Initial focus enters the topmost dialog (explicit ref, then the first eligible control, then the dialog surface). Tab and Shift+Tab wrap inside the topmost dialog; keyboard focus that drifted behind it is pulled back. Disabled, hidden, inert and non-rendered controls are excluded. |
| Restoration | Closing restores focus to the trigger while it is still valid; a removed trigger (route transition, refreshed list) falls back to the remaining topmost dialog instead of focusing a detached node. |
| Background isolation | Sibling isolation is reference counted per element, and every overlay also locks the layers below it in the overlay stack. When a nested child dialog mounts, the layers below it are made inert. Child overlays triggered from within an existing overlay MUST use `portal={true}` so the child mounts into an independent body-level host; rendering a child dialog directly inside an inert parent layer would cause the active child to inherit `inert` from its ancestor. The final release restores the original `inert`, `aria-hidden` and body `overflow` exactly once. |
| Stacking | Inline overlays keep their existing CSS `z-index`. Opt-in portals mount into a per-dialog body-level host (`data-xcloud-overlay-portal`) with a deterministic monotonic level, so a child always paints above its parent. React context, theme and localisation are preserved by `createPortal`. |
| Portal hosts | One host per portal dialog, removed with that dialog. There is no parallel application root or second provider tree. |

Portal use is opt-in (`portal` on `Dialog` / `Modal`), and is required for nested
overlays / child confirmation dialogs (such as governed runtime bootstrap and
notification channel/escalation/delivery confirmations) to guarantee that the
topmost active dialog never inherits `inert` from an underlying parent layer.
Remaining standalone overlays keep their inline position unless they require
body-level breakout.

## Rules for new UI work

- A new page starts from `PageHeader`, `MetricStrip`, the shared pagination and
  data-state primitives, `Dialog`, and `OperationFeedback`.
- Add a domain component only when the vocabulary is domain-specific (status,
  invariant, lifecycle). Do not create a second generic pagination, sort
  header, dialog, empty state or error state.
- No component imports a global stylesheet directly; the application shell
  imports global domain stylesheets, while domain components import their
  owned CSS modules.
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

## Scheduled inspection workspace

The inspection domain reuses OperationsPageFrame, the shared navigation, fields,
status feedback, pagination and unsaved-draft guards. It reuses the existing
Inventory resource picker rather than interpreting names as resource identities.
Its fixed evidence and scope components live in features/inspections; presentation
lives in styles/modules/inspections.module.css and consumes existing semantic
tokens. The shared bounded-read hook accepts a data-dependent refresh interval so
active run polling stops at a terminal state, preserving its existing cancellation
and StrictMode ownership. Inspection alert links extend investigation return
context only to the inspection run route; existing alert anchors are unchanged.

## NF Health workspace ownership

The NF Health list surface (`/nf-health`) is one orchestration owner plus four
presentation components. The split is a composition change only: no endpoint,
request shape, evidence semantic or permission changed with it.

| File | Owns | Never does |
|---|---|---|
| `features/nf-health/NfHealthPage.tsx` | The authoritative read lifecycle (one request token, one abort controller per read pair), the 30s polling and visibility policy, the URL state contract and cursor walk, the full-population KPI projection, the KPI-as-filter mapping, and the governed manual collection mutation | Render card/table/matrix markup, own a second read for a sub-view |
| `features/nf-health/NfHealthTargetCards.tsx` | The domain-grouped card wall: identity, NF type, L1/L2/L3 evidence, runtime utilization, last measurement, drawer opening and detail links | Fetch, poll, sort, interpret raw telemetry, own URL filters |
| `features/nf-health/NfHealthTargetsTable.tsx` | The audit table columns, the legacy-identity label, the freshness and collection-outcome cells, and the authorization-driven collection action | Issue a second list read, grant a mutation through visibility |
| `features/nf-health/NfHealthInterfaceMatrix.tsx` | The server-published interface columns, one cell per returned family, and the matrix detail links | Synthesize a row or column, infer protocol health from a metrics response |
| `features/nf-health/NfHealthFilterToolbar.tsx` | The search draft form and the seven URL filters, as intents reported to the page | Write the URL, start a request, keep its own filter registry |
| `features/nf-health/nf-health-badges.tsx` | The single badge vocabulary shared by all three views (overall state, freshness, layer coverage, matrix cell, utilization bar) | Decide health, compute freshness, fill a missing value |

Rules that hold across the split:

- **One read owner.** The page issues the list-or-matrix read and the
  full-population summary read together, with one token and one abort
  controller. A sub-view never issues its own list request, and the card wall,
  table and matrix all consume the same response.
- **Server order is preserved.** Domain grouping partitions the received
  sequence; it never re-sorts it. The default order stays the server-defined
  risk order.
- **KPI scope is the full collection.** `MetricStrip` values come from the
  operations summary health section, never from the visible page arrays. A
  summary that is not complete degrades every KPI to an explicit unavailable
  value rather than to a zero.
- **Polling stays single.** Exactly one 30s interval exists while the list route
  is mounted; it is suppressed while the tab is hidden, revalidates once on
  visibility restoration, skips cursor walks, and is cleared on unmount.
- **URL state has one registry.** `useOperationsUrlState` with
  `HEALTH_URL_KEYS` owns `view`, `q`, `enabled`, `domain`, `state`, `layers`,
  `freshness`, `collection`, `sort` and `cursor`. The toolbar reports intents.
  A filter change drops the cursor in the same transition, and the legacy
  `state=enabled` / `state=disabled` aliases keep their collection-state meaning.
- **Search keeps the accepted draft rule.** `committedSearchRef` records the term
  the page itself committed, so a late self-initiated URL echo cannot overwrite a
  newer draft while external URL changes still flow into the input.
- **Evidence vocabulary is single-sourced.** `nf-health-badges.tsx` renders every
  list badge, so a layer that was never measured cannot read as healthy in one
  view and unknown in another.

Verification: `frontend/tests/nf-health-workspace.test.tsx` pins each component's
rendering contract, `scripts/test-nf-health-ui-contract.mjs` asserts the
list-surface invariants against the union of these files, and
`npm --prefix frontend run acceptance:nf-health-workspace` proves the browser
behaviour against the production build.

## Topology workspace ownership

`/topology` keeps one orchestration owner and one owner per concern. The split is
a composition change: no endpoint, relationship type, evidence semantic or
permission changed with it.

| File | Owns | Never does |
|---|---|---|
| `features/topology/TopologyPage.tsx` | The three-mode navigation contract and the graph evidence source (through `useTopologyViewState` and `useOperationsUrlState`), the ledger query's URL state, the Inventory endpoint directory, and the composition of toolbar, body and workflows | Read the ledger itself, page it, or submit a mutation |
| `features/topology/use-topology-ledger.ts` | The ledger read lifecycle: request token, abort, returned page, pagination metadata, read time, cursor walk, and the query identity that invalidates the cursor trail | Write the URL, choose the view, or mutate |
| `features/topology/use-topology-edge-workflows.ts` | The create/edit/retire state machines: target capture, revision binding, in-flight state, validation and conflict feedback | Name a transport, navigate, or retry a conflict |
| `features/topology/components/TopologyLedgerToolbar.tsx` | The relationship/lifecycle selects, the endpoint pickers behind their disclosure, the active-filter chips and the read-time chip | Own query state, write the URL, or start a read |
| `features/topology/components/TopologyLedgerPanel.tsx` | The four exclusive ledger states (failed read, first read in flight, no rows, rows) and the cursor pager | Fetch, page on its own, or turn a failed read into an empty ledger |
| `features/topology/components/TopologyEdgeWorkflowDialogs.tsx` | The three governed dialogs and the revision-conflict banner | Submit without an explicit action |
| `features/topology/components/TopologyEdgeTable.tsx` | The relationship table, also the accessible equivalent of the one-hop graph | Own a request |

Rules that hold across the split:

- **One ledger read owner.** The page decides which view is active; the ledger
  hook reads only when that view is the ledger. A superseded read is aborted and
  its result dropped, so a slow earlier response can never overwrite a newer one,
  and a failed read is reported as a failure rather than as an empty ledger.
- **One URL registry.** `useTopologyViewState` owns `view`, `source`, `scope` and
  `cursor`; `useOperationsUrlState` owns the ledger filters. Legacy aliases
  (`view=actual`, `view=runtime`, `view=relationships`, `source=reference`) stay
  readable and are canonicalised on mount. A filter change drops the cursor, and a
  cursor belongs to exactly one query identity.
- **Targets are captured, never looked up.** A workflow binds the edge it was
  opened with, including its revision. A later query or view change cannot
  substitute another relationship, and a revision conflict is surfaced with an
  explicit reload instead of being retried.
- **The transport stays named in the page.** The workflow owner receives the three
  governed operations, so the page remains the single module that wires them and
  the frozen request contract keeps pointing at real code.
- **Evidence stays separated.** A declared relationship is an operator decision, a
  runtime configured link is observed configuration evidence, and the reference
  architecture is an illustration. The ledger never presents configured evidence
  as a declaration, and no surface infers a protocol connection from a discovered
  process or a configuration endpoint.

Verification: `frontend/tests/topology-ledger.test.tsx` pins the query identity,
the cursor walk, the failure classification and both presentation contracts,
`scripts/test-topology-ui-contract.mjs` asserts the ledger invariants against the
union of these files, and
`npm --prefix frontend run acceptance:topology-workspace` proves the browser
behaviour - including an out-of-order read, the three governed mutations, a 409
conflict and a read-only session - against the production build.
