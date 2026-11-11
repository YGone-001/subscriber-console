import { useId, useState, type FormEvent } from 'react';
import useSWR from 'swr';
import { Plus, X } from 'lucide-react';
import { Dialog } from '../../components/ui/Dialog';
import { Field } from '../../components/ui/Field';
import { OperationNotice } from '../../components/ui/OperationFeedback';
import { UnsavedChangesDialog, useUnsavedChangesGuard } from '../../components/ui/UnsavedChangesGuard';
import { CursorPagination } from '../../components/ui/CursorPagination';
import { useI18n } from '../../providers/I18nProvider';
import { createInventoryResource, updateInventoryResource, retireInventoryResource, fetchInventoryResources } from '../inventory/inventory-api';
import { buildCreateResourceRequest, buildUpdateResourceRequest } from '../inventory/inventory-builders';
import type { Resource } from '../inventory/inventory-types';
import { TopologyResourcePicker } from '../topology/components/TopologyResourcePicker';
import { createTopologyEdge, fetchTopologyEdges, retireTopologyEdge } from '../topology/topology-api';
import type { TopologyEdge } from '../topology/topology-types';
import { GROUP_MACHINE_PATTERN, GROUP_NETWORK_PATTERN, mutableGroupResource, parseOperationalScopes, type OperationalScope } from './groups-model';
import styles from '../../styles/modules/groups.module.css';

function DiscardGuard({ guard }: { guard: ReturnType<typeof useUnsavedChangesGuard> }) {
  const { t } = useI18n();
  return <UnsavedChangesDialog open={guard.isPromptOpen} title={t('unsaved_changes_title')} description={t('unsaved_changes_description')} keepEditingLabel={t('cancel')} discardLabel={t('close')} onKeepEditing={guard.keepEditing} onDiscard={guard.discardChanges} />;
}

export function GroupResourceEditor({ resource, mode, defaultNetwork, onClose, onSaved }: { resource: Resource | null; mode: 'site' | 'scope'; defaultNetwork?: string; onClose: () => void; onSaved: () => Promise<void> }) {
  const { t } = useI18n();
  const titleId = useId();
  const existing = parseOperationalScopes(resource?.attributes?.xcloudOperationalScopes);
  const [name, setName] = useState(resource?.name ?? '');
  const [displayName, setDisplayName] = useState(resource?.displayName ?? '');
  const [description, setDescription] = useState(resource?.description ?? '');
  const [lifecycle, setLifecycle] = useState(resource?.lifecycleState ?? 'planned');
  const [scopes, setScopes] = useState(() => (resource ? existing ?? [] : defaultNetwork ? [{ networkKey: defaultNetwork, operatorName: '', plmns: [] }] : []).map((s) => ({ ...s, plmns: s.plmns.join(', ') })));
  const [scopesChanged, setScopesChanged] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const guard = useUnsavedChangesGuard(dirty && !busy, onClose);
  const editScope = (index: number, field: string, value: string) => { setScopes((rows) => rows.map((r, i) => i === index ? { ...r, [field]: value } : r)); setScopesChanged(true); setDirty(true); };
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError('');
    let declarations: OperationalScope[] | null = [];
    if (scopesChanged || !resource) {
      declarations = parseOperationalScopes(scopes.map((s) => ({ ...s, plmns: s.plmns.trim() ? s.plmns.split(',').map((p) => p.trim()) : [] })));
      if (!declarations) { setError(t('groups_invalid_scopes')); return; }
    }
    setBusy(true);
    try {
      const mutable = resource ? mutableGroupResource(resource) : { kind: 'site', name, domain: 'platform', lifecycleState: lifecycle };
      if (mode === 'site') { mutable.name = name; mutable.displayName = displayName; mutable.description = description; mutable.lifecycleState = lifecycle; }
      if (scopesChanged || !resource) mutable.attributes = { ...mutable.attributes, xcloudOperationalScopes: declarations };
      if (resource) await updateInventoryResource(resource.resourceId, buildUpdateResourceRequest(resource.revision, mutable));
      else await createInventoryResource(buildCreateResourceRequest(mutable));
      setDirty(false); await onSaved(); onClose();
    } catch { setError(t('groups_save_failed')); } finally { setBusy(false); }
  };
  return <>
    <Dialog open onClose={() => { if (!busy) guard.requestClose(); }} className={styles.dialog} overlayClassName={styles.overlay} labelledBy={titleId}>
      <header className={styles.dialogHead}><h2 id={titleId}>{t(mode === 'scope' ? 'groups_assign' : resource ? 'groups_edit' : 'groups_create')}</h2><button type="button" className="btn btn-ghost" onClick={guard.requestClose} disabled={busy} aria-label={t('close')}><X size={18} /></button></header>
      <form onSubmit={(event) => { void submit(event); }} className={styles.form}>
        {mode === 'site' ? <div className={styles.fields}>
          <Field label={t('groups_name')}><input required pattern={GROUP_MACHINE_PATTERN} maxLength={128} value={name} onChange={(e) => { setName(e.target.value); setDirty(true); }} /></Field>
          <Field label={t('groups_display_name')}><input maxLength={256} value={displayName} onChange={(e) => { setDisplayName(e.target.value); setDirty(true); }} /></Field>
          <Field label={t('groups_lifecycle')}><select value={lifecycle} onChange={(e) => { setLifecycle(e.target.value); setDirty(true); }}>{['planned', 'active', 'maintenance'].map((value) => <option key={value} value={value}>{t(`groups_lifecycle_${value}`)}</option>)}</select></Field>
          <Field label={t('groups_description_field')}><textarea maxLength={1024} value={description} onChange={(e) => { setDescription(e.target.value); setDirty(true); }} /></Field>
        </div> : <p><strong>{resource?.displayName || resource?.name}</strong><small className={styles.mono}>{resource?.resourceId}</small></p>}
        <section className={styles.scopeEditor}><h3>{t('groups_scope_fields')}</h3><p className={styles.hint}>{t('groups_scope_fields_hint')}</p>
          {existing === null ? <OperationNotice tone="warning" message={t('groups_invalid_legacy')} /> : null}
          {scopes.map((scope, index) => <fieldset className={styles.declaration} key={index}><legend>{t('groups_network')} {index + 1}</legend>
            <Field label={t('groups_network')}><input required maxLength={64} pattern={GROUP_NETWORK_PATTERN} value={scope.networkKey} onChange={(e) => editScope(index, 'networkKey', e.target.value)} /></Field>
            <Field label={t('groups_operator')}><input maxLength={128} value={scope.operatorName} onChange={(e) => editScope(index, 'operatorName', e.target.value)} /></Field>
            <Field label={t('groups_plmn')} description={t('groups_plmn_hint')}><input value={scope.plmns} maxLength={128} onChange={(e) => editScope(index, 'plmns', e.target.value)} /></Field>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => { setScopes(scopes.filter((_, i) => i !== index)); setScopesChanged(true); setDirty(true); }}>{t('groups_remove_network')}</button>
          </fieldset>)}
          <button type="button" className="btn btn-secondary" disabled={busy || scopes.length >= 8} onClick={() => { setScopes([...scopes, { networkKey: '', operatorName: '', plmns: '' }]); setScopesChanged(true); setDirty(true); }}><Plus size={15} />{t('groups_add_network')}</button>
        </section>
        {error ? <OperationNotice tone="danger" message={error} /> : null}
        <footer className={styles.actions}><button type="button" className="btn btn-secondary" disabled={busy} onClick={guard.requestClose}>{t('cancel')}</button><button className="btn btn-primary" type="submit" disabled={busy}>{t(busy ? 'saving' : 'save')}</button></footer>
      </form>
    </Dialog><DiscardGuard guard={guard} />
  </>;
}

export function RetireSiteDialog({ resource, onClose, onSaved }: { resource: Resource; onClose: () => void; onSaved: () => Promise<void> }) {
  const { t } = useI18n(); const titleId = useId();
  const [reason, setReason] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(''); try { await retireInventoryResource(resource.resourceId, { expectedRevision: resource.revision, reason: reason.trim() }); await onSaved(); onClose(); } catch { setError(t('groups_save_failed')); } finally { setBusy(false); } };
  return <Dialog open onClose={() => { if (!busy) onClose(); }} className={styles.dialog} overlayClassName={styles.overlay} labelledBy={titleId}>
    <header className={styles.dialogHead}><h2 id={titleId}>{t('groups_retire')}: {resource.displayName || resource.name}</h2></header>
    <form className={styles.form} onSubmit={(event) => { void submit(event); }}><p>{t('groups_retire_hint')}</p><Field label={t('groups_reason')}><textarea required maxLength={512} value={reason} onChange={(event) => setReason(event.target.value)} /></Field>{error ? <OperationNotice tone="danger" message={error} /> : null}<footer className={styles.actions}><button type="button" className="btn btn-secondary" disabled={busy} onClick={onClose}>{t('cancel')}</button><button className="btn btn-danger" type="submit" disabled={busy || !reason.trim()}>{t('groups_retire')}</button></footer></form>
  </Dialog>;
}

export function ContainmentDialog({ initialSite, onClose, onChanged }: { initialSite: Resource | null; onClose: () => void; onChanged: () => Promise<void> }) {
  const { t } = useI18n(); const titleId = useId();
  const [site, setSite] = useState<Resource | null>(initialSite); const [host, setHost] = useState<Resource | null>(null); const [cursor, setCursor] = useState('');
  const [retiring, setRetiring] = useState<TopologyEdge | null>(null); const [reason, setReason] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [saved, setSaved] = useState(false);
  const guard = useUnsavedChangesGuard(Boolean(host || reason) && !busy, onClose);
  const list = useSWR(site ? ['group-containment', site.resourceId, cursor] : null, () => fetchTopologyEdges({ fromResourceId: site!.resourceId, relationshipType: 'contains', lifecycleState: 'active', cursor, limit: 50 }), { revalidateOnFocus: false });
  const resourceIds = list.data?.edges.map((e) => e.toResourceId) ?? [];
  const names = useSWR(resourceIds.length ? ['group-containment-names', resourceIds.join(',')] : null, () => fetchInventoryResources({ resourceIds }));
  const name = (id: string) => { const r = names.data?.resources.find((r) => r.resourceId === id); return r?.displayName || r?.name || id; };
  const execute = async (event: FormEvent) => {
    event.preventDefault(); setError(''); setSaved(false);
    if (!site || site.kind !== 'site' || site.lifecycleState === 'retired' || (!retiring && (!host || host.kind !== 'host' || host.lifecycleState === 'retired'))) { setError(t('groups_wrong_kind')); return; }
    setBusy(true);
    try { if (retiring) await retireTopologyEdge(retiring.edgeId, { expectedRevision: retiring.revision, reason: reason.trim() }); else await createTopologyEdge({ relationshipType: 'contains', fromResourceId: site.resourceId, toResourceId: host!.resourceId }); setSaved(true); setHost(null); setRetiring(null); setReason(''); await Promise.allSettled([list.mutate(), onChanged()]); }
    catch { setError(t('groups_save_failed')); await list.mutate(); } finally { setBusy(false); }
  };
  return <><Dialog open onClose={() => { if (!busy) guard.requestClose(); }} className={styles.dialog} overlayClassName={styles.overlay} labelledBy={titleId}>
    <header className={styles.dialogHead}><h2 id={titleId}>{t('groups_containment')}</h2><button type="button" className="btn btn-ghost" onClick={guard.requestClose} disabled={busy} aria-label={t('close')}><X size={18} /></button></header>
    <p className={styles.hint}>{t('groups_relationship_hint')}</p>
    <TopologyResourcePicker id={`${titleId}-site`} label={t('groups_pick_site')} value={site?.resourceId || ''} kind="site" onChange={(r) => { setSite(r); setCursor(''); setRetiring(null); }} disabled={busy || Boolean(retiring)} />
    {list.error ? <OperationNotice tone="danger" message={t('groups_read_error')} /> : null}
    <section className={styles.relationships}><h3>{t('groups_relationships')}</h3>{list.data?.edges.map((edge) => <div className={styles.relationship} key={edge.edgeId}><span>{name(edge.toResourceId)}<small className={styles.mono}>{edge.toResourceId}</small></span><button type="button" className="btn btn-ghost" disabled={busy} onClick={() => { setRetiring(edge); setReason(''); setSaved(false); }}>{t('groups_retire_relationship')}</button></div>)}
      {list.data?.page.hasMore || cursor ? <CursorPagination summary={t('groups_relationships')} previousLabel={t('groups_first')} nextLabel={t('next')} hasPrevious={Boolean(cursor)} hasNext={Boolean(list.data?.page.hasMore)} onPrevious={() => setCursor('')} onNext={() => setCursor(list.data?.page.nextCursor || '')} /> : null}
    </section>
    <form onSubmit={(event) => { void execute(event); }} className={styles.form}>
      {retiring ? <><p>{t('groups_retire_relationship')}: {name(retiring.toResourceId)}</p><Field label={t('groups_reason')}><textarea required maxLength={512} value={reason} onChange={(e) => setReason(e.target.value)} /></Field></> : <TopologyResourcePicker id={`${titleId}-host`} label={t('groups_pick_host')} value={host?.resourceId || ''} kind="host" onChange={setHost} disabled={busy} />}
      {error ? <OperationNotice tone="danger" message={error} /> : null}{saved ? <OperationNotice tone="success" message={t('groups_saved')} /> : null}
      <footer className={styles.actions}>{retiring ? <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => { setRetiring(null); setReason(''); }}>{t('cancel')}</button> : null}<button type="button" className="btn btn-secondary" disabled={busy} onClick={guard.requestClose}>{t('close')}</button><button type="submit" className={retiring ? 'btn btn-danger' : 'btn btn-primary'} disabled={busy || !site || (retiring ? !reason.trim() : !host)}>{t(retiring ? 'groups_retire_relationship' : 'groups_add_relationship')}</button></footer>
    </form>
  </Dialog><DiscardGuard guard={guard} /></>;
}
