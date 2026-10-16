/*
 * Network element view.
 *
 * A CNMS-inspired, network-function-oriented view over the existing Inventory
 * route. It is a view mode inside `/inventory`: the general Inventory listing,
 * its CRUD workflows and its governance remain untouched, and no resource is
 * ever created, mutated or retired from this surface.
 *
 * Data authorities:
 *   - Inventory  -> resources, domain, kind, role, lifecycle
 *   - NF Health  -> monitoring association, coverage, layers, freshness, metrics
 *   - Topology   -> declared `contains` relationships for the hierarchy
 *
 * Every unavailable value is rendered as an explicit unavailable state; an
 * active Inventory lifecycle is never rendered as a running process, and a
 * missing monitoring association is never rendered as stopped.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, RefreshCw, Search, Server, X } from 'lucide-react';
import { useRead } from '../../lib/api/use-read';
import { useI18n } from '../../providers/I18nProvider';
import { EmptyState, LoadingRows } from '../../components/ui/OperationFeedback';
import {
  applyResolvedNFTypes,
  buildOperationalResources,
  buildResourceTree,
  cpuView,
  formatBytes,
  memoryView,
  OPERATIONAL_DOMAINS,
  treeResourceIds,
  type TreeNode,
} from './operational-model';
import styles from '../../styles/modules/operations.module.css';

const PAGE_LIMIT = 20;
const EDGE_LIMIT = 200;

type ResourceListPayload = { resources?: unknown[]; page?: { nextCursor?: string | null; hasMore?: boolean } };
type TargetListPayload = { targets?: unknown[]; page?: { hasMore?: boolean } };
type EdgeListPayload = { edges?: unknown[] };

type MonitoringFilter = '' | 'monitored' | 'unmonitored' | 'degraded' | 'unknown' | 'stale';

function stateLabel(state: string, t: (key: string) => string): string {
  const known = [
    'healthy', 'degraded', 'unhealthy', 'unknown', 'stale',
    'not_configured', 'not_monitored', 'fresh',
  ];
  if (!state) return t('ops_state_unknown');
  return known.includes(state) ? t(`ops_state_${state}`) : state;
}

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
    default:
      return styles.toneUnknown;
  }
}

function TreeBranch({
  node,
  depth,
  selectedId,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  selectedId: string;
  onSelect: (node: TreeNode) => void;
}) {
  const [open, setOpen] = useState(depth < 2);
  const hasChildren = node.children.length > 0;
  const selected = selectedId === node.id;

  return (
    <li className={styles.treeItem}>
      <div className={styles.treeRow} style={{ paddingInlineStart: `${depth * 12}px` }}>
        {hasChildren ? (
          <button
            type="button"
            className={styles.treeToggle}
            aria-expanded={open}
            aria-label={`${open ? 'collapse' : 'expand'} ${node.label}`}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        ) : (
          <span className={styles.treeSpacer} aria-hidden="true" />
        )}
        <button
          type="button"
          className={`${styles.treeButton} ${selected ? styles.treeButtonSelected : ''}`}
          aria-pressed={selected}
          onClick={() => onSelect(node)}
        >
          <span className={styles.treeLabel}>{node.label}</span>
          {node.virtual ? <span className={styles.treeVirtual}>{node.kind === 'domain_group' ? node.domain : node.kind}</span> : null}
          <span className={styles.treeCount}>{treeResourceIds(node).length}</span>
        </button>
      </div>
      {hasChildren && open ? (
        <ul className={styles.treeList}>
          {node.children.map((child) => (
            <TreeBranch
              key={child.id}
              node={child}
              depth={depth + 1}
              selectedId={selectedId}
              onSelect={onSelect}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export default function NetworkElementView() {
  const { t } = useI18n();

  const [search, setSearch] = useState('');
  const [domain, setDomain] = useState('');
  const [kind, setKind] = useState('');
  const [monitoring, setMonitoring] = useState<MonitoringFilter>('');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState('');
  const [selectedResourceIds, setSelectedResourceIds] = useState<string[] | null>(null);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    params.set('limit', String(PAGE_LIMIT));
    if (search.trim()) params.set('q', search.trim());
    if (domain) params.set('domain', domain);
    if (kind) params.set('kind', kind);
    if (cursor) params.set('cursor', cursor);
    return params.toString();
  }, [search, domain, kind, cursor]);

  const resourcesRead = useRead<ResourceListPayload>(`/api/inventory/resources?${query}`);
  const targetsRead = useRead<TargetListPayload>(`/api/nf-health/targets?limit=${PAGE_LIMIT}`);
  const edgesRead = useRead<EdgeListPayload>(`/api/topology/edges?limit=${EDGE_LIMIT}`);

  const refresh = useCallback(() => {
    void resourcesRead.mutate();
    void targetsRead.mutate();
    void edgesRead.mutate();
  }, [resourcesRead, targetsRead, edgesRead]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!resourcesRead.isValidating && !targetsRead.isValidating) refresh();
    }, 30000);
    return () => window.clearInterval(timer);
  }, [refresh, resourcesRead.isValidating, targetsRead.isValidating]);

  const sourcesComplete = !resourcesRead.error && !targetsRead.error;
  const hasMore = Boolean(resourcesRead.data?.page?.hasMore);

  const { items, tree } = useMemo(() => {
    const joined = buildOperationalResources(resourcesRead.data?.resources, targetsRead.data?.targets);
    const enriched = applyResolvedNFTypes(joined.items, targetsRead.data?.targets);
    return {
      items: enriched,
      tree: buildResourceTree(enriched, edgesRead.data?.edges),
    };
  }, [resourcesRead.data, targetsRead.data, edgesRead.data]);

  const filtered = useMemo(() => {
    return items.filter((item) => {
      if (selectedResourceIds && !selectedResourceIds.includes(item.resourceId)) return false;
      if (kind && item.kind !== kind) return false;
      if (domain && item.domain !== domain) return false;
      if (search.trim()) {
        const needle = search.trim().toLowerCase();
        const haystack = `${item.name} ${item.resourceId} ${item.role} ${item.nfType} ${item.kind}`.toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      if (monitoring) {
        const state = item.monitoring?.overallState ?? 'not_monitored';
        const freshness = item.monitoring?.freshnessState ?? 'not_monitored';
        if (monitoring === 'monitored' && !item.monitoring) return false;
        if (monitoring === 'unmonitored' && item.monitoring) return false;
        if (monitoring === 'degraded' && state !== 'degraded' && state !== 'unhealthy') return false;
        if (monitoring === 'stale' && freshness !== 'stale') return false;
        if (monitoring === 'unknown' && !['unknown', 'stale', ''].includes(state)) return false;
      }
      return true;
    });
  }, [items, selectedResourceIds, kind, domain, search, monitoring]);

  const kinds = useMemo(() => Array.from(new Set(items.map((item) => item.kind).filter(Boolean))).sort(), [items]);
  const loading = resourcesRead.isLoading && items.length === 0;
  const failed = Boolean(resourcesRead.error);

  const selectNode = (node: TreeNode) => {
    setSelectedNodeId(node.id);
    setSelectedResourceIds(treeResourceIds(node));
  };
  const clearTreeSelection = () => {
    setSelectedNodeId('');
    setSelectedResourceIds(null);
  };

  const nextPage = () => {
    const next = resourcesRead.data?.page?.nextCursor ?? null;
    if (!next) return;
    setCursorHistory((history) => [...history, cursor ?? '']);
    setCursor(next);
  };
  const previousPage = () => {
    setCursorHistory((history) => {
      if (history.length === 0) return history;
      const copy = [...history];
      const previous = copy.pop() ?? '';
      setCursor(previous || undefined);
      return copy;
    });
  };

  return (
    <div className={styles.neView}>
      <div className={styles.neToolbar}>
        <label className={styles.neSearch}>
          <span className="sr-only">{t('ops_search_label')}</span>
          <Search size={15} aria-hidden="true" />
          <input
            type="search"
            value={search}
            placeholder={t('ops_search_placeholder')}
            onChange={(event) => {
              setCursor(undefined);
              setSearch(event.target.value);
            }}
          />
          {search ? (
            <button type="button" aria-label={t('ops_clear_search')} onClick={() => setSearch('')}>
              <X size={14} />
            </button>
          ) : null}
        </label>

        <label className={styles.neFilter}>
          <span>{t('ops_filter_domain')}</span>
          <select value={domain} onChange={(event) => { setCursor(undefined); setDomain(event.target.value); }}>
            <option value="">{t('ops_filter_all')}</option>
            {OPERATIONAL_DOMAINS.map((value) => (
              <option key={value} value={value}>{t(`ops_domain_${value}`)}</option>
            ))}
          </select>
        </label>

        <label className={styles.neFilter}>
          <span>{t('ops_filter_kind')}</span>
          <select value={kind} onChange={(event) => { setCursor(undefined); setKind(event.target.value); }}>
            <option value="">{t('ops_filter_all')}</option>
            {kinds.map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </label>

        <label className={styles.neFilter}>
          <span>{t('ops_filter_monitoring')}</span>
          <select value={monitoring} onChange={(event) => setMonitoring(event.target.value as MonitoringFilter)}>
            <option value="">{t('ops_filter_all')}</option>
            <option value="monitored">{t('ops_filter_monitored')}</option>
            <option value="unmonitored">{t('ops_filter_unmonitored')}</option>
            <option value="degraded">{t('ops_filter_degraded')}</option>
            <option value="stale">{t('ops_filter_stale')}</option>
            <option value="unknown">{t('ops_filter_unknown')}</option>
          </select>
        </label>

        <button type="button" className={styles.refresh} onClick={refresh} aria-label={t('ops_refresh')}>
          <RefreshCw size={15} /> {t('ops_refresh')}
        </button>
      </div>

      <div className={styles.neBody}>
        <nav className={styles.treePanel} aria-label={t('ops_tree_label')}>
          <p className={styles.treeCaption}>
            {tree.virtual ? t('ops_tree_virtual') : t('ops_tree_declared')}
          </p>
          {tree.nodes.length === 0 ? (
            <p className={styles.treeEmpty}>{t('ops_tree_empty')}</p>
          ) : (
            <ul className={styles.treeList}>
              {tree.nodes.map((node) => (
                <TreeBranch
                  key={node.id}
                  node={node}
                  depth={0}
                  selectedId={selectedNodeId}
                  onSelect={selectNode}
                />
              ))}
            </ul>
          )}
          {selectedNodeId ? (
            <button type="button" className={styles.treeClear} onClick={clearTreeSelection}>
              {t('ops_tree_clear')}
            </button>
          ) : null}
        </nav>

        <div className={styles.neTablePanel}>
          {loading ? (
            <LoadingRows rows={4} />
          ) : failed ? (
            <EmptyState icon={<Server size={40} />} title={t('ops_error_title')} description={t('ops_error_body')} />
          ) : filtered.length === 0 ? (
            <EmptyState icon={<Server size={40} />} title={t('ops_empty_title')} description={t('ops_empty_body')} />
          ) : (
            <div className={styles.tableScroll}>
              <table className={styles.neTable}>
                <caption className={styles.tableCaption}>
                  {t('ops_table_caption')} · {sourcesComplete ? t('ops_complete') : t('ops_partial')}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">{t('ops_col_name')}</th>
                    <th scope="col">{t('ops_col_domain')}</th>
                    <th scope="col">{t('ops_col_type')}</th>
                    <th scope="col">{t('ops_col_kind')}</th>
                    <th scope="col">{t('ops_col_lifecycle')}</th>
                    <th scope="col">{t('ops_col_monitoring')}</th>
                    <th scope="col">{t('ops_col_l1')}</th>
                    <th scope="col">{t('ops_col_l2')}</th>
                    <th scope="col">{t('ops_col_l3')}</th>
                    <th scope="col">{t('ops_col_freshness')}</th>
                    <th scope="col">{t('ops_col_last_measurement')}</th>
                    <th scope="col">{t('ops_col_cpu')}</th>
                    <th scope="col">{t('ops_col_memory')}</th>
                    <th scope="col">{t('ops_col_links')}</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((item) => {
                    const monitoringView = item.monitoring;
                    const cpu = cpuView(monitoringView);
                    const memory = memoryView(monitoringView);
                    return (
                      <tr key={item.resourceId}>
                        <th scope="row" className={styles.cellName}>
                          <Link to={`/inventory/${item.resourceId}`}>{item.name}</Link>
                        </th>
                        <td>{item.domain === 'unknown' ? t('ops_state_unknown') : t(`ops_domain_${item.domain}`)}</td>
                        <td>{item.typeLabel}</td>
                        <td><code className={styles.chip}>{item.kind || '-'}</code></td>
                        <td>{item.lifecycleState || '-'}</td>
                        <td>
                          <span className={`${styles.stateBadge} ${stateTone(monitoringView?.overallState ?? 'not_monitored')}`}>
                            {stateLabel(monitoringView?.overallState ?? 'not_monitored', t)}
                          </span>
                        </td>
                        <td>{monitoringView ? (monitoringView.coverage.l1Measured ? t('ops_layer_measured') : t('ops_layer_not_configured')) : t('ops_metric_unavailable')}</td>
                        <td>{monitoringView ? (monitoringView.coverage.l2Measured ? t('ops_layer_measured') : t('ops_layer_not_configured')) : t('ops_metric_unavailable')}</td>
                        <td>{monitoringView ? (monitoringView.coverage.l3Measured ? t('ops_layer_measured') : t('ops_layer_not_configured')) : t('ops_metric_unavailable')}</td>
                        <td>{monitoringView ? stateLabel(monitoringView.freshnessState, t) : t('ops_state_not_monitored')}</td>
                        <td>{monitoringView?.latestSampleAt || '-'}</td>
                        <td>
                          {cpu
                            ? `${cpu.value} ${cpu.unit}${cpu.fresh ? '' : ` (${t('ops_historical')})`}`
                            : t('ops_metric_unavailable')}
                        </td>
                        <td>{memory ? `${formatBytes(memory.value)}${memory.fresh ? '' : ` (${t('ops_historical')})`}` : t('ops_metric_unavailable')}</td>
                        <td className={styles.cellLinks}>
                          {monitoringView ? <Link to={`/nf-health/${monitoringView.targetId}`}>{t('ops_open_monitoring')}</Link> : '-'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className={styles.pager}>
            <button type="button" onClick={previousPage} disabled={cursorHistory.length === 0}>
              {t('ops_prev_page')}
            </button>
            <span className={styles.pagerInfo}>
              {hasMore ? t('ops_page_partial') : t('ops_page_complete')}
            </span>
            <button type="button" onClick={nextPage} disabled={!hasMore}>
              {t('ops_next_page')}
            </button>
          </div>

          <p className={styles.footnote}>
            {t('ops_ne_footnote')}
          </p>
        </div>
      </div>
    </div>
  );
}
