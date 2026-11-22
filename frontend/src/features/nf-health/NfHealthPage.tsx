/*
 * NF Health duty view.
 *
 * The page answers one question first: which monitoring targets need attention
 * right now. Cards and the audit table are exclusive in-page views, the default
 * order is the server-defined risk order, and every filter lives in the URL so a
 * reload, a back/forward step or a shared link restores the same queue.
 *
 * This module is the single orchestration owner of the list surface:
 *
 *   - the authoritative read lifecycle (one token, one abortable request pair);
 *   - the 30s polling lifecycle and the visibility revalidation policy;
 *   - the URL state contract and the cursor walk;
 *   - the full-population KPI projection and the KPI-as-filter mapping;
 *   - the governed manual collection mutation.
 *
 * The card wall, the audit table, the interface matrix and the filter toolbar
 * are presentation components: they receive typed props and stable callbacks,
 * they never fetch, never poll and never own URL state.
 *
 * Layer state is never collapsed into one global health percentage, and an
 * unsupported layer stays visibly distinct from a measured healthy one.
 * Registry observation, process state and metric coverage remain separate
 * facts.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Activity, Plus, Server } from 'lucide-react';
import { hasPermission } from '../../lib/permissions';
import { currentListLocation, withReturnTo } from '../../lib/return-to';
import { EmptyState, LoadingRows, OperationFeedback } from '../../components/ui/OperationFeedback';
import { ErrorState } from '../../components/ui/StatePanel';
import MetricStrip, { type MetricStripItem } from '../../components/ui/MetricStrip';
import { ViewSwitch, type ViewSwitchOption } from '../../components/ui/ViewSwitch';
import { scopeKpiDetail } from '../operations/kpi-detail';
import { OperationsPageFrame } from '../operations/OperationsPageFrame';
import { useOperationsUrlState } from '../operations/use-operations-url-state';
import {
  fetchOperationsSummary,
  healthKpisFromSummary,
  type HealthSummarySection,
} from '../operations/operations-summary';
import { SkeletonKpiStrip } from '../../components/ui/LoadingSkeleton';
import { healthKpiFilter, type HealthKpiKey } from './nf-health-kpi';
import { useAuth } from '../../providers/AuthProvider';
import { useI18n } from '../../providers/I18nProvider';
import { useRead } from '../../lib/api/use-read';
import { isAbortError } from '../../lib/api/read-client';
import { MutationApiError } from '../../lib/api/mutation-client';
import type { RuntimeComponent, RuntimeObservations } from '../runtime/runtime-types';
import { resolveRuntimeObservations, useRuntimeStream } from '../runtime/use-runtime-stream';
import {
  collectNfHealthTarget,
  fetchNfHealthInterfaces,
  fetchNfHealthTargets,
} from './nf-health-api';
import {
  DEFAULT_HEALTH_SORT,
  HEALTH_URL_KEYS,
  HEALTH_VIEWS,
  hasHealthFilters,
  healthInterfaceQuery,
  healthTargetQuery,
  healthView,
  readHealthFilters,
} from './nf-health-filters';
import type {
  HealthTargetSummary,
  InterfaceMatrixResponse,
  ListTargetsResponse,
  NfHealthMeta,
  PageInfo,
} from './nf-health-types';
import { NfHealthTargetDialog } from './NfHealthTargetDialog';
import { NfHealthTargetDrawer } from './NfHealthTargetDrawer';
import { NfHealthTargetCards, type HealthDomainGroup } from './NfHealthTargetCards';
import { NfHealthTargetsTable } from './NfHealthTargetsTable';
import { NfHealthInterfaceMatrix } from './NfHealthInterfaceMatrix';
import {
  NfHealthFilterToolbar,
  type HealthToolbarFilterKey,
} from './NfHealthFilterToolbar';
import styles from '../../styles/modules/nf-health.module.css';

const PAGE_LIMIT = 20;

type Feedback = { tone: 'success' | 'danger' | 'warning' | 'info'; message: string } | null;

export function NfHealthPage() {
  const { t, formatDateTime } = useI18n();
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const listLocation = currentListLocation('/nf-health', location.search);

  const canRead = hasPermission(user, 'core.read');
  const canConfigure = hasPermission(user, 'core.configure');

  const metaRead = useRead<NfHealthMeta>(canRead ? '/api/nf-health/meta' : null);
  const meta = metaRead.data ?? null;
  const [targets, setTargets] = useState<HealthTargetSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [targetsError, setTargetsError] = useState<string | null>(null);
  const [targetsPage, setTargetsPage] = useState<PageInfo | null>(null);
  const [targetsCursorHistory, setTargetsCursorHistory] = useState<string[]>([]);
  const [matrix, setMatrix] = useState<InterfaceMatrixResponse | null>(null);
  const [matrixPage, setMatrixPage] = useState<PageInfo | null>(null);
  const [matrixError, setMatrixError] = useState<string | null>(null);
  const [summary, setSummary] = useState<HealthSummarySection | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [lastReadAt, setLastReadAt] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [collectingId, setCollectingId] = useState<string | null>(null);

  const readTokenRef = useRef(0);
  const readAbort = useRef<AbortController | null>(null);

  useEffect(() => () => {
    readAbort.current?.abort();
  }, []);

  /* The view, every filter and the page cursor live in the URL. A filter change
   * drops the cursor through the shared contract, so page N of a discarded
   * filter set can never be requested. */
  const url = useOperationsUrlState({
    keys: HEALTH_URL_KEYS,
    views: HEALTH_VIEWS,
    defaultView: 'cards',
  });
  const view = healthView(url.view);
  const filters = useMemo(() => readHealthFilters(url.filters), [url.filters]);
  const [searchInput, setSearchInput] = useState(filters.q);

  /* The last term this page itself committed to the URL. A self-initiated
   * navigation can commit after the operator has already typed the next term;
   * that late echo must not replace the newer draft. External URL changes
   * (back/forward, shared link, clear filters) still flow into the input. */
  const committedSearchRef = useRef(filters.q);

  useEffect(() => {
    if (filters.q === committedSearchRef.current) return;
    committedSearchRef.current = filters.q;
    setSearchInput(filters.q);
  }, [filters.q]);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [drawerTarget, setDrawerTarget] = useState<HealthTargetSummary | null>(null);

  const runtimeRead = useRead<RuntimeObservations>('/api/runtime/observations');
  const runtimeStream = useRuntimeStream();
  const runtimeData = resolveRuntimeObservations(runtimeStream, runtimeRead.data);

  const loadAll = useCallback(async (activeCursor?: string) => {
    const token = ++readTokenRef.current;
    readAbort.current?.abort();
    const controller = new AbortController();
    readAbort.current = controller;
    setLoading(true);
    setTargetsError(null);
    setMatrixError(null);
    setSummaryLoading(true);
    setTargetsCursorHistory([]);
    // Section-split error boundaries: a failed list load never blanks the
    // full-collection KPI strip, and a failed summary section only degrades the
    // KPI strip to explicit unavailable labels, never to page-scoped counts.
    const matrixView = view === 'interfaces';
    try {
      const [listRes, summaryRes] = await Promise.allSettled([
        matrixView
          ? fetchNfHealthInterfaces(healthInterfaceQuery(filters, activeCursor, PAGE_LIMIT), controller.signal)
          : fetchNfHealthTargets(healthTargetQuery(filters, activeCursor, PAGE_LIMIT), controller.signal),
        fetchOperationsSummary(['health'], controller.signal),
      ]);
      if (token !== readTokenRef.current) return;
      if (matrixView) {
        if (listRes.status === 'fulfilled') {
          const payload = listRes.value as InterfaceMatrixResponse;
          setMatrix(payload);
          setMatrixPage(payload.page ?? null);
        } else if (!isAbortError(listRes.reason)) {
          setMatrix(null);
          setMatrixPage(null);
          setMatrixError(describeLoadError(listRes.reason, t));
        }
      } else if (listRes.status === 'fulfilled') {
        const payload = listRes.value as ListTargetsResponse;
        setTargets(payload.targets ?? []);
        setTargetsPage(payload.page ?? null);
      } else if (!isAbortError(listRes.reason)) {
        setTargets([]);
        setTargetsPage(null);
        setTargetsError(describeLoadError(listRes.reason, t));
      }
      if (summaryRes.status === 'fulfilled') {
        setSummary(summaryRes.value.health ?? null);
      } else if (!isAbortError(summaryRes.reason)) {
        setSummary(null);
      }
      setSummaryLoading(false);
      setLoading(false);
      setLastReadAt(new Date().toISOString());
    } catch (err) {
      if (token !== readTokenRef.current || isAbortError(err)) return;
      setLoading(false);
      setSummaryLoading(false);
    }
  }, [filters, view, t]);

  // Cursor pager loads refresh exactly one bounded list; the full-collection
  // summary stays untouched, so a page step never changes the KPI strip.
  const loadTargetsPage = useCallback(async (cursor: string | undefined) => {
    const token = ++readTokenRef.current;
    readAbort.current?.abort();
    const controller = new AbortController();
    readAbort.current = controller;
    setLoading(true);
    setTargetsError(null);
    setMatrixError(null);
    try {
      if (view === 'interfaces') {
        const res = await fetchNfHealthInterfaces(healthInterfaceQuery(filters, cursor, PAGE_LIMIT), controller.signal);
        if (token !== readTokenRef.current) return;
        setMatrix(res);
        setMatrixPage(res.page ?? null);
      } else {
        const res = await fetchNfHealthTargets(healthTargetQuery(filters, cursor, PAGE_LIMIT), controller.signal);
        if (token !== readTokenRef.current) return;
        setTargets(res.targets ?? []);
        setTargetsPage(res.page ?? null);
      }
    } catch (err) {
      if (token !== readTokenRef.current || isAbortError(err)) return;
      if (view === 'interfaces') {
        setMatrix(null);
        setMatrixPage(null);
        setMatrixError(describeLoadError(err, t));
      } else {
        setTargets([]);
        setTargetsPage(null);
        setTargetsError(describeLoadError(err, t));
      }
    } finally {
      if (token === readTokenRef.current) {
        setLoading(false);
        setLastReadAt(new Date().toISOString());
      }
    }
  }, [filters, view, t]);

  /* Deep links and browser back/forward load the page named by the URL cursor.
   * A pager click already fetched that page and is skipped through the ref, so a
   * page step still revalidates only the bounded target list. */
  const internalCursorRef = useRef<string | undefined>(undefined);
  const internalCursorNavigationRef = useRef(false);
  useEffect(() => {
    if (!canRead) {
      setLoading(false);
      setSummaryLoading(false);
      setTargetsError(t('nf_health_err_forbidden'));
      return;
    }
    if (internalCursorNavigationRef.current && url.cursor === internalCursorRef.current) {
      internalCursorNavigationRef.current = false;
      return;
    }
    void loadAll(url.cursor);
  }, [canRead, loadAll, url.cursor]);

  const loadAllRef = useRef(loadAll);
  useEffect(() => {
    loadAllRef.current = loadAll;
  }, [loadAll]);

  /* Duty pages must not silently age. Refresh the first page and the
   * full-collection KPI strip together, pause while the tab is hidden, and
   * never disturb a cursor walk: paging stays a deliberate operation. */
  useEffect(() => {
    if (!canRead) return undefined;
    const timer = window.setInterval(() => {
      if (!document.hidden && !url.cursor) void loadAllRef.current();
    }, 30000);
    const onVisibility = () => {
      if (!document.hidden && !url.cursor) void loadAllRef.current();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [canRead, url.cursor]);

  const handleTargetsFirstPage = () => {
    setTargetsCursorHistory([]);
    internalCursorRef.current = undefined;
    internalCursorNavigationRef.current = url.cursor !== undefined;
    url.setCursor(undefined);
    void loadTargetsPage(undefined);
  };

  const handleTargetsPrevPage = () => {
    if (targetsCursorHistory.length === 0) return;
    const nextHistory = targetsCursorHistory.slice(0, -1);
    setTargetsCursorHistory(nextHistory);
    const prevCursor = nextHistory.length > 0 ? nextHistory[nextHistory.length - 1] : undefined;
    internalCursorRef.current = prevCursor;
    internalCursorNavigationRef.current = url.cursor !== prevCursor;
    url.setCursor(prevCursor);
    void loadTargetsPage(prevCursor);
  };

  const handleTargetsNextPage = () => {
    const nextCursor = targetsPage?.nextCursor;
    if (!nextCursor || !targetsPage?.hasMore) return;
    setTargetsCursorHistory((history) => [...history, nextCursor]);
    internalCursorRef.current = nextCursor;
    internalCursorNavigationRef.current = url.cursor !== nextCursor;
    url.setCursor(nextCursor);
    void loadTargetsPage(nextCursor);
  };

  const targetsPageIndex = targetsCursorHistory.length + 1;
  const activePage = view === 'interfaces' ? matrixPage : targetsPage;
  const activeError = view === 'interfaces' ? matrixError : targetsError;
  const activeCount = view === 'interfaces' ? matrix?.rows.length ?? 0 : targets.length;
  const matrixColumns = matrix?.columns ?? [];
  const matrixRows = matrix?.rows ?? [];

  const handleSearchSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const next = searchInput.trim();
    committedSearchRef.current = next;
    if (next === filters.q) {
      void loadAll(url.cursor);
      return;
    }
    url.setFilter('q', next);
  };

  const handleFilterChange = (key: HealthToolbarFilterKey, value: string) => {
    url.setFilter(key, value);
  };

  const handleClearFilters = () => {
    committedSearchRef.current = '';
    setSearchInput('');
    url.setFilters({ q: null, enabled: null, domain: null, state: null, layers: null, sort: null });
  };

  const handleCollect = async (target: HealthTargetSummary) => {
    setCollectingId(target.targetId);
    setFeedback(null);
    try {
      const result = await collectNfHealthTarget(target.targetId);
      const run = result.run;
      if (run.status === 'success') {
        setFeedback({ tone: 'success', message: t('nf_health_feedback_collect_ok') });
      } else if (run.status === 'partial') {
        setFeedback({ tone: 'warning', message: t('nf_health_feedback_collect_partial') });
      } else {
        setFeedback({
          tone: 'danger',
          message: run.errorSummary || t('nf_health_feedback_collect_failed'),
        });
      }
      await loadAll(url.cursor);
    } catch (err) {
      setFeedback({ tone: 'danger', message: describeMutationError(err, t) });
    } finally {
      setCollectingId(null);
    }
  };

  // Runtime components supply process evidence (CPU sample deltas, RSS) for
  // bound targets. Unavailable measurements stay unavailable and are never
  // rendered as zeros.
  const runtimeByRole = useMemo(() => {
    const map = new Map<string, RuntimeComponent>();
    for (const component of runtimeData?.snapshot?.components ?? []) {
      if (component.role) map.set(component.role, component);
    }
    return map;
  }, [runtimeData]);

  const runtimeByNfType = useMemo(() => {
    const map = new Map<string, RuntimeComponent>();
    for (const component of runtimeData?.snapshot?.components ?? []) {
      if (component.nfType) map.set(component.nfType, component);
    }
    return map;
  }, [runtimeData]);

  const resolveRuntimeComponent = useCallback(
    (target: HealthTargetSummary): RuntimeComponent | undefined => {
      const nfType = target.nfType;
      return nfType ? runtimeByNfType.get(nfType) ?? runtimeByRole.get(nfType) : undefined;
    },
    [runtimeByRole, runtimeByNfType],
  );

  /* Domain grouping partitions the received sequence; it never re-sorts it. The
   * backend already ordered the queue by risk, and grouping must preserve that
   * order inside each domain or the "what needs attention now" answer becomes an
   * alphabetical list. */
  const domainGroups = useMemo<HealthDomainGroup[]>(() => {
    const groups = new Map<string, HealthTargetSummary[]>();
    for (const target of targets) {
      // Domain is a server-derived projection over the authoritative Inventory
      // identity. It is never inferred here.
      const key = target.domain ?? 'unknown';
      const list = groups.get(key) ?? [];
      list.push(target);
      groups.set(key, list);
    }
    return Array.from(groups.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([domain, list]) => ({
        domain,
        label: domain === 'unknown' ? t('nf_health_domain_unknown') : domain.toUpperCase(),
        targets: list,
      }));
  }, [targets, t]);

  // KPIs come from the full-collection summary section, never from the current
  // page arrays. A page-scoped count must never be presented as a platform
  // total (scope/completeness contract).
  const kpis = useMemo(() => healthKpisFromSummary(summary ?? undefined), [summary]);

  const viewOptions = useMemo<ViewSwitchOption<string>[]>(
    () => HEALTH_VIEWS.map((option) => ({
      value: option,
      label: option === 'cards'
        ? t('nf_health_view_cards')
        : option === 'table'
          ? t('nf_health_view_table')
          : t('nf_health_view_interfaces'),
      data: { 'data-nf-health-view': option },
    })),
    [t],
  );

  // KPI cards are filter entries: each one narrows the queue to exactly the
  // population it counts, so an operator never has to translate a number into
  // a hand-built filter.
  const applyKpiFilter = useCallback(
    (key: HealthKpiKey) => {
      const patch = healthKpiFilter(key);
      url.setFilters({ freshness: patch.freshness, collection: patch.collection });
    },
    [url],
  );

  const kpiItems = useMemo<MetricStripItem[]>(() => [
    {
      key: 'configured',
      label: t('nf_health_kpi_configured'),
      value: kpis.configured ?? '-',
      detail: scopeKpiDetail(kpis.configured, t),
      tone: kpis.configured === null ? 'muted' : 'primary',
      onClick: () => applyKpiFilter('configured'),
      ariaLabel: t('nf_health_kpi_filter_configured'),
    },
    {
      key: 'fresh',
      label: t('nf_health_kpi_fresh'),
      value: kpis.fresh ?? '-',
      detail: scopeKpiDetail(kpis.fresh, t),
      tone: kpis.fresh === null ? 'muted' : 'primary',
      onClick: () => applyKpiFilter('fresh'),
      ariaLabel: t('nf_health_kpi_filter_fresh'),
    },
    {
      key: 'stale',
      label: t('nf_health_kpi_stale'),
      value: kpis.stale ?? '-',
      detail: scopeKpiDetail(kpis.stale, t),
      tone: kpis.stale === null ? 'muted' : 'primary',
      onClick: () => applyKpiFilter('stale'),
      ariaLabel: t('nf_health_kpi_filter_stale'),
    },
    {
      key: 'unknown',
      label: t('nf_health_kpi_unknown'),
      value: kpis.unknown ?? '-',
      detail: scopeKpiDetail(kpis.unknown, t),
      tone: kpis.unknown === null ? 'muted' : 'primary',
      onClick: () => applyKpiFilter('unknown'),
      ariaLabel: t('nf_health_kpi_filter_unknown'),
    },
    {
      key: 'not-monitored',
      label: t('nf_health_kpi_not_monitored'),
      value: kpis.notMonitored ?? '-',
      detail: scopeKpiDetail(kpis.notMonitored, t),
      tone: kpis.notMonitored === null ? 'muted' : 'primary',
      onClick: () => applyKpiFilter('notMonitored'),
      ariaLabel: t('nf_health_kpi_filter_not_monitored'),
    },
    {
      key: 'failed',
      label: t('nf_health_kpi_failed'),
      value: kpis.failed ?? '-',
      detail: scopeKpiDetail(kpis.failed, t),
      tone: kpis.failed === null ? 'muted' : 'warning',
      onClick: () => applyKpiFilter('failed'),
      ariaLabel: t('nf_health_kpi_filter_failed'),
    },
  ], [kpis, t, applyKpiFilter]);

  const filtersActive = hasHealthFilters(filters);

  /* Detail links carry the current list URL so returning from a detail page
   * restores the same queue. The table's name link stays plain: it is the
   * identity cell, not a return-to affordance. */
  const detailHref = useCallback(
    (targetId: string) => withReturnTo(`/nf-health/${encodeURIComponent(targetId)}`, listLocation),
    [listLocation],
  );
  const plainDetailHref = useCallback(
    (targetId: string) => `/nf-health/${encodeURIComponent(targetId)}`,
    [],
  );
  const handleOpenDetail = useCallback(
    (targetId: string) => navigate(detailHref(targetId)),
    [navigate, detailHref],
  );

  return (
    <OperationsPageFrame
      title={t('nf_health_title')}
      description={t('nf_health_description')}
      icon={<Activity size={23} />}
      status={lastReadAt ? <span>{t('nf_health_last_read', { time: formatDateTime(lastReadAt) })}</span> : undefined}
      viewSwitch={(
        <ViewSwitch
          options={viewOptions}
          value={view}
          onChange={(option) => url.setView(option)}
          ariaLabel={t('nf_health_view_label')}
        />
      )}
      onRefresh={() => loadAll(url.cursor)}
      actions={
        canConfigure ? (
          <button type="button" className="btn btn-primary" onClick={() => setDialogOpen(true)}>
            <Plus size={16} />
            {t('nf_health_add_target')}
          </button>
        ) : undefined
      }
    >
      {feedback ? (
        <OperationFeedback
          tone={feedback.tone}
          title={t('nf_health_operation_result')}
          message={feedback.message}
          onDismiss={() => setFeedback(null)}
        />
      ) : null}

      {loading && summaryLoading && targets.length === 0 ? (
        <SkeletonKpiStrip count={6} />
      ) : (
        <MetricStrip
          variant="cards"
          columns={6}
          ariaLabel={t('nf_health_kpi_label')}
          items={kpiItems}
        />
      )}

      <section className="dash-card" data-nf-health-panel={view}>
        <NfHealthFilterToolbar
          filters={filters}
          searchInput={searchInput}
          onSearchInputChange={setSearchInput}
          onSearchSubmit={handleSearchSubmit}
          onFilterChange={handleFilterChange}
          onClearFilters={handleClearFilters}
          disabled={loading}
          filtersActive={filtersActive}
        />

        <div className={styles.sectionHead}>
          <h2>
            <Server size={16} aria-hidden="true" />
            {view === 'cards'
              ? t('nf_health_card_wall_section')
              : view === 'table'
                ? t('nf_health_targets_section')
                : t('nf_health_matrix_section')}
          </h2>
          <span className={styles.sectionNote}>
            {view === 'interfaces'
              ? t('nf_health_matrix_note')
              : filters.sort === DEFAULT_HEALTH_SORT
                ? t('nf_health_sort_risk_note')
                : t('nf_health_targets_note')}
          </span>
        </div>
        <p className={styles.semanticNote}>{t('nf_health_semantic_separation')}</p>

        {activeError ? (
          <div className={styles.errorWrap}>
            <ErrorState title={t('error')} message={activeError} retryLabel={t('nf_health_retry')} onRetry={() => void loadAll(url.cursor)} />
          </div>
        ) : loading && activeCount === 0 ? (
          <LoadingRows columns={view === 'cards' ? 4 : view === 'table' ? 9 : 6} rows={4} />
        ) : activeCount === 0 ? (
          <div className={styles.stateWrap}>
            <EmptyState
              icon={<Activity size={44} />}
              title={filtersActive ? t('nf_health_empty_filtered_title') : t('nf_health_empty_targets_title')}
              description={filtersActive ? t('nf_health_empty_filtered_body') : t('nf_health_empty_targets_body')}
              action={
                canConfigure && !filtersActive ? (
                  <button type="button" className="btn btn-primary" onClick={() => setDialogOpen(true)}>
                    <Plus size={16} />
                    {t('nf_health_add_target')}
                  </button>
                ) : undefined
              }
            />
          </div>
        ) : view === 'cards' ? (
          <NfHealthTargetCards
            groups={domainGroups}
            detailHref={detailHref}
            onOpenTarget={setDrawerTarget}
            resolveRuntimeComponent={resolveRuntimeComponent}
          />
        ) : view === 'table' ? (
          <NfHealthTargetsTable
            targets={targets}
            canConfigure={canConfigure}
            collectingId={collectingId}
            onCollect={handleCollect}
            targetHref={plainDetailHref}
            onOpenDetail={handleOpenDetail}
          />
        ) : (
          <NfHealthInterfaceMatrix
            columns={matrixColumns}
            rows={matrixRows}
            detailHref={detailHref}
          />
        )}

        {activeError ? null : activeCount > 0 || activePage?.hasMore ? (
          <nav className={styles.pager} aria-label={t('nf_health_targets_section')}>
            <span className={styles.pagerSummary} aria-live="polite">
              {t('nf_health_pager_targets', { count: activeCount })}
            </span>
            <div className={styles.pagerControls}>
              <button
                type="button"
                onClick={handleTargetsFirstPage}
                disabled={targetsPageIndex === 1 || loading}
              >
                {t('ops_pager_first')}
              </button>
              <button
                type="button"
                onClick={handleTargetsPrevPage}
                disabled={targetsPageIndex === 1 || loading}
              >
                {t('ops_pager_prev')}
              </button>
              <span className={styles.pageNumber}>{t('ops_pager_page', { page: targetsPageIndex })}</span>
              <button
                type="button"
                onClick={handleTargetsNextPage}
                disabled={!activePage?.hasMore || !activePage?.nextCursor || loading}
              >
                {t('ops_pager_next')}
              </button>
            </div>
          </nav>
        ) : null}
      </section>

      <NfHealthTargetDrawer
        target={drawerTarget}
        onClose={() => setDrawerTarget(null)}
        onCollected={() => void loadAll(url.cursor)}
      />

      <NfHealthTargetDialog
        open={dialogOpen}
        mode="create"
        meta={meta}
        onClose={() => setDialogOpen(false)}
        onSaved={(message) => {
          setFeedback({ tone: 'success', message });
          void loadAll(url.cursor);
        }}
        onFormError={(message) => setFeedback({ tone: 'danger', message })}
      />
    </OperationsPageFrame>
  );
}

function describeLoadError(
  err: unknown,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  return err instanceof Error && err.message ? err.message : t('nf_health_err_load');
}

function describeMutationError(
  err: unknown,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  if (err instanceof MutationApiError) {
    switch (err.code) {
      case 'NF_HEALTH_DESTINATION_NOT_ALLOWED':
        return t('nf_health_err_destination_not_allowed');
      case 'NF_HEALTH_SERVICE_UNIT_NOT_ALLOWED':
        return t('nf_health_err_service_unit_not_allowed');
      case 'NF_HEALTH_PROCESS_BINDING_MISSING':
        return t('nf_health_err_process_binding_missing');
      case 'NF_HEALTH_PROCESS_BINDING_MISMATCH':
        return t('nf_health_err_process_binding_mismatch');
      case 'NF_HEALTH_RESOURCE_NOT_FOUND':
        return t('nf_health_err_resource_not_found');
      case 'NF_HEALTH_RESOURCE_KIND_UNSUPPORTED':
        return t('nf_health_err_resource_kind_unsupported');
      case 'NF_HEALTH_RESOURCE_DOMAIN_UNSUPPORTED':
        return t('nf_health_err_resource_domain_unsupported');
      case 'NF_HEALTH_RESOURCE_RETIRED':
        return t('nf_health_err_resource_retired');
      case 'NF_HEALTH_NF_TYPE_UNRESOLVED':
        return t('nf_health_err_nf_type_unresolved');
      case 'NF_HEALTH_CANDIDATE_RESOURCE_MISMATCH':
        return t('nf_health_err_candidate_resource_mismatch');
      case 'NF_HEALTH_CANDIDATE_TYPE_MISMATCH':
        return t('nf_health_err_candidate_type_mismatch');
      case 'NF_HEALTH_TARGET_IDENTITY_MISMATCH':
        return t('nf_health_err_target_identity_mismatch');
      case 'NF_HEALTH_PROCESS_NF_TYPE_INCOMPATIBLE':
        return t('nf_health_err_process_nf_type_incompatible');
      case 'NF_HEALTH_PROCESS_DOMAIN_INCOMPATIBLE':
        return t('nf_health_err_process_domain_incompatible');
      case 'NF_HEALTH_REVISION_CONFLICT':
        return t('nf_health_err_revision_conflict');
      case 'NF_HEALTH_TARGET_NOT_FOUND':
        return t('nf_health_err_target_missing');
      case 'NF_HEALTH_TARGET_DISABLED':
        return t('nf_health_err_target_disabled');
      case 'NF_HEALTH_COLLECTION_IN_PROGRESS':
        return t('nf_health_err_collection_in_progress');
      case 'NF_HEALTH_COLLECTION_RATE_LIMITED':
        return t('nf_health_err_collection_rate_limited');
      case 'NF_HEALTH_TARGET_CONFLICT':
        return t('nf_health_err_target_conflict');
      default:
        return err.message || t('nf_health_err_mutation');
    }
  }
  return err instanceof Error && err.message ? err.message : t('nf_health_err_mutation');
}
