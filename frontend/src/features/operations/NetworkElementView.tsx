/*
 * Network element view (default `/inventory` view).
 *
 * Master-detail layout: the declared containment hierarchy on the left, one
 * compact network-element table on the right, and the detail drawer on demand.
 * The card wall is a mutually exclusive presentation (`view=cards`), never a
 * second copy of the same rows below the table.
 *
 * Data authorities:
 *   - `GET /api/operations/resources` resolves Inventory identity and the
 *     authoritative monitoring association for exactly the loaded page. The
 *     browser never joins an unrelated target page.
 *   - `GET /api/operations/summary?sections=inventory,health` supplies the KPI
 *     strip, so a KPI never counts the current page.
 *   - Topology still owns `contains`; a capped read is reported as partial and
 *     never claims that containment does not exist.
 *   - Runtime observations supply unmanaged processes, which are rendered in a
 *     separate virtual group and never enter a health or fault denominator.
 *
 * Integrity rules: unresolved is never unmonitored; a missing measurement is
 * rendered as "-", never as zero; CPU time is a cumulative counter and is never
 * turned into a percentage.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, Search, Server, X } from 'lucide-react';
import { useRead } from '../../lib/api/use-read';
import { useI18n } from '../../providers/I18nProvider';
import { EmptyState, LoadingRows } from '../../components/ui/OperationFeedback';
import {
  buildResourceTree,
  cpuView,
  formatBytes,
  memoryView,
  OPERATIONAL_DOMAINS,
  operationalStateToken,
  treeResourceIds,
  type CompletenessReport,
  type DimensionCompleteness,
  type DomainKey,
  type TreeNode,
  type TreeMode,
} from './operational-model';
import { useBoundedEdges } from './use-bounded-edges';
import { useRegisterOperationsRefresh } from './operations-refresh';
import { useOperationsUrlState } from './use-operations-url-state';
import { INVENTORY_URL_KEYS } from './inventory-url-keys';
import {
  adaptCompleteness,
  adaptOperationsResources,
  operationsResourcesPath,
  OPERATIONS_RESOURCE_LIMIT,
  type OperationsResourcesResponse,
} from './operations-resources';
import type { OperationsSummaryResponse } from './operations-summary';
import { NetworkElementCards } from './NetworkElementCards';
import { ResourceDetailDrawer } from './ResourceDetailDrawer';
import type { RuntimeComponent, RuntimeObservations } from '../runtime/runtime-types';
import { resolveRuntimeObservations, useRuntimeStream } from '../runtime/use-runtime-stream';
import styles from '../../styles/modules/operations.module.css';

const UNMANAGED_GROUP_ID = 'virtual:unmanaged';

/* Inventory kinds offered in the kind filter. The list is a presentation
 * vocabulary only: the server validates the value against its own authority. */
const KIND_OPTIONS = [
  'network_function',
  'network_function_instance',
  'network_element',
  'host',
  'virtual_machine',
  'container',
  'pod',
  'interface',
  'ip_address',
  'service',
];

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

function findNode(nodes: TreeNode[], id: string): TreeNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const child = findNode(node.children, id);
    if (child) return child;
  }
  return null;
}

/** Unmanaged processes: verified, running, and with no Inventory resource. */
export function unmanagedComponents(components: RuntimeComponent[]): RuntimeComponent[] {
  return components.filter(
    (component) => component.verified
      && component.runtimeStatus === 'running'
      && component.inventoryAssociation.state === 'absent',
  );
}

function TreeBranch({
  node,
  depth,
  selectedId,
  completeness,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  selectedId: string;
  completeness: DimensionCompleteness;
  onSelect: (node: TreeNode) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(depth < 2);
  const hasChildren = node.children.length > 0;
  const selected = selectedId === node.id;
  // "N loaded · partial": a bounded page count is never presented as a total.
  const loaded = node.children.length > 0
    ? node.children.reduce((sum, child) => sum + Math.max(treeResourceIds(child).length, 1), 0)
    : Math.max(treeResourceIds(node).length, 1);

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
          <span className={styles.treeCount}>
            {t('ops_tree_loaded', { count: loaded })} · {completenessLabel(completeness, t)}
          </span>
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
              completeness={completeness}
              onSelect={onSelect}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function KpiCard({
  label,
  value,
  unavailableLabel,
  scopeLabel,
}: {
  label: string;
  value: number | null;
  unavailableLabel: string;
  scopeLabel: string;
}) {
  return (
    <article className={styles.kpiCard}>
      <span className={styles.kpiLabel}>{label}</span>
      <strong className={styles.kpiValue}>{value ?? '-'}</strong>
      <span className={styles.kpiMeta}>
        {value === null
          ? <span className={styles.kpiUnavailable}>{unavailableLabel}</span>
          : <span className={styles.kpiScope}>{scopeLabel}</span>}
      </span>
    </article>
  );
}

export default function NetworkElementView({ presentation = 'table' }: { presentation?: 'table' | 'cards' }) {
  const { t } = useI18n();

  const url = useOperationsUrlState({ keys: INVENTORY_URL_KEYS });
  const searchQuery = url.filters.q ?? '';
  const domain = url.filters.domain ?? '';
  const kind = url.filters.kind ?? '';
  const monitoring = (url.filters.monitoring ?? '') as MonitoringFilter;
  const selectedNodeId = url.filters.node ?? '';

  const [searchInput, setSearchInput] = useState(searchQuery);
  const [drawerResourceId, setDrawerResourceId] = useState<string | null>(null);
  const [cursorTrail, setCursorTrail] = useState<string[]>([]);
  const queryKeyRef = useRef<string | null>(null);

  useEffect(() => {
    setSearchInput(searchQuery);
  }, [searchQuery]);

  const query = useMemo(
    () => operationsResourcesPath({
      q: searchQuery || undefined,
      domain: domain || undefined,
      kind: kind || undefined,
      monitoring: monitoring || undefined,
      cursor: url.cursor,
      limit: OPERATIONS_RESOURCE_LIMIT,
    }),
    [searchQuery, domain, kind, monitoring, url.cursor],
  );

  const resourcesRead = useRead<OperationsResourcesResponse>(query);
  const summaryRead = useRead<OperationsSummaryResponse>('/api/operations/summary?sections=inventory,health');
  const containment = useBoundedEdges({ relationshipType: 'contains' });
  const runtimeRead = useRead<RuntimeObservations>('/api/runtime/observations');
  const runtimeStream = useRuntimeStream();
  const runtimeData = resolveRuntimeObservations(runtimeStream, runtimeRead.data);

  const refresh = useCallback(() => {
    void resourcesRead.mutate();
    void summaryRead.mutate();
    void runtimeRead.mutate();
    containment.refresh();
  }, [resourcesRead, summaryRead, runtimeRead, containment]);

  // UX-1: the page frame owns the only visible refresh entry.
  useRegisterOperationsRefresh('inventory:network', refresh);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!resourcesRead.isValidating) refresh();
    }, 30000);
    return () => window.clearInterval(timer);
  }, [refresh, resourcesRead.isValidating]);

  const items = useMemo(() => adaptOperationsResources(resourcesRead.data), [resourcesRead.data]);

  const serverCompleteness = resourcesRead.data?.completeness;
  const completeness: CompletenessReport = useMemo(
    () => adaptCompleteness(serverCompleteness, containment.coverage, Boolean(resourcesRead.error)),
    [serverCompleteness, containment.coverage, resourcesRead.error],
  );

  const tree = useMemo(
    () => buildResourceTree(items, containment.edges, containment.coverage),
    [items, containment.edges, containment.coverage],
  );

  const unmanaged = useMemo(
    () => unmanagedComponents(runtimeData?.snapshot?.components ?? []),
    [runtimeData],
  );

  const treeNodes = useMemo(() => {
    if (unmanaged.length === 0) return tree.nodes;
    const group: TreeNode = {
      id: UNMANAGED_GROUP_ID,
      label: t('ops_unmanaged_title'),
      kind: 'unmanaged_group',
      domain: 'unknown' as DomainKey,
      resourceId: null,
      virtual: true,
      children: unmanaged.map((component) => ({
        id: `unmanaged:${component.componentId}`,
        label: component.displayName,
        kind: 'process',
        domain: 'unknown' as DomainKey,
        resourceId: null,
        virtual: true,
        children: [],
      })),
    };
    return [...tree.nodes, group];
  }, [tree.nodes, unmanaged, t]);

  const selectedNode = useMemo(
    () => (selectedNodeId ? findNode(treeNodes, selectedNodeId) : null),
    [treeNodes, selectedNodeId],
  );

  const unmanagedSelection = selectedNodeId.startsWith(UNMANAGED_GROUP_ID) || selectedNodeId.startsWith('unmanaged:');
  const unmanagedComponentId = selectedNodeId.startsWith('unmanaged:')
    ? selectedNodeId.slice('unmanaged:'.length)
    : null;

  const selectedResourceIds = useMemo(
    () => (selectedNode && !unmanagedSelection ? treeResourceIds(selectedNode) : null),
    [selectedNode, unmanagedSelection],
  );

  const visibleItems = useMemo(() => {
    if (!selectedResourceIds) return items;
    const allowed = new Set(selectedResourceIds);
    return items.filter((item) => allowed.has(item.resourceId));
  }, [items, selectedResourceIds]);

  const visibleUnmanaged = useMemo(() => {
    if (!unmanagedComponentId) return unmanaged;
    return unmanaged.filter((component) => component.componentId === unmanagedComponentId);
  }, [unmanaged, unmanagedComponentId]);

  const drawerResource = useMemo(
    () => items.find((item) => item.resourceId === drawerResourceId) ?? null,
    [items, drawerResourceId],
  );

  /* A filter change invalidates the tree selection that belonged to the previous
   * query, so a node from another result set can never keep filtering the table. */
  const setFilterNode = url.setFilter;
  useEffect(() => {
    const queryKey = `${searchQuery}|${domain}|${kind}|${monitoring}`;
    if (queryKeyRef.current === null) {
      queryKeyRef.current = queryKey;
      return;
    }
    if (queryKeyRef.current === queryKey) return;
    queryKeyRef.current = queryKey;
    if (selectedNodeId) setFilterNode('node', '');
    setCursorTrail([]);
  }, [searchQuery, domain, kind, monitoring, selectedNodeId, setFilterNode]);

  const selectNode = (node: TreeNode) => {
    url.setFilter('node', node.id === selectedNodeId ? '' : node.id);
  };

  const setNetworkFilter = (key: 'q' | 'domain' | 'kind' | 'monitoring', value: string) => {
    // Keep the filter, tree selection and cursor transition atomic. A previous
    // tree node is scoped to the old filter set and must not survive in history.
    url.setFilters({ [key]: value, node: null });
  };

  const submitSearch = (event: React.FormEvent) => {
    event.preventDefault();
    setNetworkFilter('q', searchInput.trim());
  };

  /* Cursor trail for the pager. The active cursor lives in the URL; this trail
   * only supplies the previous-page step for the current session. */
  const goFirstPage = () => {
    setCursorTrail([]);
    url.setCursor(undefined);
  };
  const goPreviousPage = () => {
    if (cursorTrail.length === 0) return;
    const trail = [...cursorTrail];
    const previous = trail.pop() ?? '';
    setCursorTrail(trail);
    url.setCursor(previous || undefined);
  };
  const goNextPage = () => {
    if (!nextCursor) return;
    setCursorTrail((trail) => [...trail, url.cursor ?? '']);
    url.setCursor(nextCursor);
  };

  const clearFilters = () => {
    setSearchInput('');
    url.clearFilters();
  };

  const loading = resourcesRead.isLoading && items.length === 0;
  const failed = Boolean(resourcesRead.error);
  const hasMore = Boolean(resourcesRead.data?.page?.hasMore);
  const nextCursor = resourcesRead.data?.page?.nextCursor ?? null;
  const filterScopePage = resourcesRead.data?.page?.filterScope === 'page';
  const activeFilterCount = [searchQuery, domain, kind, monitoring].filter(Boolean).length;

  /* KPIs come from the full-collection summary, never from the loaded page. */
  const inventorySection = summaryRead.data?.inventory;
  const healthSection = summaryRead.data?.health;
  const inventoryCounts = inventorySection?.completeness === 'complete' ? inventorySection.counts : undefined;
  const totalResources = inventoryCounts ? inventoryCounts.total : null;
  const networkFunctions = inventoryCounts
    ? (inventoryCounts.byKind?.network_function ?? 0) + (inventoryCounts.byKind?.network_function_instance ?? 0)
    : null;
  const configuredTargets = healthSection?.completeness === 'complete' ? (healthSection.targets?.configured ?? null) : null;
  const failedTargets = healthSection?.completeness === 'complete' ? (healthSection.targets?.failed ?? null) : null;
  const scopeLabel = t('ops_kpi_scope_full_collection');

  return (
    <div className={styles.neView}>
      <div className={styles.kpiStrip} aria-label={t('ops_overview_title')}>
        <KpiCard label={t('ops_kpi_resources')} value={totalResources} unavailableLabel={t('ops_kpi_unavailable')} scopeLabel={scopeLabel} />
        <KpiCard label={t('ops_kpi_network_functions')} value={networkFunctions} unavailableLabel={t('ops_kpi_unavailable')} scopeLabel={scopeLabel} />
        <KpiCard label={t('ops_kpi_monitored')} value={configuredTargets} unavailableLabel={t('ops_kpi_unavailable')} scopeLabel={scopeLabel} />
        <KpiCard label={t('ops_kpi_failed')} value={failedTargets} unavailableLabel={t('ops_kpi_unavailable')} scopeLabel={scopeLabel} />
      </div>

      <div className={styles.neToolbar}>
        <form className={styles.neSearch} onSubmit={submitSearch} role="search">
          <span className="sr-only">{t('ops_search_label')}</span>
          <Search size={15} aria-hidden="true" />
          <input
            type="search"
            value={searchInput}
            placeholder={t('ops_search_placeholder')}
            aria-label={t('ops_search_label')}
            onChange={(event) => setSearchInput(event.target.value)}
          />
          {searchInput ? (
            <button type="button" aria-label={t('ops_clear_search')} onClick={() => { setSearchInput(''); setNetworkFilter('q', ''); }}>
              <X size={14} />
            </button>
          ) : null}
        </form>

        <label className={styles.neFilter}>
          <span>{t('ops_filter_domain')}</span>
          <select value={domain} onChange={(event) => setNetworkFilter('domain', event.target.value)}>
            <option value="">{t('ops_filter_all')}</option>
            {OPERATIONAL_DOMAINS.map((value) => (
              <option key={value} value={value}>{t(`ops_domain_${value}`)}</option>
            ))}
          </select>
        </label>

        <label className={styles.neFilter}>
          <span>{t('ops_filter_kind')}</span>
          <select value={kind} onChange={(event) => setNetworkFilter('kind', event.target.value)}>
            <option value="">{t('ops_filter_all')}</option>
            {KIND_OPTIONS.map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </label>

        <label className={styles.neFilter}>
          <span>{t('ops_filter_monitoring')}</span>
          <select value={monitoring} onChange={(event) => setNetworkFilter('monitoring', event.target.value)}>
            <option value="">{t('ops_filter_all')}</option>
            <option value="monitored">{t('ops_filter_monitored')}</option>
            <option value="unmonitored">{t('ops_filter_unmonitored')}</option>
            <option value="unresolved">{t('ops_filter_unresolved')}</option>
            <option value="degraded">{t('ops_filter_degraded')}</option>
            <option value="stale">{t('ops_filter_stale')}</option>
            <option value="unknown">{t('ops_filter_unknown')}</option>
          </select>
        </label>

        {activeFilterCount > 0 ? (
          <button type="button" className="btn btn-ghost" onClick={clearFilters}>
            <X size={14} aria-hidden="true" />
            {t('ops_filter_all')}
          </button>
        ) : null}

        {filterScopePage ? (
          <span className={styles.filterScope} title={t('ops_page_partial')}>
            {t('ops_filter_scope_page')}
          </span>
        ) : null}
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
          {treeNodes.length === 0 ? (
            <p className={styles.treeEmpty}>{t('ops_tree_empty')}</p>
          ) : (
            <ul className={styles.treeList}>
              {treeNodes.map((node) => (
                <TreeBranch
                  key={node.id}
                  node={node}
                  depth={0}
                  selectedId={selectedNodeId}
                  completeness={completeness.overall}
                  onSelect={selectNode}
                />
              ))}
            </ul>
          )}
          {selectedNodeId ? (
            <button type="button" className={styles.treeClear} onClick={() => url.setFilter('node', '')}>
              {t('ops_tree_clear')}
            </button>
          ) : null}
        </nav>

        <div className={styles.neTablePanel}>
          {loading ? (
            <LoadingRows rows={6} />
          ) : failed ? (
            <EmptyState icon={<Server size={40} />} title={t('ops_error_title')} description={t('ops_error_body')} />
          ) : presentation === 'cards' ? (
            visibleItems.length === 0 && !unmanagedSelection ? (
              <EmptyState icon={<Server size={40} />} title={t('ops_empty_title')} description={t('ops_empty_body')} />
            ) : (
              <NetworkElementCards items={visibleItems} />
            )
          ) : visibleItems.length === 0 && !unmanagedSelection ? (
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
                    <th scope="col">{t('ops_col_status')}</th>
                    <th scope="col">{t('ops_layer_l1')}</th>
                    <th scope="col">{t('ops_layer_l2')}</th>
                    <th scope="col">{t('ops_layer_l3')}</th>
                    <th scope="col">{t('ops_col_cpu')}</th>
                    <th scope="col">{t('ops_col_memory')}</th>
                    <th scope="col">{t('ops_col_links')}</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleItems.map((item) => {
                    const state = operationalStateToken(item);
                    const coverage = item.monitoring?.coverage ?? null;
                    const cpu = cpuView(item.monitoring);
                    const memory = memoryView(item.monitoring);
                    return (
                      <tr key={item.resourceId}>
                        <th scope="row" className={styles.cellName}>
                          <button
                            type="button"
                            className={styles.rowButton}
                            onClick={() => setDrawerResourceId(item.resourceId)}
                          >
                            <span className={styles.rowName}>{item.name}</span>
                            <span className={styles.rowMeta}>
                              {item.typeLabel}
                              {item.lifecycleState ? <span className={styles.chip}>{item.lifecycleState}</span> : null}
                            </span>
                          </button>
                        </th>
                        <td>
                          <span className={`${styles.stateBadge} ${stateTone(state)}`}>{stateLabel(state, t)}</span>
                        </td>
                        <td>{layerMark(coverage?.l1Measured, t)}</td>
                        <td>{layerMark(coverage?.l2Measured, t)}</td>
                        <td>{layerMark(coverage?.l3Measured, t)}</td>
                        <td title={t('ops_ne_footnote')}>
                          {cpu ? `${cpu.value} ${cpu.unit}${cpu.fresh ? '' : ` (${t('ops_historical')})`}` : '-'}
                        </td>
                        <td>
                          {memory ? `${formatBytes(memory.value)}${memory.fresh ? '' : ` (${t('ops_historical')})`}` : '-'}
                        </td>
                        <td className={styles.cellLinks}>
                          {item.monitoring ? (
                            <Link className={styles.rowLink} to={`/nf-health/${encodeURIComponent(item.monitoring.targetId)}`}>
                              {t('ops_open_monitoring')}
                            </Link>
                          ) : item.association === 'unresolved' ? (
                            <span className={styles.chipMuted} title={t('ops_filter_unresolved')}>
                              {t('ops_association_unresolved')}
                            </span>
                          ) : (
                            <span className={styles.chipMuted}>{t('ops_association_absent')}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {unmanagedSelection
                    ? visibleUnmanaged.map((component) => (
                      <tr key={component.componentId} className={styles.unmanagedRow}>
                        <th scope="row" className={styles.cellName}>
                          <span className={styles.rowName}>{component.displayName}</span>
                          <span className={styles.rowMeta}>
                            <code className={styles.chip}>{component.processName}</code>
                          </span>
                        </th>
                        <td>
                          <span className={`${styles.stateBadge} ${styles.toneMuted}`}>{t('ops_unmanaged_state')}</span>
                        </td>
                        <td>-</td>
                        <td>-</td>
                        <td>-</td>
                        <td title={t('ops_unmanaged_note')}>-</td>
                        <td>{component.memoryRssBytes != null ? formatBytes(component.memoryRssBytes) : '-'}</td>
                        <td className={styles.cellLinks}>
                          <Link className={styles.rowLink} to="/inventory?view=runtime">{t('ops_unmanaged_open')}</Link>
                        </td>
                      </tr>
                    ))
                    : null}
                </tbody>
              </table>
            </div>
          )}

          <p className={styles.footnote}>{t('ops_table_note')}</p>

          {presentation === 'table' ? (
            <div className={styles.pager}>
              <button type="button" onClick={goFirstPage} disabled={!url.cursor}>
                {t('ops_pager_first')}
              </button>
              <button type="button" onClick={goPreviousPage} disabled={cursorTrail.length === 0}>
                {t('ops_prev_page')}
              </button>
              <span className={styles.pagerInfo}>
                {hasMore ? t('ops_page_partial') : t('ops_page_complete')}
              </span>
              <button
                type="button"
                onClick={goNextPage}
                disabled={!hasMore || !nextCursor}
              >
                {t('ops_next_page')}
              </button>
            </div>
          ) : null}
        </div>
      </div>

      <ResourceDetailDrawer resource={drawerResource} onClose={() => setDrawerResourceId(null)} />
    </div>
  );
}

function layerMark(measured: boolean | undefined, t: (key: string) => string): React.ReactElement {
  return measured ? (
    <span className={styles.layerOn} title={t('ops_layer_measured')}>✓</span>
  ) : (
    <span className={styles.layerOff} title={t('ops_layer_not_configured')}>–</span>
  );
}
