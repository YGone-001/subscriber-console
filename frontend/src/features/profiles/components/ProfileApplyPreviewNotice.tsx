import { useI18n } from '../../../providers/I18nProvider';
import { PROFILE_APPLY_GROUP_LABEL_KEYS, type ProfileApplyPreview } from '../profile-apply-preview';

export function ProfileApplyPreviewNotice({
  preview,
  loading,
  error,
}: {
  preview: ProfileApplyPreview | null;
  loading: boolean;
  error: string;
}) {
  const { t } = useI18n();
  if (loading) return <p className="text-muted" role="status">{t('loading')}</p>;
  if (error) return <p className="warning-text" role="alert">{t('prof_apply_preview_failed', { error })}</p>;
  if (!preview) return null;
  if (preview.noEffect) return <p className="text-muted" role="status">{t('prof_apply_preview_no_effect')}</p>;
  const groups = preview.changedGroups
    .map((group) => t(PROFILE_APPLY_GROUP_LABEL_KEYS[group] ?? 'prof_apply_group_other'))
    .join(' · ');
  return (
    <div role="status">
      <p className="text-muted">{t('prof_apply_preview_changed', { groups: groups || t('prof_drift_state_changed') })}</p>
      {preview.securityChanged && <p className="warning-text">{t('prof_apply_preview_security')}</p>}
    </div>
  );
}
