/*
 * Operations overview.
 *
 * The default landing surface. Full-collection KPIs lead, a runtime attention
 * queue answers "what needs action now", and two compact authority panels keep
 * local runtime and managed NF health separate. Detailed tables live on their
 * owning surfaces; this page only links to them.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  BellRing,
  Boxes,
  Network,
  Radar,
  RefreshCw,
  Server,
  Share2,
  ShieldCheck,
  Users,
} from 'lucide-react';
import { useRead } from '../../lib/api/use-read';
import { useI18n } from '../../providers/I18nProvider';
import MetricStrip, { type MetricStripItem, type MetricTone } from '../../components/ui/MetricStrip';
import { reasonLabelKey } from '../runtime/runtime-model';
import { resolveRuntimeObservations, useRuntimeStream } from '../runtime/use-runtime-stream';
import type { RuntimeCounts, RuntimeObservations } from '../runtime/runtime-types';
import type { UEInfoResponse } from '../ue-info/types';
import {
  buildOperationsPosture,
  runtimeAttentionItems,
  type OperationsPosture,
  type RuntimeAttentionItem,
} from './operations-overview-model';
import type { OperationsSummaryResponse } from './operations-summary';
import { ManagedNfSummaryPanel, RuntimeSummaryPanel } from './OverviewAuthorityPanels';
import styles from '../../styles/modules/operations.module.css';

const SUMMARY_SECTIONS = 'health,alerts';
const SUMMARY_REFRESH_MS = 30000;
const UE_SUMMARY_PATH = '/api/ue-info?summary=1';
const RUNTIME_DETAIL_PATH = '/inventory/runtime';

/* The overview aggregates the six operational modules; each entry is a link to
 * the module's owning surface, never an embedded second copy of its tables. */
const MODULE_LINKS = [
  { key: 'inventory', path: '/inventory', label: 'nav_inventory', icon: <Boxes size={15} aria-hidden="true" /> },
  { key: 'topology', path: '/topology', label: 'nav_topology', icon: <Share2 size={15} aria-hidden="true" /> },
  { key: 'discovery', path: '/discovery', label: 'nav_discovery', icon: <Radar size={15} aria-hidden="true" /> },
  { key: 'nf-health', path: '/nf-health', label: 'nav_nf_health', icon: <Activity size={15} aria-hidden="true" /> },
  { key: 'nf-alerts', path: '/nf-alerts', label: 'nav_nf_alerts', icon: <BellRing size={15} aria-hidden="true" /> },
  { key: 'ue-info', path: '/ue-info', label: 'nav_ue_info', icon: <Users size={15} aria-hidden="true" /> },
];

function runtimeTone(value: OperationsPosture['runtime']): MetricTone {
  if (value.running === null) return 'muted';
  if ((value.stopped ?? 0) > 0) return 'danger';
  if ((value.attention ?? 0) > 0) return 'warning';
  if ((value.expected ?? 0) === 0) return 'muted';
  return 'success';
}

function managedTone(value: OperationsPosture['monitored']): MetricTone {
  if (value.configured === null) return 'muted';
  if ((value.unhealthy ?? 0) > 0) return 'danger';
  if ((value.degraded ?? 0) > 0 || (value.stale ?? 0) > 0 || (value.failed ?? 0) > 0) return 'warning';
  if ((value.configured ?? 0) === 0) return 'muted';
  return 'success';
}

function alertsTone(value: OperationsPosture['alerts']): MetricTone {
  if (value.open === null) return 'muted';
  if ((value.critical ?? 0) > 0) return 'danger';
  if ((value.open ?? 0) > 0) return 'warning';
  return 'success';
}

function attentionTone(status: RuntimeAttentionItem['status']): string {
  switch (status) {
    case 'stopped':
      return styles.toneDanger;
    case 'stale':
      return styles.toneStale;
    case 'unknown':
      return styles.toneUnknown;
    default:
      return styles.toneWarning;
  }
}

export default function OperationsOverview() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [refreshSignal, setRefreshSignal] = useState(0);

  const summaryRead = useRead<OperationsSummaryResponse>(
    `/api/operations/summary?sections=${SUMMARY_SECTIONS}`,
  );
  const runtimeRead = useRead<RuntimeObservations>('/api/runtime/observations');
  const ueRead = useRead<UEInfoResponse>(UE_SUMMARY_PATH);
  const stream = useRuntimeStream();
  const runtimeData = resolveRuntimeObservations(stream, runtimeRead.data);
  const counts: RuntimeCounts | undefined = runtimeData?.snapshot.counts;
  const components = runtimeData?.snapshot.components;

  const posture = useMemo(
    () => buildOperationsPosture(summaryRead.data, counts),
    [summaryRead.data, counts],
  );
  const attention = useMemo(() => runtimeAttentionItems(components), [components]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!summaryRead.isValidating) void summaryRead.mutate();
      if (!ueRead.isValidating) void ueRead.mutate();
      if (stream.status !== 'connected' && !runtimeRead.isValidating) void runtimeRead.mutate();
      setRefreshSignal((value) => value + 1);
    }, SUMMARY_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [
    summaryRead.isValidating,
    summaryRead.mutate,
    ueRead.isValidating,
    ueRead.mutate,
    runtimeRead.isValidating,
    runtimeRead.mutate,
    stream.status,
  ]);

  const refresh = useCallback(() => {
    void summaryRead.mutate();
    void ueRead.mutate();
    if (stream.status !== 'connected') void runtimeRead.mutate();
    setRefreshSignal((value) => value + 1);
  }, [summaryRead, ueRead, runtimeRead, stream.status]);

  const runtimeLoading = runtimeRead.isLoading && !counts;
  const summaryLoading = summaryRead.isLoading;
  const ueLoading = ueRead.isLoading && !ueRead.data;
  const runtimeFailed = Boolean(runtimeRead.error) && !runtimeData;
  const unavailable = t('ops_kpi_unavailable');
  const loading = t('loading');

  const epcOnlineUsers = ueRead.data?.summary.epc5gcOnlineUsers ?? null;
  const totalSubscribers = ueRead.data?.summary.totalSubscribers ?? null;
  const epcSources = (ueRead.data?.sources ?? []).filter((source) =>
    ['mme', 'amf', 'smf', 'smf_metrics'].includes(source.id));
  const configuredEpcSources = epcSources.filter((source) => source.state !== 'not_configured');
  const okEpcSources = configuredEpcSources.filter((source) => source.state === 'ok').length;
  const epcSourcesIncomplete = configuredEpcSources.some((source) =>
    source.state === 'unavailable' || source.state === 'invalid_config');

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
            <span className={styles.kpiUnit}>/ {posture.runtime.expected ?? '—'}</span>
          </>
        ),
      detail: posture.runtime.running === null
        ? (runtimeLoading ? loading : unavailable)
        : t('ops_kpi_runtime_detail', {
          stopped: posture.runtime.stopped ?? '—',
          attention: posture.runtime.attention ?? '—',
          notDetected: posture.runtime.notDetected ?? '—',
        }),
      tone: runtimeTone(posture.runtime),
      onClick: () => navigate(RUNTIME_DETAIL_PATH),
    },
    {
      key: 'epc-online',
      icon: <Users size={16} />,
      label: t('ops_kpi_epc_online'),
      value: epcOnlineUsers === null ? '—' : epcOnlineUsers,
      detail: epcOnlineUsers === null
        ? (ueLoading ? loading : unavailable)
        : (totalSubscribers !== null
          ? (configuredEpcSources.length > 0
            ? t('ops_kpi_epc_online_sources', {
              count: totalSubscribers,
              ok: okEpcSources,
              total: configuredEpcSources.length,
            })
            : t('ops_kpi_epc_online_detail', { count: totalSubscribers }))
          : undefined),
      tone: epcOnlineUsers === null ? 'muted' : epcSourcesIncomplete ? 'warning' : 'success',
      onClick: () => navigate('/ue-info'),
    },
    {
      key: 'managed',
      icon: <Network size={16} />,
      label: t('ops_kpi_managed'),
      value: posture.monitored.configured === null ? '—' : posture.monitored.configured,
      detail: posture.monitored.configured === null
        ? (summaryLoading ? loading : unavailable)
        : ((posture.monitored.failed ?? 0) > 0
          ? t('ops_kpi_managed_detail_failed', {
            healthy: posture.monitored.healthy ?? '—',
            stale: posture.monitored.stale ?? '—',
            abnormal: (posture.monitored.degraded ?? 0) + (posture.monitored.unhealthy ?? 0),
            failed: posture.monitored.failed ?? 0,
          })
          : t('ops_kpi_managed_detail', {
            healthy: posture.monitored.healthy ?? '—',
            stale: posture.monitored.stale ?? '—',
            abnormal: (posture.monitored.degraded ?? 0) + (posture.monitored.unhealthy ?? 0),
          })),
      tone: managedTone(posture.monitored),
      onClick: () => navigate('/nf-health'),
    },
    {
      key: 'alerts',
      icon: <BellRing size={16} />,
      label: t('ops_kpi_alerts'),
      value: posture.alerts.open === null ? '—' : posture.alerts.open,
      detail: posture.alerts.open === null
        ? (summaryLoading ? loading : unavailable)
        : t('ops_kpi_alerts_detail', {
          critical: posture.alerts.critical ?? '—',
          active: posture.alerts.active ?? '—',
        }),
      tone: alertsTone(posture.alerts),
      onClick: () => navigate('/nf-alerts'),
    },
  ];

  const runtimeEmpty = Boolean(runtimeData) && (components?.length ?? 0) === 0;
  const runtimePending = !runtimeData && !runtimeFailed;
  const attentionUnavailable = !runtimeData;

  return (
    <div className={styles.overviewPage}>
      <MetricStrip
        variant="cards"
        columns={4}
        className={styles.kpiStrip}
        ariaLabel={t('dashboard_title')}
        items={kpiItems}
      />

      <nav className={styles.moduleNav} aria-label={t('ops_module_nav_label')}>
        {MODULE_LINKS.map((item) => (
          <Link key={item.key} to={item.path} className={styles.moduleNavLink}>
            {item.icon}
            {t(item.label)}
          </Link>
        ))}
      </nav>

      <section className={styles.attentionPanel} aria-labelledby="operations-attention-title">
        <div className={styles.attentionHead}>
          <div>
            <h2 id="operations-attention-title" className={styles.attentionTitle}>
              <AlertTriangle size={18} aria-hidden="true" />
              {t('ops_attention_title')}
            </h2>
            <p className={styles.attentionNote}>{t('ops_attention_note')}</p>
          </div>
          <Link to={RUNTIME_DETAIL_PATH} className={styles.attentionLink}>
            {t('ops_attention_open')}
          </Link>
        </div>

        {attentionUnavailable ? (
          <p className={styles.panelEmpty}>
            {runtimePending ? loading : t('ops_attention_unavailable')}
          </p>
        ) : runtimeEmpty ? (
          <p className={styles.panelEmpty}>{t('runtime_empty_title')}</p>
        ) : attention.total === 0 ? (
          <div className={styles.attentionEmpty}>
            <ShieldCheck size={18} aria-hidden="true" />
            <div className={styles.attentionEmptyCopy}>
              <strong>{t('ops_attention_empty')}</strong>
              <span>{t('ops_attention_empty_detail', { expected: posture.runtime.expected ?? '—' })}</span>
            </div>
          </div>
        ) : (
          <ul className={styles.attentionList}>
            {attention.items.map((item) => (
              <li key={item.componentId} className={styles.attentionItem}>
                <span className={`${styles.attentionBadge} ${attentionTone(item.status)}`}>
                  {t(`runtime_status_${item.status}`)}
                </span>
                <span className={styles.attentionName}>
                  {item.displayName}
                  <code>{item.processName}</code>
                </span>
                <span className={styles.attentionReason}>{t(reasonLabelKey(item.statusReason))}</span>
                <span className={styles.attentionCategory}>
                  {t(`runtime_category_${item.category}`)}
                </span>
              </li>
            ))}
            {attention.total > attention.items.length ? (
              <li className={styles.attentionMore}>
                {t('ops_attention_more', { count: attention.total - attention.items.length })}
              </li>
            ) : null}
          </ul>
        )}
      </section>

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
            <button type="button" className={styles.refresh} onClick={refresh} aria-label={t('ops_refresh')}>
              <RefreshCw size={15} /> {t('ops_refresh')}
            </button>
          </div>
        </div>

        <div className={styles.authorityGrid}>
          <RuntimeSummaryPanel
            data={runtimeData}
            counts={counts}
            live={stream.status === 'connected'}
            loading={runtimeLoading || runtimePending}
            failed={runtimeFailed}
          />
          <ManagedNfSummaryPanel summary={summaryRead.data} refreshSignal={refreshSignal} />
        </div>
      </section>
    </div>
  );
}
