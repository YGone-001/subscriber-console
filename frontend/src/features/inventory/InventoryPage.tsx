/*
 * Inventory list route.
 *
 * The surface now follows the composition the other operational modules already use:
 * one page frame that carries the title, the view switch and the single refresh
 * entry, followed by one continuous panel that carries the toolbar, the table and
 * the cursor pager, and dedicated state panels instead of states rendered inside a
 * table cell.
 *
 * Behaviour is unchanged. The cursor contract of GET /api/inventory/resources remains
 * the only pagination source, and the four filters still map one-to-one onto the query
 * parameters the endpoint accepts. The previous-page affordance stays: the cursor
 * history the page already recorded is consumable, so an operator can step back
 * without restarting from the first page.
 *
 * UX-1: the three views and the list filters live in the URL (`view`, `q`, `kind`,
 * `domain`, `state`, `cursor`), so reload, back/forward and a shared link restore the
 * same workspace. The network-element and runtime views register their own loaders
 * with the frame instead of drawing a second refresh button.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Boxes, ChevronRight, Plus, Search, X } from 'lucide-react';
import { hasPermission } from '../../lib/permissions';
import { EmptyState, LoadingRows } from '../../components/ui/OperationFeedback';
import { ErrorState } from '../../components/ui/StatePanel';
import { useAuth } from '../../providers/AuthProvider';
import { useI18n } from '../../providers/I18nProvider';
import { fetchInventoryMeta, fetchInventoryResources } from './inventory-api';
import NetworkElementView from './NetworkElementView';
import { ViewSwitch, type ViewSwitchOption } from '../../components/ui/ViewSwitch';
import { OperationsPageFrame } from '../operations/OperationsPageFrame';
import { useOperationsUrlState } from '../operations/use-operations-url-state';
import { RuntimeDiscoveryView } from '../runtime/RuntimeDiscovery';
import { INVENTORY_URL_KEYS } from '../operations/inventory-url-keys';
import type { MetaResponse, Resource } from './inventory-types';
import styles from '../../styles/modules/inventory.module.css';

const PAGE_LIMIT = 20;

/* `cards` is the mutually exclusive card wall; `assets` is the ledger and
 * `list` stays as a compatible alias for links created before UX-2. */
const INVENTORY_VIEWS = ['network', 'cards', 'assets', 'list', 'runtime'] as const;

const INVENTORY_VIEW_LABELS: Record<(typeof INVENTORY_VIEWS)[number], string> = {
  network: 'ops_view_network',
  cards: 'ops_view_cards',
  assets: 'ops_view_assets',
  list: 'ops_view_assets',
  runtime: 'runtime_view_mode',
};

/* The switch never emits the legacy `list` alias: it stays read-compatible for
 * old links, while the visible ledger option always writes `assets`. */
function inventoryViewOptions(t: (key: string) => string): ViewSwitchOption[] {
  return (['network', 'cards', 'assets', 'runtime'] as const).map((value) => ({
    value,
    label: t(INVENTORY_VIEW_LABELS[value]),
    data: { 'data-view-mode': value },
  }));
}

export function InventoryPage() {
  const { t } = useI18n();
  const { user } = useAuth();

  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [resources, setResources] = useState<Resource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /* View and filters are URL state: `view=network|list|runtime` plus the four
   * server-side filters. The network-element view stays the default surface
   * because the operational question is "what do I run", not "what is
   * registered"; the general listing remains the audit surface. */
  const url = useOperationsUrlState({
    keys: INVENTORY_URL_KEYS,
    views: INVENTORY_VIEWS,
    defaultView: 'network',
  });
  const viewMode = url.view as (typeof INVENTORY_VIEWS)[number];
  const assetsView = viewMode === 'assets' || viewMode === 'list';

  const searchQuery = url.filters.q ?? '';
  const selectedKind = url.filters.kind ?? '';
  const selectedDomain = url.filters.domain ?? '';
  const selectedLifecycle = url.filters.state ?? '';

  const [searchInput, setSearchInput] = useState(searchQuery);

  // Pagination cursor history for the previous-page affordance. The cursor that
  // produced the visible page lives in the URL; this trail is session-scoped.
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const queryKeyRef = useRef('');

  const canConfigure = hasPermission(user, 'core.configure');

  useEffect(() => {
    fetchInventoryMeta()
      .then((data) => setMeta(data))
      .catch(() => {
        // Fallback or ignore meta fetch error
      });
  }, []);

  /* Browser back/forward and a pasted link must restore the query box too, not
   * only the request. */
  useEffect(() => {
    setSearchInput(searchQuery);
  }, [searchQuery]);

  const loadResources = async (activeCursor?: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchInventoryResources({
        q: searchQuery || undefined,
        kind: selectedKind || undefined,
        domain: selectedDomain || undefined,
        lifecycleState: selectedLifecycle || undefined,
        cursor: activeCursor,
        limit: PAGE_LIMIT,
      });
      setResources(res.resources || []);
      setNextCursor(res.page?.nextCursor ?? null);
      setHasMore(Boolean(res.page?.hasMore));
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t('inventory_err_load'));
      setResources([]);
    } finally {
      setLoading(false);
    }
  };

  /* One effect for both dimensions: a changed filter set starts a new trail and
   * loads its first page, while a changed cursor only advances the trail. The
   * URL contract already dropped the cursor on any filter change. */
  useEffect(() => {
    if (!assetsView) return;
    const queryKey = `${searchQuery}|${selectedKind}|${selectedDomain}|${selectedLifecycle}`;
    if (queryKeyRef.current !== queryKey) {
      queryKeyRef.current = queryKey;
      setCursorHistory([]);
    }
    void loadResources(url.cursor);
    // Select filters apply immediately; the free-text query applies only after submit.
  }, [assetsView, searchQuery, selectedKind, selectedDomain, selectedLifecycle, url.cursor]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const nextQuery = searchInput.trim();
    if (nextQuery === searchQuery) {
      void loadResources(url.cursor);
      return;
    }
    url.setFilter('q', nextQuery);
  };

  const handleNextPage = () => {
    if (!nextCursor) return;
    setCursorHistory((prev) => [...prev, url.cursor ?? '']);
    url.setCursor(nextCursor);
  };

  const handlePrevPage = () => {
    if (cursorHistory.length === 0) return;
    const history = [...cursorHistory];
    const previous = history.pop() ?? '';
    setCursorHistory(history);
    url.setCursor(previous || undefined);
  };

  const handleFirstPage = () => {
    setCursorHistory([]);
    url.setCursor(undefined);
  };

  /* Active filters are surfaced as removable chips so the operator can see, and undo,
   * one constraint at a time instead of guessing why the list is short. */
  const activeFilters = useMemo(() => {
    const chips: Array<{ key: string; label: string; clear: () => void }> = [];
    if (searchQuery) {
      chips.push({
        key: 'q',
        label: `${t('inventory_search_short')}: ${searchQuery}`,
        clear: () => {
          setSearchInput('');
          url.setFilter('q', '');
        },
      });
    }
    if (selectedKind) {
      chips.push({ key: 'kind', label: `${t('inventory_kind')}: ${selectedKind}`, clear: () => url.setFilter('kind', '') });
    }
    if (selectedDomain) {
      chips.push({ key: 'domain', label: `${t('inventory_domain')}: ${selectedDomain}`, clear: () => url.setFilter('domain', '') });
    }
    if (selectedLifecycle) {
      chips.push({
        key: 'lifecycle',
        label: `${t('inventory_lifecycle')}: ${selectedLifecycle}`,
        clear: () => url.setFilter('state', ''),
      });
    }
    return chips;
  }, [searchQuery, selectedKind, selectedDomain, selectedLifecycle, t, url]);

  const clearAllFilters = () => {
    setSearchInput('');
    url.clearFilters();
    setCursorHistory([]);
  };

  const pageIndex = cursorHistory.length + 1;
  const hasQuery = Boolean(searchQuery) || Boolean(selectedKind) || Boolean(selectedDomain) || Boolean(selectedLifecycle);

  const formatTimestamp = (value?: string) => {
    if (!value) return '-';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
  };

  return (
    <OperationsPageFrame
      title={t('inventory_title')}
      description={t('inventory_description')}
      icon={<Boxes size={23} />}
      viewSwitch={(
        <ViewSwitch
          options={inventoryViewOptions(t)}
          value={assetsView ? 'assets' : viewMode}
          onChange={(value) => url.setView(value)}
          ariaLabel={t('ops_view_mode')}
        />
      )}
      onRefresh={assetsView ? () => loadResources(url.cursor) : undefined}
      actions={
        canConfigure ? (
          <Link to="/inventory/create" className="btn btn-primary">
            <Plus size={16} />
            {t('inventory_create_resource')}
          </Link>
        ) : undefined
      }
    >
      {viewMode === 'runtime' ? (
        <RuntimeDiscoveryView />
      ) : viewMode === 'cards' ? (
        <NetworkElementView presentation="cards" />
      ) : viewMode === 'network' ? (
        <NetworkElementView />
      ) : (
      <section className="dash-card">
        <div className={styles.toolbar}>
          <form className={styles.search} role="search" onSubmit={handleSearchSubmit}>
            <Search size={16} className={styles.searchIcon} aria-hidden="true" />
            <input
              type="search"
              aria-label={t('inventory_search_placeholder')}
              placeholder={t('inventory_search_placeholder')}
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
            <button type="submit" className="btn btn-ghost" disabled={loading}>
              {t('search')}
            </button>
          </form>

          <div className={styles.filterGroup}>
            <select
              className="form-input"
              aria-label={t('inventory_all_kinds')}
              value={selectedKind}
              onChange={(e) => url.setFilter('kind', e.target.value)}
            >
              <option value="">{t('inventory_all_kinds')}</option>
              {meta?.kinds?.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>

            <select
              className="form-input"
              aria-label={t('inventory_all_domains')}
              value={selectedDomain}
              onChange={(e) => url.setFilter('domain', e.target.value)}
            >
              <option value="">{t('inventory_all_domains')}</option>
              {meta?.domains?.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>

            <select
              className="form-input"
              aria-label={t('inventory_all_states')}
              value={selectedLifecycle}
              onChange={(e) => url.setFilter('state', e.target.value)}
            >
              <option value="">{t('inventory_all_states')}</option>
              {meta?.lifecycleStates?.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        </div>

        {activeFilters.length > 0 ? (
          <div className={styles.filterTags}>
            <span className={styles.filterTagsLabel}>{t('inventory_filter_active')}</span>
            {activeFilters.map((chip) => (
              <button key={chip.key} type="button" onClick={chip.clear}>
                {chip.label}
                <X size={12} aria-hidden="true" />
              </button>
            ))}
            <button type="button" className={styles.clearTag} onClick={clearAllFilters}>
              {t('inventory_clear_filters')}
            </button>
          </div>
        ) : null}

        {error ? (
          <div className={styles.errorWrap}>
            <ErrorState
              title={t('error')}
              message={error}
              retryLabel={t('retry')}
              onRetry={() => void loadResources(url.cursor)}
            />
          </div>
        ) : loading && resources.length === 0 ? (
          <LoadingRows columns={8} rows={5} />
        ) : resources.length === 0 ? (
          <div className={styles.stateWrap}>
            <EmptyState
              icon={<Boxes size={44} />}
              title={hasQuery ? t('inventory_empty_search_title') : t('inventory_empty_title')}
              description={hasQuery ? t('inventory_empty_search_body') : t('inventory_empty_body')}
              action={
                canConfigure && !hasQuery ? (
                  <Link to="/inventory/create" className="btn btn-primary">
                    <Plus size={16} />
                    {t('inventory_create_resource')}
                  </Link>
                ) : undefined
              }
            />
          </div>
        ) : (
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <caption className="sr-only">{t('inventory_title')}</caption>
              <colgroup>
                <col className={styles.nameCol} />
                <col className={styles.kindCol} />
                <col className={styles.domainCol} />
                <col className={styles.roleCol} />
                <col className={styles.vendorCol} />
                <col className={styles.lifecycleCol} />
                <col className={styles.updatedCol} />
                <col className={styles.actionsCol} />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">{t('inventory_name')}</th>
                  <th scope="col">{t('inventory_kind')}</th>
                  <th scope="col">{t('inventory_domain')}</th>
                  <th scope="col">{t('inventory_role')}</th>
                  <th scope="col">{t('inventory_vendor')}</th>
                  <th scope="col">{t('inventory_lifecycle')}</th>
                  <th scope="col">{t('inventory_updated_at')}</th>
                  <th scope="col" className={styles.actionsCell}>{t('actions')}</th>
                </tr>
              </thead>
              <tbody>
                {resources.map((item) => (
                  <tr key={item.resourceId}>
                    <td>
                      <div className={styles.identity}>
                        <strong title={item.name}>{item.name}</strong>
                        {item.displayName ? <small title={item.displayName}>{item.displayName}</small> : null}
                      </div>
                    </td>
                    <td>
                      <span className={`badge badge-outline ${styles.kindBadge}`} title={item.kind}>
                        <span className={styles.kindBadgeText}>{item.kind}</span>
                      </span>
                    </td>
                    <td>
                      <span className={styles.muted} title={item.domain}>{item.domain}</span>
                    </td>
                    <td>
                      <span className={styles.muted} title={item.role || '-'}>{item.role || '-'}</span>
                    </td>
                    <td>
                      <span className={styles.muted} title={`${item.vendor || ''} ${item.model || ''}`.trim()}>
                        {item.vendor || item.model ? `${item.vendor || ''} ${item.model || ''}`.trim() : '-'}
                      </span>
                    </td>
                    <td>
                      <span
                        className={`badge ${
                          item.lifecycleState === 'active'
                            ? 'badge-success'
                            : item.lifecycleState === 'maintenance'
                            ? 'badge-warning'
                            : item.lifecycleState === 'retired'
                            ? 'badge-danger'
                            : 'badge-secondary'
                        }`}
                      >
                        {item.lifecycleState}
                      </span>
                    </td>
                    <td>
                      <span className={styles.dateCell}>{formatTimestamp(item.updatedAt)}</span>
                    </td>
                    <td className={styles.actionsCell}>
                      <Link
                        to={`/inventory/${encodeURIComponent(item.resourceId)}`}
                        className={styles.rowAction}
                      >
                        {t('inventory_view_details')}
                        <ChevronRight size={14} aria-hidden="true" />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!error && resources.length > 0 ? (
          <nav className={styles.pager} aria-label={t('inventory_title')}>
            <div className={styles.pagerSummary} aria-live="polite">
              {t('inventory_showing_resources', { count: resources.length })}
            </div>
            <div className={styles.pagerControls}>
              <button type="button" onClick={handleFirstPage} disabled={pageIndex === 1 || loading}>
                {t('inventory_first_page')}
              </button>
              <button type="button" onClick={handlePrevPage} disabled={pageIndex === 1 || loading}>
                {t('inventory_prev_page')}
              </button>
              <span className={styles.pageNumber}>{t('inventory_page_indicator', { page: pageIndex })}</span>
              <button type="button" onClick={handleNextPage} disabled={!hasMore || !nextCursor || loading}>
                {t('next')}
              </button>
            </div>
          </nav>
        ) : null}
      </section>
      )}
    </OperationsPageFrame>
  );
}
