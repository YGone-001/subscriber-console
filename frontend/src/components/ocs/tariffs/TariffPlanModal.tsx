/*
 * Forward-ported from the historical xCloud UI (reference commit 2c40903):
 * frontend/src/components/ocs/tariffs/TariffPlanModal.tsx
 *
 * Adaptations: "use client" dropped; `@/` aliases replaced with relative imports;
 * the raw `fetch` calls replaced by the current mutation client so validation,
 * conflict and rate-limit failures surface through the shared error contract.
 * The request bodies (`name`, `description`, `quota_per_grant`, `validity_time`,
 * `volume_threshold`, and `plan_id` on create) are unchanged.
 *
 * Note: the reference markup uses `ocs-modal-backdrop` / `ocs-modal-container`,
 * which the reference stylesheet does not define. The class names are kept for
 * DOM parity and the missing rules are supplied in `styles/ocs.css`.
 */
import { useEffect, useState } from 'react';
import { AlertCircle, X } from 'lucide-react';
import { useI18n } from '../../../providers/I18nProvider';
import { postJson, putJson } from '../../../lib/api/mutation-client';
import type { TariffPlanViewModel } from '../../../features/ocs/ocs-view-models';

interface TariffPlanModalProps {
  isOpen: boolean;
  onClose: () => void;
  plan?: TariffPlanViewModel | null;
  onSuccess: (result: { outcome: string; message: string }) => void;
}

export default function TariffPlanModal({
  isOpen,
  onClose,
  plan,
  onSuccess,
}: TariffPlanModalProps) {
  const { t } = useI18n();

  const isEdit = Boolean(plan);
  const [planId, setPlanId] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [quotaPerGrant, setQuotaPerGrant] = useState('104857600');
  const [validityTime, setValidityTime] = useState('86400');
  const [volumeThreshold, setVolumeThreshold] = useState('10485760');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (plan) {
      setPlanId(plan.planId ?? '');
      setName(plan.name || '');
      setDescription(plan.description || '');
      setQuotaPerGrant(String(plan.quotaPerGrant ?? 104857600));
      setValidityTime(String(plan.validityTime ?? 86400));
      setVolumeThreshold(String(plan.volumeThreshold ?? 10485760));
    } else {
      setPlanId('');
      setName('');
      setDescription('');
      setQuotaPerGrant('104857600');
      setValidityTime('86400');
      setVolumeThreshold('10485760');
    }
    setError(null);
  }, [plan, isOpen]);

  if (!isOpen) return null;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    const trimmedPlanId = planId.trim();
    const trimmedName = name.trim();

    if (!isEdit && !trimmedPlanId) {
      setError(t('ocs_tariff_plan_id_required'));
      return;
    }

    if (!trimmedName) {
      setError(t('ocs_tariff_name_required'));
      return;
    }

    setSubmitting(true);
    try {
      const payload: Record<string, unknown> = {
        name: trimmedName,
        description: description.trim(),
        quota_per_grant: Number(quotaPerGrant) || 0,
        validity_time: Number(validityTime) || 0,
        volume_threshold: Number(volumeThreshold) || 0,
      };

      let result: { outcome?: string };
      if (isEdit) {
        result = await putJson<{ outcome?: string }>(
          `/api/tariff-plans/${encodeURIComponent(trimmedPlanId)}`,
          payload,
        );
      } else {
        result = await postJson<{ outcome?: string }>('/api/tariff-plans', {
          ...payload,
          plan_id: trimmedPlanId,
        });
      }

      onSuccess({
        outcome: result?.outcome || 'success',
        message: t('ocs_tariff_action_success'),
      });
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('ocs_tariff_action_failed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="ocs-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="tariff-plan-modal-title"
      onClick={onClose}
    >
      <div className="ocs-modal-container" onClick={(event) => event.stopPropagation()}>
        <div className="ocs-modal-header">
          <div>
            <h2 id="tariff-plan-modal-title" className="ocs-modal-title">
              {isEdit ? t('ocs_tariff_modal_edit_title') : t('ocs_tariff_modal_create_title')}
            </h2>
            <p className="ocs-modal-subtitle">{t('ocs_tariff_modal_desc')}</p>
          </div>
          <button
            type="button"
            className="ocs-modal-close"
            onClick={onClose}
            aria-label={t('close')}
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="ocs-modal-body">
            {error && (
              <div className="ocs-feedback-error ocs-feedback-spaced">
                <AlertCircle size={16} />
                <span>{error}</span>
              </div>
            )}

            <div className="ocs-form-group">
              <label htmlFor="tariff-plan-id" className="ocs-form-label">
                {t('ocs_tariff_col_plan_id')} *
              </label>
              <input
                id="tariff-plan-id"
                type="text"
                className="ocs-form-input ocs-mono"
                value={planId}
                disabled={isEdit || submitting}
                onChange={(event) => setPlanId(event.target.value)}
                placeholder="e.g. plan_standard_5g"
                required
              />
            </div>

            <div className="ocs-form-group">
              <label htmlFor="tariff-plan-name" className="ocs-form-label">
                {t('ocs_tariff_col_name')} *
              </label>
              <input
                id="tariff-plan-name"
                type="text"
                className="ocs-form-input"
                value={name}
                disabled={submitting}
                onChange={(event) => setName(event.target.value)}
                placeholder="Standard 5G Unlimited"
                required
              />
            </div>

            <div className="ocs-form-group">
              <label htmlFor="tariff-plan-desc" className="ocs-form-label">
                {t('ocs_tariff_col_status')} / {t('ocs_balance_reason')}
              </label>
              <textarea
                id="tariff-plan-desc"
                className="ocs-form-textarea"
                rows={2}
                value={description}
                disabled={submitting}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Description of plan and charging characteristics"
              />
            </div>

            <div className="ocs-form-group">
              <label htmlFor="tariff-quota-grant" className="ocs-form-label">
                {t('ocs_tariff_quota_per_grant')}
              </label>
              <input
                id="tariff-quota-grant"
                type="number"
                className="ocs-form-input ocs-mono"
                value={quotaPerGrant}
                disabled={submitting}
                onChange={(event) => setQuotaPerGrant(event.target.value)}
                min="0"
              />
            </div>

            <div className="ocs-form-grid-2">
              <div className="ocs-form-group">
                <label htmlFor="tariff-validity" className="ocs-form-label">
                  {t('ocs_tariff_validity_time')}
                </label>
                <input
                  id="tariff-validity"
                  type="number"
                  className="ocs-form-input ocs-mono"
                  value={validityTime}
                  disabled={submitting}
                  onChange={(event) => setValidityTime(event.target.value)}
                  min="0"
                />
              </div>

              <div className="ocs-form-group">
                <label htmlFor="tariff-threshold" className="ocs-form-label">
                  {t('ocs_tariff_volume_threshold')}
                </label>
                <input
                  id="tariff-threshold"
                  type="number"
                  className="ocs-form-input ocs-mono"
                  value={volumeThreshold}
                  disabled={submitting}
                  onChange={(event) => setVolumeThreshold(event.target.value)}
                  min="0"
                />
              </div>
            </div>
          </div>

          <div className="ocs-modal-footer">
            <button
              type="button"
              className="ocs-btn ocs-btn-secondary"
              onClick={onClose}
              disabled={submitting}
            >
              {t('cancel')}
            </button>
            <button
              type="submit"
              className="ocs-btn ocs-btn-primary"
              disabled={submitting}
            >
              {submitting ? t('saving') : t('confirm')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
