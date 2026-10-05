import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Link } from 'react-router-dom';
import { Activity, AlertTriangle, Gauge, RefreshCw, ShieldCheck, Users, Wallet, Zap } from 'lucide-react';
import { useRead } from '../../lib/api/use-read';
import { PageHeader } from '../../components/ui/PageHeader';
import { KpiCard, KpiStrip } from '../../components/ui/KpiCard';
import { EmptyState, ErrorState } from '../../components/ui/StatePanel';
import { SkeletonPage } from '../../components/ui/LoadingSkeleton';
import { useI18n } from '../../providers/I18nProvider';
import {
  buildDashboardModel,
  formatBytes,
  formatNumber,
  numberValue,
  text,
  toChartPoints,
  type ChartPoint,
  type KpiModel,
  type UnknownRecord,
} from './dashboard-model';

const TOOLTIP_STYLE = {
  background: 'var(--surface)',
  border: '1px solid var(--surface-border)',
  borderRadius: 8,
  color: 'var(--text-main)',
} as const;

function ChartCard({ title, meta, children }: { title: string; meta?: string; children: React.ReactNode }) {
  return (
    <section className="chart-card">
      <div className="chart-card-header">
        <h3>{title}</h3>
        {meta ? <span>{meta}</span> : null}
      </div>
      <div className="chart-card-body">{children}</div>
    </section>
  );
}

function UnavailableChart({ title, description }: { title: string; description: string }) {
  return (
    <section className="chart-card">
      <div className="chart-card-header"><h3>{title}</h3></div>
      <div className="chart-card-body">
        <EmptyState title={title} description={description} />
      </div>
    </section>
  );
}

function kpiIcon(id: string) {
  if (id === 'traffic') return <Gauge size={16} />;
  if (id === 'subscribers') return <Users size={16} />;
  if (id === 'alerts') return <AlertTriangle size={16} />;
  if (id === 'contracts') return <Wallet size={16} />;
  if (id === 'active-sessions') return <Activity size={16} />;
  if (id === 'utilization') return <Gauge size={16} />;
  if (id === 'invariants') return <ShieldCheck size={16} />;
  return <Zap size={16} />;
}

function kpiValue(kpi: KpiModel, t: (key: string) => string) {
  if (kpi.id === 'invariants') {
    if (kpi.value === 'dashboard_invariants_ok') return t('dashboard_invariants_ok');
    const broken = kpi.value.split(':')[1] ?? '0';
    return t('dashboard_invariants_broken').replace('{count}', broken);
  }
  return kpi.value;
}

function kpiHint(kpi: KpiModel, t: (key: string) => string) {
  if (!kpi.hintKey) return undefined;
  if (kpi.id === 'alerts') return `${kpi.value} ${t('noc_critical')}`;
  return t(kpi.hintKey);
}

/**
 * Restored operator dashboard.
 *
 * Every value derives from the current accepted read contracts
 * (/api/analytics/metrics, /api/analytics/sparkline, /api/alerts and
 * /api/ocs/subscribers). Metrics the current contract does not report render an
 * explicit unavailable state instead of fabricated data.
 */
export function DashboardPage() {
  const { t } = useI18n();
  const metrics = useRead<unknown>('/api/analytics/metrics');
  const sparkline = useRead<unknown>('/api/analytics/sparkline');
  const alerts = useRead<unknown>('/api/alerts');
  const contracts = useRead<unknown>('/api/ocs/subscribers?limit=1');

  const model = buildDashboardModel({
    metrics: metrics.data,
    sparkline: sparkline.data,
    alerts: alerts.data,
    contracts: contracts.data,
  });

  const loading = metrics.isLoading || sparkline.isLoading || alerts.isLoading || contracts.isLoading;
  const error = metrics.error ?? sparkline.error ?? alerts.error ?? contracts.error;

  const refresh = () => {
    void metrics.mutate();
    void sparkline.mutate();
    void alerts.mutate();
    void contracts.mutate();
  };

  if (loading && !model.available) return <SkeletonPage kpis={4} cards={2} rows={5} />;

  if (error && !model.available) {
    return (
      <div className="page">
        <PageHeader eyebrow={t('dashboard_eyebrow')} title={t('nav_dashboard')} />
        <ErrorState title={t('error_title')} message={error.message} retryLabel={t('refresh')} onRetry={refresh} />
      </div>
    );
  }

  const balances = model.balances ?? {};
  const sessions = model.sessions ?? {};
  const reservations = model.reservations ?? {};
  const usage = model.usage ?? {};

  const renderSeriesChart = (points: Array<{ index: number; value: number }>, title: string, stroke: string, meta?: string) => {
    if (points.length === 0) return <UnavailableChart key={title} title={title} description={t('dashboard_no_series_body')} />;
    return (
      <ChartCard key={title} title={title} meta={meta}>
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={points}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--surface-border)" vertical={false} />
            <XAxis dataKey="index" stroke="var(--text-muted)" fontSize={11} />
            <YAxis stroke="var(--text-muted)" fontSize={11} width={64} />
            <Tooltip contentStyle={TOOLTIP_STYLE} />
            <Line type="monotone" dataKey="value" stroke={stroke} strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>
    );
  };

  const renderBarChart = (points: ChartPoint[], title: string, fill: string, layout: 'horizontal' | 'vertical' = 'horizontal') => {
    if (points.length === 0) return <UnavailableChart key={title} title={title} description={t('dashboard_no_series_body')} />;
    return (
      <ChartCard key={title} title={title}>
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={points} layout={layout}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--surface-border)" vertical={layout === 'vertical'} horizontal={layout === 'horizontal'} />
            {layout === 'vertical' ? (
              <>
                <XAxis type="number" stroke="var(--text-muted)" fontSize={11} />
                <YAxis type="category" dataKey="name" stroke="var(--text-muted)" fontSize={11} width={140} />
              </>
            ) : (
              <>
                <XAxis dataKey="name" stroke="var(--text-muted)" fontSize={11} interval={0} angle={-18} textAnchor="end" height={54} />
                <YAxis stroke="var(--text-muted)" fontSize={11} width={64} />
              </>
            )}
            <Tooltip contentStyle={TOOLTIP_STYLE} />
            <Bar dataKey="value" fill={fill} radius={layout === 'vertical' ? [0, 4, 4, 0] : [4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>
    );
  };

  const bytes = (value: unknown) => {
    const formatted = formatBytes(numberValue(value));
    return `${formatted.value} ${formatted.unit}`;
  };

  return (
    <div className="page analytics-root">
      <PageHeader
        eyebrow={t('dashboard_eyebrow')}
        title={t('nav_dashboard')}
        subtitle={model.refreshedAt > 0 ? t('dashboard_generated_at').replace('{time}', new Date(model.refreshedAt).toLocaleString()) : undefined}
        actions={
          <button type="button" className="btn btn-secondary" onClick={refresh} disabled={loading}>
            <RefreshCw size={16} className={loading ? 'op-spinner' : undefined} />
            {t('refresh')}
          </button>
        }
      />

      {error ? <ErrorState title={t('error_title')} message={error.message} retryLabel={t('refresh')} onRetry={refresh} /> : null}

      <KpiStrip>
        {model.kpis.slice(0, 4).map((kpi) => (
          <KpiCard
            key={kpi.id}
            label={t(kpi.labelKey)}
            value={kpiValue(kpi, t)}
            unit={kpi.unit}
            tone={kpi.tone}
            icon={kpiIcon(kpi.id)}
            hint={kpiHint(kpi, t)}
          />
        ))}
      </KpiStrip>

      <KpiStrip>
        {model.kpis.slice(4).map((kpi) => (
          <KpiCard
            key={kpi.id}
            label={t(kpi.labelKey)}
            value={kpiValue(kpi, t)}
            unit={kpi.unit}
            tone={kpi.tone}
            icon={kpiIcon(kpi.id)}
            hint={kpiHint(kpi, t)}
          />
        ))}
      </KpiStrip>

      <div className="card-grid card-grid-wide">
        {renderSeriesChart(model.trafficSeries, t('dashboard_traffic_trend'), 'var(--chart-1)')}
        {renderSeriesChart(
          model.subscriberSeries,
          t('dashboard_subscriber_trend'),
          'var(--chart-3)',
          `${formatNumber(numberValue((model.balances ?? {}).totalSubscribers))} ${t('dashboard_kpi_subscribers')}`,
        )}
        {renderBarChart(model.plmnPoints, t('dashboard_plmn_distribution'), 'var(--chart-1)')}
        {renderBarChart(model.tariffPoints, t('dashboard_tariff_distribution'), 'var(--chart-2)')}
      </div>

      <section className="card-grid">
        <div className="detail-panel">
          <div className="section-header">
            <h3>{t('dashboard_ocs_balances')}</h3>
            <span className="section-header-meta">{t('dashboard_allocated')} / {t('dashboard_used')} / {t('dashboard_available')}</span>
          </div>
          <dl className="detail-list">
            <div><dt>{t('dashboard_kpi_subscribers')}</dt><dd>{formatNumber(numberValue(balances.totalSubscribers))}</dd></div>
            <div><dt>Data {t('dashboard_allocated')}</dt><dd>{bytes(balances.totalDataAllocated)}</dd></div>
            <div><dt>Data {t('dashboard_used')}</dt><dd>{bytes(balances.totalDataUsed)}</dd></div>
            <div><dt>Data {t('dashboard_reserved')}</dt><dd>{bytes(balances.totalDataReserved)}</dd></div>
            <div><dt>Data {t('dashboard_available')}</dt><dd>{bytes(balances.totalDataAvailable)}</dd></div>
            <div><dt>Voice {t('dashboard_allocated')}</dt><dd>{formatNumber(numberValue(balances.totalVoiceAllocated))}</dd></div>
            <div><dt>SMS {t('dashboard_allocated')}</dt><dd>{formatNumber(numberValue(balances.totalSmsAllocated))}</dd></div>
          </dl>
        </div>

        <div className="detail-panel">
          <div className="section-header">
            <h3>{t('dashboard_ocs_sessions')}</h3>
            <span className="section-header-meta">{t('dashboard_sessions_total')} {formatNumber(numberValue(sessions.totalSessions))}</span>
          </div>
          <dl className="detail-list">
            <div><dt>{t('dashboard_sessions_active')}</dt><dd>{formatNumber(numberValue(sessions.activeSessions))}</dd></div>
            <div><dt>{t('dashboard_sessions_closed')}</dt><dd>{formatNumber(numberValue(sessions.closedSessions))}</dd></div>
            <div><dt>Closing</dt><dd>{formatNumber(numberValue(sessions.closingSessions))}</dd></div>
            <div><dt>Granted octets</dt><dd>{formatNumber(numberValue(sessions.totalGrantedOctets))}</dd></div>
            <div><dt>Used octets</dt><dd>{formatNumber(numberValue(sessions.totalUsedOctets))}</dd></div>
          </dl>
        </div>

        <div className="detail-panel">
          <div className="section-header"><h3>{t('dashboard_ocs_reservations')}</h3></div>
          <dl className="detail-list">
            <div><dt>Total</dt><dd>{formatNumber(numberValue(reservations.totalReservations))}</dd></div>
            <div><dt>Active</dt><dd>{formatNumber(numberValue(reservations.activeReservations))}</dd></div>
            <div><dt>{t('dashboard_settled_reservations')}</dt><dd>{formatNumber(numberValue(reservations.settledReservations))}</dd></div>
            <div><dt>{t('dashboard_orphaned_reservations')}</dt><dd>{formatNumber(numberValue(reservations.orphanedReservations))}</dd></div>
          </dl>
        </div>

        <div className="detail-panel">
          <div className="section-header"><h3>{t('dashboard_ocs_usage')}</h3></div>
          <dl className="detail-list">
            <div><dt>{t('dashboard_records')}</dt><dd>{formatNumber(numberValue(usage.totalRecords))}</dd></div>
            <div><dt>{t('dashboard_charged_records')}</dt><dd>{formatNumber(numberValue(usage.chargedRecords))}</dd></div>
            <div><dt>Input octets</dt><dd>{formatNumber(numberValue(usage.totalInputOctets))}</dd></div>
            <div><dt>Output octets</dt><dd>{formatNumber(numberValue(usage.totalOutputOctets))}</dd></div>
          </dl>
        </div>
      </section>

      {model.topConsumers.length > 0
        ? renderBarChart(model.topConsumers, t('dashboard_top_consumers'), 'var(--chart-4)', 'vertical')
        : null}

      <section className="workbench">
        <div className="workbench-header">
          <h3>{t('dashboard_workbench')}</h3>
          <Link to="/system-health" className="btn btn-secondary btn-sm">{t('nav_health')}</Link>
        </div>
        {model.workbench.length === 0 ? (
          <div className="workbench-list">
            <EmptyState
              title={t('dashboard_workbench_empty')}
              description={t('dashboard_workbench_empty_body')}
              icon={<ShieldCheck size={28} />}
            />
          </div>
        ) : (
          <div className="workbench-list">
            {model.workbench.map((item) => {
              const critical = item.level.toLowerCase() === 'critical';
              return (
                <Link
                  key={item.id}
                  to="/system-health"
                  className={`workbench-item ${critical ? 'workbench-item-danger' : 'workbench-item-warning'}`}
                >
                  <span className="workbench-item-icon" aria-hidden="true"><AlertTriangle size={16} /></span>
                  <span className="workbench-item-copy">
                    <strong>{item.reason}</strong>
                    <span>{item.imsi} · {item.timestamp}</span>
                  </span>
                  <span className="workbench-item-action" aria-hidden="true"><Zap size={15} /></span>
                </Link>
              );
            })}
          </div>
        )}
      </section>
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
