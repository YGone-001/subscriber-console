import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { BookOpen, ChevronRight, Plus, Search, Tag, X } from 'lucide-react';
import PageHeader from '../../components/ui/PageHeader';
import MetricStrip, { type MetricStripItem } from '../../components/ui/MetricStrip';
import { EmptyState, LoadingRows } from '../../components/ui/OperationFeedback';
import { useRead } from '../../lib/api/use-read';
import { useI18n } from '../../providers/I18nProvider';
import { useAuth } from '../../providers/AuthProvider';
import { hasPermission } from '../../lib/permissions';
import { buildEntriesPath, fetchKnowledgeMeta } from './knowledge-api';
import type { KnowledgeMeta, KnowledgeSummary } from './types';
import styles from '../../styles/modules/knowledge.module.css';

const PAGE_LIMIT = 20;

export function KnowledgePage() {
  const { t, formatDateTime } = useI18n();
  const { user } = useAuth();
  const canConfigure = hasPermission(user, 'core.configure');

  const [searchParams, setSearchParams] = useSearchParams();
  const q = searchParams.get('q') ?? '';
  const protocol = searchParams.get('protocol') ?? '';
  const tag = searchParams.get('tag') ?? '';
  const cursor = searchParams.get('cursor') ?? '';

  const [searchInput, setSearchInput] = useState(q);
  const [meta, setMeta] = useState<KnowledgeMeta | null>(null);
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);

  useEffect(() => {
    void fetchKnowledgeMeta().then(setMeta).catch(() => {});
  }, []);

  useEffect(() => {
    setSearchInput(q);
  }, [q]);

  const listPath = useMemo(
    () => buildEntriesPath({ q: q || undefined, protocol: protocol || undefined, tag: tag || undefined, cursor: cursor || undefined, limit: PAGE_LIMIT }),
    [q, protocol, tag, cursor],
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
    setParam({ q: value.trim(), protocol, tag });
  };

  const entries = data?.entries ?? [];
  const total = data?.total ?? 0;

  const kpi: MetricStripItem[] = [
    { key: 'total', icon: <BookOpen size={16} />, label: t('kb_kpi_total'), value: meta ? meta.total : (isLoading ? t('loading') : '—'), tone: 'primary' },
    { key: 'protocols', icon: <Tag size={16} />, label: t('kb_kpi_protocols'), value: meta ? meta.protocolCounts.length : '—', tone: 'muted' },
  ];

  const goPrev = () => {
    const prev = cursorHistory[cursorHistory.length - 1];
    const next = cursorHistory.slice(0, -1);
    setCursorHistory(next);
    const params = new URLSearchParams(searchParams);
    if (prev) params.set('cursor', prev);
    else params.delete('cursor');
    setSearchParams(params);
  };

  const goNext = () => {
    if (data?.page.nextCursor) {
      setCursorHistory((h) => [...h, cursor]);
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
          <Link to="/knowledge/new" className={styles.newButton}>
            <Plus size={15} /> {t('kb_new_entry')}
          </Link>
        ) : undefined}
      />

      <MetricStrip variant="cards" columns={2} className={styles.kpi} ariaLabel={t('kb_page_title')} items={kpi} />

      <section className={styles.panel} aria-labelledby="kb-list-title">
        <div className={styles.toolbar}>
          <div className={styles.search} role="search">
            <Search size={16} aria-hidden="true" />
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
            <button type="button" className={styles.searchButton} onClick={() => applySearch(searchInput)}>{t('search')}</button>
          </div>
          <label className={styles.filter}>
            <span>{t('kb_filter_protocol')}</span>
            <select value={protocol} onChange={(event) => setParam({ protocol: event.target.value, q, tag })}>
              <option value="">{t('kb_filter_all')}</option>
              {(meta?.protocols ?? []).map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
        </div>

        {meta && meta.topTags.length > 0 && (
          <div className={styles.tagStrip} role="list">
            {meta.topTags.map((item) => (
              <button
                key={item.tag}
                type="button"
                role="listitem"
                className={`${styles.tagChip} ${tag === item.tag ? styles.tagChipActive : ''}`}
                onClick={() => setParam({ tag: tag === item.tag ? '' : item.tag, q, protocol })}
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
          <EmptyState icon={<BookOpen size={40} />} title={t('kb_empty_title')} description={t('kb_empty_body')} />
        ) : (
          <ul className={styles.list}>
            {entries.map((entry) => (
              <li key={entry.id}>
                <Link to={`/knowledge/${entry.id}`} className={styles.row}>
                  <div className={styles.rowBadge}>{(entry.protocol || 'KB').slice(0, 3).toUpperCase()}</div>
                  <div className={styles.rowBody}>
                    <div className={styles.rowTitle}>
                      {entry.title}
                      <span className={styles.rowProtocol}>{entry.protocol || t('kb_protocol_general')}</span>
                    </div>
                    <p className={styles.rowPhenomenon}>{entry.phenomenon || t('kb_no_phenomenon')}</p>
                    {entry.tags.length > 0 && (
                      <div className={styles.rowTags}>
                        {entry.tags.slice(0, 4).map((t) => <span key={t}>{t}</span>)}
                      </div>
                    )}
                  </div>
                  <div className={styles.rowMeta}>
                    <span>{formatDateTime(entry.updatedAt)}</span>
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
