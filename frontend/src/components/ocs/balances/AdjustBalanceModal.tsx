/*
 * Forward-ported from the historical xCloud UI (reference commit 2c40903):
 * frontend/src/components/ocs/balances/AdjustBalanceModal.tsx
 *
 * Adaptations: "use client" dropped; `@/` aliases replaced with relative imports;
 * the raw `fetch` replaced by the current mutation client, so the 409
 * precondition conflict and the 502 backend-unreachable code arrive through the
 * shared error contract instead of being re-parsed from the response body.
 *
 * The request body is unchanged: `{ operation, bucket, amount, reason, ticketId }`
 * to `POST /api/ocs/balances/{imsi}/adjust`. Balance reset stays unavailable:
 * this surface never calls `/reset`.
 */
import { useState } from 'react';
import { AlertCircle, RefreshCw, X } from 'lucide-react';
import { useI18n } from '../../../providers/I18nProvider';
import { postJson } from '../../../lib/api/mutation-client';
import { formatBytes } from '../../../lib/unitParser';

interface AdjustBalanceModalProps {
  isOpen: boolean;
  onClose: () => void;
  imsi: string;
  dataAvailable: number | null;
  voiceAvailable: number | null;
  smsAvailable: number | null;
  onSuccess: (result: { outcome: string; message: string }) => void;
}

const CAS_CODES = ['BALANCE_PRECONDITION_CHANGED', 'PRECONDITION_FAILED'];
const BACKEND_UNREACHABLE_CODES = ['GO_BACKEND_UNREACHABLE'];

export default function AdjustBalanceModal({
  isOpen,
  onClose,
  imsi,
  dataAvailable,
  voiceAvailable,
  smsAvailable,
  onSuccess,
}: AdjustBalanceModalProps) {
  const { t } = useI18n();

  const [bucket, setBucket] = useState<'data' | 'voice' | 'sms'>('data');
  const [operation, setOperation] = useState<'credit' | 'debit'>('credit');
  const [amountInput, setAmountInput] = useState<string>('1');
  const [dataUnit, setDataUnit] = useState<'GB' | 'MB' | 'Bytes'>('GB');
  const [voiceUnit, setVoiceUnit] = useState<'Minutes' | 'Seconds'>('Minutes');
  const [reason, setReason] = useState<string>('');
  const [ticketId, setTicketId] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [casConflict, setCasConflict] = useState<boolean>(false);

  if (!isOpen) return null;

  const currentAvailable =
    bucket === 'data' ? dataAvailable : bucket === 'voice' ? voiceAvailable : smsAvailable;

  const calculateAmount = (): number => {
    const raw = parseFloat(amountInput);
    if (Number.isNaN(raw) || raw <= 0) return 0;
    if (bucket === 'data') {
      if (dataUnit === 'GB') return Math.round(raw * 1024 * 1024 * 1024);
      if (dataUnit === 'MB') return Math.round(raw * 1024 * 1024);
      return Math.round(raw);
    }
    if (bucket === 'voice') {
      if (voiceUnit === 'Minutes') return Math.round(raw * 60);
      return Math.round(raw);
    }
    return Math.round(raw);
  };

  const calculatedAmount = calculateAmount();

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setCasConflict(false);

    if (calculatedAmount <= 0) {
      setError(t('ocs_balance_amount_invalid'));
      return;
    }

    if (operation === 'debit' && currentAvailable !== null && calculatedAmount > currentAvailable) {
      setError(t('ocs_balance_insufficient'));
      return;
    }

    if (!reason.trim()) {
      setError(t('ocs_balance_reason_required'));
      return;
    }

    setSubmitting(true);
    try {
      const result = await postJson<{ outcome?: string }>(
        `/api/ocs/balances/${encodeURIComponent(imsi)}/adjust`,
        {
          operation,
          bucket,
          amount: calculatedAmount,
          reason: reason.trim(),
          ticketId: ticketId.trim() || undefined,
        },
      );

      onSuccess({
        outcome: result?.outcome || 'success',
        message: t('ocs_balance_success_executed'),
      });
      onClose();
    } catch (failure) {
      const code = (failure as { code?: string }).code;
      if (code && CAS_CODES.includes(code)) {
        setCasConflict(true);
        setError(t('ocs_balance_precondition_changed'));
      } else if (code && BACKEND_UNREACHABLE_CODES.includes(code)) {
        setError(t('ocs_balance_backend_unreachable'));
      } else {
        setError(failure instanceof Error ? failure.message : t('network_error'));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="ocs-dialog-overlay" onClick={onClose}>
      <div
        className="ocs-dialog ocs-modal-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="balance-modal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="ocs-dialog-header ocs-dialog-header-between">
          <h3 id="balance-modal-title">{t('ocs_balance_modal_title')}</h3>
          <button
            type="button"
            className="ocs-btn-icon"
            onClick={onClose}
            aria-label={t('close')}
          >
            <X size={18} />
          </button>
        </div>

        <div className="ocs-balance-modal-imsi">
          <span className="ocs-balance-modal-imsi-line">
            IMSI: <strong className="ocs-mono">{imsi}</strong>
          </span>
          <div className="ocs-balance-modal-imsi-note">
            {t('ocs_col_data_available')}: {formatBytes(dataAvailable ?? 0)} |{' '}
            {t('ocs_col_voice_avail')}: {voiceAvailable ?? 0}s |{' '}
            {t('ocs_col_sms_avail')}: {smsAvailable ?? 0}
          </div>
        </div>

        {error && (
          <div className="ocs-feedback-error ocs-feedback-spaced ocs-feedback-row">
            <AlertCircle size={16} />
            <span>{error}</span>
            {casConflict && (
              <button
                type="button"
                className="ocs-btn ocs-btn-secondary ocs-btn-compact-auto"
                onClick={() => {
                  onClose();
                  window.location.reload();
                }}
              >
                <RefreshCw size={12} /> {t('refresh')}
              </button>
            )}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div className="ocs-form-group">
            <label className="ocs-form-label" htmlFor="adjust-bucket">{t('ocs_balance_bucket')}</label>
            <select
              id="adjust-bucket"
              className="ocs-select ocs-select-full"
              value={bucket}
              onChange={(event) => setBucket(event.target.value as 'data' | 'voice' | 'sms')}
            >
              <option value="data">{t('ocs_balance_bucket_data')}</option>
              <option value="voice">{t('ocs_balance_bucket_voice')}</option>
              <option value="sms">{t('ocs_balance_bucket_sms')}</option>
            </select>
          </div>

          <div className="ocs-form-group">
            <label className="ocs-form-label" htmlFor="adjust-operation">{t('ocs_balance_operation')}</label>
            <select
              id="adjust-operation"
              className="ocs-select ocs-select-full"
              value={operation}
              onChange={(event) => setOperation(event.target.value as 'credit' | 'debit')}
            >
              <option value="credit">{t('ocs_balance_op_credit')}</option>
              <option value="debit">{t('ocs_balance_op_debit')}</option>
            </select>
          </div>

          <div className="ocs-form-group">
            <label className="ocs-form-label" htmlFor="adjust-amount">{t('ocs_balance_amount')}</label>
            <div className="ocs-amount-row">
              <input
                id="adjust-amount"
                type="number"
                step="any"
                min="0"
                className="ocs-form-input"
                value={amountInput}
                onChange={(event) => setAmountInput(event.target.value)}
                placeholder="1"
                required
              />
              {bucket === 'data' && (
                <select
                  className="ocs-select ocs-select-unit"
                  value={dataUnit}
                  aria-label={t('ocs_balance_amount')}
                  onChange={(event) => setDataUnit(event.target.value as 'GB' | 'MB' | 'Bytes')}
                >
                  <option value="GB">GB</option>
                  <option value="MB">MB</option>
                  <option value="Bytes">Bytes</option>
                </select>
              )}
              {bucket === 'voice' && (
                <select
                  className="ocs-select ocs-select-unit"
                  value={voiceUnit}
                  aria-label={t('ocs_balance_amount')}
                  onChange={(event) => setVoiceUnit(event.target.value as 'Minutes' | 'Seconds')}
                >
                  <option value="Minutes">{t('minutes')}</option>
                  <option value="Seconds">{t('seconds')}</option>
                </select>
              )}
              {bucket === 'sms' && (
                <span className="ocs-unit-suffix">
                  {t('sms_unit')}
                </span>
              )}
            </div>
            {calculatedAmount > 0 && bucket === 'data' && dataUnit !== 'Bytes' && (
              <span className="ocs-amount-hint">
                = {calculatedAmount.toLocaleString()} Bytes ({formatBytes(calculatedAmount)})
              </span>
            )}
          </div>

          <div className="ocs-form-group">
            <label className="ocs-form-label" htmlFor="adjust-reason">{t('ocs_balance_reason')}</label>
            <textarea
              id="adjust-reason"
              className="ocs-form-textarea"
              maxLength={200}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="e.g. Customer quota compensation"
              required
            />
          </div>

          <div className="ocs-form-group">
            <label className="ocs-form-label" htmlFor="adjust-ticket">{t('ocs_balance_ticket_id')}</label>
            <input
              id="adjust-ticket"
              type="text"
              maxLength={100}
              className="ocs-form-input"
              value={ticketId}
              onChange={(event) => setTicketId(event.target.value)}
              placeholder="e.g. INC100234"
            />
          </div>

          <div className="ocs-dialog-actions ocs-dialog-actions-spaced">
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
              {submitting ? t('submitting') : t('ocs_balance_adjust')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
