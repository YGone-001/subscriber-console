import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { useSWRConfig } from 'swr';
import { ArrowDown, ArrowUp, BookOpen, ChevronRight, Download, Paperclip, Plus, RotateCcw, Search, Tag, Trash2, X } from 'lucide-react';
import PageHeader from '../../components/ui/PageHeader';
import MetricStrip, { type MetricStripItem } from '../../components/ui/MetricStrip';
import { ConfirmActionPanel, EmptyState, LoadingRows, OperationNotice } from '../../components/ui/OperationFeedback';
import { ViewSwitch } from '../../components/ui/ViewSwitch';
import { useRead } from '../../lib/api/use-read';
import { useI18n } from '../../providers/I18nProvider';
import { useAuth } from '../../providers/AuthProvider';
import { hasPermission } from '../../lib/permissions';
import { currentListLocation, withReturnTo } from '../../lib/return-to';
import { buildEntriesPath, deleteEntry, fetchEntry, restoreEntry, updateEntry } from './knowledge-api';
import { knowledgeReadErrorMessage } from './knowledge-errors';
import { runWithConcurrency } from './knowledge-batch';
import { mergeTags, splitTagInput } from './knowledge-tags';
import { matchContext } from './knowledge-match';
import { pageNumberFromStack, parseCursorStack, popCursorStack, pushCursorStack, serializeCursorStack } from './knowledge-paging';
import { HighlightText } from './components/HighlightText';
import type { KnowledgeMeta, KnowledgeSummary } from './types';
import styles from '../../styles/modules/knowledge.module.css';

const PAGE_LIMIT = 20;
const DEFAULT_SORT = 'updatedAt';

type ListResponse = {
  entries: KnowledgeSummary[];
  total: number;
  page: { nextCursor: string | null; hasMore: boolean };
};

function defaultOrder(sort: string): string {
  return sort === 'title' || sort === 'protocol' ? 'asc' : 'desc';
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
  const cursorStack = parseCursorStack(searchParams.get('stack'));
  const sort = searchParams.get('sort') || DEFAULT_SORT;
  const order = searchParams.get('order') || defaultOrder(sort);
  const status = searchParams.get('status') === 'deleted' ? 'deleted' : 'active';
  const view = searchParams.get('view') === 'table' ? 'table' : 'list';

  const [searchInput, setSearchInput] = useState(q);
  const [tagInput, setTagInput] = useState(tag);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchAction, setBatchAction] = useState<'delete' | 'restore' | null>(null);
  const [batchWorking, setBatchWorking] = useState(false);
  const [batchTagOpen, setBatchTagOpen] = useState(false);
  const [batchTagInput, setBatchTagInput] = useState('');
  const [batchTagWorking, setBatchTagWorking] = useState(false);
  const [batchNotice, setBatchNotice] = useState<string | null>(null);
  const [batchError, setBatchError] = useState<string | null>(null);

  const { data: meta } = useRead<KnowledgeMeta>('/api/knowledge/meta');
  const { data: tagDictionary } = useRead<{ tags: Array<{ tag: string; count: number }> }>('/api/knowledge/tags');
  const { mutate: mutateCache } = useSWRConfig();

  useEffect(() => {
    setSearchInput(q);
  }, [q]);

  useEffect(() => {
    setTagInput(tag);
  }, [tag]);

  const listPath = useMemo(
    () => buildEntriesPath({
      q: q || undefined,
      protocol: protocol || undefined,
      tag: tag || undefined,
      cursor: cursor || undefined,
      limit: PAGE_LIMIT,
      sort,
      order,
      status: status === 'deleted' ? 'deleted' : undefined,
    }),
    [q, protocol, tag, cursor, sort, order, status],
  );
  const { data, error, isLoading, mutate: refreshList } = useRead<ListResponse>(listPath);

  useEffect(() => {
    setSelected(new Set());
  }, [listPath]);

  const setParam = (next: Record<string, string>) => {
    const params = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(next)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    params.delete('cursor');
    params.delete('stack');
    setSearchParams(params);
  };

  const applySearch = (value: string) => {
    setParam({ q: value.trim() });
  };

  const applyTag = (value: string) => {
    setParam({ tag: value.trim() });
  };

  const setView = (next: 'list' | 'table') => {
    const params = new URLSearchParams(searchParams);
    if (next === 'table') params.set('view', 'table');
    else params.delete('view');
    setSearchParams(params);
  };

  const entries = data?.entries ?? [];
  const total = data?.total ?? 0;
  const hasFilters = Boolean(q || protocol || tag);
  const pageNumber = pageNumberFromStack(cursorStack, Boolean(cursor));

  const clearFilters = () => {
    setSearchInput('');
    setTagInput('');
    const params = new URLSearchParams();
    if (status === 'deleted') params.set('status', 'deleted');
    if (view === 'table') params.set('view', 'table');
    setSearchParams(params);
  };

  const kpi: MetricStripItem[] = status === 'deleted'
    ? [
        {
          key: 'recycle',
          icon: <Trash2 size={16} />,
          label: t('kb_kpi_recycle_total'),
          value: meta && typeof meta.deletedTotal === 'number' ? meta.deletedTotal : '—',
          tone: 'muted',
        },
      ]
    : [
        { key: 'total', icon: <BookOpen size={16} />, label: t('kb_kpi_total'), value: meta ? meta.total : '—', tone: 'primary' },
        { key: 'protocols', icon: <Tag size={16} />, label: t('kb_kpi_protocols'), value: meta ? `${meta.protocolCounts.length}/${meta.protocols.length}` : '—', tone: 'muted' },
      ];

  const goPrev = () => {
    const prev = popCursorStack(cursorStack);
    const params = new URLSearchParams(searchParams);
    if (prev.cursor) params.set('cursor', prev.cursor);
    else params.delete('cursor');
    const stack = serializeCursorStack(prev.stack);
    if (stack) params.set('stack', stack);
    else params.delete('stack');
    setSearchParams(params);
  };

  const goNext = () => {
    const nextCursor = data?.page.nextCursor;
    if (!nextCursor) return;
    const params = new URLSearchParams(searchParams);
    const stack = serializeCursorStack(pushCursorStack(cursorStack, cursor));
    if (stack) params.set('stack', stack);
    else params.delete('stack');
    params.set('cursor', nextCursor);
    setSearchParams(params);
  };

  const allSelected = entries.length > 0 && entries.every((entry) => selected.has(entry.id));
  const selectedEntries = entries.filter((entry) => selected.has(entry.id));
  const selectedCount = selectedEntries.length;

  const toggleSelect = (id: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (allSelected) {
      setSelected(new Set());
      return;
    }
    setSelected(new Set(entries.map((entry) => entry.id)));
  };

  const finishBatch = async (ok: number, failed: number) => {
    setBatchWorking(false);
    setBatchAction(null);
    setSelected(new Set());
    try {
      await refreshList();
      await mutateCache('/api/knowledge/meta');
    } catch {
      /* The list still revalidates when it mounts. */
    }
    if (failed > 0) setBatchError(t('kb_batch_partial', { ok, failed }));
    else setBatchNotice(t('kb_batch_success', { count: ok }));
  };

  const runBatchDelete = async () => {
    const targets = selectedEntries;
    if (targets.length === 0) return;
    setBatchWorking(true);
    setBatchError(null);
    setBatchNotice(null);
    const permanent = status === 'deleted';
    const results = await runWithConcurrency(targets, 4, (entry) => deleteEntry(entry.id, entry.revision, permanent));
    const ok = results.filter((result) => result.status === 'fulfilled').length;
    await finishBatch(ok, results.length - ok);
  };

  const runBatchRestore = async () => {
    const targets = selectedEntries;
    if (targets.length === 0) return;
    setBatchWorking(true);
    setBatchError(null);
    setBatchNotice(null);
    const results = await runWithConcurrency(targets, 4, (entry) => restoreEntry(entry.id, entry.revision));
    const ok = results.filter((result) => result.status === 'fulfilled').length;
    await finishBatch(ok, results.length - ok);
  };

  const exportSelected = async () => {
    const targets = selectedEntries;
    if (targets.length === 0) return;
    setBatchWorking(true);
    setBatchError(null);
    setBatchNotice(null);
    const results = await runWithConcurrency(targets, 4, (entry) => fetchEntry(entry.id));
    const details = results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
    const failed = results.length - details.length;
    if (details.length > 0) {
      const payload = {
        exportedAt: new Date().toISOString(),
        count: details.length,
        entries: details,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `knowledge-export-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    }
    setBatchWorking(false);
    if (failed > 0) setBatchError(t('kb_batch_partial', { ok: details.length, failed }));
    else if (details.length > 0) setBatchNotice(t('kb_batch_exported', { count: details.length }));
    else setBatchError(t('kb_batch_export_failed'));
  };

  const runBatchTag = async () => {
    const additions = splitTagInput(batchTagInput);
    if (additions.length === 0) return;
    const targets = selectedEntries;
    if (targets.length === 0) return;
    setBatchTagWorking(true);
    setBatchError(null);
    setBatchNotice(null);
    const maxTags = meta?.maxTags ?? 20;
    const maxTagLength = meta?.maxTagLength ?? 32;
    const results = await runWithConcurrency(targets, 3, async (entry) => {
      const detail = await fetchEntry(entry.id);
      const merged = mergeTags(detail.tags, additions, maxTags, maxTagLength);
      const unchanged = merged.length === detail.tags.length
        && merged.every((value, index) => value === detail.tags[index]);
      if (unchanged) return detail;
      return updateEntry(entry.id, {
        title: detail.title,
        protocol: detail.protocol === 'General' ? undefined : detail.protocol,
        phenomenon: detail.phenomenon,
        rootCause: detail.rootCause,
        solution: detail.solution,
        tags: merged,
        attachmentFileIds: detail.attachments.map((file) => file.fileId),
        expectedRevision: detail.revision,
      });
    });
    const ok = results.filter((result) => result.status === 'fulfilled').length;
    const failed = results.length - ok;
    setBatchTagWorking(false);
    setBatchTagOpen(false);
    setBatchTagInput('');
    setSelected(new Set());
    try {
      await refreshList();
      await mutateCache('/api/knowledge/meta');
    } catch {
      /* The list still revalidates when it mounts. */
    }
    if (failed > 0) setBatchError(t('kb_batch_partial', { ok, failed }));
    else setBatchNotice(t('kb_batch_success', { count: ok }));
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

      {batchNotice && <OperationNotice tone="success" message={batchNotice} onClose={() => setBatchNotice(null)} />}
      {batchError && <OperationNotice tone="danger" message={batchError} onClose={() => setBatchError(null)} />}

      <section className={styles.panel} aria-labelledby="kb-list-title">
        <div className={styles.tabs} role="group" aria-label={t('kb_view_tabs')}>
          <button
            type="button"
            className={`${styles.tab} ${status === 'active' ? styles.tabActive : ''}`}
            aria-pressed={status === 'active'}
            onClick={() => setParam({ status: '' })}
          >
            <BookOpen size={15} /> {t('kb_tab_active')}
            <span className={styles.tabCount}>{meta ? meta.total : '—'}</span>
          </button>
          <button
            type="button"
            className={`${styles.tab} ${status === 'deleted' ? styles.tabActive : ''}`}
            aria-pressed={status === 'deleted'}
            onClick={() => setParam({ status: 'deleted' })}
          >
            <Trash2 size={15} /> {t('kb_tab_recycle')}
            <span className={styles.tabCount}>{meta && typeof meta.deletedTotal === 'number' ? meta.deletedTotal : '—'}</span>
          </button>
        </div>

        <div className={styles.toolbar}>
          <div className={styles.search} role="search">
            <Search size={16} aria-hidden="true" />
            <div className={styles.searchField}>
              <input
                type="search"
                value={searchInput}
                placeholder={t('kb_search_placeholder')}
                aria-label={t('kb_search_placeholder')}
                maxLength={64}
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
              list="kb-tag-dictionary"
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
        <datalist id="kb-tag-dictionary">
          {(tagDictionary?.tags ?? []).map((item) => (
            <option key={item.tag} value={item.tag}>{item.count}</option>
          ))}
        </datalist>

        <div className={styles.panelHead}>
          <h2 id="kb-list-title" className={styles.sectionTitle}>{t('kb_list_title')}</h2>
          <div className={styles.panelHeadActions}>
            <ViewSwitch
              options={[
                { value: 'list', label: t('kb_view_list') },
                { value: 'table', label: t('kb_view_table') },
              ]}
              value={view}
              onChange={setView}
              ariaLabel={t('kb_view_tabs')}
            />
            {view === 'list' && entries.length > 0 && (
              <label className={styles.selectAll}>
                <input
                  type="checkbox"
                  checked={allSelected}
                  disabled={batchWorking}
                  aria-label={t('kb_select_all')}
                  onChange={toggleAll}
                />
                <span>{t('kb_select_all')}</span>
              </label>
            )}
            <span className={styles.panelMeta}>{t('kb_result_count', { total })}</span>
          </div>
        </div>

        {selectedCount > 0 && (
          <div className={styles.batchBar} role="toolbar" aria-label={t('kb_batch_actions')}>
            <span className={styles.batchCount}>{t('kb_selected_count', { count: selectedCount })}</span>
            <button type="button" className={styles.batchButton} disabled={batchWorking} onClick={() => void exportSelected()}>
              <Download size={15} /> {t('kb_batch_export')}
            </button>
            <button type="button" className={styles.batchButton} disabled={batchWorking} onClick={() => setBatchAction('delete')}>
              <Trash2 size={15} /> {status === 'deleted' ? t('kb_permanent_delete') : t('kb_batch_delete')}
            </button>
            {status !== 'deleted' && (
              <button type="button" className={styles.batchButton} disabled={batchWorking || batchTagWorking} onClick={() => { setBatchTagInput(''); setBatchTagOpen(true); }}>
                <Tag size={15} /> {t('kb_batch_tag')}
              </button>
            )}
            {status === 'deleted' && (
              <button type="button" className={styles.batchButton} disabled={batchWorking} onClick={() => setBatchAction('restore')}>
                <RotateCcw size={15} /> {t('kb_batch_restore')}
              </button>
            )}
            <button type="button" className={styles.batchButton} disabled={batchWorking} onClick={() => setSelected(new Set())}>
              {t('kb_clear_selection')}
            </button>
          </div>
        )}

        {isLoading && !data ? (
          <LoadingRows rows={5} />
        ) : error && !data ? (
          <EmptyState
            icon={<BookOpen size={40} />}
            title={t('kb_error_title')}
            description={knowledgeReadErrorMessage(error, t, 'kb_error_body')}
            action={(
              <button type="button" className={styles.searchButton} onClick={() => void refreshList()}>
                {t('kb_retry')}
              </button>
            )}
          />
        ) : entries.length === 0 ? (
          <EmptyState
            icon={hasFilters ? <Search size={40} /> : status === 'deleted' ? <Trash2 size={40} /> : <BookOpen size={40} />}
            title={hasFilters ? t('kb_no_match_title') : status === 'deleted' ? t('kb_recycle_empty_title') : t('kb_empty_title')}
            description={hasFilters ? t('kb_no_match_body') : status === 'deleted' ? t('kb_recycle_empty_body') : t('kb_empty_body')}
            action={hasFilters ? (
              <button type="button" className={styles.searchButton} onClick={clearFilters}>
                {t('kb_clear_filters')}
              </button>
            ) : status === 'deleted' ? (
              <button type="button" className={styles.searchButton} onClick={() => setParam({ status: '' })}>
                {t('kb_back_to_active')}
              </button>
            ) : undefined}
          />
        ) : view === 'table' ? (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption className={styles.tableCaption}>{t('kb_list_title')}</caption>
              <thead>
                <tr>
                  <th scope="col" className={styles.tableSelect}>
                    <input
                      type="checkbox"
                      checked={allSelected}
                      disabled={batchWorking}
                      aria-label={t('kb_select_all')}
                      onChange={toggleAll}
                    />
                  </th>
                  <th scope="col">{t('kb_field_title')}</th>
                  <th scope="col" className={styles.tableOptional}>{t('kb_field_protocol')}</th>
                  <th scope="col" className={styles.tableOptional}>{t('kb_field_tags')}</th>
                  <th scope="col" className={styles.tableOptional}>{t('kb_attachments')}</th>
                  <th scope="col">{t('kb_sort_updated')}</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => {
                  const match = matchContext(entry, q);
                  const matchText = match?.field === 'tag'
                    ? t('kb_match_tag', { value: match.value })
                    : match?.field === 'protocol'
                      ? t('kb_match_protocol', { value: match.value })
                      : match?.field === 'body'
                        ? t('kb_match_body')
                        : '';
                  return (
                    <tr key={entry.id}>
                      <td className={styles.tableSelect}>
                        <input
                          type="checkbox"
                          checked={selected.has(entry.id)}
                          disabled={batchWorking}
                          aria-label={t('kb_select_entry', { title: entry.title })}
                          onChange={(event) => toggleSelect(entry.id, event.target.checked)}
                        />
                      </td>
                      <td>
                        <Link to={withReturnTo(`/knowledge/${entry.id}`, listLocation)} className={styles.tableTitleLink}>
                          <HighlightText text={entry.title} query={q} />
                        </Link>
                        {entry.status === 'deleted' && <span className={styles.rowStatus}>{t('kb_status_deleted')}</span>}
                        {matchText && <span className={styles.tableMatch}>{matchText}</span>}
                      </td>
                      <td className={styles.tableOptional}>{entry.protocol || t('kb_protocol_general')}</td>
                      <td className={styles.tableOptional}>
                        <div className={styles.rowTags}>
                          {entry.tags.slice(0, 4).map((value) => <span key={value}>{value}</span>)}
                        </div>
                      </td>
                      <td className={styles.tableOptional}>{entry.attachmentCount || '—'}</td>
                      <td>{formatDateTime(entry.deletedAt || entry.updatedAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <ul className={styles.list}>
            {entries.map((entry) => {
              const match = matchContext(entry, q);
              const matchText = match?.field === 'tag'
                ? t('kb_match_tag', { value: match.value })
                : match?.field === 'protocol'
                  ? t('kb_match_protocol', { value: match.value })
                  : match?.field === 'body'
                    ? t('kb_match_body')
                    : '';
              return (
                <li key={entry.id} className={styles.rowItem}>
                  <label className={styles.rowSelect}>
                    <input
                      type="checkbox"
                      checked={selected.has(entry.id)}
                      disabled={batchWorking}
                      aria-label={t('kb_select_entry', { title: entry.title })}
                      onChange={(event) => toggleSelect(entry.id, event.target.checked)}
                    />
                  </label>
                  <Link to={withReturnTo(`/knowledge/${entry.id}`, listLocation)} className={styles.row}>
                    <div className={styles.rowBadge} aria-hidden="true"><BookOpen size={16} /></div>
                    <div className={styles.rowBody}>
                      <div className={styles.rowTitle}>
                        <span className={styles.rowTitleText}><HighlightText text={entry.title} query={q} /></span>
                        {entry.status === 'deleted' && <span className={styles.rowStatus}>{t('kb_status_deleted')}</span>}
                        <span className={styles.rowProtocol}>{entry.protocol || t('kb_protocol_general')}</span>
                      </div>
                      <p className={styles.rowPhenomenon}><HighlightText text={entry.phenomenon || t('kb_no_phenomenon')} query={q} /></p>
                      {matchText && <p className={styles.rowMatch}>{matchText}</p>}
                      {entry.tags.length > 0 && (
                        <div className={styles.rowTags}>
                          {entry.tags.slice(0, 4).map((value) => <span key={value}>{value}</span>)}
                        </div>
                      )}
                    </div>
                    <div className={styles.rowMeta}>
                      {entry.attachmentCount > 0 && (
                        <span className={styles.rowAttach} title={t('kb_attachments_count', { count: entry.attachmentCount })}>
                          <Paperclip size={13} /> {entry.attachmentCount}
                        </span>
                      )}
                      <span title={formatDateTime(entry.deletedAt || entry.updatedAt)}>
                        {formatRelativeTime(entry.deletedAt || entry.updatedAt)}
                      </span>
                      <ChevronRight size={16} />
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}

        {total > 0 && (
          <div className={styles.pager}>
            <span className={styles.pagerInfo}>
              {t('kb_page_info', { total })} · {t('kb_page_number', { page: pageNumber })}
            </span>
            <div className={styles.pagerActions}>
              <button type="button" onClick={goPrev} disabled={!cursor}>{t('prev')}</button>
              <button type="button" onClick={goNext} disabled={!data?.page.hasMore}>{t('next')}</button>
            </div>
          </div>
        )}
      </section>

      {batchAction && (
        <ConfirmActionPanel
          presentation="modal"
          tone={batchAction === 'restore' ? 'info' : 'danger'}
          title={batchAction === 'restore' ? t('kb_batch_restore') : status === 'deleted' ? t('kb_permanent_delete') : t('kb_batch_delete')}
          message={batchAction === 'restore'
            ? t('kb_batch_restore_confirm', { count: selectedCount })
            : status === 'deleted'
              ? t('kb_batch_permanent_delete_confirm', { count: selectedCount })
              : t('kb_batch_delete_confirm', { count: selectedCount })}
          confirmLabel={batchAction === 'restore' ? t('kb_restore') : t('delete')}
          cancelLabel={t('cancel')}
          isWorking={batchWorking}
          onConfirm={() => void (batchAction === 'restore' ? runBatchRestore() : runBatchDelete())}
          onCancel={() => { if (!batchWorking) setBatchAction(null); }}
        />
      )}
      {batchTagOpen && (
        <ConfirmActionPanel
          presentation="modal"
          tone="info"
          title={t('kb_batch_tag_title')}
          message={t('kb_batch_tag_message', { count: selectedCount })}
          confirmLabel={t('kb_batch_tag_confirm')}
          cancelLabel={t('cancel')}
          isWorking={batchTagWorking}
          confirmDisabled={splitTagInput(batchTagInput).length === 0}
          onConfirm={() => void runBatchTag()}
          onCancel={() => { if (!batchTagWorking) setBatchTagOpen(false); }}
        >
          <label className={styles.field} htmlFor="kb-batch-tags">
            <span className={styles.fieldLabel}>{t('kb_batch_tag_input')}</span>
            <input
              id="kb-batch-tags"
              className={styles.input}
              value={batchTagInput}
              maxLength={256}
              placeholder={t('kb_batch_tag_placeholder')}
              disabled={batchTagWorking}
              onChange={(event) => setBatchTagInput(event.target.value)}
            />
          </label>
          <p className={styles.panelMeta}>{t('kb_batch_tag_hint')}</p>
        </ConfirmActionPanel>
      )}
    </div>
  );
}