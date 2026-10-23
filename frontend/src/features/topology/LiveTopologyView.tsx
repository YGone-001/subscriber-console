/*
 * Read-only live topology.
 *
 * Nodes come from the current runtime snapshot. Links come only from explicit
 * NF_ETC configuration; they are configured evidence, not observed traffic and
 * not a health claim. No write control is rendered here.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink, Layers, RefreshCw, Search } from 'lucide-react';
import { useRead } from '../../lib/api/use-read';
import { useI18n } from '../../providers/I18nProvider';
import { EmptyState, LoadingRows } from '../../components/ui/OperationFeedback';
import { useRegisterOperationsRefresh } from '../operations/operations-refresh';
import { ActualTopologyCanvas } from './components/ActualTopologyCanvas';
import { buildActualTopology } from './actual-topology-model';
import { liveDirectory, liveEdges } from './live-topology-model';
import type {
  LiveEndpoint,
  LiveNode,
  LiveTopologyResponse,
} from './live-topology-types';
import styles from '../../styles/modules/architecture.module.css';

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
  const [search, setSearch] = useState('');
  const data = live.data;
  const refresh = useCallback(() => {
    void live.mutate();
  }, [live.mutate]);
  useRegisterOperationsRefresh('topology:actual:live', refresh);

  const directory = useMemo(() => liveDirectory(data), [data]);
  const liveLinks = useMemo(() => liveEdges(data), [data]);
  const runtimeResources = useMemo(() => Object.values(directory), [directory]);
  const layout = useMemo(
    () => buildActualTopology(liveLinks, directory, { domainMode: 'all', resources: runtimeResources }),
    [liveLinks, directory, runtimeResources],
  );
  const selected = data?.nodes.find((node) => node.componentId === selectedComponentId);
  const unresolved = data?.unresolvedPeers ?? [];

  useEffect(() => {
    if (selectedComponentId && data && !data.nodes.some((node) => node.componentId === selectedComponentId)) {
      setSelectedComponentId(undefined);
    }
  }, [data, selectedComponentId]);

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
  const attentionCount = runtime.unverified + runtime.permissionDenied + runtime.unknown + runtime.stale;
  const config = data.config;
  const nodeById = new Map(data.nodes.map((node) => [node.componentId, node]));

  return (
    <section className={styles.liveSection} aria-labelledby="live-topology-title" data-live-topology="true">
      <h2 id="live-topology-title" className="sr-only">{t('topology_live_title')}</h2>
      <div className={styles.liveHeader}>
        <div className={styles.liveHeading}>
          <strong>{t('topology_live_title')}</strong>
          <p>{t('topology_live_subtitle')}</p>
        </div>
        <div className={styles.liveChips} role="status">
          <span className={styles.liveChip} data-runtime-running={runtime.running}>
            {t('runtime_status_running')} {runtime.running}
          </span>
          <span className={styles.liveChip} data-runtime-stopped={runtime.stopped}>
            {t('runtime_status_stopped')} {runtime.stopped}
          </span>
          <span className={styles.liveChip} data-runtime-attention={attentionCount}>
            {t('topology_live_attention', { count: attentionCount })}
          </span>
          <span className={styles.liveChip} data-runtime-not-detected={runtime.notDetected}>
            {t('runtime_status_not_detected')} {runtime.notDetected}
          </span>
          <span className={styles.liveChip} data-configured-edge-count={data.edges.length}>
            {t('topology_live_configured_edges', { count: data.edges.length })}
          </span>
          {unresolved.length > 0 ? (
            <span className={styles.liveChip} data-unresolved-peer-count={unresolved.length}>
              {t('topology_live_unresolved_peers', { count: unresolved.length })}
            </span>
          ) : null}
        </div>
        <div className={styles.liveActions}>
          <Link className="btn btn-secondary" to="/topology?view=actual&source=reference">
            {t('topology_live_open_architecture')}
          </Link>
        </div>
      </div>

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

      <div className={styles.liveToolbar}>
        <label className={styles.liveSearch}>
          <Search size={15} aria-hidden="true" />
          <span className="sr-only">{t('topology_live_search_placeholder')}</span>
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('topology_live_search_placeholder')}
          />
        </label>
        <span>{t('topology_live_runtime_total', { count: runtime.total })}</span>
      </div>

      {layout.nodes.length === 0 ? (
        <EmptyState
          icon={<Layers size={40} />}
          title={t('topology_live_error_title')}
          description={t('topology_live_error_body')}
        />
      ) : (
        <div className={styles.liveCanvasViewport} data-live-canvas="true">
          <div style={{ width: `${layout.width}px`, height: `${layout.height}px` }}>
            <ActualTopologyCanvas
              layout={layout}
              selectedResourceId={selectedComponentId}
              search={search}
              showAllInterfaceNames
              onSelectResource={(resourceId) => {
                setSelectedComponentId((current) => current === resourceId ? undefined : resourceId);
              }}
              onHoverEdge={() => {}}
            />
          </div>
        </div>
      )}

      <div className={styles.liveBody}>
        <aside className={styles.liveDetail} aria-label={t('topology_live_selected')}>
          {selected ? (
            <LiveNodeDetail node={selected} />
          ) : (
            <p className={styles.liveMuted}>{t('topology_live_detail_empty')}</p>
          )}
        </aside>

        <section className={styles.liveEdges} aria-labelledby="live-edges-title">
          <h3 id="live-edges-title">{t('topology_live_edges_title')}</h3>
          {data.edges.length === 0 ? (
            <p className={styles.liveMuted}>{t('topology_live_no_edges')}</p>
          ) : (
            <div className={styles.liveTableScroll}>
              <table className={styles.liveTable}>
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
      </div>

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
    </section>
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
      <span className={styles.liveEyebrow}>{t('topology_live_selected')}</span>
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
