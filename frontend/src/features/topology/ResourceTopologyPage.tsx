/*
 * Resource topology detail (/topology/:resourceId).
 *
 * A mandatory visual deliverable: the one-hop relationship neighbourhood of a
 * single Inventory resource, rendered as a deterministic directed graph with an
 * equivalent accessible relationship table and a selected-relationship detail
 * panel.
 *
 * Only edges returned by the Topology API are rendered. An edge recorded as
 * `active` is a DECLARED relationship; it is never presented as a verified
 * healthy network interface.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, GitBranch, RefreshCw } from 'lucide-react';
import { ErrorState, LoadingState } from '../../components/ui/StatePanel';
import PageHeader from '../../components/ui/PageHeader';
import { EmptyState } from '../../components/ui/OperationFeedback';
import { useI18n } from '../../providers/I18nProvider';
import { resolveReturnTo } from '../../lib/return-to';
import { createLatestRequestGuard } from '../../lib/api/latest-request';
import { useOperationsUrlState } from '../operations/use-operations-url-state';
import { fetchTopologyNeighbors, fetchTopologyMeta } from './topology-api';
import type {
  DirectionFilter,
  NeighborsResponse,
  ResourceProjection,
  TopologyMetaResponse,
} from './topology-types';
import { DOMAIN_FILTER_BUCKETS, RELATIONSHIP_PRESENTATION } from './topology-types';
import { primeResourceProjections } from './use-resource-directory';
import { TopologyGraph } from './components/TopologyGraph';
import { TopologyEdgeTable } from './components/TopologyEdgeTable';
import { TopologyEdgeDetail } from './components/TopologyEdgeDetail';
import styles from '../../styles/modules/topology.module.css';

const PAGE_LIMIT = 50;

export function ResourceTopologyPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const returnTo = resolveReturnTo(location.search, '/topology', ['/topology']);
  const { resourceId = '' } = useParams();

  const [meta, setMeta] = useState<TopologyMetaResponse | null>(null);
  const [data, setData] = useState<NeighborsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  /* The one-hop view keeps its filters, page cursor and selected relationship in
   the query string, so reload, Back/Forward and a shared link restore the same
   neighbourhood instead of resetting to the default filter set. */
  const url = useOperationsUrlState({
    keys: ['direction', 'relationship', 'state', 'domain', 'selected'],
    clearKeys: ['direction', 'relationship', 'state', 'domain', 'selected'],
  });
  const direction = (url.filters.direction || 'both') as DirectionFilter;
  const relationshipType = url.filters.relationship || '';
  const lifecycleState = url.filters.state || 'active';
  const domainBucket = url.filters.domain || '';
  const selectedEdgeId = url.filters.selected || undefined;
  const cursor = url.cursor;

  const setDirection = (value: DirectionFilter) => url.setFilter('direction', value === 'both' ? '' : value);
  const setRelationshipType = (value: string) => url.setFilter('relationship', value);
  const setLifecycleState = (value: string) => url.setFilter('state', value === 'active' ? '' : value);
  const setDomainBucket = (value: string) => url.setFilter('domain', value);
  const setSelectedEdgeId = (value?: string) => url.setFilter('selected', value ?? '');
  const setCursor = (value?: string) => url.setCursor(value);

  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);

  /* Neighbour reads are imperative and re-issued on every filter or cursor
   * change. A slow earlier page must never replace the page the operator is now
   * on, so only the newest read may write state. */
  const readGuard = useRef(createLatestRequestGuard());
  const readAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    fetchTopologyMeta()
      .then(setMeta)
      .catch(() => {
        /* Falls back to raw relationship identifiers. */
      });
  }, []);

  const load = useCallback(
    async (activeCursor?: string) => {
      if (!resourceId) return;
      const token = readGuard.current.begin();
      readAbort.current?.abort();
      const controller = new AbortController();
      readAbort.current = controller;
      setLoading(true);
      setError(null);
      setNotFound(false);
      try {
        const res = await fetchTopologyNeighbors(resourceId, {
          direction,
          relationshipType: relationshipType || undefined,
          lifecycleState: lifecycleState || undefined,
          cursor: activeCursor,
          limit: PAGE_LIMIT,
        }, controller.signal);
        if (!readGuard.current.isCurrent(token)) return;
        setData(res);
        setNextCursor(res.page?.nextCursor ?? null);
        setHasMore(Boolean(res.page?.hasMore));
        primeResourceProjections([res.rootResource, ...res.neighbors.map((n) => n.neighborResource)]);
      } catch (err) {
        if (!readGuard.current.isCurrent(token)) return;
        const status = (err as { status?: number }).status;
        if (status === 404) {
          setNotFound(true);
        } else {
          setError(err instanceof Error && err.message ? err.message : t('topology_err_load'));
        }
        setData(null);
      } finally {
        if (readGuard.current.isCurrent(token)) setLoading(false);
      }
    },
    [resourceId, direction, relationshipType, lifecycleState, t],
  );

  /* Abort on unmount only; superseded reads are already dropped by the guard. */
  useEffect(() => () => readAbort.current?.abort(), []);

  /* The URL owns the cursor: a filter change drops it in the shared hook, so the
   read is driven by the cursor rather than by component state. */
  useEffect(() => {
    void load(cursor);
  }, [load, cursor]);

  /* The pager keeps its own back-list for the visible previous control; a shared
     link restores the cursor itself, and browser Back restores the filters. */
  const filterSignature = `${direction}|${relationshipType}|${lifecycleState}|${domainBucket}`;
  const filterSignatureRef = useRef(filterSignature);
  useEffect(() => {
    if (filterSignatureRef.current === filterSignature) return;
    filterSignatureRef.current = filterSignature;
    setCursorHistory([]);
  }, [filterSignature]);

  const relationshipLabel = useCallback(
    (value: string) => {
      const presentation = RELATIONSHIP_PRESENTATION[value];
      return presentation ? t(presentation.labelKey) : value;
    },
    [t],
  );

  const directory = useMemo<Record<string, ResourceProjection>>(() => {
    if (!data) return {};
    const map: Record<string, ResourceProjection> = { [data.rootResource.resourceId]: data.rootResource };
    for (const neighbor of data.neighbors) {
      map[neighbor.neighborResource.resourceId] = neighbor.neighborResource;
    }
    return map;
  }, [data]);

  /* Presentation-only domain filter over the Inventory domain values carried by
     the returned neighbours. It is not a relationship type and never alters the
     server query. */
  const filteredNeighbors = useMemo(() => {
    if (!data) return [];
    if (!domainBucket) return data.neighbors;
    const bucket = DOMAIN_FILTER_BUCKETS.find((entry) => entry.key === domainBucket);
    if (!bucket) return data.neighbors;
    return data.neighbors.filter((neighbor) => bucket.domains.includes(neighbor.neighborResource.domain));
  }, [data, domainBucket]);

  const filteredEdges = useMemo(() => filteredNeighbors.map((neighbor) => neighbor.edge), [filteredNeighbors]);

  const selectedEdge = useMemo(() => {
    const pool = filteredEdges.length > 0 ? filteredEdges : (data?.neighbors ?? []).map((n) => n.edge);
    return pool.find((edge) => edge.edgeId === selectedEdgeId) ?? null;
  }, [filteredEdges, data, selectedEdgeId]);

  const rootName = data ? data.rootResource.displayName || data.rootResource.name : resourceId;
  const pageIndex = cursorHistory.length + 1;

  const handleNextPage = () => {
    if (!nextCursor) return;
    setCursorHistory((prev) => [...prev, cursor ?? '']);
    setCursor(nextCursor);
  };

  const handlePrevPage = () => {
    if (cursorHistory.length === 0) return;
    const history = [...cursorHistory];
    const previous = history.pop() ?? '';
    setCursorHistory(history);
    setCursor(previous || undefined);
  };

  return (
    <div className="container animate-fade-in">
      <PageHeader
        eyebrow={t('eyebrow_topology')}
        icon={<GitBranch size={23} />}
        title={rootName}
        description={
          data
            ? `${data.rootResource.kind} · ${data.rootResource.domain} · ${data.rootResource.lifecycleState}`
            : t('topology_resource_description')
        }
        actions={(
          <>
            <button type="button" className="btn btn-secondary" onClick={() => navigate(returnTo)}>
              <ArrowLeft size={16} />
              {t('topology_back_to_list')}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => navigate(`/inventory/${encodeURIComponent(resourceId)}`)}
            >
              {t('topology_open_inventory')}
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => load(cursor)} disabled={loading}>
              <RefreshCw size={16} className={loading ? styles.spin : undefined} />
              {t('refresh')}
            </button>
          </>
        )}
      />

      {notFound ? (
        <section className="dash-card">
          <div className={styles.stateWrap}>
            <EmptyState
              icon={<GitBranch size={44} />}
              title={t('topology_unknown_resource_title')}
              description={t('topology_unknown_resource_body')}
              action={(
                <button type="button" className="btn btn-secondary" onClick={() => navigate(returnTo)}>
                  {t('topology_back_to_list')}
                </button>
              )}
            />
          </div>
        </section>
      ) : error ? (
        <section className="dash-card">
          <div className={styles.errorWrap}>
            <ErrorState title={t('error')} message={error} retryLabel={t('retry')} onRetry={() => load(cursor)} />
          </div>
        </section>
      ) : loading && !data ? (
        <section className="dash-card">
          <div className={styles.stateWrap}>
            <LoadingState label={t('loading')} />
          </div>
        </section>
      ) : data ? (
        <>
          <section className="dash-card">
            <div className={styles.toolbar}>
              <div className={styles.filterGroup}>
                <select
                  className="form-input"
                  aria-label={t('topology_direction')}
                  value={direction}
                  onChange={(event) => setDirection(event.target.value as DirectionFilter)}
                >
                  <option value="both">{t('topology_direction_both')}</option>
                  <option value="inbound">{t('topology_direction_inbound')}</option>
                  <option value="outbound">{t('topology_direction_outbound')}</option>
                </select>
                <select
                  className="form-input"
                  aria-label={t('topology_relationship')}
                  value={relationshipType}
                  onChange={(event) => setRelationshipType(event.target.value)}
                >
                  <option value="">{t('topology_all_relationships')}</option>
                  {(meta?.relationshipTypes ?? []).map((value) => (
                    <option key={value} value={value}>
                      {relationshipLabel(value)}
                    </option>
                  ))}
                </select>
                <select
                  className="form-input"
                  aria-label={t('topology_lifecycle')}
                  value={lifecycleState}
                  onChange={(event) => setLifecycleState(event.target.value)}
                >
                  {(meta?.lifecycleStates ?? ['active', 'retired']).map((value) => (
                    <option key={value} value={value}>
                      {value === 'retired' ? t('topology_state_retired') : t('topology_state_active')}
                    </option>
                  ))}
                </select>
                <select
                  className="form-input"
                  aria-label={t('topology_domain_filter')}
                  value={domainBucket}
                  onChange={(event) => setDomainBucket(event.target.value)}
                >
                  <option value="">{t('topology_domain_all')}</option>
                  {DOMAIN_FILTER_BUCKETS.map((bucket) => (
                    <option key={bucket.key} value={bucket.key}>
                      {t(bucket.labelKey)}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <p className={styles.declaredNotice}>{t('topology_declared_notice')}</p>

            {filteredNeighbors.length === 0 ? (
              <div className={styles.stateWrap}>
                <EmptyState
                  icon={<GitBranch size={44} />}
                  title={t('topology_graph_empty_title')}
                  description={t('topology_graph_empty_body')}
                />
              </div>
            ) : (
              <div className={styles.graphLayout}>
                <TopologyGraph
                  root={data.rootResource}
                  neighbors={filteredNeighbors}
                  selectedEdgeId={selectedEdgeId}
                  onSelectEdge={setSelectedEdgeId}
                />
                <TopologyEdgeDetail
                  edge={selectedEdge}
                  directory={directory}
                  canConfigure={false}
                  onViewResource={(id) => navigate(`/topology/${encodeURIComponent(id)}`)}
                />
              </div>
            )}
          </section>

          <section className="dash-card">
            <h2 className={styles.sectionTitle}>{t('topology_relationships_table_title')}</h2>
            {filteredNeighbors.length === 0 ? (
              <div className={styles.stateWrap}>
                <EmptyState
                  icon={<GitBranch size={44} />}
                  title={t('topology_empty_title')}
                  description={t('topology_empty_body')}
                />
              </div>
            ) : (
              <TopologyEdgeTable
                edges={filteredEdges}
                directory={directory}
                caption={t('topology_table_caption')}
                rootResourceId={resourceId}
                selectedEdgeId={selectedEdgeId}
                canConfigure={false}
                onSelectEdge={setSelectedEdgeId}
                onViewResource={(id) => navigate(`/topology/${encodeURIComponent(id)}`)}
              />
            )}

            {data.neighbors.length > 0 ? (
              <nav className={styles.pager} aria-label={t('topology_title')}>
                <div className={styles.pagerSummary} aria-live="polite">
                  {t('topology_showing_edges', { count: data.neighbors.length })}
                </div>
                <div className={styles.pagerControls}>
                  <button type="button" onClick={handlePrevPage} disabled={pageIndex === 1 || loading}>
                    {t('topology_prev_page')}
                  </button>
                  <span className={styles.pageNumber}>
                    {t('topology_page_indicator', { page: pageIndex })}
                  </span>
                  <button type="button" onClick={handleNextPage} disabled={!hasMore || !nextCursor || loading}>
                    {t('next')}
                  </button>
                </div>
              </nav>
            ) : null}
          </section>
        </>
      ) : null}
    </div>
  );
}

export default ResourceTopologyPage;
