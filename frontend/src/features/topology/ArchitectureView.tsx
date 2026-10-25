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
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
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
  ARCHITECTURE_TONES,
  LINK_EVIDENCE_ORDER,
  bindingLabelKey,
  countArchitectureTones,
  countLinkEvidence,
  domainLabelKey,
  filterArchitecture,
  resolveArchitecture,
  stateLabelKey,
  summarizeArchitecture,
  type ArchitectureLinkEvidence,
  type ArchitectureNodeView,
  type NodeTone,
} from './architecture-model';
import {
  ARCHITECTURE_ROLE_TOKENS,
  ARCHITECTURE_VIEW_MODES,
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  architectureLanesForView,
  architectureNodesForView,
  type ArchitectureViewMode,
} from './reference-architecture';
import { ArchitectureCanvas } from './components/ArchitectureCanvas';
import { ArchitectureRoleDetail } from './components/ArchitectureDetailDrawer';
import { TopologyCanvasControls, TopologyGraphToolbar } from './components/TopologyGraphToolbar';
import { TopologyInspector } from './components/TopologyInspector';
import { TopologyAnnouncer } from './components/TopologyAnnouncer';
import type { RuntimeObservations } from '../runtime/runtime-types';
import { resolveRuntimeObservations, useRuntimeStream } from '../runtime/use-runtime-stream';
import styles from '../../styles/modules/architecture.module.css';

const REFRESH_INTERVAL_MS = 30000;
const ARCHITECTURE_RESOURCE_LIMIT = 200;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 1.75;
const ZOOM_STEP = 0.15;

const VIEW_LABEL_KEY: Record<ArchitectureViewMode, string> = {
  all: 'arch_view_all',
  epc: 'arch_view_epc',
  '5gc-sa': 'arch_view_5gc_sa',
  '5gc-nsa': 'arch_view_5gc_nsa',
};

const OVERVIEW_VIEWS = ['epc', '5gc-sa', '5gc-nsa'] as const;

const OVERVIEW_DESC_KEY: Record<typeof OVERVIEW_VIEWS[number], string> = {
  epc: 'arch_overview_epc_desc',
  '5gc-sa': 'arch_overview_5gc_sa_desc',
  '5gc-nsa': 'arch_overview_5gc_nsa_desc',
};

const ATTENTION_TONES = new Set<NodeTone>(['degraded', 'unhealthy', 'stale', 'unknown', 'unresolved']);

/* The compact legend renders only tones that occur in the visible projection;
 * the full vocabulary stays behind the "legend" dialog. */
const FULL_TONES: NodeTone[] = [...ARCHITECTURE_TONES];

/* Binding states already have their own summary chips. Keep the state legend
 * focused on monitoring/identity states so a tone is not counted twice. */
const LEGEND_ONLY_TONES = new Set<NodeTone>(['ambiguous', 'observed', 'unregistered']);

const INCOMPLETE_DIMENSIONS = ['inventory', 'monitoring', 'telemetry', 'topology'] as const;

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

/* Shape and border style are a second carrier next to colour, so a state stays
 * distinguishable without relying on hue alone. */
function toneMarkClass(tone: NodeTone): string {
  const map: Record<NodeTone, string> = {
    healthy: styles.legendMarkHealthy,
    degraded: styles.legendMarkDegraded,
    unhealthy: styles.legendMarkUnhealthy,
    stale: styles.legendMarkStale,
    unknown: styles.legendMarkUnknown,
    unmonitored: styles.legendMarkUnmonitored,
    unresolved: styles.legendMarkUnresolved,
    ambiguous: styles.legendMarkAmbiguous,
    observed: styles.legendMarkObserved,
    unregistered: styles.legendMarkUnregistered,
  };
  return map[tone] ?? styles.legendMarkUnknown;
}

function ToneMark({ tone }: { tone: NodeTone }) {
  return (
    <span
      className={`${styles.legendMark} ${toneClass(tone)} ${toneMarkClass(tone)}`}
      aria-hidden="true"
    />
  );
}

function summaryToneClass(tone: NodeTone): string | undefined {
  if (tone === 'unhealthy') return styles.summaryDanger;
  if (tone === 'degraded' || tone === 'stale' || tone === 'ambiguous' || tone === 'observed') {
    return styles.summaryWarn;
  }
  return undefined;
}

function evidenceLabelKey(evidence: ArchitectureLinkEvidence): string {
  return `arch_evidence_${evidence}`;
}

function evidenceLineClass(evidence: ArchitectureLinkEvidence): string {
  const map: Record<ArchitectureLinkEvidence, string> = {
    declared: styles.evidenceLineDeclared,
    bound: styles.evidenceLineBound,
    observed: styles.evidenceLineObserved,
    unresolved: styles.evidenceLineUnresolved,
    reference: styles.evidenceLineReference,
  };
  return map[evidence];
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

export function ArchitectureView({
  embedded = false,
  initialView = '5gc-sa',
}: {
  embedded?: boolean;
  initialView?: ArchitectureViewMode;
}) {
  const { t } = useI18n();
  const [view, setView] = useState<ArchitectureViewMode>(initialView);
  const [selectedRole, setSelectedRole] = useState<string | undefined>(undefined);
  const [legendOpen, setLegendOpen] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [focusedRole, setFocusedRole] = useState<string | undefined>(undefined);
  const [focusedLinkKey, setFocusedLinkKey] = useState<string | undefined>(undefined);
  const [zoom, setZoom] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [panning, setPanning] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const triggerRoleRef = useRef<{ role: string; element?: Element | null } | undefined>(undefined);
  const autoFitRef = useRef(false);
  const panRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    scrollLeft: number;
    scrollTop: number;
  } | null>(null);

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
  useRegisterOperationsRefresh(
    embedded ? 'topology:actual:suggested' : 'topology:architecture',
    refresh,
  );

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
      nodes: architectureNodesForView(view === 'all' ? '5gc-sa' : view),
    }),
    [items, runtimeData, edges.edges, view],
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
  const visibleSummary = useMemo(() => summarizeArchitecture(visible.nodes), [visible.nodes]);
  const toneCounts = useMemo(() => countArchitectureTones(visible.nodes), [visible.nodes]);
  const stateTones = useMemo(
    () => toneCounts.filter(({ tone }) => !LEGEND_ONLY_TONES.has(tone)),
    [toneCounts],
  );
  const evidenceCounts = useMemo(() => countLinkEvidence(visible.links), [visible.links]);
  const overviewCards = useMemo(() => OVERVIEW_VIEWS.map((candidate) => {
    const scoped = filterArchitecture(projection, candidate);
    const scopedSummary = summarizeArchitecture(scoped.nodes);
    const attention = countArchitectureTones(scoped.nodes)
      .filter(({ tone }) => ATTENTION_TONES.has(tone))
      .reduce((total, entry) => total + entry.count, 0);
    return {
      view: candidate,
      roles: scoped.nodes.length,
      bound: scopedSummary.bound,
      observed: scopedSummary.observedUnmanaged,
      monitored: scopedSummary.monitored,
      attention,
    };
  }), [projection]);
  const lanes = useMemo(
    () => (view === 'all' ? [] : architectureLanesForView(view)),
    [view],
  );
  const incompleteSources = INCOMPLETE_DIMENSIONS.filter(
    (dimension) => completeness[dimension] !== 'complete',
  );
  const announcement = useMemo(() => {
    if (loading) return t('topology_announce_loading');
    if (failed) return t('topology_announce_unavailable');
    if (selected) return t('topology_announce_selected_role', { name: selected.label });
    const loaded = t('topology_announce_loaded', {
      nodes: visible.nodes.length,
      links: visible.links.length,
      filters: t(VIEW_LABEL_KEY[view]),
    });
    const partial = completeness.overall !== 'complete'
      ? `${t('topology_announce_partial', { nodes: visible.nodes.length, links: visible.links.length })} `
      : '';
    return `${partial}${loaded}${visible.hiddenCount > 0
      ? ` ${t('topology_announce_hidden', { nodes: visible.hiddenCount, links: 0 })}`
      : ''}`;
  }, [loading, failed, selected, visible.nodes.length, visible.links.length, visible.hiddenCount, view, completeness.overall, t]);

  const scrollToOrigin = useCallback(() => {
    const viewport = canvasRef.current;
    if (!viewport) return;
    viewport.scrollLeft = 0;
    viewport.scrollTop = 0;
  }, []);

  const fitView = useCallback(() => {
    const viewport = canvasRef.current;
    if (!viewport) {
      setZoom(1);
      return;
    }
    const computed = window.getComputedStyle(viewport);
    const paddingX = (Number.parseFloat(computed.paddingLeft) || 0) + (Number.parseFloat(computed.paddingRight) || 0);
    const paddingY = (Number.parseFloat(computed.paddingTop) || 0) + (Number.parseFloat(computed.paddingBottom) || 0);
    const availableWidth = viewport.clientWidth - paddingX - 2;
    const availableHeight = viewport.clientHeight - paddingY - 2;
    const scale = Math.min(1, availableWidth / CANVAS_WIDTH, availableHeight / CANVAS_HEIGHT);
    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Number(scale.toFixed(2))));
    autoFitRef.current = true;
    viewport.scrollLeft = 0;
    viewport.scrollTop = 0;
    setZoom(next);
  }, []);

  useEffect(() => {
    const onResize = () => {
      if (autoFitRef.current) fitView();
    };
    const onFullscreenChange = () => {
      setFullscreen(document.fullscreenElement === canvasRef.current);
      if (autoFitRef.current) window.requestAnimationFrame(fitView);
    };
    window.addEventListener('resize', onResize);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => {
      window.removeEventListener('resize', onResize);
      document.removeEventListener('fullscreenchange', onFullscreenChange);
    };
  }, [fitView]);

  useEffect(() => {
    if (!fullscreen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      void document.exitFullscreen?.();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [fullscreen]);

  const updateZoom = (delta: number) => {
    autoFitRef.current = false;
    setZoom((current) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number((current + delta).toFixed(2)))));
  };
  const resetView = () => {
    autoFitRef.current = false;
    setZoom(1);
    setSelectedRole(undefined);
    setFocusedRole(undefined);
    setFocusedLinkKey(undefined);
    triggerRoleRef.current = undefined;
    scrollToOrigin();
  };
  const revealAllRoles = () => {
    setView('all');
    setSelectedRole(undefined);
    setFocusedRole(undefined);
    setFocusedLinkKey(undefined);
    triggerRoleRef.current = undefined;
    scrollToOrigin();
  };
  const restoreRoleFocus = useCallback(() => {
    const trigger = triggerRoleRef.current;
    triggerRoleRef.current = undefined;
    if (!trigger) return;
    if (trigger.element instanceof Element && trigger.element.isConnected) {
      (trigger.element as HTMLElement).focus?.();
      return;
    }
    window.requestAnimationFrame(() => {
      canvasRef.current?.querySelector<SVGElement>(`[data-role="${trigger.role}"]`)?.focus();
    });
  }, []);
  const closeRoleInspector = useCallback(() => {
    setSelectedRole(undefined);
    restoreRoleFocus();
  }, [restoreRoleFocus]);
  const openRoleInspector = useCallback((role: string) => {
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    triggerRoleRef.current = {
      role,
      element: active && active !== document.body ? active : null,
    };
    setSelectedRole(role);
  }, []);
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen?.();
    } else {
      void canvasRef.current?.requestFullscreen?.();
    }
  }, []);

  /* Dragging the empty canvas pans the viewport. Presses that start on a role
   * keep their own selection and keyboard behaviour. */
  const beginPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'mouse' || event.button !== 0) return;
    const target = event.target as Element | null;
    if (target?.closest('[data-role], a, button, input, select, textarea')) return;
    const viewport = canvasRef.current;
    if (!viewport) return;
    panRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: viewport.scrollLeft,
      scrollTop: viewport.scrollTop,
    };
    viewport.setPointerCapture?.(event.pointerId);
    setPanning(true);
  };
  const movePan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    const viewport = canvasRef.current;
    if (!viewport) return;
    viewport.scrollLeft = pan.scrollLeft - (event.clientX - pan.startX);
    viewport.scrollTop = pan.scrollTop - (event.clientY - pan.startY);
  };
  const endPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    panRef.current = null;
    setPanning(false);
    const viewport = canvasRef.current;
    if (viewport?.hasPointerCapture?.(event.pointerId)) {
      viewport.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <section
      className={styles.section}
      aria-labelledby="architecture-title"
      data-architecture-embedded={embedded ? 'true' : undefined}
    >
      <h2 id="architecture-title" className="sr-only">{t('arch_title')}</h2>
      <TopologyAnnouncer message={announcement} />

      {loading ? (
        <div className={styles.statePanel} data-state-panel="loading">
          <LoadingRows rows={4} />
        </div>
      ) : failed ? (
        <div className={styles.statePanel} data-state-panel="unavailable" data-state-source="operations-resources">
          <EmptyState
            icon={<Layers size={40} />}
            title={t('arch_error_title')}
            description={t('arch_error_body')}
            action={(
              <button type="button" className="btn btn-secondary" onClick={refresh}>
                {t('retry')}
              </button>
            )}
          />
          <p className={styles.stateSource}>{t('arch_unavailable_source')}</p>
        </div>
      ) : (
        <>
          <TopologyGraphToolbar
            filters={(
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
                      setFocusedRole(undefined);
                      setFocusedLinkKey(undefined);
                      triggerRoleRef.current = undefined;
                      scrollToOrigin();
                    }}
                  >
                    {t(VIEW_LABEL_KEY[mode])}
                  </button>
                ))}
              </div>
            )}
          />

          <div className={styles.toolbar}>
            <div className={styles.summaryStrip} role="list">
              <span role="listitem"><strong>{visibleSummary.bound}</strong> {t('arch_summary_bound')}</span>
              <span role="listitem"><strong>{visibleSummary.unbound}</strong> {t('arch_summary_unbound')}</span>
              {visibleSummary.ambiguous > 0 ? (
                <span role="listitem" className={styles.summaryWarn} data-summary-binding="ambiguous">
                  <strong>{visibleSummary.ambiguous}</strong> {t('arch_binding_ambiguous')}
                </span>
              ) : null}
              {visibleSummary.observedUnmanaged > 0 ? (
                <span role="listitem" className={styles.summaryWarn} data-summary-binding="observed">
                  <strong>{visibleSummary.observedUnmanaged}</strong> {t('arch_summary_observed')}
                </span>
              ) : null}
              {visibleSummary.monitored > 0 ? (
                <span role="listitem" data-summary-monitored={visibleSummary.monitored}>
                  <strong>{visibleSummary.monitored}</strong> {t('arch_summary_monitored')}
                </span>
              ) : null}
              {stateTones.map(({ tone, count }) => (
                <span
                  key={tone}
                  role="listitem"
                  className={summaryToneClass(tone)}
                  data-summary-tone={tone}
                >
                  <ToneMark tone={tone} />
                  {t(stateLabelKey(tone))} <strong>{count}</strong>
                </span>
              ))}
            </div>
            <span
              className={`${styles.completeness} ${completeness.overall === 'complete' ? styles.toneHealthy : completeness.overall === 'unavailable' ? styles.toneUnhealthy : styles.toneStale}`}
              data-completeness={completeness.overall}
              role="status"
            >
              {t(`ops_completeness_${completeness.overall}`)}
            </span>
          </div>

          <div
            className={styles.archWorkspace}
            data-inspector-open={selected ? 'true' : undefined}
          >
            <div className={styles.archWorkspaceMain}>
              {/*
                * Same placement as the other graph sources: navigation belongs to
                * the surface it acts on and must not spend a toolbar row.
               */}
              {view !== 'all' ? (
                <TopologyCanvasControls
                  className={styles.actualCanvasControls}
                  zoom={{
                    value: zoom,
                    min: MIN_ZOOM,
                    max: MAX_ZOOM,
                    onIn: () => updateZoom(ZOOM_STEP),
                    onOut: () => updateZoom(-ZOOM_STEP),
                    onFit: fitView,
                    onReset: resetView,
                  }}
                  fullscreen={{ active: fullscreen, onToggle: toggleFullscreen }}
                />
              ) : null}
          {view !== 'all' ? (
            <div className={styles.legendCompact}>
              <span
                className={styles.legendCompactGroup}
                role="group"
                aria-label={t('arch_legend_states')}
                data-state-legend="true"
              >
                {toneCounts.map(({ tone, count }) => (
                  <span key={tone} className={styles.legendItem} data-legend-tone={tone}>
                    <ToneMark tone={tone} />
                    {t(stateLabelKey(tone))} <span className={styles.legendCount}>{count}</span>
                  </span>
                ))}
              </span>
              <span
                className={styles.legendCompactGroup}
                role="group"
                aria-label={t('arch_evidence_label')}
                data-evidence-legend="true"
              >
                {evidenceCounts.map(({ evidence, count }) => (
                  <span key={evidence} className={styles.legendItem} data-evidence={evidence}>
                    <i className={`${styles.evidenceLine} ${evidenceLineClass(evidence)}`} aria-hidden="true" />
                    {t(evidenceLabelKey(evidence))} <span className={styles.legendCount}>{count}</span>
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
          ) : null}

          {completeness.overall !== 'complete' ? (
            <div
              className={styles.completenessNote}
              data-completeness-note={completeness.overall}
              role="status"
            >
              <span>
                {t('arch_completeness_note', {
                  sources: incompleteSources
                    .map((dimension) => `${t(`arch_dimension_${dimension}`)} ${t(`ops_completeness_${completeness[dimension]}`)}`)
                    .join(' · '),
                })}
                {edges.coverage === 'partial'
                  ? ` ${edges.coverageReason === 'page_limit'
                    ? t('arch_topology_partial_page_limit')
                    : t('arch_topology_partial_read_error')}`
                  : null}
              </span>
              <button
                type="button"
                className="btn btn-secondary"
                data-action="retry-partial"
                onClick={refresh}
              >
                {t('retry')}
              </button>
            </div>
          ) : null}

          {view !== 'all' && visible.hiddenCount > 0 ? (
            <div className={styles.hiddenNote} data-hidden-roles={visible.hiddenCount}>
              <span>{t('arch_hidden_note', { count: visible.hiddenCount })}</span>
              <button
                type="button"
                className={styles.legendToggle}
                data-action="show-hidden-roles"
                onClick={() => {
                  revealAllRoles();
                  setListOpen(true);
                }}
              >
                {t('arch_hidden_show')}
              </button>
              <button
                type="button"
                className={styles.legendToggle}
                data-action="clear-view-filter"
                onClick={revealAllRoles}
              >
                {t('arch_hidden_clear')}
              </button>
            </div>
          ) : null}

          {view === 'all' ? (
            <div className={styles.overviewGrid} data-architecture-overview="true">
              {overviewCards.map((card) => (
                <button
                  key={card.view}
                  type="button"
                  className={styles.overviewCard}
                  data-overview-view={card.view}
                  onClick={() => {
                    setView(card.view);
                    setSelectedRole(undefined);
                    scrollToOrigin();
                  }}
                >
                  <span className={styles.overviewTitle}>{t(VIEW_LABEL_KEY[card.view])}</span>
                  <span className={styles.overviewDesc}>{t(OVERVIEW_DESC_KEY[card.view])}</span>
                  <span className={styles.overviewStats}>
                    <span><strong>{card.roles}</strong> {t('arch_overview_roles')}</span>
                    <span><strong>{card.bound}</strong> {t('arch_summary_bound')}</span>
                    <span><strong>{card.observed}</strong> {t('arch_summary_observed')}</span>
                    {card.monitored > 0 ? (
                      <span><strong>{card.monitored}</strong> {t('arch_summary_monitored')}</span>
                    ) : null}
                    {card.attention > 0 ? (
                      <span className={styles.summaryWarn}>
                        <strong>{card.attention}</strong> {t('arch_overview_attention')}
                      </span>
                    ) : null}
                  </span>
                  <span className={styles.overviewEnter}>{t('arch_overview_open')}</span>
                </button>
              ))}
            </div>
          ) : (
            <div
              ref={canvasRef}
              className={styles.archCanvasViewport}
              data-architecture-viewport="true"
              data-panning={panning ? 'true' : undefined}
              onPointerDown={beginPan}
              onPointerMove={movePan}
              onPointerUp={endPan}
              onPointerCancel={endPan}
            >
              <div
                className={styles.archCanvasScale}
                style={{ width: `${CANVAS_WIDTH * zoom}px`, height: `${CANVAS_HEIGHT * zoom}px` }}
              >
                <ArchitectureCanvas
                  nodes={visible.nodes}
                  links={visible.links}
                  lanes={lanes}
                  selectedRole={selectedRole}
                  focusedRole={focusedRole}
                  focusedLinkKey={focusedLinkKey}
                  onFocusRole={setFocusedRole}
                  onSelect={(role) => {
                    if (role === selectedRole) {
                      closeRoleInspector();
                      return;
                    }
                    openRoleInspector(role);
                  }}
                />
              </div>
            </div>
          )}

          {/* Equivalent list representation: the same state as the canvas, in
              text, for keyboard and assistive-technology users. */}
          {view !== 'all' && listOpen ? (
            <>
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
                        onFocus={() => setFocusedRole(node.role)}
                        onBlur={() => setFocusedRole(undefined)}
                        onClick={() => openRoleInspector(node.role)}
                      >
                        {t('arch_list_open')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <table className={styles.nodeTable} data-architecture-relationship-list="true">
              <caption className={styles.nodeTableCaption}>{t('topology_list_relationships')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('topology_list_source')}</th>
                  <th scope="col">{t('topology_list_interface')}</th>
                  <th scope="col">{t('topology_list_target')}</th>
                  <th scope="col">{t('topology_list_evidence')}</th>
                  <th scope="col">{t('topology_list_state')}</th>
                </tr>
              </thead>
              <tbody>
                {visible.links.map((link) => {
                  const source = visible.nodes.find((node) => node.role === link.source);
                  const target = visible.nodes.find((node) => node.role === link.target);
                  return (
                    <tr key={link.key} data-architecture-link-row={link.key}>
                      <th scope="row">
                        <button
                          type="button"
                          className={styles.legendToggle}
                          onFocus={() => setFocusedLinkKey(link.key)}
                          onBlur={() => setFocusedLinkKey(undefined)}
                          onClick={() => openRoleInspector(link.source)}
                        >
                          {source?.label || link.source}
                        </button>
                      </th>
                      <td>{link.interfaceLabel}</td>
                      <td>
                        <button
                          type="button"
                          className={styles.legendToggle}
                          onFocus={() => setFocusedLinkKey(link.key)}
                          onBlur={() => setFocusedLinkKey(undefined)}
                          onClick={() => openRoleInspector(link.target)}
                        >
                          {target?.label || link.target}
                        </button>
                      </td>
                      <td>{t(evidenceLabelKey(link.evidence))}</td>
                      <td>{link.endpointsBound ? t('arch_binding_bound') : t('arch_binding_unbound')}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </>
          ) : null}

          <p className={styles.footnote}>
            <Layers size={14} /> {t('arch_coverage_note')}
          </p>
            </div>
            {selected ? (
              <TopologyInspector label={t('arch_detail_title')} onClose={closeRoleInspector}>
                <ArchitectureRoleDetail node={selected} />
              </TopologyInspector>
            ) : null}
          </div>
        </>
      )}

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
                  <ToneMark tone={tone} />
                  {t(stateLabelKey(tone))}
                </span>
              ))}
            </div>
          </section>
          <section className={styles.drawerSection}>
            <h3 className={styles.drawerSectionTitle}>{t('arch_evidence_label')}</h3>
            <div className={styles.legendDialogGroup}>
              {LINK_EVIDENCE_ORDER.map((evidence) => (
                <span key={evidence} className={styles.legendItem}>
                  <i className={`${styles.evidenceLine} ${evidenceLineClass(evidence)}`} aria-hidden="true" />
                  {t(evidenceLabelKey(evidence))}
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
