import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { ArrowDown, ArrowUp, BookOpen, ChevronRight, Paperclip, Plus, Search, Tag, X } from 'lucide-react';
import PageHeader from '../../components/ui/PageHeader';
import MetricStrip, { type MetricStripItem } from '../../components/ui/MetricStrip';
import { EmptyState, LoadingRows } from '../../components/ui/OperationFeedback';
import { useRead } from '../../lib/api/use-read';
import { useI18n } from '../../providers/I18nProvider';
import { useAuth } from '../../providers/AuthProvider';
import { hasPermission } from '../../lib/permissions';
import { currentListLocation, withReturnTo } from '../../lib/return-to';
import { buildEntriesPath, fetchKnowledgeMeta } from './knowledge-api';
import { HighlightText } from './components/HighlightText';
import type { KnowledgeMeta, KnowledgeSummary } from './types';
import styles from '../../styles/modules/knowledge.module.css';

const PAGE_LIMIT = 20;
const DEFAULT_SORT = 'updatedAt';

function defaultOrder(sort: string): string {
  return sort === 'title' || sort === 'protocol' ? 'asc' : 'desc';
}

function readHistory(key: string): string[] {
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function writeHistory(key: string, history: string[]): void {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(history));
  } catch {
    /* sessionStorage may be unavailable (private mode); paging still works. */
  }
}

export function KnowledgePage() {
  const { t, formatDateTime, formatRelativeTime } = useI18n();
  const { user } = useAuth();
  const canConfigure = hasPermission(user, 'core.configure');

  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const listLocation = currentListLocation('/knowledge', location.search);
  const q = searchParams.get('q') ?? '';
  const protocol = searchParams.get('protocol') ?? '';
  const tag = searchParams.get('tag') ?? '';
  const cursor = searchParams.get('cursor') ?? '';
  const sort = searchParams.get('sort') || DEFAULT_SORT;
  const order = searchParams.get('order') || defaultOrder(sort);

  const [searchInput, setSearchInput] = useState(q);
  const [tagInput, setTagInput] = useState(tag);
  const [meta, setMeta] = useState<KnowledgeMeta | null>(null);

  // The cursor history is keyed by the active filter/sort signature so a refresh
  // restores the back-stack for the current view instead of losing it.
  const historyKey = `kb-history:${q}|${protocol}|${tag}|${sort}|${order}`;
  const [cursorHistory, setCursorHistory] = useState<string[]>(() => readHistory(historyKey));

  useEffect(() => {
    void fetchKnowledgeMeta().then(setMeta).catch(() => {});
  }, []);

  useEffect(() => {
    setSearchInput(q);
  }, [q]);

  useEffect(() => {
    setTagInput(tag);
  }, [tag]);

  useEffect(() => {
    setCursorHistory(readHistory(historyKey));
  }, [historyKey]);

  const listPath = useMemo(
    () => buildEntriesPath({
      q: q || undefined,
      protocol: protocol || undefined,
      tag: tag || undefined,
      cursor: cursor || undefined,
      limit: PAGE_LIMIT,
      sort,
      order,
    }),
    [q, protocol, tag, cursor, sort, order],
  );
  const { data, error, isLoading } = useRead<{ entries: KnowledgeSummary[]; total: number; page: { nextCursor: string | null; hasMore: boolean } }>(listPath);

  const setParam = (next: Record<string, string>) => {
    const params = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(next)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    params.delete('cursor');
    setCursorHistory([]);
    setSearchParams(params);
  };

  const applySearch = (value: string) => {
    setParam({ q: value.trim() });
  };

  const applyTag = (value: string) => {
    setParam({ tag: value.trim() });
  };

  const entries = data?.entries ?? [];
  const total = data?.total ?? 0;
  const hasFilters = Boolean(q || protocol || tag);

  const clearFilters = () => {
    setSearchInput('');
    setTagInput('');
    setCursorHistory([]);
    setSearchParams(new URLSearchParams());
  };

  const kpi: MetricStripItem[] = [
    { key: 'total', icon: <BookOpen size={16} />, label: t('kb_kpi_total'), value: meta ? meta.total : (isLoading ? t('loading') : '—'), tone: 'primary' },
    { key: 'protocols', icon: <Tag size={16} />, label: t('kb_kpi_protocols'), value: meta ? `${meta.protocolCounts.length}/${meta.protocols.length}` : '—', tone: 'muted' },
  ];

  const goPrev = () => {
    const prev = cursorHistory[cursorHistory.length - 1];
    const next = cursorHistory.slice(0, -1);
    setCursorHistory(next);
    writeHistory(historyKey, next);
    const params = new URLSearchParams(searchParams);
    if (prev) params.set('cursor', prev);
    else params.delete('cursor');
    setSearchParams(params);
  };

  const goNext = () => {
    if (data?.page.nextCursor) {
      const next = [...cursorHistory, cursor];
      setCursorHistory(next);
      writeHistory(historyKey, next);
      const params = new URLSearchParams(searchParams);
      params.set('cursor', data.page.nextCursor as string);
      setSearchParams(params);
    }
  };

  return (
    <div className="container animate-fade-in">
      <PageHeader
        eyebrow={t('kb_page_eyebrow')}
        icon={<BookOpen size={24} />}
        title={t('kb_page_title')}
        description={t('kb_page_description')}
        actions={canConfigure ? (
          <Link to={withReturnTo('/knowledge/new', listLocation)} className={styles.newButton}>
            <Plus size={15} /> {t('kb_new_entry')}
          </Link>
        ) : undefined}
      />

      <MetricStrip variant="strip" className={styles.kpi} ariaLabel={t('kb_page_title')} items={kpi} />

      <section className={styles.panel} aria-labelledby="kb-list-title">
        <div className={styles.toolbar}>
          <div className={styles.search} role="search">
            <Search size={16} aria-hidden="true" />
            <div className={styles.searchField}>
              <input
              type="search"
              value={searchInput}
              placeholder={t('kb_search_placeholder')}
              aria-label={t('kb_search_placeholder')}
              onChange={(event) => setSearchInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') applySearch(searchInput);
              }}
            />
            {q && (
              <button type="button" className={styles.searchClear} aria-label={t('kb_clear_search')} onClick={() => applySearch('')}>
                <X size={15} />
              </button>
              )}
            </div>
            <button type="button" className={styles.searchButton} onClick={() => applySearch(searchInput)}>{t('kb_search_action')}</button>
          </div>
          <label className={styles.filter}>
            <span>{t('kb_filter_protocol')}</span>
            <select value={protocol} onChange={(event) => setParam({ protocol: event.target.value })}>
              <option value="">{t('kb_filter_all')}</option>
              {(meta?.protocols ?? []).map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
          <label className={styles.filter}>
            <span>{t('kb_filter_tag')}</span>
            <input
              type="text"
              value={tagInput}
              placeholder={t('kb_filter_tag_placeholder')}
              aria-label={t('kb_filter_tag')}
              onChange={(event) => setTagInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') applyTag(tagInput);
              }}
              onBlur={() => { if (tagInput.trim() !== tag) applyTag(tagInput); }}
            />
          </label>
          <label className={styles.filter}>
            <span>{t('kb_sort_label')}</span>
            <select value={sort} onChange={(event) => setParam({ sort: event.target.value, order: '' })}>
              <option value="updatedAt">{t('kb_sort_updated')}</option>
              <option value="createdAt">{t('kb_sort_created')}</option>
              <option value="title">{t('kb_sort_title')}</option>
              <option value="protocol">{t('kb_sort_protocol')}</option>
            </select>
          </label>
          <button
            type="button"
            className={styles.orderToggle}
            title={order === 'asc' ? t('kb_order_asc') : t('kb_order_desc')}
            aria-label={t('kb_order_toggle')}
            onClick={() => setParam({ order: order === 'asc' ? 'desc' : 'asc' })}
          >
            {order === 'asc' ? <ArrowUp size={15} /> : <ArrowDown size={15} />}
          </button>
        </div>

        {meta && meta.topTags.length > 0 && (
          <div className={styles.tagStrip} role="list">
            {meta.topTags.map((item) => (
              <button
                key={item.tag}
                type="button"
                role="listitem"
                className={`${styles.tagChip} ${tag === item.tag ? styles.tagChipActive : ''}`}
                onClick={() => setParam({ tag: tag === item.tag ? '' : item.tag })}
              >
                {item.tag} <span>{item.count}</span>
              </button>
            ))}
          </div>
        )}

        <div className={styles.panelHead}>
          <h2 id="kb-list-title" className={styles.sectionTitle}>{t('kb_list_title')}</h2>
          <span className={styles.panelMeta}>{t('kb_result_count', { total })}</span>
        </div>

        {isLoading && !data ? (
          <LoadingRows rows={5} />
        ) : error && !data ? (
          <EmptyState icon={<BookOpen size={40} />} title={t('kb_error_title')} description={t('kb_error_body')} />
        ) : entries.length === 0 ? (
          <EmptyState
            icon={hasFilters ? <Search size={40} /> : <BookOpen size={40} />}
            title={hasFilters ? t('kb_no_match_title') : t('kb_empty_title')}
            description={hasFilters ? t('kb_no_match_body') : t('kb_empty_body')}
            action={hasFilters ? (
              <button type="button" className={styles.searchButton} onClick={clearFilters}>
                {t('kb_clear_filters')}
              </button>
            ) : undefined}
          />
        ) : (
          <ul className={styles.list}>
            {entries.map((entry) => (
              <li key={entry.id}>
                <Link to={withReturnTo(`/knowledge/${entry.id}`, listLocation)} className={styles.row}>
                  <div className={styles.rowBadge} aria-hidden="true"><BookOpen size={16} /></div>
                  <div className={styles.rowBody}>
                    <div className={styles.rowTitle}>
                      <span className={styles.rowTitleText}><HighlightText text={entry.title} query={q} /></span>
                      <span className={styles.rowProtocol}>{entry.protocol || t('kb_protocol_general')}</span>
                    </div>
                    <p className={styles.rowPhenomenon}><HighlightText text={entry.phenomenon || t('kb_no_phenomenon')} query={q} /></p>
                    {entry.tags.length > 0 && (
                      <div className={styles.rowTags}>
                        {entry.tags.slice(0, 4).map((tag) => <span key={tag}>{tag}</span>)}
                      </div>
                    )}
                  </div>
                  <div className={styles.rowMeta}>
                    {entry.attachmentCount > 0 && (
                      <span className={styles.rowAttach} title={t('kb_attachments_count', { count: entry.attachmentCount })}>
                        <Paperclip size={13} /> {entry.attachmentCount}
                      </span>
                    )}
                    <span title={formatDateTime(entry.updatedAt)}>{formatRelativeTime(entry.updatedAt)}</span>
                    <ChevronRight size={16} />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}

        {total > 0 && (
          <div className={styles.pager}>
            <span className={styles.pagerInfo}>{t('kb_page_info', { total })}</span>
            <div className={styles.pagerActions}>
              <button type="button" onClick={goPrev} disabled={cursorHistory.length === 0}>{t('previous')}</button>
              <button type="button" onClick={goNext} disabled={!data?.page.hasMore}>{t('next')}</button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}