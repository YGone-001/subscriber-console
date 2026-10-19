/*
 * NF Discovery list route.
 *
 * Surfaces the read-only observation plane: configured sources, bounded scan
 * history, and NF candidates. Observation state is rendered separately from
 * registry status and never collapsed into an operational health flag.
 * Link and unlink only write discovery metadata; Inventory stays authoritative.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Boxes,
  Link2,
  Link2Off,
  Plus,
  Radar,
  Search,
  Server,
  ShieldCheck,
  X,
} from 'lucide-react';
import { hasPermission } from '../../lib/permissions';
import { EmptyState, LoadingRows, OperationFeedback } from '../../components/ui/OperationFeedback';
import { ErrorState } from '../../components/ui/StatePanel';
import { Dialog } from '../../components/ui/Dialog';
import { Field } from '../../components/ui/Field';
import { OperationsPageFrame } from '../operations/OperationsPageFrame';
import { useOperationsUrlState } from '../operations/use-operations-url-state';
import {
  discoveryKpisFromSummary,
  fetchOperationsSummary,
  type DiscoverySummarySection,
} from '../operations/operations-summary';
import { SkeletonKpiStrip } from '../../components/ui/LoadingSkeleton';
import { useAuth } from '../../providers/AuthProvider';
import { useI18n } from '../../providers/I18nProvider';
import { MutationApiError } from '../../lib/api/mutation-client';
import {
  createDiscoverySource,
  fetchDiscoveryCandidates,
  fetchDiscoveryMeta,
  fetchDiscoverySources,
  linkDiscoveryCandidate,
  scanDiscoverySource,
  unlinkDiscoveryCandidate,
} from './discovery-api';
import { buildLinkCandidateRequest, buildUnlinkCandidateRequest } from './discovery-builders';
import { RuntimeBootstrapDialog } from '../runtime/RuntimeBootstrapDialog';
import {
  fetchRuntimeObservations,
} from '../runtime/runtime-api';
import type { RuntimeComponent } from '../runtime/runtime-types';
import { resolveRuntimeObservations, useRuntimeStream } from '../runtime/use-runtime-stream';
import {
  buildCreateSourceRequest,
  CANONICAL_ADAPTER_TYPES,
  CANONICAL_TRANSPORT_MODES,
} from './discovery-validation';
import type {
  DiscoveryAdapterType,
  DiscoveryMetaResponse,
  DiscoverySource,
  DiscoveryTransportMode,
  NfObservation,
  PageInfo,
} from './discovery-types';
import styles from '../../styles/modules/discovery.module.css';

const PAGE_LIMIT = 20;

type Feedback = { tone: 'success' | 'danger' | 'warning' | 'info'; message: string } | null;

export function DiscoveryPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const navigate = useNavigate();

  const canRead = hasPermission(user, 'core.read');
  const canConfigure = hasPermission(user, 'core.configure');

  const [meta, setMeta] = useState<DiscoveryMetaResponse | null>(null);
  const [sources, setSources] = useState<DiscoverySource[]>([]);
  const [candidates, setCandidates] = useState<NfObservation[]>([]);
  const [loading, setLoading] = useState(true);
  const [sourcesError, setSourcesError] = useState<string | null>(null);
  const [candidatesError, setCandidatesError] = useState<string | null>(null);
  const [sourcesPage, setSourcesPage] = useState<PageInfo | null>(null);
  const [candidatesPage, setCandidatesPage] = useState<PageInfo | null>(null);
  const [sourcesCursorHistory, setSourcesCursorHistory] = useState<string[]>([]);
  const [candidatesCursorHistory, setCandidatesCursorHistory] = useState<string[]>([]);
  const [summary, setSummary] = useState<DiscoverySummarySection | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [busyCandidateId, setBusyCandidateId] = useState<string | null>(null);
  const [scanningSourceId, setScanningSourceId] = useState<string | null>(null);

  /* UX-1: the source query, the candidate filters and the candidate cursor live
   * in the URL. The source list keeps its own session cursor until UX-4 splits
   * the two lists into exclusive views. */
  const url = useOperationsUrlState({ keys: ['q', 'state', 'nfType'] });
  const searchQuery = url.filters.q ?? '';
  const observationFilter = url.filters.state ?? '';
  const nfTypeFilter = url.filters.nfType ?? '';
  const [searchInput, setSearchInput] = useState(searchQuery);

  // Keep the visible query in step with the URL (back/forward, shared link).
  useEffect(() => {
    setSearchInput(searchQuery);
  }, [searchQuery]);

  const [createOpen, setCreateOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [formName, setFormName] = useState('');
  const [formAdapter, setFormAdapter] = useState<DiscoveryAdapterType>('nrf');
  const [formBaseUrl, setFormBaseUrl] = useState('');
  const [formTransport, setFormTransport] = useState<DiscoveryTransportMode>('h2c');
  const [formEnabled, setFormEnabled] = useState(true);

  const [linkTarget, setLinkTarget] = useState<NfObservation | null>(null);
  const [linkResourceId, setLinkResourceId] = useState('');
  const [linkError, setLinkError] = useState<string | null>(null);

  // Runtime onboarding closure: candidates themselves are read-only
  // observations, but the local runtime plane can map an observed NF type to
  // recognized local components. The bootstrap dialog is the only write path
  // and stays governed (preview -> apply); this page never writes discovery
  // or inventory data itself.
  const [runtimeComponents, setRuntimeComponents] = useState<RuntimeComponent[]>([]);
  const [bootstrapTarget, setBootstrapTarget] = useState<{ template: string; componentIds: string[] } | null>(null);

  const runtimeStream = useRuntimeStream();

  useEffect(() => {
    if (!canRead) return;
    let cancelled = false;
    const loadRuntime = async () => {
      try {
        const observations = await fetchRuntimeObservations();
        if (!cancelled) setRuntimeComponents(observations.snapshot.components ?? []);
      } catch {
        // The runtime plane is optional context for onboarding; candidates
        // must render even when it is unavailable.
        if (!cancelled) setRuntimeComponents([]);
      }
    };
    void loadRuntime();
    return () => {
      cancelled = true;
    };
  }, [canRead]);

  // Server-recognized components indexed by canonical NF type. The live SSE
  // snapshot wins once the shared stream is connected; the one-shot fetch only
  // covers the gap while the stream is not connected.
  const runtimeObservations = resolveRuntimeObservations(runtimeStream, undefined);
  const effectiveRuntimeComponents = runtimeObservations?.snapshot.components ?? runtimeComponents;
  const runtimeByNfType = useMemo(() => {
    const index = new Map<string, RuntimeComponent[]>();
    for (const component of effectiveRuntimeComponents) {
      if (!component.nfType) continue;
      const list = index.get(component.nfType);
      if (list) list.push(component);
      else index.set(component.nfType, [component]);
    }
    return index;
  }, [effectiveRuntimeComponents]);

  const loadAll = useCallback(async (activeCursor?: string) => {
    setLoading(true);
    setSourcesError(null);
    setCandidatesError(null);
    setSummaryLoading(true);
    setSourcesCursorHistory([]);
    setCandidatesCursorHistory([]);
    // Section-split error boundaries: one failing list never blanks the
    // other, and a failed summary section only degrades the KPI strip to
    // explicit unavailable labels, never to page-scoped counts.
    const [metaRes, sourcesRes, candidatesRes, summaryRes] = await Promise.allSettled([
      fetchDiscoveryMeta(),
      fetchDiscoverySources({ q: searchQuery || undefined, limit: PAGE_LIMIT }),
      fetchDiscoveryCandidates({
        nfType: nfTypeFilter || undefined,
        observationState: (observationFilter as NfObservation['observationState'] | '') || undefined,
        cursor: activeCursor,
        limit: PAGE_LIMIT,
      }),
      fetchOperationsSummary(['discovery']),
    ]);
    setMeta(metaRes.status === 'fulfilled' ? metaRes.value : null);
    if (sourcesRes.status === 'fulfilled') {
      setSources(sourcesRes.value.sources ?? []);
      setSourcesPage(sourcesRes.value.page ?? null);
    } else {
      setSources([]);
      setSourcesPage(null);
      setSourcesError(describeLoadError(sourcesRes.reason, t));
    }
    if (candidatesRes.status === 'fulfilled') {
      setCandidates(candidatesRes.value.candidates ?? []);
      setCandidatesPage(candidatesRes.value.page ?? null);
    } else {
      setCandidates([]);
      setCandidatesPage(null);
      setCandidatesError(describeLoadError(candidatesRes.reason, t));
    }
    setSummary(summaryRes.status === 'fulfilled' ? (summaryRes.value.discovery ?? null) : null);
    setSummaryLoading(false);
    setLoading(false);
  }, [searchQuery, observationFilter, nfTypeFilter, t]);

  // Cursor pager loads refresh exactly one bounded list; the other list and
  // the full-collection summary stay untouched.
  const loadSourcesPage = useCallback(async (cursor: string | undefined) => {
    setLoading(true);
    setSourcesError(null);
    try {
      const res = await fetchDiscoverySources({ q: searchQuery || undefined, cursor, limit: PAGE_LIMIT });
      setSources(res.sources ?? []);
      setSourcesPage(res.page ?? null);
    } catch (err) {
      setSources([]);
      setSourcesPage(null);
      setSourcesError(describeLoadError(err, t));
    } finally {
      setLoading(false);
    }
  }, [searchQuery, t]);

  const loadCandidatesPage = useCallback(async (cursor: string | undefined) => {
    setLoading(true);
    setCandidatesError(null);
    try {
      const res = await fetchDiscoveryCandidates({
        nfType: nfTypeFilter || undefined,
        observationState: (observationFilter as NfObservation['observationState'] | '') || undefined,
        cursor,
        limit: PAGE_LIMIT,
      });
      setCandidates(res.candidates ?? []);
      setCandidatesPage(res.page ?? null);
    } catch (err) {
      setCandidates([]);
      setCandidatesPage(null);
      setCandidatesError(describeLoadError(err, t));
    } finally {
      setLoading(false);
    }
  }, [observationFilter, nfTypeFilter, t]);

  /* Deep links and browser back/forward load the candidate page named by the
   * URL cursor. A pager click already fetched that page and is skipped through
   * the ref, so a page step still revalidates only the bounded candidate list. */
  const internalCursorRef = useRef<string | undefined>(undefined);
  const internalCursorNavigationRef = useRef(false);
  useEffect(() => {
    if (!canRead) {
      setLoading(false);
      setSummaryLoading(false);
      setSourcesError(t('discovery_err_forbidden'));
      setCandidatesError(t('discovery_err_forbidden'));
      return;
    }
    if (internalCursorNavigationRef.current && url.cursor === internalCursorRef.current) {
      internalCursorNavigationRef.current = false;
      return;
    }
    void loadAll(url.cursor);
  }, [canRead, loadAll, url.cursor]);

  const handleSourcesFirstPage = () => {
    setSourcesCursorHistory([]);
    void loadSourcesPage(undefined);
  };

  const handleSourcesPrevPage = () => {
    if (sourcesCursorHistory.length === 0) return;
    const nextHistory = sourcesCursorHistory.slice(0, -1);
    setSourcesCursorHistory(nextHistory);
    const prevCursor = nextHistory.length > 0 ? nextHistory[nextHistory.length - 1] : undefined;
    void loadSourcesPage(prevCursor);
  };

  const handleSourcesNextPage = () => {
    const nextCursor = sourcesPage?.nextCursor;
    if (!nextCursor || !sourcesPage?.hasMore) return;
    setSourcesCursorHistory((history) => [...history, nextCursor]);
    void loadSourcesPage(nextCursor);
  };

  const handleCandidatesFirstPage = () => {
    setCandidatesCursorHistory([]);
    internalCursorRef.current = undefined;
    internalCursorNavigationRef.current = url.cursor !== undefined;
    url.setCursor(undefined);
    void loadCandidatesPage(undefined);
  };

  const handleCandidatesPrevPage = () => {
    if (candidatesCursorHistory.length === 0) return;
    const nextHistory = candidatesCursorHistory.slice(0, -1);
    setCandidatesCursorHistory(nextHistory);
    const prevCursor = nextHistory.length > 0 ? nextHistory[nextHistory.length - 1] : undefined;
    internalCursorRef.current = prevCursor;
    internalCursorNavigationRef.current = url.cursor !== prevCursor;
    url.setCursor(prevCursor);
    void loadCandidatesPage(prevCursor);
  };

  const handleCandidatesNextPage = () => {
    const nextCursor = candidatesPage?.nextCursor;
    if (!nextCursor || !candidatesPage?.hasMore) return;
    setCandidatesCursorHistory((history) => [...history, nextCursor]);
    internalCursorRef.current = nextCursor;
    internalCursorNavigationRef.current = url.cursor !== nextCursor;
    url.setCursor(nextCursor);
    void loadCandidatesPage(nextCursor);
  };

  const sourcesPageIndex = sourcesCursorHistory.length + 1;
  const candidatesPageIndex = candidatesCursorHistory.length + 1;

  const handleSearchSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const next = searchInput.trim();
    if (next === searchQuery) {
      void loadAll(url.cursor);
      return;
    }
    url.setFilter('q', next);
  };

  const handleCreate = async () => {
    setFormError(null);
    setSubmitting(true);
    try {
      const payload = buildCreateSourceRequest({
        name: formName,
        adapterType: formAdapter,
        baseUrl: formBaseUrl,
        transportMode: formTransport,
        enabled: formEnabled,
      });
      await createDiscoverySource(payload);
      setCreateOpen(false);
      setFormName('');
      setFormBaseUrl('');
      setFormEnabled(true);
      setFeedback({ tone: 'success', message: t('discovery_feedback_created') });
      await loadAll(url.cursor);
    } catch (err) {
      setFormError(describeMutationError(err, t));
    } finally {
      setSubmitting(false);
    }
  };

  const handleScan = async (source: DiscoverySource) => {
    setScanningSourceId(source.sourceId);
    setFeedback(null);
    try {
      const result = await scanDiscoverySource(source.sourceId);
      const run = result.run;
      if (run.status === 'success') {
        setFeedback({ tone: 'success', message: t('discovery_feedback_scan_ok', { count: run.discoveredCount }) });
      } else if (run.status === 'partial') {
        setFeedback({ tone: 'warning', message: t('discovery_feedback_scan_partial') });
      } else {
        setFeedback({
          tone: 'danger',
          message: run.errorSummary || t('discovery_feedback_scan_failed'),
        });
      }
      await loadAll(url.cursor);
    } catch (err) {
      setFeedback({ tone: 'danger', message: describeMutationError(err, t) });
    } finally {
      setScanningSourceId(null);
    }
  };

  const handleLink = async () => {
    if (!linkTarget) return;
    setBusyCandidateId(linkTarget.candidateId);
    setLinkError(null);
    setFeedback(null);
    try {
      const payload = buildLinkCandidateRequest(linkTarget, linkResourceId);
      await linkDiscoveryCandidate(linkTarget.candidateId, payload);
      setLinkTarget(null);
      setLinkResourceId('');
      setFeedback({ tone: 'success', message: t('discovery_feedback_linked') });
      await loadAll(url.cursor);
    } catch (err) {
      setLinkError(describeMutationError(err, t));
    } finally {
      setBusyCandidateId(null);
    }
  };

  const handleUnlink = async (candidate: NfObservation) => {
    setBusyCandidateId(candidate.candidateId);
    setFeedback(null);
    try {
      const payload = buildUnlinkCandidateRequest(candidate);
      await unlinkDiscoveryCandidate(candidate.candidateId, payload);
      setFeedback({ tone: 'success', message: t('discovery_feedback_unlinked') });
      await loadAll(url.cursor);
    } catch (err) {
      setFeedback({ tone: 'danger', message: describeMutationError(err, t) });
    } finally {
      setBusyCandidateId(null);
    }
  };

  // KPIs come from the full-collection summary section, never from the
  // current page arrays. A page-scoped count must never be presented as a
  // platform total (UX-0 scope/completeness contract).
  const kpis = useMemo(() => discoveryKpisFromSummary(summary ?? undefined), [summary]);

  const observationLabel = (state: string) => {
    switch (state) {
      case 'seen':
        return t('discovery_state_seen');
      case 'missing':
        return t('discovery_state_missing');
      case 'stale':
        return t('discovery_state_stale');
      default:
        return state;
    }
  };

  return (
    <OperationsPageFrame
      title={t('discovery_title')}
      description={t('discovery_description')}
      icon={<Radar size={23} />}
      onRefresh={() => loadAll(url.cursor)}
      actions={
        canConfigure ? (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              setFormError(null);
              setCreateOpen(true);
            }}
          >
            <Plus size={16} />
            {t('discovery_create_source')}
          </button>
        ) : undefined
      }
    >

      {feedback ? (
        <OperationFeedback
          tone={feedback.tone}
          title={t('discovery_operation_result')}
          message={feedback.message}
          onDismiss={() => setFeedback(null)}
        />
      ) : null}

      {summaryLoading && kpis.sources === null ? (
        <SkeletonKpiStrip count={4} />
      ) : (
        <section className={styles.kpiStrip} aria-label={t('discovery_kpi_label')}>
          <article className={styles.kpiCard}>
            <span className={styles.kpiLabel}>{t('discovery_kpi_sources')}</span>
            <strong className={styles.kpiValue}>{kpis.sources ?? '-'}</strong>
            <span className={styles.kpiMeta}>
              {kpis.sources === null ? (
                <span className={styles.kpiUnavailable}>{t('ops_kpi_unavailable')}</span>
              ) : (
                <span className={styles.kpiScope} title={t('ops_kpi_scope_note')}>{t('ops_kpi_scope_full_collection')}</span>
              )}
            </span>
          </article>
          <article className={styles.kpiCard}>
            <span className={styles.kpiLabel}>{t('discovery_kpi_seen')}</span>
            <strong className={styles.kpiValue}>{kpis.seen ?? '-'}</strong>
            <span className={styles.kpiMeta}>
              {kpis.seen === null ? (
                <span className={styles.kpiUnavailable}>{t('ops_kpi_unavailable')}</span>
              ) : (
                <span className={styles.kpiScope} title={t('ops_kpi_scope_note')}>{t('ops_kpi_scope_full_collection')}</span>
              )}
            </span>
          </article>
          <article className={styles.kpiCard}>
            <span className={styles.kpiLabel}>{t('discovery_kpi_missing')}</span>
            <strong className={styles.kpiValue}>{kpis.missing ?? '-'}</strong>
            <span className={styles.kpiMeta}>
              {kpis.missing === null ? (
                <span className={styles.kpiUnavailable}>{t('ops_kpi_unavailable')}</span>
              ) : (
                <span className={styles.kpiScope} title={t('ops_kpi_scope_note')}>{t('ops_kpi_scope_full_collection')}</span>
              )}
            </span>
          </article>
          <article className={styles.kpiCard}>
            <span className={styles.kpiLabel}>{t('discovery_kpi_linked')}</span>
            <strong className={styles.kpiValue}>{kpis.linked ?? '-'}</strong>
            <span className={styles.kpiMeta}>
              {kpis.linked === null ? (
                <span className={styles.kpiUnavailable}>{t('ops_kpi_unavailable')}</span>
              ) : (
                <span className={styles.kpiScope} title={t('ops_kpi_scope_note')}>{t('ops_kpi_scope_full_collection')}</span>
              )}
            </span>
          </article>
        </section>
      )}

      <section className="dash-card">
        <div className={styles.toolbar}>
          <form className={styles.search} onSubmit={handleSearchSubmit} role="search">
            <Search size={16} className={styles.searchIcon} aria-hidden="true" />
            <input
              type="search"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder={t('discovery_search_placeholder')}
              aria-label={t('discovery_search_placeholder')}
            />
            <button type="submit" className="btn btn-secondary">
              {t('search')}
            </button>
          </form>
          <div className={styles.filterGroup}>
            <select
              className="form-input"
              aria-label={t('discovery_filter_observation')}
              value={observationFilter}
              onChange={(event) => url.setFilter('state', event.target.value)}
            >
              <option value="">{t('discovery_filter_all_states')}</option>
              {(meta?.observationStates ?? ['seen', 'missing', 'stale']).map((value) => (
                <option key={value} value={value}>
                  {observationLabel(value)}
                </option>
              ))}
            </select>
            <input
              className="form-input"
              type="text"
              aria-label={t('discovery_filter_nf_type')}
              placeholder={t('discovery_filter_nf_type')}
              value={nfTypeFilter}
              onChange={(event) => url.setFilter('nfType', event.target.value)}
            />
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setSearchInput('');
                url.clearFilters();
              }}
              disabled={loading}
            >
              <X size={14} aria-hidden="true" />
              {t('discovery_clear_filters')}
            </button>
          </div>
        </div>

        <div className={styles.sectionHead}>
          <h2>
            <Server size={16} aria-hidden="true" />
            {t('discovery_sources_section')}
          </h2>
          <span className={styles.sectionNote}>{t('discovery_sources_note')}</span>
        </div>

        {sourcesError ? (
          <div className={styles.errorWrap}>
            <ErrorState title={t('error')} message={sourcesError} retryLabel={t('retry')} onRetry={() => void loadAll(url.cursor)} />
          </div>
        ) : loading && sources.length === 0 ? (
          <LoadingRows columns={6} rows={4} />
        ) : sources.length === 0 ? (
          <div className={styles.stateWrap}>
            <EmptyState
              icon={<Server size={44} />}
              title={t('discovery_empty_sources_title')}
              description={t('discovery_empty_sources_body')}
              action={
                canConfigure ? (
                  <button type="button" className="btn btn-primary" onClick={() => setCreateOpen(true)}>
                    <Plus size={16} />
                    {t('discovery_create_source')}
                  </button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <caption className="sr-only">{t('discovery_sources_caption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('discovery_col_name')}</th>
                  <th scope="col">{t('discovery_col_adapter')}</th>
                  <th scope="col">{t('discovery_col_base_url')}</th>
                  <th scope="col">{t('discovery_col_enabled')}</th>
                  <th scope="col">{t('discovery_col_last_scan')}</th>
                  <th scope="col">{t('discovery_col_actions')}</th>
                </tr>
              </thead>
              <tbody>
                {sources.map((source) => (
                  <tr key={source.sourceId}>
                    <td>
                      <Link to={`/discovery/sources/${encodeURIComponent(source.sourceId)}`} className={styles.rowLink}>
                        {source.name}
                      </Link>
                    </td>
                    <td><code className={styles.chip}>{source.adapterType}</code></td>
                    <td><code className={styles.uuid}>{source.baseUrl}</code></td>
                    <td>
                      <span className={source.enabled ? styles.badgeOk : styles.badgeMuted}>
                        {source.enabled ? t('discovery_enabled') : t('discovery_disabled')}
                      </span>
                    </td>
                    <td>{source.lastScanAt ? formatTimestamp(source.lastScanAt) : '-'}</td>
                    <td>
                      <div className={styles.rowActions}>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={() => void handleScan(source)}
                          disabled={!canConfigure || !source.enabled || scanningSourceId === source.sourceId}
                          title={t('discovery_scan_action')}
                        >
                          <Radar size={14} />
                          {scanningSourceId === source.sourceId ? t('discovery_scanning') : t('discovery_scan_action')}
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={() => navigate(`/discovery/sources/${encodeURIComponent(source.sourceId)}`)}
                        >
                          {t('discovery_open_detail')}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {sourcesError ? null : sources.length > 0 || sourcesPage?.hasMore ? (
          <nav className={styles.pager} aria-label={t('discovery_sources_section')}>
            <span className={styles.pagerSummary} aria-live="polite">
              {t('discovery_pager_sources', { count: sources.length })}
            </span>
            <div className={styles.pagerControls}>
              <button
                type="button"
                onClick={handleSourcesFirstPage}
                disabled={sourcesPageIndex === 1 || loading}
              >
                {t('ops_pager_first')}
              </button>
              <button
                type="button"
                onClick={handleSourcesPrevPage}
                disabled={sourcesPageIndex === 1 || loading}
              >
                {t('ops_pager_prev')}
              </button>
              <span className={styles.pageNumber}>{t('ops_pager_page', { page: sourcesPageIndex })}</span>
              <button
                type="button"
                onClick={handleSourcesNextPage}
                disabled={!sourcesPage?.hasMore || !sourcesPage?.nextCursor || loading}
              >
                {t('ops_pager_next')}
              </button>
            </div>
          </nav>
        ) : null}
      </section>

      <section className="dash-card">
        <div className={styles.sectionHead}>
          <h2>
            <Boxes size={16} aria-hidden="true" />
            {t('discovery_candidates_section')}
          </h2>
          <span className={styles.sectionNote}>{t('discovery_candidates_note')}</span>
        </div>

        {candidatesError ? (
          <div className={styles.errorWrap}>
            <ErrorState title={t('error')} message={candidatesError} retryLabel={t('retry')} onRetry={() => void loadAll(url.cursor)} />
          </div>
        ) : loading && candidates.length === 0 ? (
          <LoadingRows columns={7} rows={4} />
        ) : candidates.length === 0 ? (
          <div className={styles.stateWrap}>
            <EmptyState
              icon={<Boxes size={44} />}
              title={t('discovery_empty_candidates_title')}
              description={t('discovery_empty_candidates_body')}
            />
          </div>
        ) : (
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <caption className="sr-only">{t('discovery_candidates_caption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('discovery_col_nf_type')}</th>
                  <th scope="col">{t('discovery_col_instance')}</th>
                  <th scope="col">{t('discovery_col_registry_status')}</th>
                  <th scope="col">{t('discovery_col_observation')}</th>
                  <th scope="col">{t('discovery_col_link')}</th>
                  <th scope="col">{t('discovery_col_actions')}</th>
                </tr>
              </thead>
              <tbody>
                {candidates.map((candidate) => {
                  const matchedRuntimeComponents = runtimeByNfType.get(candidate.nfType) ?? [];
                  return (
                  <tr key={candidate.candidateId}>
                    <td><strong>{candidate.nfType}</strong></td>
                    <td>
                      <div className={styles.stack}>
                        <code className={styles.uuid}>{candidate.externalNfInstanceId}</code>
                        {candidate.ipv4Addresses?.length ? (
                          <small>{candidate.ipv4Addresses.join(', ')}</small>
                        ) : null}
                      </div>
                    </td>
                    <td><code className={styles.chip}>{candidate.nfStatus}</code></td>
                    <td>
                      <span className={stateBadgeClass(candidate.observationState, styles)}>
                        {observationLabel(candidate.observationState)}
                      </span>
                    </td>
                    <td>
                      {candidate.linkedResourceId ? (
                        <Link
                          to={`/inventory/${encodeURIComponent(candidate.linkedResourceId)}`}
                          className={styles.rowLink}
                        >
                          <Link2 size={14} aria-hidden="true" />
                          {shortId(candidate.linkedResourceId)}
                        </Link>
                      ) : (
                        <span className={styles.badgeMuted}>{t('discovery_unlinked')}</span>
                      )}
                    </td>
                    <td>
                      <div className={styles.rowActions}>
                        {candidate.linkedResourceId ? (
                          <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={() => void handleUnlink(candidate)}
                            disabled={!canConfigure || busyCandidateId === candidate.candidateId}
                          >
                            <Link2Off size={14} />
                            {t('discovery_unlink_action')}
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-primary"
                            onClick={() => {
                              setLinkError(null);
                              setLinkResourceId('');
                              setLinkTarget(candidate);
                            }}
                            disabled={!canConfigure || busyCandidateId === candidate.candidateId}
                          >
                            <Link2 size={14} />
                            {t('discovery_link_action')}
                          </button>
                        )}
                        {matchedRuntimeComponents.length > 0 ? (
                          <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={() => {
                              setBootstrapTarget({
                                template: 'auto',
                                componentIds: matchedRuntimeComponents.map((component) => component.componentId),
                              });
                            }}
                            disabled={!canConfigure}
                            title={t('discovery_bootstrap_hint', {
                              count: matchedRuntimeComponents.length,
                              nfType: candidate.nfType,
                            })}
                          >
                            <ShieldCheck size={14} />
                            {t('discovery_bootstrap_action')}
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {candidatesError ? null : candidates.length > 0 || candidatesPage?.hasMore ? (
          <nav className={styles.pager} aria-label={t('discovery_candidates_section')}>
            <span className={styles.pagerSummary} aria-live="polite">
              {t('discovery_pager_candidates', { count: candidates.length })}
            </span>
            <div className={styles.pagerControls}>
              <button
                type="button"
                onClick={handleCandidatesFirstPage}
                disabled={candidatesPageIndex === 1 || loading}
              >
                {t('ops_pager_first')}
              </button>
              <button
                type="button"
                onClick={handleCandidatesPrevPage}
                disabled={candidatesPageIndex === 1 || loading}
              >
                {t('ops_pager_prev')}
              </button>
              <span className={styles.pageNumber}>{t('ops_pager_page', { page: candidatesPageIndex })}</span>
              <button
                type="button"
                onClick={handleCandidatesNextPage}
                disabled={!candidatesPage?.hasMore || !candidatesPage?.nextCursor || loading}
              >
                {t('ops_pager_next')}
              </button>
            </div>
          </nav>
        ) : null}
      </section>

      <Dialog
        open={linkTarget !== null}
        onClose={() => setLinkTarget(null)}
        overlayClassName={`modal-overlay ${styles.modalOverlay}`}
        className={`modal-content animate-fade-in ${styles.modalContent}`}
        labelledBy="discovery-link-title"
      >
        <div className={styles.modalHeader}>
          <h2 id="discovery-link-title">{t('discovery_link_title')}</h2>
        </div>
        <div className={styles.modalBody}>
          <p className={styles.modalIntro}>{t('discovery_link_intro')}</p>
          {linkTarget ? (
            <dl className={styles.identityReadonly}>
              <div>
                <dt>{t('discovery_col_nf_type')}</dt>
                <dd>{linkTarget.nfType}</dd>
              </div>
              <div>
                <dt>{t('discovery_col_instance')}</dt>
                <dd><code className={styles.uuid}>{linkTarget.externalNfInstanceId}</code></dd>
              </div>
            </dl>
          ) : null}
          <Field
            htmlFor="discovery-link-resource"
            label={t('discovery_link_resource')}
            description={t('discovery_link_resource_hint')}
            error={linkError ?? undefined}
          >
            <input
              id="discovery-link-resource"
              className="form-input"
              value={linkResourceId}
              onChange={(event) => setLinkResourceId(event.target.value)}
              disabled={busyCandidateId !== null}
              placeholder="00000000-0000-4000-8000-000000000000"
            />
          </Field>
          <div className={styles.formActions}>
            <button type="button" className="btn btn-secondary" onClick={() => setLinkTarget(null)} disabled={busyCandidateId !== null}>
              {t('cancel')}
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void handleLink()} disabled={busyCandidateId !== null}>
              {busyCandidateId !== null ? t('discovery_submitting') : t('discovery_link_confirm')}
            </button>
          </div>
        </div>
      </Dialog>

      <Dialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        overlayClassName={`modal-overlay ${styles.modalOverlay}`}
        className={`modal-content animate-fade-in ${styles.modalContent}`}
        labelledBy="discovery-create-title"
      >
        <div className={styles.modalHeader}>
          <h2 id="discovery-create-title">{t('discovery_create_source')}</h2>
        </div>
        <div className={styles.modalBody}>
          <p className={styles.modalIntro}>{t('discovery_create_intro')}</p>
          <Field htmlFor="discovery-name" label={t('discovery_field_name')}>
            <input
              id="discovery-name"
              className="form-input"
              value={formName}
              onChange={(event) => setFormName(event.target.value)}
              disabled={submitting}
            />
          </Field>
          <Field htmlFor="discovery-adapter" label={t('discovery_field_adapter')}>
            <select
              id="discovery-adapter"
              className="form-input"
              value={formAdapter}
              onChange={(event) => setFormAdapter(event.target.value as DiscoveryAdapterType)}
              disabled={submitting}
            >
              {CANONICAL_ADAPTER_TYPES.map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </select>
          </Field>
          <Field htmlFor="discovery-base-url" label={t('discovery_field_base_url')} description={t('discovery_field_base_url_hint')}>
            <input
              id="discovery-base-url"
              className="form-input"
              value={formBaseUrl}
              onChange={(event) => setFormBaseUrl(event.target.value)}
              disabled={submitting}
              placeholder="http://127.0.0.10:7777"
            />
          </Field>
          <Field htmlFor="discovery-transport" label={t('discovery_field_transport')}>
            <select
              id="discovery-transport"
              className="form-input"
              value={formTransport}
              onChange={(event) => setFormTransport(event.target.value as DiscoveryTransportMode)}
              disabled={submitting}
            >
              {CANONICAL_TRANSPORT_MODES.map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </select>
          </Field>
          <Field htmlFor="discovery-enabled" label={t('discovery_field_enabled')}>
            <input
              id="discovery-enabled"
              type="checkbox"
              checked={formEnabled}
              onChange={(event) => setFormEnabled(event.target.checked)}
              disabled={submitting}
            />
          </Field>
          {formError ? <p className={styles.formError} role="alert">{formError}</p> : null}
          <div className={styles.formActions}>
            <button type="button" className="btn btn-secondary" onClick={() => setCreateOpen(false)} disabled={submitting}>
              {t('cancel')}
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void handleCreate()} disabled={submitting}>
              {submitting ? t('discovery_submitting') : t('discovery_create_confirm')}
            </button>
          </div>
        </div>
      </Dialog>

      {bootstrapTarget ? (
        <RuntimeBootstrapDialog
          template={bootstrapTarget.template}
          componentIds={bootstrapTarget.componentIds}
          onClose={() => setBootstrapTarget(null)}
          onApplied={() => {
            setFeedback({ tone: 'success', message: t('discovery_bootstrap_applied') });
            // Refresh candidates so newly onboarded resources can be linked.
            void loadAll(url.cursor);
          }}
        />
      ) : null}
    </OperationsPageFrame>
  );
}

function stateBadgeClass(state: string, styles: Record<string, string>): string {
  if (state === 'seen') return styles.badgeOk;
  if (state === 'missing') return styles.badgeDanger;
  return styles.badgeWarn;
}

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}...` : value;
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
  return err instanceof Error && err.message ? err.message : t('discovery_err_load');
}

function describeMutationError(
  err: unknown,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  if (err instanceof Error && err.message && !err.message.startsWith('{')) {
    if (err.message.startsWith('discovery_validation_')) {
      return t(err.message);
    }
  }
  if (err instanceof MutationApiError) {
    switch (err.code) {
      case 'DISCOVERY_TARGET_NOT_ALLOWED':
        return t('discovery_err_not_allowed');
      case 'DISCOVERY_SOURCE_DISABLED':
        return t('discovery_err_disabled');
      case 'DISCOVERY_SCAN_IN_PROGRESS':
        return t('discovery_err_scan_in_progress');
      case 'DISCOVERY_SCAN_RATE_LIMITED':
        return t('discovery_err_scan_rate_limited');
      case 'DISCOVERY_REVISION_CONFLICT':
        return t('discovery_err_revision_conflict');
      case 'DISCOVERY_INVENTORY_LINK_CONFLICT':
        return t('discovery_err_link_conflict');
      case 'DISCOVERY_SOURCE_NOT_FOUND':
        return t('discovery_err_source_missing');
      case 'DISCOVERY_CANDIDATE_NOT_FOUND':
        return t('discovery_err_candidate_missing');
      default:
        return err.message || t('discovery_err_mutation');
    }
  }
  return err instanceof Error && err.message ? err.message : t('discovery_err_mutation');
}
