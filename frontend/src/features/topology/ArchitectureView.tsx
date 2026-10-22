/*
 * Architecture view (/topology?view=architecture).
 *
 * Projects the static 3GPP reference skeleton onto the authorities that already
 * exist in this console: Inventory owns the resource, NF Health owns the
 * monitoring association and measured layers, Topology owns the declared
 * relationships, and the runtime scanner supplies process evidence for roles
 * that have no resource yet.
 *
 * UX-3 changes:
 *   - the resources are read through `GET /api/operations/resources?roles=...`
 *     with every canonical role token of the skeleton, so the projection is not
 *     limited to an arbitrary first page of Inventory;
 *   - the canvas is the only primary surface on this view; the detail moved into
 *     an overlay drawer and the legend collapsed into one line plus a dialog;
 *   - an ambiguous role claims no binding and lists its candidates instead of
 *     silently binding the first one.
 *
 * Nothing is written back: the view is a read-only projection. Every unavailable
 * fact is rendered as an explicit state instead of a zero or a green indicator.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Layers } from 'lucide-react';
import { useRead } from '../../lib/api/use-read';
import { useI18n } from '../../providers/I18nProvider';
import { EmptyState, LoadingRows } from '../../components/ui/OperationFeedback';
import { Dialog } from '../../components/ui/Dialog';
import { useBoundedEdges } from '../operations/use-bounded-edges';
import { useRegisterOperationsRefresh } from '../operations/operations-refresh';
import {
  adaptCompleteness,
  adaptOperationsResources,
  operationsResourcesPath,
  type OperationsResourcesResponse,
} from '../operations/operations-resources';
import {
  bindingLabelKey,
  domainLabelKey,
  filterArchitecture,
  resolveArchitecture,
  stateLabelKey,
  type ArchitectureNodeView,
  type NodeTone,
} from './architecture-model';
import {
  ARCHITECTURE_ROLE_TOKENS,
  ARCHITECTURE_VIEW_MODES,
  type ArchitectureViewMode,
} from './reference-architecture';
import { ArchitectureCanvas } from './components/ArchitectureCanvas';
import { ArchitectureDetailDrawer } from './components/ArchitectureDetailDrawer';
import type { RuntimeObservations } from '../runtime/runtime-types';
import { resolveRuntimeObservations, useRuntimeStream } from '../runtime/use-runtime-stream';
import styles from '../../styles/modules/architecture.module.css';

const REFRESH_INTERVAL_MS = 30000;
const ARCHITECTURE_RESOURCE_LIMIT = 200;

const VIEW_LABEL_KEY: Record<ArchitectureViewMode, string> = {
  all: 'arch_view_all',
  epc: 'arch_view_epc',
  '5gc-sa': 'arch_view_5gc_sa',
  '5gc-nsa': 'arch_view_5gc_nsa',
};

/* The collapsed legend keeps the states an operator actually triages on. The
 * full vocabulary lives behind the "legend" dialog. */
const COMPACT_TONES: NodeTone[] = ['healthy', 'degraded', 'unhealthy', 'ambiguous', 'unmonitored'];

const FULL_TONES: NodeTone[] = [
  'healthy', 'degraded', 'unhealthy', 'stale', 'unknown',
  'ambiguous', 'unmonitored', 'unresolved', 'observed', 'unregistered',
];

const DOMAINS = ['cp', 'sp', 'up', 'dm', 'legacy'] as const;

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
    ambiguous: styles.toneAmbiguous,
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

export function ArchitectureView() {
  const { t } = useI18n();
  const [view, setView] = useState<ArchitectureViewMode>('5gc-sa');
  const [selectedRole, setSelectedRole] = useState<string | undefined>(undefined);
  const [legendOpen, setLegendOpen] = useState(false);
  const [listOpen, setListOpen] = useState(false);

  // One bounded projection read: every skeleton role in a single request, with
  // the authoritative monitoring association resolved server-side.
  const resourcesRead = useRead<OperationsResourcesResponse>(
    operationsResourcesPath({ roles: ARCHITECTURE_ROLE_TOKENS, limit: ARCHITECTURE_RESOURCE_LIMIT }),
  );
  const runtimeRead = useRead<RuntimeObservations>('/api/runtime/observations');
  const runtimeStream = useRuntimeStream();
  const runtimeData = resolveRuntimeObservations(runtimeStream, runtimeRead.data);
  const edges = useBoundedEdges();

  const refresh = useCallback(() => {
    void resourcesRead.mutate();
    void runtimeRead.mutate();
    edges.refresh();
  }, [resourcesRead, runtimeRead, edges]);

  // UX-1: the page frame owns the only visible refresh entry.
  useRegisterOperationsRefresh('topology:architecture', refresh);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!resourcesRead.isValidating) refresh();
    }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refresh, resourcesRead.isValidating]);

  const items = useMemo(() => adaptOperationsResources(resourcesRead.data), [resourcesRead.data]);

  const completeness = useMemo(
    () => adaptCompleteness(resourcesRead.data?.completeness, edges.coverage, Boolean(resourcesRead.error)),
    [resourcesRead.data, edges.coverage, resourcesRead.error],
  );

  const projection = useMemo(
    () => resolveArchitecture({
      resources: items,
      runtimeComponents: runtimeData?.snapshot?.components,
      edges: edges.edges,
    }),
    [items, runtimeData, edges.edges],
  );

  const visible = useMemo(() => filterArchitecture(projection, view), [projection, view]);
  const selected: ArchitectureNodeView | null = useMemo(() => {
    if (!selectedRole) return null;
    return visible.nodes.find((node) => node.role === selectedRole)
      ?? projection.nodes.find((node) => node.role === selectedRole)
      ?? null;
  }, [visible.nodes, projection.nodes, selectedRole]);

  const loading = resourcesRead.isLoading && items.length === 0;
  const failed = Boolean(resourcesRead.error);
  const summary = projection.summary;

  return (
    <section className={styles.section} aria-labelledby="architecture-title">
      <h2 id="architecture-title" className="sr-only">{t('arch_title')}</h2>

      {loading ? (
        <LoadingRows rows={4} />
      ) : failed ? (
        <EmptyState
          icon={<Layers size={40} />}
          title={t('arch_error_title')}
          description={t('arch_error_body')}
        />
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
              <span role="listitem" className={summary.ambiguous > 0 ? styles.summaryWarn : undefined}>
                <strong>{summary.ambiguous}</strong> {t('arch_binding_ambiguous')}
              </span>
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
            <span className={`${styles.completeness} ${completeness.overall === 'complete' ? styles.toneHealthy : completeness.overall === 'unavailable' ? styles.toneUnhealthy : styles.toneStale}`}>
              {t(`ops_completeness_${completeness.overall}`)}
            </span>
          </div>

          <div className={styles.legendCompact}>
            <span className={styles.legendCompactGroup}>
              {COMPACT_TONES.map((tone) => (
                <span key={tone} className={styles.legendItem}>
                  <span className={`${styles.legendDot} ${toneClass(tone)}`} aria-hidden="true" />
                  {t(stateLabelKey(tone))}
                </span>
              ))}
            </span>
            <button type="button" className={styles.legendToggle} onClick={() => setLegendOpen(true)}>
              {t('arch_legend_toggle')}
            </button>
            <button
              type="button"
              className={styles.legendToggle}
              aria-expanded={listOpen}
              onClick={() => setListOpen((open) => !open)}
            >
              {t('arch_list_toggle')}
            </button>
          </div>

          {visible.hiddenCount > 0 ? (
            <p className={styles.hiddenNote}>{t('arch_hidden_note', { count: visible.hiddenCount })}</p>
          ) : null}

          <div className={`${styles.canvasWrap} ${styles.canvasWrapFull}`}>
            <ArchitectureCanvas
              nodes={visible.nodes}
              links={visible.links}
              selectedRole={selectedRole}
              onSelect={(role) => setSelectedRole((current) => (current === role ? undefined : role))}
            />
          </div>

          {/* Equivalent list representation: the same state as the canvas, in
              text, for keyboard and assistive-technology users. */}
          {listOpen ? (
            <table className={styles.nodeTable}>
              <caption className={styles.nodeTableCaption}>{t('arch_canvas_aria')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('arch_list_role')}</th>
                  <th scope="col">{t('arch_legend_domains')}</th>
                  <th scope="col">{t('arch_list_state')}</th>
                  <th scope="col">{t('arch_list_binding')}</th>
                  <th scope="col">{t('arch_list_open')}</th>
                </tr>
              </thead>
              <tbody>
                {visible.nodes.map((node) => (
                  <tr key={node.role}>
                    <th scope="row">{node.label}</th>
                    <td>{t(domainLabelKey(node.domain))}</td>
                    <td>
                      <span className={`${styles.stateBadge} ${toneClass(node.tone)}`}>
                        {t(stateLabelKey(node.tone))}
                      </span>
                    </td>
                    <td>{t(bindingLabelKey(node.binding))}</td>
                    <td>
                      <button
                        type="button"
                        className={styles.legendToggle}
                        onClick={() => setSelectedRole(node.role)}
                      >
                        {t('arch_list_open')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}

          <p className={styles.footnote}>
            <Layers size={14} /> {t('arch_coverage_note')}
          </p>
        </>
      )}

      <ArchitectureDetailDrawer node={selected} onClose={() => setSelectedRole(undefined)} />

      <Dialog
        open={legendOpen}
        onClose={() => setLegendOpen(false)}
        overlayClassName="modal-overlay"
        className="modal-content animate-fade-in"
        labelledBy="architecture-legend-title"
      >
        <h2 id="architecture-legend-title" className={styles.detailTitle}>{t('arch_legend_title')}</h2>
        <div className={styles.legendDialog}>
          <section className={styles.drawerSection}>
            <h3 className={styles.drawerSectionTitle}>{t('arch_legend_domains')}</h3>
            <div className={styles.legendDialogGroup}>
              {DOMAINS.map((domain) => (
                <span key={domain} className={styles.legendItem}>
                  <span className={`${styles.legendSwatch} ${domainClass(domain)}`} aria-hidden="true" />
                  {t(domainLabelKey(domain))}
                </span>
              ))}
            </div>
          </section>
          <section className={styles.drawerSection}>
            <h3 className={styles.drawerSectionTitle}>{t('arch_legend_states')}</h3>
            <div className={styles.legendDialogGroup}>
              {FULL_TONES.map((tone) => (
                <span key={tone} className={styles.legendItem}>
                  <span className={`${styles.legendDot} ${toneClass(tone)}`} aria-hidden="true" />
                  {t(stateLabelKey(tone))}
                </span>
              ))}
            </div>
          </section>
          <p className={styles.viewNote}>{t('arch_note')}</p>
        </div>
      </Dialog>
    </section>
  );
}

export default ArchitectureView;
