/*
 * Operations overview authority panels.
 *
 * Two summaries sit side by side because they answer different questions from
 * different authorities. The runtime panel reports the local /proc snapshot;
 * the managed-NF panel reports Inventory population against NF Health evidence.
 * Neither panel borrows the other's status vocabulary, and neither renders a
 * missing measurement as zero.
 */
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Activity, Server } from 'lucide-react';
import { LoadingRows } from '../../components/ui/OperationFeedback';
import { useI18n } from '../../providers/I18nProvider';
import { groupByCategory, summarize } from '../runtime/runtime-model';
import type { RuntimeCounts, RuntimeObservations } from '../runtime/runtime-types';
import {
  healthStatusDistribution,
  runtimeStatusDistribution,
  type StatusDistributionItem,
} from './operations-overview-model';
import type { OperationsSummaryResponse } from './operations-summary';
import { useOperationalOverviewData } from './use-operational-overview-data';
import styles from '../../styles/modules/operations.module.css';

const NF_SUMMARY_LIMIT = 50;
const HEALTH_STATE_KEYS = ['healthy', 'degraded', 'unhealthy', 'unknown', 'stale', 'not_configured'];

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

function completenessTone(value: 'complete' | 'partial' | 'unavailable'): string {
  if (value === 'complete') return styles.toneHealthy;
  if (value === 'unavailable') return styles.toneDanger;
  return styles.toneWarning;
}

function StatusDistribution({
  items,
  title,
  label,
}: {
  items: StatusDistributionItem[] | null;
  title: string;
  label: (key: string) => string;
}) {
  const { t } = useI18n();
  const total = items ? items.reduce((sum, item) => sum + item.value, 0) : 0;

  return (
    <div className={styles.distribution} role="group" aria-label={title}>
      <span className={styles.distributionTitle}>{title}</span>
      {items === null ? (
        <p className={styles.distributionEmpty}>{t('ops_distribution_unavailable')}</p>
      ) : total === 0 ? (
        <p className={styles.distributionEmpty}>{t('ops_distribution_empty')}</p>
      ) : (
        <>
          <div className={styles.distributionBar} aria-hidden="true">
            {items.filter((item) => item.value > 0).map((item) => (
              <span
                key={item.key}
                className={distributionTone(item.key)}
                style={{ width: `${(item.value / total) * 100}%` }}
              />
            ))}
          </div>
          <div className={styles.distributionLegend} role="list">
            {items.map((item) => (
              <span key={item.key} className={styles.distributionItem} role="listitem">
                <span
                  className={`${styles.distributionDot} ${distributionTone(item.key)}`}
                  aria-hidden="true"
                />
                {label(item.key)}
                <strong className={styles.distributionValue}>{item.value}</strong>
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function RuntimeSummaryPanel({
  data,
  counts,
  live,
  loading,
  failed,
}: {
  data?: RuntimeObservations;
  counts?: RuntimeCounts;
  live: boolean;
  loading: boolean;
  failed: boolean;
}) {
  const { t, formatDateTime } = useI18n();
  const snapshot = data?.snapshot;
  const components = snapshot?.components ?? [];
  const groups = useMemo(() => groupByCategory(components), [components]);
  const distribution = useMemo(() => runtimeStatusDistribution(counts), [counts]);
  const scanAt = snapshot?.scan?.completedAt;

  return (
    <section className={styles.authorityPanel} aria-labelledby="runtime-summary-title">
      <div className={styles.authorityHead}>
        <div>
          <h3 id="runtime-summary-title" className={styles.authorityTitle}>
            <Activity size={17} aria-hidden="true" />
            {t('ops_runtime_panel_title')}
          </h3>
          <p className={styles.authorityNote}>{t('ops_runtime_panel_note')}</p>
        </div>
        {scanAt ? (
          <span className={styles.snapshotChip}>
            {t('ops_snapshot_at', { time: formatDateTime(scanAt) })}
          </span>
        ) : null}
      </div>

      <div className={styles.authorityMeta}>
        {snapshot?.host?.hostName ? <span>{snapshot.host.hostName}</span> : null}
        <span className={styles.liveChip} data-live={live || undefined}>
          {live ? t('runtime_stream_live') : t('ops_runtime_panel_polling')}
        </span>
      </div>

      {loading ? (
        <LoadingRows rows={3} />
      ) : failed ? (
        <p className={styles.panelEmpty}>{t('ops_kpi_unavailable')}</p>
      ) : groups.length === 0 ? (
        <p className={styles.panelEmpty}>{t('runtime_empty_title')}</p>
      ) : (
        <>
          <ul className={styles.domainSummaryList}>
            {groups.map((group) => {
              const groupSummary = summarize(group.components);
              const attention = groupSummary.stopped + groupSummary.attention;
              return (
                <li key={group.category} className={styles.domainSummaryRow}>
                  <span className={styles.domainSummaryName}>
                    {t(`runtime_category_${group.category}`)}
                  </span>
                  <span className={`${styles.domainSummaryValue} ${attention > 0 ? styles.toneWarning : ''}`}>
                    {groupSummary.running}
                    {groupSummary.expected > 0 ? (
                      <span className={styles.domainSummaryDenominator}>/ {groupSummary.expected}</span>
                    ) : null}
                  </span>
                  <span className={styles.domainSummaryMeta}>
                    {groupSummary.notDetected > 0
                      ? t('ops_runtime_panel_not_detected', { count: groupSummary.notDetected })
                      : t('ops_runtime_panel_expected', { count: groupSummary.expected })}
                    {attention > 0 ? ` · ${t('ops_runtime_panel_attention', { count: attention })}` : null}
                  </span>
                </li>
              );
            })}
          </ul>

          <StatusDistribution
            items={distribution}
            title={t('ops_runtime_distribution_title')}
            label={(key) => t(`runtime_summary_${key}`)}
          />

          <Link to="/inventory?view=runtime" className={styles.authorityLink}>
            {t('ops_runtime_panel_link')}
          </Link>
        </>
      )}
    </section>
  );
}

export function ManagedNfSummaryPanel({
  summary,
  refreshSignal,
}: {
  summary?: OperationsSummaryResponse;
  refreshSignal: number;
}) {
  const { t, formatDateTime } = useI18n();
  const {
    resourcesRead,
    associationsRead,
    completeness,
    items,
    groups,
    summary: operational,
  } = useOperationalOverviewData(NF_SUMMARY_LIMIT, refreshSignal);

  const healthTargets = summary?.health?.completeness === 'complete' ? summary.health.targets : undefined;
  const targetCount = healthTargets ? healthTargets.configured : null;
  const enabledTargets = healthTargets ? healthTargets.enabled : null;
  const distribution = useMemo(() => healthStatusDistribution(summary), [summary]);
  const nfGroups = groups.filter((group) => group.counts.registered > 0);
  const pagePartial = Boolean(resourcesRead.data?.page?.hasMore);
  const loading = (resourcesRead.isLoading || associationsRead.isLoading) && items.length === 0;
  const failed = Boolean(resourcesRead.error);

  return (
    <section className={styles.authorityPanel} aria-labelledby="managed-nf-summary-title">
      <div className={styles.authorityHead}>
        <div>
          <h3 id="managed-nf-summary-title" className={styles.authorityTitle}>
            <Server size={17} aria-hidden="true" />
            {t('ops_nf_panel_title')}
          </h3>
          <p className={styles.authorityNote}>{t('ops_nf_panel_note')}</p>
        </div>
        {loading ? null : (
          <span className={`${styles.completeness} ${completenessTone(completeness.overall)}`}>
            {t(`ops_completeness_${completeness.overall}`)}
          </span>
        )}
      </div>

      <div className={styles.authorityMeta}>
        <span>
          {targetCount !== null && enabledTargets !== null && targetCount !== enabledTargets
            ? t('ops_nf_panel_targets_enabled', { configured: targetCount, enabled: enabledTargets })
            : t('ops_nf_panel_targets', { count: targetCount ?? '—' })}
        </span>
        {pagePartial ? <span>{t('ops_completeness_partial')}</span> : null}
        {summary?.generatedAt ? (
          <span className={styles.snapshotChip}>
            {t('ops_snapshot_at', { time: formatDateTime(summary.generatedAt) })}
          </span>
        ) : null}
      </div>

      {loading ? (
        <LoadingRows rows={3} />
      ) : failed ? (
        <p className={styles.panelEmpty}>{t('ops_nf_panel_unavailable')}</p>
      ) : nfGroups.length === 0 ? (
        <p className={styles.panelEmpty}>{t('ops_nf_panel_empty')}</p>
      ) : (
        <>
          <p className={styles.authoritySubhead}>
            {t('ops_nf_panel_page_scope', { count: operational.registered })}
          </p>
          <ul className={styles.domainSummaryList}>
            {nfGroups.map((group) => {
              const abnormal = group.counts.degraded + group.counts.unhealthy;
              const meta = [
                t('ops_nf_panel_healthy', { count: group.counts.healthy }),
                t('ops_nf_panel_stale', { count: group.counts.stale }),
              ];
              if (abnormal > 0) meta.push(t('ops_nf_panel_abnormal', { count: abnormal }));
              if (group.counts.unmonitored > 0) {
                meta.push(t('ops_nf_panel_unmonitored', { count: group.counts.unmonitored }));
              }
              if (group.counts.unresolved > 0) {
                meta.push(t('ops_nf_panel_unresolved', { count: group.counts.unresolved }));
              }
              const tone = abnormal > 0
                ? styles.toneDanger
                : group.counts.stale > 0 || group.counts.unmonitored > 0 || group.counts.unresolved > 0
                  ? styles.toneWarning
                  : styles.toneHealthy;
              return (
                <li key={group.domain} className={styles.domainSummaryRow}>
                  <span className={styles.domainSummaryName}>{t(`ops_domain_${group.domain}`)}</span>
                  <span className={`${styles.domainSummaryValue} ${tone}`}>
                    {group.counts.monitored}
                    <span className={styles.domainSummaryDenominator}>/ {group.counts.registered}</span>
                  </span>
                  <span className={styles.domainSummaryMeta}>{meta.join(' · ')}</span>
                </li>
              );
            })}
          </ul>

          <StatusDistribution
            items={distribution}
            title={t('ops_nf_distribution_title')}
            label={(key) => (HEALTH_STATE_KEYS.includes(key) ? t(`ops_state_${key}`) : key)}
          />

          <Link to="/inventory" className={styles.authorityLink}>
            {t('ops_nf_panel_link')}
          </Link>
        </>
      )}
    </section>
  );
}
