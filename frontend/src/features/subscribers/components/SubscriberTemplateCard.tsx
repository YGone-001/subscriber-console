/*
 * Template provenance for one subscriber.
 *
 * A subscriber records the template it was provisioned from, but that fact was
 * invisible: the record could be template-governed, bound to a template that no
 * longer exists, or independent, and the console showed the same thing. This card
 * states which of the three it is, and lets the operator re-apply a template
 * after seeing what that would change.
 *
 * The preview is not an estimate: it asks the server, which compares the record
 * with the same projection the governed apply performs.
 */
import { useEffect, useRef, useState } from 'react';
import { Boxes } from 'lucide-react';
import { useI18n } from '../../../providers/I18nProvider';
import { postJson } from '../../../lib/api/mutation-client';
import { ConfirmActionPanel } from '../../../components/ui/OperationFeedback';
import { PROFILE_DRIFT_GROUP_LABEL_KEYS } from '../../profiles/components/ProfileDriftCard';
import { resolveTemplateBinding, type TemplateOption } from '../subscriber-template-binding';
import { buildProfileApplyRequest } from '../mutation-contract';

type DriftEntry = { imsi: string; state: string; changedGroups?: string[] };
type DriftReport = { results?: DriftEntry[] };

type Props = {
  imsi: string;
  binding: string;
  profileList: TemplateOption[];
  profilesReady: boolean;
  canApply: boolean;
  onOpenTemplate: (name: string) => void;
  onApplied: (message: string) => void;
  onError: (message: string) => void;
};

function groupLabel(t: (key: string) => string, group: string): string {
  return t(PROFILE_DRIFT_GROUP_LABEL_KEYS[group] ?? 'prof_drift_group_other');
}

export function SubscriberTemplateCard({
  imsi, binding, profileList, profilesReady, canApply, onOpenTemplate, onApplied, onError,
}: Props) {
  const { t } = useI18n();
  const [isApplyOpen, setIsApplyOpen] = useState(false);
  const [picked, setPicked] = useState('');
  const [preview, setPreview] = useState<DriftEntry | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [isApplying, setIsApplying] = useState(false);

  const [check, setCheck] = useState<DriftEntry | null>(null);
  const [isChecking, setIsChecking] = useState(false);

  /* A preview answers for one (template, subscriber) pair; a slower earlier
   * request must not overwrite the newer selection. */
  const previewToken = useRef(0);

  const bindingInfo = resolveTemplateBinding(binding, profileList, profilesReady);
  const boundTemplate = bindingInfo.template;
  const bindingState = bindingInfo.state;

  const requestPreview = async (templateName: string) => {
    const token = previewToken.current + 1;
    previewToken.current = token;
    setIsPreviewing(true);
    setPreviewError('');
    setPreview(null);
    try {
      const report = await postJson<DriftReport>(
        `/api/profiles/${encodeURIComponent(templateName)}/drift-precheck`,
        { imsis: [imsi] },
      );
      if (previewToken.current !== token) return;
      const entry = (report?.results ?? []).find((row) => row.imsi === imsi) ?? (report?.results ?? [])[0] ?? null;
      setPreview(entry);
    } catch (error) {
      if (previewToken.current !== token) return;
      setPreviewError(error instanceof Error ? error.message : String(error));
    } finally {
      if (previewToken.current === token) setIsPreviewing(false);
    }
  };

  useEffect(() => {
    if (!isApplyOpen || !picked) return;
    void requestPreview(picked);
  }, [isApplyOpen, picked]);

  const closeApply = () => {
    setIsApplyOpen(false);
    setPicked('');
    setPreview(null);
    setPreviewError('');
    previewToken.current += 1;
  };

  const executeApply = async () => {
    const templateName = picked.trim();
    if (!templateName) return;
    setIsApplying(true);
    try {
      const data = await postJson<{ outcome?: string }>(
        `/api/subscribers/${encodeURIComponent(imsi)}/profile`,
        buildProfileApplyRequest(templateName),
      );
      closeApply();
      onApplied(data?.outcome === 'no_effect'
        ? t('sub_apply_profile_no_effect', { imsi })
        : t('sub_apply_profile_success', { imsi, name: templateName }));
    } catch (error) {
      const detail = error instanceof Error && error.message ? ` (${error.message})` : '';
      onError(`${t('sub_apply_profile_error', { imsi })}${detail}`);
      closeApply();
    } finally {
      setIsApplying(false);
    }
  };

  const runCheck = async () => {
    if (!bindingInfo.name || !boundTemplate) return;
    setIsChecking(true);
    setCheck(null);
    try {
      const report = await postJson<DriftReport>(
        `/api/profiles/${encodeURIComponent(bindingInfo.name)}/drift-precheck`,
        { imsis: [imsi] },
      );
      setCheck((report?.results ?? []).find((row) => row.imsi === imsi) ?? null);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsChecking(false);
    }
  };

  const previewSummary = (() => {
    if (isPreviewing) return t('sub_tpl_previewing');
    if (previewError) return t('sub_tpl_preview_failed', { error: previewError });
    if (!preview) return '';
    if (preview.state === 'unknown') return t('sub_tpl_preview_unknown');
    if (preview.state === 'in_sync') return t('sub_tpl_preview_sync');
    const groups = (preview.changedGroups ?? []).map((group) => groupLabel(t, group)).join(' · ');
    return t('sub_tpl_preview_changed', { groups: groups || t('prof_drift_state_changed') });
  })();

  const checkSummary = (() => {
    if (isChecking) return t('sub_tpl_checking');
    if (!check) return '';
    if (check.state === 'unknown') return t('sub_tpl_check_unknown');
    if (check.state === 'in_sync') return t('sub_tpl_check_sync');
    const groups = (check.changedGroups ?? []).map((group) => groupLabel(t, group)).join(' · ');
    return t('sub_tpl_check_changed', { groups: groups || t('prof_drift_state_changed') });
  })();

  return (
    <div className="dash-card">
      <div className="dash-card-header">
        <Boxes size={20} color="var(--primary)" />
        <h3 className="section-header-title">{t('sub_tpl_title')}</h3>
      </div>
      <div className="dash-card-body">
        <div className="subscriber-template-binding">
          {bindingState === 'bound' && (
            <span className="status-badge active">{t('sub_tpl_bound')}</span>
          )}
          {bindingState === 'dangling' && (
            <span className="status-badge suspended" title={t('sub_tpl_dangling_hint')}>{t('sub_tpl_dangling')}</span>
          )}
          {bindingState === 'unbound' && (
            <span className="status-badge partial">{t('sub_tpl_unbound')}</span>
          )}
          <span className="policy-text">{bindingInfo.name || t('sub_tpl_unbound')}</span>
        </div>

        {bindingState === 'dangling' && (
          <p className="warning-text">{t('sub_tpl_dangling_hint')}</p>
        )}

        <div className="page-action-buttons" style={{ marginTop: 'var(--space-3, 12px)' }}>
          {bindingState === 'bound' && boundTemplate && (
            <button type="button" className="btn btn-outline" onClick={() => onOpenTemplate(bindingInfo.name)}>
              {t('sub_tpl_view')}
            </button>
          )}
          {bindingState === 'bound' && (
            <button type="button" className="btn btn-outline" onClick={() => { void runCheck(); }} disabled={isChecking}>
              {isChecking ? t('sub_tpl_checking') : t('sub_tpl_check')}
            </button>
          )}
          {canApply && (
            <button type="button" className="btn btn-outline" onClick={() => setIsApplyOpen(true)}>
              {t('sub_tpl_apply')}
            </button>
          )}
        </div>

        {checkSummary && <p className="text-muted">{checkSummary}</p>}
      </div>

      {isApplyOpen && (
        <ConfirmActionPanel
          tone="warning"
          title={t('sub_apply_profile_title', { imsi })}
          message={t('sub_apply_profile_desc', { imsi })}
          confirmLabel={t('sub_apply_profile_confirm')}
          cancelLabel={t('cancel')}
          isWorking={isApplying}
          confirmDisabled={!picked.trim() || isPreviewing || !preview || preview.state === 'unknown'}
          onConfirm={() => { void executeApply(); }}
          onCancel={closeApply}
        >
          <div>
            <label className="form-label" htmlFor="subscriber-template-select">{t('profile_template')}</label>
            <select
              id="subscriber-template-select"
              className="form-input"
              value={picked}
              onChange={(event) => setPicked(event.target.value)}
              disabled={profileList.length === 0}
            >
              <option value="">{profileList.length > 0 ? t('sub_apply_profile_pick') : t('sub_no_profiles')}</option>
              {profileList.map((template) => (
                <option key={template.name} value={template.name}>
                  {template.title || template.name}
                </option>
              ))}
            </select>
          </div>
          {previewSummary && (
            <p className={previewError ? 'warning-text' : 'text-muted'} role="status">{previewSummary}</p>
          )}
        </ConfirmActionPanel>
      )}
    </div>
  );
}
