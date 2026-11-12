import { EVIDENCE_TIME_FORMAT } from '../../lib/evidence-time';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import useSWR from 'swr';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ChevronRight, Radio, Search, X } from 'lucide-react';
import { OperationsPageFrame } from '../operations/OperationsPageFrame';
import { UEViewSwitch } from '../ue-info/UEViewSwitch';
import MetricStrip from '../../components/ui/MetricStrip';
import { CursorPagination } from '../../components/ui/CursorPagination';
import { Dialog } from '../../components/ui/Dialog';
import { Field } from '../../components/ui/Field';
import { EmptyState, ErrorState, LoadingState } from '../../components/ui/StatePanel';
import { getJsonWithSignal } from '../../lib/api/read-client';
import { useI18n } from '../../providers/I18nProvider';
import { IMS_QUERY_KEYS, IMS_SCOPE_KEYS, clearIMSQuery, imsActiveBindings, imsGroupReturn, imsQuery, patchIMSQuery, type IMSIdentity, type IMSResponse, type IMSSource } from './ims-model';
import styles from '../../styles/modules/ims-registration.module.css';

function subscribeNarrow(listener: () => void) { const query = window.matchMedia('(max-width: 600px)'); query.addEventListener('change', listener); return () => query.removeEventListener('change', listener); }
function narrowSnapshot() { return window.matchMedia('(max-width: 600px)').matches; }
function wideServerSnapshot() { return false; }

function useIMSRead(path: string) {
  const requests = useRef(new Map<string, AbortController>());
  const fetcher = useCallback(async (key: string) => {
    requests.current.get(key)?.abort();
    const controller = new AbortController();
    requests.current.set(key, controller);
    try { return await getJsonWithSignal<IMSResponse>(key, controller.signal); }
    finally { if (requests.current.get(key) === controller) requests.current.delete(key); }
  }, []);
  useEffect(() => {
    const controllers = requests.current;
    return () => { controllers.get(path)?.abort(); };
  }, [path]);
  return useSWR<IMSResponse>(path, fetcher, { keepPreviousData: false, revalidateOnFocus: false, shouldRetryOnError: false });
}

export function IMSSourceSelect({ sourceId, sources }: { sourceId: string; sources: { id: string; name: string }[] }) {
  const { t } = useI18n();
  const [choice, setChoice] = useState(sourceId);
  return <select name="sourceId" value={choice} onChange={(event) => setChoice(event.target.value)}><option value="">{t('ims_all_sources')}</option>{choice && !sources.some((source) => source.id === choice) ? <option value={choice}>{t('ims_source')}: {choice}</option> : null}{sources.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}</select>;
}

export function IMSSourceCard({ source }: { source: IMSSource }) {
  const { t, formatDateTime } = useI18n();
  return <article className={styles.source} data-state={source.state}>
    <header><h3>{source.name}</h3><span>{t(`ims_source_${source.state}`)}</span></header>
    <p className={styles.reason}>{source.reason ? t(`ims_reason_${source.reason}`) : t(`ims_source_${source.completeness}`)}</p>
    <dl className={styles.facts}>
      <div><dt>{t('ims_persistence')}</dt><dd>{t(`ims_mode_${source.persistence}`)}</dd></div>
      <div><dt>{t('ims_read_at')}</dt><dd>{source.readAt ? formatDateTime(source.readAt, EVIDENCE_TIME_FORMAT) : t('ims_unknown')}</dd></div>
      <div><dt>{t('ims_source_asof')}</dt><dd>{source.sourceAsOf ? formatDateTime(source.sourceAsOf) : t('ims_unknown')}</dd></div>
      <div><dt>{t('ims_freshness')}</dt><dd>{t('ims_unknown')}</dd></div>
      <div><dt>{t('ims_mapping')}</dt><dd>{t(`ims_identity_${source.identityState}`)}</dd></div>
    </dl>
  </article>;
}

export function IMSIdentityEvidence({ item, partial = false }: { item: IMSIdentity; partial?: boolean }) {
  const { t, formatDateTime } = useI18n();
  return <div className={styles.evidence}>
    {partial ? <p className={styles.warning}>{t('ims_partial_hint')}</p> : null}
    <p className={styles.identity}>{item.publicIdentity}</p>
    <p>{t(`ims_state_${item.state}`)}</p>
    <dl className={styles.facts}>
      <div><dt>{t('ims_source')}</dt><dd>{item.sourceId}</dd></div>
      <div><dt>{t('ims_read_at')}</dt><dd>{formatDateTime(item.readAt)}</dd></div>
      <div><dt>{t('ims_mapping')}</dt><dd>{t(`ims_identity_${item.identityState}`)}</dd></div>
      <div><dt>{t('ims_private')}</dt><dd>{item.privateIdentities.length ? item.privateIdentities.join(', ') : t('ims_no_mapping')}</dd></div>
      <div><dt>{t('ims_msisdn')}</dt><dd>{item.msisdns.length ? item.msisdns.join(', ') : t('ims_no_mapping')}</dd></div>
    </dl>
    <h3>{t('ims_contacts')}</h3>
    <ul className={styles.bindings}>{item.bindings.map((binding) => <li key={binding.key}>
      <strong>{t(`ims_binding_${binding.state}`)}</strong>
      <span className={styles.identity}>{binding.uri || t('ims_not_available')}</span>
      <span>{t('ims_expiry')}: {binding.expiresAt ? formatDateTime(binding.expiresAt) : t('ims_unknown')}</span>
    </li>)}</ul>
    <p className={styles.note}>{t('ims_database_note')}</p>
  </div>;
}

export function IMSRegistrationsPage() {
  const { t, formatNumber } = useI18n();
  const [params, setParams] = useSearchParams();
  const path = imsQuery(params);
  const read = useIMSRead(path);
  const data = read.error ? undefined : read.data;
  const [auto, setAuto] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const filterSummaryRef = useRef<HTMLElement>(null);
  const narrow = useSyncExternalStore(subscribeNarrow, narrowSnapshot, wideServerSnapshot);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const item = data?.items.find((candidate) => candidate.key === selected);
  const groupActive = IMS_SCOPE_KEYS.some((key) => params.has(key));
  const sourceNames = new Map(data?.catalogSources.map((source) => [source.id, source.name]));
  const completeSources = new Set(data?.sources.filter((source) => source.completeness === 'complete').map((source) => source.id));
  const cursorChanged = read.error && typeof read.error === 'object' && 'status' in read.error && read.error.status === 409;

  useEffect(() => {
    if (!auto) return;
    const timer = window.setInterval(() => { if (!document.hidden && !read.isValidating) void read.mutate(); }, 30000);
    return () => window.clearInterval(timer);
  }, [auto, read.isValidating, read.mutate]);

  const apply = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const patch: Record<string, string | null> = {};
    for (const key of ['q', 'sourceId', 'state', 'networkKey', 'operatorName', 'plmn']) patch[key] = String(form.get(key) || '').trim() || null;
    setParams((current) => patchIMSQuery(current, patch));
    setSelected(null);
    if (narrow) { setFiltersOpen(false); filterSummaryRef.current?.focus(); }
  };
  const value = (count: number | null | undefined) => typeof count === 'number' ? formatNumber(count) : t('ims_not_available');
  const controls = <form className={styles.filters} onSubmit={apply} key={path}>
    <Field label={t('ims_search')}><input name="q" maxLength={128} defaultValue={params.get('q') || ''} /></Field>
    <Field label={t('ims_source')}><IMSSourceSelect sourceId={params.get('sourceId') || ''} sources={data?.catalogSources ?? []} /></Field>
    <Field label={t('ims_state')}><select name="state" defaultValue={params.get('state') || ''}><option value="">{t('ims_all_states')}</option>{['active_binding_observed', 'no_active_binding_observed', 'unknown'].map((state) => <option key={state} value={state}>{t(`ims_state_${state}`)}</option>)}</select></Field>
    <div className={styles.actions}><button type="submit" className="btn btn-primary"><Search size={15} aria-hidden="true" />{t('ims_filter')}</button><button type="button" className="btn btn-secondary" onClick={() => { setParams(clearIMSQuery(params)); setSelected(null); if (narrow) { setFiltersOpen(false); filterSummaryRef.current?.focus(); } }}>{t('ims_reset')}</button></div>
    <details className={styles.scopeFilters} open={groupActive}><summary>{t('ims_scope_filters')}</summary><div className={styles.scopeFields}>
    <Field label={t('ims_network')}><input name="networkKey" maxLength={64} defaultValue={params.get('networkKey') || ''} /></Field>
    <Field label={t('ims_operator')}><input name="operatorName" maxLength={128} defaultValue={params.get('operatorName') || ''} /></Field>
    <Field label={t('ims_plmn')}><input name="plmn" inputMode="numeric" maxLength={6} defaultValue={params.get('plmn') || ''} /></Field>
    </div></details>
  </form>;

  const filters = narrow ? <details className={styles.filterDisclosure} open={filtersOpen} onToggle={(event) => setFiltersOpen(event.currentTarget.open)}><summary ref={filterSummaryRef}>{t('ims_filter_toggle')} ({IMS_QUERY_KEYS.filter((key) => key !== 'cursor' && params.has(key)).length})</summary>{controls}</details> : controls;
  return <OperationsPageFrame title={t('ims_title')} description={t('ims_description')} icon={<Radio />} viewSwitch={<UEViewSwitch />} filters={filters} onRefresh={async () => { await read.mutate(); }} status={<div className={styles.context}>
    <span className={styles.databaseFull}>{t('ims_database_note')}</span><span className={styles.databaseCompact}>{t('ims_database_short')}</span>
    <Link to={imsGroupReturn(params)}>{groupActive ? t('ims_back_group') : t('ims_choose_group')}</Link>
    {groupActive ? <span>{t('ims_group_applied')}</span> : null}
  </div>}>
    <div className={styles.workspace} aria-busy={read.isValidating}>
      <MetricStrip variant="cards" columns={4} className={styles.metrics} ariaLabel={t('ims_title')} items={[
        { key: 'contacts', label: <span className={styles.metricLabel}>{t('ims_active_bindings')}</span>, value: value(data?.counts.activeBindings), detail: data?.counts.activeBindings == null && data?.sources.some((source) => source.state === 'ok') ? t('ims_observed', { count: data.observed.activeBindings }) : undefined, tone: data?.counts.activeBindings == null ? 'muted' : 'primary' },
        { key: 'active-identities', label: <span className={styles.metricLabel}>{t('ims_active_identities')}</span>, value: value(data?.counts.activePublicIdentities), tone: data?.counts.activePublicIdentities == null ? 'muted' : 'primary' },
        { key: 'identities', label: <span className={styles.metricLabel}>{t('ims_identities')}</span>, value: value(data?.counts.publicIdentities), tone: data?.counts.publicIdentities == null ? 'muted' : 'primary' },
        { key: 'sources', label: <span className={styles.metricLabel}>{t('ims_source_count')}</span>, value: data && data.configurationState === 'ok' ? value(data.sources.length) : t('ims_not_available'), tone: 'muted' },
      ]} />
      <div className={styles.toolbar}><p className={styles.note}>{t('ims_scope_note')}</p><label className={styles.auto}><input type="checkbox" checked={auto} onChange={(event) => setAuto(event.target.checked)} />{t('ims_auto')}</label></div>
      {read.isLoading ? <LoadingState label={t('loading')} /> : read.error ? <ErrorState title={t('ims_load_error')} message={cursorChanged ? t('ims_cursor_changed') : t('ims_load_error_hint')} retryLabel={t('refresh')} onRetry={() => { void read.mutate(); }} /> : data && data.configurationState !== 'ok' ? <EmptyState title={t(`ims_${data.configurationState}`)} description={t(`ims_${data.configurationState}_hint`)} /> : data ? <>
        {data.completeness !== 'complete' ? <div className={styles.warning} role="status"><strong>{t('ims_partial')}</strong><p>{t('ims_partial_hint')}</p></div> : null}
        {data.sources.length ? <details className={styles.sourceDisclosure} open={data.completeness !== 'complete'}><summary>{t('ims_sources')} ({data.sources.length})<span>{t('ims_freshness')}: {t('ims_unknown')}</span></summary><section aria-label={t('ims_sources')} className={styles.sources}>{data.sources.map((source) => <IMSSourceCard key={source.id} source={source} />)}</section></details> : null}
        {data.items.length === 0 ? <EmptyState title={t(data.completeness === 'unavailable' ? 'ims_load_error' : 'ims_empty')} description={t(data.completeness === 'unavailable' ? 'ims_load_error_hint' : 'ims_empty_hint')} /> : <div className={styles.tableWrap}><table className={styles.table}>
          <caption>{t('ims_title')}</caption><thead><tr><th>{t('ims_identity')}</th><th>{t('ims_source')}</th><th>{t('ims_state')}</th><th>{t('ims_active_bindings')}</th><th><span className="sr-only">{t('ims_details')}</span></th></tr></thead>
          <tbody>{data.items.map((identity) => <tr key={identity.key}><td className={styles.identity}>{identity.publicIdentity}</td><td>{sourceNames.get(identity.sourceId) || identity.sourceId}</td><td>{t(`ims_state_${identity.state}`)}</td><td>{value(completeSources.has(identity.sourceId) ? imsActiveBindings(identity) : null)}</td><td><button type="button" className="btn btn-ghost" aria-label={`${t('ims_details')}: ${identity.publicIdentity}`} onClick={() => setSelected(identity.key)}>{t('ims_details')}<ChevronRight size={14} aria-hidden="true" /></button></td></tr>)}</tbody>
        </table></div>}
        <CursorPagination summary={t('ims_page_summary', { shown: data.items.length, total: value(data.pagination.total) })} previousLabel={t('ims_first')} nextLabel={t('ims_next')} hasPrevious={params.has('cursor')} hasNext={data.pagination.hasMore} onPrevious={() => setParams((current) => patchIMSQuery(current, { cursor: null }, false))} onNext={() => setParams((current) => patchIMSQuery(current, { cursor: data.pagination.nextCursor }, false))} />
      </> : null}
      {cursorChanged ? <button type="button" className="btn btn-secondary" onClick={() => setParams((current) => patchIMSQuery(current, { cursor: null }, false))}><ArrowLeft size={15} />{t('ims_first')}</button> : null}
    </div>
    <Dialog open={Boolean(item)} onClose={() => setSelected(null)} labelledBy="ims-evidence-title" className={styles.drawer} overlayClassName={styles.overlay} initialFocusRef={closeRef}>
      <header className={styles.drawerHead}><h2 id="ims-evidence-title">{t('ims_details')}</h2><button ref={closeRef} type="button" className="btn btn-ghost" aria-label={t('ims_close')} onClick={() => setSelected(null)}><X size={20} /></button></header>
      {item ? <IMSIdentityEvidence item={item} partial={!completeSources.has(item.sourceId)} /> : null}
    </Dialog>
  </OperationsPageFrame>;
}
