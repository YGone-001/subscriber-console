import { EVIDENCE_TIME_FORMAT } from '../../lib/evidence-time';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Field } from '../../components/ui/Field';
import { EmptyState, ErrorState, LoadingState } from '../../components/ui/StatePanel';
import { OperationFeedback } from '../../components/ui/OperationFeedback';
import { UnsavedChangesDialog, useUnsavedChangesGuard } from '../../components/ui/UnsavedChangesGuard';
import { useI18n } from '../../providers/I18nProvider';
import { useBoundedRead } from '../../lib/api/use-bounded-read';
import { driftLink, driftPolicyPath, saveDriftPolicy, type DriftPolicyView } from './config-drift-api';
import styles from '../../styles/modules/config-drift.module.css';
export function DriftStatus({value}:{value:string}){const {t}=useI18n();return <span className={styles.badge} data-state={value}>{t('drift_'+value)}</span>;}
function PolicyEditor({data,onSaved,readError}:{data:DriftPolicyView;readError:boolean;onSaved:()=>Promise<unknown>}){
 const {t}=useI18n();const [enabled,setEnabled]=useState(data.policy.enabled);const [severity,setSeverity]=useState(data.policy.severity);const [revision,setRevision]=useState(data.policy.revision);const [busy,setBusy]=useState(false);const [message,setMessage]=useState<string|null>(null);const [failed,setFailed]=useState(false);
 const dirty=enabled!==data.policy.enabled||severity!==data.policy.severity;
 const guard=useUnsavedChangesGuard(dirty,()=>{setEnabled(data.policy.enabled);setSeverity(data.policy.severity);setRevision(data.policy.revision);});
 const submit=async(e:FormEvent)=>{e.preventDefault();if(busy||readError)return;setBusy(true);setMessage(null);try{const next=await saveDriftPolicy(data.sourceId,revision,enabled,severity);setRevision(next.policy.revision);setFailed(false);setMessage(t('drift_saved'));await onSaved();}catch{setFailed(true);setMessage(t('drift_save_failed'));await onSaved();}finally{setBusy(false);}};
 return <><form className={styles.policyForm} onSubmit={submit}><Field htmlFor="drift-policy-enabled" label={t('drift_policy')} description={t('drift_policy_hint')}><label className={styles.check}><input id="drift-policy-enabled" type="checkbox" checked={enabled} disabled={busy||!data.registered||(!enabled&&data.resourceState!=='valid')} onChange={e=>setEnabled(e.target.checked)}/>{t('drift_enable')}</label></Field><Field htmlFor="drift-policy-severity" label={t('drift_severity')} description={t('drift_severity_hint')}><select id="drift-policy-severity" className="form-input" value={severity} disabled={busy} onChange={e=>setSeverity(e.target.value)}>{['warning','critical','info'].map(v=><option key={v} value={v}>{t('nf_alerts_severity_'+v)}</option>)}</select></Field><button className="btn btn-primary" type="submit" disabled={busy||readError||!dirty||!data.registered}>{t(busy?'saving':'save')}</button></form>
 {data.policy.revision!==revision?<p role="status" className={styles.note}>{t('drift_policy_conflict')} {t(data.policy.enabled?'drift_policy_enabled':'drift_policy_disabled')} / {t('nf_alerts_severity_'+data.policy.severity)} / {t('inv_revision')}: {data.policy.revision}. <button type="button" className="btn btn-secondary" disabled={busy} onClick={()=>{setRevision(data.policy.revision);setMessage(null);}}>{t('drift_use_revision')}</button></p>:null}
 {message?<OperationFeedback tone={failed?'danger':'success'} message={message}/>:null}
 <UnsavedChangesDialog open={guard.isPromptOpen} title={t('drift_draft_title')} description={t('drift_draft_hint')} keepEditingLabel={t('inv_cancel')} discardLabel={t('inv_discard')} onKeepEditing={guard.keepEditing} onDiscard={guard.discardChanges}/></>;
}
export function DriftPolicyPanel({sourceId,canConfigure}:{sourceId:string;canConfigure:boolean}){
 const {t,formatDateTime}=useI18n();const read=useBoundedRead<DriftPolicyView>(driftPolicyPath(sourceId),5000);const data=read.error?undefined:read.data;
 return <section className={styles.panel} aria-label={t('drift_policy_title')}><div className={styles.head}><h2>{t('drift_policy_title')}</h2>{data?<DriftStatus value={data.evaluation.state}/>:null}</div>
 {read.isLoading?<LoadingState label={t('loading')}/>:read.error?<ErrorState title={t('drift_read_failed')} message={t('drift_retry')} retryLabel={t('refresh')} onRetry={()=>void read.mutate()}/>:!data?<EmptyState title={t('drift_no_evaluation')}/>:<div className={styles.content}>
 <p className={styles.note}>{t('drift_scope_note')}</p>
 <dl className={styles.facts}><div><dt>{t('drift_last_verified')}</dt><dd>{data.evaluation.lastVerified?formatDateTime(data.evaluation.lastVerified.at,EVIDENCE_TIME_FORMAT):t('drift_no_evaluation')}<small>{t('drift_'+data.freshness)}</small></dd></div><div><dt>{t('drift_baseline_cycle')}</dt><dd>{data.baselineId?data.baselineRevision:t('drift_no_baseline')}</dd></div><div><dt>{t('drift_progress')}</dt><dd>{data.evaluation.processedSequence} / {data.publishedSequence}<small>{t('drift_queued',{count:data.queuedInputs})}</small></dd></div></dl>
 {data.publicationPending||data.queuedInputs>0?<OperationFeedback tone="warning" message={t('drift_pending_hint')}/>:null}
 {!data.baselineId?<OperationFeedback tone="info" message={t('drift_baseline_hint')}/>:null}
 {data.resourceState!=='valid'?<OperationFeedback tone="warning" message={t('drift_binding_hint')}/>:null}
 {data.evaluation.reason?<p className={styles.note}>{t('drift_reason')}: {t('drift_'+data.evaluation.reason)}</p>:null}
 <div className={styles.actions}><Link className="btn btn-secondary" to={'/nf-alerts?'+new URLSearchParams({view:'config',sourceId:data.sourceId})}>{t('drift_source_alerts')}</Link>{data.openAlertId?<Link className="btn btn-secondary" to={driftLink(data.openAlertId)}>{t('drift_open_alert')}</Link>:null}</div>
 {!canConfigure?<p className={styles.note}>{t('drift_readonly')}</p>:null}
 </div>}{canConfigure&&read.data?<div className={styles.content}><PolicyEditor key={sourceId} data={read.data} readError={Boolean(read.error)} onSaved={()=>read.mutate()}/></div>:null}</section>;
}
