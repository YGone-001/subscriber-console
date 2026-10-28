/*
 * Tariff plan create/edit dialog.
 *
 * The historical form sent raw byte and second counts typed by hand, prefilled
 * defaults that disagreed with the backend (100 MiB / 10 MiB against the server's
 * 1 GiB / 1 MiB), coerced an empty or malformed field to 0 through
 * `Number(value) || 0`, and labelled the description textarea "status / reason".
 *
 * This version keeps the same request body (`name`, `description`,
 * `quota_per_grant`, `validity_time`, `volume_threshold`, plus `plan_id` on
 * create) while fixing the four defects:
 *
 *   - each magnitude field has a unit selector and the request carries the
 *     converted integer;
 *   - the defaults match the server defaults, so a form left untouched produces
 *     the same document as an API create with no quota fields;
 *   - an empty or malformed field blocks submission instead of silently writing
 *     zero, and the volume threshold may not exceed the granted quota;
 *   - the description field has its own label.
 */
import { useEffect, useState } from 'react';
import { AlertCircle, X } from 'lucide-react';
import { useI18n } from '../../../providers/I18nProvider';
import { postJson, putJson } from '../../../lib/api/mutation-client';
import { formatBytes, formatSeconds, splitByteInput, splitSecondsInput } from '../../../lib/unitParser';
import type { TariffPlanViewModel } from '../../../features/ocs/ocs-view-models';

interface TariffPlanModalProps {
  isOpen: boolean;
  onClose: () => void;
  plan?: TariffPlanViewModel | null;
  onSuccess: (result: { outcome: string; message: string }) => void;
}

/* Server defaults (tariff.createPlanBody): 1 GiB, one day, 1 MiB. */
const DEFAULT_QUOTA = '1';
const DEFAULT_QUOTA_UNIT = 'GB';
const DEFAULT_VALIDITY = '1';
const DEFAULT_VALIDITY_UNIT = 'd';
const DEFAULT_THRESHOLD = '1';
const DEFAULT_THRESHOLD_UNIT = 'MB';

const PLAN_ID_PATTERN = /^[a-zA-Z0-9_-]{3,80}$/;

const BYTE_FACTOR: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };
const SECOND_FACTOR: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

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
  const [quotaValue, setQuotaValue] = useState(DEFAULT_QUOTA);
  const [quotaUnit, setQuotaUnit] = useState(DEFAULT_QUOTA_UNIT);
  const [validityValue, setValidityValue] = useState(DEFAULT_VALIDITY);
  const [validityUnit, setValidityUnit] = useState(DEFAULT_VALIDITY_UNIT);
  const [thresholdValue, setThresholdValue] = useState(DEFAULT_THRESHOLD);
  const [thresholdUnit, setThresholdUnit] = useState(DEFAULT_THRESHOLD_UNIT);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (plan) {
      const quota = splitByteInput(plan.quotaPerGrant ?? 0, 'GB');
      const validity = splitSecondsInput(plan.validityTime ?? 0, 'd');
      const threshold = splitByteInput(plan.volumeThreshold ?? 0, 'MB');
      setPlanId(plan.planId ?? '');
      setName(plan.name || '');
      setDescription(plan.description || '');
      setQuotaValue(quota.value);
      setQuotaUnit(quota.unit);
      setValidityValue(validity.value);
      setValidityUnit(validity.unit);
      setThresholdValue(threshold.value);
      setThresholdUnit(threshold.unit);
    } else {
      setPlanId('');
      setName('');
      setDescription('');
      setQuotaValue(DEFAULT_QUOTA);
      setQuotaUnit(DEFAULT_QUOTA_UNIT);
      setValidityValue(DEFAULT_VALIDITY);
      setValidityUnit(DEFAULT_VALIDITY_UNIT);
      setThresholdValue(DEFAULT_THRESHOLD);
      setThresholdUnit(DEFAULT_THRESHOLD_UNIT);
    }
    setError(null);
  }, [plan, isOpen]);

  const toBytes = (value: string, unit: string): number | null => {
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed) || parsed < 0) return null;
    const factor = BYTE_FACTOR[unit];
    return Number.isFinite(factor) ? Math.round(parsed * factor) : null;
  };

  const toSeconds = (value: string, unit: string): number | null => {
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    const factor = SECOND_FACTOR[unit];
    return Number.isFinite(factor) ? Math.round(parsed * factor) : null;
  };

  const quotaBytes = toBytes(quotaValue, quotaUnit);
  const thresholdBytes = toBytes(thresholdValue, thresholdUnit);
  const validitySeconds = toSeconds(validityValue, validityUnit);

  if (!isOpen) return null;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    const trimmedPlanId = planId.trim();
    const trimmedName = name.trim();

    if (!isEdit && !PLAN_ID_PATTERN.test(trimmedPlanId)) {
      setError(t('ocs_tariff_plan_id_required'));
      return;
    }
    if (!trimmedName) {
      setError(t('ocs_tariff_name_required'));
      return;
    }
    if (quotaBytes === null || quotaBytes <= 0) {
      setError(t('ocs_tariff_quota_invalid'));
      return;
    }
    if (validitySeconds === null) {
      setError(t('ocs_tariff_validity_invalid'));
      return;
    }
    if (thresholdBytes === null || thresholdBytes <= 0) {
      setError(t('ocs_tariff_threshold_invalid'));
      return;
    }
    if (thresholdBytes > quotaBytes) {
      setError(t('ocs_tariff_threshold_over_quota'));
      return;
    }

    setSubmitting(true);
    try {
      const payload: Record<string, unknown> = {
        name: trimmedName,
        description: description.trim(),
        quota_per_grant: quotaBytes,
        validity_time: validitySeconds,
        volume_threshold: thresholdBytes,
      };

      let result: { outcome?: string };
      if (isEdit) {
        result = await putJson<{ outcome?: string }>(
          `/api/tariff-plans/${encodeURIComponent(trimmedPlanId)}`,
          payload,
        );
      } else {
        result = await postJson<{ outcome?: string }>('/api/tariff-plans', { ...payload, plan_id: trimmedPlanId });
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
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="ocs-modal-body">
            {error && (
              <div className="ocs-feedback-error ocs-feedback-spaced" role="alert">
                <AlertCircle size={16} aria-hidden="true" />
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
                placeholder="plan_standard_5g"
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
                {t('ocs_tariff_col_description')}
              </label>
              <textarea
                id="tariff-plan-desc"
                className="ocs-form-textarea"
                rows={2}
                value={description}
                disabled={submitting}
                onChange={(event) => setDescription(event.target.value)}
                placeholder={t('ocs_tariff_col_description')}
              />
            </div>

            <div className="ocs-form-group">
              <label htmlFor="tariff-quota-grant" className="ocs-form-label">
                {t('ocs_tariff_quota_per_grant')}
              </label>
              <div className="ocs-amount-row">
                <input
                  id="tariff-quota-grant"
                  type="number"
                  step="any"
                  min="0"
                  className="ocs-form-input ocs-mono"
                  value={quotaValue}
                  disabled={submitting}
                  onChange={(event) => setQuotaValue(event.target.value)}
                />
                <select
                  className="ocs-select ocs-select-unit"
                  value={quotaUnit}
                  aria-label={`${t('ocs_tariff_quota_per_grant')} ${t('ocs_unit_label')}`}
                  disabled={submitting}
                  onChange={(event) => setQuotaUnit(event.target.value)}
                >
                  <option value="B">{t('ocs_unit_bytes')}</option>
                  <option value="MB">MB</option>
                  <option value="GB">GB</option>
                </select>
              </div>
              <span className="ocs-form-hint">
                {quotaBytes === null ? t('ocs_tariff_quota_invalid') : `= ${formatBytes(quotaBytes)}`}
              </span>
            </div>

            <div className="ocs-form-grid-2">
              <div className="ocs-form-group">
                <label htmlFor="tariff-validity" className="ocs-form-label">
                  {t('ocs_tariff_validity_time')}
                </label>
                <div className="ocs-amount-row">
                  <input
                    id="tariff-validity"
                    type="number"
                    step="any"
                    min="0"
                    className="ocs-form-input ocs-mono"
                    value={validityValue}
                    disabled={submitting}
                    onChange={(event) => setValidityValue(event.target.value)}
                  />
                  <select
                    className="ocs-select ocs-select-unit"
                    value={validityUnit}
                    aria-label={`${t('ocs_tariff_validity_time')} ${t('ocs_unit_label')}`}
                    disabled={submitting}
                    onChange={(event) => setValidityUnit(event.target.value)}
                  >
                    <option value="m">{t('ocs_unit_minute')}</option>
                    <option value="h">{t('ocs_unit_hour')}</option>
                    <option value="d">{t('ocs_unit_day')}</option>
                  </select>
                </div>
                <span className="ocs-form-hint">
                  {validitySeconds === null ? t('ocs_tariff_validity_invalid') : `= ${formatSeconds(validitySeconds)}`}
                </span>
              </div>

              <div className="ocs-form-group">
                <label htmlFor="tariff-threshold" className="ocs-form-label">
                  {t('ocs_tariff_volume_threshold')}
                </label>
                <div className="ocs-amount-row">
                  <input
                    id="tariff-threshold"
                    type="number"
                    step="any"
                    min="0"
                    className="ocs-form-input ocs-mono"
                    value={thresholdValue}
                    disabled={submitting}
                    onChange={(event) => setThresholdValue(event.target.value)}
                  />
                  <select
                    className="ocs-select ocs-select-unit"
                    value={thresholdUnit}
                    aria-label={`${t('ocs_tariff_volume_threshold')} ${t('ocs_unit_label')}`}
                    disabled={submitting}
                    onChange={(event) => setThresholdUnit(event.target.value)}
                  >
                    <option value="B">{t('ocs_unit_bytes')}</option>
                    <option value="MB">MB</option>
                    <option value="GB">GB</option>
                  </select>
                </div>
                <span className="ocs-form-hint">
                  {thresholdBytes === null ? t('ocs_tariff_threshold_invalid') : `= ${formatBytes(thresholdBytes)}`}
                </span>
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
