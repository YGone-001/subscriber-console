/*
 * SPA route table.
 *
 * Business pages are declared as `route.lazy` loaders so the entry bundle only
 * carries the shell, the authentication boundary and the login surface. Each
 * loader uses a literal dynamic import path, which lets Vite derive the module
 * graph at build time and emit one chunk per page module (shared modules land in
 * a chunk both routes reference).
 *
 * The route inventory itself stays owned by `APP_ROUTES` in `lib/navigation.ts`:
 * this table only maps an existing canonical pattern to its module. Redirect
 * aliases keep rendering `<Navigate>` and never load a page module.
 *
 * `router.tsx` consumes this table and nothing else, so the table can be
 * imported by tests that need route resolution without a DOM.
 */
import type { ComponentType } from 'react';
import { Navigate, type RouteObject } from 'react-router-dom';
import { AppShell } from '../app/AppShell';
import { NotFoundPage } from '../app/NotFoundPage';
import { InitialRouteFallback, RouteLoadError } from '../app/RouteLoadState';
import { AuthGate } from '../auth/AuthGate';
import { LoginPage } from '../auth/LoginPage';
import { APP_ROUTES } from '../lib/navigation';
import { COMPATIBILITY_REDIRECTS } from './redirects';

/** The shape `route.lazy` resolves to. */
type LazyRouteModule = { Component: ComponentType };

/** A `route.lazy` loader. */
export type LazyRouteLoader = () => Promise<LazyRouteModule>;

/**
 * Bind a literal dynamic import to one named export.
 *
 * The generic keeps the export name checked at compile time: a renamed or
 * removed page export fails `tsc`, not the browser.
 */
function lazyPage<TModule extends Record<string, unknown>>(
  load: () => Promise<TModule>,
  exportName: Extract<keyof TModule, string>,
): LazyRouteLoader {
  return async () => {
    const module = await load();
    const Component = module[exportName];
    if (typeof Component !== 'function') {
      throw new Error(`route module does not export a component named "${exportName}"`);
    }
    return { Component: Component as ComponentType };
  };
}

/**
 * Page module per canonical route pattern.
 *
 * Patterns absent from this map are compatibility aliases (redirects) or the
 * login surface; both are declared directly in the route table below.
 */
export const ROUTE_LAZY_PAGES: Partial<Record<string, LazyRouteLoader>> = {
  /* Core and common pages */
  '/': lazyPage(() => import('../features/read/ReadPages'), 'DashboardPage'),
  '/system-health': lazyPage(() => import('../features/system-health/SystemHealthPage'), 'SystemHealthPage'),
  '/subscribers': lazyPage(() => import('../features/subscribers/SubscribersPage'), 'SubscribersPage'),
  '/subscribers/new': lazyPage(() => import('../features/subscribers/SubscriberDetailPage'), 'SubscriberDetailPage'),
  '/subscribers/:imsi': lazyPage(() => import('../features/subscribers/SubscriberDetailPage'), 'SubscriberDetailPage'),
  '/profile': lazyPage(() => import('../features/profiles/ProfilesPage'), 'ProfilesPage'),
  '/profile/new': lazyPage(() => import('../features/profiles/ProfileDetailPage'), 'ProfileDetailPage'),
  '/profile/:name': lazyPage(() => import('../features/profiles/ProfileDetailPage'), 'ProfileDetailPage'),

  /* OCS */
  '/ocs/balances': lazyPage(() => import('../features/ocs/balances/BalancesPage'), 'BalancesPage'),
  '/ocs/balances/:imsi': lazyPage(() => import('../features/ocs/balances/BalanceDetailPage'), 'BalanceDetailPage'),
  '/ocs/contracts': lazyPage(() => import('../features/ocs/contracts/ContractsPage'), 'ContractsPage'),
  '/ocs/contracts/:imsi': lazyPage(() => import('../features/ocs/contracts/ContractDetailPage'), 'ContractDetailPage'),
  '/ocs/tariffs': lazyPage(() => import('../features/ocs/tariffs/TariffsPage'), 'TariffsPage'),
  '/ocs/tariffs/:planId': lazyPage(() => import('../features/ocs/tariffs/TariffDetailPage'), 'TariffDetailPage'),

  /* Network operations */
  '/inventory': lazyPage(() => import('../features/inventory/InventoryPage'), 'InventoryPage'),
  '/inventory/assets': lazyPage(() => import('../features/inventory/InventoryAssetsPage'), 'InventoryAssetsPage'),
  '/inventory/runtime': lazyPage(() => import('../features/inventory/InventoryRuntimePage'), 'InventoryRuntimePage'),
  '/inventory/groups': lazyPage(() => import('../features/groups/GroupsPage'), 'GroupsPage'),
  '/inventory/:resourceId': lazyPage(() => import('../features/inventory/InventoryDetailPage'), 'InventoryDetailPage'),
  '/inventory/create': lazyPage(() => import('../features/inventory/InventoryCreatePage'), 'InventoryCreatePage'),
  '/topology': lazyPage(() => import('../features/topology/TopologyPage'), 'TopologyPage'),
  '/topology/:resourceId': lazyPage(() => import('../features/topology/ResourceTopologyPage'), 'ResourceTopologyPage'),
  '/discovery': lazyPage(() => import('../features/discovery/DiscoveryPage'), 'DiscoveryPage'),
  '/discovery/sources/:sourceId': lazyPage(() => import('../features/discovery/DiscoverySourceDetailPage'), 'DiscoverySourceDetailPage'),
  '/nf-health': lazyPage(() => import('../features/nf-health/NfHealthPage'), 'NfHealthPage'),
  '/nf-health/:targetId': lazyPage(() => import('../features/nf-health/NfHealthDetailPage'), 'NfHealthDetailPage'),
  '/nf-alerts': lazyPage(() => import('../features/nf-alerts/NfAlertsPage'), 'NfAlertsPage'),

  /* Operational workspaces */
  '/ue-info': lazyPage(() => import('../features/ue-info/UEInfoPage'), 'UEInfoPage'),
  '/ims-registrations': lazyPage(() => import('../features/ims-registration/IMSRegistrationsPage'), 'IMSRegistrationsPage'),
  '/investigations': lazyPage(() => import('../features/investigations/InvestigationsPage'), 'InvestigationsPage'),
  '/investigations/:investigationId': lazyPage(() => import('../features/investigations/InvestigationsPage'), 'InvestigationsPage'),
  '/inspections': lazyPage(() => import('../features/inspections/InspectionsPages'), 'InspectionsPage'),
  '/inspections/new': lazyPage(() => import('../features/inspections/InspectionsPages'), 'InspectionNewPage'),
  '/inspections/plans/:planId': lazyPage(() => import('../features/inspections/InspectionsPages'), 'InspectionPlanPage'),
  '/inspections/runs/:runId': lazyPage(() => import('../features/inspections/InspectionsPages'), 'InspectionRunPage'),
  '/logs': lazyPage(() => import('../features/logs/LogCenterPage'), 'LogCenterPage'),
  '/config-snapshots': lazyPage(() => import('../features/config-snapshots/ConfigSnapshotsPage'), 'ConfigSnapshotsPage'),
  '/config-snapshots/:sourceId': lazyPage(() => import('../features/config-snapshots/ConfigSnapshotsPage'), 'ConfigSnapshotsPage'),
  '/ops-reports': lazyPage(() => import('../features/ops-reports/OperationsReportsPage'), 'OperationsReportsPage'),
  '/agents': lazyPage(() => import('../features/agents/AgentsPage'), 'AgentsPage'),
  '/agents/:agentId': lazyPage(() => import('../features/agents/AgentsPage'), 'AgentsPage'),

  /* Platform administration and knowledge */
  '/users': lazyPage(() => import('../features/users/UsersPage'), 'UsersPage'),
  '/users/:username': lazyPage(() => import('../features/users/UserDetailPage'), 'UserDetailPage'),
  '/users/create': lazyPage(() => import('../features/users/UserCreatePage'), 'UserCreatePage'),
  '/knowledge': lazyPage(() => import('../features/knowledge/KnowledgePage'), 'KnowledgePage'),
  '/knowledge/new': lazyPage(() => import('../features/knowledge/KnowledgeEditorPage'), 'KnowledgeEditorPage'),
  '/knowledge/:entryId': lazyPage(() => import('../features/knowledge/KnowledgeDetailPage'), 'KnowledgeDetailPage'),
  '/knowledge/:entryId/edit': lazyPage(() => import('../features/knowledge/KnowledgeEditorPage'), 'KnowledgeEditorPage'),
  '/system/retention': lazyPage(() => import('../features/retention/RetentionPage'), 'RetentionPage'),
};

/**
 * Business routes derived from the canonical navigation inventory.
 *
 * A compatibility alias renders its redirect and loads no page module. A
 * canonical route without an alias is served by its lazy loader, so the shell
 * can stay mounted while the module downloads.
 */
const businessRoutes: RouteObject[] = APP_ROUTES.filter((route) => route.route !== '/login').map((route) => {
  const redirect = COMPATIBILITY_REDIRECTS[route.route];
  if (redirect) {
    return { path: route.route, element: <Navigate to={redirect} replace /> };
  }
  const lazy = ROUTE_LAZY_PAGES[route.route];
  return lazy ? { path: route.route, lazy } : { path: route.route };
});

export const appRoutes: RouteObject[] = [
  {
    path: '/login',
    element: <LoginPage />,
    hydrateFallbackElement: <InitialRouteFallback />,
  },
  {
    element: <AuthGate><AppShell /></AuthGate>,
    hydrateFallbackElement: <InitialRouteFallback />,
    children: [
      {
        /* Shell-preserving boundary: a failed page module is reported inside the
         * shell so navigation stays usable instead of replacing the whole app. */
        errorElement: <RouteLoadError />,
        children: [
          ...businessRoutes,
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
  { path: '*', element: <NotFoundPage /> },
];
