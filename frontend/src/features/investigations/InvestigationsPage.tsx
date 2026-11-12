import { EVIDENCE_TIME_FORMAT } from '../../lib/evidence-time';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { SearchCheck } from 'lucide-react';
import { OperationsPageFrame } from '../operations/OperationsPageFrame';
import MetricStrip from '../../components/ui/MetricStrip';
import { CursorPagination } from '../../components/ui/CursorPagination';
import { Field } from '../../components/ui/Field';
import { EmptyState, ErrorState, LoadingState } from '../../components/ui/StatePanel';
import { OperationFeedback } from '../../components/ui/OperationFeedback';
import { postJson } from '../../lib/api/mutation-client';
import { hasPermission } from '../../lib/permissions';
import { useAuth } from '../../providers/AuthProvider';
import { useI18n } from '../../providers/I18nProvider';
import { alertReturn, contextPath, investigationEntry, investigationListPath, investigationReturn, localTime, recordLink, type InvestigationContext, type InvestigationList, type InvestigationRecord, type RecordView } from './investigation-model';
import { useInvestigationRead } from './use-investigation-read';
import { InvestigationCoverage, InvestigationRelations, InvestigationTimeline } from './InvestigationEvidence';
import { InvestigationEditor } from './InvestigationEditor';
import styles from '../../styles/modules/investigations.module.css';

function InvestigationWindowForm({from,to,onSubmit}:{from:string;to:string;onSubmit:(event:FormEvent<HTMLFormElement>)=>void}) {
 const {t}=useI18n();
 return <><form className={styles.window} onSubmit={onSubmit}><Field htmlFor="investigation-from" label={t('inv_from')}><input id="investigation-from" name="from" className="form-input" type="datetime-local" step="1" defaultValue={localTime(from)} required/></Field><Field htmlFor="investigation-to" label={t('inv_to')}><input id="investigation-to" name="to" className="form-input" type="datetime-local" step="1" defaultValue={localTime(to)} required/></Field><button className="btn btn-secondary" type="submit">{t('inv_apply')}</button></form><p className={styles.note}>{t('inv_window_hint')}</p></>;
}
function InvestigationDirectory(){
  const {t,formatDateTime}=useI18n();const [params,setParams]=useSearchParams();const location=useLocation();const path=investigationListPath(params);const read=useInvestigationRead<InvestigationList>(path);const data=read.error?undefined:read.data;
  const filter=(event:FormEvent<HTMLFormElement>)=>{event.preventDefault();const form=new FormData(event.currentTarget);const next=new URLSearchParams(params);next.delete('cursor');for(const key of ['q','status']){const value=String(form.get(key)||'').trim();if(value)next.set(key,value);else next.delete(key);}setParams(next);};
  return <OperationsPageFrame title={t('inv_title')} description={t('inv_description')} icon={<SearchCheck size={20}/>} onRefresh={()=>read.mutate().then(()=>undefined)} actions={<Link className="btn btn-primary" to="/nf-alerts">{t('inv_open_alerts')}</Link>}>
    <div className={styles.workspace}><p className={styles.note}>{t('inv_directory_hint')}</p>{['resourceId','alertId'].filter(key=>params.has(key)).map(key=><p key={key} className={styles.note}>{t(key==='resourceId'?'inv_resource':'inv_alert')}: <code className={styles.identity}>{params.get(key)}</code></p>)}
      <form key={`${params.get('q')||''}:${params.get('status')||''}`} className={styles.filters} onSubmit={filter}><Field htmlFor="investigation-search" label={t('inv_search')}><input id="investigation-search" name="q" className="form-input" maxLength={160} defaultValue={params.get('q')||''}/></Field><Field htmlFor="investigation-filter-status" label={t('inv_status')}><select id="investigation-filter-status" className="form-input" name="status" defaultValue={params.get('status')||''}><option value="">{t('inv_all')}</option>{['open','investigating','resolved'].map(s=><option key={s} value={s}>{t(`inv_state_${s}`)}</option>)}</select></Field><button className="btn btn-primary" type="submit">{t('inv_apply')}</button><button className="btn btn-secondary" type="button" onClick={()=>setParams({})}>{t('inv_clear')}</button></form>
      {read.isLoading?<LoadingState label={t('loading')}/>:null}{read.error?<ErrorState title={t('inv_load_error')} message={t('inv_retry')} retryLabel={t('refresh')} onRetry={()=>void read.mutate()}/>:null}
      {data&&!data.items.length?<EmptyState title={t('inv_empty')} description={t('inv_empty_hint')}/>:null}
      {data?.items.length?<div className={styles.tableWrap}><table className={styles.table}><caption>{t('inv_records')}</caption><thead><tr><th>{t('inv_record_title')}</th><th>{t('inv_status')}</th><th>{t('inv_updated')}</th><th>{t('inv_actor')}</th></tr></thead><tbody>{data.items.map(item=><tr key={item.investigationId}><td><Link to={recordLink(item.investigationId,location.pathname+location.search)}>{item.title}</Link><small className={styles.identity}>{item.resourceId||t('inv_unknown')}</small></td><td>{t(`inv_state_${item.status}`)}</td><td>{formatDateTime(item.updatedAt)}</td><td>{item.updatedBy}</td></tr>)}</tbody></table></div>:null}
      {data?<CursorPagination summary={t('inv_page',{count:data.items.length})} previousLabel={t('inv_first')} nextLabel={t('inv_next')} hasPrevious={params.has('cursor')} hasNext={data.hasMore} onPrevious={()=>{const next=new URLSearchParams(params);next.delete('cursor');setParams(next);}} onNext={()=>{if(data.nextCursor){const next=new URLSearchParams(params);next.set('cursor',data.nextCursor);setParams(next);}}}/>:null}
    </div>
  </OperationsPageFrame>;
}
function InvestigationWorkspace({id}:{id?:string}){
  const {t,formatDateTime}=useI18n();const {user}=useAuth();const canWrite=hasPermission(user,'core.configure');const [params,setParams]=useSearchParams();const location=useLocation();const navigate=useNavigate();
  const savedRead=useInvestigationRead<RecordView>(id?`/api/investigations/${encodeURIComponent(id)}`:null);const saved=savedRead.data?.record;
  const alertId=saved?.alertId||(!id?params.get('alertId')||'':'');const from=saved?.from||params.get('from')||'';const to=saved?.to||params.get('to')||'';
  const path=contextPath(alertId,from,to,id);const evidence=useInvestigationRead<InvestigationContext>(path);const data=evidence.error?undefined:evidence.data;
  const [title,setTitle]=useState('');const [busy,setBusy]=useState(false);const [error,setError]=useState<string|null>(null);const request=useRef<{id:string;signature:string}|null>(null);const recordArea=useRef<HTMLElement>(null);
  useEffect(()=>{if(!id&&data&&!params.has('from')&&!params.has('to')){const next=new URLSearchParams(params);next.set('from',data.from);next.set('to',data.to);setParams(next,{replace:true});}},[data,id,params,setParams]);
  const refresh=useCallback(async()=>{await Promise.allSettled([evidence.mutate(),savedRead.mutate()]);},[evidence,savedRead]);
  const updateWindow=(event:FormEvent<HTMLFormElement>)=>{event.preventDefault();const form=new FormData(event.currentTarget);const a=new Date(String(form.get('from')||''));const b=new Date(String(form.get('to')||''));if(!Number.isFinite(a.getTime())||!Number.isFinite(b.getTime())||b<=a||b.getTime()-a.getTime()>86400000||b.getTime()>Date.now()){setError(t('inv_window_error'));return;}const next=new URLSearchParams(params);next.set('from',a.toISOString());next.set('to',b.toISOString());setError(null);setParams(next);};
  const create=async(event:FormEvent)=>{event.preventDefault();if(!data||busy||!canWrite)return;setBusy(true);setError(null);const payload={alertId,title:title.trim()||data.anchor.name,from:data.from,to:data.to};const signature=JSON.stringify(payload);if(request.current?.signature!==signature)request.current={id:crypto.randomUUID(),signature};try{const record=await postJson<InvestigationRecord>('/api/investigations',{requestId:request.current.id,...payload});navigate(recordLink(record.investigationId,location.pathname+location.search),{replace:true});}catch{setError(t('inv_create_error'));}finally{setBusy(false);}};
  const category=params.get('kind')||'all';
  return <OperationsPageFrame title={t('inv_title')} description={saved?.title||t('inv_preview')} icon={<SearchCheck size={20}/>} onRefresh={refresh} actions={<><button type="button" className="btn btn-secondary" disabled={!data&&!saved} onClick={()=>{recordArea.current?.scrollIntoView({block:'start'});recordArea.current?.focus({preventScroll:true});}}>{t('inv_jump_record')}</button><Link className="btn btn-secondary" to={id?investigationReturn(location.search):alertReturn(location.search)}>{t(id?'inv_back':'inv_back_alerts')}</Link></>}>
    <div className={styles.workspace}>
      {!id&&!path?<ErrorState title={t('inv_load_error')} message={t('inv_invalid_anchor')}/>:null}
      {savedRead.isLoading||evidence.isLoading?<LoadingState label={t('loading')}/>:null}
      {savedRead.error&&!saved?<ErrorState title={t('inv_load_error')} message={t('inv_record_read_error')}/>:null}
      {evidence.error?<><ErrorState title={t('inv_load_error')} message={t('inv_retry')} retryLabel={t('refresh')} onRetry={()=>void evidence.mutate()}/>{!id&&alertId?<section className={styles.panel}><h2>{t('inv_window')}</h2><InvestigationWindowForm key={path} from={from||new Date(Date.now()-3600000).toISOString()} to={to||new Date().toISOString()} onSubmit={updateWindow}/><Link to={investigationEntry(alertId)}>{t('inv_reset_window')}</Link></section>:null}</>:null}
      {error?<OperationFeedback tone="danger" message={error}/>:null}
      {data?<>
        <section className={styles.panel}><h2>{data.anchor.name}</h2><p className={styles.note}>{t('inv_scope_note')}</p>
          <p className={styles.windowSummary}><strong>{t('inv_window')}</strong><span>{formatDateTime(data.from,EVIDENCE_TIME_FORMAT)} - {formatDateTime(data.to,EVIDENCE_TIME_FORMAT)}</span></p>
          <details><summary>{t('inv_window_context')}</summary><dl className={styles.facts}><div><dt>{t('inv_alert')}</dt><dd className={styles.identity}>{data.anchor.alertId}</dd></div><div><dt>{t('inv_read_at')}</dt><dd>{formatDateTime(data.generatedAt,EVIDENCE_TIME_FORMAT)}</dd></div></dl>
            {!id?<InvestigationWindowForm key={path} from={data.from} to={data.to} onSubmit={updateWindow}/>:<Link to={investigationEntry(alertId)}>{t('inv_new_window')}</Link>}
          </details>
        </section>
        <InvestigationCoverage data={data} metrics={<MetricStrip ariaLabel={t('inv_evidence')} className={styles.metrics} items={[{key:'events',label:<span className={styles.metricLabel}>{t('inv_events_count')}</span>,value:data.events.length},{key:'resources',label:<span className={styles.metricLabel}>{t('inv_resources_count')}</span>,value:data.coverage.inventory.state==='unavailable'?'-':data.resources.length},{key:'changes',label:<span className={styles.metricLabel}>{t('inv_changes_count')}</span>,value:data.coverage.configuration.state==='unavailable'||data.coverage.configuration.state==='not_applicable'?'-':data.events.filter(e=>e.kind==='configuration'&&e.changed===true).length}]}/>}/>
      </>:null}
      <div className={styles.split}>
        <div className={styles.workspace}>{data?<><Field htmlFor="investigation-category" label={t('inv_category')}><select id="investigation-category" className="form-input" value={category} onChange={event=>{const next=new URLSearchParams(params);next.set('kind',event.target.value);setParams(next);}}>{['all','alerts','health','configuration'].map(kind=><option key={kind} value={kind}>{t(`inv_kind_${kind}`)}</option>)}</select></Field><InvestigationTimeline data={data} category={category}/></>:null}</div>
        <aside ref={recordArea} tabIndex={-1} aria-label={t('inv_human_record')} className={`${styles.workspace} ${styles.recordArea}`}>
          {id&&savedRead.data?<InvestigationEditor key={id} view={savedRead.data} canWrite={canWrite} readError={Boolean(savedRead.error)} onReload={()=>savedRead.mutate()} onSaved={()=>{void savedRead.mutate();}}/>:null}
          {!id&&data?<section className={styles.panel}><h2>{t('inv_human_record')}</h2><p className={styles.note}>{t('inv_create_hint')}</p>{canWrite?<form className={styles.form} onSubmit={create}><Field htmlFor="new-investigation-title" label={t('inv_record_title')}><input id="new-investigation-title" className="form-input" value={title} placeholder={data.anchor.name} onChange={e=>setTitle(e.target.value)} maxLength={160}/></Field><button type="submit" className="btn btn-primary" disabled={busy}>{t(busy?'inv_saving':'inv_create')}</button></form>:<p>{t('inv_readonly')}</p>}<p><Link to="/investigations">{t('inv_records')}</Link></p></section>:null}
          {data?<InvestigationRelations data={data}/>:null}
        </aside>
      </div>
    </div>
  </OperationsPageFrame>;
}
export function InvestigationsPage(){
  const {investigationId}=useParams();const [params]=useSearchParams();return investigationId||params.get('view')==='context'?<InvestigationWorkspace key={investigationId||params.get('alertId')} id={investigationId}/>:<InvestigationDirectory/>;
}
