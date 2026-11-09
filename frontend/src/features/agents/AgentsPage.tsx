import { useEffect, useState } from 'react';
import useSWR from 'swr';
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ChevronRight, KeyRound, Plus, RefreshCw, Search, Server, Settings2 } from 'lucide-react';
import { PageHeader } from '../../components/ui/PageHeader';
import MetricStrip from '../../components/ui/MetricStrip';
import { Dialog } from '../../components/ui/Dialog';
import { CursorPagination } from '../../components/ui/CursorPagination';
import { EmptyState, ErrorState, LoadingState } from '../../components/ui/StatePanel';
import { capabilityDecision } from '../../lib/permissions';
import { resolveReturnTo, withReturnTo } from '../../lib/return-to';
import { useAuth } from '../../providers/AuthProvider';
import { useI18n } from '../../providers/I18nProvider';
import { AgentEditor, CredentialDialog } from './AgentDialogs';
import { fetchAgent, fetchAgents, rotateAgentCredential, updateAgent, type Agent, type AgentCredential, type AgentObservation } from './agents-api';
import { bytes, metricCells, percent, visibleComponentState } from './agents-model';
import styles from '../../styles/modules/agents.module.css';

function StateBadge({ value }: { value: string }) {
  const { t } = useI18n();
  return <span className={styles.badge} data-state={value}>{t(`agents_state_${value}`)}</span>;
}
function Measurement({ value, stale }: { value: string | null; stale?: boolean }) {
  const { t } = useI18n();
  return <span className={styles.measurement} data-stale={stale || undefined}>{value ?? t('agents_unavailable')}</span>;
}
export function AgentEvidence({ observation, freshness }: { observation: AgentObservation; freshness: string }) {
  const { t, formatDateTime } = useI18n();
  const m = metricCells(observation.metrics);
  return <section className={styles.panel}>
    <header className={styles.panelHead}><h2>{t('agents_observation')}</h2><span>{formatDateTime(observation.collectedAt)}</span></header>
    <p className={styles.hint}>{t('agents_evidence_hint')}</p>
    {freshness !== 'fresh' ? <p className={styles.notice} role="status">{t('agents_stale_evidence')}</p> : null}
    {!observation.scanComplete ? <p className={styles.notice}>{t('agents_scan_partial')}</p> : null}
    <dl className={styles.facts}>
      <div><dt>{t('agents_reported_host')}</dt><dd>{observation.hostName || t('agents_unavailable')}</dd></div>
      <div><dt>{t('agents_cpu')}</dt><dd><Measurement value={m.cpu} stale={freshness !== 'fresh'} /></dd></div>
      <div><dt>{t('agents_memory')}</dt><dd><Measurement value={m.memory} stale={freshness !== 'fresh'} /></dd></div>
      <div><dt>{t('agents_disk')}</dt><dd><Measurement value={m.disk} stale={freshness !== 'fresh'} /></dd></div>
      <div><dt>{t('agents_version')}</dt><dd>{observation.version || t('agents_unavailable')}</dd></div>
      <div><dt>{t('agents_visibility')}</dt><dd>{t(`agents_visibility_${observation.visibility}`)}</dd></div>
    </dl>
    <div className={styles.tableWrap}><table className={styles.table}>
      <caption className={styles.caption}>{t('agents_components')}</caption>
      <thead><tr><th>{t('agents_component')}</th><th>{t('agents_observed_state')}</th><th>{t('agents_pid')}</th><th>{t('agents_workers')}</th><th>{t('agents_cpu')}</th><th>{t('agents_rss')}</th></tr></thead>
      <tbody>{observation.components.map((c) => <tr key={c.componentId}>
        <td><code>{c.componentId}</code></td>
        <td><StateBadge value={visibleComponentState(observation, freshness, c.runtimeStatus)} />{freshness !== 'fresh' ? <small>{t('agents_last_state', { state: t(`agents_state_${c.runtimeStatus}`) })}</small> : null}</td>
        <td>{c.primaryPid > 0 ? c.primaryPid : t('agents_unavailable')}</td><td>{c.verified || (observation.scanComplete && c.runtimeStatus === 'stopped') ? c.workerCount : t('agents_unavailable')}</td>
        <td><Measurement value={percent(c.cpuPercent)} stale={freshness !== 'fresh'} /></td><td><Measurement value={bytes(c.memoryRssBytes)} stale={freshness !== 'fresh'} /></td>
      </tr>)}</tbody>
    </table></div>
  </section>;
}

export function AgentsPage() {
  const { t, formatDateTime } = useI18n();
  const { user } = useAuth();
  const canManage = capabilityDecision(user?.role, 'user_admin') === 'allow';
  const { agentId } = useParams();
  const location = useLocation();
  const [search, setSearch] = useSearchParams();
  const q = search.get('q') ?? '';
  const cursor = search.get('cursor') ?? '';
  const list = useSWR(agentId ? null : ['agents', q, cursor], () => fetchAgents(q, cursor), { refreshInterval: 15000, revalidateOnFocus: false, shouldRetryOnError: false });
  const detail = useSWR(agentId ? ['agent', agentId] : null, () => fetchAgent(agentId!), { refreshInterval: 15000, revalidateOnFocus: false, shouldRetryOnError: false });
  const [editor, setEditor] = useState<Agent | 'new' | null>(null);
  const [credential, setCredential] = useState<AgentCredential | null>(null);
  const [action, setAction] = useState<'toggle' | 'rotate' | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [input, setInput] = useState(q);
  useEffect(() => { setInput(q); }, [q]);
  const agentRows = list.data?.agents ?? [];
  const current = detail.data;
  const summary = !list.error && list.data?.completeness === 'complete' ? list.data.summary : null;
  const refresh = () => { void list.mutate(); void detail.mutate(); };
  async function execute() {
    if (!current) return;
    setBusy(true); setActionError('');
    try {
      if (action === 'rotate') setCredential(await rotateAgentCredential(current.agentId, current.revision));
      else await updateAgent(current.agentId, { name: current.name, scope: current.scope, enabled: !current.enabled, expectedRevision: current.revision });
      setAction(null); refresh();
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : '';
      setActionError(t(code === 'AGENT_REVISION_CONFLICT' ? 'agents_err_conflict' : 'agents_err_save'));
    } finally { setBusy(false); }
  }
  const controller = list.data?.controller;
  const localMetrics = metricCells(controller?.observation?.metrics);
  const listAvailable = list.data?.completeness === 'complete' && !list.error;
  return <div className={styles.page}>
    {agentId ? <Link className="btn btn-ghost" to={resolveReturnTo(location.search, '/agents', ['/agents'])}><ArrowLeft size={16} />{t('agents_back')}</Link> : null}
    <PageHeader title={current?.name ?? t('agents_title')} description={t(agentId ? 'agents_detail_description' : 'agents_description')} icon={<Server size={23} />}
      actions={<>
        <button className="btn btn-secondary" onClick={refresh} disabled={list.isValidating || detail.isValidating}><RefreshCw size={16} />{t('refresh')}</button>
        {canManage && !agentId ? <button className="btn btn-primary" onClick={() => setEditor('new')}><Plus size={16} />{t('agents_create')}</button> : null}
        {canManage && current ? <>
          <button className="btn btn-secondary" onClick={() => setEditor(current)}><Settings2 size={16} />{t('agents_edit')}</button>
          <button className="btn btn-secondary" onClick={() => { setActionError(''); setAction('rotate'); }}><KeyRound size={16} />{t('agents_rotate')}</button>
          <button className="btn btn-secondary" onClick={() => { setActionError(''); setAction('toggle'); }}>{t(current.enabled ? 'agents_disable' : 'agents_enable')}</button>
        </> : null}
      </>} />
    {!agentId ? <>
      <section className={styles.controller}>
        <div><span className={styles.eyebrow}>{t('agents_controller')}</span><h2>{controller?.hostName || t('agents_loading_controller')}</h2><p>{t('agents_controller_hint')}</p></div>
        <div className={styles.localMetrics}>
          <div><span>{t('agents_cpu')}</span><Measurement value={localMetrics.cpu} stale={Boolean(list.error)} /></div>
          <div><span>{t('agents_memory')}</span><Measurement value={localMetrics.memory} stale={Boolean(list.error)} /></div>
          <div><span>{t('agents_disk')}</span><Measurement value={localMetrics.disk} stale={Boolean(list.error)} /></div>
        </div>
        <Link className="btn btn-secondary" to="/inventory/runtime">{t('agents_local_observation')}<ChevronRight size={16} /></Link>
      </section>
      <MetricStrip ariaLabel={t('agents_summary')} items={[
        { key: 'total', label: t('agents_remote_total'), value: summary?.total ?? t('agents_unavailable') },
        { key: 'online', label: t('agents_state_online'), value: summary?.online ?? t('agents_unavailable'), tone: 'success' },
        { key: 'attention', label: t('agents_attention'), value: summary ? summary.stale + summary.offline : t('agents_unavailable'), tone: 'warning' },
        { key: 'pending', label: t('agents_state_pending'), value: summary?.pending ?? t('agents_unavailable') },
      ]} />
      <section className={styles.panel}>
        <form className={styles.toolbar} onSubmit={(event) => { event.preventDefault(); setSearch(input.trim() ? { q: input.trim() } : {}); }}>
          <label className={styles.search}><Search size={16} /><input aria-label={t('agents_search')} value={input} onChange={(event) => setInput(event.target.value)} placeholder={t('agents_search')} /></label>
          <button className="btn btn-secondary" type="submit">{t('search')}</button>
        </form>
        {list.isLoading ? <LoadingState label={t('loading')} /> : !listAvailable ? <ErrorState title={t('agents_title')} message={t('agents_err_load')} retryLabel={t('refresh')} onRetry={refresh} /> : agentRows.length === 0 ? <EmptyState icon={<Server size={30} />} title={t(q ? 'agents_no_matches' : 'agents_empty')} description={t(q ? 'agents_change_search' : 'agents_empty_hint')} /> : <div className={styles.tableWrap}><table className={styles.table}>
          <thead><tr><th>{t('agents_name')}</th><th>{t('agents_scope')}</th><th>{t('agents_reported_host')}</th><th>{t('agents_connection')}</th><th>{t('agents_cpu')}</th><th>{t('agents_memory')}</th><th>{t('agents_last_received')}</th></tr></thead>
          <tbody>{agentRows.map((a) => {
            const m = metricCells(a.observation?.metrics);
            return <tr key={a.agentId}>
              <td><Link className={styles.agentLink} to={withReturnTo(`/agents/${a.agentId}`, location.pathname + location.search)}>{a.name}<ChevronRight size={14} /></Link><small className={styles.mono}>{a.agentId.slice(0, 12)}</small></td>
              <td>{a.scope.operatorName || a.scope.networkKey}<small>{a.scope.networkKey}{a.scope.plmns.length ? ` / ${a.scope.plmns.join(', ')}` : ''}</small></td>
              <td>{a.observation?.hostName || t('agents_unavailable')}</td>
              <td><StateBadge value={a.connectionState} /></td>
              <td><Measurement value={m.cpu} stale={a.evidenceFreshness !== 'fresh'} /></td><td><Measurement value={m.memory} stale={a.evidenceFreshness !== 'fresh'} /></td>
              <td>{a.lastReceivedAt ? formatDateTime(a.lastReceivedAt) : t('agents_never_received')}</td>
            </tr>;
          })}</tbody>
        </table></div>}
        <CursorPagination summary={t('agents_summary_scope')} previousLabel={t('agents_first_page')} nextLabel={t('agents_next_page')}
          hasPrevious={Boolean(cursor)} hasNext={Boolean(listAvailable && list.data?.hasMore && list.data.nextCursor)}
          onPrevious={() => setSearch(q ? { q } : {})}
          onNext={() => { if (list.data?.nextCursor) setSearch({ ...(q ? { q } : {}), cursor: list.data.nextCursor }); }} />
      </section>
      <p className={styles.hint}>{t('agents_scope_hint')}</p>
    </> : detail.isLoading ? <p role="status">{t('loading')}</p> : detail.error || !current ? <p className={styles.error} role="alert">{t('agents_err_detail')}</p> : <>
      <section className={styles.panel}><header className={styles.panelHead}><h2>{t('agents_identity')}</h2><StateBadge value={current.connectionState} /></header>
        <dl className={styles.facts}>
          <div><dt>{t('agents_id')}</dt><dd className={styles.mono}>{current.agentId}</dd></div>
          <div><dt>{t('agents_network_key')}</dt><dd>{current.scope.networkKey}</dd></div>
          <div><dt>{t('agents_operator')}</dt><dd>{current.scope.operatorName || t('agents_not_assigned')}</dd></div>
          <div><dt>{t('agents_plmns')}</dt><dd>{current.scope.plmns.join(', ') || t('agents_not_assigned')}</dd></div>
          <div><dt>{t('agents_host_resource')}</dt><dd>{current.scope.hostResourceId ? <Link to={`/inventory/${current.scope.hostResourceId}`}>{current.scope.hostResourceId}</Link> : t('agents_not_assigned')}</dd></div>
          <div><dt>{t('agents_site')}</dt><dd>{current.scope.siteResourceId ? <Link to={`/inventory/${current.scope.siteResourceId}`}>{current.scope.siteResourceId}</Link> : t('agents_not_assigned')}</dd></div>
          <div><dt>{t('agents_last_received')}</dt><dd>{current.lastReceivedAt ? formatDateTime(current.lastReceivedAt) : t('agents_never_received')}</dd></div>
        </dl>
      </section>
      {current.observation ? <AgentEvidence observation={current.observation} freshness={current.evidenceFreshness} /> : <div className={styles.empty}><h2>{t('agents_state_pending')}</h2><p>{t('agents_waiting_hint')}</p></div>}
    </>}
    {editor ? <AgentEditor key={editor === 'new' ? 'new' : editor.agentId} agent={editor === 'new' ? undefined : editor} onClose={() => setEditor(null)} onChanged={refresh} onCredential={setCredential} /> : null}
    {credential ? <CredentialDialog credential={credential} onClose={() => setCredential(null)} /> : null}
    {action ? <Dialog open onClose={() => { if (!busy) setAction(null); }} ariaLabel={t(action === 'rotate' ? 'agents_rotate' : current?.enabled ? 'agents_disable' : 'agents_enable')} overlayClassName="modal-overlay" className="modal-content">
      <div className={styles.dialog}><h2>{t(action === 'rotate' ? 'agents_rotate' : current?.enabled ? 'agents_disable' : 'agents_enable')}</h2>
        <p>{t(action === 'rotate' ? 'agents_rotate_hint' : current?.enabled ? 'agents_disable_hint' : 'agents_enable_hint')}</p>
        {actionError ? <p className={styles.error} role="alert">{actionError}</p> : null}
        <footer className={styles.dialogActions}><button className="btn btn-secondary" disabled={busy} onClick={() => setAction(null)}>{t('cancel')}</button><button className="btn btn-primary" disabled={busy} onClick={() => { void execute(); }}>{t('confirm')}</button></footer>
      </div>
    </Dialog> : null}
  </div>;
}
