import type { ReactNode } from 'react';
import { EVIDENCE_TIME_FORMAT } from '../../lib/evidence-time';
import { Link } from 'react-router-dom';
import { useI18n } from '../../providers/I18nProvider';
import { eventCategory, eventTarget, type InvestigationContext } from './investigation-model';
import styles from '../../styles/modules/investigations.module.css';

export function InvestigationCoverage({data,metrics}:{data:InvestigationContext;metrics?:ReactNode}) {
  const {t}=useI18n();
  return <section aria-label={t('inv_coverage')} className={styles.workspace}>
    {data.completeness!=='complete'?<p className={styles.warning} role="status">{t('inv_partial_hint')}</p>:null}
    <details className={styles.coverageDisclosure} open={data.completeness!=='complete'}><summary>{t('inv_coverage')} ({Object.keys(data.coverage).length}) &middot; {t(data.completeness==='complete'?'inv_complete':'inv_partial')}</summary><div className={styles.coverage}>{['inventory','topology','alerts','health','configuration'].filter(name=>data.coverage[name]).map(name=>{const c=data.coverage[name];return <article key={name} className={styles.source} data-state={c.state}>
      <strong>{t(`inv_source_${name}`)}</strong><p>{t(`inv_${c.state}`)}</p>
      {c.state==='unavailable'||c.state==='not_applicable'?null:<p>{t('inv_returned',{count:c.returned,limit:c.limit})}</p>}
      {c.reason?<p>{t(`inv_reason_${c.reason}`)}</p>:null}
    </article>;})}</div>{metrics}</details><p className={styles.note}>{t('inv_history_note')}</p>
  </section>;
}
export function InvestigationTimeline({data,category='all'}:{data:InvestigationContext;category?:string}) {
  const {t,formatDateTime}=useI18n();const resources=new Map(data.resources.map(r=>[r.resourceId,r]));const events=data.events.filter(e=>category==='all'||eventCategory(e)===category);
  const label=(prefix:string,value:string)=>{const key=`${prefix}${value}`;const text=t(key);return text===key?t('inv_unknown'):text;};
  return <section className={styles.panel} aria-label={t('inv_evidence')}><h2>{t('inv_evidence')}</h2>
    {events.length?<ol className={styles.timeline}>{events.map(event=><li key={event.key} className={styles.timelineItem} data-kind={event.kind}>
      <header><strong>{t(`inv_event_${event.kind}`)}</strong><time dateTime={event.at}>{formatDateTime(event.at,EVIDENCE_TIME_FORMAT)}</time></header>
      <p>{event.name||resources.get(event.resourceId)?.name||t('inv_unresolved_resource')}</p>
      <p className={styles.note}>{label('inv_outcome_',event.outcome)} &middot; {t(`inv_basis_${event.basis}`)}</p>
      {event.kind==='configuration'?<><p>{t(event.changed===true?'inv_changed':event.changed===false?'inv_unchanged':'inv_change_unknown')}</p><p className={styles.note}>{t('inv_config_time')}</p></>:null}
      {event.measuredAt?<p className={styles.note}>{t('inv_measured_at')}: {formatDateTime(event.measuredAt,EVIDENCE_TIME_FORMAT)}</p>:null}
      {event.layers?<dl className={styles.facts}>{(['process','interface','service'] as const).map(layer=><div key={layer}><dt>{t(`inv_layer_${layer}`)}</dt><dd>{label('inv_layer_',event.layers?.[layer].state||'unknown')}</dd></div>)}</dl>:null}
      <details><summary>{t('inv_event_detail')}</summary><dl className={styles.facts}><div><dt>{t('inv_resource')}</dt><dd className={styles.identity}>{event.resourceId||t('inv_unknown')}</dd></div><div><dt>{t('inv_evidence')}</dt><dd className={styles.identity}>{event.id}</dd></div>{event.snapshotId?<div><dt>{t('inv_snapshot')}</dt><dd className={styles.identity}>{event.snapshotId}</dd></div>:null}</dl><Link to={eventTarget(event)}>{t('inv_owner')}</Link><p className={styles.note}>{t('inv_owner_hint')}</p></details>
    </li>)}</ol>:<p className={styles.note}>{t('inv_no_events')}</p>}
  </section>;
}
export function InvestigationRelations({data}:{data:InvestigationContext}) {
  const {t}=useI18n();const resources=new Map(data.resources.map(r=>[r.resourceId,r]));
  return <section className={styles.panel}><h2>{t('inv_current_relations')}</h2><p className={styles.note}>{t('inv_relation_note')}</p>
    <ul className={styles.relations}>{data.relations.map(edge=><li key={edge.edgeId}><span>{resources.get(edge.fromResourceId)?.name||t('inv_unresolved_resource')}</span><small>{t('inv_relation_type')}: <code>{edge.relationshipType}</code></small><span>{resources.get(edge.toResourceId)?.name||t('inv_unresolved_resource')}</span><small className={styles.identity}>{edge.edgeId}</small></li>)}</ul>
    {!data.relations.length?<p>{t('inv_no_relations')}</p>:null}
    <details><summary>{t('inv_resources_count')} ({data.resources.length})</summary><ul className={styles.relations}>{data.resources.map(r=><li key={r.resourceId}><Link to={`/inventory/${r.resourceId}`}>{r.name}</Link><small>{r.domain} / {r.role||r.kind} &middot; {r.lifecycleState==='retired'?t('inv_retired'):r.lifecycleState}</small><small className={styles.identity}>{r.resourceId}</small></li>)}</ul></details>
    <p><Link to={data.anchor.resourceId ? `/logs?resourceId=${encodeURIComponent(data.anchor.resourceId)}` : '/logs'}>{t('inv_logs')}</Link></p><p className={styles.note}>{t('inv_logs_hint')}</p>
  </section>;
}
