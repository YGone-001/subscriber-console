/*
 * Business analysis cockpit.
 *
 * Every headline metric comes from an explicit authority:
 *   - subscribers and online users: UE Info summary;
 *   - contracts and tariff adoption: OCS contract / tariff plan reads;
 *   - usage: accepted OCS usage records over the trailing 24-hour window;
 *   - pools, sessions, reservations and invariants: OCS analytics.
 *
 * The page never turns a missing measurement into zero and never derives a
 * trend or a readiness score from generated data.
 */
import { useMemo } from 'react';
import useSWR from 'swr';
import {
  Activity,
  AlertCircle,
  CreditCard,
  Database,
  Layers,
  Network,
  RefreshCw,
  TrendingUp,
  Users,
} from 'lucide-react';
import { fetcher } from '../lib/fetcher';
import { useI18n } from '../providers/I18nProvider';
import MetricStrip, { type MetricStripItem } from './ui/MetricStrip';
import CountUpNumber from './analytics/CountUpNumber';
import SkeletonDashboard from './analytics/SkeletonDashboard';
import BusinessRiskPanel from './analytics/BusinessRiskPanel';
import UsageTrendChart from './analytics/UsageTrendChart';
import TariffPlanDistributionChart from './analytics/TariffPlanDistributionChart';
import OcsHealthPanel from './analytics/OcsHealthPanel';
import TopUsageChart from './analytics/TopUsageChart';
import { BYTES_IN_GB } from './analytics/utils';
import type { BusinessRisk, MetricsData } from './analytics/types';
import type { UEInfoResponse } from '../features/ue-info/types';

const RISK_RANK: Record<BusinessRisk['tone'], number> = { danger: 0, warning: 1, info: 2 };

export default function AnalyticsCockpit() {
  const { t, formatNumber, formatDateTime } = useI18n();
  const metrics = useSWR<MetricsData>('/api/analytics/metrics', fetcher, { refreshInterval: 30000 });
  const ue = useSWR<UEInfoResponse>('/api/ue-info?summary=1', fetcher, { refreshInterval: 30000 });

  const risks = useMemo<BusinessRisk[]>(() => {
    const data = metrics.data;
    if (!data) return [];
    const balances = data.ocsBalances;
    const reservations = data.ocsReservations;
    const sessions = data.ocsSessions;
    const activeSessionTotal = sessions?.activeUsedOctets ?? 0;
    const sessionFallback = (data.usageWindowRecords ?? 0) === 0 && activeSessionTotal > 0;
    const usageRecords = data.usageWindowRecords ?? 0;
    const usageTotal = data.usageWindowTotalOctets ?? 0;
    const usageHours = data.usageWindowHours ?? 24;
    const latest = data.latestUsageAt ?? '';
    const latestText = latest
      ? formatDateTime(latest, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : '';
    const remainingGb = balances ? balances.totalDataAvailable / BYTES_IN_GB : null;
    const usageGb = usageTotal / BYTES_IN_GB;
    const averageHourlyGb = usageHours > 0 ? usageGb / usageHours : null;
    const runwayHours = usageRecords > 0 && averageHourlyGb !== null && averageHourlyGb > 0 && remainingGb !== null
      ? remainingGb / averageHourlyGb
      : null;
    const balancesAvailable = Boolean(balances && (balances.totalSubscribers > 0 || balances.totalDataAllocated > 0));
    const top = usageRecords > 0 ? data.topUsage?.[0] : sessions?.activeUsageTop?.[0];
    const result: BusinessRisk[] = [];

    if (!balancesAvailable) {
      result.push({
        id: 'ocs-empty',
        tone: 'warning',
        title: t('dash_biz_risk_ocs_empty_title'),
        detail: t('dash_biz_risk_ocs_empty_detail'),
        href: '/ocs/balances',
        action: t('nav_ocs_balances'),
      });
    } else if (usageRecords === 0) {
      if (sessionFallback && sessions) {
        result.push({
          id: 'usage-not-recorded',
          tone: 'warning',
          title: t('dash_biz_risk_usage_not_recorded_title'),
          detail: t('dash_biz_risk_usage_not_recorded_detail', {
            sessions: formatNumber(sessions.activeSessions),
            total: formatNumber(activeSessionTotal / BYTES_IN_GB, { maximumFractionDigits: 2 }),
          }),
          href: '/ocs/sessions',
          action: t('nav_ocs_sessions'),
        });
      } else {
        result.push({
          id: 'usage-stale',
          tone: 'warning',
          title: t('dash_biz_risk_usage_stale_title'),
          detail: latestText
            ? t('dash_biz_risk_usage_stale_detail', { time: latestText })
            : t('dash_biz_risk_usage_none'),
          href: '/ocs/usage',
          action: t('nav_ocs_usage'),
        });
      }
    } else if (runwayHours !== null && runwayHours < 72) {
      result.push({
        id: 'quota-exhaustion',
        tone: runwayHours < 24 ? 'danger' : 'warning',
        title: t('dash_biz_risk_quota_title'),
        detail: t('dash_biz_risk_quota_detail', {
          hours: formatNumber(runwayHours, { maximumFractionDigits: 1 }),
        }),
        href: '/ocs/balances',
        action: t('nav_ocs_balances'),
      });
    }

    if (balances && balances.brokenInvariantCount > 0) {
      result.push({
        id: 'balance-invariant',
        tone: 'danger',
        title: t('dash_biz_risk_invariant_title', { count: formatNumber(balances.brokenInvariantCount) }),
        detail: t('dash_biz_risk_invariant_detail', {
          checked: formatNumber(balances.invariantChecked),
          scope: t('dash_biz_ocs_scope_data'),
        }),
        href: '/ocs/balances',
        action: t('nav_ocs_balances'),
      });
    }

    if (reservations && reservations.orphanedReservations > 0) {
      result.push({
        id: 'orphaned-reservations',
        tone: 'warning',
        title: t('dash_biz_risk_orphan_title', { count: formatNumber(reservations.orphanedReservations) }),
        detail: t('dash_biz_risk_orphan_detail'),
        href: '/ocs/usage',
        action: t('nav_ocs_usage'),
      });
    }

    if (top && top.share >= 35) {
      const sessionMode = usageRecords === 0 && sessionFallback;
      result.push({
        id: 'usage-concentration',
        tone: top.share >= 50 ? 'danger' : 'warning',
        title: t(sessionMode ? 'dash_biz_risk_session_concentration_title' : 'dash_biz_risk_concentration_title', {
          imsi: top.imsi,
        }),
        detail: t(sessionMode ? 'dash_biz_risk_session_concentration_detail' : 'dash_biz_risk_concentration_detail', {
          share: formatNumber(top.share, { maximumFractionDigits: 1 }),
        }),
        href: '/subscribers',
        action: t('nav_subscriber'),
      });
    }

    if ((data.tariffPlanDist ?? []).length === 0) {
      result.push({
        id: 'tariff-empty',
        tone: 'warning',
        title: t('dash_biz_kpi_plans_empty'),
        detail: t('dash_biz_risk_tariff_empty_detail'),
        href: '/ocs/tariffs',
        action: t('nav_ocs_tariffs'),
      });
    }

    return result.sort((left, right) => RISK_RANK[left.tone] - RISK_RANK[right.tone]);
  }, [metrics.data, t, formatNumber, formatDateTime]);

  if (metrics.isLoading) {
    return <SkeletonDashboard />;
  }

  if (metrics.error || metrics.data?.error || !metrics.data) {
    return (
      <div className="analytics-offline">
        <AlertCircle size={34} />
        <span>{t('dash_biz_offline')}</span>
      </div>
    );
  }

  const data = metrics.data;
  const balances = data.ocsBalances;
  const sessions = data.ocsSessions;
  const reservations = data.ocsReservations;
  const usage = data.ocsUsage;
  const tariffPlans = data.tariffPlanDist ?? [];
  const usageTrend = data.usageTrend ?? [];
  const topUsage = data.topUsage ?? [];
  const usageWindowRecords = data.usageWindowRecords ?? 0;
  const usageWindowTotalOctets = data.usageWindowTotalOctets ?? 0;
  const latestUsageAt = data.latestUsageAt ?? '';
  const totalUsageGb = usageWindowTotalOctets / BYTES_IN_GB;
  const activeSessionTotalOctets = sessions?.activeUsedOctets ?? 0;
  const activeSessionTop = sessions?.activeUsageTop ?? [];
  const sessionFallback = usageWindowRecords === 0 && activeSessionTotalOctets > 0;
  const sessionUsageGb = activeSessionTotalOctets / BYTES_IN_GB;
  const sessionUsageDetail = sessions
    ? t('dash_biz_kpi_session_usage_detail', { sessions: formatNumber(sessions.activeSessions) })
    : undefined;

  const totalSubscribers = ue.data?.summary.totalSubscribers ?? null;
  const onlineUsers = ue.data?.summary.epc5gcOnlineUsers ?? null;
  const epcSources = (ue.data?.sources ?? []).filter((source) =>
    ['mme', 'amf', 'smf', 'smf_metrics'].includes(source.id));
  const configuredSources = epcSources.filter((source) => source.state !== 'not_configured');
  const okSources = configuredSources.filter((source) => source.state === 'ok').length;
  const sourcesIncomplete = configuredSources.some((source) =>
    source.state === 'unavailable' || source.state === 'invalid_config');

  const contractCount = tariffPlans.reduce((sum, plan) => sum + plan.subscriberCount, 0);
  const adoptedPlans = tariffPlans.filter((plan) => plan.subscriberCount > 0).length;
  const totalPlans = tariffPlans.length;
  const dataPercent = balances && balances.totalDataAllocated > 0 ? balances.dataUtilizationRate : null;
  const dataUsedGb = balances ? balances.totalDataUsed / BYTES_IN_GB : 0;
  const dataAllocatedGb = balances ? balances.totalDataAllocated / BYTES_IN_GB : 0;
  const latestUsageText = latestUsageAt
    ? formatDateTime(latestUsageAt, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '';

  const usageDetail = usageWindowRecords > 0
    ? t('dash_biz_kpi_usage_detail', {
      records: formatNumber(usageWindowRecords),
      time: latestUsageText || '—',
    })
    : latestUsageText
      ? t('dash_biz_kpi_usage_empty', { time: latestUsageText })
      : t('dash_biz_kpi_usage_none');

  const kpiItems: MetricStripItem[] = [
    {
      key: 'subscribers',
      icon: <Users size={16} />,
      label: t('dash_biz_kpi_subscribers'),
      value: totalSubscribers !== null ? <CountUpNumber value={totalSubscribers} /> : '—',
      detail: totalSubscribers !== null
        ? t('dash_biz_kpi_subscribers_detail')
        : (ue.isLoading ? t('loading') : t('ops_kpi_unavailable')),
    },
    {
      key: 'online',
      icon: <Network size={16} />,
      label: t('dash_biz_kpi_online'),
      value: onlineUsers !== null ? <CountUpNumber value={onlineUsers} /> : '—',
      detail: onlineUsers !== null
        ? (configuredSources.length > 0
          ? t('dash_biz_kpi_online_detail', { ok: formatNumber(okSources), total: formatNumber(configuredSources.length) })
          : undefined)
        : (ue.isLoading ? t('loading') : t('dash_biz_kpi_online_unavailable')),
      tone: onlineUsers === null ? 'muted' : sourcesIncomplete ? 'warning' : undefined,
    },
    {
      key: 'contracts',
      icon: <CreditCard size={16} />,
      label: t('nav_ocs_contracts'),
      value: <CountUpNumber value={contractCount} />,
      detail: t('dash_biz_kpi_contracts_detail', { count: formatNumber(totalPlans) }),
    },
    {
      key: 'usage',
      icon: <TrendingUp size={16} />,
      label: sessionFallback ? t('dash_biz_kpi_session_usage') : t('dash_biz_kpi_usage'),
      value: usageWindowRecords > 0
        ? (
          <>
            <CountUpNumber value={totalUsageGb} decimals={2} />
            <span>GB</span>
          </>
        )
        : sessionFallback
          ? (
            <>
              <CountUpNumber value={sessionUsageGb} decimals={2} />
              <span>GB</span>
            </>
          )
          : '—',
      detail: usageWindowRecords > 0
        ? usageDetail
        : sessionFallback
          ? sessionUsageDetail
          : usageDetail,
      tone: usageWindowRecords > 0 || sessionFallback ? undefined : (latestUsageText ? 'warning' : 'muted'),
    },
    {
      key: 'data-pool',
      icon: <Database size={16} />,
      label: t('dash_ocs_kpi_utilization'),
      value: dataPercent !== null
        ? (
          <>
            <CountUpNumber value={dataPercent} decimals={1} />
            <span>%</span>
          </>
        )
        : '—',
      detail: dataPercent !== null
        ? t('dash_biz_kpi_pool_detail', {
          used: formatNumber(dataUsedGb, { maximumFractionDigits: 1 }),
          total: formatNumber(dataAllocatedGb, { maximumFractionDigits: 1 }),
        })
        : t('dash_biz_kpi_pool_empty'),
      tone: dataPercent === null ? 'muted' : dataPercent >= 85 ? 'danger' : dataPercent >= 65 ? 'warning' : undefined,
    },
    {
      key: 'tariff-coverage',
      icon: <Layers size={16} />,
      label: t('dash_biz_kpi_plans'),
      value: totalPlans > 0
        ? (
          <>
            {formatNumber(adoptedPlans)}
            <span>/ {formatNumber(totalPlans)}</span>
          </>
        )
        : '—',
      detail: totalPlans > 0
        ? t('dash_biz_kpi_plans_detail', {
          adopted: formatNumber(adoptedPlans),
          total: formatNumber(totalPlans),
        })
        : t('dash_biz_kpi_plans_empty'),
      tone: totalPlans > 0 ? undefined : 'muted',
    },
  ];

  return (
    <div className="analytics-root">
      <div className="analytics-business-toolbar">
        <span className="analytics-business-snapshot">
          <Activity size={14} aria-hidden="true" />
          {t('dash_biz_snapshot', {
            time: data.timestamp ? formatDateTime(data.timestamp) : '—',
          })}
        </span>
        <button
          type="button"
          className="btn btn-outline analytics-refresh"
          onClick={() => {
            void metrics.mutate();
            void ue.mutate();
          }}
          disabled={metrics.isValidating || ue.isValidating}
        >
          <RefreshCw size={14} />
          {t('ops_refresh')}
        </button>
      </div>

      <MetricStrip variant="strip" ariaLabel={t('dash_biz_kpi_aria')} items={kpiItems} />

      <BusinessRiskPanel risks={risks} total={risks.length} />

      <div className="analytics-chart-grid">
        <UsageTrendChart
          points={usageTrend}
          totalOctets={usageWindowTotalOctets}
          records={usageWindowRecords}
          latestUsageAt={latestUsageAt}
          emptyTitle={sessionFallback ? t('dash_biz_usage_no_series_title') : undefined}
          emptyDescription={sessionFallback
            ? t('dash_biz_usage_no_series_detail', {
              sessions: formatNumber(sessions?.activeSessions ?? 0),
              total: formatNumber(sessionUsageGb, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
            })
            : undefined}
        />
        <TariffPlanDistributionChart tariffPlanDist={tariffPlans} />
      </div>

      <OcsHealthPanel
        balances={balances}
        sessions={sessions}
        reservations={reservations}
        usage={usage}
      />

      {sessionFallback ? (
        <TopUsageChart
          entries={activeSessionTop}
          totalOctets={activeSessionTotalOctets}
          records={sessions?.activeSessions ?? 0}
          latestUsageAt=""
          mode="session"
        />
      ) : (
        <TopUsageChart
          entries={topUsage}
          totalOctets={usageWindowTotalOctets}
          records={usageWindowRecords}
          latestUsageAt={latestUsageAt}
        />
      )}
    </div>
  );
}
