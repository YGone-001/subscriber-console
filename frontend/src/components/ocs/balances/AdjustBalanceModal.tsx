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
 *      Refresh fetches fresh record directly from authoritative read endpoint without cache,
 *      validates all fields and invariants, verifies IMSI, and checks that the version has indeed changed.
 *   5. OutcomeUnknown state: on network or transport failure, execution outcome is uncertain;
 *      resubmission is blocked to prevent duplicate credit/debit.
 *      Provides truthful reconciliation: refreshing balance + history on detail surface,
 *      or explicit navigation to detail and truthful list refresh on list surface.
 */
import { useState, useRef, useEffect } from 'react';
import { AlertCircle, ArrowLeft, Check, CheckCircle2, RefreshCw, X } from 'lucide-react';
import { useI18n } from '../../../providers/I18nProvider';
import { getJson } from '../../../lib/api/read-client';
import { postJson, MutationApiError } from '../../../lib/api/mutation-client';
import { formatBytes } from '../../../lib/unitParser';
import { formatOcsBytes } from '../../../features/ocs/ocs-format';
import { toBalanceViewModel, type OcsBalanceViewModel } from '../../../features/ocs/ocs-view-models';
import {
  hasSnapshotConflict,
  isValidCasVersion,
  parseCanonicalAdjustmentAmount,
  projectBalanceAdjustment,
  validateAuthoritativeBalance,
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
  /** Refetch the owning surface (e.g. balance list or balance detail). */
  onRefresh?: () => Promise<void> | void;
  /** Refetch adjustment history on detail page. */
  onRefreshHistory?: () => Promise<void> | void;
  /** Notify caller when a fresh balance record is resolved. */
  onBalanceUpdate?: (fresh: OcsBalanceViewModel) => void;
  /** Whether the owning surface provides adjustment history on-screen (e.g. detail page). */
  hasHistoryOnSurface?: boolean;
  /**
   * Whether the owning surface currently holds a CAS-eligible snapshot. When
   * false the dialog stays read-only: a missing or invalid version can never
   * be promoted into a mutation precondition.
   */
  casEligible?: boolean;
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
  onRefreshHistory,
  onBalanceUpdate,
  hasHistoryOnSurface,
  casEligible = true,
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

  // Authoritative balance snapshot managed in modal
  const [currentBalance, setCurrentBalance] = useState<OcsBalanceViewModel | null>(balance ?? null);
  const [lastConflictedVersion, setLastConflictedVersion] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  // Reconcile state for outcomeUnknown
  const [reconciling, setReconciling] = useState<boolean>(false);
  const [reconcileFeedback, setReconcileFeedback] = useState<{
    type: 'info' | 'warning' | 'error';
    message: string;
  } | null>(null);

  // Synchronous submission latch to protect against rapid double-clicks or keypresses
  const isSubmittingRef = useRef<boolean>(false);

  useEffect(() => {
    if (!balance || balance.imsi !== imsi) return;

    // Validate incoming balance snapshot integrity
    const val = validateAuthoritativeBalance(balance, imsi);
    if (!val.ok) return;

    setCurrentBalance((prev) => {
      if (!prev) return balance;
      if (typeof prev.version !== 'number') return balance;
      if (typeof balance.version !== 'number') return prev;

      // Reject regression: incoming version is strictly less than what modal already holds
      if (balance.version < prev.version) {
        return prev;
      }

      // Conflict detection: same version but conflicting values
      if (balance.version === prev.version) {
        if (hasSnapshotConflict(prev, balance)) {
          // Conflicting values for the same version: fail closed
          setStep('conflict');
          setLastConflictedVersion(prev.version);
          setProjection(null);
          setReviewedVersion(null);
          setError(t('ocs_balance_snapshot_conflict'));
          return prev;
        }
        return balance;
      }

      // Incoming version is newer (balance.version > prev.version)
      return balance;
    });
  }, [balance, imsi, t]);

  if (!isOpen) return null;

  const effectiveBalance = currentBalance ?? balance;

  // Task D: Remove Fabricated Balance Fallback.
  // If authoritative balance snapshot is missing, render safe unavailable alert;
  // never synthesize artificial metrics or assume invariant compliance.
  if (!effectiveBalance) {
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
                void onRefresh();
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
    typeof effectiveBalance.version === 'number' &&
    effectiveBalance.version !== reviewedVersion;

  const isSubmitting = step === 'submitting';

  const handleProceedToReview = (event: React.FormEvent) => {
    event.preventDefault();
    if (isSubmitting || refreshing) return;
    setError(null);
    setRefreshError(null);

    if (!casEligible) {
      setError(t('ocs_balance_version_unavailable'));
      return;
    }

    if (!parseAttempt.ok) {
      setError(t(parseAttempt.errorKey));
      return;
    }

    if (!reason.trim()) {
      setError(t('ocs_balance_reason_required'));
      return;
    }

    const projResult = projectBalanceAdjustment({
      balance: effectiveBalance,
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
    setRefreshError(null);

    if (isSnapshotStale) {
      setError(t('ocs_balance_snapshot_stale'));
      return;
    }

    /*
     * Fail closed: no mutation may be dispatched without a valid CAS version,
     * even if a projection somehow survived a snapshot change.
     */
    if (!casEligible || !isValidCasVersion(projection.version)) {
      setError(t('ocs_balance_version_missing'));
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
      const failedVersion = projection.version;
      setProjection(null);
      setReviewedVersion(null);

      if (failure instanceof MutationApiError) {
        if (failure.code && CAS_CODES.includes(failure.code)) {
          // Task A & B: Fail closed on CAS precondition conflict
          setLastConflictedVersion(failedVersion);
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

  const handleRefreshAfterConflict = async () => {
    setRefreshing(true);
    setRefreshError(null);
    setError(null);
    try {
      // 1. Authoritative direct read with cache: no-store
      const raw = await getJson<unknown>(`/api/ocs/balances/${encodeURIComponent(imsi)}`);
      const fresh = toBalanceViewModel(raw);

      // 2. Validate against schema, IMSI, invariants, and conservation rules
      const val = validateAuthoritativeBalance(fresh, imsi);
      if (!val.ok || !fresh) {
        setRefreshError(t(val.ok ? 'ocs_balance_refresh_failed' : val.errorKey));
        return;
      }

      // 3. Strict Monotonic CAS Version Validation:
      // Reject any snapshot whose version has not strictly progressed beyond the conflicted version
      if (
        lastConflictedVersion !== null &&
        (typeof fresh.version !== 'number' || fresh.version <= lastConflictedVersion)
      ) {
        setRefreshError(
          t('ocs_balance_conflict_unresolved', {
            freshVersion: `v${fresh.version ?? '\u2014'}`,
            conflictedVersion: `v${lastConflictedVersion}`,
          }),
        );
        return;
      }

      // 4. Update local snapshot and inform caller
      setCurrentBalance(fresh);
      onBalanceUpdate?.(fresh);

      // 5. Trigger parent surface refresh if available
      if (onRefresh) {
        try {
          await onRefresh();
        } catch {
          // Parent refresh non-fatal if direct read succeeded
        }
      }

      // 6. Transition to editing
      setStep('editing');
      setLastConflictedVersion(null);
      setRefreshError(null);
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : t('ocs_balance_refresh_failed'));
    } finally {
      setRefreshing(false);
    }
  };

  const handleReconcileDetail = async () => {
    if (reconciling) return;
    setReconciling(true);
    setReconcileFeedback(null);

    const balancePromise = onRefresh ? Promise.resolve(onRefresh()) : Promise.resolve();
    const historyPromise = onRefreshHistory ? Promise.resolve(onRefreshHistory()) : Promise.resolve();

    const [balanceResult, historyResult] = await Promise.allSettled([balancePromise, historyPromise]);

    const balanceFailed = onRefresh ? balanceResult.status === 'rejected' : false;
    const historyFailed = onRefreshHistory ? historyResult.status === 'rejected' : false;

    setReconciling(false);
    if (balanceFailed && historyFailed) {
      setReconcileFeedback({
        type: 'error',
        message: t('ocs_balance_refresh_failed'),
      });
    } else if (balanceFailed) {
      setReconcileFeedback({
        type: 'warning',
        message: t('ocs_balance_partial_balance_failed'),
      });
    } else if (historyFailed) {
      setReconcileFeedback({
        type: 'warning',
        message: t('ocs_balance_partial_history_failed'),
      });
    } else {
      setReconcileFeedback({
        type: 'info',
        message: t('ocs_balance_evidence_refreshed'),
      });
    }
  };

  const handleBackToEdit = () => {
    if (isSubmitting || refreshing) return;
    setStep('editing');
    setError(null);
    setRefreshError(null);
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
      onClose={isSubmitting || refreshing ? () => {} : onClose}
      className="ocs-dialog ocs-modal-dialog"
      overlayClassName="ocs-dialog-overlay"
      labelledBy="balance-modal-title"
      role="dialog"
      closeOnOverlay={!isSubmitting && !refreshing}
      closeOnEscape={!isSubmitting && !refreshing}
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
          disabled={isSubmitting || refreshing}
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
          {t('ocs_col_data_available')}: {formatOcsBytes(effectiveBalance.data.available)} |{' '}
          {t('ocs_col_voice_avail')}:{' '}
          {effectiveBalance.voice.available === null ? '\u2014' : `${effectiveBalance.voice.available}s`} |{' '}
          {t('ocs_col_sms_avail')}:{' '}
          {effectiveBalance.sms.available === null ? '\u2014' : effectiveBalance.sms.available}
        </div>
      </div>

      {step === 'editing' && !casEligible && (
        <div className="warning-text" role="alert">
          {t('ocs_balance_version_unavailable')}
        </div>
      )}

      {step === 'editing' && casEligible && !isValidCasVersion(effectiveBalance.version) && (
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
                void onRefresh();
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
            <span>{refreshError || error || t('ocs_balance_precondition_changed')}</span>
          </div>

          {lastConflictedVersion !== null && (
            <div className="ocs-review-summary-grid">
              <div className="ocs-review-item" style={{ gridColumn: '1 / -1' }}>
                <span className="ocs-review-item-label">{t('ocs_balance_account_status')}</span>
                <span className="ocs-review-item-value">
                  {t('ocs_balance_precondition_changed')} (v{lastConflictedVersion})
                </span>
              </div>
            </div>
          )}

          <div className="ocs-dialog-actions ocs-dialog-actions-spaced">
            <button
              type="button"
              className="ocs-btn ocs-btn-secondary"
              onClick={onClose}
              disabled={refreshing}
            >
              {t('close')}
            </button>
            <button
              type="button"
              className="ocs-btn ocs-btn-primary"
              onClick={handleRefreshAfterConflict}
              disabled={refreshing}
            >
              {refreshing ? (
                <>
                  <RefreshCw size={14} className="ocs-spin" aria-hidden="true" /> {t('ocs_balance_refreshing')}
                </>
              ) : (
                <>
                  <RefreshCw size={14} aria-hidden="true" /> {t('ocs_balance_btn_refresh_rereview')}
                </>
              )}
            </button>
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

          {reconcileFeedback && (
            <div
              className={`ocs-feedback-${reconcileFeedback.type} ocs-feedback-spaced ocs-feedback-row`}
              role="status"
            >
              <AlertCircle size={16} aria-hidden="true" />
              <span>{reconcileFeedback.message}</span>
            </div>
          )}

          <div className="ocs-dialog-actions ocs-dialog-actions-spaced">
            <button
              type="button"
              className="ocs-btn ocs-btn-secondary"
              onClick={onClose}
              disabled={reconciling}
            >
              {t('close')}
            </button>

            {hasHistoryOnSurface ? (
              <button
                type="button"
                className="ocs-btn ocs-btn-primary"
                onClick={handleReconcileDetail}
                disabled={reconciling}
              >
                {reconciling ? (
                  <>
                    <RefreshCw size={14} className="ocs-spin" aria-hidden="true" /> {t('refreshing')}
                  </>
                ) : (
                  <>
                    <RefreshCw size={14} aria-hidden="true" /> {t('ocs_balance_btn_refresh_history')}
                  </>
                )}
              </button>
            ) : (
              <>
                <a
                  href={`/ocs/balances/${encodeURIComponent(imsi)}`}
                  className="ocs-btn ocs-btn-primary"
                  onClick={onClose}
                >
                  {t('ocs_balance_btn_view_history')}
                </a>
                {onRefresh && (
                  <button
                    type="button"
                    className="ocs-btn ocs-btn-secondary"
                    onClick={() => {
                      void onRefresh();
                      onClose();
                    }}
                  >
                    <RefreshCw size={14} aria-hidden="true" /> {t('ocs_balance_btn_refresh_list')}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {step === 'editing' && (
        <form onSubmit={handleProceedToReview} noValidate>
          <div className="ocs-form-group">
            <label className="ocs-form-label" htmlFor="adjust-bucket">
              {t('ocs_balance_bucket')}
            </label>
            <select
              id="adjust-bucket"
              className="ocs-select ocs-select-full"
              value={bucket}
              onChange={(event) => setBucket(event.target.value as BalanceBucketType)}
              disabled={refreshing}
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
              disabled={refreshing}
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
                disabled={refreshing}
                required
              />
              {bucket === 'data' && (
                <select
                  className="ocs-select ocs-select-unit"
                  value={dataUnit}
                  aria-label={t('ocs_balance_amount')}
                  onChange={(event) => setDataUnit(event.target.value as DataUnitType)}
                  disabled={refreshing}
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
                  disabled={refreshing}
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
              disabled={refreshing}
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
              disabled={refreshing}
            />
          </div>

          <div className="ocs-dialog-actions ocs-dialog-actions-spaced">
            <button
              type="button"
              className="ocs-btn ocs-btn-secondary"
              onClick={onClose}
              disabled={isSubmitting || refreshing}
            >
              {t('cancel')}
            </button>
            <button
              type="submit"
              className="ocs-btn ocs-btn-primary"
              disabled={
                isSubmitting || refreshing || !casEligible || !isValidCasVersion(effectiveBalance.version)
              }
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
              disabled={isSubmitting || isSnapshotStale || !projection || !casEligible}
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
