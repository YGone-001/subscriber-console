/*
 * Operational Overview.
 *
 * A CNMS-inspired operational network overview adapted to xCloud's authorities.
 * It renders the Inventory resource population and the NF Health monitoring
 * projection for the loaded page. It never replaces the business analytics
 * cockpit: it is an additional section on the existing dashboard route.
 *
 * Integrity rules enforced here:
 *   - monitoring associations are resolved by an authoritative bounded batch
 *     lookup for exactly the loaded resource identifiers, never inferred from an
 *     unrelated NF Health cursor page;
 *   - an unresolved association is reported as unresolved, never as unmonitored;
 *   - completeness is reported per source (Inventory, monitoring, telemetry);
 *   - a measured layer is never rendered as a healthy service;
 *   - an unmonitored resource is never rendered as stopped;
 *   - missing values are rendered as unavailable, never as zero;
 *   - no subscriber or online-user count is derived from this data.
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
  combineCompleteness,
  formatBytes,
  groupByDomain,
  memoryView,
  OPERATIONAL_DOMAINS,
  summarizeOperational,
  type CompletenessReport,
  type DimensionCompleteness,
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
    'not_configured', 'not_monitored', 'fresh', 'unresolved',
  ];
  if (!state) return t('ops_state_unknown');
  return known.includes(state) ? t(`ops_state_${state}`) : state;
}

function completenessLabel(value: DimensionCompleteness, t: (key: string) => string): string {
  return t(`ops_completeness_${value}`);
}

function layerCoverage(resource: OperationalResource, t: (key: string) => string): string {
  const monitoring = resource.monitoring;
  if (resource.association === 'unresolved') return t('ops_assoc_unresolved');
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
  const overall = resource.association === 'unresolved'
    ? 'unresolved'
    : monitoring
      ? monitoring.overallState
      : 'not_monitored';

  return (
    <li className={styles.nfRow}>
      <div className={styles.nfRowMain}>
        <span className={styles.nfName}>{resource.name}</span>
        <span className={styles.nfType}>{resource.typeLabel}</span>
        {resource.retired ? <span className={styles.chipRetired}>{t('ops_lifecycle_retired')}</span> : null}
        {!resource.isNetworkFunction ? <span className={styles.chipMuted}>{t('ops_kind_non_nf')}</span> : null}
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

  // Authoritative bounded association lookup for exactly the loaded resources.
  const resourceIds = useMemo(() => {
    const ids = (resourcesRead.data?.resources ?? [])
      .map((resource) => {
        const record = (resource ?? {}) as Record<string, unknown>;
        const value = record._id ?? record.resourceId;
        return typeof value === 'string' ? value : '';
      })
      .filter(Boolean);
    return ids;
  }, [resourcesRead.data]);

  const associationPath = resourceIds.length > 0
    ? `/api/nf-health/targets?resourceIds=${encodeURIComponent(resourceIds.join(','))}`
    : null;
  const associationsRead = useRead<TargetListPayload>(associationPath);

  const [expanded, setExpanded] = useState<Record<string, boolean>>({ epc: true, '5gc': true });

  const refresh = useCallback(() => {
    void resourcesRead.mutate();
    if (associationPath) void associationsRead.mutate();
  }, [resourcesRead, associationsRead, associationPath]);

  // Bounded, cancellation-aware refresh: one timer, cleared on unmount, and it
  // never fires while a previous request is still in flight.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!resourcesRead.isValidating && !associationsRead.isValidating) refresh();
    }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refresh, resourcesRead.isValidating, associationsRead.isValidating]);

  const completeness: CompletenessReport = useMemo(() => {
    const inventory: DimensionCompleteness = resourcesRead.error
      ? 'unavailable'
      : resourcesRead.data
        ? (resourcesRead.data.page?.hasMore ? 'partial' : 'complete')
        : 'partial';
    const monitoring: DimensionCompleteness = !resourceIds.length
      ? (resourcesRead.error ? 'unavailable' : 'partial')
      : associationsRead.error
        ? 'unavailable'
        : associationsRead.data
          ? 'complete'
          : 'partial';
    const targets = associationsRead.data?.targets ?? [];
    const telemetryFailed = targets.some((target) => {
      const record = (target ?? {}) as Record<string, unknown>;
      return record.statusComplete === false;
    });
    const telemetry: DimensionCompleteness = monitoring !== 'complete'
      ? monitoring
      : telemetryFailed
        ? 'partial'
        : 'complete';
    // The overview renders no hierarchy, so it makes no topology claim.
    return combineCompleteness({ inventory, monitoring, telemetry, topology: 'complete' });
  }, [resourcesRead.data, resourcesRead.error, associationsRead.data, associationsRead.error, resourceIds.length]);

  const { items, groups, summary } = useMemo(() => {
    const associationResolved = !associationsRead.error && Boolean(associationsRead.data);
    const joined = buildOperationalResources(
      resourcesRead.data?.resources,
      associationsRead.data?.targets,
      associationResolved,
    );
    const enriched = applyResolvedNFTypes(joined.items, associationsRead.data?.targets);
    return {
      items: enriched,
      groups: groupByDomain(enriched, completeness),
      summary: summarizeOperational(enriched, completeness),
    };
  }, [resourcesRead.data, associationsRead.data, associationsRead.error, completeness]);

  const loading = (resourcesRead.isLoading || associationsRead.isLoading) && items.length === 0;
  const failed = Boolean(resourcesRead.error);

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
          <span className={`${styles.completeness} ${summary.completeness.overall === 'complete' ? styles.toneHealthy : summary.completeness.overall === 'unavailable' ? styles.toneDanger : styles.toneWarning}`}>
            {completenessLabel(summary.completeness.overall, t)}
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
              <p className={styles.cardHint}>
                {t('ops_card_population_hint', { logical: summary.logicalFunctions, instances: summary.instances })}
              </p>
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
              <h3 className={styles.cardTitle}>{t('ops_card_unresolved')}</h3>
              <p className={styles.cardValue}>{summary.unresolved}</p>
              <p className={styles.cardHint}>{t('ops_card_unresolved_hint')}</p>
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

          <div className={styles.completenessStrip} role="list">
            {(['inventory', 'monitoring', 'telemetry'] as const).map((dimension) => (
              <span key={dimension} className={styles.completenessItem} role="listitem">
                {t(`ops_dimension_${dimension}`)}: {completenessLabel(summary.completeness[dimension], t)}
              </span>
            ))}
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
