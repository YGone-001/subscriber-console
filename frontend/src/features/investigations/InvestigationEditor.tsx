import { EVIDENCE_TIME_FORMAT } from '../../lib/evidence-time';
import { useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Field } from '../../components/ui/Field';
import { Dialog } from '../../components/ui/Dialog';
import { OperationFeedback } from '../../components/ui/OperationFeedback';
import { UnsavedChangesDialog, useUnsavedChangesGuard } from '../../components/ui/UnsavedChangesGuard';
import { MutationApiError, patchJson } from '../../lib/api/mutation-client';
import { useI18n } from '../../providers/I18nProvider';
import { draftFor, type InvestigationRecord, type KnowledgeFact, type RecordView } from './investigation-model';
import { useInvestigationRead } from './use-investigation-read';
import styles from '../../styles/modules/investigations.module.css';

function KnowledgePicker({ids,known,onChange,disabled}:{ids:string[];known:KnowledgeFact[];onChange:(ids:string[])=>void;disabled:boolean}) {
  const {t}=useI18n();const [search,setSearch]=useState('');const [query,setQuery]=useState<string|null>(null);
  const read=useInvestigationRead<{entries:KnowledgeFact[]}>(query);const entries=read.error?[]:read.data?.entries||[];
  const all=new Map([...known,...entries].map(k=>[k.id,k]));
  const searchKnowledge=()=>{const next=`/api/knowledge/entries?${new URLSearchParams({q:search.trim(),limit:'10'})}`;if(next===query)void read.mutate();else setQuery(next);};
  return <div className={styles.knowledge}>
    <Field htmlFor="investigation-knowledge" label={t('inv_knowledge_search')}><input id="investigation-knowledge" className="form-input" value={search} onChange={e=>setSearch(e.target.value)} maxLength={160} disabled={disabled} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();searchKnowledge();}}}/></Field>
    <button type="button" className="btn btn-secondary" disabled={disabled||read.isLoading} onClick={searchKnowledge}>{t('inv_knowledge_find')}</button>
    {read.error?<p role="status">{t('inv_load_error')}</p>:null}
    {query&&!read.isLoading&&!read.error&&!entries.length?<p className={styles.note}>{t('inv_knowledge_empty')}</p>:null}
    <ul>{Array.from(new Set([...ids,...entries.map(k=>k.id)])).map(id=><li key={id}>
      <input id={`knowledge-${id}`} type="checkbox" checked={ids.includes(id)} disabled={disabled||(!ids.includes(id)&&ids.length>=8)} onChange={e=>onChange(e.target.checked?[...ids,id].sort():ids.filter(v=>v!==id))}/>
      <label htmlFor={`knowledge-${id}`}>{all.get(id)?.title||t('inv_knowledge_removed')} {all.get(id)?<Link to={`/knowledge/${id}`} target="_blank" rel="noopener noreferrer">{t('inv_knowledge_open')}</Link>:<span className={styles.identity}>{id}</span>}</label>
    </li>)}</ul><p className={styles.note}>{t('inv_knowledge_limit')}</p>
  </div>;
}
export function InvestigationEditor({view,canWrite,readError,onReload,onSaved}:{view:RecordView;canWrite:boolean;readError:boolean;onReload:()=>Promise<RecordView|undefined>;onSaved:(record:InvestigationRecord)=>void}) {
  const {t,formatDateTime}=useI18n();const [saved,setSaved]=useState(view.record);const [draft,setDraft]=useState(()=>draftFor(view.record));
  const [busy,setBusy]=useState(false);const [conflict,setConflict]=useState(false);const [confirm,setConfirm]=useState<'resolve'|'reload'|null>(null);
  const [feedback,setFeedback]=useState<{tone:'success'|'danger'|'warning';message:string}|null>(null);const cancelRef=useRef<HTMLButtonElement>(null);
  const dirty=JSON.stringify(draft)!==JSON.stringify(draftFor(saved));
  const guard=useUnsavedChangesGuard(dirty,()=>{setDraft(draftFor(saved));});
  const newer=view.record.revision>saved.revision;
  const disabled=!canWrite||readError||busy;
  const save=async()=>{
    if(disabled||conflict||newer)return;setConfirm(null);setBusy(true);setFeedback(null);
    try {const record=await patchJson<InvestigationRecord>(`/api/investigations/${saved.investigationId}`,{expectedRevision:saved.revision,...draft});setSaved(record);setDraft(draftFor(record));setConflict(false);setFeedback({tone:'success',message:t('inv_saved')});onSaved(record);}
    catch(error){const collision=error instanceof MutationApiError&&error.status===409;setConflict(collision);setFeedback({tone:collision?'warning':'danger',message:t(collision?'inv_conflict':'inv_save_error')});}
    finally {setBusy(false);}
  };
  const reload=async()=>{
    setConfirm(null);setBusy(true);
    try {const fresh=await onReload();if(fresh){setSaved(fresh.record);setDraft(draftFor(fresh.record));setConflict(false);setFeedback(null);}else setFeedback({tone:'danger',message:t('inv_record_read_error')});}
    catch{setFeedback({tone:'danger',message:t('inv_record_read_error')});}finally{setBusy(false);}
  };
  const submit=(event:FormEvent)=>{
    event.preventDefault();if(draft.status==='resolved'&&draft.conclusion.trim().length<3){setFeedback({tone:'warning',message:t('inv_conclusion_required')});return;}
    if(draft.status==='resolved'&&saved.status!=='resolved')setConfirm('resolve');else void save();
  };
  return <section className={styles.panel} aria-label={t('inv_human_record')}>
    <h2>{t('inv_human_record')}</h2><p className={styles.note}>{t('inv_manual_note')}</p>
    <dl className={styles.facts}><div><dt>{t('inv_revision')}</dt><dd>{saved.revision}</dd></div><div><dt>{t('inv_actor')}</dt><dd>{saved.updatedBy}</dd></div><div><dt>{t('inv_updated')}</dt><dd>{formatDateTime(saved.updatedAt,EVIDENCE_TIME_FORMAT)}</dd></div></dl>
    {!canWrite?<p className={styles.note}>{t('inv_readonly')}</p>:null}{readError?<p role="status" className={styles.warning}>{t('inv_record_read_error')}</p>:null}
    {newer&&!conflict?<p role="status" className={styles.warning}>{t('inv_conflict')}</p>:null}
    {feedback?<OperationFeedback tone={feedback.tone} message={feedback.message}/>:null}
    <form className={styles.form} onSubmit={submit}>
      <Field htmlFor="investigation-title" label={t('inv_record_title')}><input id="investigation-title" className="form-input" value={draft.title} onChange={e=>setDraft(d=>({...d,title:e.target.value}))} maxLength={160} required disabled={disabled}/></Field>
      <Field htmlFor="investigation-status" label={t('inv_status')}><select id="investigation-status" className="form-input" value={draft.status} onChange={e=>setDraft(d=>({...d,status:e.target.value}))} disabled={disabled}>{['open','investigating','resolved'].map(status=><option key={status} value={status}>{t(`inv_state_${status}`)}</option>)}</select></Field>
      <Field htmlFor="investigation-notes" label={t('inv_notes')}><textarea id="investigation-notes" className="form-input" value={draft.notes} onChange={e=>setDraft(d=>({...d,notes:e.target.value}))} maxLength={2048} disabled={disabled}/></Field>
      <Field htmlFor="investigation-conclusion" label={t('inv_conclusion')}><textarea id="investigation-conclusion" className="form-input" value={draft.conclusion} onChange={e=>setDraft(d=>({...d,conclusion:e.target.value}))} maxLength={1024} disabled={disabled} required={draft.status==='resolved'}/></Field>
      <p className={styles.note}>{t('inv_note_privacy')}</p><h3>{t('inv_knowledge')}</h3>
      {view.knowledgeCoverage.state!=='complete'?<p className={styles.warning}>{t('inv_reason_reference_missing')}</p>:null}
      <KnowledgePicker ids={draft.knowledgeIds} known={view.knowledge} onChange={knowledgeIds=>setDraft(d=>({...d,knowledgeIds}))} disabled={disabled}/>
      {canWrite?<div className={styles.toolbar}><button type="submit" className="btn btn-primary" disabled={disabled||!dirty||conflict||newer}>{t(busy?'inv_saving':'inv_save')}</button><button type="button" className="btn btn-secondary" disabled={busy} onClick={()=>dirty?setConfirm('reload'):void reload()}>{t('inv_reload')}</button></div>:null}
    </form>
    <details><summary>{t('inv_recent')}</summary><ol>{saved.recentChanges.map(change=><li key={change.revision}>{formatDateTime(change.at,EVIDENCE_TIME_FORMAT)} &middot; {change.actor} &middot; {t(`inv_state_${change.status}`)} &middot; {change.revision}</li>)}</ol></details>
    <Dialog open={confirm!==null} onClose={()=>setConfirm(null)} initialFocusRef={cancelRef} ariaLabel={t(confirm==='reload'?'inv_draft_title':'inv_resolve_title')} className={styles.confirm} overlayClassName={styles.confirmOverlay}>
      <h2>{t(confirm==='reload'?'inv_draft_title':'inv_resolve_title')}</h2><p>{t(confirm==='reload'?'inv_draft_hint':'inv_resolve_hint')}</p><div className={styles.toolbar}><button ref={cancelRef} type="button" className="btn btn-secondary" onClick={()=>setConfirm(null)}>{t('inv_cancel')}</button><button type="button" className="btn btn-primary" onClick={()=>void(confirm==='reload'?reload():save())}>{t(confirm==='reload'?'inv_discard':'inv_confirm')}</button></div>
    </Dialog>
    <UnsavedChangesDialog open={guard.isPromptOpen} title={t('inv_draft_title')} description={t('inv_draft_hint')} keepEditingLabel={t('inv_cancel')} discardLabel={t('inv_discard')} onKeepEditing={guard.keepEditing} onDiscard={guard.discardChanges}/>
  </section>;
}
