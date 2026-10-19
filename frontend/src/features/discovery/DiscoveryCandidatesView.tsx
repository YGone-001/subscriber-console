/*
 * Discovery candidates view (view=candidates, the default).
 *
 * Processing observed candidates is the daily task, so this view owns the first
 * screen of /discovery. It renders the observation -> link -> monitoring funnel
 * as three independent columns, keeps the NRF registry status verbatim, and
 * never folds either into an operational health flag.
 *
 * Section-split integrity:
 *   - the bounded source selector failure never blanks the candidate list;
 *   - the candidate read failure never blanks the selector;
 *   - the runtime plane is not read here at all, so its unavailability cannot
 *     affect this view.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Boxes } from 'lucide-react';
import { EmptyState, LoadingRows } from '../../components/ui/OperationFeedback';
import { ErrorState } from '../../components/ui/StatePanel';
import { useI18n } from '../../providers/I18nProvider';
import { useRegisterOperationsRefresh } from '../operations/operations-refresh';
import { fetchDiscoveryCandidates, fetchDiscoveryMeta, fetchDiscoverySources } from './discovery-api';
import {
  canAdvance,
  firstScroll,
  nextScroll,
  pageIndexFor,
  previousScroll,
} from './discovery-pager';
import type { DiscoverySource, NfObservation, PageInfo } from './discovery-types';
import {
  describeLoadError,
  monitoringBadgeClass,
  monitoringLabel,
  observationLabel,
  observationStateBadgeClass,
  shortId,
} from './discovery-view-model';
import styles from '../../styles/modules/discovery.module.css';

const PAGE_LIMIT = 20;
/* The selector is a bounded full read: one page sized to the repository limit,
 * with an explicit note when more sources exist than the page can show. */
const SELECTOR_LIMIT = 200;

export type DiscoveryCandidatesFilters = {
  sourceId: string;
  state: string;
  nfType: string;
};

type Props = {
  filters: DiscoveryCandidatesFilters;
  onFilterChange: (key: keyof DiscoveryCandidatesFilters, value: string) => void;
  onClearFilters: () => void;
  hasFilters: boolean;
  cursor: string | undefined;
  onCursorChange: (cursor: string | undefined) => void;
  onOpenCandidate: (candidate: NfObservation) => void;
  reloadToken: number;
};

export function DiscoveryCandidatesView({
  filters,
  onFilterChange,
  onClearFilters,
  hasFilters,
  cursor,
  onCursorChange,
  onOpenCandidate,
  reloadToken,
}: Props) {
  const { t } = useI18n();

  const [observationStates, setObservationStates] = useState<string[]>(['seen', 'missing', 'stale']);
  const [candidates, setCandidates] = useState<NfObservation[]>([]);
  const [page, setPage] = useState<PageInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectorSources, setSelectorSources] = useState<DiscoverySource[]>([]);
  const [selectorTruncated, setSelectorTruncated] = useState(false);
  const [selectorError, setSelectorError] = useState<string | null>(null);

  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  const queryKeyRef = useRef('');

  useEffect(() => {
    fetchDiscoveryMeta()
      .then((meta) => setObservationStates(meta.observationStates ?? ['seen', 'missing', 'stale']))
      .catch(() => {
        /* The raw state vocabulary remains usable as a fallback. */
      });
  }, []);

  const loadSelector = useCallback(async () => {
    try {
      const res = await fetchDiscoverySources({ limit: SELECTOR_LIMIT });
      setSelectorSources(res.sources ?? []);
      setSelectorTruncated(Boolean(res.page?.hasMore));
      setSelectorError(null);
    } catch (err) {
      // The selector is auxiliary context: its failure must never blank the
      // candidate queue below.
      setSelectorSources([]);
      setSelectorTruncated(false);
      setSelectorError(describeLoadError(err, t));
    }
  }, [t]);

  const loadCandidates = useCallback(
    async (activeCursor?: string) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetchDiscoveryCandidates({
          sourceId: filters.sourceId || undefined,
          nfType: filters.nfType || undefined,
          observationState: (filters.state as NfObservation['observationState'] | '') || undefined,
          cursor: activeCursor,
          limit: PAGE_LIMIT,
        });
        setCandidates(res.candidates ?? []);
        setPage(res.page ?? null);
      } catch (err) {
        setCandidates([]);
        setPage(null);
        setError(describeLoadError(err, t));
      } finally {
        setLoading(false);
      }
    },
    [filters.sourceId, filters.state, filters.nfType, t],
  );

  useEffect(() => {
    void loadSelector();
  }, [loadSelector, reloadToken]);

  useEffect(() => {
    const queryKey = `${filters.sourceId}|${filters.state}|${filters.nfType}`;
    if (queryKeyRef.current !== queryKey) {
      queryKeyRef.current = queryKey;
      setCursorHistory([]);
    }
    void loadCandidates(cursor);
  }, [loadCandidates, cursor, reloadToken]);

  useRegisterOperationsRefresh('discovery:candidates:selector', loadSelector);
  useRegisterOperationsRefresh('discovery:candidates', () => loadCandidates(cursor));

  const pageIndex = pageIndexFor(cursorHistory);

  const handleFirstPage = () => {
    const next = firstScroll();
    setCursorHistory(next.history);
    onCursorChange(next.cursor);
  };

  const handlePrevPage = () => {
    const next = previousScroll(cursorHistory);
    if (next.history.length === cursorHistory.length) return;
    setCursorHistory(next.history);
    onCursorChange(next.cursor);
  };

  const handleNextPage = () => {
    const next = nextScroll(cursorHistory, page);
    if (!next) return;
    setCursorHistory(next.history);
    onCursorChange(next.cursor);
  };

  return (
    <section className="dash-card" aria-label="discovery-candidates-view" data-discovery-view="candidates">
      <div className={styles.toolbar}>
        <div className={styles.filterGroup}>
          <label className={styles.selectorLabel} htmlFor="discovery-source-selector">
            {t('discovery_source_selector_label')}
          </label>
          <select
            id="discovery-source-selector"
            className="form-input"
            data-discovery-source-selector="true"
            value={filters.sourceId}
            onChange={(event) => onFilterChange('sourceId', event.target.value)}
          >
            <option value="">{t('discovery_source_selector_all')}</option>
            {selectorSources.map((source) => (
              <option key={source.sourceId} value={source.sourceId}>
                {source.name}
              </option>
            ))}
          </select>
          {selectorTruncated ? (
            <span className={styles.sectionNote}>
              {t('discovery_source_selector_bounded', { count: selectorSources.length })}
            </span>
          ) : null}
          {selectorError ? (
            <span className={styles.selectorError} role="status">
              {t('discovery_source_selector_error')}
            </span>
          ) : null}
        </div>
        <div className={styles.filterGroup}>
          <select
            className="form-input"
            aria-label={t('discovery_filter_observation')}
            value={filters.state}
            onChange={(event) => onFilterChange('state', event.target.value)}
          >
            <option value="">{t('discovery_filter_all_states')}</option>
            {observationStates.map((value) => (
              <option key={value} value={value}>
                {observationLabel(value, t)}
              </option>
            ))}
          </select>
          <input
            className="form-input"
            type="text"
            aria-label={t('discovery_filter_nf_type')}
            placeholder={t('discovery_filter_nf_type')}
            value={filters.nfType}
            onChange={(event) => onFilterChange('nfType', event.target.value)}
          />
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onClearFilters}
            disabled={!hasFilters}
          >
            {t('discovery_clear_filters')}
          </button>
        </div>
      </div>

      {error ? (
        <div className={styles.errorWrap}>
          <ErrorState
            title={t('error')}
            message={error}
            retryLabel={t('retry')}
            onRetry={() => void loadCandidates(cursor)}
          />
        </div>
      ) : loading && candidates.length === 0 ? (
        <LoadingRows columns={6} rows={4} />
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
                <th scope="col">{t('discovery_col_observed')}</th>
                <th scope="col">{t('discovery_col_linked')}</th>
                <th scope="col">{t('discovery_col_monitored')}</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((candidate) => (
                <tr key={candidate.candidateId}>
                  <td>
                    <button
                      type="button"
                      className={styles.rowButton}
                      onClick={() => onOpenCandidate(candidate)}
                    >
                      <strong>{candidate.nfType}</strong>
                    </button>
                  </td>
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
                    <span className={observationStateBadgeClass(candidate.observationState, styles)}>
                      {observationLabel(candidate.observationState, t)}
                    </span>
                  </td>
                  <td>
                    {candidate.linkedResourceId ? (
                      <span className={styles.linkedId} title={candidate.linkedResourceId}>
                        {shortId(candidate.linkedResourceId)}
                      </span>
                    ) : (
                      <span className={styles.badgeMuted}>{t('discovery_unlinked')}</span>
                    )}
                  </td>
                  <td>
                    <span className={monitoringBadgeClass(candidate, styles)}>
                      {monitoringLabel(candidate, t)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!error && (candidates.length > 0 || page?.hasMore) ? (
        <nav className={styles.pager} aria-label={t('discovery_candidates_section')}>
          <span className={styles.pagerSummary} aria-live="polite">
            {t('discovery_pager_candidates', { count: candidates.length })}
          </span>
          <div className={styles.pagerControls}>
            <button type="button" onClick={handleFirstPage} disabled={pageIndex === 1 || loading}>
              {t('ops_pager_first')}
            </button>
            <button type="button" onClick={handlePrevPage} disabled={pageIndex === 1 || loading}>
              {t('ops_pager_prev')}
            </button>
            <span className={styles.pageNumber}>{t('ops_pager_page', { page: pageIndex })}</span>
            <button
              type="button"
              onClick={handleNextPage}
              disabled={!canAdvance(page) || loading}
            >
              {t('ops_pager_next')}
            </button>
          </div>
        </nav>
      ) : null}

      <p className={styles.funnelNote}>{t('discovery_funnel_note')}</p>
    </section>
  );
}

export default DiscoveryCandidatesView;
