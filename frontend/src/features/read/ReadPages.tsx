/*
 * Read/dashboard entry module.
 *
 * The dashboard itself is the forward-ported AnalyticsCockpit
 * (reference commit 2c40903: `app/(dashboard)/page.tsx` + `components/AnalyticsCockpit.tsx`).
 *
 * The remaining exports are kept for backward compatibility with the earlier
 * module contract: the business pages are owned by their own feature modules and
 * re-exported here, and `ReadBarChart` / `text` remain available to any existing
 * caller.
 */
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { RadioTower } from 'lucide-react';
import AnalyticsCockpit from '../../components/AnalyticsCockpit';
import PageHeader from '../../components/ui/PageHeader';
import { useI18n } from '../../providers/I18nProvider';
import { text, toChartPoints, type UnknownRecord } from './dashboard-model';

/**
 * Dashboard (overview) page — the default landing page after sign-in.
 *
 * It renders the AnalyticsCockpit, which owns:
 * - KPI strip (traffic, subscribers, PLMN regions, contracts, utilization, invariants)
 * - workbench panel (prioritised action items + operations readiness score)
 * - OCS resource strip (balance capacity, session telemetry)
 * - charts (top consumers, tariff plan distribution)
 */
export function DashboardPage() {
  const { t } = useI18n();

  return (
    <div className="container animate-fade-in">
      <PageHeader
        eyebrow={t('dash_live')}
        icon={<RadioTower size={24} />}
        title={t('dashboard_title')}
        description={t('dash_workbench_subtitle')}
      />
      <AnalyticsCockpit />
    </div>
  );
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
