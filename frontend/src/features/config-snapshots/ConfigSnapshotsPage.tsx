import { useState, type FormEvent } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Check, FileDiff, FileText, RefreshCw, Save } from 'lucide-react';
import { PageHeader } from '../../components/ui/PageHeader';
import MetricStrip from '../../components/ui/MetricStrip';
import { CursorPagination } from '../../components/ui/CursorPagination';
import { Dialog } from '../../components/ui/Dialog';
import { EmptyState, ErrorState, LoadingState } from '../../components/ui/StatePanel';
import { ViewSwitch } from '../../components/ui/ViewSwitch';
import { hasPermission } from '../../lib/permissions';
import { withReturnTo, resolveReturnTo } from '../../lib/return-to';
import { useAuth } from '../../providers/AuthProvider';
import { useI18n } from '../../providers/I18nProvider';
import { captureConfig, captureRequestId, readConfig, setConfigBaseline, sourceListPath, sourcePath, type ConfigDiff, type ConfigMeta, type ConfigSource, type Observation, type Page, type Snapshot, type SourceList } from './config-api';
import { DriftPolicyPanel } from '../config-drift/DriftPolicyPanel';
import { ConfigDriftWorkspace } from '../config-drift/ConfigDriftWorkspace';
import styles from '../../styles/modules/operations-evidence.module.css';

export function ConfigStatus({ value }: { value: string }) {
  const { t } = useI18n();
  return <span className={styles.badge} data-state={value}>{t(`evidence_${value}`)}</span>;
}
export function SnapshotEvidence({ snapshot }: { snapshot: Snapshot }) {
  const { t, formatDateTime } = useI18n();
  return <section className={styles.panel}>
    <div className={styles.sectionHead}><h2>{t('config_observed_content')}</h2><ConfigStatus value={snapshot.mode} /></div>
    <div className={styles.content}><p className={styles.hint}>{formatDateTime(snapshot.collectedAt)} / {snapshot.policy}</p>
      <p>{t('config_projection_hint')}</p>
      {snapshot.mode === 'projected' ? <pre className={styles.code} tabIndex={0} aria-label={t('config_observed_content')}>{snapshot.projection}</pre> : <EmptyState title={t('evidence_metadata_only')} description={t(`evidence_${snapshot.reason}`)} />}
    </div>
  </section>;
}

export function ConfigSnapshotsPage() {
  const { sourceId } = useParams();
  const { t, formatDateTime } = useI18n();
  const { user } = useAuth();
  const { mutate } = useSWRConfig();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const [baseline, setBaseline] = useState<string | null>(null);
  const requestedView = params.get('view') || 'versions'; const view = ['versions', 'observations', 'diff', 'drift'].includes(requestedView) ? requestedView : 'versions';
  const canConfigure = hasPermission(user, 'core.configure');
  const base = sourceId ? sourcePath(sourceId) : '';
  const list = useSWR<SourceList>(sourceId ? null : sourceListPath(params), readConfig);
  const detail = useSWR<ConfigSource>(sourceId ? base : null, readConfig);
  const meta = useSWR<ConfigMeta>('/api/config-snapshots/meta', readConfig);
  const historyKey = `${base}/snapshots?limit=50${params.get('cursor') ? `&cursor=${encodeURIComponent(params.get('cursor')!)}` : ''}`;
  const history = useSWR<Page<Snapshot>>(sourceId && view !== 'observations' ? historyKey : null, readConfig);
  const observations = useSWR<Page<Observation>>(sourceId && view === 'observations' ? `${base}/observations?limit=50${params.get('cursor') ? `&cursor=${encodeURIComponent(params.get('cursor')!)}` : ''}` : null, readConfig);
  const selectedId = params.get('snapshot');
  const selected = useSWR<Snapshot>(sourceId && selectedId ? `${base}/snapshots/${encodeURIComponent(selectedId)}` : null, readConfig);
  const left = params.get('left') || detail.data?.baselineId || '';
  const right = params.get('right') || detail.data?.latestSnapshot?.snapshotId || '';
  const diff = useSWR<ConfigDiff>(sourceId && view === 'diff' && left && right ? `${base}/diff?left=${encodeURIComponent(left)}&right=${encodeURIComponent(right)}` : null, readConfig);
  const update = (changes: Record<string, string>) => { const next = new URLSearchParams(params); for (const [key, value] of Object.entries(changes)) { if (value) next.set(key, value); else next.delete(key); } if (!('cursor' in changes)) next.delete('cursor'); setParams(next); };
  const refresh = async () => { await mutate((key) => typeof key === 'string' && (key.startsWith('/api/config-snapshots/') || key.startsWith('/api/config-drift/'))); };
  const capture = async () => {
    if (!sourceId) return; setBusy(true); setFeedback(null);
    try { const result = await captureConfig(sourceId, captureRequestId()); setFeedback({ error: result.status !== 'ok', text: t(result.status === 'ok' ? 'config_captured' : `evidence_${result.reason}`) }); await refresh(); }
    catch { setFeedback({ error: true, text: t('config_capture_failed') }); }
    finally { setBusy(false); }
  };
  const saveBaseline = async () => {
    if (!sourceId || !detail.data || baseline === null) return; setBusy(true); setFeedback(null);
    try { await setConfigBaseline(sourceId, detail.data.revision, baseline); setBaseline(null); setFeedback({ error: false, text: t('config_baseline_saved') }); await refresh(); }
    catch { setFeedback({ error: true, text: t('config_baseline_failed') }); await detail.mutate(); setBaseline(null); }
    finally { setBusy(false); }
  };
  const search = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const data = new FormData(event.currentTarget); update({ q: String(data.get('q') || '').trim(), status: String(data.get('status') || '') }); };
  const current = detail.data;
  const snapshot = selectedId ? selected.data : current?.latestSnapshot;
  const page = view === 'observations' ? observations.data : history.data;
  const back = resolveReturnTo(location.search, '/config-snapshots', ['/config-snapshots']);
  const errorPanel = (text: string) => <ErrorState title={t('evidence_unavailable')} message={text} retryLabel={t('refresh')} onRetry={() => { void refresh(); }} />;
  const versionChoices = [...new Set([...(history.data?.items.map((item) => item.snapshotId) || []), current?.baselineId, current?.latestSnapshot?.snapshotId, left, right].filter((id): id is string => Boolean(id)))];

  if (view === 'drift') {
    return <div className={styles.page}>
      <PageHeader title={sourceId ? current?.name || t('config_title') : t('config_title')} subtitle={t('drift_description')} icon={<FileDiff size={22} />} actions={<>
        {sourceId ? <Link className="btn btn-secondary" to={back}><ArrowLeft size={16} />{t('back')}</Link> : null}
        <button className="btn btn-secondary" onClick={() => { void refresh(); }}><RefreshCw size={16} />{t('refresh')}</button>
      </>} />
      <ViewSwitch ariaLabel={t('config_views')} value={view} options={['versions', 'observations', 'diff', 'drift'].map((value) => ({ value, label: t(`config_view_${value}`) }))} onChange={(value) => update({ view: value, snapshot: '' })} />
      <ConfigDriftWorkspace embedded />
    </div>;
  }

  return <div className={styles.page}>
    <PageHeader title={sourceId ? current?.name || t('config_title') : t('config_title')} subtitle={t('config_description')} icon={<FileDiff size={22} />} actions={<>
      {sourceId ? <Link className="btn btn-secondary" to={back}><ArrowLeft size={16} />{t('back')}</Link> : null}
      <button className="btn btn-secondary" onClick={() => { void refresh(); }}><RefreshCw size={16} />{t('refresh')}</button>
      {sourceId && canConfigure ? <button className="btn btn-primary" disabled={busy || !current?.registered || !meta.data?.fingerprintConfigured} onClick={() => { void capture(); }}><Save size={16} />{t('config_capture')}</button> : null}
    </>} />
    {feedback ? <p role={feedback.error ? 'alert' : 'status'} className={feedback.error ? styles.error : styles.notice}>{feedback.text}</p> : null}
    {meta.error ? errorPanel(t('config_meta_failed')) : meta.data && (meta.data.catalogState !== 'configured' || !meta.data.fingerprintConfigured) ? <p className={styles.notice}>{t(meta.data.catalogState === 'invalid_config' ? 'config_manifest_invalid' : meta.data.catalogState !== 'configured' ? 'config_not_configured' : 'config_key_missing')}</p> : null}
    {!sourceId ? <>
      <MetricStrip ariaLabel={t('config_summary')} items={['total', 'changed', 'failed', 'noBaseline'].map((key) => ({ key, label: t(`config_count_${key}`), value: list.data?.summary?.[key] ?? t('evidence_unavailable'), detail: t('config_count_scope'), tone: key === 'failed' ? 'warning' as const : 'muted' as const }))} />
      <section className={styles.panel}>
        <form className={styles.toolbar} onSubmit={search}>
          <label>{t('search')}<input name="q" defaultValue={params.get('q') || ''} placeholder={t('config_search')} /></label>
          <label>{t('config_collection')}<select name="status" defaultValue={params.get('status') || ''}><option value="">{t('evidence_all')}</option>{['not_collected', 'ok', 'unreadable', 'publication_pending'].map((state) => <option key={state} value={state}>{t(`evidence_${state}`)}</option>)}</select></label>
          <button className="btn btn-secondary" type="submit">{t('search')}</button>
        </form>
        {list.isLoading ? <LoadingState label={t('loading')} /> : list.error || list.data?.completeness === 'unavailable' ? errorPanel(t('config_sources_failed')) : !list.data?.items.length ? <EmptyState title={t('config_no_sources')} description={t('config_not_configured')} /> : <div className={styles.tableWrap}><table className={styles.table}>
          <caption>{t('config_summary_scope')}</caption><thead><tr><th>{t('config_source')}</th><th>{t('config_resource')}</th><th>{t('config_collection')}</th><th>{t('config_baseline_comparison')}</th><th>{t('config_last_observation')}</th></tr></thead>
          <tbody>{list.data.items.map((item) => <tr key={item.sourceId}><td><Link to={withReturnTo(`/config-snapshots/${item.sourceId}`, location.pathname + location.search)}>{item.name}</Link><small>{item.format} / {item.profile}</small>{!item.registered ? <ConfigStatus value="source_removed" /> : null}</td><td>{item.resourceId ? <Link to={`/inventory/${item.resourceId}`}>{item.resourceId}</Link> : t('evidence_unassociated')}<small>{t(`evidence_${item.resourceState}`)}</small></td><td><ConfigStatus value={item.collectionState} /></td><td><ConfigStatus value={item.comparison} /></td><td>{item.latest ? formatDateTime(item.latest.collectedAt) : t('evidence_not_collected')}</td></tr>)}</tbody>
        </table></div>}
        <CursorPagination summary={t('config_summary_scope')} previousLabel={t('evidence_first_page')} nextLabel={t('next')} hasPrevious={Boolean(params.get('cursor'))} hasNext={Boolean(list.data?.hasMore)} onPrevious={() => update({ cursor: '' })} onNext={() => update({ cursor: list.data?.nextCursor || '' })} />
      </section>
    </> : detail.isLoading ? <LoadingState label={t('loading')} /> : detail.error || !current ? errorPanel(t('config_source_failed')) : <>
      <section className={styles.panel}><div className={styles.sectionHead}><h2>{t('config_source')}</h2><ConfigStatus value={current.collectionState} /></div>
        <dl className={styles.facts}>
          <div><dt>{t('config_source_id')}</dt><dd>{current.sourceId}</dd></div><div><dt>{t('config_collector')}</dt><dd>{current.collectorId}</dd></div>
          <div><dt>{t('config_resource')}</dt><dd>{current.resourceId ? <Link to={`/inventory/${current.resourceId}`}>{current.resourceId}</Link> : t('evidence_unassociated')}</dd></div>
          <div><dt>{t('config_baseline_comparison')}</dt><dd><ConfigStatus value={current.comparison} /></dd></div>
          <div><dt>{t('config_baseline')}</dt><dd>{current.baselineId || t('evidence_no_baseline')}<small>{current.baselineAt ? `${formatDateTime(current.baselineAt)} / ${current.baselineBy}` : ''}</small></dd></div>
          <div><dt>{t('config_schedule')}</dt><dd>{current.intervalSeconds ? t('config_every_seconds', { seconds: current.intervalSeconds }) : t('config_manual_only')}</dd></div>
          {current.intervalSeconds ? <div><dt>{t('config_next_collection')}</dt><dd>{current.nextCollectionAt ? formatDateTime(current.nextCollectionAt) : t('evidence_unavailable')}<small>{current.scheduleLastError ? t(`evidence_${current.scheduleLastError}`) : t(`evidence_${current.scheduleState}`)}</small></dd></div> : null}
        </dl>
        {current.latest?.status !== 'ok' && current.latestSnapshot ? <p className={styles.notice}>{t('config_last_success_hint')}</p> : null}
        {current.pending ? <p className={styles.notice}>{t('config_pending_hint')}</p> : null}
        {current.latest && current.latest.status !== 'ok' ? <p className={styles.error}>{t(`evidence_${current.latest.reason}`)}</p> : null}
        <p className={styles.hintBlock}>{t('config_no_runtime_claim')}</p>
      </section>
      <DriftPolicyPanel key={sourceId} sourceId={sourceId} canConfigure={canConfigure}/>
      <ViewSwitch ariaLabel={t('config_views')} value={view} options={['versions', 'observations', 'diff', 'drift'].map((value) => ({ value, label: t(`config_view_${value}`) }))} onChange={(value) => update({ view: value, snapshot: '' })} />
      {view === 'diff' ? <section className={styles.panel}>
        <div className={styles.toolbar}>{(['left', 'right'] as const).map((side) => <label key={side}>{t(`config_${side}`)}<select value={side === 'left' ? left : right} onChange={(event) => update({ [side]: event.target.value })}><option value="">{t('config_select_version')}</option>{versionChoices.map((id) => <option key={id} value={id}>{id.slice(0, 12)}{id === current.baselineId ? ` / ${t('config_baseline')}` : ''}</option>)}</select></label>)}</div>
        {!left || !right ? <EmptyState title={t('config_select_two')} /> : diff.isLoading ? <LoadingState label={t('loading')} /> : diff.error ? errorPanel(t('config_diff_failed')) : diff.data ? <div className={styles.content}><ConfigStatus value={diff.data.comparison} />{!diff.data.complete ? <p className={styles.notice}>{t(`evidence_${diff.data.reason}`)}</p> : <div className={styles.diff} tabIndex={0} aria-label={t('config_view_diff')}>{diff.data.lines.map((line, i) => <div key={i} data-kind={line.kind}><span className={styles.leftNumber}>{line.left ?? ''}</span><span className={styles.rightNumber}>{line.right ?? ''}</span><code className={styles.leftText}>{line.kind === 'add' ? '' : `${line.kind === 'remove' ? '-' : ' '}${line.text}`}</code><code className={styles.rightText}>{line.kind === 'remove' ? '' : `${line.kind === 'add' ? '+' : ' '}${line.text}`}</code><code className={styles.unifiedText}>{line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}{line.text}</code></div>)}</div>}</div> : null}
      </section> : <section className={styles.panel}>
        <div className={styles.sectionHead}><h2>{t(`config_view_${view}`)}</h2>{canConfigure && current.baselineId ? <button className="btn btn-secondary" onClick={() => setBaseline('')}>{t('config_clear_baseline')}</button> : null}</div>
        {(view === 'observations' ? observations.isLoading : history.isLoading) ? <LoadingState label={t('loading')} /> : (view === 'observations' ? observations.error : history.error) ? errorPanel(t('config_history_failed')) : !page?.items.length ? <EmptyState title={t('config_no_history')} /> : <div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>{t('config_last_observation')}</th><th>{t('config_evidence')}</th><th>{t('config_actor')}</th><th>{t('config_actions')}</th></tr></thead><tbody>
          {view === 'observations' ? observations.data?.items.map((item) => <tr key={item.observationId}><td>{formatDateTime(item.collectedAt)}</td><td><ConfigStatus value={item.status} /><small>{item.reason ? t(`evidence_${item.reason}`) : item.changed === null ? t('config_initial_observation') : t(item.changed ? 'config_change_observed' : 'evidence_unchanged')}</small></td><td>{item.actor}</td><td>{item.snapshotId ? <button className="btn btn-secondary" onClick={() => update({ snapshot: item.snapshotId, view: 'versions' })}>{t('config_view_content')}</button> : t('evidence_unavailable')}</td></tr>) : history.data?.items.map((item) => <tr key={item.snapshotId}><td>{formatDateTime(item.collectedAt)}<small className={styles.mono}>{item.snapshotId.slice(0, 12)}</small></td><td><ConfigStatus value={item.mode} /><small>{item.policy}</small></td><td>{item.actor}</td><td><div className={styles.actions}><button className="btn btn-secondary" onClick={() => update({ snapshot: item.snapshotId })}><FileText size={14} />{t('config_view_content')}</button>{canConfigure && current.registered ? <button className="btn btn-secondary" disabled={busy} onClick={() => setBaseline(item.snapshotId)}><Check size={14} />{t('config_set_baseline')}</button> : null}</div></td></tr>)}
        </tbody></table></div>}
        <CursorPagination summary={t('config_history_scope')} previousLabel={t('evidence_first_page')} nextLabel={t('next')} hasPrevious={Boolean(params.get('cursor'))} hasNext={Boolean(page?.hasMore)} onPrevious={() => update({ cursor: '' })} onNext={() => update({ cursor: page?.nextCursor || '' })} />
      </section>}
      {selectedId && selected.error ? errorPanel(t('config_version_failed')) : snapshot ? <SnapshotEvidence snapshot={snapshot} /> : null}
    </>}
    {baseline !== null ? <Dialog open onClose={() => { if (!busy) setBaseline(null); }} ariaLabel={t('config_set_baseline')} overlayClassName="modal-overlay" className="modal-content"><div className={styles.dialog}><h2>{t(baseline ? 'config_set_baseline' : 'config_clear_baseline')}</h2><p>{t('config_baseline_hint')}</p><p>{t('drift_baseline_change_hint')}</p><code>{baseline || t('evidence_no_baseline')}</code><footer className={styles.actions}><button className="btn btn-secondary" disabled={busy} onClick={() => setBaseline(null)}>{t('cancel')}</button><button className="btn btn-primary" disabled={busy} onClick={() => { void saveBaseline(); }}>{t('confirm')}</button></footer></div></Dialog> : null}
    <p className={styles.hint}>{t('config_retention_hint', { days: meta.data?.retentionDays || 90, versions: meta.data?.maxVersions || 100 })}</p>
  </div>;
}