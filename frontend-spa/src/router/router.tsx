import type { ReactNode } from 'react';
import { createBrowserRouter, Navigate } from 'react-router-dom';
import { AppShell } from '../app/AppShell';
import { MigrationPendingPage } from '../app/MigrationPendingPage';
import { NotFoundPage } from '../app/NotFoundPage';
import { AuthGate } from '../auth/AuthGate';
import { LoginPage } from '../auth/LoginPage';
import { APP_ROUTES } from '../lib/navigation';
import { COMPATIBILITY_REDIRECTS } from './redirects';
import { BalanceDetailPage, BalancesPage, ContractDetailPage, ContractsPage, DashboardPage, ProfilesPage, SubscribersPage, SystemHealthPage, TariffDetailPage, TariffsPage, UserDetailPage, UsersPage } from '../features/read/ReadPages';

const readPages: Record<string, ReactNode> = {
  '/': <DashboardPage />, '/ocs/balances': <BalancesPage />, '/ocs/balances/:imsi': <BalanceDetailPage />,
  '/ocs/contracts': <ContractsPage />, '/ocs/contracts/:imsi': <ContractDetailPage />, '/ocs/tariffs': <TariffsPage />,
  '/ocs/tariffs/:planId': <TariffDetailPage />, '/profile': <ProfilesPage />, '/subscribers': <SubscribersPage />,
  '/system-health': <SystemHealthPage />, '/users': <UsersPage />, '/users/:username': <UserDetailPage />,
};
const businessRoutes = APP_ROUTES.filter((route) => route.status !== 'foundation').map((route) => ({
  path: route.targetRoute,
  element: COMPATIBILITY_REDIRECTS[route.targetRoute] ? <Navigate to={COMPATIBILITY_REDIRECTS[route.targetRoute]} replace /> : (readPages[route.targetRoute] ?? <MigrationPendingPage />),
}));

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { element: <AuthGate><AppShell /></AuthGate>, children: [
    ...businessRoutes,
  ] },
  { path: '*', element: <NotFoundPage /> },
]);
