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
  Expand,
  GitBranch,
  Layers,
  Minimize,
  Minus,
  RefreshCw,
  RotateCcw,
  Scan,
  Search,
  SquareArrowOutUpRight,
  ZoomIn,
} from 'lucide-react';
import { useI18n } from '../../providers/I18nProvider';
import { Link } from 'react-router-dom';
import { EmptyState, LoadingRows } from '../../components/ui/OperationFeedback';
import { useBoundedEdges } from '../operations/use-bounded-edges';
import { useRegisterOperationsRefresh } from '../operations/operations-refresh';
import { ACTUAL_DOMAIN_MODE_OPTIONS, buildActualTopology, nodeMatches } from './actual-topology-model';
import { nfRoleLabel, type TopologyDomainMode } from './nf-classification';
import {
  filterEdgesByInterface,
  interfaceCoverage,
  interfaceNamesInEdges,
  interfaceUsageCounts,
  UNANNOTATED_INTERFACE_FILTER,
} from './interface-catalog';
import { nodeHealthLabelKey, summarizeNodeHealth, type NodeHealthState } from './actual-topology-health';
import { useResourceDirectory } from './use-resource-directory';
import { useTopologyHealth } from './use-topology-health';
import { ActualTopologyCanvas } from './components/ActualTopologyCanvas';
import { LiveTopologyView } from './LiveTopologyView';
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

export function ActualTopologyView() {
  const { t } = useI18n();
  const { edges, coverage, loading, refresh } = useBoundedEdges();
  const [selectedResourceId, setSelectedResourceId] = useState<string | undefined>();
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
  const autoFitRef = useRef(true);
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
  const selectedHealth = selected ? health.byResource.get(selected.resourceId) : undefined;
  const relatedCount = selected
    ? layout.links.filter((link) => link.fromResourceId === selected.resourceId || link.toResourceId === selected.resourceId).length
    : 0;
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

  useRegisterOperationsRefresh('topology:actual', refreshAll);

  const fitView = useCallback(() => {
    const viewport = canvasRef.current;
    if (!viewport) {
      setZoom(1);
      return;
    }
    const computed = window.getComputedStyle(viewport);
    const paddingX = (Number.parseFloat(computed.paddingLeft) || 0) + (Number.parseFloat(computed.paddingRight) || 0);
    const paddingY = (Number.parseFloat(computed.paddingTop) || 0) + (Number.parseFloat(computed.paddingBottom) || 0);
    const maxHeight = Number.parseFloat(computed.maxHeight);
    const availableWidth = viewport.clientWidth - paddingX - 2;
    const availableHeight = (Number.isFinite(maxHeight) ? maxHeight : viewport.clientHeight) - paddingY - 2;
    const scale = Math.min(1, availableWidth / layout.width, availableHeight / layout.height);
    const next = Math.max(MIN_ZOOM, Math.min(1, Number(scale.toFixed(2))));
    autoFitRef.current = true;
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
    if (!selectedResourceId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectedResourceId(undefined);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedResourceId]);

  useEffect(() => {
    if (selectedResourceId && !layout.nodes.some((node) => node.resourceId === selectedResourceId)) {
      setSelectedResourceId(undefined);
    }
    if (hoveredEdgeId && !layout.links.some((link) => link.edgeId === hoveredEdgeId)) {
      setHoveredEdgeId(undefined);
    }
  }, [layout.nodes, layout.links, selectedResourceId, hoveredEdgeId]);

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
    setSearch('');
    setHoveredEdgeId(undefined);
    setShowSupport(false);
    setShowBoundary(true);
    setDomainMode('all');
    setInterfaceFilter('');
    setShowAllInterfaceNames(false);
    fitView();
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
        <LoadingRows rows={5} />
      </section>
    );
  }

  if (!loading && coverage === 'unavailable') {
    return (
      <section className={styles.actualSection} aria-labelledby="actual-topology-title">
        <h2 id="actual-topology-title" className="sr-only">{t('topology_title')}</h2>
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
      </section>
    );
  }

  if (!loading && edges.length === 0) {
    return (
      <section className={styles.actualSection} aria-labelledby="actual-topology-title">
        <h2 id="actual-topology-title" className="sr-only">{t('topology_title')}</h2>
        <div className={styles.actualSuggestedNotice} role="status">
          <Layers size={22} aria-hidden="true" />
          <div>
            <strong>{t('topology_actual_suggested_title')}</strong>
            <span>{t('topology_actual_suggested_body')}</span>
          </div>
          <Link className="btn btn-secondary" to="/topology?view=relationships">
            <GitBranch size={15} />
            {t('topology_open_ledger')}
          </Link>
        </div>
        <LiveTopologyView />
      </section>
    );
  }

  return (
    <section className={styles.actualSection} aria-labelledby="actual-topology-title" aria-busy={loading}>
      <h2 id="actual-topology-title" className="sr-only">{t('topology_title')}</h2>
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
            <span data-search-status="true">
              {matchedNodes.length > 0
                ? t('topology_search_matches', { count: matchedNodes.length })
                : t('topology_search_no_match')}
            </span>
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
        <div className={styles.actualControls} role="group" aria-label={t('topology_canvas_controls')}>
          <button
            type="button"
            data-action="zoom-out"
            onClick={() => updateZoom(-ZOOM_STEP)}
            disabled={zoom <= MIN_ZOOM}
            aria-label={t('topology_zoom_out')}
            title={t('topology_zoom_out')}
          >
            <Minus size={15} />
          </button>
          <span aria-live="polite">{Math.round(zoom * 100)}%</span>
          <button
            type="button"
            data-action="zoom-in"
            onClick={() => updateZoom(ZOOM_STEP)}
            disabled={zoom >= MAX_ZOOM}
            aria-label={t('topology_zoom_in')}
            title={t('topology_zoom_in')}
          >
            <ZoomIn size={15} />
          </button>
          <button type="button" data-action="fit" onClick={fitView} aria-label={t('topology_fit_view')} title={t('topology_fit_view')}>
            <Scan size={15} />
          </button>
          <button type="button" data-action="reset" onClick={resetView} aria-label={t('topology_reset_view')} title={t('topology_reset_view')}>
            <RotateCcw size={15} />
          </button>
          <button
            type="button"
            data-action="fullscreen"
            onClick={toggleFullscreen}
            aria-label={t(fullscreen ? 'topology_exit_fullscreen' : 'topology_fullscreen')}
            title={t(fullscreen ? 'topology_exit_fullscreen' : 'topology_fullscreen')}
          >
            {fullscreen ? <Minimize size={15} /> : <Expand size={15} />}
          </button>
        </div>
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
      </div>
      <p className={styles.actualNote}>{t('topology_declared_notice')}</p>
      {coverage === 'partial' ? (
        <p className={styles.actualCoverageNote} role="status">{t('topology_actual_partial_notice')}</p>
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
        <>
          <div ref={canvasRef} className={styles.actualCanvasViewport}>
            <div
              className={styles.actualCanvasScale}
              style={{ width: `${layout.width * zoom}px`, height: `${layout.height * zoom}px` }}
            >
              <ActualTopologyCanvas
                layout={layout}
                selectedResourceId={selectedResourceId}
                search={search}
                hoveredEdgeId={hoveredEdgeId}
                health={health.coverage !== 'unavailable' && health.byResource.size > 0 ? health.byResource : undefined}
                showAllInterfaceNames={showAllInterfaceNames}
                onSelectResource={(resourceId) => setSelectedResourceId((current) => current === resourceId ? undefined : resourceId)}
                onHoverEdge={setHoveredEdgeId}
              />
            </div>
          </div>
          {selected ? (
            <div className={styles.actualFocus} role="status">
              <div>
                <span className={styles.actualFocusEyebrow}>{t('topology_graph_root')}</span>
                <strong>{selected.displayName || selected.name || selected.resourceId}</strong>
                <span>
                  {selected.resourceClass === 'support'
                    ? t('topology_support_resource')
                    : selected.resourceClass === 'unresolved'
                      ? t('topology_unresolved_resource')
                      : (selected.role ? nfRoleLabel(selected.role) : selected.kind) || t('unknown')}
                  {' / '}
                  {selected.domain ? selected.domain.toUpperCase() : t('unknown')}
                  {' / '}
                  {t('topology_showing_edges', { count: relatedCount })}
                </span>
                {selected.proxy ? (
                  <span className={styles.actualProxyNote} data-proxy-note="true">
                    {t('topology_actual_proxy_via', { proxy: nfRoleLabel(selected.role) })}
                  </span>
                ) : null}
                {selectedHealth ? (
                  <span className={styles.actualFocusHealth} data-focus-health={selectedHealth.state}>
                    <i className={`${styles.actualSwatch} ${healthSwatchClass(selectedHealth.state)}`} aria-hidden="true" />
                    {t('topology_health_label')}: {t(nodeHealthLabelKey(selectedHealth.state))}
                    {selectedHealth.targetId ? (
                      <Link
                        className={styles.actualFocusHealthLink}
                        to={`/nf-health/${encodeURIComponent(selectedHealth.targetId)}`}
                      >
                        {t('topology_health_open_target')}
                      </Link>
                    ) : null}
                  </span>
                ) : null}
              </div>
              <div className={styles.actualFocusActions}>
                <button type="button" className="btn btn-secondary" onClick={() => setSelectedResourceId(undefined)}>
                  {t('topology_clear_focus')}
                </button>
                <Link className="btn btn-secondary" to={`/topology/${encodeURIComponent(selected.resourceId)}`}>
                  <SquareArrowOutUpRight size={15} />
                  {t('topology_open_resource')}
                </Link>          </div>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

export default ActualTopologyView;
