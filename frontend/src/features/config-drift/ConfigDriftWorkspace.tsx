import { EVIDENCE_TIME_FORMAT } from '../../lib/evidence-time';
import { useState, type FormEvent } from 'react';
import { useSWRConfig } from 'swr';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { BellRing } from 'lucide-react';
import { OperationsPageFrame } from '../operations/OperationsPageFrame';
import { ViewSwitch } from '../../components/ui/ViewSwitch';
import MetricStrip from '../../components/ui/MetricStrip';
import { Field } from '../../components/ui/Field';
import { Dialog } from '../../components/ui/Dialog';
import { CursorPagination } from '../../components/ui/CursorPagination';
import { EmptyState, ErrorState, LoadingState } from '../../components/ui/StatePanel';
import { OperationFeedback } from '../../components/ui/OperationFeedback';
import { useBoundedRead } from '../../lib/api/use-bounded-read';
import { resolveReturnTo } from '../../lib/return-to';
import { hasPermission } from '../../lib/permissions';
import { useAuth } from '../../providers/AuthProvider';
import { useI18n } from '../../providers/I18nProvider';
import { NotificationSettingsDialog } from '../nf-alerts/NotificationSettingsDialog';
import { acknowledgeDrift, configInvestigationEntry, driftAlertPath, driftLink, driftListPath, driftPolicyPath, type DriftAlert, type DriftEvent, type DriftList, type DriftPage, type DriftPolicyView } from './config-drift-api';
import { DriftStatus } from './DriftPolicyPanel';
import styles from '../../styles/modules/config-drift.module.css';
const keys=['state','severity','sourceId','resourceId','networkKey','siteResourceId','hostResourceId','operatorName','plmn'] as const;
function DriftDirectory(){
 const {t,formatDateTime}=useI18n();const [params,setParams]=useSearchParams();const location=useLocation();const read=useBoundedRead<DriftList>(driftListPath(params));const data=read.error?undefined:read.data;
 const submit=(e:FormEvent<HTMLFormElement>)=>{e.preventDefault();const form=new FormData(e.currentTarget);const next=new URLSearchParams(params);next.delete('cursor');for(const k of keys){const v=String(form.get(k)||'').trim();if(v)next.set(k,v);else next.delete(k);}setParams(next);};
 const page=(cursor:string)=>{const next=new URLSearchParams(params);if(cursor)next.set('cursor',cursor);else next.delete('cursor');setParams(next);};
 return <div className={styles.workspace}>
 <MetricStrip ariaLabel={t('drift_summary')} items={['active','acknowledged','resolved'].map(k=>({key:k,label:t('drift_'+k),value:data?.summary?.[k]??t('evidence_unavailable'),detail:t('drift_summary_scope')}))}/>
 <section className={styles.panel}><div className={styles.content}><form className={styles.filters} key={location.search} onSubmit={submit}>
 <Field htmlFor="drift-state" label={t('drift_state')}><select id="drift-state" name="state" className="form-input" defaultValue={params.get('state')||'open'}>{['open','active','acknowledged','resolved','all'].map(v=><option key={v} value={v}>{t('drift_'+v)}</option>)}</select></Field>
 <Field htmlFor="drift-severity" label={t('drift_severity')}><select id="drift-severity" name="severity" className="form-input" defaultValue={params.get('severity')||''}><option value="">{t('drift_all')}</option>{['critical','warning','info'].map(v=><option key={v} value={v}>{t('nf_alerts_severity_'+v)}</option>)}</select></Field>
 <Field htmlFor="drift-source" label={t('config_source_id')}><input id="drift-source" name="sourceId" className="form-input" defaultValue={params.get('sourceId')||''} maxLength={36}/></Field>
 <Field htmlFor="drift-resource" label={t('config_resource')}><input id="drift-resource" name="resourceId" className="form-input" defaultValue={params.get('resourceId')||''} maxLength={36}/></Field>
 <Field htmlFor="drift-site" label={t('drift_site')}><input id="drift-site" name="siteResourceId" className="form-input" defaultValue={params.get('siteResourceId')||''} maxLength={36}/></Field>
 <Field htmlFor="drift-network" label={t('drift_network')}><input id="drift-network" name="networkKey" className="form-input" defaultValue={params.get('networkKey')||''} maxLength={64}/></Field>
 <details><summary>{t('drift_more_scope')}</summary>{['hostResourceId','operatorName','plmn'].map(k=><Field key={k} htmlFor={'drift-scope-'+k} label={t('drift_'+k)}><input id={'drift-scope-'+k} name={k} className="form-input" defaultValue={params.get(k)||''} maxLength={k==='operatorName'?128:36}/></Field>)}</details>
 <div className={styles.actions}><button className="btn btn-primary" type="submit">{t('search')}</button><button className="btn btn-secondary" type="button" onClick={()=>setParams({view:'config'})}>{t('drift_clear')}</button></div></form><p className={styles.note}>{t('drift_scope_note')}</p></div>
 {read.isLoading?<LoadingState label={t('loading')}/>:read.error?<ErrorState title={t('drift_read_failed')} message={t('drift_retry')} retryLabel={t('refresh')} onRetry={()=>void read.mutate()}/>:data&&!data.items.length?<EmptyState title={t('drift_empty')} description={t('drift_empty_hint')}/>:data?<div className={styles.tableWrap}><table className={styles.table}><caption>{t('drift_list_caption')}</caption><thead><tr><th>{t('config_source')}</th><th>{t('drift_state')}</th><th>{t('drift_severity')}</th><th>{t('drift_opened_at')}</th><th>{t('drift_last_verified')}</th></tr></thead><tbody>{data.items.map(a=><tr key={a.driftAlertId}><td><Link to={driftLink(a.driftAlertId,location.pathname+location.search)}>{a.sourceName}</Link><small>{a.resourceId}</small></td><td><DriftStatus value={a.state}/>{a.endReason?<small>{t('drift_'+a.endReason)}</small>:null}</td><td>{t('nf_alerts_severity_'+a.severity)}</td><td>{formatDateTime(a.openedAt,EVIDENCE_TIME_FORMAT)}</td><td>{formatDateTime(a.latest.at,EVIDENCE_TIME_FORMAT)}<small>{t('drift_observations',{count:a.triggerCount})}</small></td></tr>)}</tbody></table></div>:null}
 {data?.completeness==='partial'?<OperationFeedback tone="warning" message={t('drift_partial')}/>:null}
 {data?<CursorPagination summary={t('drift_page',{count:data.items.length})} previousLabel={t('evidence_first_page')} nextLabel={t('next')} hasPrevious={params.has('cursor')} hasNext={data.hasMore} onPrevious={()=>page('')} onNext={()=>page(data.nextCursor||'')}/>:null}
 </section></div>;
}
function DriftDetail({id}:{id:string}){
 const {t,formatDateTime}=useI18n();const {user}=useAuth();const location=useLocation();const [params,setParams]=useSearchParams();const read=useBoundedRead<DriftAlert>(driftAlertPath(id));const a=read.error?undefined:read.data;
 const policy=useBoundedRead<DriftPolicyView>(a?driftPolicyPath(a.sourceId):null,5000);
 const events=useBoundedRead<DriftPage<DriftEvent>>(a?driftAlertPath(id)+'/events?'+new URLSearchParams({limit:'25',...(params.get('eventCursor')?{cursor:params.get('eventCursor')!}:{})}):null);
 const deliveries=useBoundedRead<{deliveries:{id:string;event:string;status:string;occurredAt:string;attempts:number}[];page:{hasMore:boolean;nextCursor:string|null}}>(a?'/api/nf-notifications/deliveries?'+new URLSearchParams({subjectKind:'config_drift',subjectId:id,limit:'20',...(params.get('deliveryCursor')?{cursor:params.get('deliveryCursor')!}:{})}):null);
 const [confirm,setConfirm]=useState(false);const [busy,setBusy]=useState(false);const [error,setError]=useState<string|null>(null);
 const ack=async()=>{if(!a||busy)return;setBusy(true);setError(null);try{await acknowledgeDrift(a);setConfirm(false);await Promise.allSettled([read.mutate(),events.mutate()]);}catch{setError(t('drift_ack_failed'));await read.mutate();}finally{setBusy(false);}};
 const setCursor=(key:string,value:string)=>{const next=new URLSearchParams(params);if(value)next.set(key,value);else next.delete(key);setParams(next);};
 const back=resolveReturnTo(location.search,'/nf-alerts?view=config',['/nf-alerts']);
 return <div className={styles.workspace}><div className={styles.actions}><Link className="btn btn-secondary" to={back}>{t('back')}</Link>{a?<><Link className="btn btn-secondary" to={'/config-snapshots/'+a.sourceId}>{t('drift_source_detail')}</Link><Link className="btn btn-primary" to={configInvestigationEntry(id,location.pathname+location.search)}>{t('drift_investigate')}</Link>{a.state==='active'&&hasPermission(user,'core.configure')?<button type="button" className="btn btn-secondary" disabled={busy} onClick={()=>setConfirm(true)}>{t('drift_acknowledge')}</button>:null}</>:null}</div>
 {error?<OperationFeedback tone="danger" message={error}/>:null}
 {read.isLoading?<LoadingState label={t('loading')}/>:read.error?<ErrorState title={t('drift_read_failed')} message={t('drift_retry')} retryLabel={t('refresh')} onRetry={()=>void read.mutate()}/>:a?<>
 <section className={styles.panel}><div className={styles.head}><h2>{a.sourceName}</h2><DriftStatus value={a.state}/></div><div className={styles.content}><p className={styles.note}>{t('drift_episode_hint')}</p><dl className={styles.facts}>
 <div><dt>{t('drift_severity')}</dt><dd>{t('nf_alerts_severity_'+a.severity)}<small>{t('drift_policy_revision',{revision:a.policyRevision})}</small></dd></div><div><dt>{t('drift_baseline_cycle')}</dt><dd>{a.baselineRevision}<small className={styles.identity}>{a.baselineId}</small></dd></div><div><dt>{t('drift_opened_at')}</dt><dd>{formatDateTime(a.openedAt,EVIDENCE_TIME_FORMAT)}</dd></div><div><dt>{t('drift_last_verified')}</dt><dd>{formatDateTime(a.latest.at,EVIDENCE_TIME_FORMAT)}<small>{t('drift_observations',{count:a.triggerCount})}</small></dd></div><div><dt>{t('drift_reason')}</dt><dd>{a.endReason?t('drift_'+a.endReason):t('drift_still_open')}</dd></div><div><dt>{t('config_resource')}</dt><dd><Link to={'/inventory/'+a.resourceId}>{a.resourceId}</Link></dd></div></dl>
 <div className={styles.actions}>{[['trigger',a.trigger.snapshotId],['latest',a.latest.snapshotId]].map(([kind,snapshot])=><Link key={kind} className="btn btn-secondary" to={'/config-snapshots/'+a.sourceId+'?'+new URLSearchParams({view:'diff',left:a.baselineId,right:snapshot})}>{t('drift_diff_'+kind)}</Link>)}</div>
 {policy.error?<OperationFeedback tone="warning" message={t('drift_evaluation_unavailable')}/>:policy.data?<p className={styles.note}>{t('drift_current_evaluation')}: {t('drift_'+policy.data.evaluation.state)} / {t('drift_'+policy.data.freshness)}. {t('drift_cycle_note')}</p>:null}
 {a.latest.comparison==='unprojected_changed'?<OperationFeedback tone="info" message={t('drift_unprojected_hint')}/>:null}
 </div></section>
 <section className={styles.panel}><div className={styles.head}><h2>{t('drift_events')}</h2></div><div className={styles.content}>
 {events.error?<ErrorState title={t('drift_read_failed')} message={t('drift_retry')} retryLabel={t('refresh')} onRetry={()=>void events.mutate()}/>:events.isLoading?<LoadingState label={t('loading')}/>:events.data?<><ul className={styles.events}>{events.data.items.map(e=><li key={e.eventId}><strong>{t('drift_event_'+e.kind)}</strong><time dateTime={e.at}>{formatDateTime(e.at,EVIDENCE_TIME_FORMAT)}</time>{e.reason?<span>{t('drift_'+e.reason)}</span>:null}{e.actor?<span>{e.actor}</span>:null}</li>)}</ul><CursorPagination summary={t('drift_page',{count:events.data.items.length})} previousLabel={t('evidence_first_page')} nextLabel={t('next')} hasPrevious={params.has('eventCursor')} hasNext={events.data.hasMore} onPrevious={()=>setCursor('eventCursor','')} onNext={()=>setCursor('eventCursor',events.data?.nextCursor||'')}/></>:null}</div></section>
 <section className={styles.panel}><div className={styles.head}><h2>{t('drift_deliveries')}</h2></div><div className={styles.content}>{deliveries.error?<ErrorState title={t('drift_read_failed')} message={t('drift_retry')} retryLabel={t('refresh')} onRetry={()=>void deliveries.mutate()}/>:deliveries.isLoading?<LoadingState label={t('loading')}/>:deliveries.data?.deliveries?.length?<><ul className={styles.events}>{deliveries.data.deliveries.map(d=><li key={d.id}><strong>{t('drift_event_'+d.event)}</strong><span>{t('nf_notify_status_'+d.status)} / {t('drift_attempts',{count:d.attempts})}</span><time dateTime={d.occurredAt}>{formatDateTime(d.occurredAt,EVIDENCE_TIME_FORMAT)}</time></li>)}</ul><CursorPagination summary={t('drift_page',{count:deliveries.data.deliveries.length})} previousLabel={t('evidence_first_page')} nextLabel={t('next')} hasPrevious={params.has('deliveryCursor')} hasNext={deliveries.data.page.hasMore} onPrevious={()=>setCursor('deliveryCursor','')} onNext={()=>setCursor('deliveryCursor',deliveries.data?.page.nextCursor||'')}/></>:<EmptyState title={t('drift_no_deliveries')} description={t('drift_subscription_hint')}/>}</div></section>
 </>:null}
 <Dialog open={confirm} onClose={()=>{if(!busy)setConfirm(false);}} ariaLabel={t('drift_acknowledge')} overlayClassName="modal-overlay" className="modal-content"><div className={styles.confirm}><h2>{t('drift_acknowledge')}</h2><p>{t('drift_ack_hint')}</p>{error?<OperationFeedback tone="danger" message={error}/>:null}<div className={styles.actions}><button type="button" className="btn btn-secondary" disabled={busy} onClick={()=>setConfirm(false)}>{t('cancel')}</button><button type="button" className="btn btn-primary" disabled={busy} onClick={()=>void ack()}>{t('confirm')}</button></div></div></Dialog>
 </div>;
}
export function ConfigDriftWorkspace(){
 const {t}=useI18n();const {user}=useAuth();const {mutate}=useSWRConfig();const [params,setParams]=useSearchParams();const [notify,setNotify]=useState(false);const id=params.get('driftAlertId');const meta=useBoundedRead<{workerRunning:boolean;lastError:string}>('/api/config-drift/meta',5000);
 return <OperationsPageFrame title={t('nf_alerts_title')} description={t('drift_description')} icon={<BellRing size={23}/>} viewSwitch={<ViewSwitch value="config" ariaLabel={t('nf_alerts_view_label')} options={['open','history','rules','config'].map(value=>({value,label:t(value==='config'?'drift_view':'nf_alerts_view_'+value)}))} onChange={value=>setParams({view:value})}/>} onRefresh={async()=>{await mutate(key=>typeof key==='string'&&(key.startsWith('/api/config-drift/')||key.startsWith('/api/nf-notifications/deliveries')));}} actions={hasPermission(user,'core.configure')?<button className="btn btn-secondary" type="button" onClick={()=>setNotify(true)}>{t('nf_notify_title')}</button>:undefined}>
 {meta.error||(meta.data&&(!meta.data.workerRunning||meta.data.lastError))?<OperationFeedback tone="warning" message={t('drift_worker_stopped')}/>:null}{id?<DriftDetail key={id} id={id}/>:<DriftDirectory/>}<NotificationSettingsDialog open={notify} onClose={()=>setNotify(false)} onChanged={()=>{}} subjectKind="config_drift"/>
 </OperationsPageFrame>;
}
