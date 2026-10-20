/*
 * Operations overview.
 *
 * The default landing surface. It combines the platform-wide operations summary
 * (Inventory, NF Health, NF alerts) with the local runtime snapshot, then exposes
 * one network-status panel with two explicitly separated authorities:
 * local runtime processes and managed Inventory/NF Health resources.
 *
 * The business analytics cockpit is not mounted here; it is a sibling view in
 * OperationsOverviewPage so this surface never runs its polling in the background.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, BellRing, RefreshCw, Server, Smartphone, Users } from 'lucide-react';
import { useRead } from '../../lib/api/use-read';
import { useI18n } from '../../providers/I18nProvider';
import MetricStrip, { type MetricStripItem, type MetricTone } from '../../components/ui/MetricStrip';
import OperationalOverview from './OperationalOverview';
import { RuntimeDiscoveryEmbedded } from '../runtime/RuntimeDiscovery';
import { resolveRuntimeObservations, useRuntimeStream } from '../runtime/use-runtime-stream';
import type { RuntimeCounts, RuntimeObservations } from '../runtime/runtime-types';
import type { UEInfoResponse } from '../ue-info/types';
import {
  buildOperationsPosture,
  healthStatusDistribution,
  runtimeStatusDistribution,
  type OperationsPosture,
  type StatusDistributionItem,
} from './operations-overview-model';
import type { OperationsSummaryResponse } from './operations-summary';
import styles from '../../styles/modules/operations.module.css';

const SUMMARY_SECTIONS = 'health,alerts';
const SUMMARY_REFRESH_MS = 30000;
const UE_SUMMARY_PATH = '/api/ue-info?summary=1';

function runtimeTone(value: OperationsPosture['runtime']): MetricTone {
  if (value.running === null) return 'muted';
  if ((value.stopped ?? 0) > 0) return 'danger';
  if ((value.attention ?? 0) > 0) return 'warning';
  if ((value.total ?? 0) === 0) return 'muted';
  return 'success';
}

function alertsTone(value: OperationsPosture['alerts']): MetricTone {
  if (value.active === null) return 'muted';
  if ((value.critical ?? 0) > 0) return 'danger';
  if ((value.active ?? 0) > 0) return 'warning';
  return 'success';
}

function distributionTone(key: string): string {
  switch (key) {
    case 'running':
    case 'healthy':
      return styles.toneHealthy;
    case 'stopped':
    case 'unhealthy':
      return styles.toneDanger;
    case 'attention':
    case 'degraded':
      return styles.toneWarning;
    case 'stale':
      return styles.toneStale;
    case 'not_detected':
    case 'not_configured':
      return styles.toneMuted;
    default:
      return styles.toneUnknown;
  }
}

export default function OperationsOverview() {
  const { t, formatDateTime } = useI18n();
  const [tab, setTab] = useState<'runtime' | 'inventory'>('runtime');
  const [refreshSignal, setRefreshSignal] = useState(0);

  const summaryRead = useRead<OperationsSummaryResponse>(
    `/api/operations/summary?sections=${SUMMARY_SECTIONS}`,
  );
  const runtimeRead = useRead<RuntimeObservations>('/api/runtime/observations');
  const ueRead = useRead<UEInfoResponse>(UE_SUMMARY_PATH);
  const stream = useRuntimeStream();
  const runtimeData = resolveRuntimeObservations(stream, runtimeRead.data);
  const counts: RuntimeCounts | undefined = runtimeData?.snapshot.counts;

  const posture = useMemo(
    () => buildOperationsPosture(summaryRead.data, counts),
    [summaryRead.data, counts],
  );

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!summaryRead.isValidating) void summaryRead.mutate();
      if (!ueRead.isValidating) void ueRead.mutate();
    }, SUMMARY_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [summaryRead.isValidating, summaryRead.mutate, ueRead.isValidating, ueRead.mutate]);

  const refresh = useCallback(() => {
    void summaryRead.mutate();
    void ueRead.mutate();
    setRefreshSignal((value) => value + 1);
  }, [summaryRead, ueRead]);

  const runtimeLoading = runtimeRead.isLoading && !counts;
  const summaryLoading = summaryRead.isLoading;
  const ueLoading = ueRead.isLoading && !ueRead.data;
  const distributionLoading = tab === 'runtime' ? runtimeLoading : summaryLoading;
  const unavailable = t('ops_kpi_unavailable');
  const loading = t('loading');
  const epcOnlineUsers = ueRead.data?.summary.epc5gcOnlineUsers ?? null;
  const imsOnlineUsers = ueRead.data?.summary.imsOnlineUsers ?? null;
  const totalSubscribers = ueRead.data?.summary.totalSubscribers ?? null;

  const kpiItems: MetricStripItem[] = [
    {
      key: 'runtime',
      icon: <Server size={16} />,
      label: t('ops_kpi_runtime'),
      value: posture.runtime.running === null
        ? '—'
        : (
          <>
            {posture.runtime.running}
            <span className={styles.kpiUnit}>/ {posture.runtime.total ?? '—'}</span>
          </>
        ),
      detail: posture.runtime.running === null
        ? (runtimeLoading ? loading : unavailable)
        : t('ops_kpi_runtime_detail', {
          expected: posture.runtime.expected ?? '—',
          stopped: posture.runtime.stopped ?? '—',
        }),
      tone: runtimeTone(posture.runtime),
    },
    {
      key: 'epc-online',
      icon: <Users size={16} />,
      label: t('ops_kpi_epc_online'),
      value: epcOnlineUsers === null ? '—' : epcOnlineUsers,
      detail: epcOnlineUsers === null
        ? (ueLoading ? loading : unavailable)
        : (totalSubscribers !== null
          ? t('ops_kpi_epc_online_detail', { count: totalSubscribers })
          : undefined),
      tone: epcOnlineUsers === null ? 'muted' : 'success',
    },
    {
      key: 'ims-online',
      icon: <Smartphone size={16} />,
      label: t('ops_kpi_ims_online'),
      value: imsOnlineUsers === null ? '—' : imsOnlineUsers,
      detail: imsOnlineUsers === null ? t('ops_kpi_ims_pending') : undefined,
      tone: imsOnlineUsers === null ? 'muted' : 'success',
    },
    {
      key: 'alerts',
      icon: <BellRing size={16} />,
      label: t('ops_kpi_alerts'),
      value: posture.alerts.active === null ? '—' : posture.alerts.active,
      detail: posture.alerts.active === null
        ? (summaryLoading ? loading : unavailable)
        : t('ops_kpi_alerts_detail', { critical: posture.alerts.critical ?? '—' }),
      tone: alertsTone(posture.alerts),
    },
  ];

  const runtimeDistribution = useMemo(() => runtimeStatusDistribution(counts), [counts]);
  const healthDistribution = useMemo(
    () => healthStatusDistribution(summaryRead.data),
    [summaryRead.data],
  );
  const distributionItems: StatusDistributionItem[] | null = tab === 'runtime'
    ? runtimeDistribution
    : healthDistribution;

  const distributionTotal = distributionItems
    ? distributionItems.reduce((total, item) => total + item.value, 0)
    : 0;

  const distributionLabel = (key: string): string => {
    if (tab === 'runtime') return t(`runtime_summary_${key}`);
    const known = ['healthy', 'degraded', 'unhealthy', 'unknown', 'stale', 'not_configured'];
    return known.includes(key) ? t(`ops_state_${key}`) : key;
  };

  return (
    <div className={styles.overviewPage}>
      <MetricStrip
        variant="cards"
        columns={4}
        className={styles.kpiStrip}
        ariaLabel={t('dashboard_title')}
        items={kpiItems}
      />

      <section className={styles.statusPanel} aria-labelledby="operations-status-title">
        <div className={styles.statusPanelHead}>
          <div className={styles.statusPanelCopy}>
            <h2 id="operations-status-title" className={styles.statusPanelTitle}>
              <Activity size={18} aria-hidden="true" />
              {t('ops_status_panel_title')}
            </h2>
            <p className={styles.statusPanelNote}>{t('ops_status_panel_note')}</p>
          </div>
          <div className={styles.statusPanelActions}>
            {summaryRead.data?.generatedAt ? (
              <span className={styles.snapshotChip}>
                {t('ops_snapshot_at', { time: formatDateTime(summaryRead.data.generatedAt) })}
              </span>
            ) : null}
            <div className={styles.viewToggle} role="group" aria-label={t('ops_status_view_label')}>
              {(['runtime', 'inventory'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  className={tab === option ? styles.viewToggleActive : undefined}
                  aria-pressed={tab === option}
                  onClick={() => setTab(option)}
                >
                  {t(option === 'runtime' ? 'ops_tab_runtime' : 'ops_tab_inventory')}
                </button>
              ))}
            </div>
            <button type="button" className={styles.refresh} onClick={refresh} aria-label={t('ops_refresh')}>
              <RefreshCw size={15} /> {t('ops_refresh')}
            </button>
          </div>
        </div>

        <div className={styles.distribution} role="group" aria-label={t('ops_distribution_title')}>
          <span className={styles.distributionTitle}>{t('ops_distribution_title')}</span>
          {distributionItems === null ? (
            <p className={styles.distributionEmpty}>
              {distributionLoading ? loading : t('ops_distribution_unavailable')}
            </p>
          ) : distributionTotal === 0 ? (
            <p className={styles.distributionEmpty}>{t('ops_distribution_empty')}</p>
          ) : (
            <>
              <div className={styles.distributionBar} aria-hidden="true">
                {distributionItems.filter((item) => item.value > 0).map((item) => (
                  <span
                    key={item.key}
                    className={distributionTone(item.key)}
                    style={{ width: `${(item.value / distributionTotal) * 100}%` }}
                  />
                ))}
              </div>
              <div className={styles.distributionLegend} role="list">
                {distributionItems.map((item) => (
                  <span key={item.key} className={styles.distributionItem} role="listitem">
                    <span
                      className={`${styles.distributionDot} ${distributionTone(item.key)}`}
                      aria-hidden="true"
                    />
                    {distributionLabel(item.key)}
                    <strong className={styles.distributionValue}>{item.value}</strong>
                  </span>
                ))}
              </div>
            </>
          )}
        </div>

        {tab === 'runtime' ? (
          <div className={styles.statusBody}>
            <RuntimeDiscoveryEmbedded refreshSignal={refreshSignal} />
          </div>
        ) : (
          <div className={styles.statusBody}>
            <OperationalOverview variant="embedded" refreshSignal={refreshSignal} />
          </div>
        )}
      </section>
    </div>
  );
}
