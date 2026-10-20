/*
 * Read/dashboard entry module.
 *
 * The default landing page is now the operations overview
 * (`features/operations/OperationsOverviewPage`). It owns the operations posture,
 * the unified network-status panel and the secondary business analytics view.
 *
 * The remaining exports are kept for backward compatibility with the earlier
 * module contract: the business pages are owned by their own feature modules and
 * re-exported here, and `ReadBarChart` / `text` remain available to any existing
 * caller.
 */
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { OperationsOverviewPage } from '../operations/OperationsOverviewPage';
import { text, toChartPoints, type UnknownRecord } from './dashboard-model';

/**
 * Dashboard (overview) page — the default landing page after sign-in.
 *
 * The page previously stacked the analytics cockpit, the operational overview
 * and the local runtime panel as three independent sections. The consolidated
 * surface keeps those authorities but presents operations first and mounts the
 * business cockpit only when its view is selected.
 */
export function DashboardPage() {
  return <OperationsOverviewPage />;
}

/* Backward-compatible exports. These surfaces are owned by their feature modules;
 * the re-exports keep the historical module contract intact without duplicating
 * implementations. */

export { SubscribersPage } from '../subscribers/SubscribersPage';
export { ProfilesPage } from '../profiles/ProfilesPage';
export { BalancesPage } from '../ocs/balances/BalancesPage';
export { BalanceDetailPage } from '../ocs/balances/BalanceDetailPage';
export { ContractsPage } from '../ocs/contracts/ContractsPage';
export { ContractDetailPage } from '../ocs/contracts/ContractDetailPage';
export { TariffsPage } from '../ocs/tariffs/TariffsPage';
export { TariffDetailPage } from '../ocs/tariffs/TariffDetailPage';
export { UsersPage } from '../users/UsersPage';
export { UserDetailPage } from '../users/UserDetailPage';

export function ReadBarChart({ rows }: { rows: UnknownRecord[] }) {
  const chartRows = toChartPoints(rows);
  return (
    <ResponsiveContainer width="100%" height={180}>
      <BarChart data={chartRows}>
        <XAxis dataKey="name" />
        <YAxis />
        <Tooltip />
        <Bar dataKey="value" fill="var(--primary)" />
      </BarChart>
    </ResponsiveContainer>
  );
}

export { text };
