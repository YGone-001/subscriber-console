/*
 * Discovery sources view (view=sources).
 *
 * Source configuration is a low-frequency task, so it moved out of the default
 * screen into its own view. It keeps the bounded name search, the cursor pager
 * and the governed scan action; candidate processing lives in the candidates
 * view and scan history in the runs view.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Radar, Search, Server, X } from 'lucide-react';
import { EmptyState, LoadingRows } from '../../components/ui/OperationFeedback';
import { ErrorState } from '../../components/ui/StatePanel';
import { useI18n } from '../../providers/I18nProvider';
import { useRegisterOperationsRefresh } from '../operations/operations-refresh';
import { fetchDiscoverySources } from './discovery-api';
import type { DiscoverySource, PageInfo } from './discovery-types';
import { describeLoadError, formatTimestamp } from './discovery-view-model';
import styles from '../../styles/modules/discovery.module.css';

const PAGE_LIMIT = 20;

type Props = {
  query: string;
  onQuerySubmit: (value: string) => void;
  cursor: string | undefined;
  onCursorChange: (cursor: string | undefined) => void;
  canConfigure: boolean;
  onCreateSource: () => void;
  onScan: (source: DiscoverySource) => void;
  scanningSourceId: string | null;
  reloadToken: number;
};

export function DiscoverySourcesView({
  query,
  onQuerySubmit,
  cursor,
  onCursorChange,
  canConfigure,
  onCreateSource,
  onScan,
  scanningSourceId,
  reloadToken,
}: Props) {
  const { t } = useI18n();
  const [sources, setSources] = useState<DiscoverySource[]>([]);
  const [page, setPage] = useState<PageInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState(query);
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  const queryKeyRef = useRef('');

  // Keep the visible query in step with the URL (back/forward, shared link).
  useEffect(() => {
    setSearchInput(query);
  }, [query]);

  const loadSources = useCallback(
    async (activeCursor?: string) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetchDiscoverySources({
          q: query || undefined,
          cursor: activeCursor,
          limit: PAGE_LIMIT,
        });
        setSources(res.sources ?? []);
        setPage(res.page ?? null);
      } catch (err) {
        setSources([]);
        setPage(null);
        setError(describeLoadError(err, t));
      } finally {
        setLoading(false);
      }
    },
    [query, t],
  );

  useEffect(() => {
    if (queryKeyRef.current !== query) {
      queryKeyRef.current = query;
      setCursorHistory([]);
    }
    void loadSources(cursor);
  }, [loadSources, cursor, reloadToken]);

  useRegisterOperationsRefresh('discovery:sources', () => loadSources(cursor));

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

  const handleSearchSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const next = searchInput.trim();
    if (next === query) {
      void loadSources(cursor);
      return;
    }
    onQuerySubmit(next);
  };

  return (
    <section className="dash-card" aria-label="discovery-sources-view" data-discovery-view="sources">
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
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              setSearchInput('');
              onQuerySubmit('');
            }}
            disabled={!query}
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

      {error ? (
        <div className={styles.errorWrap}>
          <ErrorState
            title={t('error')}
            message={error}
            retryLabel={t('retry')}
            onRetry={() => void loadSources(cursor)}
          />
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
                <button type="button" className="btn btn-primary" onClick={onCreateSource}>
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
                  <td>{formatTimestamp(source.lastScanAt)}</td>
                  <td>
                    <div className={styles.rowActions}>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => onScan(source)}
                        disabled={!canConfigure || !source.enabled || scanningSourceId === source.sourceId}
                        title={t('discovery_scan_action')}
                      >
                        <Radar size={14} />
                        {scanningSourceId === source.sourceId ? t('discovery_scanning') : t('discovery_scan_action')}
                      </button>
                      <Link
                        className="btn btn-ghost"
                        to={`/discovery/sources/${encodeURIComponent(source.sourceId)}`}
                      >
                        {t('discovery_open_detail')}
                      </Link>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!error && (sources.length > 0 || page?.hasMore) ? (
        <nav className={styles.pager} aria-label={t('discovery_sources_section')}>
          <span className={styles.pagerSummary} aria-live="polite">
            {t('discovery_pager_sources', { count: sources.length })}
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

export default DiscoverySourcesView;
