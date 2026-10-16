/*
 * Operational Overview.
 *
 * A CNMS-inspired operational network overview adapted to xCloud's authorities.
 * It renders the Inventory resource population and the NF Health monitoring
 * projection for the loaded page. It never replaces the business analytics
 * cockpit: it is an additional section on the existing dashboard route.
 *
 * Honesty rules enforced here:
 *   - counts carry an explicit completeness marker (complete vs partial page)
 *   - a measured layer is never rendered as a healthy service
 *   - an unmonitored resource is never rendered as stopped
 *   - missing values are rendered as unavailable, never as zero
 *   - no subscriber or online-user count is derived from this data
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, ChevronDown, ChevronRight, Layers, RefreshCw, Server, ShieldCheck } from 'lucide-react';
import { useRead } from '../../lib/api/use-read';
import { useI18n } from '../../providers/I18nProvider';
import { EmptyState, LoadingRows } from '../../components/ui/OperationFeedback';
import {
  applyResolvedNFTypes,
  buildOperationalResources,
  formatBytes,
  groupByDomain,
  memoryView,
  OPERATIONAL_DOMAINS,
  summarizeOperational,
  type OperationalResource,
} from './operational-model';
import styles from '../../styles/modules/operations.module.css';

const OVERVIEW_LIMIT = 50;
const REFRESH_INTERVAL_MS = 30000;

type TargetListPayload = { targets?: unknown[]; page?: { hasMore?: boolean } };
type ResourceListPayload = { resources?: unknown[]; page?: { hasMore?: boolean } };

function stateTone(state: string): string {
  switch (state) {
    case 'healthy':
      return styles.toneHealthy;
    case 'degraded':
      return styles.toneWarning;
    case 'unhealthy':
      return styles.toneDanger;
    case 'stale':
      return styles.toneStale;
    case 'not_configured':
    case 'not_monitored':
      return styles.toneMuted;
    default:
      return styles.toneUnknown;
  }
}

/** Localized state label; an unknown token is shown verbatim, never guessed. */
function stateLabel(state: string, t: (key: string) => string): string {
  const known = [
    'healthy', 'degraded', 'unhealthy', 'unknown', 'stale',
    'not_configured', 'not_monitored', 'fresh',
  ];
  if (!state) return t('ops_state_unknown');
  return known.includes(state) ? t(`ops_state_${state}`) : state;
}

function layerCoverage(resource: OperationalResource, t: (key: string) => string): string {
  const monitoring = resource.monitoring;
  if (!monitoring) return t('ops_layer_unmonitored');
  const parts = [
    `${t('ops_layer_l1')} ${monitoring.coverage.l1Measured ? t('ops_layer_measured') : t('ops_layer_not_configured')}`,
    `${t('ops_layer_l2')} ${monitoring.coverage.l2Measured ? t('ops_layer_measured') : t('ops_layer_not_configured')}`,
    `${t('ops_layer_l3')} ${monitoring.coverage.l3Measured ? t('ops_layer_measured') : t('ops_layer_not_configured')}`,
  ];
  return parts.join(' · ');
}

function ResourceRow({ resource }: { resource: OperationalResource }) {
  const { t } = useI18n();
  const monitoring = resource.monitoring;
  const memory = memoryView(monitoring);
  const overall = monitoring ? monitoring.overallState : 'not_monitored';

  return (
    <li className={styles.nfRow}>
      <div className={styles.nfRowMain}>
        <span className={styles.nfName}>{resource.name}</span>
        <span className={styles.nfType}>{resource.typeLabel}</span>
        {resource.retired ? <span className={styles.chipRetired}>{t('ops_lifecycle_retired')}</span> : null}
      </div>
      <div className={styles.nfRowMeta}>
        <span className={`${styles.stateBadge} ${stateTone(overall)}`} title={stateLabel(overall, t)}>
          {stateLabel(overall, t)}
        </span>
        <span className={styles.nfCoverage}>{layerCoverage(resource, t)}</span>
        <span className={styles.nfMemory}>
          {memory
            ? `${t('ops_memory')} ${formatBytes(memory.value)}${memory.fresh ? '' : ` (${t('ops_historical')})`}`
            : t('ops_metric_unavailable')}
        </span>
        <span className={styles.nfLinks}>
          <Link to={`/inventory/${resource.resourceId}`}>{t('ops_open_resource')}</Link>
          {monitoring ? <Link to={`/nf-health/${monitoring.targetId}`}>{t('ops_open_monitoring')}</Link> : null}
        </span>
      </div>
    </li>
  );
}

export default function OperationalOverview() {
  const { t } = useI18n();
  const resourcesRead = useRead<ResourceListPayload>(`/api/inventory/resources?limit=${OVERVIEW_LIMIT}`);
  const targetsRead = useRead<TargetListPayload>(`/api/nf-health/targets?limit=${OVERVIEW_LIMIT}`);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ epc: true, '5gc': true });

  const refresh = useCallback(() => {
    void resourcesRead.mutate();
    void targetsRead.mutate();
  }, [resourcesRead, targetsRead]);

  // Bounded, cancellation-aware refresh: one timer, cleared on unmount, and it
  // never fires while a previous request is still in flight.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!resourcesRead.isValidating && !targetsRead.isValidating) refresh();
    }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refresh, resourcesRead.isValidating, targetsRead.isValidating]);

  const sourcesComplete = !resourcesRead.error && !targetsRead.error;
  const hasMore = Boolean(resourcesRead.data?.page?.hasMore) || Boolean(targetsRead.data?.page?.hasMore);

  const { items, groups, summary } = useMemo(() => {
    const joined = buildOperationalResources(resourcesRead.data?.resources, targetsRead.data?.targets);
    const enriched = applyResolvedNFTypes(joined.items, targetsRead.data?.targets);
    return {
      items: enriched,
      groups: groupByDomain(enriched, hasMore, sourcesComplete),
      summary: summarizeOperational(enriched, hasMore, sourcesComplete),
    };
  }, [resourcesRead.data, targetsRead.data, hasMore, sourcesComplete]);

  const loading = (resourcesRead.isLoading || targetsRead.isLoading) && items.length === 0;
  const failed = Boolean(resourcesRead.error) && Boolean(targetsRead.error);

  const toggle = (domain: string) => setExpanded((current) => ({ ...current, [domain]: !current[domain] }));

  return (
    <section className={styles.overview} aria-labelledby="operational-overview-title">
      <div className={styles.sectionHead}>
        <div>
          <h2 id="operational-overview-title" className={styles.sectionTitle}>
            <Activity size={18} /> {t('ops_overview_title')}
          </h2>
          <p className={styles.sectionNote}>{t('ops_overview_note')}</p>
        </div>
        <div className={styles.sectionActions}>
          <span className={`${styles.completeness} ${summary.completeness === 'complete' ? styles.toneHealthy : styles.toneWarning}`}>
            {summary.completeness === 'complete' ? t('ops_complete') : t('ops_partial')}
          </span>
          <button type="button" className={styles.refresh} onClick={refresh} aria-label={t('ops_refresh')}>
            <RefreshCw size={15} /> {t('ops_refresh')}
          </button>
        </div>
      </div>

      {loading ? (
        <LoadingRows rows={3} />
      ) : failed ? (
        <EmptyState icon={<Server size={40} />} title={t('ops_error_title')} description={t('ops_error_body')} />
      ) : items.length === 0 ? (
        <EmptyState icon={<Server size={40} />} title={t('ops_empty_title')} description={t('ops_empty_body')} />
      ) : (
        <>
          <div className={styles.cardGrid}>
            <article className={styles.card}>
              <h3 className={styles.cardTitle}>{t('ops_card_population')}</h3>
              <p className={styles.cardValue}>{summary.registered}</p>
              <p className={styles.cardHint}>{t('ops_card_population_hint')}</p>
            </article>
            <article className={styles.card}>
              <h3 className={styles.cardTitle}>{t('ops_card_monitored')}</h3>
              <p className={styles.cardValue}>
                {summary.monitored}
                <span className={styles.cardValueSuffix}>/ {summary.registered}</span>
              </p>
              <p className={styles.cardHint}>{t('ops_card_monitored_hint')}</p>
            </article>
            <article className={styles.card}>
              <h3 className={styles.cardTitle}>{t('ops_card_unmonitored')}</h3>
              <p className={styles.cardValue}>{summary.unmonitored}</p>
              <p className={styles.cardHint}>{t('ops_card_unmonitored_hint')}</p>
            </article>
            <article className={styles.card}>
              <h3 className={styles.cardTitle}>{t('ops_card_fresh')}</h3>
              <p className={styles.cardValue}>{summary.fresh}</p>
              <p className={styles.cardHint}>{t('ops_card_fresh_hint')}</p>
            </article>
            <article className={styles.card}>
              <h3 className={styles.cardTitle}>{t('ops_card_stale')}</h3>
              <p className={styles.cardValue}>{summary.stale}</p>
              <p className={styles.cardHint}>{t('ops_card_stale_hint')}</p>
            </article>
            <article className={styles.card}>
              <h3 className={styles.cardTitle}>{t('ops_card_degraded')}</h3>
              <p className={styles.cardValue}>
                {summary.degraded}
                <span className={styles.cardValueSuffix}>/ {summary.unhealthy} {t('ops_card_unhealthy_suffix')}</span>
              </p>
              <p className={styles.cardHint}>{t('ops_card_degraded_hint')}</p>
            </article>
          </div>

          <div className={styles.domainStrip} role="list">
            {OPERATIONAL_DOMAINS.map((domain) => {
              const group = groups.find((entry) => entry.domain === domain);
              return (
                <div key={domain} className={styles.domainCard} role="listitem">
                  <span className={styles.domainName}>{t(`ops_domain_${domain}`)}</span>
                  <span className={styles.domainValue}>{group ? group.resources.length : 0}</span>
                  <span className={styles.domainMeta}>
                    {group
                      ? `${group.counts.monitored} ${t('ops_domain_monitored')} · ${group.counts.fresh} ${t('ops_domain_fresh')}`
                      : t('ops_domain_absent')}
                  </span>
                </div>
              );
            })}
          </div>

          <div className={styles.groupList}>
            {groups.map((group) => {
              const isOpen = expanded[group.domain] !== false;
              return (
                <section key={group.domain} className={styles.group}>
                  <button
                    type="button"
                    className={styles.groupToggle}
                    aria-expanded={isOpen}
                    onClick={() => toggle(group.domain)}
                  >
                    {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                    <span className={styles.groupName}>{t(`ops_domain_${group.domain}`)}</span>
                    <span className={styles.groupCount}>
                      {group.resources.length} {t('ops_group_resources')} · {group.counts.monitored} {t('ops_group_monitored')}
                    </span>
                  </button>
                  {isOpen ? (
                    <ul className={styles.nfList}>
                      {group.resources.map((resource) => (
                        <ResourceRow key={resource.resourceId} resource={resource} />
                      ))}
                    </ul>
                  ) : null}
                </section>
              );
            })}
          </div>

          <p className={styles.footnote}>
            <Layers size={14} /> {t('ops_footnote_layers')}
            <ShieldCheck size={14} /> {t('ops_footnote_scope')}
          </p>
        </>
      )}
    </section>
  );
}
