/*
 * NF Health duty view.
 *
 * The page answers one question first: which monitoring targets need attention
 * right now. Cards and the audit table are exclusive in-page views, the default
 * order is the server-defined risk order, and every filter lives in the URL so a
 * reload, a back/forward step or a shared link restores the same queue.
 *
 * Layer state is never collapsed into one global health percentage, and an
 * unsupported layer stays visibly distinct from a measured healthy one.
 * Registry observation, process state and metric coverage remain separate
 * facts.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Activity,
  Boxes,
  Link2,
  Play,
  Plus,
  Search,
  Server,
  X,
} from 'lucide-react';
import { hasPermission } from '../../lib/permissions';
import { EmptyState, LoadingRows, OperationFeedback } from '../../components/ui/OperationFeedback';
import { ErrorState } from '../../components/ui/StatePanel';
import { OperationsPageFrame } from '../operations/OperationsPageFrame';
import { useOperationsUrlState } from '../operations/use-operations-url-state';
import {
  fetchOperationsSummary,
  healthKpisFromSummary,
  type HealthSummarySection,
} from '../operations/operations-summary';
import { SkeletonKpiStrip } from '../../components/ui/LoadingSkeleton';
import { useAuth } from '../../providers/AuthProvider';
import { useI18n } from '../../providers/I18nProvider';
import { useRead } from '../../lib/api/use-read';
import { MutationApiError } from '../../lib/api/mutation-client';
import { OPERATIONAL_DOMAINS } from '../operations/operational-model';
import type { RuntimeComponent, RuntimeObservations } from '../runtime/runtime-types';
import { resolveRuntimeObservations, useRuntimeStream } from '../runtime/use-runtime-stream';
import {
  collectNfHealthTarget,
  fetchNfHealthInterfaces,
  fetchNfHealthMeta,
  fetchNfHealthTargets,
} from './nf-health-api';
import {
  DEFAULT_HEALTH_SORT,
  HEALTH_LAYER_FILTERS,
  HEALTH_OVERALL_STATES,
  HEALTH_SORTS,
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
  InterfaceCell,
  InterfaceMatrixResponse,
  LayerState,
  ListTargetsResponse,
  NfHealthMeta,
  PageInfo,
} from './nf-health-types';
import { NfHealthTargetDialog } from './NfHealthTargetDialog';
import { NfHealthTargetDrawer } from './NfHealthTargetDrawer';
import styles from '../../styles/modules/nf-health.module.css';

const PAGE_LIMIT = 20;

type Feedback = { tone: 'success' | 'danger' | 'warning' | 'info'; message: string } | null;

export function NfHealthPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const navigate = useNavigate();

  const canRead = hasPermission(user, 'core.read');
  const canConfigure = hasPermission(user, 'core.configure');

  const [meta, setMeta] = useState<NfHealthMeta | null>(null);
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
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [collectingId, setCollectingId] = useState<string | null>(null);

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

  // Keep the visible query in step with the URL (back/forward, shared link).
  useEffect(() => {
    setSearchInput(filters.q);
  }, [filters.q]);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [drawerTarget, setDrawerTarget] = useState<HealthTargetSummary | null>(null);

  const runtimeRead = useRead<RuntimeObservations>('/api/runtime/observations');
  const runtimeStream = useRuntimeStream();
  const runtimeData = resolveRuntimeObservations(runtimeStream, runtimeRead.data);

  const loadAll = useCallback(async (activeCursor?: string) => {
    setLoading(true);
    setTargetsError(null);
    setMatrixError(null);
    setSummaryLoading(true);
    setTargetsCursorHistory([]);
    // Section-split error boundaries: a failed list load never blanks the
    // full-collection KPI strip, and a failed summary section only degrades the
    // KPI strip to explicit unavailable labels, never to page-scoped counts.
    const matrixView = view === 'interfaces';
    const [metaRes, listRes, summaryRes] = await Promise.allSettled([
      fetchNfHealthMeta(),
      matrixView
        ? fetchNfHealthInterfaces(healthInterfaceQuery(filters, activeCursor, PAGE_LIMIT))
        : fetchNfHealthTargets(healthTargetQuery(filters, activeCursor, PAGE_LIMIT)),
      fetchOperationsSummary(['health']),
    ]);
    setMeta(metaRes.status === 'fulfilled' ? metaRes.value : null);
    if (matrixView) {
      if (listRes.status === 'fulfilled') {
        const payload = listRes.value as InterfaceMatrixResponse;
        setMatrix(payload);
        setMatrixPage(payload.page ?? null);
      } else {
        setMatrix(null);
        setMatrixPage(null);
        setMatrixError(describeLoadError(listRes.reason, t));
      }
    } else if (listRes.status === 'fulfilled') {
      const payload = listRes.value as ListTargetsResponse;
      setTargets(payload.targets ?? []);
      setTargetsPage(payload.page ?? null);
    } else {
      setTargets([]);
      setTargetsPage(null);
      setTargetsError(describeLoadError(listRes.reason, t));
    }
    setSummary(summaryRes.status === 'fulfilled' ? (summaryRes.value.health ?? null) : null);
    setSummaryLoading(false);
    setLoading(false);
  }, [filters, view, t]);

  // Cursor pager loads refresh exactly one bounded list; the full-collection
  // summary stays untouched, so a page step never changes the KPI strip.
  const loadTargetsPage = useCallback(async (cursor: string | undefined) => {
    setLoading(true);
    setTargetsError(null);
    setMatrixError(null);
    try {
      if (view === 'interfaces') {
        const res = await fetchNfHealthInterfaces(healthInterfaceQuery(filters, cursor, PAGE_LIMIT));
        setMatrix(res);
        setMatrixPage(res.page ?? null);
      } else {
        const res = await fetchNfHealthTargets(healthTargetQuery(filters, cursor, PAGE_LIMIT));
        setTargets(res.targets ?? []);
        setTargetsPage(res.page ?? null);
      }
    } catch (err) {
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
      setLoading(false);
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
    if (next === filters.q) {
      void loadAll(url.cursor);
      return;
    }
    url.setFilter('q', next);
  };

  const handleClearFilters = () => {
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

  const domainGroups = useMemo(() => {
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

  const filtersActive = hasHealthFilters(filters);

  return (
    <OperationsPageFrame
      title={t('nf_health_title')}
      description={t('nf_health_description')}
      icon={<Activity size={23} />}
      viewSwitch={(
        <div className={styles.viewToggle} role="group" aria-label={t('nf_health_view_label')}>
          {HEALTH_VIEWS.map((option) => (
            <button
              key={option}
              type="button"
              data-nf-health-view={option}
              className={view === option ? styles.viewToggleActive : undefined}
              aria-pressed={view === option}
              onClick={() => url.setView(option)}
            >
              {option === 'cards'
                ? t('nf_health_view_cards')
                : option === 'table'
                  ? t('nf_health_view_table')
                  : t('nf_health_view_interfaces')}
            </button>
          ))}
        </div>
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
        <SkeletonKpiStrip count={4} />
      ) : (
        <section className={styles.kpiStrip} aria-label={t('nf_health_kpi_label')}>
          <article className={styles.kpiCard}>
            <span className={styles.kpiLabel}>{t('nf_health_kpi_configured')}</span>
            <strong className={styles.kpiValue}>{kpis.configured ?? '-'}</strong>
            <span className={styles.kpiMeta}>
              {kpis.configured === null ? (
                <span className={styles.kpiUnavailable}>{t('ops_kpi_unavailable')}</span>
              ) : (
                <span className={styles.kpiScope} title={t('ops_kpi_scope_note')}>{t('ops_kpi_scope_full_collection')}</span>
              )}
            </span>
          </article>
          <article className={styles.kpiCard}>
            <span className={styles.kpiLabel}>{t('nf_health_kpi_fresh')}</span>
            <strong className={styles.kpiValue}>{kpis.fresh ?? '-'}</strong>
            <span className={styles.kpiMeta}>
              {kpis.fresh === null ? (
                <span className={styles.kpiUnavailable}>{t('ops_kpi_unavailable')}</span>
              ) : (
                <span className={styles.kpiScope} title={t('ops_kpi_scope_note')}>{t('ops_kpi_scope_full_collection')}</span>
              )}
            </span>
          </article>
          <article className={styles.kpiCard}>
            <span className={styles.kpiLabel}>{t('nf_health_kpi_degraded')}</span>
            <strong className={styles.kpiValue}>{kpis.failed ?? '-'}</strong>
            <span className={styles.kpiMeta}>
              {kpis.failed === null ? (
                <span className={styles.kpiUnavailable}>{t('ops_kpi_unavailable')}</span>
              ) : (
                <span className={styles.kpiScope} title={t('ops_kpi_scope_note')}>{t('ops_kpi_scope_full_collection')}</span>
              )}
            </span>
          </article>
          <article className={styles.kpiCard}>
            <span className={styles.kpiLabel}>{t('nf_health_kpi_stale')}</span>
            <strong className={styles.kpiValue}>{kpis.staleUnknown ?? '-'}</strong>
            <span className={styles.kpiMeta}>
              {kpis.staleUnknown === null ? (
                <span className={styles.kpiUnavailable}>{t('ops_kpi_unavailable')}</span>
              ) : (
                <span className={styles.kpiScope} title={t('ops_kpi_scope_note')}>{t('ops_kpi_scope_full_collection')}</span>
              )}
            </span>
          </article>
        </section>
      )}

      <section className="dash-card" data-nf-health-panel={view}>
        <div className={styles.toolbar}>
          <form className={styles.search} onSubmit={handleSearchSubmit} role="search">
            <Search size={16} className={styles.searchIcon} aria-hidden="true" />
            <input
              type="search"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder={t('nf_health_search_placeholder')}
              aria-label={t('nf_health_search_placeholder')}
            />
            <button type="submit" className="btn btn-secondary">
              {t('search')}
            </button>
          </form>
          <div className={styles.filterGroup}>
            <select
              className="form-input"
              aria-label={t('nf_health_filter_enabled')}
              value={filters.enabled}
              onChange={(event) => url.setFilter('enabled', event.target.value)}
            >
              <option value="">{t('nf_health_filter_all_states')}</option>
              <option value="true">{t('nf_health_enabled')}</option>
              <option value="false">{t('nf_health_disabled')}</option>
            </select>
            <select
              className="form-input"
              aria-label={t('nf_health_filter_domain')}
              value={filters.domain}
              onChange={(event) => url.setFilter('domain', event.target.value)}
            >
              <option value="">{t('nf_health_filter_all_domains')}</option>
              {OPERATIONAL_DOMAINS.map((domain) => (
                <option key={domain} value={domain}>
                  {t(`ops_domain_${domain}`)}
                </option>
              ))}
            </select>
            <select
              className="form-input"
              aria-label={t('nf_health_filter_overall')}
              value={filters.overall}
              onChange={(event) => url.setFilter('state', event.target.value)}
            >
              <option value="">{t('nf_health_filter_all_overall')}</option>
              {HEALTH_OVERALL_STATES.map((state) => (
                <option key={state} value={state}>
                  {t(`nf_health_state_${state}`)}
                </option>
              ))}
            </select>
            <select
              className="form-input"
              aria-label={t('nf_health_filter_layers')}
              value={filters.layer}
              onChange={(event) => url.setFilter('layers', event.target.value)}
            >
              <option value="">{t('nf_health_filter_all_layers')}</option>
              {HEALTH_LAYER_FILTERS.map((layer) => (
                <option key={layer} value={layer}>
                  {t(`nf_health_layer_${layer}_measured_filter`)}
                </option>
              ))}
            </select>
            <select
              className="form-input"
              aria-label={t('nf_health_filter_sort')}
              value={filters.sort}
              onChange={(event) => url.setFilter('sort', event.target.value)}
            >
              {HEALTH_SORTS.map((sort) => (
                <option key={sort} value={sort}>
                  {sort === 'risk' ? t('nf_health_sort_risk') : t('nf_health_sort_updated')}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={handleClearFilters}
              disabled={loading || !filtersActive}
            >
              <X size={14} aria-hidden="true" />
              {t('nf_health_clear_filters')}
            </button>
          </div>
        </div>

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
          <div className={styles.cardWall}>
            {domainGroups.map((group) => (
              <div key={group.domain} className={styles.cardGroup}>
                <h3 className={styles.cardGroupTitle}>{group.label}</h3>
                <div className={styles.cardGrid}>
                  {group.targets.map((target) => {
                    const runtimeComponent = resolveRuntimeComponent(target);
                    return (
                      <article key={target.targetId} className={styles.targetCard}>
                        <button
                          type="button"
                          className={styles.targetCardMain}
                          data-nf-health-card={target.targetId}
                          onClick={() => setDrawerTarget(target)}
                          aria-label={t('nf_health_open_drawer', { name: target.name })}
                        >
                          <header className={styles.targetCardHead}>
                            <strong className={styles.targetCardName}>{target.name}</strong>
                            <span className={styles.targetCardType}>{target.nfType ?? '-'}</span>
                          </header>
                          <div className={styles.targetCardStatus}>
                            {overallBadge(target, t)}
                          </div>
                          <div className={styles.targetCardBadges}>
                            {coverageBadge(true, target.coverage.l1Measured, t, styles, 'L1')}
                            {coverageBadge(true, target.coverage.l2Measured, t, styles, 'L2')}
                            {coverageBadge(
                              target.coverage.l3Available,
                              target.coverage.l3Measured,
                              t,
                              styles,
                              'L3',
                            )}
                          </div>
                          <UtilizationBar
                            label={t('nf_health_card_memory')}
                            available={Boolean(runtimeComponent?.memoryAvailable)}
                            percent={runtimeComponent?.memoryPercent ?? null}
                          />
                          <UtilizationBar
                            label={t('nf_health_card_cpu')}
                            available={Boolean(runtimeComponent?.cpuAvailable)}
                            percent={runtimeComponent?.cpuPercent ?? null}
                          />
                        </button>
                        <footer className={styles.targetCardFoot}>
                          <span className={styles.targetCardMeta}>
                            {formatTimestamp(target.lastMeasuredAt)}
                          </span>
                          <Link
                            to={`/nf-health/${encodeURIComponent(target.targetId)}`}
                            className={styles.rowLink}
                          >
                            {t('nf_health_open_detail')}
                          </Link>
                        </footer>
                      </article>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        ) : view === 'table' ? (
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <caption className="sr-only">{t('nf_health_targets_caption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('nf_health_col_name')}</th>
                  <th scope="col">{t('nf_health_col_nf_type')}</th>
                  <th scope="col">{t('nf_health_col_mode')}</th>
                  <th scope="col">{t('nf_health_col_l1')}</th>
                  <th scope="col">{t('nf_health_col_l2')}</th>
                  <th scope="col">{t('nf_health_col_l3')}</th>
                  <th scope="col">{t('nf_health_col_last_measured')}</th>
                  <th scope="col">{t('nf_health_evidence_freshness')}</th>
                  <th scope="col">{t('nf_health_col_collection_status')}</th>
                  <th scope="col">{t('nf_health_col_actions')}</th>
                </tr>
              </thead>
              <tbody>
                {targets.map((target) => {
                  const legacyIdentity =
                    !target.resourceId ||
                    target.identityState === 'legacy_unbound' ||
                    target.identityState === 'legacy_unresolved';
                  return (
                    <tr key={target.targetId}>
                      <td>
                        <Link
                          to={`/nf-health/${encodeURIComponent(target.targetId)}`}
                          className={styles.rowLink}
                        >
                          {target.name}
                        </Link>
                        <div className={styles.stack}>
                          <code className={styles.uuid}>{target.targetId}</code>
                        </div>
                      </td>
                      <td>
                        <div className={styles.stack}>
                          <strong>{target.nfType ?? target.name}</strong>
                          {target.domain ? (
                            <span className={styles.chip}>{target.domain}</span>
                          ) : null}
                          {target.resourceId ? (
                            <Link
                              to={`/inventory/${encodeURIComponent(target.resourceId)}`}
                              className={styles.rowLink}
                              title={t('nf_health_link_resource')}
                            >
                              <Link2 size={12} aria-hidden="true" />
                              {t('nf_health_link_resource')}
                            </Link>
                          ) : null}
                          {target.candidateId ? (
                            <Link to="/discovery" className={styles.rowLink} title={t('nf_health_link_candidate')}>
                              <Boxes size={12} aria-hidden="true" />
                              {t('nf_health_link_candidate')}
                            </Link>
                          ) : null}
                          {legacyIdentity ? (
                            <span className={styles.badgeUnknown} title={t('nf_health_identity_legacy_hint')}>
                              {t('nf_health_identity_legacy')}
                            </span>
                          ) : null}
                        </div>
                      </td>
                      <td>
                        <code className={styles.chip}>
                          {target.collectionMode === 'manual'
                            ? t('nf_health_mode_manual')
                            : t('nf_health_mode_scheduled')}
                        </code>
                      </td>
                      <td>
                        {coverageBadge(true, target.coverage.l1Measured, t, styles)}
                      </td>
                      <td>
                        {coverageBadge(true, target.coverage.l2Measured, t, styles)}
                      </td>
                      <td>
                        {coverageBadge(
                          target.coverage.l3Available,
                          target.coverage.l3Measured,
                          t,
                          styles,
                        )}
                      </td>
                      <td>{formatTimestamp(target.lastMeasuredAt)}</td>
                      <td>{freshnessBadge(target, t)}</td>
                      <td>
                        {target.lastError ? (
                          <span className={styles.badgeUnhealthy}>{t('nf_health_status_failed')}</span>
                        ) : target.lastSuccessAt ? (
                          <span className={styles.badgeHealthy}>{t('nf_health_status_success')}</span>
                        ) : (
                          <span className={styles.badgeUnknown}>{t('nf_health_status_never')}</span>
                        )}
                      </td>
                      <td>
                        <div className={styles.rowActions}>
                          <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={() => void handleCollect(target)}
                            disabled={!canConfigure || collectingId === target.targetId}
                            title={t('nf_health_collect_action')}
                          >
                            <Play size={14} />
                            {collectingId === target.targetId ? t('nf_health_collecting') : t('nf_health_collect_action')}
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost"
                            onClick={() => navigate(`/nf-health/${encodeURIComponent(target.targetId)}`)}
                          >
                            {t('nf_health_open_detail')}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className={styles.tableScroll}>
            <table className={styles.matrix} data-nf-health-matrix="true">
              <caption className="sr-only">{t('nf_health_matrix_caption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('nf_health_col_name')}</th>
                  {matrixColumns.map((family) => (
                    <th key={family} scope="col">
                      {t(`nf_health_probe_family_${family}`)}
                    </th>
                  ))}
                  <th scope="col">{t('nf_health_col_overall')}</th>
                  <th scope="col">{t('nf_health_evidence_freshness')}</th>
                  <th scope="col">{t('nf_health_col_last_measured')}</th>
                </tr>
              </thead>
              <tbody>
                {matrixRows.map((row) => (
                  <tr key={row.targetId} data-nf-health-matrix-row={row.targetId}>
                    <th scope="row">
                      <Link
                        to={`/nf-health/${encodeURIComponent(row.targetId)}`}
                        className={styles.rowLink}
                      >
                        {row.name}
                      </Link>
                      <div className={styles.stack}>
                        <span className={styles.chip}>{row.nfType ?? '-'}</span>
                        {row.domain ? <span className={styles.chip}>{row.domain}</span> : null}
                      </div>
                    </th>
                    {matrixColumns.map((family) => (
                      <td key={family} data-nf-health-cell={`${row.targetId}:${family}`}>
                        {matrixCell(row.cells[family] ?? { state: 'not_configured' as LayerState }, t)}
                      </td>
                    ))}
                    <td>{stateBadge(row.overallState, t)}</td>
                    <td>{freshnessStateBadge(row.freshness, t)}</td>
                    <td>{formatTimestamp(row.lastMeasuredAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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

/* The main status of a target: the server projection, never a client guess.
 * A target whose projection is unknown says so instead of implying health. */
function overallBadge(
  target: HealthTargetSummary,
  t: (key: string) => string,
): React.ReactElement {
  return stateBadge(target.overallState ?? 'unknown', t);
}

function stateBadge(state: string, t: (key: string) => string): React.ReactElement {
  const className =
    state === 'healthy'
      ? styles.badgeHealthy
      : state === 'degraded'
        ? styles.badgeDegraded
        : state === 'unhealthy'
          ? styles.badgeUnhealthy
          : state === 'stale'
            ? styles.badgeStale
            : state === 'not_configured'
              ? styles.badgeNotConfigured
              : styles.badgeUnknown;
  const key = state === 'healthy' || state === 'degraded' || state === 'unhealthy' ||
    state === 'stale' || state === 'not_configured'
    ? `nf_health_state_${state}`
    : 'nf_health_state_unknown';
  return <span className={className}>{t(key)}</span>;
}

function freshnessBadge(
  target: HealthTargetSummary,
  t: (key: string) => string,
): React.ReactElement {
  return freshnessStateBadge(target.freshness?.state ?? 'unknown', t);
}

function freshnessStateBadge(state: string, t: (key: string) => string): React.ReactElement {
  if (state === 'fresh') {
    return <span className={styles.badgeHealthy}>{t('nf_health_state_healthy')}</span>;
  }
  if (state === 'stale') {
    return <span className={styles.badgeStale}>{t('nf_health_state_stale')}</span>;
  }
  if (state === 'not_monitored') {
    return <span className={styles.badgeNotConfigured}>{t('nf_health_state_not_configured')}</span>;
  }
  return <span className={styles.badgeUnknown}>{t('nf_health_state_unknown')}</span>;
}

/* A matrix cell renders the measured state and keeps the evidence one hover
 * away. not_configured stays neutral: an interface that was never declared is
 * not a failure. */
function matrixCell(cell: InterfaceCell, t: (key: string) => string): React.ReactElement {
  const detail = [
    cell.httpStatus ? `HTTP ${cell.httpStatus}` : null,
    cell.responseMs != null ? `${cell.responseMs} ms` : null,
    cell.reason ?? null,
    cell.measuredAt ? formatTimestamp(cell.measuredAt) : null,
  ]
    .filter(Boolean)
    .join(' - ');
  const badge = layerBadge(cell.state, t, styles);
  return detail ? <span title={detail}>{badge}</span> : badge;
}

/* Coverage is a measurement fact, not a health verdict: an established
 * measurement keeps the neutral evidence tone, an attempted-but-absent
 * measurement says unknown, and a layer with no exporter says not configured. */
function coverageBadge(
  available: boolean,
  measured: boolean,
  t: (key: string) => string,
  stylesRecord: Record<string, string>,
  labelPrefix?: string,
): React.ReactElement {
  const state: LayerState | 'measured' = !available ? 'not_configured' : measured ? 'measured' : 'unknown';
  return layerBadge(state, t, stylesRecord, labelPrefix);
}

function layerBadge(
  state: LayerState | 'measured',
  t: (key: string) => string,
  stylesRecord: Record<string, string>,
  labelPrefix?: string,
): React.ReactElement {
  const className =
    state === 'measured'
      ? stylesRecord.badgeMeasured
      : state === 'healthy'
        ? stylesRecord.badgeHealthy
        : state === 'degraded'
          ? stylesRecord.badgeDegraded
          : state === 'unhealthy'
            ? stylesRecord.badgeUnhealthy
            : state === 'not_configured'
              ? stylesRecord.badgeNotConfigured
              : state === 'stale'
                ? stylesRecord.badgeStale
                : stylesRecord.badgeUnknown;

  const labelKey =
    state === 'measured'
      ? 'nf_health_layer_measured'
      : state === 'healthy' || state === 'degraded' || state === 'unhealthy' ||
          state === 'stale' || state === 'not_configured'
        ? `nf_health_state_${state}`
        : 'nf_health_state_unknown';

  return <span className={className}>{labelPrefix ? `${labelPrefix} · ${t(labelKey)}` : t(labelKey)}</span>;
}

function UtilizationBar({
  label,
  available,
  percent,
}: {
  label: string;
  available: boolean;
  percent: number | null;
}): React.ReactElement {
  const { t } = useI18n();
  if (!available || percent == null || !Number.isFinite(percent)) {
    return (
      <div className={styles.utilRow}>
        <span className={styles.utilLabel}>{label}</span>
        <span className={styles.utilValue}>{t('ops_metric_unavailable')}</span>
      </div>
    );
  }
  const clamped = Math.max(0, Math.min(100, percent));
  const tone = clamped >= 90 ? styles.utilBarDanger : clamped >= 75 ? styles.utilBarWarn : styles.utilBarOk;
  return (
    <div className={styles.utilRow}>
      <span className={styles.utilLabel}>{label}</span>
      <div
        className={styles.utilTrack}
        role="meter"
        aria-valuenow={Math.round(clamped)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <span className={`${styles.utilBar} ${tone}`} style={{ width: `${clamped}%` }} />
      </div>
      <span className={styles.utilValue}>{`${Math.round(clamped)}%`}</span>
    </div>
  );
}

function formatTimestamp(value?: string): string {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
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
