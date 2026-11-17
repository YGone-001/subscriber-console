/*
 * Governed balance adjustment (`POST /api/ocs/balances/{imsi}/adjust`).
 *
 * Implements a strict two-step confirmation workflow with resilient retry safety:
 *   1. Editing state: validates amount, bucket, operation, CAS version, and reason.
 *   2. Reviewing state: renders an exact projected before/delta/after preview
 *      from the authoritative balance snapshot before any mutation request is issued.
 *   3. Submitting state: executes a single CAS-governed mutation with double-submit protection
 *      guaranteed by an immediate synchronous ref latch.
 *   4. Conflict state: on CAS precondition change, reviewed intent is permanently invalidated,
 *      execution button is eliminated, and authoritative refresh is required.
 *   5. OutcomeUnknown state: on network or transport failure, execution outcome is uncertain;
 *      resubmission is blocked to prevent duplicate credit/debit, requiring explicit refresh.
 */
import { useState, useRef } from 'react';
import { AlertCircle, ArrowLeft, Check, CheckCircle2, RefreshCw, X } from 'lucide-react';
import { useI18n } from '../../../providers/I18nProvider';
import { postJson, MutationApiError } from '../../../lib/api/mutation-client';
import { formatBytes } from '../../../lib/unitParser';
import { formatOcsBytes } from '../../../features/ocs/ocs-format';
import type { OcsBalanceViewModel } from '../../../features/ocs/ocs-view-models';
import {
  parseCanonicalAdjustmentAmount,
  projectBalanceAdjustment,
  type BalanceAdjustmentProjection,
  type BalanceBucketType,
  type BalanceOperationType,
  type DataUnitType,
  type VoiceUnitType,
} from '../../../features/ocs/ocs-balance-math';
import { Dialog } from '../../ui/Dialog';

export type AdjustModalStep =
  | 'editing'
  | 'reviewing'
  | 'submitting'
  | 'conflict'
  | 'outcomeUnknown'
  | 'completed';

export interface AdjustBalanceModalProps {
  isOpen: boolean;
  onClose: () => void;
  imsi: string;
  dataAvailable?: number | null;
  voiceAvailable?: number | null;
  smsAvailable?: number | null;
  /** CAS precondition from the record the dialog was opened for. */
  version?: number | null;
  /** Authoritative balance view model if available. */
  balance?: OcsBalanceViewModel | null;
  /** Refetch the owning surface after a stale precondition or uncertain outcome. */
  onRefresh?: () => void;
  onSuccess: (result: { outcome: string; message: string }) => void;
}

const CAS_CODES = ['BALANCE_PRECONDITION_CHANGED', 'PRECONDITION_FAILED'];
const BACKEND_UNREACHABLE_CODES = ['GO_BACKEND_UNREACHABLE'];

function formatBucketDisplay(bucket: BalanceBucketType, value: number | null): string {
  if (value === null) return '\u2014';
  if (bucket === 'data') {
    return `${formatOcsBytes(value)} (${value.toLocaleString()} B)`;
  }
  if (bucket === 'voice') {
    if (value >= 60) {
      const mins = Math.floor(value / 60);
      const secs = value % 60;
      return `${value.toLocaleString()}s (${mins}m ${secs}s)`;
    }
    return `${value.toLocaleString()}s`;
  }
  return value.toLocaleString();
}

export default function AdjustBalanceModal({
  isOpen,
  onClose,
  imsi,
  balance,
  onRefresh,
  onSuccess,
}: AdjustBalanceModalProps) {
  const { t } = useI18n();

  const [step, setStep] = useState<AdjustModalStep>('editing');
  const [bucket, setBucket] = useState<BalanceBucketType>('data');
  const [operation, setOperation] = useState<BalanceOperationType>('credit');
  const [amountInput, setAmountInput] = useState<string>('1');
  const [dataUnit, setDataUnit] = useState<DataUnitType>('GB');
  const [voiceUnit, setVoiceUnit] = useState<VoiceUnitType>('Minutes');
  const [reason, setReason] = useState<string>('');
  const [ticketId, setTicketId] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [projection, setProjection] = useState<BalanceAdjustmentProjection | null>(null);
  const [reviewedVersion, setReviewedVersion] = useState<number | null>(null);

  // Synchronous submission latch to protect against rapid double-clicks or keypresses
  const isSubmittingRef = useRef<boolean>(false);

  if (!isOpen) return null;

  // Task D: Remove Fabricated Balance Fallback.
  // If authoritative balance snapshot is missing, render safe unavailable alert;
  // never synthesize artificial metrics or assume invariant compliance.
  if (!balance) {
    return (
      <Dialog
        open={isOpen}
        onClose={onClose}
        className="ocs-dialog ocs-modal-dialog"
        overlayClassName="ocs-dialog-overlay"
        labelledBy="balance-modal-title"
        role="dialog"
        closeOnOverlay={true}
      >
        <div className="ocs-dialog-header ocs-dialog-header-between">
          <div>
            <h3 id="balance-modal-title">{t('ocs_balance_modal_title')}</h3>
          </div>
          <button
            type="button"
            className="ocs-btn-icon"
            onClick={onClose}
            aria-label={t('close')}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="ocs-balance-modal-imsi">
          <span className="ocs-balance-modal-imsi-line">
            IMSI: <strong className="ocs-mono">{imsi}</strong>
          </span>
        </div>

        <div className="ocs-feedback-error ocs-feedback-spaced ocs-feedback-row" role="alert">
          <AlertCircle size={16} aria-hidden="true" />
          <span>{t('ocs_balance_unavailable')}</span>
        </div>

        <div className="ocs-dialog-actions ocs-dialog-actions-spaced">
          <button
            type="button"
            className="ocs-btn ocs-btn-secondary"
            onClick={onClose}
          >
            {t('close')}
          </button>
          {onRefresh && (
            <button
              type="button"
              className="ocs-btn ocs-btn-primary"
              onClick={() => {
                onClose();
                onRefresh();
              }}
            >
              <RefreshCw size={14} aria-hidden="true" /> {t('refresh')}
            </button>
          )}
        </div>
      </Dialog>
    );
  }

  const selectedUnit = bucket === 'data' ? dataUnit : bucket === 'voice' ? voiceUnit : 'SMS';

  // Real-time calculation hint for editing form
  const parseAttempt = parseCanonicalAdjustmentAmount(amountInput, bucket, selectedUnit);
  const liveCanonicalAmount = parseAttempt.ok ? parseAttempt.canonicalAmount : 0;

  // Stale snapshot detection
  const isSnapshotStale =
    (step === 'reviewing' || step === 'submitting') &&
    reviewedVersion !== null &&
    typeof balance.version === 'number' &&
    balance.version !== reviewedVersion;

  const isSubmitting = step === 'submitting';

  const handleProceedToReview = (event: React.FormEvent) => {
    event.preventDefault();
    if (isSubmitting) return;
    setError(null);

    if (!parseAttempt.ok) {
      setError(t(parseAttempt.errorKey));
      return;
    }

    if (!reason.trim()) {
      setError(t('ocs_balance_reason_required'));
      return;
    }

    const projResult = projectBalanceAdjustment({
      balance,
      bucket,
      operation,
      canonicalAmount: parseAttempt.canonicalAmount,
    });

    if (!projResult.ok) {
      setError(t(projResult.errorKey));
      return;
    }

    setProjection(projResult.projection);
    setReviewedVersion(projResult.projection.version);
    setStep('reviewing');
  };

  const handleConfirmAdjustment = async () => {
    // Synchronously check and lock latch
    if (!projection || isSubmittingRef.current || isSubmitting) return;
    setError(null);

    if (isSnapshotStale) {
      setError(t('ocs_balance_snapshot_stale'));
      return;
    }

    isSubmittingRef.current = true;
    setStep('submitting');
    try {
      const result = await postJson<{ ok?: boolean; outcome?: string; message?: string }>(
        `/api/ocs/balances/${encodeURIComponent(projection.imsi)}/adjust`,
        {
          operation: projection.operation,
          bucket: projection.bucket,
          amount: projection.canonicalAmount,
          reason: reason.trim(),
          ticketId: ticketId.trim() || undefined,
          version: projection.version,
        },
      );

      // Task F: Validate Mutation Response Outcome
      const isOk = result?.ok === true;
      const outcome = result?.outcome;
      const isValidOutcome = outcome === 'success' || outcome === 'executed_audit_warning';

      if (!isOk || !isValidOutcome) {
        setProjection(null);
        setReviewedVersion(null);
        setStep('outcomeUnknown');
        setError(t('ocs_balance_response_ambiguous'));
        return;
      }

      setStep('completed');
      onSuccess({
        outcome,
        message: result?.message || t('ocs_balance_success_executed'),
      });
      onClose();
    } catch (failure) {
      // Invalidate reviewed projection on failure to prevent stale resubmission
      setProjection(null);
      setReviewedVersion(null);

      if (failure instanceof MutationApiError) {
        if (failure.code && CAS_CODES.includes(failure.code)) {
          // Task B: Fail closed on CAS precondition conflict
          setStep('conflict');
          setError(t('ocs_balance_precondition_changed'));
        } else if (
          (failure.code && BACKEND_UNREACHABLE_CODES.includes(failure.code)) ||
          failure.status === 0
        ) {
          // Task C: Handle uncertain / transport failure safely
          setStep('outcomeUnknown');
          setError(t('ocs_balance_network_uncertain'));
        } else {
          setStep('editing');
          setError(failure.message || t('network_error'));
        }
      } else {
        setStep('outcomeUnknown');
        const message = failure instanceof Error ? failure.message : t('network_error');
        setError(message);
      }
    } finally {
      isSubmittingRef.current = false;
    }
  };

  const handleBackToEdit = () => {
    if (isSubmitting) return;
    setStep('editing');
    setError(null);
  };

  const dialogTitle =
    step === 'editing'
      ? t('ocs_balance_modal_title')
      : step === 'conflict'
      ? t('ocs_balance_precondition_changed')
      : step === 'outcomeUnknown'
      ? t('ocs_balance_outcome_unknown_title')
      : t('ocs_balance_review_title');

  return (
    <Dialog
      open={isOpen}
      onClose={isSubmitting ? () => {} : onClose}
      className="ocs-dialog ocs-modal-dialog"
      overlayClassName="ocs-dialog-overlay"
      labelledBy="balance-modal-title"
      role="dialog"
      closeOnOverlay={!isSubmitting}
    >
      <div className="ocs-dialog-header ocs-dialog-header-between">
        <div>
          <h3 id="balance-modal-title">{dialogTitle}</h3>
          {(step === 'reviewing' || step === 'submitting') && (
            <div className="ocs-dialog-subtitle">{t('ocs_balance_review_subtitle')}</div>
          )}
        </div>
        <button
          type="button"
          className="ocs-btn-icon"
          onClick={onClose}
          disabled={isSubmitting}
          aria-label={t('close')}
        >
          <X size={18} aria-hidden="true" />
        </button>
      </div>

      <div className="ocs-balance-modal-imsi">
        <span className="ocs-balance-modal-imsi-line">
          IMSI: <strong className="ocs-mono">{imsi}</strong>
        </span>
        <div className="ocs-balance-modal-imsi-note">
          {t('ocs_col_data_available')}: {formatOcsBytes(balance.data.available)} |{' '}
          {t('ocs_col_voice_avail')}:{' '}
          {balance.voice.available === null ? '\u2014' : `${balance.voice.available}s`} |{' '}
          {t('ocs_col_sms_avail')}:{' '}
          {balance.sms.available === null ? '\u2014' : balance.sms.available}
        </div>
      </div>

      {step === 'editing' && typeof balance.version !== 'number' && (
        <div className="warning-text" role="alert">
          {t('ocs_balance_version_missing')}
        </div>
      )}

      {isSnapshotStale && (
        <div className="ocs-feedback-error ocs-feedback-spaced ocs-feedback-row" role="alert">
          <AlertCircle size={16} aria-hidden="true" />
          <span>{t('ocs_balance_snapshot_stale')}</span>
          {onRefresh && (
            <button
              type="button"
              className="ocs-btn ocs-btn-secondary ocs-btn-compact-auto"
              onClick={() => {
                onRefresh();
                setStep('editing');
              }}
            >
              <RefreshCw size={12} aria-hidden="true" /> {t('refresh')}
            </button>
          )}
        </div>
      )}

      {error && step !== 'conflict' && step !== 'outcomeUnknown' && (
        <div className="ocs-feedback-error ocs-feedback-spaced ocs-feedback-row" role="alert">
          <AlertCircle size={16} aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {step === 'conflict' && (
        <div className="ocs-review-workflow">
          <div className="ocs-feedback-error ocs-feedback-spaced ocs-feedback-row" role="alert">
            <AlertCircle size={16} aria-hidden="true" />
            <span>{error || t('ocs_balance_precondition_changed')}</span>
          </div>

          <div className="ocs-dialog-actions ocs-dialog-actions-spaced">
            <button
              type="button"
              className="ocs-btn ocs-btn-secondary"
              onClick={onClose}
            >
              {t('close')}
            </button>
            {onRefresh && (
              <button
                type="button"
                className="ocs-btn ocs-btn-primary"
                onClick={() => {
                  onRefresh();
                  setStep('editing');
                  setError(null);
                }}
              >
                <RefreshCw size={14} aria-hidden="true" /> {t('ocs_balance_btn_refresh_rereview')}
              </button>
            )}
          </div>
        </div>
      )}

      {step === 'outcomeUnknown' && (
        <div className="ocs-review-workflow">
          <div className="ocs-feedback-error ocs-feedback-spaced ocs-feedback-row" role="alert">
            <AlertCircle size={16} aria-hidden="true" />
            <span>{error || t('ocs_balance_network_uncertain')}</span>
          </div>

          <div className="ocs-review-notice" style={{ marginTop: '0.75rem', marginBottom: '1rem' }}>
            <AlertCircle size={16} aria-hidden="true" />
            <span>{t('ocs_balance_outcome_unknown_desc')}</span>
          </div>

          <div className="ocs-dialog-actions ocs-dialog-actions-spaced">
            <button
              type="button"
              className="ocs-btn ocs-btn-secondary"
              onClick={onClose}
            >
              {t('close')}
            </button>
            {onRefresh && (
              <button
                type="button"
                className="ocs-btn ocs-btn-primary"
                onClick={() => {
                  onRefresh();
                  onClose();
                }}
              >
                <RefreshCw size={14} aria-hidden="true" /> {t('ocs_balance_btn_refresh_history')}
              </button>
            )}
          </div>
        </div>
      )}

      {step === 'editing' && (
        <form onSubmit={handleProceedToReview}>
          <div className="ocs-form-group">
            <label className="ocs-form-label" htmlFor="adjust-bucket">
              {t('ocs_balance_bucket')}
            </label>
            <select
              id="adjust-bucket"
              className="ocs-select ocs-select-full"
              value={bucket}
              onChange={(event) => setBucket(event.target.value as BalanceBucketType)}
            >
              <option value="data">{t('ocs_balance_bucket_data')}</option>
              <option value="voice">{t('ocs_balance_bucket_voice')}</option>
              <option value="sms">{t('ocs_balance_bucket_sms')}</option>
            </select>
          </div>

          <div className="ocs-form-group">
            <label className="ocs-form-label" htmlFor="adjust-operation">
              {t('ocs_balance_operation')}
            </label>
            <select
              id="adjust-operation"
              className="ocs-select ocs-select-full"
              value={operation}
              onChange={(event) => setOperation(event.target.value as BalanceOperationType)}
            >
              <option value="credit">{t('ocs_balance_op_credit')}</option>
              <option value="debit">{t('ocs_balance_op_debit')}</option>
            </select>
          </div>

          <div className="ocs-form-group">
            <label className="ocs-form-label" htmlFor="adjust-amount">
              {t('ocs_balance_amount')}
            </label>
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
                  onChange={(event) => setDataUnit(event.target.value as DataUnitType)}
                >
                  <option value="GB">GB</option>
                  <option value="MB">MB</option>
                  <option value="Bytes">{t('ocs_unit_bytes')}</option>
                </select>
              )}
              {bucket === 'voice' && (
                <select
                  className="ocs-select ocs-select-unit"
                  value={voiceUnit}
                  aria-label={t('ocs_balance_amount')}
                  onChange={(event) => setVoiceUnit(event.target.value as VoiceUnitType)}
                >
                  <option value="Minutes">{t('minutes')}</option>
                  <option value="Seconds">{t('seconds')}</option>
                </select>
              )}
              {bucket === 'sms' && (
                <span className="ocs-unit-suffix">{t('sms_unit')}</span>
              )}
            </div>
            {liveCanonicalAmount > 0 && bucket === 'data' && dataUnit !== 'Bytes' && (
              <span className="ocs-amount-hint">
                = {liveCanonicalAmount.toLocaleString()} {t('ocs_unit_bytes')} ({formatBytes(liveCanonicalAmount)})
              </span>
            )}
            {liveCanonicalAmount > 0 && bucket === 'voice' && voiceUnit === 'Minutes' && (
              <span className="ocs-amount-hint">
                = {liveCanonicalAmount.toLocaleString()} {t('seconds')}
              </span>
            )}
          </div>

          <div className="ocs-form-group">
            <label className="ocs-form-label" htmlFor="adjust-reason">
              {t('ocs_balance_reason')}
            </label>
            <textarea
              id="adjust-reason"
              className="ocs-form-textarea"
              maxLength={200}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder={t('ocs_balance_reason_ph')}
              required
            />
          </div>

          <div className="ocs-form-group">
            <label className="ocs-form-label" htmlFor="adjust-ticket">
              {t('ocs_balance_ticket_id')}
            </label>
            <input
              id="adjust-ticket"
              type="text"
              maxLength={100}
              className="ocs-form-input"
              value={ticketId}
              onChange={(event) => setTicketId(event.target.value)}
              placeholder={t('ocs_balance_ticket_ph')}
            />
          </div>

          <div className="ocs-dialog-actions ocs-dialog-actions-spaced">
            <button
              type="button"
              className="ocs-btn ocs-btn-secondary"
              onClick={onClose}
              disabled={isSubmitting}
            >
              {t('cancel')}
            </button>
            <button
              type="submit"
              className="ocs-btn ocs-btn-primary"
              disabled={isSubmitting || typeof balance.version !== 'number'}
            >
              {t('ocs_balance_btn_review')}
            </button>
          </div>
        </form>
      )}

      {(step === 'reviewing' || step === 'submitting') && (
        <div className="ocs-review-workflow">
          <div className="ocs-review-notice">
            <CheckCircle2 size={16} aria-hidden="true" />
            <span>{t('ocs_balance_review_preview_notice')}</span>
          </div>

          <div className="ocs-review-summary-grid">
            <div className="ocs-review-item">
              <span className="ocs-review-item-label">{t('ocs_balance_operation')}</span>
              <span className="ocs-review-item-value">
                <span
                  className={`ocs-badge ${
                    operation === 'debit' ? 'ocs-op-badge-debit' : 'ocs-op-badge-credit'
                  }`}
                >
                  {operation === 'credit' ? t('ocs_balance_op_credit') : t('ocs_balance_op_debit')}
                </span>
              </span>
            </div>

            <div className="ocs-review-item">
              <span className="ocs-review-item-label">{t('ocs_balance_bucket')}</span>
              <span className="ocs-review-item-value">
                {bucket === 'data'
                  ? t('ocs_balance_bucket_data')
                  : bucket === 'voice'
                  ? t('ocs_balance_bucket_voice')
                  : t('ocs_balance_bucket_sms')}
              </span>
            </div>

            <div className="ocs-review-item">
              <span className="ocs-review-item-label">{t('ocs_balance_amount')}</span>
              <span className="ocs-review-item-value ocs-mono">
                {amountInput} {selectedUnit}
              </span>
            </div>

            <div className="ocs-review-item">
              <span className="ocs-review-item-label">{t('ocs_balance_canonical_amount')}</span>
              <span className="ocs-review-item-value ocs-mono">
                {projection?.canonicalAmount.toLocaleString()} {projection ? (parseAttempt.ok ? parseAttempt.canonicalUnit : '') : ''}
              </span>
            </div>

            <div className="ocs-review-item">
              <span className="ocs-review-item-label">{t('ocs_balance_signed_delta')}</span>
              <span
                className={`ocs-review-item-value ocs-mono ${
                  operation === 'debit' ? 'ocs-delta-debit' : 'ocs-delta-credit'
                }`}
              >
                {projection && projection.signedDelta > 0
                  ? `+${projection.signedDelta.toLocaleString()}`
                  : projection?.signedDelta.toLocaleString()}{' '}
                {projection ? (parseAttempt.ok ? parseAttempt.canonicalUnit : '') : ''}
              </span>
            </div>

            <div className="ocs-review-item">
              <span className="ocs-review-item-label">{t('ocs_balance_version')}</span>
              <span className="ocs-review-item-value ocs-mono">
                v{projection?.version}
              </span>
            </div>
          </div>

          <div className="ocs-table-wrap">
            <table className="ocs-review-table">
              <thead>
                <tr>
                  <th>{t('metric')}</th>
                  <th>{t('ocs_balance_current_total')}</th>
                  <th>{t('ocs_balance_signed_delta')}</th>
                  <th>{t('ocs_balance_expected_total')}</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    <strong>{t('total')}</strong>
                  </td>
                  <td className="ocs-mono">
                    {projection ? formatBucketDisplay(bucket, projection.beforeTotal) : '\u2014'}
                  </td>
                  <td
                    className={`ocs-mono ${
                      operation === 'debit' ? 'ocs-delta-debit' : 'ocs-delta-credit'
                    }`}
                  >
                    {projection && projection.signedDelta > 0
                      ? `+${projection.signedDelta.toLocaleString()}`
                      : projection?.signedDelta.toLocaleString()}
                  </td>
                  <td className="ocs-mono ocs-expected-highlight">
                    {projection ? formatBucketDisplay(bucket, projection.expectedTotal) : '\u2014'}
                  </td>
                </tr>
                <tr>
                  <td>
                    <strong>{t('available')}</strong>
                  </td>
                  <td className="ocs-mono">
                    {projection ? formatBucketDisplay(bucket, projection.beforeAvailable) : '\u2014'}
                  </td>
                  <td
                    className={`ocs-mono ${
                      operation === 'debit' ? 'ocs-delta-debit' : 'ocs-delta-credit'
                    }`}
                  >
                    {projection && projection.signedDelta > 0
                      ? `+${projection.signedDelta.toLocaleString()}`
                      : projection?.signedDelta.toLocaleString()}
                  </td>
                  <td className="ocs-mono ocs-expected-highlight">
                    {projection ? formatBucketDisplay(bucket, projection.expectedAvailable) : '\u2014'}
                  </td>
                </tr>
                <tr>
                  <td>{t('ocs_balance_unchanged_used')}</td>
                  <td className="ocs-mono" colSpan={3}>
                    {projection ? formatBucketDisplay(bucket, projection.unchangedUsed) : '\u2014'}
                  </td>
                </tr>
                {bucket !== 'sms' && (
                  <tr>
                    <td>{t('ocs_balance_unchanged_reserved')}</td>
                    <td className="ocs-mono" colSpan={3}>
                      {projection ? formatBucketDisplay(bucket, projection.unchangedReserved) : '\u2014'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="ocs-review-summary-grid">
            <div className="ocs-review-item">
              <span className="ocs-review-item-label">{t('ocs_balance_reason')}</span>
              <span className="ocs-review-item-value">{reason}</span>
            </div>
            {ticketId.trim() && (
              <div className="ocs-review-item">
                <span className="ocs-review-item-label">{t('ocs_balance_ticket_id')}</span>
                <span className="ocs-review-item-value ocs-mono">{ticketId.trim()}</span>
              </div>
            )}
          </div>

          <div className="ocs-dialog-actions ocs-dialog-actions-spaced">
            <button
              type="button"
              className="ocs-btn ocs-btn-secondary"
              onClick={handleBackToEdit}
              disabled={isSubmitting}
            >
              <ArrowLeft size={14} aria-hidden="true" /> {t('ocs_balance_btn_back')}
            </button>
            <button
              type="button"
              className="ocs-btn ocs-btn-secondary"
              onClick={onClose}
              disabled={isSubmitting}
            >
              {t('cancel')}
            </button>
            <button
              type="button"
              className={`ocs-btn ${operation === 'debit' ? 'ocs-btn-danger' : 'ocs-btn-primary'}`}
              onClick={handleConfirmAdjustment}
              disabled={isSubmitting || isSnapshotStale || !projection}
            >
              {isSubmitting ? (
                <>
                  <RefreshCw size={14} className="ocs-spin" aria-hidden="true" /> {t('submitting')}
                </>
              ) : (
                <>
                  <Check size={14} aria-hidden="true" /> {t('ocs_balance_btn_confirm')}
                </>
              )}
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
