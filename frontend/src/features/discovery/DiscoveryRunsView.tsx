/*
 * Discovery runs view (view=runs).
 *
 * Scan history is a low-frequency audit surface. It keeps the bounded run list,
 * the optional source and status filters, and the cursor pager. A failed or
 * truncated run never rewrites previously observed candidates; this view only
 * reports what the backend recorded.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { History } from 'lucide-react';
import { EmptyState, LoadingRows } from '../../components/ui/OperationFeedback';
import { ErrorState } from '../../components/ui/StatePanel';
import { useI18n } from '../../providers/I18nProvider';
import { useRegisterOperationsRefresh } from '../operations/operations-refresh';
import { fetchDiscoveryRuns, fetchDiscoverySources } from './discovery-api';
import type { DiscoveryRun, DiscoveryRunStatus, DiscoverySource, PageInfo } from './discovery-types';
import { describeLoadError, formatTimestamp } from './discovery-view-model';
import styles from '../../styles/modules/discovery.module.css';

const PAGE_LIMIT = 20;
const SELECTOR_LIMIT = 200;
const RUN_STATUSES: DiscoveryRunStatus[] = ['running', 'success', 'partial', 'failed'];

type Props = {
  sourceId: string;
  onSourceIdChange: (value: string) => void;
  status: string;
  onStatusChange: (value: string) => void;
  onClearFilters: () => void;
  hasFilters: boolean;
  cursor: string | undefined;
  onCursorChange: (cursor: string | undefined) => void;
  reloadToken: number;
};

function runStatusLabel(status: string, t: (key: string) => string): string {
  switch (status) {
    case 'success':
      return t('discovery_run_success');
    case 'partial':
      return t('discovery_run_partial');
    case 'failed':
      return t('discovery_run_failed');
    case 'running':
      return t('discovery_run_running');
    default:
      return status;
  }
}

export function DiscoveryRunsView({
  sourceId,
  onSourceIdChange,
  status,
  onStatusChange,
  onClearFilters,
  hasFilters,
  cursor,
  onCursorChange,
  reloadToken,
}: Props) {
  const { t } = useI18n();
  const [sources, setSources] = useState<DiscoverySource[]>([]);
  const [runs, setRuns] = useState<DiscoveryRun[]>([]);
  const [page, setPage] = useState<PageInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  const queryKeyRef = useRef('');

  useEffect(() => {
    let cancelled = false;
    fetchDiscoverySources({ limit: SELECTOR_LIMIT })
      .then((res) => {
        if (!cancelled) setSources(res.sources ?? []);
      })
      .catch(() => {
        /* The source filter degrades to free text; the run list still loads. */
      });
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  const loadRuns = useCallback(
    async (activeCursor?: string) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetchDiscoveryRuns({
          sourceId: sourceId || undefined,
          status: (status as DiscoveryRunStatus | '') || undefined,
          cursor: activeCursor,
          limit: PAGE_LIMIT,
        });
        setRuns(res.runs ?? []);
        setPage(res.page ?? null);
      } catch (err) {
        setRuns([]);
        setPage(null);
        setError(describeLoadError(err, t));
      } finally {
        setLoading(false);
      }
    },
    [sourceId, status, t],
  );

  useEffect(() => {
    const queryKey = `${sourceId}|${status}`;
    if (queryKeyRef.current !== queryKey) {
      queryKeyRef.current = queryKey;
      setCursorHistory([]);
    }
    void loadRuns(cursor);
  }, [loadRuns, cursor, reloadToken]);

  useRegisterOperationsRefresh('discovery:runs', () => loadRuns(cursor));

  const pageIndex = cursorHistory.length + 1;

  const handleFirstPage = () => {
    setCursorHistory([]);
    onCursorChange(undefined);
  };

  const handlePrevPage = () => {
    if (cursorHistory.length === 0) return;
    const nextHistory = cursorHistory.slice(0, -1);
    setCursorHistory(nextHistory);
    const prevCursor = nextHistory.length > 0 ? nextHistory[nextHistory.length - 1] : undefined;
    onCursorChange(prevCursor);
  };

  const handleNextPage = () => {
    const nextCursor = page?.nextCursor;
    if (!nextCursor || !page?.hasMore) return;
    setCursorHistory((history) => [...history, nextCursor]);
    onCursorChange(nextCursor);
  };

  return (
    <section className="dash-card" aria-label="discovery-runs-view" data-discovery-view="runs">
      <div className={styles.toolbar}>
        <div className={styles.filterGroup}>
          <label className={styles.selectorLabel} htmlFor="discovery-runs-source">
            {t('discovery_col_source')}
          </label>
          <select
            id="discovery-runs-source"
            className="form-input"
            value={sourceId}
            onChange={(event) => onSourceIdChange(event.target.value)}
          >
            <option value="">{t('discovery_source_selector_all')}</option>
            {sources.map((source) => (
              <option key={source.sourceId} value={source.sourceId}>
                {source.name}
              </option>
            ))}
          </select>
          <select
            className="form-input"
            aria-label={t('discovery_runs_filter_status')}
            value={status}
            onChange={(event) => onStatusChange(event.target.value)}
          >
            <option value="">{t('discovery_runs_all_statuses')}</option>
            {RUN_STATUSES.map((value) => (
              <option key={value} value={value}>
                {runStatusLabel(value, t)}
              </option>
            ))}
          </select>
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

      <div className={styles.sectionHead}>
        <h2>
          <History size={16} aria-hidden="true" />
          {t('discovery_runs_section')}
        </h2>
        <span className={styles.sectionNote}>{t('discovery_runs_note')}</span>
      </div>

      {error ? (
        <div className={styles.errorWrap}>
          <ErrorState
            title={t('error')}
            message={error}
            retryLabel={t('retry')}
            onRetry={() => void loadRuns(cursor)}
          />
        </div>
      ) : loading && runs.length === 0 ? (
        <LoadingRows columns={7} rows={4} />
      ) : runs.length === 0 ? (
        <div className={styles.stateWrap}>
          <EmptyState
            icon={<History size={44} />}
            title={t('discovery_empty_runs_title')}
            description={t('discovery_empty_runs_body')}
          />
        </div>
      ) : (
        <div className={styles.tableScroll}>
          <table className={styles.table}>
            <caption className="sr-only">{t('discovery_runs_caption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('discovery_col_source')}</th>
                <th scope="col">{t('discovery_col_started')}</th>
                <th scope="col">{t('discovery_col_run_status')}</th>
                <th scope="col">{t('discovery_col_discovered')}</th>
                <th scope="col">{t('discovery_col_created')}</th>
                <th scope="col">{t('discovery_col_updated')}</th>
                <th scope="col">{t('discovery_col_missing')}</th>
                <th scope="col">{t('discovery_col_error')}</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.runId}>
                  <td>
                    <code className={styles.uuid}>{run.sourceId}</code>
                  </td>
                  <td>{formatTimestamp(run.startedAt)}</td>
                  <td>
                    <span
                      className={
                        run.status === 'success'
                          ? styles.badgeOk
                          : run.status === 'failed'
                            ? styles.badgeDanger
                            : run.status === 'partial'
                              ? styles.badgeWarn
                              : styles.badgeMuted
                      }
                    >
                      {runStatusLabel(run.status, t)}
                    </span>
                  </td>
                  <td>{run.discoveredCount}</td>
                  <td>{run.createdCount}</td>
                  <td>{run.updatedCount}</td>
                  <td>{run.missingCount}</td>
                  <td>
                    {run.errorSummary ? (
                      <span className={styles.runError} title={run.errorSummary}>
                        {run.errorSummary}
                      </span>
                    ) : (
                      '-'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!error && (runs.length > 0 || page?.hasMore) ? (
        <nav className={styles.pager} aria-label={t('discovery_runs_section')}>
          <span className={styles.pagerSummary} aria-live="polite">
            {t('discovery_pager_runs', { count: runs.length })}
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
              disabled={!page?.hasMore || !page?.nextCursor || loading}
            >
              {t('ops_pager_next')}
            </button>
          </div>
        </nav>
      ) : null}
    </section>
  );
}

export default DiscoveryRunsView;
