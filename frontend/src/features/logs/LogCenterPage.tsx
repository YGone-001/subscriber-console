/*
 * Log workspace (/logs).
 *
 * One source, one bounded stream, one filter bar. The page never accepts a file
 * path: it picks from the registry the server built, and it renders the
 * vocabulary the server declared (levels, tail ceiling, line ceiling).
 *
 * Visible state is part of the contract: connection status, reconnects, lines
 * the server dropped, lines discarded while paused, and the exact filter scope
 * are all on screen, because a silent log view is worse than no log view.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Pause, Play, RefreshCw, ScrollText, Search, Trash2, X } from 'lucide-react';
import { PageHeader } from '../../components/ui/PageHeader';
import { EmptyState } from '../../components/ui/OperationFeedback';
import { ErrorState } from '../../components/ui/StatePanel';
import { useI18n } from '../../providers/I18nProvider';
import { useOperationsUrlState } from '../operations/use-operations-url-state';
import { fetchLogSources } from './logs-api';
import { useLogStream } from './use-log-stream';
import {
  DEFAULT_TAIL_LINES,
  MAX_VIEW_LINES,
  type LogCapabilities,
  type LogSource,
} from './logs-types';
import styles from '../../styles/modules/logs.module.css';

const LOG_URL_KEYS = ['sourceId', 'level', 'keyword', 'tail', 'resourceId'] as const;
const TAIL_OPTIONS = [50, 100, 200, 500];
const STATUS_LABEL_KEY: Record<string, string> = {
  idle: 'logs_status_idle',
  connecting: 'logs_status_connecting',
  live: 'logs_status_live',
  reconnecting: 'logs_status_reconnecting',
  closed: 'logs_status_closed',
  unavailable: 'logs_status_unavailable',
};

export function LogCenterPage() {
  const { t } = useI18n();
  const url = useOperationsUrlState({ keys: LOG_URL_KEYS });

  const resourceId = url.filters.resourceId ?? '';
  const sourceId = url.filters.sourceId ?? '';
  const level = url.filters.level ?? '';
  const keyword = url.filters.keyword ?? '';
  const requestedTail = Number(url.filters.tail ?? '');

  const [sources, setSources] = useState<LogSource[]>([]);
  const [capabilities, setCapabilities] = useState<LogCapabilities | null>(null);
  const [sourcesLoading, setSourcesLoading] = useState(true);
  const [sourcesError, setSourcesError] = useState<string | null>(null);

  const [keywordInput, setKeywordInput] = useState(keyword);
  const [autoScroll, setAutoScroll] = useState(true);
  const [paused, setPaused] = useState(false);

  const viewportRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setKeywordInput(keyword);
  }, [keyword]);

  const loadSources = useCallback(async () => {
    setSourcesLoading(true);
    setSourcesError(null);
    try {
      const response = await fetchLogSources(resourceId || undefined);
      setSources(response.sources ?? []);
      setCapabilities(response.capabilities ?? null);
    } catch (error) {
      setSources([]);
      setCapabilities(null);
      setSourcesError(error instanceof Error && error.message ? error.message : t('logs_err_sources'));
    } finally {
      setSourcesLoading(false);
    }
  }, [resourceId, t]);

  useEffect(() => {
    void loadSources();
  }, [loadSources]);

  /* A context link carries a resourceId. When exactly one source is bound to it
   * the page selects it; ambiguity is left to the operator. */
  useEffect(() => {
    if (sourceId || sourcesLoading || sources.length === 0) return;
    if (resourceId && sources.length === 1) {
      url.setFilter('sourceId', sources[0].sourceId);
    }
  }, [resourceId, sourceId, sources, sourcesLoading, url]);

  const tailLines = useMemo(() => {
    const fallback = capabilities?.defaultTailLines ?? DEFAULT_TAIL_LINES;
    const max = capabilities?.maxTailLines ?? 500;
    if (!Number.isFinite(requestedTail) || requestedTail <= 0) return fallback;
    return Math.min(requestedTail, max);
  }, [requestedTail, capabilities]);

  const selectedSource = useMemo(
    () => sources.find((source) => source.sourceId === sourceId) ?? null,
    [sources, sourceId],
  );

  const stream = useLogStream({
    sourceId,
    tailLines,
    level,
    keyword,
    follow: true,
    paused,
  });

  const totalLines = stream.lines.length;
  const bufferFull = totalLines >= MAX_VIEW_LINES;

  /* Auto-scroll only when the operator is already at the bottom; scrolling up
   * must not be undone by the next frame. */
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !autoScroll || paused) return;
    viewport.scrollTop = viewport.scrollHeight;
  }, [stream.lines, autoScroll, paused]);

  const handleScroll = () => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const distance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    const atBottom = distance < 48;
    if (!atBottom && autoScroll) setAutoScroll(false);
    if (atBottom && !autoScroll) setAutoScroll(true);
  };

  const handleKeywordSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    url.setFilter('keyword', keywordInput.trim());
  };

  const handleClearFilters = () => {
    setKeywordInput('');
    url.setFilters({ level: null, keyword: null, tail: null });
  };

  const handleResourceScopeClear = () => {
    url.setFilters({ resourceId: null, sourceId: null });
  };

  const filtersActive = Boolean(level || keyword);

  return (
    <div className={styles.page}>
      <PageHeader
        title={t('logs_title')}
        description={t('logs_description')}
        icon={<ScrollText size={23} />}
        actions={(
          <div className={styles.headerActions}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                setPaused(false);
                stream.reconnect();
              }}
              disabled={!sourceId}
            >
              <RefreshCw size={15} />
              {t('logs_reconnect')}
            </button>
          </div>
        )}
      />

      {resourceId ? (
        <div className={styles.scopeNote} role="status">
          <span>{t('logs_resource_scope', { count: sources.length })}</span>
          <button type="button" className="btn btn-ghost" onClick={handleResourceScopeClear}>
            <X size={14} aria-hidden="true" />
            {t('logs_clear_resource_scope')}
          </button>
        </div>
      ) : null}

      <section className={styles.workspace} aria-label={t('logs_workspace_label')}>
        <div className={styles.toolbar}>
          <div className={styles.controlGroup}>
            <label className={styles.controlLabel} htmlFor="logs-source">{t('logs_source_label')}</label>
            <select
              id="logs-source"
              className="form-input"
              data-logs-source="true"
              value={sourceId}
              onChange={(event) => url.setFilter('sourceId', event.target.value)}
              disabled={sourcesLoading || sources.length === 0}
            >
              <option value="">{t('logs_source_placeholder')}</option>
              {sources.map((source) => (
                <option key={source.sourceId} value={source.sourceId} disabled={!source.readable}>
                  {source.name}{source.readable ? '' : ` ${t('logs_source_unreadable')}`}
                </option>
              ))}
            </select>
          </div>

          <div className={styles.controlGroup}>
            <label className={styles.controlLabel} htmlFor="logs-level">{t('logs_level_label')}</label>
            <select
              id="logs-level"
              className="form-input"
              value={level}
              onChange={(event) => url.setFilter('level', event.target.value)}
            >
              <option value="">{t('logs_level_all')}</option>
              {(capabilities?.levels ?? ['debug', 'info', 'warn', 'error']).map((option) => (
                <option key={option} value={option}>{t(`logs_level_${option}`)}</option>
              ))}
            </select>
          </div>

          <form className={styles.search} onSubmit={handleKeywordSubmit} role="search">
            <Search size={15} className={styles.searchIcon} aria-hidden="true" />
            <input
              type="search"
              value={keywordInput}
              onChange={(event) => setKeywordInput(event.target.value)}
              placeholder={t('logs_keyword_placeholder')}
              aria-label={t('logs_keyword_placeholder')}
            />
            <button type="submit" className="btn btn-secondary">{t('search')}</button>
          </form>

          <div className={styles.controlGroup}>
            <label className={styles.controlLabel} htmlFor="logs-tail">{t('logs_tail_label')}</label>
            <select
              id="logs-tail"
              className="form-input"
              value={String(tailLines)}
              onChange={(event) => url.setFilter('tail', event.target.value)}
            >
              {TAIL_OPTIONS.map((option) => (
                <option key={option} value={String(option)}>{option}</option>
              ))}
            </select>
          </div>

          <div className={styles.controlGroup}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setPaused((value) => !value)}
              disabled={!sourceId}
              aria-pressed={paused}
            >
              {paused ? <Play size={14} /> : <Pause size={14} />}
              {paused ? t('logs_resume') : t('logs_pause')}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={stream.clear}
              disabled={!sourceId || totalLines === 0}
            >
              <Trash2 size={14} />
              {t('logs_clear_view')}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={handleClearFilters}
              disabled={!filtersActive}
            >
              <X size={14} aria-hidden="true" />
              {t('logs_clear_filters')}
            </button>
          </div>
        </div>

        <div className={styles.statusBar} role="status" aria-live="polite">
          <span className={`${styles.statusPill} ${statusTone(stream.status)}`} data-logs-status={stream.status}>
            {t(STATUS_LABEL_KEY[stream.status] ?? 'logs_status_idle')}
          </span>
          <span className={styles.statusMeta}>
            {selectedSource ? selectedSource.name : t('logs_no_source')}
          </span>
          <span className={styles.statusMeta}>{t('logs_filter_scope', {
            level: level ? t(`logs_level_${level}`) : t('logs_level_all'),
            keyword: keyword || t('logs_keyword_none'),
          })}</span>
          {stream.dropped > 0 ? (
            <span className={styles.statusWarn} data-logs-dropped={stream.dropped}>
              {t('logs_dropped', { count: stream.dropped })}
            </span>
          ) : null}
          {stream.discarded > 0 ? (
            <span className={styles.statusWarn} data-logs-discarded={stream.discarded}>
              {t('logs_discarded', { count: stream.discarded })}
            </span>
          ) : null}
          {paused ? <span className={styles.statusWarn}>{t('logs_paused_badge')}</span> : null}
          {bufferFull ? <span className={styles.statusMeta}>{t('logs_view_bounded', { count: MAX_VIEW_LINES })}</span> : null}
          {stream.notices.length > 0 ? (
            <span className={styles.statusWarn}>
              <AlertTriangle size={13} aria-hidden="true" /> {stream.notices[stream.notices.length - 1]}
            </span>
          ) : null}
        </div>

        {sourcesError ? (
          <div className={styles.stateWrap}>
            <ErrorState
              title={t('error')}
              message={sourcesError}
              retryLabel={t('retry')}
              onRetry={() => void loadSources()}
            />
          </div>
        ) : sourcesLoading ? (
          <div className={styles.stateWrap}><p className={styles.dim}>{t('logs_loading_sources')}</p></div>
        ) : sources.length === 0 ? (
          <div className={styles.stateWrap}>
            <EmptyState
              icon={<ScrollText size={44} />}
              title={t('logs_empty_sources_title')}
              description={resourceId ? t('logs_empty_sources_bound') : t('logs_empty_sources_body')}
            />
          </div>
        ) : !sourceId ? (
          <div className={styles.stateWrap}>
            <EmptyState
              icon={<ScrollText size={44} />}
              title={t('logs_pick_source_title')}
              description={t('logs_pick_source_body')}
            />
          </div>
        ) : (
          <div
            className={styles.viewport}
            ref={viewportRef}
            onScroll={handleScroll}
            data-logs-viewport="true"
          >
            {stream.lines.length === 0 ? (
              <p className={styles.dim}>{stream.status === 'live' ? t('logs_empty_lines') : t('logs_waiting')}</p>
            ) : (
              <ol className={styles.lines}>
                {stream.lines.map((line) => (
                  <li key={`${line.seq}-${line.text.slice(0, 24)}`} className={styles.line}>
                    <span className={styles.lineLevel} data-level={line.level}>
                      {line.level}
                    </span>
                    <span className={styles.lineText}>{line.text}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}

        {!autoScroll && sourceId ? (
          <button
            type="button"
            className={styles.jumpButton}
            onClick={() => {
              const viewport = viewportRef.current;
              if (viewport) viewport.scrollTop = viewport.scrollHeight;
              setAutoScroll(true);
            }}
          >
            {t('logs_jump_latest')}
          </button>
        ) : null}
      </section>
    </div>
  );
}

function statusTone(status: string): string {
  if (status === 'live') return styles.statusLive;
  if (status === 'reconnecting' || status === 'connecting') return styles.statusPending;
  if (status === 'unavailable' || status === 'closed') return styles.statusDown;
  return styles.statusIdle;
}

export default LogCenterPage;
