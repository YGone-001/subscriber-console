/*
 * Read-only live topology.
 *
 * Nodes come from the current runtime snapshot. Links come only from explicit
 * NF_ETC configuration; they are configured evidence, not observed traffic and
 * not a health claim. No write control is rendered here.
 *
 * The graph is presented inside the shared topology shell: search, canvas
 * controls and the contextual inspector share one structure with the declared
 * and reference sources. Configured links are never described as observed
 * traffic or service health.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink, Layers, RefreshCw } from 'lucide-react';
import { useRead } from '../../lib/api/use-read';
import { useI18n } from '../../providers/I18nProvider';
import { EmptyState, LoadingRows } from '../../components/ui/OperationFeedback';
import { useRegisterOperationsRefresh } from '../operations/operations-refresh';
import { ActualTopologyCanvas } from './components/ActualTopologyCanvas';
import { TopologyGraphShell } from './components/TopologyGraphShell';
import { TopologyGraphToolbar } from './components/TopologyGraphToolbar';
import { ACTUAL_DOMAIN_MODE_OPTIONS, buildActualTopology } from './actual-topology-model';
import { LABEL_DETAIL_MIN_ZOOM, resolveLabelVisibility } from './actual-topology-labels';
import { interfaceCoverage } from './interface-catalog';
import type { TopologyDomainMode } from './nf-classification';
import {
  liveConfigCompleteness,
  liveDirectory,
  liveEdges,
  presentRuntimeStates,
} from './live-topology-model';
import type {
  LiveEndpoint,
  LiveNode,
  LiveTopologyResponse,
} from './live-topology-types';
import styles from '../../styles/modules/architecture.module.css';

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 1.75;
const ZOOM_STEP = 0.15;

function endpointLabel(endpoint: LiveEndpoint): string {
  const address = endpoint.address || '-';
  const port = endpoint.port ? `:${endpoint.port}` : '';
  return `${endpoint.protocol} ${address}${port}`.trim();
}

function runtimeLabelKey(status: string): string {
  return `runtime_status_${status}`;
}

export function LiveTopologyView() {
  const { t } = useI18n();
  const live = useRead<LiveTopologyResponse>('/api/topology/live');
  const [selectedComponentId, setSelectedComponentId] = useState<string | undefined>();
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | undefined>();
  const [hoveredResourceId, setHoveredResourceId] = useState<string | undefined>();
  const [focusedResourceId, setFocusedResourceId] = useState<string | undefined>();
  const [search, setSearch] = useState('');
  const [domainMode, setDomainMode] = useState<TopologyDomainMode>('all');
  const [showAllInterfaceNames, setShowAllInterfaceNames] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [panning, setPanning] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const autoFitRef = useRef(true);
  const panRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    scrollLeft: number;
    scrollTop: number;
  } | null>(null);
  const data = live.data;
  const refresh = useCallback(() => {
    void live.mutate();
  }, [live.mutate]);
  useRegisterOperationsRefresh('topology:actual:live', refresh);

  const directory = useMemo(() => liveDirectory(data), [data]);
  const liveLinks = useMemo(() => liveEdges(data), [data]);
  const runtimeResources = useMemo(() => Object.values(directory), [directory]);
  const layout = useMemo(
    () => buildActualTopology(liveLinks, directory, { domainMode, resources: runtimeResources }),
    [liveLinks, directory, runtimeResources, domainMode],
  );
  const labelVisibility = useMemo(
    () => resolveLabelVisibility(layout.links, {
      selectedResourceId: selectedComponentId,
      focusedResourceId,
      hoveredResourceId,
      hoveredEdgeId,
      showAllInterfaceNames,
      zoom,
    }),
    [layout.links, selectedComponentId, focusedResourceId, hoveredResourceId, hoveredEdgeId, showAllInterfaceNames, zoom],
  );
  const interfaceCounts = useMemo(() => interfaceCoverage(layout.links), [layout.links]);
  const selected = data?.nodes.find((node) => node.componentId === selectedComponentId);
  const unresolved = data?.unresolvedPeers ?? [];

  useEffect(() => {
    if (selectedComponentId && data && !data.nodes.some((node) => node.componentId === selectedComponentId)) {
      setSelectedComponentId(undefined);
    }
    if (hoveredEdgeId && !layout.links.some((link) => link.edgeId === hoveredEdgeId)) {
      setHoveredEdgeId(undefined);
    }
    if (hoveredResourceId && !layout.nodes.some((node) => node.resourceId === hoveredResourceId)) {
      setHoveredResourceId(undefined);
    }
    if (focusedResourceId && !layout.nodes.some((node) => node.resourceId === focusedResourceId)) {
      setFocusedResourceId(undefined);
    }
  }, [data, selectedComponentId, layout.links, layout.nodes, hoveredEdgeId, hoveredResourceId, focusedResourceId]);

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
    viewport.scrollLeft = 0;
    viewport.scrollTop = 0;
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

  const updateZoom = (delta: number) => {
    autoFitRef.current = false;
    setZoom((current) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number((current + delta).toFixed(2)))));
  };
  const resetView = () => {
    setSelectedComponentId(undefined);
    setHoveredEdgeId(undefined);
    setHoveredResourceId(undefined);
    setFocusedResourceId(undefined);
    setSearch('');
    setDomainMode('all');
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

  /* Dragging the empty canvas pans the scroll viewport. Presses that start on a
   * node or lane header keep their own click/keyboard behaviour, so panning can
   * never steal a selection. */
  const beginPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'mouse' || event.button !== 0) return;
    const target = event.target as Element | null;
    if (target?.closest('[data-resource-id], [data-lane-focus], a, button, input, select, textarea')) return;
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

  const liveStateLabel = (state: string) => {
    const key = `topology_live_state_${state}`;
    const translated = t(key);
    return translated === key ? state : translated;
  };

  if (live.isLoading && !data) {
    return <LoadingRows rows={5} />;
  }

  if (live.error && !data) {
    return (
      <EmptyState
        icon={<Layers size={40} />}
        title={t('topology_live_error_title')}
        description={t('topology_live_error_body')}
        action={(
          <div className={styles.liveErrorActions}>
            <button type="button" className="btn btn-secondary" onClick={refresh}>
              <RefreshCw size={15} />
              {t('retry')}
            </button>
            <Link className="btn btn-secondary" to="/topology?view=actual&source=reference">
              {t('topology_live_open_architecture')}
            </Link>
          </div>
        )}
      />
    );
  }

  if (!data) return null;

  const runtime = data.runtime;
  const config = data.config;
  const runtimeStates = presentRuntimeStates(runtime);
  const completeness = liveConfigCompleteness(config);
  const nodeById = new Map(data.nodes.map((node) => [node.componentId, node]));

  return (
    <div className={styles.liveSection} data-live-topology="true">
      <TopologyGraphShell
        titleId="live-topology-title"
        title={t('topology_live_title')}
        subtitle={t('topology_live_subtitle')}
        evidence={t('topology_source_evidence_runtime')}
        completeness={completeness}
        summary={runtimeStates.length > 0 || data.edges.length > 0 || unresolved.length > 0 ? (
          <div className={styles.liveChips}>
            {runtimeStates.map(({ state, count }) => (
              <span key={state} className={styles.liveChip} data-runtime-state={state}>
                {t(`runtime_status_${state}`)} {count}
              </span>
            ))}
            {data.edges.length > 0 ? (
              <span className={styles.liveChip} data-configured-edge-count={data.edges.length}>
                {t('topology_live_configured_edges', { count: data.edges.length })}
              </span>
            ) : null}
            {unresolved.length > 0 ? (
              <span className={styles.liveChip} data-unresolved-peer-count={unresolved.length}>
                {t('topology_live_unresolved_peers', { count: unresolved.length })}
              </span>
            ) : null}
          </div>
        ) : undefined}
        notice={(
          <>
            {!config.manifestConfigured ? (
              <p className={styles.liveWarning} data-config-warning="unconfigured">
                {t('topology_live_config_unconfigured')}
              </p>
            ) : !config.complete ? (
              <p className={styles.liveWarning} data-config-warning="incomplete">
                {t('topology_live_config_incomplete', {
                  available: config.availableSources,
                  total: config.sourceCount,
                })}
              </p>
            ) : (
              <p className={styles.liveConfigNote} data-config-complete="true">
                {t('topology_live_config_complete')}
              </p>
            )}
            {config.unavailable && config.unavailable.length > 0 ? (
              <details className={styles.liveSources}>
                <summary>{t('topology_live_sources')}</summary>
                <ul>
                  {config.unavailable.map((source, index) => (
                    <li key={`${source.componentId ?? 'manifest'}-${source.file ?? 'entry'}-${index}`}>
                      {source.componentId || 'manifest'}
                      {source.file ? ` · ${source.file}` : ''}
                      {' · '}
                      {source.reason}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </>
        )}
        toolbar={(
          <TopologyGraphToolbar
            search={{
              value: search,
              onChange: setSearch,
              label: t('topology_live_search_placeholder'),
              placeholder: t('topology_live_search_placeholder'),
            }}
            filters={(
              <label className={styles.liveDomainFilter}>
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
            )}
            actions={(
              <>
                {interfaceCounts.annotated > 0 ? (
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
                <Link className="btn btn-secondary" to="/topology?view=actual&source=reference">
                  {t('topology_live_open_architecture')}
                </Link>
              </>
            )}
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
        )}
        inspector={selected ? <LiveNodeDetail node={selected} /> : undefined}
        inspectorLabel={t('topology_live_selected')}
        onCloseInspector={() => setSelectedComponentId(undefined)}
        legend={(
          <span className={styles.liveLegendItem}>
            <i className={styles.liveLegendLine} aria-hidden="true" />
            {t('topology_live_evidence_configured')}
          </span>
        )}
        status={(
          <span className={styles.liveStatusFacts}>
            <span data-live-zoom={Math.round(zoom * 100)}>
              {t('topology_zoom_level', { percent: Math.round(zoom * 100) })}
            </span>
            <span data-hidden-label-count={labelVisibility.hiddenCount}>
              {t('topology_labels_hidden', { count: labelVisibility.hiddenCount })}
            </span>
            {showAllInterfaceNames && zoom < LABEL_DETAIL_MIN_ZOOM ? (
              <span data-label-zoom-hint="true">
                {t('topology_interface_zoom_hint', { percent: Math.round(LABEL_DETAIL_MIN_ZOOM * 100) })}
              </span>
            ) : null}
            <span data-live-runtime-total="true">
              {t('topology_live_runtime_total', { count: runtime.total })}
            </span>
          </span>
        )}
        footer={(
          <>
            <section className={styles.liveEdges} aria-labelledby="live-edges-title">
              <h3 id="live-edges-title">{t('topology_live_edges_title')}</h3>
              {data.edges.length === 0 ? (
                <p className={styles.liveMuted}>{t('topology_live_no_edges')}</p>
              ) : (
                <div className={styles.liveTableScroll}>
                  <table className={styles.liveTable}>
                    <caption className="sr-only">{t('topology_live_edges_title')}</caption>
                    <thead>
                      <tr>
                        <th scope="col">{t('topology_from_resource')}</th>
                        <th scope="col">{t('topology_to_resource')}</th>
                        <th scope="col">{t('topology_interfaces')}</th>
                        <th scope="col">{t('topology_live_state')}</th>
                        <th scope="col">{t('topology_live_evidence')}</th>
                        <th scope="col">{t('topology_live_endpoint')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.edges.map((edge) => {
                        const from = nodeById.get(edge.fromComponentId);
                        const to = nodeById.get(edge.toComponentId);
                        return (
                          <tr key={edge.edgeId} data-live-edge-id={edge.edgeId} data-evidence={edge.evidence}>
                            <td>{from?.displayName || edge.fromComponentId}</td>
                            <td>{to?.displayName || edge.toComponentId}</td>
                            <td>{edge.interfaceNames.length > 0 ? edge.interfaceNames.join(' / ') : edge.protocol}</td>
                            <td>{liveStateLabel(edge.state)}</td>
                            <td>{t('topology_live_evidence_configured')}</td>
                            <td>
                              <code>{endpointLabel(edge.fromEndpoint)}</code>
                              {' -> '}
                              <code>{endpointLabel(edge.toEndpoint)}</code>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {unresolved.length > 0 ? (
              <details className={styles.liveUnresolved}>
                <summary>{t('topology_live_unresolved_title')}</summary>
                <ul>
                  {unresolved.map((item, index) => (
                    <li key={`${item.componentId}-${item.protocol}-${item.peer}-${index}`}>
                      <strong>{item.componentId}</strong>
                      {' · '}
                      {item.protocol}
                      {' · '}
                      {item.peer}
                      {' · '}
                      {item.reason}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </>
        )}
      >
        {layout.nodes.length === 0 ? (
          <EmptyState
            icon={<Layers size={40} />}
            title={t('topology_live_error_title')}
            description={t('topology_live_error_body')}
          />
        ) : (
          <div
            ref={canvasRef}
            className={styles.liveCanvasViewport}
            data-live-canvas="true"
            data-panning={panning ? 'true' : undefined}
            onPointerDown={beginPan}
            onPointerMove={movePan}
            onPointerUp={endPan}
            onPointerCancel={endPan}
          >
            <div
              className={styles.liveCanvasScale}
              style={{ width: `${layout.width * zoom}px`, height: `${layout.height * zoom}px` }}
            >
              <ActualTopologyCanvas
                layout={layout}
                selectedResourceId={selectedComponentId}
                focusedResourceId={focusedResourceId}
                hoveredResourceId={hoveredResourceId}
                hoveredEdgeId={hoveredEdgeId}
                search={search}
                zoom={zoom}
                showAllInterfaceNames={showAllInterfaceNames}
                onSelectResource={(resourceId) => {
                  setSelectedComponentId((current) => current === resourceId ? undefined : resourceId);
                }}
                onFocusResource={setFocusedResourceId}
                onHoverResource={setHoveredResourceId}
                onHoverEdge={setHoveredEdgeId}
                onFocusDomain={(domain) => setDomainMode(domain as TopologyDomainMode)}
              />
            </div>
          </div>
        )}
      </TopologyGraphShell>
    </div>
  );
}

function LiveNodeDetail({ node }: { node: LiveNode }) {
  const { t } = useI18n();
  const runtimeStatusLabel = (status: string) => {
    const key = runtimeLabelKey(status);
    const translated = t(key);
    return translated === key ? status : translated;
  };
  return (
    <div className={styles.liveDetailBody}>
      <strong>{node.displayName || node.componentId}</strong>
      <dl className={styles.liveDetailList}>
        <div>
          <dt>{t('topology_live_process')}</dt>
          <dd>{node.processName || '-'}</dd>
        </div>
        <div>
          <dt>{t('topology_runtime_label')}</dt>
          <dd data-runtime-status={node.runtimeStatus}>{runtimeStatusLabel(node.runtimeStatus)}</dd>
        </div>
        <div>
          <dt>{t('topology_live_type_domain')}</dt>
          <dd>{[node.nfType || node.role || '-', node.domain || '-'].join(' / ')}</dd>
        </div>
        <div>
          <dt>{t('topology_live_listeners')}</dt>
          <dd>
            {node.listeners && node.listeners.length > 0 ? (
              <ul className={styles.liveEndpointList}>
                {node.listeners.map((listener, index) => (
                  <li key={`${listener.protocol}-${listener.address}-${listener.port}-${index}`}>
                    <code>{endpointLabel(listener)}</code>
                    {listener.sourceFile ? <span>{listener.sourceFile}</span> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <span className={styles.liveMuted}>{t('topology_live_no_listeners')}</span>
            )}
          </dd>
        </div>
      </dl>
      {node.inventoryResourceId ? (
        <Link className={styles.linkBtn} to={`/inventory/${encodeURIComponent(node.inventoryResourceId)}`}>
          <ExternalLink size={12} aria-hidden="true" />
          {t('topology_live_open_inventory')}
        </Link>
      ) : null}
    </div>
  );
}

export default LiveTopologyView;
