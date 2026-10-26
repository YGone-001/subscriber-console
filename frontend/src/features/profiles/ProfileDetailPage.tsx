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
import { ArrowLeft, Boxes, Pencil, Save, Trash2, UserPlus, Users } from 'lucide-react';
import { useI18n } from '../../providers/I18nProvider';
import { useAuth } from '../../providers/AuthProvider';
import { useRead } from '../../lib/api/use-read';
import { MutationApiError, deleteJson, postJson, putJson } from '../../lib/api/mutation-client';
import { buildProfileApplyRequest } from '../subscribers/mutation-contract';
import { useAppParam, useAppRouter } from '../../lib/ui-compat/router';
import { hasPermission } from '../../lib/permissions';
import PageHeader from '../../components/ui/PageHeader';
import { ErrorState } from '../../components/ui/StatePanel';
import { ConfirmActionPanel, LoadingRows, OperationNotice } from '../../components/ui/OperationFeedback';
import ProfileViewMode from './components/ProfileViewMode';
import ProfileEditMode from './components/ProfileEditMode';
import { ProfileVersionsCard } from './components/ProfileVersionsCard';
import {
  buildDraftChangeRows,
  buildProfileKeyFromTitle,
  buildProfilePayload,
  createDraftFromProfile,
  createEmptyDraft,
  draftSignature,
  type ProfileDraft,
} from './profile-draft';
import { findProfileDraftIssue, type ProfileDraftIssue } from './profile-validation';
import type {
  ProfileDetailResponse,
  ProfileMetaResponse,
  ProfileVersionDetail,
  ProfileVersionsResponse,
  RatingsResponse,
  TariffPlansResponse,
} from './profile-types';

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
  const [editingBaseline, setEditingBaseline] = useState<string | null>(() => (isCreate ? draftSignature(createEmptyDraft()) : null));
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);
  const [forceDeleteCount, setForceDeleteCount] = useState<number | null>(null);
  const [isSaveConfirmOpen, setIsSaveConfirmOpen] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<ProfileVersionDetail | null>(null);
  const [discardTarget, setDiscardTarget] = useState<'leave' | 'cancel' | null>(null);
  const [isAccessRestrictionsExpanded, setIsAccessRestrictionsExpanded] = useState(false);
  const [newlyAddedSliceIndex, setNewlyAddedSliceIndex] = useState<number | null>(null);
  const [expandedSlices, setExpandedSlices] = useState<number[]>([0]);
  const [isApplyOpen, setIsApplyOpen] = useState(false);
  const [applyImsi, setApplyImsi] = useState('');
  const [isApplying, setIsApplying] = useState(false);

  useEffect(() => {
    if (!profile || isEditing) return;
    setDraft(createDraftFromProfile(profile, profileName || ''));
  }, [profile, isEditing, profileName]);

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
  /* Applying a template to a subscriber is the governed subscriber write, so the
   * entry point follows the subscriber capability, not the template one. */
  const canApplyTemplates = hasPermission(user, 'subscribers.write');
  const accessBits = meta?.accessRestriction.bits ?? null;

  const impactedSubscribers = detail?.stats?.totalSubscribers ?? 0;
  const hasUnsavedChanges = isEditing && editingBaseline !== null && editingBaseline !== draftSignature(draft);

  const draftPayload = useMemo(
    () => (profile ? buildProfilePayload(draft, profileName || '', !!profile.ocsDefaults) : {}),
    [draft, profile, profileName],
  );
  const draftChangeRows = useMemo(
    () => (profile ? buildDraftChangeRows(draftPayload, profile) : []),
    [draftPayload, profile],
  );
  const changedDraftRows = draftChangeRows.filter((row) => row.changed);
  const changedSectionText = changedDraftRows.map((row) => t(row.labelKey)).join(', ') || t('prof_change_none');

  const describeIssue = (issue: ProfileDraftIssue): string => {
    switch (issue.code) {
      case 'nameRequired':
        return t('prof_err_name_req');
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
    const targetName = profileName || buildProfileKeyFromTitle(draft.title);
    const issue = findProfileDraftIssue({ name: targetName, auth: draft.auth, ambr: draft.ueAmbr, slices: draft.slices });
    if (issue) {
      setError(describeIssue(issue));
      return null;
    }
    return { targetName, payload: buildProfilePayload(draft, targetName, !!profile?.ocsDefaults) };
  };

  const submit = async (targetName: string, payload: Record<string, unknown>) => {
    setIsSaving(true);
    setError(null);
    try {
      if (isCreate) {
        await postJson('/api/profiles', { name: targetName });
      }
      try {
        await putJson(`/api/profiles/${encodeURIComponent(targetName)}`, payload);
      } catch (err) {
        if (isCreate) {
          const detailMessage = err instanceof Error ? err.message : '';
          throw new Error(t('prof_err_create_partial', { detail: detailMessage }));
        }
        throw err;
      }
      setIsSaveConfirmOpen(false);
      setIsEditing(false);
      setNotice({ type: 'success', text: t('prof_msg_saved') });
      await globalMutate('/api/profiles');
      if (isCreate) {
        router.replace(`/profile/${encodeURIComponent(targetName)}`);
        return;
      }
      await mutateDetail();
      await mutateVersions();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('prof_err_save'));
    } finally {
      setIsSaving(false);
    }
  };

  const requestSave = () => {
    const prepared = prepareSave();
    if (!prepared) return;
    if (profileName) {
      const preparedRows = buildDraftChangeRows(prepared.payload, profile).filter((row) => row.changed);
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
      await deleteJson(`/api/profiles/${encodeURIComponent(profileName)}${force ? '?force=true' : ''}`);
      await globalMutate('/api/profiles');
      router.push('/profile');
    } catch (err) {
      setIsDeleteConfirmOpen(false);
      const message = err instanceof Error ? err.message : t('prof_err_delete');
      const conflict = err instanceof MutationApiError
        && err.status === 409
        && (err.code === 'PROFILE_IN_USE' || /in use by/i.test(message));
      if (conflict) {
        const parsed = Number(message.match(/(\d+)/)?.[1] ?? 0);
        setForceDeleteCount(parsed > 0 ? parsed : (impactedSubscribers || 1));
        return;
      }
      setError(message);
    } finally {
      setIsDeleting(false);
    }
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
    <div className="container animate-fade-in profile-page-container">
      <div className="profile-detail-back">
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
              disabled={isSaving || (isCreate && !draft.title.trim())}
            >
              <Save size={16} /> {isSaving ? t('sub_btn_saving') : (isCreate ? t('prof_btn_create') : t('prof_btn_save'))}
            </button>
          </div>
        ) : (
          <div className="page-action-buttons">
            {canApplyTemplates && !isCreate && (
              <button
                className="btn btn-outline"
                onClick={() => { setApplyImsi(''); setIsApplyOpen(true); }}
              >
                <UserPlus size={16} /> {t('prof_apply_btn')}
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
            {canWrite && (
              <button className="btn btn-outline" onClick={() => setIsDeleteConfirmOpen(true)} disabled={isDeleting}>
                <Trash2 size={16} /> {t('delete')}
              </button>
            )}
            {canWrite && (
              <button className="btn btn-primary" onClick={startEditing}>
                <Pencil size={16} /> {t('prof_btn_edit')}
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
          message={t('prof_del_in_use_desc', { count: forceDeleteCount, name: profileName || '' })}
          confirmLabel={t('prof_btn_force_delete')}
          cancelLabel={t('cancel')}
          isWorking={isDeleting}
          onConfirm={() => { void executeDelete(true); }}
          onCancel={() => setForceDeleteCount(null)}
        />
      )}

      {isSaveConfirmOpen && (
        <ConfirmActionPanel
          tone={impactedSubscribers > 0 ? 'warning' : 'info'}
          title={t('prof_change_confirm_title')}
          message={t('prof_change_confirm_desc', {
            count: impactedSubscribers,
            sections: changedSectionText,
          })}
          confirmLabel={t('prof_change_confirm_btn')}
          cancelLabel={t('cancel')}
          isWorking={isSaving}
          onConfirm={confirmSave}
          onCancel={() => setIsSaveConfirmOpen(false)}
        >
          <div className="pm-confirm-diff-rows">
            {draftChangeRows.map((row) => (
              <div key={row.key} className="pm-confirm-diff-row">
                <span className="pm-diff-label">{t(row.labelKey)}</span>
                <strong className={row.changed ? 'pm-confirm-diff-changed' : 'pm-confirm-diff-unchanged'}>
                  {row.changed ? t('prof_version_changed') : t('prof_version_unchanged')}
                </strong>
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
            resetDraftAndExit();
          }}
          onCancel={() => setDiscardTarget(null)}
        />
      )}

      {isLoading && !isCreate ? (
        <div className="dash-card profile-table-state">
          <LoadingRows columns={4} rows={4} />
        </div>
      ) : detailError && !isCreate ? (
        <div className="dash-card profile-table-state">
          <ErrorState
            title={t('prof_err_load')}
            message={detailError instanceof Error ? detailError.message : String(detailError)}
            retryLabel={t('retry')}
            onRetry={() => { void mutateDetail(); }}
          />
        </div>
      ) : (
        <>
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
              onRestore={setRestoreTarget}
            />
          )}

          {isEditing ? (
            <ProfileEditMode
              t={t}
              profileName={profileName ?? null}
              state={{
                inputName: draft.title,
                profileTitle: draft.title,
                authData: draft.auth,
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
                setProfileTitle: (value: string) => setDraft((current) => ({ ...current, title: value })),
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
              }}
            />
          ) : (
            <ProfileViewMode
              t={t}
              authData={draft.auth}
              credentialsMasked={credentialsMasked}
              usimType={draft.usimType}
              ocsDefaults={draft.ocsDefaults}
              tariffPlanList={plansData?.plans ?? []}
              ratingList={ratingsData?.ratings ?? []}
              ratingStatus={ratingStatus}
              ueAmbr={draft.ueAmbr}
              isAccessRestrictionsExpanded={isAccessRestrictionsExpanded}
              setIsAccessRestrictionsExpanded={setIsAccessRestrictionsExpanded}
              accessRestriction={draft.accessRestriction}
              slices={draft.slices}
              backendStats={detail?.stats ?? null}
            />
          )}
        </>
      )}
    </div>
  );
}
