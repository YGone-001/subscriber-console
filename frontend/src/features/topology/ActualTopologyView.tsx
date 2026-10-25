/*
 * Declared topology as the primary topology view.
 *
 * This surface reads only active, authoritative Topology edges and resolves
 * their endpoint identities through Inventory. The reference architecture is
 * intentionally kept in its own view so it cannot be mistaken for deployment
 * evidence.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  GitBranch,
  Layers,
  RefreshCw,
  Search,
} from 'lucide-react';
import { useI18n } from '../../providers/I18nProvider';
import { TopologyCanvasControls } from './components/TopologyGraphToolbar';
import { Link } from 'react-router-dom';
import { EmptyState, LoadingRows } from '../../components/ui/OperationFeedback';
import { useBoundedEdges } from '../operations/use-bounded-edges';
import { useRegisterOperationsRefresh } from '../operations/operations-refresh';
import { ACTUAL_DOMAIN_MODE_OPTIONS, buildActualTopology, nodeMatches, type ActualTopologyLink, type ActualTopologyNode } from './actual-topology-model';
import { nfRoleLabel, type TopologyDomainMode } from './nf-classification';
import {
  edgeInterfaceNames,
  filterEdgesByInterface,
  interfaceCoverage,
  interfaceNamesInEdges,
  interfaceUsageCounts,
  UNANNOTATED_INTERFACE_FILTER,
} from './interface-catalog';
import {
  READABLE_MIN_ZOOM,
  measureCanvasBox,
  resolveFitZoom,
  type TopologyFitMode,
} from './topology-zoom';
import { nodeHealthLabelKey, summarizeNodeHealth, type NodeHealth, type NodeHealthState } from './actual-topology-health';
import { useResourceDirectory } from './use-resource-directory';
import { useTopologyHealth } from './use-topology-health';
import { ActualTopologyCanvas } from './components/ActualTopologyCanvas';
import { TopologyEdgeDetail } from './components/TopologyEdgeDetail';
import { TopologyInspector } from './components/TopologyInspector';
import { TopologyAnnouncer } from './components/TopologyAnnouncer';
import styles from '../../styles/modules/architecture.module.css';

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 1.75;
const ZOOM_STEP = 0.15;

function healthSwatchClass(state: NodeHealthState): string {
  switch (state) {
    case 'healthy': return styles.actualSwatchHealthy;
    case 'degraded':
    case 'stale': return styles.actualSwatchWarning;
    case 'unhealthy': return styles.actualSwatchDanger;
    case 'disabled': return styles.actualSwatchDisabled;
    case 'not_monitored':
    case 'not_configured': return styles.actualSwatchHollow;
    case 'unresolved': return styles.actualSwatchUnresolved;
    default: return styles.actualSwatchUnknown;
  }
}

export function ActualTopologyView({ onShowRuntime }: { onShowRuntime?: () => void } = {}) {
  const { t } = useI18n();
  const { edges, coverage, coverageReason, loading, refresh } = useBoundedEdges();
  const [selectedResourceId, setSelectedResourceId] = useState<string | undefined>();
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | undefined>();
  const [focusedResourceId, setFocusedResourceId] = useState<string | undefined>();
  const [focusedEdgeId, setFocusedEdgeId] = useState<string | undefined>();
  const [listOpen, setListOpen] = useState(false);
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | undefined>();
  const [search, setSearch] = useState('');
  const [showSupport, setShowSupport] = useState(false);
  const [showBoundary, setShowBoundary] = useState(true);
  const [domainMode, setDomainMode] = useState<TopologyDomainMode>('all');
  const [interfaceFilter, setInterfaceFilter] = useState('');
  const [showAllInterfaceNames, setShowAllInterfaceNames] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<{ kind: 'node' | 'edge'; id: string; element?: Element | null } | undefined>(undefined);
  const autoFitRef = useRef(true);
  const fitModeRef = useRef<TopologyFitMode>('readable');
  const endpointIds = useMemo(
    () => edges.flatMap((edge) => {
      if (!edge || typeof edge !== 'object') return [];
      const value = edge as { fromResourceId?: unknown; toResourceId?: unknown };
      return [typeof value.fromResourceId === 'string' ? value.fromResourceId : '', typeof value.toResourceId === 'string' ? value.toResourceId : ''];
    }).filter(Boolean),
    [edges],
  );
  const directory = useResourceDirectory(endpointIds);
  const availableInterfaces = useMemo(() => interfaceNamesInEdges(edges), [edges]);
  const interfaceCounts = useMemo(() => interfaceUsageCounts(edges), [edges]);
  const coverageCounts = useMemo(() => interfaceCoverage(edges), [edges]);
  const interfaceScopedEdges = useMemo(
    () => filterEdgesByInterface(edges, interfaceFilter),
    [edges, interfaceFilter],
  );
  const layout = useMemo(
    () => buildActualTopology(interfaceScopedEdges, directory, { showSupport, showBoundary, domainMode }),
    [interfaceScopedEdges, directory, showSupport, showBoundary, domainMode],
  );
  const nodeIds = useMemo(
    () => layout.nodes.filter((node) => node.resourceClass !== 'support').map((node) => node.resourceId),
    [layout.nodes],
  );
  const health = useTopologyHealth(nodeIds);
  const healthCounts = useMemo(() => summarizeNodeHealth(health.byResource), [health.byResource]);
  const selected = layout.nodes.find((node) => node.resourceId === selectedResourceId);
  const selectedEdge = layout.links.find((link) => link.edgeId === selectedEdgeId);
  const selectedHealth = selected ? health.byResource.get(selected.resourceId) : undefined;
  const selectedRelatedLinks = selected
    ? layout.links.filter((link) => link.fromResourceId === selected.resourceId || link.toResourceId === selected.resourceId)
    : [];
  const matchedNodes = search.trim() ? layout.nodes.filter((node) => nodeMatches(node, search)) : [];
  const domainModeLabel = t(
    ACTUAL_DOMAIN_MODE_OPTIONS.find((option) => option.value === domainMode)?.labelKey ?? 'topology_domain_all',
  );
  const supportToggle = layout.supportResourceCount > 0 ? (
    <button
      type="button"
      className={styles.actualSupportToggle}
      data-action="toggle-support"
      aria-pressed={showSupport}
      onClick={() => setShowSupport((current) => !current)}
    >
      <Layers size={15} aria-hidden="true" />
      {showSupport
        ? t('topology_actual_support_hide', { count: layout.supportResourceCount })
        : t('topology_actual_support_show', { count: layout.supportResourceCount })}
    </button>
  ) : null;
  const hiddenSupportNotice = !showSupport && layout.supportResourceCount > 0 ? (
    <span className={styles.actualHiddenSupport} data-hidden-support="true" role="status">
      {t('topology_actual_hidden_support', {
        resources: layout.supportResourceCount,
        links: layout.supportLinkCount,
      })}
    </span>
  ) : null;
  const boundaryToggle = layout.selectedDomain && layout.boundaryNodeCount > 0 ? (
    <button
      type="button"
      className={styles.actualSupportToggle}
      data-action="toggle-boundary"
      aria-pressed={showBoundary}
      onClick={() => setShowBoundary((current) => !current)}
    >
      {showBoundary
        ? t('topology_actual_boundary_hide', { count: layout.boundaryNodeCount })
        : t('topology_actual_boundary_show', { count: layout.boundaryNodeCount })}
    </button>
  ) : null;
  const hiddenBoundaryNotice = !showBoundary && layout.boundaryNodeCount > 0 ? (
    <span className={styles.actualHiddenSupport} data-hidden-boundary="true" role="status">
      {t('topology_actual_hidden_boundary', {
        nodes: layout.boundaryNodeCount,
        links: layout.boundaryLinkCount,
        cross: layout.crossDomainLinkCount,
      })}
    </span>
  ) : null;
  const domainEmptyAction = domainMode === 'all' ? supportToggle : (
    <button type="button" className="btn btn-secondary" onClick={() => setDomainMode('all')}>
      {t('topology_domain_all')}
    </button>
  );
  const interfaceFilterLabel = interfaceFilter === UNANNOTATED_INTERFACE_FILTER
    ? t('topology_interface_unannotated')
    : interfaceFilter;
  const emptyReason = layout.nodes.length > 0
    ? null
    : layout.activeLinkCount === 0
      ? (interfaceFilter ? 'interface' : 'domain')
      : layout.scopedLinkCount === 0
        ? 'domain'
        : 'support';
  const emptyAction = emptyReason === 'interface' ? (
    <button
      type="button"
      className="btn btn-secondary"
      data-action="clear-interface-filter"
      onClick={() => setInterfaceFilter('')}
    >
      {t('topology_interface_clear_filter')}
    </button>
  ) : emptyReason === 'domain'
    ? domainEmptyAction
    : supportToggle;

  const refreshAll = useCallback(() => {
    refresh();
    health.refresh();
  }, [refresh, health.refresh]);

  const announcement = useMemo(() => {
    if (loading) return t('topology_announce_loading');
    if (coverage === 'unavailable') return t('topology_announce_unavailable');
    if (selectedEdge) {
      return t('topology_announce_selected_edge', {
        from: inspectorNodeName(selectedEdge.fromNode),
        to: inspectorNodeName(selectedEdge.toNode),
      });
    }
    if (selected) return t('topology_announce_selected_node', { name: inspectorNodeName(selected) });
    const filters = [
      search ? `${t('topology_search_filter')}: ${search}` : '',
      domainMode !== 'all'
        ? t(ACTUAL_DOMAIN_MODE_OPTIONS.find((option) => option.value === domainMode)?.labelKey ?? 'topology_domain_all')
        : '',
      interfaceFilter ? `${t('topology_interface_filter')}: ${interfaceFilterLabel}` : '',
    ].filter(Boolean).join(' · ');
    const hiddenNodes = layout.hiddenBoundaryNodeCount + (showSupport ? 0 : layout.supportResourceCount);
    const hiddenLinks = layout.hiddenBoundaryLinkCount + (showSupport ? 0 : layout.supportLinkCount);
    const partial = coverage === 'partial'
      ? `${t('topology_announce_partial', { nodes: layout.nodes.length, links: layout.links.length })} `
      : '';
    return `${partial}${t('topology_announce_loaded', {
      nodes: layout.nodes.length,
      links: layout.links.length,
      filters: filters || t('topology_announce_no_filters'),
    })}${hiddenNodes > 0 || hiddenLinks > 0
      ? ` ${t('topology_announce_hidden', { nodes: hiddenNodes, links: hiddenLinks })}`
      : ''}`;
  }, [
    loading, coverage, selectedEdge, selected, search, domainMode, interfaceFilter,
    interfaceFilterLabel, layout, showSupport, t,
  ]);

  useRegisterOperationsRefresh('topology:actual', refreshAll);

  const fitView = useCallback((mode: TopologyFitMode = fitModeRef.current) => {
    const viewport = canvasRef.current;
    fitModeRef.current = mode;
    const box = measureCanvasBox(viewport);
    if (!box) {
      setZoom(1);
      return;
    }
    const floor = mode === 'readable' ? Math.max(MIN_ZOOM, READABLE_MIN_ZOOM) : MIN_ZOOM;
    const next = resolveFitZoom(box, { width: layout.width, height: layout.height }, mode, floor);
    autoFitRef.current = true;
    if (viewport) {
      viewport.scrollLeft = 0;
      viewport.scrollTop = 0;
    }
    setZoom(next);
  }, [layout.width, layout.height]);

  useEffect(() => {
    fitView();
  }, [fitView]);

  useEffect(() => {
    const onResize = () => {
      if (autoFitRef.current) fitView();
    };
    const onFullscreenChange = () => {
      setFullscreen(document.fullscreenElement === canvasRef.current);
      if (autoFitRef.current) window.requestAnimationFrame(() => fitView());
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

  const selectNode = (resourceId: string) => {
    if (resourceId === selectedResourceId) {
      triggerRef.current = undefined;
      setSelectedResourceId(undefined);
      return;
    }
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    triggerRef.current = {
      kind: 'node',
      id: resourceId,
      element: active && active !== document.body ? active : null,
    };
    setSelectedEdgeId(undefined);
    setSelectedResourceId(resourceId);
  };
  const selectEdge = (edgeId: string) => {
    if (edgeId === selectedEdgeId) {
      triggerRef.current = undefined;
      setSelectedEdgeId(undefined);
      return;
    }
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    triggerRef.current = {
      kind: 'edge',
      id: edgeId,
      element: active && active !== document.body ? active : null,
    };
    setSelectedResourceId(undefined);
    setSelectedEdgeId(edgeId);
  };
  const closeInspector = useCallback(() => {
    setSelectedResourceId(undefined);
    setSelectedEdgeId(undefined);
    const trigger = triggerRef.current;
    triggerRef.current = undefined;
    if (!trigger) return;
    if (trigger.element instanceof Element && trigger.element.isConnected) {
      (trigger.element as HTMLElement).focus?.();
      return;
    }
    window.requestAnimationFrame(() => {
      const selector = trigger.kind === 'node'
        ? `[data-resource-id="${trigger.id}"]`
        : `[data-edge-id="${trigger.id}"]`;
      canvasRef.current?.querySelector<SVGElement>(selector)?.focus();
    });
  }, []);

  useEffect(() => {
    if (selectedResourceId && !layout.nodes.some((node) => node.resourceId === selectedResourceId)) {
      setSelectedResourceId(undefined);
    }
    if (selectedEdgeId && !layout.links.some((link) => link.edgeId === selectedEdgeId)) {
      setSelectedEdgeId(undefined);
    }
    if (hoveredEdgeId && !layout.links.some((link) => link.edgeId === hoveredEdgeId)) {
      setHoveredEdgeId(undefined);
    }
    if (focusedResourceId && !layout.nodes.some((node) => node.resourceId === focusedResourceId)) {
      setFocusedResourceId(undefined);
    }
    if (focusedEdgeId && !layout.links.some((link) => link.edgeId === focusedEdgeId)) {
      setFocusedEdgeId(undefined);
    }
  }, [layout.nodes, layout.links, selectedResourceId, selectedEdgeId, focusedResourceId, focusedEdgeId, hoveredEdgeId]);

  useEffect(() => {
    if (!interfaceFilter || interfaceFilter === UNANNOTATED_INTERFACE_FILTER) return;
    if (!availableInterfaces.includes(interfaceFilter)) setInterfaceFilter('');
  }, [availableInterfaces, interfaceFilter]);

  const updateZoom = (delta: number) => {
    autoFitRef.current = false;
    setZoom((current) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number((current + delta).toFixed(2)))));
  };
  const resetView = () => {
    setSelectedResourceId(undefined);
    setSelectedEdgeId(undefined);
    setFocusedResourceId(undefined);
    setFocusedEdgeId(undefined);
    triggerRef.current = undefined;
    setSearch('');
    setHoveredEdgeId(undefined);
    setShowSupport(false);
    setShowBoundary(true);
    setDomainMode('all');
    setInterfaceFilter('');
    setShowAllInterfaceNames(false);
    fitView('readable');
  };
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen?.();
    } else {
      void canvasRef.current?.requestFullscreen?.();
    }
  }, []);

  if (loading && edges.length === 0) {
    return (
      <section className={styles.actualSection} aria-labelledby="actual-topology-title" aria-busy="true">
        <h2 id="actual-topology-title" className="sr-only">{t('topology_title')}</h2>
        <TopologyAnnouncer message={t('topology_announce_loading')} />
        <div className={styles.statePanel} data-state-panel="loading">
          <LoadingRows rows={5} />
        </div>
      </section>
    );
  }

  if (!loading && coverage === 'unavailable') {
    return (
      <section className={styles.actualSection} aria-labelledby="actual-topology-title">
        <h2 id="actual-topology-title" className="sr-only">{t('topology_title')}</h2>
        <TopologyAnnouncer message={t('topology_announce_unavailable')} />
        <div className={styles.statePanel} data-state-panel="unavailable" data-state-source="topology-edges">
          <EmptyState
            icon={<AlertTriangle size={40} />}
            title={t('topology_actual_unavailable_title')}
            description={t('topology_actual_unavailable_body')}
            action={(
              <button type="button" className="btn btn-secondary" onClick={refresh}>
                <RefreshCw size={15} />
                {t('refresh')}
              </button>
            )}
          />
          <p className={styles.stateSource}>{t('topology_actual_unavailable_source')}</p>
        </div>
      </section>
    );
  }

  if (!loading && edges.length === 0) {
    return (
      <section className={styles.actualSection} aria-labelledby="actual-topology-title">
        <h2 id="actual-topology-title" className="sr-only">{t('topology_title')}</h2>
        <TopologyAnnouncer message={t('topology_announce_empty')} />
        <div className={styles.statePanel} data-state-panel="empty-declared" data-state-source="declared">
        <EmptyState
          icon={<GitBranch size={40} />}
          title={t('topology_actual_empty_declared_title')}
          description={t('topology_actual_empty_declared_body')}
          action={(
            <div className={styles.actualEmptyActions}>
              {onShowRuntime ? (
                <button
                  type="button"
                  className="btn btn-secondary"
                  data-action="show-runtime-source"
                  onClick={onShowRuntime}
                >
                  <Layers size={15} aria-hidden="true" />
                  {t('topology_actual_open_runtime')}
                </button>
              ) : null}
              <Link className="btn btn-secondary" to="/topology?view=ledger">
                <GitBranch size={15} />
                {t('topology_open_ledger')}
              </Link>
            </div>
          )}
        />
        </div>
      </section>
    );
  }

  return (
    <section className={styles.actualSection} aria-labelledby="actual-topology-title" aria-busy={loading}>
      <h2 id="actual-topology-title" className="sr-only">{t('topology_title')}</h2>
      <TopologyAnnouncer message={announcement} />
      <div className={styles.actualToolbar}>
        <label className={styles.actualDomainFilter}>
          <span className="sr-only">{t('topology_domain_filter')}</span>
          <select
            value={domainMode}
            onChange={(event) => setDomainMode(event.target.value as TopologyDomainMode)}
            aria-label={t('topology_domain_filter')}
            data-domain-mode={domainMode}
          >
            {ACTUAL_DOMAIN_MODE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{t(option.labelKey)}</option>
            ))}
          </select>
        </label>
        <div className={styles.actualSummary} role="status">
          <span>{t('topology_actual_node_count', { count: layout.nodes.length })}</span>
          <span>{t('topology_showing_edges', { count: layout.links.length })}</span>
          <span
            className={coverage === 'complete' ? styles.actualCoverageComplete : styles.actualCoveragePartial}
            title={t('topology_actual_coverage_hint')}
          >
            {t(`ops_completeness_${coverage}`)}
          </span>
          {layout.selectedDomain && layout.boundaryNodeCount > 0 ? (
            <span data-boundary-count="true">
              {t('topology_actual_boundary_count', { count: layout.boundaryNodeCount })}
            </span>
          ) : null}
          {layout.crossDomainLinkCount > 0 ? (
            <span data-cross-domain-count="true">
              {t('topology_actual_cross_domain_count', { count: layout.crossDomainLinkCount })}
            </span>
          ) : null}
          {search.trim() ? (
            <>
              <span data-search-status="true">
                {matchedNodes.length > 0
                  ? t('topology_search_matches', { count: matchedNodes.length })
                  : t('topology_search_no_match')}
              </span>
              {matchedNodes.length === 0 ? (
                <button
                  type="button"
                  className={styles.actualSupportToggle}
                  data-action="clear-search"
                  onClick={() => setSearch('')}
                >
                  {t('topology_search_clear')}
                </button>
              ) : null}
            </>
          ) : null}
        </div>
        {supportToggle || hiddenSupportNotice || boundaryToggle || hiddenBoundaryNotice ? (
          <div className={styles.actualSupportBar}>
            {supportToggle}
            {hiddenSupportNotice}
            {boundaryToggle}
            {hiddenBoundaryNotice}
          </div>
        ) : null}
        <label className={styles.actualSearch}>
          <Search size={15} aria-hidden="true" />
          <span className="sr-only">{t('topology_picker_search_placeholder')}</span>
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('topology_picker_search_placeholder')}
          />
        </label>
      </div>
      <div className={styles.actualSecondaryToolbar}>
        <label className={styles.actualInterfaceFilter}>
          <span>{t('topology_interface_filter')}</span>
          <select
            value={interfaceFilter}
            onChange={(event) => setInterfaceFilter(event.target.value)}
            data-interface-filter
          >
            <option value="">{t('topology_interface_filter_all')}</option>
            {availableInterfaces.map((name) => (
              <option key={name} value={name}>
                {`${name} (${interfaceCounts.get(name) ?? 0})`}
              </option>
            ))}
            <option value={UNANNOTATED_INTERFACE_FILTER}>{t('topology_interface_unannotated')}</option>
          </select>
        </label>
        <span className={styles.actualInterfaceCoverage} data-interface-coverage="true">
          {t('topology_interface_coverage', {
            annotated: coverageCounts.annotated,
            total: coverageCounts.total,
          })}
        </span>
        {coverageCounts.annotated > 0 && interfaceFilter !== UNANNOTATED_INTERFACE_FILTER ? (
          <button
            type="button"
            className={styles.actualSupportToggle}
            data-action="toggle-interface-labels"
            aria-pressed={showAllInterfaceNames}
            onClick={() => setShowAllInterfaceNames((current) => !current)}
          >
            {showAllInterfaceNames
              ? t('topology_interface_hide_all')
              : t('topology_interface_show_all')}
          </button>
        ) : null}
        <button
          type="button"
          className={styles.actualSupportToggle}
          data-action="toggle-lists"
          aria-expanded={listOpen}
          aria-pressed={listOpen}
          onClick={() => setListOpen((open) => !open)}
        >
          {listOpen ? t('topology_hide_lists') : t('topology_show_lists')}
        </button>
      </div>
      <p className={styles.actualNote}>{t('topology_declared_notice')}</p>
      {coverage === 'partial' ? (
        <div
          className={styles.actualCoverageNote}
          role="status"
          data-state-panel="partial"
          data-partial-reason={coverageReason ?? 'unknown'}
        >
          <span>
            {t('topology_actual_partial_notice')}
            {coverageReason === 'page_limit' ? ` ${t('topology_actual_partial_page_limit')}` : null}
            {coverageReason === 'read_error' ? ` ${t('topology_actual_partial_read_error')}` : null}
          </span>
          <button type="button" className="btn btn-secondary" data-action="retry-partial" onClick={refresh}>
            {t('retry')}
          </button>
        </div>
      ) : null}
      {health.loading || health.byResource.size > 0 || health.coverage !== 'complete' ? (
        <div className={styles.actualHealthLegend} role="group" aria-label={t('topology_health_label')}>
          {health.loading ? (
            <span className={styles.actualHealthPending}>{t('topology_health_loading')}</span>
          ) : null}
          {health.coverage === 'unavailable' ? (
            <span className={styles.actualHealthWarning}>{t('topology_health_unavailable')}</span>
          ) : (
            <>
              {healthCounts.monitored > 0 ? (
                <span className={styles.actualHealthChip} data-health-summary="monitored">
                  <i className={`${styles.actualSwatch} ${styles.actualSwatchNeutral}`} aria-hidden="true" />
                  {t('topology_health_monitored')} {healthCounts.monitored}
                </span>
              ) : null}
              {healthCounts.abnormal > 0 ? (
                <span className={styles.actualHealthChip} data-health-summary="abnormal">
                  <i className={`${styles.actualSwatch} ${styles.actualSwatchDanger}`} aria-hidden="true" />
                  {t('topology_health_abnormal')} {healthCounts.abnormal}
                </span>
              ) : null}
              {healthCounts.stale > 0 ? (
                <span className={styles.actualHealthChip} data-health-summary="stale">
                  <i className={`${styles.actualSwatch} ${styles.actualSwatchWarning}`} aria-hidden="true" />
                  {t('nf_health_state_stale')} {healthCounts.stale}
                </span>
              ) : null}
              {healthCounts.unknown > 0 ? (
                <span className={styles.actualHealthChip} data-health-summary="unknown">
                  <i className={`${styles.actualSwatch} ${styles.actualSwatchUnknown}`} aria-hidden="true" />
                  {t('nf_health_state_unknown')} {healthCounts.unknown}
                </span>
              ) : null}
              {healthCounts.notConfigured > 0 ? (
                <span className={styles.actualHealthChip} data-health-summary="not_configured">
                  <i className={`${styles.actualSwatch} ${styles.actualSwatchHollow}`} aria-hidden="true" />
                  {t('nf_health_state_not_configured')} {healthCounts.notConfigured}
                </span>
              ) : null}
              {healthCounts.disabled > 0 ? (
                <span className={styles.actualHealthChip} data-health-summary="disabled">
                  <i className={`${styles.actualSwatch} ${styles.actualSwatchDisabled}`} aria-hidden="true" />
                  {t('topology_health_disabled')} {healthCounts.disabled}
                </span>
              ) : null}
              {healthCounts.notMonitored > 0 ? (
                <span
                  className={styles.actualHealthChip}
                  data-health-summary="not_monitored"
                  title={t('topology_health_not_monitored_hint')}
                >
                  <i className={`${styles.actualSwatch} ${styles.actualSwatchHollow}`} aria-hidden="true" />
                  {t('topology_health_not_monitored')} {healthCounts.notMonitored}
                </span>
              ) : null}
              {healthCounts.unresolved > 0 ? (
                <span
                  className={styles.actualHealthChip}
                  data-health-summary="unresolved"
                  title={t('topology_health_unresolved_hint')}
                >
                  <i className={`${styles.actualSwatch} ${styles.actualSwatchUnresolved}`} aria-hidden="true" />
                  {t('topology_health_unresolved')} {healthCounts.unresolved}
                </span>
              ) : null}
            </>
          )}
        </div>
      ) : null}
      {layout.nodes.length === 0 ? (
        <EmptyState
          icon={emptyReason === 'support' ? <Layers size={40} /> : <Search size={40} />}
          title={emptyReason === 'interface'
            ? t('topology_interface_empty_title')
            : emptyReason === 'domain'
              ? t('topology_actual_domain_empty_title')
              : t('topology_actual_no_nf_title')}
          description={emptyReason === 'interface'
            ? t('topology_interface_empty_body', { interface: interfaceFilterLabel })
            : emptyReason === 'domain'
              ? t('topology_actual_domain_empty_body', { domain: domainModeLabel })
              : t('topology_actual_no_nf_body', {
                resources: layout.supportResourceCount,
                links: layout.supportLinkCount,
              })}
          action={emptyAction}
        />
      ) : (
        <div
          className={styles.archWorkspace}
          data-inspector-open={selected || selectedEdge ? 'true' : undefined}
        >
          <div className={styles.archWorkspaceMain}>
            {/*
              * Navigation floats over the canvas corner: it belongs to the
              * surface it acts on, and keeping it out of the toolbar rows leaves
              * more of the first screen for the graph itself.
             */}
            <TopologyCanvasControls
              className={styles.actualCanvasControls}
              zoom={{
                value: zoom,
                min: MIN_ZOOM,
                max: MAX_ZOOM,
                onIn: () => updateZoom(ZOOM_STEP),
                onOut: () => updateZoom(-ZOOM_STEP),
                onFit: () => fitView('all'),
                onReset: resetView,
              }}
              fullscreen={{ active: fullscreen, onToggle: toggleFullscreen }}
            />
            <div ref={canvasRef} className={styles.actualCanvasViewport}>
              <div
                className={styles.actualCanvasScale}
                style={{ width: `${layout.width * zoom}px`, height: `${layout.height * zoom}px` }}
              >
                <ActualTopologyCanvas
                  layout={layout}
                  selectedResourceId={selectedResourceId}
                  selectedEdgeId={selectedEdgeId}
                  focusedResourceId={focusedResourceId}
                  focusedEdgeId={focusedEdgeId}
                  search={search}
                  hoveredEdgeId={hoveredEdgeId}
                  health={health.coverage !== 'unavailable' && health.byResource.size > 0 ? health.byResource : undefined}
                  zoom={zoom}
                  showAllInterfaceNames={showAllInterfaceNames}
                  onSelectResource={selectNode}
                  onSelectEdge={selectEdge}
                  onFocusResource={setFocusedResourceId}
                  onFocusEdge={setFocusedEdgeId}
                  onHoverEdge={setHoveredEdgeId}
                  onFocusDomain={(domain) => setDomainMode(domain as TopologyDomainMode)}
                />
              </div>
            </div>
            {listOpen ? (
              <ActualLists
                nodes={layout.nodes}
                links={layout.links}
                health={health.coverage !== 'unavailable' ? health.byResource : new Map()}
                onFocusNode={setFocusedResourceId}
                onSelectNode={selectNode}
                onFocusEdge={setFocusedEdgeId}
                onSelectEdge={selectEdge}
              />
            ) : null}
          </div>
          {selected || selectedEdge ? (
            <TopologyInspector
              label={selectedEdge ? t('topology_inspector_edge') : t('topology_inspector_node')}
              onClose={closeInspector}
            >
              {selectedEdge ? (
                <TopologyEdgeDetail
                  edge={selectedEdge}
                  directory={directory}
                  canConfigure={false}
                  embedded
                  onViewResource={(resourceId) => {
                    if (layout.nodes.some((node) => node.resourceId === resourceId)) selectNode(resourceId);
                  }}
                />
              ) : selected ? (
                <ActualNodeInspector
                  node={selected}
                  health={selectedHealth}
                  links={selectedRelatedLinks}
                  onSelectEdge={selectEdge}
                />
              ) : null}
            </TopologyInspector>
          ) : null}
        </div>
      )}
    </section>
  );
}

function inspectorNodeName(node: ActualTopologyNode): string {
  return node.displayName || node.name || node.resourceId;
}

function ActualLists({
  nodes,
  links,
  health,
  onFocusNode,
  onSelectNode,
  onFocusEdge,
  onSelectEdge,
}: {
  nodes: ActualTopologyNode[];
  links: ActualTopologyLink[];
  health: ReadonlyMap<string, NodeHealth>;
  onFocusNode: (resourceId?: string) => void;
  onSelectNode: (resourceId: string) => void;
  onFocusEdge: (edgeId?: string) => void;
  onSelectEdge: (edgeId: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div className={styles.topologyLists} data-topology-lists="actual">
      <section className={styles.topologyListSection} aria-labelledby="actual-node-list-title">
        <h3 id="actual-node-list-title">{t('topology_list_nodes')}</h3>
        <div className={styles.topologyListScroll}>
          <table className={styles.topologyListTable}>
            <caption className="sr-only">{t('topology_list_nodes')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('topology_list_name')}</th>
                <th scope="col">{t('topology_inspector_type')}</th>
                <th scope="col">{t('topology_domain_filter')}</th>
                <th scope="col">{t('topology_lifecycle')}</th>
                <th scope="col">{t('topology_health_label')}</th>
              </tr>
            </thead>
            <tbody>
              {nodes.map((node) => {
                const nodeHealth = health.get(node.resourceId);
                return (
                  <tr key={node.resourceId} data-list-node-row={node.resourceId}>
                    <th scope="row">
                      <button
                        type="button"
                        className={styles.linkBtn}
                        data-list-node={node.resourceId}
                        onFocus={() => onFocusNode(node.resourceId)}
                        onBlur={() => onFocusNode(undefined)}
                        onClick={() => onSelectNode(node.resourceId)}
                      >
                        {inspectorNodeName(node)}
                      </button>
                    </th>
                    <td>{node.resourceClass === 'support' ? t('topology_support_resource') : node.role ? nfRoleLabel(node.role) : (node.kind || t('unknown'))}</td>
                    <td>{node.domain ? node.domain.toUpperCase() : t('unknown')}</td>
                    <td>{node.lifecycleState || t('unknown')}</td>
                    <td>{nodeHealth ? t(nodeHealthLabelKey(nodeHealth.state)) : t('ops_metric_unavailable')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className={styles.topologyListSection} aria-labelledby="actual-relationship-list-title">
        <h3 id="actual-relationship-list-title">{t('topology_list_relationships')}</h3>
        <div className={styles.topologyListScroll}>
          <table className={styles.topologyListTable}>
            <caption className="sr-only">{t('topology_list_relationships')}</caption>
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
              {links.map((link) => {
                const interfaceNames = edgeInterfaceNames(link);
                const stateKey = `topology_state_${link.lifecycleState}`;
                const state = t(stateKey);
                return (
                  <tr key={link.edgeId} data-list-edge-row={link.edgeId}>
                    <th scope="row">
                      <button
                        type="button"
                        className={styles.linkBtn}
                        data-list-edge={link.edgeId}
                        onFocus={() => onFocusEdge(link.edgeId)}
                        onBlur={() => onFocusEdge(undefined)}
                        onClick={() => onSelectEdge(link.edgeId)}
                      >
                        {inspectorNodeName(link.fromNode)}
                      </button>
                    </th>
                    <td>{interfaceNames.length > 0 ? interfaceNames.join(' / ') : t('topology_interface_unannotated')}</td>
                    <td>{inspectorNodeName(link.toNode)}</td>
                    <td>{link.source?.kind || t('topology_source_declared')}</td>
                    <td>{state === stateKey ? link.lifecycleState : state}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function ActualNodeInspector({
  node,
  health,
  links,
  onSelectEdge,
}: {
  node: ActualTopologyNode;
  health?: NodeHealth;
  links: ActualTopologyLink[];
  onSelectEdge: (edgeId: string) => void;
}) {
  const { t } = useI18n();
  const typeLabel = node.resourceClass === 'support'
    ? t('topology_support_resource')
    : node.resourceClass === 'unresolved'
      ? t('topology_unresolved_resource')
      : (node.role ? nfRoleLabel(node.role) : (node.kind || t('unknown')));
  const healthLabel = health ? t(nodeHealthLabelKey(health.state)) : t('ops_metric_unavailable');
  return (
    <div className={styles.liveDetailBody}>
      <strong>{inspectorNodeName(node)}</strong>
      <dl className={styles.liveDetailList}>
        <div>
          <dt>{t('topology_inspector_identity')}</dt>
          <dd><code>{node.resourceId}</code></dd>
        </div>
        <div>
          <dt>{t('topology_inspector_type')}</dt>
          <dd>{typeLabel}</dd>
        </div>
        <div>
          <dt>{t('topology_domain_filter')}</dt>
          <dd>{node.domain ? node.domain.toUpperCase() : t('unknown')}</dd>
        </div>
        <div>
          <dt>{t('topology_lifecycle')}</dt>
          <dd>{node.lifecycleState || t('unknown')}</dd>
        </div>
        <div>
          <dt>{t('topology_health_label')}</dt>
          <dd data-inspector-health={health?.state}>
            {health ? (
              <span className={styles.actualFocusHealth}>
                <i className={`${styles.actualSwatch} ${healthSwatchClass(health.state)}`} aria-hidden="true" />
                {healthLabel}
              </span>
            ) : healthLabel}
          </dd>
        </div>
        <div>
          <dt>{t('topology_inspector_evidence')}</dt>
          <dd>{t('topology_actual_inspector_evidence')}</dd>
        </div>
        {node.boundary ? (
          <div>
            <dt>{t('topology_actual_boundary_label')}</dt>
            <dd>{t('topology_inspector_boundary_note')}</dd>
          </div>
        ) : null}
        {node.proxy ? (
          <div>
            <dt>{t('topology_actual_proxy_label')}</dt>
            <dd>{t('topology_actual_proxy_via', { proxy: nfRoleLabel(node.role) })}</dd>
          </div>
        ) : null}
      </dl>

      {health?.targetId ? (
        <Link className={styles.linkBtn} to={`/nf-health/${encodeURIComponent(health.targetId)}`}>
          {t('topology_health_open_target')}
        </Link>
      ) : null}

      <section aria-label={t('topology_related_relationships')}>
        <h4 className={styles.inspectorSectionTitle}>{t('topology_related_relationships')}</h4>
        {links.length === 0 ? (
          <p className={styles.liveMuted}>{t('topology_no_relationships')}</p>
        ) : (
          <ul className={styles.actualInspectorLinks}>
            {links.map((link) => {
              const interfaceNames = edgeInterfaceNames(link);
              return (
                <li key={link.edgeId}>
                  <button
                    type="button"
                    className={styles.linkBtn}
                    data-related-edge={link.edgeId}
                    onClick={() => onSelectEdge(link.edgeId)}
                  >
                    {inspectorNodeName(link.fromNode)} -&gt; {inspectorNodeName(link.toNode)}
                    {interfaceNames.length > 0 ? ` · ${interfaceNames.join(' / ')}` : ''}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <Link className={styles.linkBtn} to={`/inventory/${encodeURIComponent(node.resourceId)}`}>
        {t('topology_live_open_inventory')}
      </Link>
    </div>
  );
}

export default ActualTopologyView;
