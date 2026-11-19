import { useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Field } from '../../components/ui/Field';
import { OperationFeedback } from '../../components/ui/OperationFeedback';
import { UnsavedChangesDialog, useUnsavedChangesGuard } from '../../components/ui/UnsavedChangesGuard';
import { useBoundedRead } from '../../lib/api/use-bounded-read';
import { MutationApiError, postJson, putJson } from '../../lib/api/mutation-client';
import { requestUuid } from '../../lib/api/request-id';
import { useI18n } from '../../providers/I18nProvider';
import { TopologyResourcePicker } from '../topology/components/TopologyResourcePicker';
import type { ListResourcesResponse } from '../inventory/inventory-types';
import { CHECK_KINDS, definitionFor, emptyFilter, inspectionError, planLink, validateInspectionDraft, type Definition, type InspectionPlan, type InspectionPreview } from './inspection-model';
import { InspectionScopeSummary } from './InspectionEvidence';
import styles from '../../styles/modules/inspections.module.css';

export function InspectionEditor({ initial, latest, back, onSaved, onConflict }: { initial: Definition; latest?: InspectionPlan; back: string; onSaved?: (p: InspectionPlan) => void; onConflict?: () => void }) {
  const { t, formatDateTime } = useI18n(); const navigate = useNavigate();
  const [saved, setSaved] = useState(latest); const [baseline, setBaseline] = useState(() => JSON.stringify(initial)); const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false); const [preview, setPreview] = useState<{ digest: string; value: InspectionPreview } | null>(null); const [message, setMessage] = useState(''); const [conflict, setConflict] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({}); const summaryRef = useRef<HTMLElement>(null);
  const fieldError = (id: string) => ({ error: errors[id] ? t(errors[id]) : undefined, errorId: `${id}-error` });
  const inputError = (id: string) => ({ 'aria-invalid': errors[id] ? true as const : undefined, 'aria-describedby': errors[id] ? `${id}-error` : undefined });
  const validate = () => { const next = validateInspectionDraft(draft); setErrors(next); if (Object.keys(next).length) { requestAnimationFrame(() => summaryRef.current?.focus()); return false; } return true; };
  const request = useRef<{ digest: string; id: string } | null>(null); const [pickerLabels, setPickerLabels] = useState<Record<string, string>>({});
  const draftKey = JSON.stringify(draft); const dirty = baseline !== draftKey;
  const guard = useUnsavedChangesGuard(dirty || busy, () => navigate(back));
  const selectedPreview = preview?.digest === draftKey ? preview.value : null;
  const newer = Boolean(saved && latest && latest.revision > saved.revision);
  const update = (patch: Partial<Definition>) => { setDraft(value => ({ ...value, ...patch })); setMessage(''); setErrors({}); };
  const setScopeField = (key: keyof Definition['scope']['filter'], value: string) => update({ scope: { ...draft.scope, filter: { ...draft.scope.filter, [key]: value } } });
  const labels = useBoundedRead<ListResourcesResponse>(draft.scope.mode === 'resources' && draft.scope.resourceIds.length > 0 && draft.scope.resourceIds.length <= 50 ? `/api/inventory/resources?${new URLSearchParams({ resourceIds: draft.scope.resourceIds.join(',') })}` : null);
  const names = { ...Object.fromEntries((labels.data?.resources || []).map(r => [r.resourceId, r.displayName || r.name])), ...pickerLabels };
  const previewDefinition = async () => { if (!validate()) return; setBusy(true); setMessage(''); try { const value = await postJson<InspectionPreview>('/api/inspection-plans/preview', draft); setPreview({ digest: draftKey, value }); } catch (error) { setMessage(inspectionError(error)); } finally { setBusy(false); } };
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (busy || !selectedPreview || conflict || newer || !validate()) return; setBusy(true); setMessage('');
    try {
      let result: InspectionPlan;
      if (saved) result = await putJson<InspectionPlan>(`/api/inspection-plans/${saved.planId}`, { ...draft, expectedRevision: saved.revision, enabled: saved.enabled, archived: false });
      else { if (request.current?.digest !== draftKey) request.current = { digest: draftKey, id: requestUuid() }; result = await postJson<InspectionPlan>('/api/inspection-plans', { ...draft, requestId: request.current.id }); }
      const definition = definitionFor(result); setSaved(result); setDraft(definition); setBaseline(JSON.stringify(definition)); setPreview(null); setMessage('inspection_saved'); onSaved?.(result);
      if (!latest) navigate(planLink(result.planId, back), { replace: true });
    } catch (error) { if (error instanceof MutationApiError && error.status === 409) { setConflict(true); onConflict?.(); } setMessage(inspectionError(error)); } finally { setBusy(false); }
  };
  const reload = () => { if (!latest) return; const d = definitionFor(latest); setSaved(latest); setDraft(d); setBaseline(JSON.stringify(d)); setPreview(null); setConflict(false); setMessage(''); };
  return <form className={styles.editor} onSubmit={save} aria-busy={busy} noValidate>
    {Object.keys(errors).length ? <section className={styles.validation} role="alert" tabIndex={-1} ref={summaryRef} aria-label={t('inspection_validation_summary')}><h2>{t('inspection_validation_summary')}</h2><ul>{Object.entries(errors).map(([id, key]) => <li key={id}><a href={`#${id}`} onClick={event => { event.preventDefault(); document.getElementById(id)?.focus(); }}>{t(key)}</a></li>)}</ul></section> : null}
    {message ? <OperationFeedback tone={message === 'inspection_saved' ? 'success' : 'danger'} message={t(message)} /> : null}
    {newer || conflict ? <OperationFeedback tone="warning" message={t('inspection_conflict_draft')} /> : null}
    <fieldset disabled={busy} className={styles.fieldset}><legend>{t('inspection_plan_basics')}</legend>
      <Field htmlFor="inspection-name" label={t('inspection_name')} {...fieldError("inspection-name")}><input id="inspection-name" {...inputError("inspection-name")} className="form-input" required maxLength={128} value={draft.name} onChange={e => update({ name: e.target.value })} /></Field>
      <Field htmlFor="inspection-description" label={t('inspection_notes')}><textarea id="inspection-description" className="form-input" maxLength={1024} rows={2} value={draft.description} onChange={e => update({ description: e.target.value })} /></Field>
    </fieldset>
    <fieldset disabled={busy} className={styles.fieldset}><legend>{t('inspection_scope')}</legend>
      <Field htmlFor="inspection-scope-mode" label={t('inspection_scope_mode')} {...fieldError("inspection-scope-mode")}><select id="inspection-scope-mode" {...inputError("inspection-scope-mode")} className="form-input" value={draft.scope.mode} onChange={e => update({ scope: { mode: e.target.value as Definition['scope']['mode'], filter: emptyFilter(), resourceIds: [] } })}>{['groups', 'resources', 'all'].map(k => <option key={k} value={k}>{t(`inspection_scope_${k}`)}</option>)}</select></Field>
      {draft.scope.mode === 'all' ? <OperationFeedback tone="warning" message={t('inspection_all_scope_hint')} /> : null}
      {draft.scope.mode === 'groups' ? <>
        <div className={styles.columns}><TopologyResourcePicker id="inspection-site" label={t('groups_site')} kind="site" value={draft.scope.filter.siteResourceId} onChange={r => setScopeField('siteResourceId', r?.resourceId || '')} /><TopologyResourcePicker id="inspection-host" label={t('groups_host')} kind="host" value={draft.scope.filter.hostResourceId} onChange={r => setScopeField('hostResourceId', r?.resourceId || '')} /></div>
        <div className={styles.fields}>{(['networkKey', 'operatorName', 'plmn', 'domain'] as const).map(key => <Field key={key} htmlFor={`inspection-${key}`} label={t(`inspection_scope_${key}`)} {...fieldError(`inspection-${key}`)}>{key === 'domain' ? <select id={`inspection-${key}`} {...inputError(`inspection-${key}`)} className="form-input" value={draft.scope.filter[key]} onChange={e => setScopeField(key, e.target.value)}><option value="">{t('inspection_any')}</option>{['epc', '5gc', 'ims', 'charging', 'shared', 'platform', 'ran', 'transport', 'cloud', 'other'].map(v => <option key={v} value={v}>{v.toUpperCase()}</option>)}</select> : <input id={`inspection-${key}`} {...inputError(`inspection-${key}`)} className="form-input" maxLength={key === 'operatorName' ? 128 : key === 'plmn' ? 6 : 64} value={draft.scope.filter[key]} onChange={e => setScopeField(key, e.target.value)} />}</Field>)}</div><p className={styles.note}>{t('inspection_group_intersection')}</p>
      </> : null}
      {draft.scope.mode === 'resources' ? <>
        <TopologyResourcePicker id="inspection-resource" label={t('inspection_add_resource')} value="" disabled={draft.scope.resourceIds.length >= 200} onChange={r => { if (r && r.lifecycleState !== 'retired' && !draft.scope.resourceIds.includes(r.resourceId)) { update({ scope: { ...draft.scope, resourceIds: [...draft.scope.resourceIds, r.resourceId] } }); setPickerLabels(v => ({ ...v, [r.resourceId]: r.displayName || r.name })); } }} />
        <ul className={styles.selected}>{draft.scope.resourceIds.map(id => <li key={id}><span>{names[id] || id}</span><button className="btn btn-secondary btn-sm" type="button" onClick={() => update({ scope: { ...draft.scope, resourceIds: draft.scope.resourceIds.filter(v => v !== id) } })} aria-label={`${t('inspection_remove_resource')}: ${names[id] || id}`}>{t('inspection_remove_resource')}</button></li>)}</ul>
      </> : null}
    </fieldset>
    <fieldset disabled={busy} className={styles.fieldset}><legend>{t('inspection_checks')}</legend><Field htmlFor="inspection-check-monitoring" label={t("inspection_select_checks")} {...fieldError("inspection-check-monitoring")}><div className={styles.checks}>{CHECK_KINDS.map(kind => <label key={kind}><input id={`inspection-check-${kind}`} {...(kind === "monitoring" ? inputError("inspection-check-monitoring") : {})} type="checkbox" checked={draft.checks.includes(kind)} onChange={e => update({ checks: e.target.checked ? [...draft.checks, kind] : draft.checks.filter(k => k !== kind) })} /><span>{t(`inspection_kind_${kind}`)}</span></label>)}</div></Field>
      <Field htmlFor="inspection-age" label={t('inspection_config_age')}><select id="inspection-age" className="form-input" value={draft.configMaxAgeSeconds} onChange={e => update({ configMaxAgeSeconds: Number(e.target.value) })}>{[300, 900, 3600, 14400, 86400, 604800].map(n => <option key={n} value={n}>{t('inspection_seconds', { count: n })}</option>)}</select></Field><p className={styles.note}>{t('inspection_age_hint')}</p>
    </fieldset>
    <fieldset disabled={busy} className={styles.fieldset}><legend>{t('inspection_schedule')}</legend><div className={styles.fields}>
      <Field htmlFor="inspection-cadence" label={t('inspection_cadence')}><select id="inspection-cadence" className="form-input" value={draft.schedule.kind} onChange={e => update({ schedule: { ...draft.schedule, kind: e.target.value as Definition['schedule']['kind'] } })}>{['interval', 'daily', 'weekly'].map(k => <option key={k} value={k}>{t(`inspection_cadence_${k}`)}</option>)}</select></Field>
      {draft.schedule.kind === 'interval' ? <Field htmlFor="inspection-interval" label={t('inspection_interval')}><select id="inspection-interval" className="form-input" value={draft.schedule.intervalSeconds} onChange={e => update({ schedule: { ...draft.schedule, intervalSeconds: Number(e.target.value) } })}>{[900, 3600, 14400].map(n => <option key={n} value={n}>{t('inspection_seconds', { count: n })}</option>)}</select></Field> : <Field htmlFor="inspection-time" label={t('inspection_local_time')} {...fieldError("inspection-time")}><input id="inspection-time" {...inputError("inspection-time")} type="time" className="form-input" required value={draft.schedule.time} onChange={e => update({ schedule: { ...draft.schedule, time: e.target.value } })} /></Field>}
      {draft.schedule.kind === 'weekly' ? <Field htmlFor="inspection-weekday" label={t('inspection_weekday')}><select id="inspection-weekday" className="form-input" value={draft.schedule.weekday} onChange={e => update({ schedule: { ...draft.schedule, weekday: Number(e.target.value) } })}>{[0, 1, 2, 3, 4, 5, 6].map(n => <option key={n} value={n}>{t(`inspection_weekday_${n}`)}</option>)}</select></Field> : null}
      <Field htmlFor="inspection-timezone" label={t('inspection_timezone')} {...fieldError("inspection-timezone")}><input id="inspection-timezone" {...inputError("inspection-timezone")} className="form-input" list="inspection-timezones" required maxLength={64} value={draft.schedule.timezone} onChange={e => update({ schedule: { ...draft.schedule, timezone: e.target.value } })} /><datalist id="inspection-timezones">{['Asia/Shanghai', 'UTC', 'Europe/London', 'America/New_York'].map(z => <option key={z} value={z} />)}</datalist></Field>
    </div><p className={styles.note}>{t('inspection_schedule_hint')}</p></fieldset>
    <div className={styles.actions}><button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void previewDefinition()}>{t(busy ? 'inspection_working' : 'inspection_preview')}</button><button className="btn btn-primary" type="submit" disabled={busy || !selectedPreview || conflict || newer}>{t(saved ? 'inspection_save' : 'inspection_save_paused')}</button><button className="btn btn-secondary" type="button" disabled={busy} onClick={guard.requestClose}>{t('cancel')}</button></div>
    {selectedPreview ? <section className={styles.section} aria-label={t('inspection_preview')}><h2>{t('inspection_preview')}</h2><InspectionScopeSummary scope={selectedPreview.scope} /><h3>{t('inspection_next_five')}</h3><ol className={styles.nextDates}>{selectedPreview.next.map(at => <li key={at}><time dateTime={at}>{new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: selectedPreview.definition.schedule.timezone }).format(new Date(at))}</time><small>{selectedPreview.definition.schedule.timezone} · {t('inspection_browser_time')}: {formatDateTime(at)}</small></li>)}</ol></section> : null}
    {conflict || newer ? <details className={styles.section}><summary>{t('inspection_reload_options')}</summary><p>{t('inspection_reload_hint')}</p><button type="button" className="btn btn-secondary" disabled={busy || !latest || !newer} onClick={reload}>{t('inspection_discard_reload')}</button></details> : null}
    <UnsavedChangesDialog open={guard.isPromptOpen} title={t('inspection_unsaved')} description={t('inspection_unsaved_hint')} keepEditingLabel={t('inspection_keep_editing')} discardLabel={t('inspection_discard')} onKeepEditing={guard.keepEditing} onDiscard={busy ? guard.keepEditing : guard.discardChanges} />
  </form>;
}
