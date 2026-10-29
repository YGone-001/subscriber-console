/*
 * User-template detail page.
 *
 * Replaces the modal surface: the six sections, the statistics and the version
 * history are page-level, filter state and navigation live in the URL, and every
 * read goes through the shared read client so failures are visible instead of
 * rendering a default-filled form.
 */
import { useEffect, useMemo, useState } from 'react';
import { useSWRConfig } from 'swr';
import { ArrowLeft, Boxes, Copy, Download, Pencil, Save, Trash2, UserPlus, Users } from 'lucide-react';
import { useI18n } from '../../providers/I18nProvider';
import { useAuth } from '../../providers/AuthProvider';
import { useRead } from '../../lib/api/use-read';
import { getBlob } from '../../lib/api/read-client';
import { MutationApiError, deleteJson, postJson, putJson } from '../../lib/api/mutation-client';
import { buildProfileApplyRequest } from '../subscribers/mutation-contract';
import { useAppParam, useAppRouter, useAppSearchParam } from '../../lib/ui-compat/router';
import { hasPermission } from '../../lib/permissions';
import PageHeader from '../../components/ui/PageHeader';
import { ErrorState } from '../../components/ui/StatePanel';
import { ConfirmActionPanel, LoadingRows, OperationNotice } from '../../components/ui/OperationFeedback';
import ProfileViewMode from './components/ProfileViewMode';
import ProfileEditMode from './components/ProfileEditMode';
import ProfileSectionNav, { type ProfileSectionAnchor } from './components/ProfileSectionNav';
import { ProfileDriftCard } from './components/ProfileDriftCard';
import { ProfileVersionsCard } from './components/ProfileVersionsCard';
import {
  buildDraftChangeRows,
  buildProfilePayload,
  createDraftFromProfile,
  createEmptyDraft,
  draftSignature,
  suggestProfileKey,
  type ProfileDraft,
} from './profile-draft';
import { findProfileDraftIssue, profileKeyIssue, type ProfileDraftIssue } from './profile-validation';
import { resolveTemplateImpact } from './profile-format';
import { buildProfileVersionDiff } from './profile-version-diff';
import type {
  ProfileDetailResponse,
  ProfileMetaResponse,
  ProfileVersionDetail,
  ProfileVersionsResponse,
  RatingsResponse,
  TariffPlansResponse,
} from './profile-types';
import styles from '../../styles/modules/profile.module.css';

const VIEW_SECTIONS: Array<{ id: string; labelKey: string }> = [
  { id: 'psec-stats', labelKey: 'prof_change_impacted' },
  { id: 'psec-security', labelKey: 'sec_security_auth' },
  { id: 'psec-ocs-view', labelKey: 'sec_billing_config' },
  { id: 'psec-network', labelKey: 'sec_global_network' },
  { id: 'psec-access-restrictions', labelKey: 'sec_access_restrict' },
  { id: 'psec-slices', labelKey: 'prof_sec_slices' },
];

const EDIT_SECTIONS: Array<{ id: string; labelKey: string }> = [
  { id: 'psec-info', labelKey: 'prof_sec_info' },
  { id: 'psec-security', labelKey: 'sec_security_auth' },
  { id: 'psec-ocs-edit', labelKey: 'sec_billing_config' },
  { id: 'psec-network', labelKey: 'sec_global_network' },
  { id: 'psec-access-restrictions', labelKey: 'sec_access_restrict' },
  { id: 'psec-slices', labelKey: 'prof_sec_slices' },
];

export function ProfileDetailPage() {
  const profileName = useAppParam('name');
  const isCreate = !profileName;
  const { t, formatDateTime } = useI18n();
  const router = useAppRouter();
  const { mutate: globalMutate } = useSWRConfig();
  const { user } = useAuth();

  const detailPath = profileName ? `/api/profiles/${encodeURIComponent(profileName)}` : null;
  const versionsPath = profileName ? `/api/profiles/${encodeURIComponent(profileName)}/versions?limit=20` : null;
  const { data: detail, isLoading, error: detailError, mutate: mutateDetail } = useRead<ProfileDetailResponse>(detailPath);
  const {
    data: versionsData,
    isLoading: isVersionsLoading,
    error: versionsError,
    mutate: mutateVersions,
  } = useRead<ProfileVersionsResponse>(versionsPath);
  const { data: meta } = useRead<ProfileMetaResponse>('/api/profiles/meta');
  const { data: plansData, error: plansError } = useRead<TariffPlansResponse>('/api/tariff-plans');

  const profile = detail?.profile ?? null;

  const [draft, setDraft] = useState<ProfileDraft>(createEmptyDraft);
  const [isEditing, setIsEditing] = useState(isCreate);
  /* The title suggests a key until the operator types one; after that the
   * suggestion stops overwriting their choice. */
  const [isKeyTouched, setIsKeyTouched] = useState(false);
  const [editingBaseline, setEditingBaseline] = useState<string | null>(() => (isCreate ? draftSignature(createEmptyDraft()) : null));
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);
  const [forceDeleteCount, setForceDeleteCount] = useState<number | 'unknown' | null>(null);
  const [isSaveConfirmOpen, setIsSaveConfirmOpen] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<ProfileVersionDetail | null>(null);
  const [discardTarget, setDiscardTarget] = useState<'leave' | 'cancel' | 'restore' | null>(null);
  const [pendingRestore, setPendingRestore] = useState<ProfileVersionDetail | null>(null);
  const [isAccessRestrictionsExpanded, setIsAccessRestrictionsExpanded] = useState(false);
  const [newlyAddedSliceIndex, setNewlyAddedSliceIndex] = useState<number | null>(null);
  const [expandedSlices, setExpandedSlices] = useState<number[]>([0]);
  const [isApplyOpen, setIsApplyOpen] = useState(false);
  const [applyImsi, setApplyImsi] = useState('');
  const [isApplying, setIsApplying] = useState(false);
  const [isCloneOpen, setIsCloneOpen] = useState(false);
  const [cloneKey, setCloneKey] = useState('');
  const [cloneTitle, setCloneTitle] = useState('');
  const [isCloning, setIsCloning] = useState(false);
  const [isExporting, setIsExporting] = useState(false);

  useEffect(() => {
    if (!profile || isEditing) return;
    setDraft(createDraftFromProfile(profile, profileName || ''));
  }, [profile, isEditing, profileName]);

  /* Creating navigates from /profile/new to /profile/:name, which remounts the
   * page and drops component state, so the confirmation travels as a query
   * flag instead of local notice state. */
  const createdFlag = useAppSearchParam('created');
  useEffect(() => {
    if (!createdFlag || isCreate || !profileName) return;
    setNotice({ type: 'success', text: t('prof_msg_created') });
    router.replace(`/profile/${encodeURIComponent(profileName)}`);
  }, [createdFlag, isCreate, profileName, router, t]);

  const planId = String(draft.ocsDefaults.planId || '').trim();
  const ratingsPath = planId ? `/api/ratings?planId=${encodeURIComponent(planId)}` : null;
  const { data: ratingsData, error: ratingsError } = useRead<RatingsResponse>(ratingsPath);

  const tariffPlanStatus = plansError ? 'unavailable' : (plansData ? 'ready' : 'loading');
  const ratingStatus = ratingsError ? 'unavailable' : (planId ? (ratingsData ? 'ready' : 'loading') : 'ready');

  const canWrite = meta?.capabilities.canWrite ?? hasPermission(user, 'profiles.write');
  const canRestore = meta?.capabilities.canRestore ?? hasPermission(user, 'profiles.write');
  /* The server masks auth material for roles without the subscriber write
   * permission; this bit mirrors that server-side decision. */
  const credentialsMasked = (
    meta?.capabilities.credentialVisibility
    ?? (hasPermission(user, 'subscribers.write') ? 'plaintext' : 'masked')
  ) === 'masked';
  /* Writing credential material requires both authorities; the server states it
   * so the page does not infer the coupling from the role table. */
  const canEditCredentials = meta?.capabilities.canEditCredentials ?? (canWrite && !credentialsMasked);
  /* Applying a template to a subscriber is the governed subscriber write, so the
   * entry point follows the subscriber capability, not the template one. */
  const canApplyTemplates = hasPermission(user, 'subscribers.write');
  const accessBits = meta?.accessRestriction.bits ?? null;

  const statsUnavailable = detail?.statsCompleteness === 'unavailable' || !detail?.stats;
  /* A failed attribution read is unknown, not zero: the write confirmations say
   * so instead of reporting a count that never came from anywhere. */
  const impact = resolveTemplateImpact(detail?.stats?.totalSubscribers, !statsUnavailable);
  /* The counter the page loaded with; every write preconditions on it so a
   * concurrent edit surfaces as a conflict instead of a silent overwrite. */
  const storedRevision = typeof profile?.revision === 'number' ? profile.revision : null;
  const hasUnsavedChanges = isEditing && editingBaseline !== null && editingBaseline !== draftSignature(draft);

  const draftPayload = useMemo(
    () => (profile ? buildProfilePayload(draft, profileName || '', !!profile.ocsDefaults, { includeAuth: canEditCredentials }) : {}),
    [draft, profile, profileName, canEditCredentials],
  );
  const draftChangeRows = useMemo(
    () => (profile ? buildDraftChangeRows(draftPayload, profile, canEditCredentials ? [] : ['auth']) : []),
    [draftPayload, profile, canEditCredentials],
  );
  const changedDraftRows = draftChangeRows.filter((row) => row.changed);

  const sectionAnchors: ProfileSectionAnchor[] = (isEditing ? EDIT_SECTIONS : VIEW_SECTIONS)
    .map((section) => ({ id: section.id, label: t(section.labelKey) }));

  const jumpToSection = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  /* Hierarchy jump: a collapsed slice owns its sessions, so the owning card is
   * expanded first and the scroll waits for that render. */
  const jumpToAnchor = (id: string) => {
    const owner = /^slice-card-(\d+)/.exec(id);
    if (owner) {
      const index = Number(owner[1]);
      setExpandedSlices((current) => (current.includes(index) ? current : [...current, index]));
    }
    window.setTimeout(() => {
      const el = document.getElementById(id);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      el.classList.add(styles.profileAnchorFlash);
      window.setTimeout(() => el.classList.remove(styles.profileAnchorFlash), 1600);
    }, owner ? 90 : 0);
  };

  /* The stored document on the left, the pending payload on the right: the same
   * comparison the version history renders, so confirming a save is not a
   * section-level guess while the history panel shows real values. */
  const saveDiffSections = useMemo(() => {
    if (!profile) return [];
    return buildProfileVersionDiff(profile, draftPayload, {
      notConfigured: t('prof_diff_not_configured'),
      sliceUnit: t('prof_version_slices'),
      sessionUnit: t('prof_diff_session_unit'),
      pccUnit: t('prof_diff_pcc_unit'),
      accessNone: t('prof_diff_access_none'),
      accessSuspended: t('prof_diff_access_suspended'),
      maskedSecret: t('prof_diff_masked'),
      withheld: t('credential_withheld'),
    })
      .map((section) => ({ ...section, rows: section.rows.filter((row) => row.changed) }))
      .filter((section) => section.rows.length > 0)
      /* The credential block is not part of this write when the caller cannot
       * see it, so it is not a difference the operator is being warned about. */
      .filter((section) => canEditCredentials || section.key !== 'auth');
  }, [draftPayload, profile, t, canEditCredentials]);

  const describeIssue = (issue: ProfileDraftIssue): string => {
    switch (issue.code) {
      case 'nameRequired':
        return t('prof_err_name_req');
      case 'nameInvalid':
        return t('prof_err_name_invalid');
      case 'nameReserved':
        return t('prof_err_name_reserved');
      case 'kFormat':
        return t('prof_err_k_format');
      case 'opFormat':
        return t('prof_err_op_format');
      case 'amfFormat':
        return t('prof_err_amf_format');
      case 'ambrInvalid':
        return t('prof_err_ambr_invalid', { direction: t(issue.direction === 'downlink' ? 'sub_dl' : 'sub_ul') });
      case 'sstRange':
        return t('prof_err_sst_range', { index: issue.index });
      case 'sdFormat':
        return t('prof_err_sd_format', { index: issue.index });
      case 'pgwIpv4':
        return t('prof_err_pgw_ipv4', { name: issue.sessionName });
    }
  };

  const prepareSave = (): { targetName: string; payload: Record<string, unknown> } | null => {
    setError(null);
    /* The key is validated and sent exactly as typed: leading or trailing spaces
     * are a format error, not something the client may quietly repair. */
    const targetName = profileName || draft.key;
    const issue = findProfileDraftIssue({
      name: targetName,
      auth: draft.auth,
      ambr: draft.ueAmbr,
      slices: draft.slices,
      validateAuth: canEditCredentials,
    });
    if (issue) {
      setError(describeIssue(issue));
      return null;
    }
    return { targetName, payload: buildProfilePayload(draft, targetName, !!profile?.ocsDefaults, { includeAuth: canEditCredentials }) };
  };

  const submit = async (targetName: string, payload: Record<string, unknown>) => {
    setIsSaving(true);
    setError(null);
    try {
      let committedAsNoEffect = false;
      if (isCreate) {
        /* One governed write: the create endpoint accepts the same content
         * fields as the update endpoint, so a new template no longer lands as
         * CREATE followed by UPDATE in the history. */
        await postJson('/api/profiles', { ...payload, name: targetName });
      } else {
        const result = await putJson<{ classification?: string }>(
          `/api/profiles/${encodeURIComponent(targetName)}`,
          storedRevision === null ? payload : { ...payload, expectedRevision: storedRevision },
        );
        committedAsNoEffect = result?.classification === 'NO_EFFECT';
      }
      setIsSaveConfirmOpen(false);
      setIsEditing(false);
      setNotice({ type: 'success', text: committedAsNoEffect ? t('prof_msg_no_effect') : t('prof_msg_saved') });
      await globalMutate('/api/profiles');
      if (isCreate) {
        router.replace(`/profile/${encodeURIComponent(targetName)}?created=1`);
        return;
      }
      await mutateDetail();
      await mutateVersions();
    } catch (err) {
      if (err instanceof MutationApiError && err.code === 'PROFILE_REVISION_CONFLICT') {
        // Keep the draft: the operator's edits are worth more than a reload.
        setError(t('prof_err_revision_conflict'));
        void mutateDetail();
      } else {
        setError(err instanceof Error ? err.message : t('prof_err_save'));
      }
    } finally {
      setIsSaving(false);
    }
  };

  const requestSave = () => {
    const prepared = prepareSave();
    if (!prepared) return;
    if (profileName) {
      const preparedRows = buildDraftChangeRows(prepared.payload, profile, canEditCredentials ? [] : ['auth']).filter((row) => row.changed);
      if (preparedRows.length > 0 && !isSaveConfirmOpen) {
        setIsSaveConfirmOpen(true);
        return;
      }
    }
    void submit(prepared.targetName, prepared.payload);
  };

  const confirmSave = () => {
    const prepared = prepareSave();
    if (prepared) void submit(prepared.targetName, prepared.payload);
  };

  const executeDelete = async (force: boolean) => {
    if (!profileName) return;
    setIsDeleting(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (force) params.set('force', 'true');
      if (storedRevision !== null) params.set('expectedRevision', String(storedRevision));
      const query = params.toString();
      await deleteJson(`/api/profiles/${encodeURIComponent(profileName)}${query ? `?${query}` : ''}`);
      await globalMutate('/api/profiles');
      router.push('/profile');
    } catch (err) {
      setIsDeleteConfirmOpen(false);
      const message = err instanceof Error ? err.message : t('prof_err_delete');
      if (err instanceof MutationApiError && err.code === 'PROFILE_REVISION_CONFLICT') {
        setError(t('prof_err_revision_conflict'));
        void mutateDetail();
        return;
      }
      const conflict = err instanceof MutationApiError
        && err.status === 409
        && (err.code === 'PROFILE_IN_USE' || /in use by/i.test(message));
      if (conflict) {
        const parsed = Number(message.match(/(\d+)/)?.[1] ?? 0);
        setForceDeleteCount(parsed > 0 ? parsed : (impact.kind === 'known' && impact.count > 0 ? impact.count : 'unknown'));
        return;
      }
      setError(message);
    } finally {
      setIsDeleting(false);
    }
  };

  /* A restore rewrites the live template, so an in-progress draft would be
   * discarded by it. Ask first, then let the operator confirm the restore. */
  const requestRestore = (target: ProfileVersionDetail) => {
    if (hasUnsavedChanges) {
      setPendingRestore(target);
      setDiscardTarget('restore');
      return;
    }
    setRestoreTarget(target);
  };

  const executeRestore = async () => {
    if (!profileName || !restoreTarget) return;
    setIsRestoring(true);
    setError(null);
    try {
      await postJson(
        `/api/profiles/${encodeURIComponent(profileName)}/versions/${encodeURIComponent(restoreTarget.versionId)}/restore`,
      );
      setRestoreTarget(null);
      await mutateDetail();
      await mutateVersions();
      await globalMutate('/api/profiles');
      setIsEditing(false);
      setNotice({ type: 'success', text: t('prof_version_msg_restored') });
    } catch (err) {
      setRestoreTarget(null);
      setError(err instanceof Error ? err.message : t('prof_version_err_restore'));
    } finally {
      setIsRestoring(false);
    }
  };

  const executeApply = async () => {
    if (!profileName) return;
    const imsi = applyImsi.trim();
    setIsApplying(true);
    setError(null);
    try {
      const data = await postJson<{ outcome?: string }>(
        `/api/subscribers/${encodeURIComponent(imsi)}/profile`,
        buildProfileApplyRequest(profileName),
      );
      setIsApplyOpen(false);
      setApplyImsi('');
      setNotice({
        type: 'success',
        text: data?.outcome === 'no_effect'
          ? t('prof_apply_no_effect', { imsi })
          : t('prof_apply_success', { imsi }),
      });
    } catch (err) {
      setIsApplyOpen(false);
      const detail = err instanceof Error ? err.message : '';
      setError(detail ? `${t('prof_apply_error', { imsi })} (${detail})` : t('prof_apply_error', { imsi }));
    } finally {
      setIsApplying(false);
    }
  };

  const executeClone = async () => {
    if (!profileName) return;
    const target = cloneKey.trim();
    setIsCloning(true);
    setError(null);
    try {
      const created = await postJson<{ name?: string }>(`/api/profiles/${encodeURIComponent(profileName)}/clone`, {
        name: target,
        title: cloneTitle.trim() || undefined,
      });
      setIsCloneOpen(false);
      setCloneKey('');
      setCloneTitle('');
      await globalMutate('/api/profiles');
      router.push(`/profile/${encodeURIComponent(created?.name || target)}`);
    } catch (err) {
      setIsCloneOpen(false);
      setError(err instanceof Error ? err.message : t('prof_clone_err'));
    } finally {
      setIsCloning(false);
    }
  };

  const downloadExport = async () => {
    if (!profileName) return;
    setIsExporting(true);
    setError(null);
    try {
      const blob = await getBlob(`/api/profiles/${encodeURIComponent(profileName)}/export`);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `profile-${profileName.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('prof_export_err'));
    } finally {
      setIsExporting(false);
    }
  };

  const resetDraftAndExit = () => {
    if (isCreate || !profile) {
      router.push('/profile');
      return;
    }
    setDraft(createDraftFromProfile(profile, profileName || ''));
    setIsEditing(false);
    setError(null);
  };

  const requestLeave = () => {
    if (hasUnsavedChanges) {
      setDiscardTarget('leave');
      return;
    }
    router.push('/profile');
  };

  const requestCancelEditing = () => {
    if (hasUnsavedChanges) {
      setDiscardTarget('cancel');
      return;
    }
    resetDraftAndExit();
  };

  const startEditing = () => {
    setError(null);
    setEditingBaseline(draftSignature(draft));
    setIsEditing(true);
  };

  const addSlice = () => {
    setDraft((current) => {
      const currentMaxSd = current.slices.reduce((max: number, slice: any) => {
        const parsed = parseInt(String(slice?.sd ?? '0'), 10);
        return Number.isFinite(parsed) ? Math.max(max, parsed) : max;
      }, 0);
      const nextSd = String(Math.max(1, currentMaxSd + 1)).padStart(6, '0');
      const next = [...current.slices, { default_indicator: current.slices.length === 0, sd: nextSd, sst: 1, session_list: [] }];
      setNewlyAddedSliceIndex(next.length - 1);
      setExpandedSlices((prev) => (prev.includes(next.length - 1) ? prev : [...prev, next.length - 1]));
      return { ...current, slices: next };
    });
  };

  const toggleSliceExpanded = (index: number) => {
    setExpandedSlices((current) => (current.includes(index) ? current.filter((entry) => entry !== index) : [...current, index]));
  };

  const removeSlice = (index: number) => {
    setDraft((current) => ({ ...current, slices: current.slices.filter((_slice, position) => position !== index) }));
  };

  const handleSliceChange = (index: number, slice: any) => {
    setDraft((current) => ({
      ...current,
      slices: current.slices.map((entry, position) => (position === index ? slice : entry)),
    }));
  };

  const setOcsDefaults = (value: Record<string, any>) => {
    setDraft((current) => ({ ...current, ocsDefaults: value }));
  };

  return (
    <div className={`container animate-fade-in ${styles.profilePageContainer}`}>
      <div className={styles.profileDetailBack}>
        <button type="button" className="btn btn-outline" onClick={requestLeave}>
          <ArrowLeft size={16} /> {t('back')}
        </button>
      </div>

      <PageHeader
        eyebrow={t('eyebrow_policy_template')}
        icon={<Boxes size={23} />}
        title={isCreate ? t('prof_new_profile') : (draft.title || profileName || '')}
        description={isCreate ? t('prof_new_desc') : t('prof_detail_subtitle')}
        actions={isCreate || isEditing ? (
          <div className="page-action-buttons">
            <button className="btn btn-outline" onClick={requestCancelEditing}>{t('cancel')}</button>
            <button
              className="btn btn-primary"
              onClick={requestSave}
              disabled={isSaving || (isCreate && (!draft.title.trim() || !draft.key.trim())) || (!isCreate && changedDraftRows.length === 0)}
            >
              <Save size={16} /> {isSaving ? t('sub_btn_saving') : (isCreate ? t('prof_btn_create') : t('prof_btn_save'))}
            </button>
          </div>
        ) : (
          <div className="page-action-buttons">
            {canWrite && (
              <button className="btn btn-primary" onClick={startEditing}>
                <Pencil size={16} /> {t('prof_btn_edit')}
              </button>
            )}
            {!isCreate && (
              <button
                className="btn btn-outline"
                onClick={() => router.push(`/subscribers?profile=${encodeURIComponent(profileName)}`)}
              >
                <Users size={16} /> {t('prof_view_linked')}
              </button>
            )}
            {canApplyTemplates && !isCreate && (
              <button
                className="btn btn-outline"
                onClick={() => { setApplyImsi(''); setIsApplyOpen(true); }}
              >
                <UserPlus size={16} /> {t('prof_apply_btn')}
              </button>
            )}
            {canWrite && (
              <button
                className="btn btn-outline"
                onClick={() => { setCloneKey(''); setCloneTitle(''); setIsCloneOpen(true); }}
              >
                <Copy size={16} /> {t('prof_clone_btn')}
              </button>
            )}
            <button className="btn btn-outline" onClick={() => { void downloadExport(); }} disabled={isExporting}>
              <Download size={16} /> {isExporting ? t('prof_export_busy') : t('prof_export_btn')}
            </button>
            {canWrite && (
              <button className="btn btn-danger" onClick={() => setIsDeleteConfirmOpen(true)} disabled={isDeleting}>
                <Trash2 size={16} /> {t('delete')}
              </button>
            )}
          </div>
        )}
      />

      {notice && (
        <OperationNotice
          presentation="inline"
          tone={notice.type === 'error' ? 'danger' : 'success'}
          message={notice.text}
          onClose={() => setNotice(null)}
        />
      )}
      {error && (
        <OperationNotice
          presentation="inline"
          tone="danger"
          title={t('error')}
          message={error}
          onClose={() => setError(null)}
        />
      )}

      {isDeleteConfirmOpen && (
        <ConfirmActionPanel
          tone="danger"
          title={t('prof_del_confirm', { name: profileName || '' })}
          message={t('prof_del_desc')}
          confirmLabel={t('delete')}
          cancelLabel={t('cancel')}
          isWorking={isDeleting}
          onConfirm={() => { void executeDelete(false); }}
          onCancel={() => setIsDeleteConfirmOpen(false)}
        />
      )}

      {forceDeleteCount !== null && (
        <ConfirmActionPanel
          tone="danger"
          title={t('prof_del_in_use_title', { name: profileName || '' })}
          message={forceDeleteCount === 'unknown'
            ? t('prof_del_in_use_unknown_desc', { name: profileName || '' })
            : t('prof_del_in_use_desc', { count: forceDeleteCount ?? 0, name: profileName || '' })}
          confirmLabel={t('prof_btn_force_delete')}
          cancelLabel={t('cancel')}
          isWorking={isDeleting}
          onConfirm={() => { void executeDelete(true); }}
          onCancel={() => setForceDeleteCount(null)}
        />
      )}

      {isSaveConfirmOpen && (
        <ConfirmActionPanel
          tone={impact.kind === 'known' && impact.count === 0 ? 'info' : 'warning'}
          title={t('prof_change_confirm_title')}
          message={impact.kind === 'unknown'
            ? t('prof_change_confirm_desc_unknown')
            : t('prof_change_confirm_desc', { count: impact.count })}
          confirmLabel={t('prof_change_confirm_btn')}
          cancelLabel={t('cancel')}
          isWorking={isSaving}
          onConfirm={confirmSave}
          onCancel={() => setIsSaveConfirmOpen(false)}
        >
          <div className="pm-confirm-diff-rows">
            <p className="pm-confirm-note">{t('prof_change_confirm_note')}</p>
            <div className="pm-confirm-diff-columns" aria-hidden="true">
              <span />
              <span>{t('prof_diff_stored_col')}</span>
              <span>{t('prof_diff_pending_col')}</span>
            </div>
            {saveDiffSections.map((section) => (
              <div key={section.key} className="pm-confirm-diff-section">
                <div className="pm-confirm-diff-section-title">{t(section.labelKey)}</div>
                {section.rows.map((row) => (
                  <div key={row.key} className="pm-confirm-diff-row changed">
                    <span className="pm-diff-label">
                      {row.labelParams ? t(row.labelKey, row.labelParams) : t(row.labelKey)}
                    </span>
                    <span className="pm-confirm-diff-pair">
                      <span className="pm-confirm-diff-from">{row.versionValue}</span>
                      <span className="pm-confirm-diff-arrow" aria-hidden="true">→</span>
                      <span className="pm-confirm-diff-to">{row.currentValue}</span>
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </ConfirmActionPanel>
      )}

      {isApplyOpen && (
        <ConfirmActionPanel
          tone="warning"
          title={t('prof_apply_title', { name: draft.title || profileName || '' })}
          message={t('prof_apply_desc')}
          confirmLabel={t('prof_apply_confirm')}
          cancelLabel={t('cancel')}
          isWorking={isApplying}
          confirmDisabled={!/^\d{15}$/.test(applyImsi.trim())}
          onConfirm={() => { void executeApply(); }}
          onCancel={() => setIsApplyOpen(false)}
        >
          <div>
            <label className="form-label" htmlFor="profile-apply-imsi">{t('prof_apply_imsi_label')}</label>
            <input
              id="profile-apply-imsi"
              type="text"
              className="form-input"
              inputMode="numeric"
              autoComplete="off"
              value={applyImsi}
              onChange={(event) => setApplyImsi(event.target.value)}
              placeholder={t('prof_apply_imsi_ph')}
            />
            {applyImsi.trim() !== '' && !/^\d{15}$/.test(applyImsi.trim()) && (
              <div className="warning-text">{t('prof_apply_imsi_invalid')}</div>
            )}
          </div>
        </ConfirmActionPanel>
      )}

      {isCloneOpen && (
        <ConfirmActionPanel
          tone="info"
          title={t('prof_clone_title', { name: profileName || '' })}
          message={t('prof_clone_desc')}
          confirmLabel={t('prof_clone_confirm')}
          cancelLabel={t('cancel')}
          isWorking={isCloning}
          confirmDisabled={!cloneKey.trim() || cloneKey.trim() === profileName}
          onConfirm={() => { void executeClone(); }}
          onCancel={() => setIsCloneOpen(false)}
        >
          <div className={styles.profileCloneFields}>
            <div>
              <label className="form-label" htmlFor="profile-clone-key">{t('prof_clone_key_label')}</label>
              <input
                id="profile-clone-key"
                type="text"
                className="form-input"
                autoComplete="off"
                value={cloneKey}
                onChange={(event) => setCloneKey(event.target.value)}
                placeholder={t('prof_clone_key_ph')}
              />
            </div>
            <div>
              <label className="form-label" htmlFor="profile-clone-title">{t('prof_clone_title_label')}</label>
              <input
                id="profile-clone-title"
                type="text"
                className="form-input"
                autoComplete="off"
                value={cloneTitle}
                onChange={(event) => setCloneTitle(event.target.value)}
                placeholder={t('prof_clone_title_ph')}
              />
            </div>
          </div>
        </ConfirmActionPanel>
      )}

      {restoreTarget && (
        <ConfirmActionPanel
          tone="warning"
          title={t('prof_version_restore_confirm_title', { name: profileName || '' })}
          message={t('prof_version_restore_confirm_desc', {
            action: t(`prof_version_action_${restoreTarget.action}`),
            time: formatDateTime(restoreTarget.savedAt || ''),
          })}
          confirmLabel={t('prof_version_restore_confirm_btn')}
          cancelLabel={t('cancel')}
          isWorking={isRestoring}
          onConfirm={() => { void executeRestore(); }}
          onCancel={() => setRestoreTarget(null)}
        />
      )}

      {discardTarget && (
        <ConfirmActionPanel
          tone="warning"
          title={t('unsaved_changes_title')}
          message={t('unsaved_changes_description')}
          confirmLabel={t('unsaved_changes_discard')}
          cancelLabel={t('unsaved_changes_keep_editing')}
          onConfirm={() => {
            const action = discardTarget;
            setDiscardTarget(null);
            if (action === 'leave') {
              router.push('/profile');
              return;
            }
            if (action === 'restore') {
              resetDraftAndExit();
              setRestoreTarget(pendingRestore);
              setPendingRestore(null);
              return;
            }
            resetDraftAndExit();
          }}
          onCancel={() => {
            setDiscardTarget(null);
            setPendingRestore(null);
          }}
        />
      )}

      {isLoading && !isCreate ? (
        <div className={`dash-card ${styles.profileTableState}`}>
          <LoadingRows columns={4} rows={4} />
        </div>
      ) : detailError && !isCreate ? (
        <div className={`dash-card ${styles.profileTableState}`}>
          <ErrorState
            title={t('prof_err_load')}
            message={detailError instanceof Error ? detailError.message : String(detailError)}
            retryLabel={t('retry')}
            onRetry={() => { void mutateDetail(); }}
          />
        </div>
      ) : (
        <>
          <ProfileSectionNav
            sections={sectionAnchors}
            label={t('prof_section_nav_label')}
            onJump={jumpToSection}
          />

          {isEditing ? (
            <ProfileEditMode
              t={t}
              profileName={profileName ?? null}
              state={{
                inputName: draft.title,
                profileTitle: draft.title,
                profileKey: draft.key,
                profileKeyProblem: isCreate ? profileKeyIssue(draft.key) : null,
                authData: draft.auth,
                canEditCredentials,
                usimType: draft.usimType,
                ueAmbr: draft.ueAmbr,
                isAccessRestrictionsExpanded,
                accessRestriction: draft.accessRestriction,
                ocsDefaults: draft.ocsDefaults,
                tariffPlanList: plansData?.plans ?? [],
                ratingList: ratingsData?.ratings ?? [],
                tariffPlanStatus,
                ratingStatus,
                accessBits,
                slices: draft.slices,
                newlyAddedSliceIndex,
                expandedSlices,
              }}
              actions={{
                setInputName: (value: string) => setDraft((current) => ({ ...current, title: value })),
                /* The key follows the title only until the operator edits the key
                 * themselves; after that it is their decision. */
                setProfileTitle: (value: string) => setDraft((current) => ({
                  ...current,
                  title: value,
                  key: isKeyTouched ? current.key : suggestProfileKey(value),
                })),
                setProfileKey: (value: string) => {
                  setIsKeyTouched(true);
                  setDraft((current) => ({ ...current, key: value }));
                },
                setAuthData: (value: ProfileDraft['auth']) => setDraft((current) => ({ ...current, auth: value })),
                setUsimType: (value: ProfileDraft['usimType']) => setDraft((current) => ({ ...current, usimType: value })),
                setUeAmbr: (value: ProfileDraft['ueAmbr']) => setDraft((current) => ({ ...current, ueAmbr: value })),
                setIsAccessRestrictionsExpanded,
                setAccessRestriction: (value: number | null) => setDraft((current) => ({ ...current, accessRestriction: value })),
                setOcsDefaults,
                addSlice,
                handleSliceChange,
                removeSlice,
                toggleSliceExpanded,
                jumpToAnchor,
              }}
            />
          ) : (
            <ProfileViewMode
              t={t}
              authData={draft.auth}
              credentialState={profile?.auth?.credentialState ?? null}
              rawAuth={profile?.auth ?? null}
              usimType={draft.usimType}
              ocsDefaults={draft.ocsDefaults}
              tariffPlanList={plansData?.plans ?? []}
              ratingList={ratingsData?.ratings ?? []}
              ratingStatus={ratingStatus}
              ueAmbr={draft.ueAmbr}
              isAccessRestrictionsExpanded={isAccessRestrictionsExpanded}
              setIsAccessRestrictionsExpanded={setIsAccessRestrictionsExpanded}
              accessRestriction={draft.accessRestriction}
              accessBits={accessBits}
              slices={draft.slices}
              backendStats={detail?.stats ?? null}
              statsUnavailable={statsUnavailable}
            />
          )}

          {!isCreate && !isEditing && canApplyTemplates && profileName && (
            <ProfileDriftCard
              t={t}
              profileName={profileName}
              onRejected={(message) => { setError(message); }}
            />
          )}

          {/* History is a retrieval tool, not the template's content: it sits
              below the workspace and starts collapsed. */}
          {!isCreate && profileName && (
            <ProfileVersionsCard
              t={t}
              formatDateTime={formatDateTime}
              profileName={profileName}
              versions={versionsData?.versions ?? []}
              currentProfile={profile}
              isLoading={isVersionsLoading}
              error={versionsError}
              canRestore={canRestore}
              onRefresh={() => { void mutateVersions(); }}
              onRestore={requestRestore}
            />
          )}
        </>
      )}
    </div>
  );
}
