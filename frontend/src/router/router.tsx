import type { ReactNode } from 'react';
import { createBrowserRouter, Navigate } from 'react-router-dom';
import { AppShell } from '../app/AppShell';
import { NotFoundPage } from '../app/NotFoundPage';
import { AuthGate } from '../auth/AuthGate';
import { LoginPage } from '../auth/LoginPage';
import { APP_ROUTES } from '../lib/navigation';
import { COMPATIBILITY_REDIRECTS } from './redirects';
import { DashboardPage } from '../features/read/ReadPages';
import { SystemHealthPage } from '../features/system-health/SystemHealthPage';
import { SubscribersPage } from '../features/subscribers/SubscribersPage';
import { BalancesPage } from '../features/ocs/balances/BalancesPage';
import { BalanceDetailPage } from '../features/ocs/balances/BalanceDetailPage';
import { ContractsPage } from '../features/ocs/contracts/ContractsPage';
import { ContractDetailPage } from '../features/ocs/contracts/ContractDetailPage';
import { TariffsPage } from '../features/ocs/tariffs/TariffsPage';
import { TariffDetailPage } from '../features/ocs/tariffs/TariffDetailPage';
import { ProfilesPage } from '../features/profiles/ProfilesPage';
import { UsersPage } from '../features/users/UsersPage';
import { UserDetailPage } from '../features/users/UserDetailPage';
import { UserCreatePage } from '../features/users/UserCreatePage';
import { InventoryPage } from '../features/inventory/InventoryPage';
import { InventoryDetailPage } from '../features/inventory/InventoryDetailPage';
import { InventoryCreatePage } from '../features/inventory/InventoryCreatePage';
import { TopologyPage } from '../features/topology/TopologyPage';
import { ResourceTopologyPage } from '../features/topology/ResourceTopologyPage';
import { DiscoveryPage } from '../features/discovery/DiscoveryPage';
import { DiscoverySourceDetailPage } from '../features/discovery/DiscoverySourceDetailPage';
import { NfHealthPage } from '../features/nf-health/NfHealthPage';
import { NfHealthDetailPage } from '../features/nf-health/NfHealthDetailPage';

const pages: Record<string, ReactNode> = {
  '/': <DashboardPage />,
  '/inventory': <InventoryPage />,
  '/inventory/:resourceId': <InventoryDetailPage />,
  '/inventory/create': <InventoryCreatePage />,
  '/topology': <TopologyPage />,
  '/topology/:resourceId': <ResourceTopologyPage />,
  '/discovery': <DiscoveryPage />,
  '/discovery/sources/:sourceId': <DiscoverySourceDetailPage />,
  '/nf-health': <NfHealthPage />,
  '/nf-health/:targetId': <NfHealthDetailPage />,
  '/ocs/balances': <BalancesPage />,
  '/ocs/balances/:imsi': <BalanceDetailPage />,
  '/ocs/contracts': <ContractsPage />,
  '/ocs/contracts/:imsi': <ContractDetailPage />,
  '/ocs/tariffs': <TariffsPage />,
  '/ocs/tariffs/:planId': <TariffDetailPage />,
  '/profile': <ProfilesPage />,
  '/subscribers': <SubscribersPage />,
  '/system-health': <SystemHealthPage />,
  '/users': <UsersPage />,
  '/users/:username': <UserDetailPage />,
  '/users/create': <UserCreatePage />,
};

const businessRoutes = APP_ROUTES.filter((route) => route.route !== '/login').map((route) => ({
  path: route.route,
  element: COMPATIBILITY_REDIRECTS[route.route] ? <Navigate to={COMPATIBILITY_REDIRECTS[route.route]} replace /> : pages[route.route],
}));

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { element: <AuthGate><AppShell /></AuthGate>, children: [
    ...businessRoutes,
  ] },
  { path: '*', element: <NotFoundPage /> },
]);
