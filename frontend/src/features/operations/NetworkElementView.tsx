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
 * Integrity rules enforced here:
 *   - monitoring associations are resolved by an authoritative bounded batch
 *     lookup for exactly the loaded resource identifiers;
 *   - an unresolved association is reported as unresolved, never unmonitored;
 *   - completeness is tracked separately for Inventory, monitoring, telemetry
 *     and Topology;
 *   - Topology edges are read with bounded cursor pagination, and a missing edge
 *     on an incomplete page never claims that containment does not exist;
 *   - server-side filter changes reset the cursor, the cursor history and any
 *     tree selection that belonged to the previous query;
 *   - every unavailable value is rendered as an unavailable state.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, RefreshCw, Search, Server, X } from 'lucide-react';
import { getJsonWithSignal } from '../../lib/api/read-client';
import { useRead } from '../../lib/api/use-read';
import { useI18n } from '../../providers/I18nProvider';
import { EmptyState, LoadingRows } from '../../components/ui/OperationFeedback';
import {
  applyResolvedNFTypes,
  buildOperationalResources,
  buildResourceTree,
  combineCompleteness,
  cpuView,
  formatBytes,
  memoryView,
  OPERATIONAL_DOMAINS,
  treeResourceIds,
  type CompletenessReport,
  type DimensionCompleteness,
  type TopologyCoverage,
  type TreeNode,
  type TreeMode,
} from './operational-model';
import styles from '../../styles/modules/operations.module.css';

const PAGE_LIMIT = 20;
const TOPOLOGY_PAGE_LIMIT = 200;
const TOPOLOGY_MAX_PAGES = 3;

type ResourceListPayload = { resources?: unknown[]; page?: { nextCursor?: string | null; hasMore?: boolean } };
type TargetListPayload = { targets?: unknown[]; page?: { hasMore?: boolean } };
type EdgeListPayload = { edges?: unknown[]; page?: { nextCursor?: string | null; hasMore?: boolean } };

type MonitoringFilter = '' | 'monitored' | 'unmonitored' | 'unresolved' | 'degraded' | 'unknown' | 'stale';

function stateLabel(state: string, t: (key: string) => string): string {
  const known = [
    'healthy', 'degraded', 'unhealthy', 'unknown', 'stale',
    'not_configured', 'not_monitored', 'fresh', 'unresolved',
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

function completenessLabel(value: DimensionCompleteness, t: (key: string) => string): string {
  return t(`ops_completeness_${value}`);
}

function treeModeLabel(mode: TreeMode, t: (key: string) => string): string {
  return t(`ops_tree_mode_${mode}`);
}

/**
 * Reads the declared `contains` relationships with bounded cursor pagination.
 *
 * A partial read keeps the edges it loaded, marks the coverage partial and never
 * claims that containment does not exist. A failed read marks the coverage
 * unavailable rather than presenting an empty authoritative graph.
 */
function useDeclaredContainmentEdges(enabled: boolean): {
  edges: unknown[];
  coverage: TopologyCoverage;
  refresh: () => void;
} {
  const [edges, setEdges] = useState<unknown[]>([]);
  const [coverage, setCoverage] = useState<TopologyCoverage>('partial');
  const [nonce, setNonce] = useState(0);
  const runIdRef = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    const runId = runIdRef.current + 1;
    runIdRef.current = runId;
    const controller = new AbortController();
    let cancelled = false;

    const load = async () => {
      const collected: unknown[] = [];
      let cursor: string | null = null;
      let pages = 0;
      let hasMore = false;
      try {
        do {
          const params = new URLSearchParams();
          params.set('relationshipType', 'contains');
          params.set('limit', String(TOPOLOGY_PAGE_LIMIT));
          if (cursor) params.set('cursor', cursor);
          const payload = await getJsonWithSignal<EdgeListPayload>(
            `/api/topology/edges?${params.toString()}`,
            controller.signal,
          );
          if (cancelled || runIdRef.current !== runId) return;
          collected.push(...(payload.edges ?? []));
          hasMore = Boolean(payload.page?.hasMore);
          cursor = payload.page?.nextCursor ?? null;
          pages += 1;
        } while (hasMore && cursor && pages < TOPOLOGY_MAX_PAGES);
        if (cancelled || runIdRef.current !== runId) return;
        setEdges(collected);
        setCoverage(hasMore ? 'partial' : 'complete');
      } catch {
        if (cancelled || runIdRef.current !== runId) return;
        // Keep whatever was loaded; the graph is not authoritative.
        setEdges(collected);
        setCoverage(collected.length > 0 ? 'partial' : 'unavailable');
      }
    };

    void load();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [enabled, nonce]);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);
  return { edges, coverage, refresh };
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

  // Authoritative bounded association lookup for exactly the loaded resources.
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

  const containment = useDeclaredContainmentEdges(true);

  const refresh = useCallback(() => {
    void resourcesRead.mutate();
    if (associationPath) void associationsRead.mutate();
    containment.refresh();
  }, [resourcesRead, associationsRead, associationPath, containment]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!resourcesRead.isValidating && !associationsRead.isValidating) refresh();
    }, 30000);
    return () => window.clearInterval(timer);
  }, [refresh, resourcesRead.isValidating, associationsRead.isValidating]);

  const completeness: CompletenessReport = useMemo(() => {
    const inventory: DimensionCompleteness = resourcesRead.error
      ? 'unavailable'
      : resourcesRead.data
        ? (resourcesRead.data.page?.hasMore ? 'partial' : 'complete')
        : 'partial';
    const monitoringDim: DimensionCompleteness = !resourceIds.length
      ? (resourcesRead.error ? 'unavailable' : 'partial')
      : associationsRead.error
        ? 'unavailable'
        : associationsRead.data
          ? 'complete'
          : 'partial';
    const targets = associationsRead.data?.targets ?? [];
    const telemetryFailed = targets.some((target) => {
      const record = (target ?? {}) as Record<string, unknown>;
      return record.statusComplete === false;
    });
    const telemetry: DimensionCompleteness = monitoringDim !== 'complete'
      ? monitoringDim
      : telemetryFailed
        ? 'partial'
        : 'complete';
    return combineCompleteness({
      inventory,
      monitoring: monitoringDim,
      telemetry,
      topology: containment.coverage,
    });
  }, [
    resourcesRead.data, resourcesRead.error,
    associationsRead.data, associationsRead.error,
    resourceIds.length, containment.coverage,
  ]);

  const { items, tree } = useMemo(() => {
    const associationResolved = !associationsRead.error && Boolean(associationsRead.data);
    const joined = buildOperationalResources(
      resourcesRead.data?.resources,
      associationsRead.data?.targets,
      associationResolved,
    );
    const enriched = applyResolvedNFTypes(joined.items, associationsRead.data?.targets);
    return {
      items: enriched,
      tree: buildResourceTree(enriched, containment.edges, containment.coverage),
    };
  }, [resourcesRead.data, associationsRead.data, associationsRead.error, containment.edges, containment.coverage]);

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
        if (monitoring === 'monitored' && item.association !== 'confirmed') return false;
        if (monitoring === 'unmonitored' && item.association !== 'absent') return false;
        if (monitoring === 'unresolved' && item.association !== 'unresolved') return false;
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
  const hasMore = Boolean(resourcesRead.data?.page?.hasMore);

  /** Server-side filter changes must reset the cursor and the tree selection. */
  const resetQueryState = useCallback(() => {
    setCursor(undefined);
    setCursorHistory([]);
    setSelectedNodeId('');
    setSelectedResourceIds(null);
  }, []);

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
              resetQueryState();
              setSearch(event.target.value);
            }}
          />
          {search ? (
            <button
              type="button"
              aria-label={t('ops_clear_search')}
              onClick={() => {
                resetQueryState();
                setSearch('');
              }}
            >
              <X size={14} />
            </button>
          ) : null}
        </label>

        <label className={styles.neFilter}>
          <span>{t('ops_filter_domain')}</span>
          <select
            value={domain}
            onChange={(event) => {
              resetQueryState();
              setDomain(event.target.value);
            }}
          >
            <option value="">{t('ops_filter_all')}</option>
            {OPERATIONAL_DOMAINS.map((value) => (
              <option key={value} value={value}>{t(`ops_domain_${value}`)}</option>
            ))}
          </select>
        </label>

        <label className={styles.neFilter}>
          <span>{t('ops_filter_kind')}</span>
          <select
            value={kind}
            onChange={(event) => {
              resetQueryState();
              setKind(event.target.value);
            }}
          >
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
            <option value="unresolved">{t('ops_filter_unresolved')}</option>
            <option value="degraded">{t('ops_filter_degraded')}</option>
            <option value="stale">{t('ops_filter_stale')}</option>
            <option value="unknown">{t('ops_filter_unknown')}</option>
          </select>
        </label>

        <button type="button" className={styles.refresh} onClick={refresh} aria-label={t('ops_refresh')}>
          <RefreshCw size={15} /> {t('ops_refresh')}
        </button>
      </div>

      <div className={styles.completenessStrip} role="list">
        {(['inventory', 'monitoring', 'telemetry', 'topology'] as const).map((dimension) => (
          <span key={dimension} className={styles.completenessItem} role="listitem">
            {t(`ops_dimension_${dimension}`)}: {completenessLabel(completeness[dimension], t)}
          </span>
        ))}
      </div>

      <div className={styles.neBody}>
        <nav className={styles.treePanel} aria-label={t('ops_tree_label')}>
          <p className={styles.treeCaption}>{treeModeLabel(tree.mode, t)}</p>
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
                  {t('ops_table_caption')} · {completenessLabel(completeness.overall, t)}
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
                    const associationState = item.association === 'unresolved'
                      ? 'unresolved'
                      : monitoringView
                        ? monitoringView.overallState
                        : 'not_monitored';
                    return (
                      <tr key={item.resourceId}>
                        <th scope="row" className={styles.cellName}>
                          <Link to={`/inventory/${item.resourceId}`}>{item.name}</Link>
                        </th>
                        <td>{item.domain === 'unknown' ? t('ops_state_unknown') : t(`ops_domain_${item.domain}`)}</td>
                        <td>{item.typeLabel}</td>
                        <td>
                          <code className={styles.chip}>{item.kind || '-'}</code>
                          {!item.isNetworkFunction ? <span className={styles.chipMuted}>{t('ops_kind_non_nf')}</span> : null}
                        </td>
                        <td>{item.lifecycleState || '-'}</td>
                        <td>
                          <span className={`${styles.stateBadge} ${stateTone(associationState)}`}>
                            {stateLabel(associationState, t)}
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

          <p className={styles.footnote}>{t('ops_ne_footnote')}</p>
        </div>
      </div>
    </div>
  );
}
