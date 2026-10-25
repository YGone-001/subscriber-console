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
import { TopologyAnnouncer } from './components/TopologyAnnouncer';
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
  LiveEdge,
  LiveEndpoint,
  LiveNode,
  LiveTopologyResponse,
} from './live-topology-types';
import type { RegisterRelationshipDraft } from './topology-types';
import { buildDeclaredDraftFromLink } from './topology-builders';
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

/*
 * Runtime evidence never writes the ledger by itself: the operator selects one
 * link and confirms it, so a declared edge stays an intent the operator owns.
 */
export type LiveTopologyViewProps = {
  /* Registers one configured link. Resolves to an error message, or null when
   * the ledger accepted the edge. */
  onRegisterRelationship?: (draft: RegisterRelationshipDraft) => Promise<string | null>;
};

export function LiveTopologyView({ onRegisterRelationship }: LiveTopologyViewProps) {
  const { t } = useI18n();
  const live = useRead<LiveTopologyResponse>('/api/topology/live');
  const [selectedComponentId, setSelectedComponentId] = useState<string | undefined>();
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | undefined>();
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | undefined>();
  const [focusedEdgeId, setFocusedEdgeId] = useState<string | undefined>();
  const [hoveredResourceId, setHoveredResourceId] = useState<string | undefined>();
  const [focusedResourceId, setFocusedResourceId] = useState<string | undefined>();
  const [search, setSearch] = useState('');
  const [domainMode, setDomainMode] = useState<TopologyDomainMode>('all');
  const [showAllInterfaceNames, setShowAllInterfaceNames] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [panning, setPanning] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<{ kind: 'node' | 'edge'; id: string; element?: Element | null } | undefined>(undefined);
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
  const selectedEdge = data?.edges.find((edge) => edge.edgeId === selectedEdgeId);
  const unresolved = data?.unresolvedPeers ?? [];

  const announcement = useMemo(() => {
    if (live.isLoading && !data) return t('topology_announce_loading');
    if (live.error && !data) return t('topology_announce_unavailable');
    if (!data) return t('topology_announce_loading');
    const name = (componentId: string) => (
      data.nodes.find((node) => node.componentId === componentId)?.displayName || componentId
    );
    if (selectedEdge) {
      return t('topology_announce_selected_edge', {
        from: name(selectedEdge.fromComponentId),
        to: name(selectedEdge.toComponentId),
      });
    }
    if (selected) return t('topology_announce_selected_node', { name: selected.displayName || selected.componentId });
    const filters = [
      search ? `${t('topology_search_filter')}: ${search}` : '',
      domainMode !== 'all'
        ? t(ACTUAL_DOMAIN_MODE_OPTIONS.find((option) => option.value === domainMode)?.labelKey ?? 'topology_domain_all')
        : '',
    ].filter(Boolean).join(' · ');
    return t('topology_announce_loaded', {
      nodes: data.nodes.length,
      links: data.edges.length,
      filters: filters || t('topology_announce_no_filters'),
    });
  }, [live.isLoading, live.error, data, selected, selectedEdge, search, domainMode, t]);

  useEffect(() => {
    if (selectedComponentId && data && !data.nodes.some((node) => node.componentId === selectedComponentId)) {
      setSelectedComponentId(undefined);
    }
    if (selectedEdgeId && data && !data.edges.some((edge) => edge.edgeId === selectedEdgeId)) {
      setSelectedEdgeId(undefined);
    }
    if (hoveredEdgeId && !layout.links.some((link) => link.edgeId === hoveredEdgeId)) {
      setHoveredEdgeId(undefined);
    }
    if (focusedEdgeId && !layout.links.some((link) => link.edgeId === focusedEdgeId)) {
      setFocusedEdgeId(undefined);
    }
    if (hoveredResourceId && !layout.nodes.some((node) => node.resourceId === hoveredResourceId)) {
      setHoveredResourceId(undefined);
    }
    if (focusedResourceId && !layout.nodes.some((node) => node.resourceId === focusedResourceId)) {
      setFocusedResourceId(undefined);
    }
  }, [data, selectedComponentId, selectedEdgeId, layout.links, layout.nodes, hoveredEdgeId, focusedEdgeId, hoveredResourceId, focusedResourceId]);

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
    setSelectedComponentId(undefined);
    setSelectedEdgeId(undefined);
    triggerRef.current = undefined;
    setHoveredEdgeId(undefined);
    setHoveredResourceId(undefined);
    setFocusedResourceId(undefined);
    setFocusedEdgeId(undefined);
    setSearch('');
    setDomainMode('all');
    setShowAllInterfaceNames(false);
    fitView();
  };
  const selectNode = (componentId: string) => {
    if (componentId === selectedComponentId) {
      triggerRef.current = undefined;
      setSelectedComponentId(undefined);
      return;
    }
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    triggerRef.current = {
      kind: 'node',
      id: componentId,
      element: active && active !== document.body ? active : null,
    };
    setSelectedEdgeId(undefined);
    setSelectedComponentId(componentId);
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
    setSelectedComponentId(undefined);
    setSelectedEdgeId(edgeId);
  };
  const closeInspector = useCallback(() => {
    setSelectedComponentId(undefined);
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
    return (
      <div className={styles.liveSection}>
        <TopologyAnnouncer message={t('topology_announce_loading')} />
        <TopologyGraphShell
          titleId="live-topology-title"
          title={t('topology_live_title')}
          subtitle={t('topology_live_subtitle')}
          evidence={t('topology_source_evidence_runtime')}
        >
          <div className={styles.statePanel} data-state-panel="loading">
            <LoadingRows rows={5} />
          </div>
        </TopologyGraphShell>
      </div>
    );
  }

  if (live.error && !data) {
    return (
      <div className={styles.liveSection}>
        <TopologyAnnouncer message={t('topology_announce_unavailable')} />
        <TopologyGraphShell
          titleId="live-topology-title"
          title={t('topology_live_title')}
          subtitle={t('topology_live_subtitle')}
          evidence={t('topology_source_evidence_runtime')}
        >
          <div className={styles.statePanel} data-state-panel="unavailable" data-state-source="topology-live">
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
            <p className={styles.stateSource}>{t('topology_live_unavailable_source')}</p>
          </div>
        </TopologyGraphShell>
      </div>
    );
  }

  if (!data) return null;

  const runtime = data.runtime;
  const config = data.config;
  const runtimeStates = presentRuntimeStates(runtime);
  const completeness = liveConfigCompleteness(config);
  const unavailableSources = config.unavailable ?? [];
  const nodeById = new Map(data.nodes.map((node) => [node.componentId, node]));

  return (
    <div className={styles.liveSection} data-live-topology="true">
      <TopologyAnnouncer message={announcement} />
      <TopologyGraphShell
        titleId="live-topology-title"
        title={t('topology_live_title')}
        subtitle={t('topology_live_subtitle')}
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
        notice={(!config.manifestConfigured || !config.complete || unavailableSources.length > 0) ? (
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
            ) : null}
            {unavailableSources.length > 0 ? (
              <details className={styles.liveSources}>
                <summary>{t('topology_live_sources')}</summary>
                <ul>
                  {unavailableSources.map((source, index) => (
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
        ) : undefined}
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
        inspector={selectedEdge ? (
          <LiveEdgeDetail
            edge={selectedEdge}
            nodes={data.nodes}
            onSelectNode={selectNode}
            onRegister={onRegisterRelationship}
          />
        ) : selected ? (
          <LiveNodeDetail
            node={selected}
            nodes={data.nodes}
            edges={data.edges.filter((edge) => (
              edge.fromComponentId === selected.componentId || edge.toComponentId === selected.componentId
            ))}
            onSelectEdge={selectEdge}
          />
        ) : undefined}
        inspectorLabel={selectedEdge ? t('topology_inspector_edge') : t('topology_live_selected')}
        onCloseInspector={closeInspector}
        legend={(
          <span className={styles.liveLegendItem}>
            <i className={styles.liveLegendLine} aria-hidden="true" />
            {t('topology_live_evidence_configured')}
          </span>
        )}
        status={(
          <span className={styles.liveStatusFacts}>
            {config.manifestConfigured && config.complete ? (
              <span data-live-config-read="complete">{t('topology_live_config_complete')}</span>
            ) : null}
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
            <section className={styles.topologyListSection} aria-labelledby="live-nodes-title">
              <h3 id="live-nodes-title">{t('topology_list_nodes')}</h3>
              <div className={styles.topologyListScroll}>
                <table className={styles.topologyListTable}>
                  <caption className="sr-only">{t('topology_list_nodes')}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t('topology_list_name')}</th>
                      <th scope="col">{t('topology_live_type_domain')}</th>
                      <th scope="col">{t('topology_runtime_label')}</th>
                      <th scope="col">{t('topology_list_state')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.nodes.map((node) => {
                      const runtimeKey = `runtime_status_${node.runtimeStatus}`;
                      const runtimeText = t(runtimeKey);
                      return (
                        <tr key={node.componentId} data-live-node-row={node.componentId}>
                          <th scope="row">
                            <button
                              type="button"
                              className={styles.linkBtn}
                              data-list-node={node.componentId}
                              onFocus={() => setFocusedResourceId(node.componentId)}
                              onBlur={() => setFocusedResourceId(undefined)}
                              onClick={() => selectNode(node.componentId)}
                            >
                              {node.displayName || node.componentId}
                            </button>
                          </th>
                          <td>{[node.nfType || node.role || '-', node.domain || '-'].join(' / ')}</td>
                          <td>{runtimeText === runtimeKey ? node.runtimeStatus : runtimeText}</td>
                          <td>{node.inventoryResourceId ? t('arch_binding_bound') : t('arch_binding_unbound')}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>

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
                            <td>
                              <button
                                type="button"
                                className={styles.linkBtn}
                                data-list-edge={edge.edgeId}
                                onFocus={() => setFocusedEdgeId(edge.edgeId)}
                                onBlur={() => setFocusedEdgeId(undefined)}
                                onClick={() => selectEdge(edge.edgeId)}
                              >
                                {from?.displayName || edge.fromComponentId}
                              </button>
                            </td>
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
          <div className={styles.statePanel} data-state-panel="empty" data-state-source="topology-live">
            <EmptyState
              icon={<Layers size={40} />}
              title={t('topology_live_empty_title')}
              description={t('topology_live_empty_body')}
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
          </div>
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
                selectedEdgeId={selectedEdgeId}
                focusedResourceId={focusedResourceId}
                focusedEdgeId={focusedEdgeId}
                hoveredResourceId={hoveredResourceId}
                hoveredEdgeId={hoveredEdgeId}
                search={search}
                zoom={zoom}
                showAllInterfaceNames={showAllInterfaceNames}
                onSelectResource={selectNode}
                onSelectEdge={selectEdge}
                onFocusResource={setFocusedResourceId}
                onFocusEdge={setFocusedEdgeId}
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

function LiveNodeDetail({
  node,
  nodes,
  edges,
  onSelectEdge,
}: {
  node: LiveNode;
  nodes: LiveNode[];
  edges: LiveEdge[];
  onSelectEdge: (edgeId: string) => void;
}) {
  const { t } = useI18n();
  const nodeName = (componentId: string) => (
    nodes.find((candidate) => candidate.componentId === componentId)?.displayName || componentId
  );
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
          <dt>{t('topology_inspector_identity')}</dt>
          <dd><code>{node.inventoryResourceId || node.componentId}</code></dd>
        </div>
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
        <div>
          <dt>{t('topology_inspector_evidence')}</dt>
          <dd>{t('topology_source_evidence_runtime')}</dd>
        </div>
      </dl>
      <section aria-label={t('topology_related_relationships')}>
        <h4 className={styles.inspectorSectionTitle}>{t('topology_related_relationships')}</h4>
        {edges.length === 0 ? (
          <p className={styles.liveMuted}>{t('topology_no_relationships')}</p>
        ) : (
          <ul className={styles.actualInspectorLinks}>
            {edges.map((edge) => (
              <li key={edge.edgeId}>
                <button
                  type="button"
                  className={styles.linkBtn}
                  data-related-edge={edge.edgeId}
                  onClick={() => onSelectEdge(edge.edgeId)}
                >
                  {nodeName(edge.fromComponentId)} -&gt; {nodeName(edge.toComponentId)}
                  {' · '}
                  {edge.interfaceNames.length > 0 ? edge.interfaceNames.join(' / ') : edge.protocol}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {node.inventoryResourceId ? (
        <Link className={styles.linkBtn} to={`/inventory/${encodeURIComponent(node.inventoryResourceId)}`}>
          <ExternalLink size={12} aria-hidden="true" />
          {t('topology_live_open_inventory')}
        </Link>
      ) : null}
    </div>
  );
}

function LiveEdgeDetail({
  edge,
  nodes,
  onSelectNode,
  onRegister,
}: {
  edge: LiveEdge;
  nodes: LiveNode[];
  onSelectNode: (componentId: string) => void;
  onRegister?: (draft: RegisterRelationshipDraft) => Promise<string | null>;
}) {
  const { t } = useI18n();
  const from = nodes.find((node) => node.componentId === edge.fromComponentId);
  const to = nodes.find((node) => node.componentId === edge.toComponentId);
  const stateKey = `topology_live_state_${edge.state}`;
  const translated = t(stateKey);
  const fromResourceId = from?.inventoryResourceId;
  const toResourceId = to?.inventoryResourceId;
  const [registerState, setRegisterState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [registerError, setRegisterError] = useState<string | null>(null);

  const register = async () => {
    if (!onRegister) return;
    const draft = buildDeclaredDraftFromLink({
      relationshipType: edge.relationshipType,
      interfaceNames: edge.interfaceNames,
      fromResourceId,
      toResourceId,
      description: t('topology_live_register_description', {
        reference: edge.interfaceNames.length > 0 ? edge.interfaceNames.join(' / ') : edge.protocol,
        source: edge.sourceFiles && edge.sourceFiles.length > 0 ? edge.sourceFiles[0] : edge.protocol,
      }),
    });
    if (!draft) return;
    setRegisterState('busy');
    setRegisterError(null);
    const failure = await onRegister(draft);
    if (failure) {
      setRegisterError(failure);
      setRegisterState('idle');
      return;
    }
    setRegisterState('done');
  };
  return (
    <div className={styles.liveDetailBody}>
      <strong>
        {from?.displayName || edge.fromComponentId} -&gt; {to?.displayName || edge.toComponentId}
      </strong>
      <dl className={styles.liveDetailList}>
        <div>
          <dt>{t('topology_from_resource')}</dt>
          <dd>
            <button type="button" className={styles.linkBtn} onClick={() => onSelectNode(edge.fromComponentId)}>
              {from?.displayName || edge.fromComponentId}
            </button>
          </dd>
        </div>
        <div>
          <dt>{t('topology_interfaces')}</dt>
          <dd>{edge.interfaceNames.length > 0 ? edge.interfaceNames.join(' / ') : edge.protocol}</dd>
        </div>
        <div>
          <dt>{t('topology_to_resource')}</dt>
          <dd>
            <button type="button" className={styles.linkBtn} onClick={() => onSelectNode(edge.toComponentId)}>
              {to?.displayName || edge.toComponentId}
            </button>
          </dd>
        </div>
        <div>
          <dt>{t('topology_live_state')}</dt>
          <dd>{translated === stateKey ? edge.state : translated}</dd>
        </div>
        <div>
          <dt>{t('topology_live_evidence')}</dt>
          <dd>{t('topology_live_evidence_configured')}</dd>
        </div>
        <div>
          <dt>{t('topology_live_endpoint')}</dt>
          <dd>
            <code>{endpointLabel(edge.fromEndpoint)}</code>
            {' -> '}
            <code>{endpointLabel(edge.toEndpoint)}</code>
          </dd>
        </div>
        {edge.sourceFiles && edge.sourceFiles.length > 0 ? (
          <div>
            <dt>{t('topology_live_sources')}</dt>
            <dd>{edge.sourceFiles.join(', ')}</dd>
          </div>
        ) : null}
      </dl>
      {onRegister && fromResourceId && toResourceId ? (
        <div className={styles.liveDetailAction} data-register-edge={edge.edgeId}>
          {registerState === 'done' ? (
            <span data-registered-edge="true">{t('topology_live_registered')}</span>
          ) : (
            <button
              type="button"
              className="btn btn-secondary"
              data-action="register-declared-relationship"
              disabled={registerState === 'busy'}
              onClick={() => { void register(); }}
            >
              {registerState === 'busy' ? t('topology_live_registering') : t('topology_live_register')}
            </button>
          )}
          {registerError ? (
            <p className={styles.liveDetailError} role="alert" data-register-error="true">{registerError}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export default LiveTopologyView;
