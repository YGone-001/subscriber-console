/*
 * Architecture view (/topology).
 *
 * Projects the static 3GPP reference skeleton onto the authorities that already
 * exist in this console: Inventory owns the resource, NF Health owns the
 * monitoring association and measured layers, Topology owns the declared
 * relationships, and the runtime scanner supplies process evidence for roles
 * that have no resource yet.
 *
 * No endpoint is added for this surface and nothing is written back: the view is
 * a read-only projection. Every unavailable fact is rendered as an explicit
 * state instead of a zero or a green indicator.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Layers, Network, RefreshCw } from 'lucide-react';
import { useRead } from '../../lib/api/use-read';
import { useI18n } from '../../providers/I18nProvider';
import { EmptyState, LoadingRows } from '../../components/ui/OperationFeedback';
import {
  applyResolvedNFTypes,
  buildOperationalResources,
  formatBytes,
  type DimensionCompleteness,
} from '../operations/operational-model';
import { useBoundedEdges } from '../operations/use-bounded-edges';
import {
  bindingLabelKey,
  domainLabelKey,
  filterArchitecture,
  resolveArchitecture,
  stateLabelKey,
  type ArchitectureNodeView,
} from './architecture-model';
import { ARCHITECTURE_VIEW_MODES, type ArchitectureViewMode } from './reference-architecture';
import { ArchitectureCanvas } from './components/ArchitectureCanvas';
import type { RuntimeObservations } from '../runtime/runtime-types';
import { resolveRuntimeObservations, useRuntimeStream } from '../runtime/use-runtime-stream';
import styles from '../../styles/modules/architecture.module.css';

const RESOURCE_LIMIT = 50;
const REFRESH_INTERVAL_MS = 30000;

type ResourceListPayload = { resources?: unknown[]; page?: { hasMore?: boolean } };
type TargetListPayload = { targets?: unknown[] };

const VIEW_LABEL_KEY: Record<ArchitectureViewMode, string> = {
  all: 'arch_view_all',
  epc: 'arch_view_epc',
  '5gc-sa': 'arch_view_5gc_sa',
  '5gc-nsa': 'arch_view_5gc_nsa',
};

const TONE_ORDER = [
  'healthy', 'degraded', 'unhealthy', 'stale', 'unknown', 'unmonitored', 'unresolved', 'observed', 'unregistered',
] as const;

function toneClass(tone: string): string {
  const map: Record<string, string> = {
    healthy: styles.toneHealthy,
    degraded: styles.toneDegraded,
    unhealthy: styles.toneUnhealthy,
    stale: styles.toneStale,
    unknown: styles.toneUnknown,
    unmonitored: styles.toneUnmonitored,
    unresolved: styles.toneUnresolved,
    observed: styles.toneObserved,
    unregistered: styles.toneUnregistered,
  };
  return map[tone] ?? styles.toneUnknown;
}

function domainClass(domain: string): string {
  const map: Record<string, string> = {
    cp: styles.domainCp,
    sp: styles.domainSp,
    up: styles.domainUp,
    dm: styles.domainDm,
    legacy: styles.domainLegacy,
  };
  return map[domain] ?? styles.domainLegacy;
}

function metricText(
  metric: { value: number; unit: string; fresh: boolean } | null,
  historicalLabel: string,
): string {
  if (!metric) return '';
  return `${metric.value} ${metric.unit}${metric.fresh ? '' : ` (${historicalLabel})`}`;
}

function DetailPanel({ node, onClear }: { node: ArchitectureNodeView | null; onClear: () => void }) {
  const { t } = useI18n();
  if (!node) {
    return (
      <aside className={styles.detail} aria-label={t('arch_detail_title')}>
        <p className={styles.detailHint}>{t('arch_detail_hint')}</p>
      </aside>
    );
  }

  const memory = node.memory ? formatBytes(node.memory.value) : '';
  const cpu = metricText(node.cpu, t('ops_historical'));
  const stateText = t(stateLabelKey(node.tone));

  return (
    <aside className={styles.detail} aria-label={`${t('arch_detail_title')}: ${node.label}`}>
      <header className={styles.detailHead}>
        <span className={`${styles.domainBar} ${domainClass(node.domain)}`} aria-hidden="true" />
        <div>
          <h3 className={styles.detailTitle}>{node.label}</h3>
          <p className={styles.detailSub}>{t(domainLabelKey(node.domain))}</p>
        </div>
        <button type="button" className={styles.detailClose} onClick={onClear} aria-label={t('close')}>
          &times;
        </button>
      </header>

      <dl className={styles.detailList}>
        <div>
          <dt>{t('status')}</dt>
          <dd><span className={`${styles.stateBadge} ${toneClass(node.tone)}`}>{stateText}</span></dd>
        </div>
        <div>
          <dt>{t('arch_detail_binding')}</dt>
          <dd>{t(bindingLabelKey(node.binding))}</dd>
        </div>
        {node.resourceId ? (
          <>
            <div>
              <dt>{t('arch_detail_resource')}</dt>
              <dd>
                <Link to={`/inventory/${encodeURIComponent(node.resourceId)}`}>{node.resourceName}</Link>
              </dd>
            </div>
            <div>
              <dt>{t('arch_detail_lifecycle')}</dt>
              <dd>{node.lifecycleState || '-'}</dd>
            </div>
            <div>
              <dt>{t('arch_detail_coverage')}</dt>
              <dd className={styles.layerRow}>
                {node.coverage ? (
                  <>
                    <span className={node.coverage.l1 ? styles.layerOn : styles.layerOff}>L1</span>
                    <span className={node.coverage.l2 ? styles.layerOn : styles.layerOff}>L2</span>
                    <span className={node.coverage.l3 ? styles.layerOn : styles.layerOff}>L3</span>
                  </>
                ) : t('ops_metric_unavailable')}
              </dd>
            </div>
            <div>
              <dt>{t('arch_detail_memory')}</dt>
              <dd>{memory || t('ops_metric_unavailable')}</dd>
            </div>
            <div>
              <dt>{t('arch_detail_cpu')}</dt>
              <dd>{cpu || t('ops_metric_unavailable')}</dd>
            </div>
            <div>
              <dt>{t('arch_detail_freshness')}</dt>
              <dd>{node.freshness ? t(`ops_state_${node.freshness}`) : t('ops_state_unknown')}</dd>
            </div>
            {node.targetId ? (
              <div>
                <dt>{t('arch_detail_monitoring')}</dt>
                <dd>
                  <Link to={`/nf-health/${encodeURIComponent(node.targetId)}`}>
                    {t('arch_detail_open_monitoring')}
                  </Link>
                </dd>
              </div>
            ) : (
              <div>
                <dt>{t('arch_detail_monitoring')}</dt>
                <dd>
                  <span className={styles.detailMuted}>{t('arch_detail_no_monitoring')}</span>
                  <Link className={styles.detailAction} to="/nf-health">
                    {t('arch_detail_configure_monitoring')}
                  </Link>
                </dd>
              </div>
            )}
          </>
        ) : null}
      </dl>

      {node.observed ? (
        <div className={styles.detailNote}>
          <p>
            <strong>{t('arch_detail_observed_process')}:</strong>{' '}
            <code>{node.observed.processName}</code>
          </p>
          <p>{t('arch_detail_observed_body')}</p>
          <Link className={styles.detailAction} to="/inventory?view=runtime">
            {t('arch_detail_manage')}
          </Link>
        </div>
      ) : null}

      {!node.resourceId && !node.observed ? (
        <div className={styles.detailNote}>
          <p>{t('arch_detail_unbound_body')}</p>
        </div>
      ) : null}

      {node.binding === 'ambiguous' ? (
        <div className={styles.detailNote}>
          <p>{t('arch_detail_ambiguous_body', { count: node.candidateCount })}</p>
        </div>
      ) : null}
    </aside>
  );
}

export function ArchitectureView() {
  const { t } = useI18n();
  const [view, setView] = useState<ArchitectureViewMode>('all');
  const [selectedRole, setSelectedRole] = useState<string | undefined>(undefined);

  const resourcesRead = useRead<ResourceListPayload>(`/api/inventory/resources?limit=${RESOURCE_LIMIT}`);
  const runtimeRead = useRead<RuntimeObservations>('/api/runtime/observations');
  const runtimeStream = useRuntimeStream();
  const runtimeData = resolveRuntimeObservations(runtimeStream, runtimeRead.data);
  const edges = useBoundedEdges();

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

  const refresh = useCallback(() => {
    void resourcesRead.mutate();
    if (associationPath) void associationsRead.mutate();
    void runtimeRead.mutate();
    edges.refresh();
  }, [resourcesRead, associationsRead, runtimeRead, edges, associationPath]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!resourcesRead.isValidating && !associationsRead.isValidating) refresh();
    }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refresh, resourcesRead.isValidating, associationsRead.isValidating]);

  const items = useMemo(() => {
    const associationResolved = !associationsRead.error && Boolean(associationsRead.data);
    const joined = buildOperationalResources(
      resourcesRead.data?.resources,
      associationsRead.data?.targets,
      associationResolved,
    );
    return applyResolvedNFTypes(joined.items, associationsRead.data?.targets);
  }, [resourcesRead.data, associationsRead.data, associationsRead.error]);

  const projection = useMemo(
    () => resolveArchitecture({
      resources: items,
      runtimeComponents: runtimeData?.snapshot?.components,
      edges: edges.edges,
    }),
    [items, runtimeData, edges.edges],
  );

  const visible = useMemo(() => filterArchitecture(projection, view), [projection, view]);
  const selected = visible.nodes.find((node) => node.role === selectedRole)
    ?? projection.nodes.find((node) => node.role === selectedRole)
    ?? null;

  const inventoryCompleteness: DimensionCompleteness = resourcesRead.error
    ? 'unavailable'
    : resourcesRead.data
      ? (resourcesRead.data.page?.hasMore ? 'partial' : 'complete')
      : 'partial';

  const loading = resourcesRead.isLoading && items.length === 0;
  const failed = Boolean(resourcesRead.error);
  const summary = projection.summary;

  return (
    <section className={styles.section} aria-labelledby="architecture-title">
      <div className={styles.sectionHead}>
        <div>
          <h2 id="architecture-title" className={styles.sectionTitle}>
            <Network size={18} /> {t('arch_title')}
          </h2>
          <p className={styles.sectionNote}>{t('arch_note')}</p>
        </div>
        <div className={styles.sectionActions}>
          <span className={`${styles.completeness} ${inventoryCompleteness === 'complete' ? styles.toneHealthy : inventoryCompleteness === 'unavailable' ? styles.toneUnhealthy : styles.toneStale}`}>
            {t(`ops_completeness_${inventoryCompleteness}`)}
          </span>
          <button type="button" className={styles.refresh} onClick={refresh} aria-label={t('ops_refresh')}>
            <RefreshCw size={15} /> {t('ops_refresh')}
          </button>
        </div>
      </div>

      {loading ? (
        <LoadingRows rows={3} />
      ) : failed ? (
        <EmptyState icon={<Network size={40} />} title={t('arch_error_title')} description={t('arch_error_body')} />
      ) : (
        <>
          <div className={styles.toolbar}>
            <div className={styles.viewSwitch} role="group" aria-label={t('arch_view_label')}>
              {ARCHITECTURE_VIEW_MODES.map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={view === mode}
                  className={view === mode ? styles.viewSwitchActive : undefined}
                  onClick={() => {
                    setView(mode);
                    setSelectedRole(undefined);
                  }}
                >
                  {t(VIEW_LABEL_KEY[mode])}
                </button>
              ))}
            </div>
            <div className={styles.summaryStrip} role="list">
              <span role="listitem"><strong>{summary.bound}</strong> {t('arch_summary_bound')}</span>
              <span role="listitem"><strong>{summary.unbound}</strong> {t('arch_summary_unbound')}</span>
              <span role="listitem" className={summary.observedUnmanaged > 0 ? styles.summaryWarn : undefined}>
                <strong>{summary.observedUnmanaged}</strong> {t('arch_summary_observed')}
              </span>
              <span role="listitem"><strong>{summary.monitored}</strong> {t('arch_summary_monitored')}</span>
              <span role="listitem" className={summary.degraded > 0 ? styles.summaryWarn : undefined}>
                <strong>{summary.degraded}</strong> {t('arch_summary_degraded')}
              </span>
              <span role="listitem" className={summary.unhealthy > 0 ? styles.summaryDanger : undefined}>
                <strong>{summary.unhealthy}</strong> {t('arch_summary_unhealthy')}
              </span>
            </div>
          </div>

          <div className={styles.legendRow}>
            <span className={styles.legendGroup}>
              {(['cp', 'sp', 'up', 'dm', 'legacy'] as const).map((domain) => (
                <span key={domain} className={styles.legendItem}>
                  <span className={`${styles.legendSwatch} ${domainClass(domain)}`} aria-hidden="true" />
                  {t(domainLabelKey(domain))}
                </span>
              ))}
            </span>
            <span className={styles.legendDivider} aria-hidden="true" />
            <span className={styles.legendGroup}>
              {TONE_ORDER.map((tone) => (
                <span key={tone} className={styles.legendItem}>
                  <span className={`${styles.legendDot} ${toneClass(tone)}`} aria-hidden="true" />
                  {t(stateLabelKey(tone))}
                </span>
              ))}
            </span>
          </div>

          {visible.hiddenCount > 0 ? (
            <p className={styles.hiddenNote}>{t('arch_hidden_note', { count: visible.hiddenCount })}</p>
          ) : null}

          <div className={styles.body}>
            <ArchitectureCanvas
              nodes={visible.nodes}
              links={visible.links}
              selectedRole={selectedRole}
              onSelect={(role) => setSelectedRole((current) => (current === role ? undefined : role))}
            />
            <DetailPanel node={selected} onClear={() => setSelectedRole(undefined)} />
          </div>

          <p className={styles.footnote}>
            <Layers size={14} /> {t('arch_coverage_note')}
          </p>
        </>
      )}
    </section>
  );
}

export default ArchitectureView;
