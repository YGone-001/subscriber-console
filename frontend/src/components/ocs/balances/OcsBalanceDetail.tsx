/*
 * Balance detail (`/ocs/balances/:imsi`).
 *
 * The historical page read the *list* endpoint with a substring filter and took
 * the first row, so `/ocs/balances/123` could render a record whose IMSI merely
 * contained `123`, and a network failure was indistinguishable from a missing
 * record. It also passed every missing field through `?? 0`, which turned "not
 * reported" into a measured zero, and it never sent the CAS version the adjust
 * endpoint accepts.
 *
 * The dedicated read `GET /api/ocs/balances/{imsi}` answers with exactly the
 * requested record, which removes the guessing entirely. This page uses it,
 * distinguishes the four failure situations, keeps missing values missing, and
 * hands the record version to the adjustment dialog so a concurrent write is
 * rejected instead of silently overwritten.
 */
import { useState, useEffect, useCallback } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ArrowLeft, Database, History, MessageSquare, Phone, ShieldCheck, SlidersHorizontal, Wallet } from 'lucide-react';
import PageHeader from '../../ui/PageHeader';
import RefreshButton from '../../ui/RefreshButton';
import OcsStatusBadge from '../common/OcsStatusBadge';
import OcsInvariantBadge from '../common/OcsInvariantBadge';
import OcsDetailState from '../common/OcsDetailState';
import AdjustBalanceModal from './AdjustBalanceModal';
import { getJson } from '../../../lib/api/read-client';
import { useRead } from '../../../lib/api/use-read';
import { hasPermission } from '../../../lib/permissions';
import { useAuth } from '../../../providers/AuthProvider';
import { useI18n } from '../../../providers/I18nProvider';
import {
  isSnapshotCasEligible,
  isValidCasVersion,
  resolveAuthoritativeSnapshot,
  type AuthoritativeSnapshotState,
} from '../../../features/ocs/ocs-balance-math';
import {
  toBalanceViewModel,
  toAdjustmentListViewModel,
  type OcsAdjustmentViewModel,
  type OcsBalanceViewModel,
} from '../../../features/ocs/ocs-view-models';
import { formatOcsBytes, formatOcsNumber, formatOcsTime } from '../../../features/ocs/ocs-format';
import { resolveReturnTo } from '../../../lib/return-to';

interface OcsBalanceDetailProps {
  imsi: string;
}

export default function OcsBalanceDetail({ imsi }: OcsBalanceDetailProps) {
  const { t } = useI18n();
  const { user } = useAuth();
  const canAdjust = hasPermission(user, 'ocs.balance.adjust');

  const [prevImsi, setPrevImsi] = useState(imsi);
  const [activeState, setActiveState] = useState<AuthoritativeSnapshotState | null>(null);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Synchronously reset IMSI-scoped state when the route prop changes
  if (prevImsi !== imsi) {
    setPrevImsi(imsi);
    setActiveState(null);
    setFeedback(null);
    setAdjustOpen(false);
  }

  const encoded = encodeURIComponent(imsi);
  const { data, error, isLoading: loading, mutate: refresh } = useRead<unknown>(
    `/api/ocs/balances/${encoded}`,
  );
  /* The trail is a separate read on purpose: a log outage must not hide the
   * balance itself, and the balance must stay readable when the log is empty. */
  const { data: adjustmentsData, error: adjustmentsError, isLoading: adjustmentsLoading, mutate: refreshAdjustments } = useRead<unknown>(
    `/api/ocs/balances/${encoded}/adjustments?limit=20`,
  );

  const rawBalance = toBalanceViewModel(data);
  const isCurrentImsiData = rawBalance?.imsi === imsi;

  /*
   * All version arbitration lives in the shared resolver: a missing or invalid
   * CAS version can never overwrite an established high-watermark, can never
   * clear an unresolved conflict, and never advances the accepted snapshot.
   */
  const applyAuthoritativeSnapshot = useCallback(
    (fresh: OcsBalanceViewModel) => {
      setActiveState((prev) => resolveAuthoritativeSnapshot(prev, fresh, imsi));
    },
    [imsi],
  );

  useEffect(() => {
    if (rawBalance && rawBalance.imsi === imsi) {
      applyAuthoritativeSnapshot(rawBalance);
    }
  }, [rawBalance, imsi, applyAuthoritativeSnapshot]);

  const currentScoped = activeState && activeState.imsi === imsi ? activeState : null;
  const balance = currentScoped?.balance ?? (isCurrentImsiData ? rawBalance : null);
  const hasConflict = currentScoped?.hasConflict ?? false;
  /*
   * A response without a usable CAS version is insufficient evidence: the
   * accepted high-watermark is retained, but the surface fails closed and
   * refuses to start a mutation until a valid authoritative snapshot returns.
   */
  const versionUnavailable = currentScoped
    ? currentScoped.versionUnavailable
    : !isValidCasVersion(balance?.version);
  const casEligible = isSnapshotCasEligible(currentScoped);

  const handleManualRefresh = useCallback(async () => {
    try {
      const freshRaw = await getJson<unknown>(`/api/ocs/balances/${encoded}`);
      const fresh = toBalanceViewModel(freshRaw);
      if (fresh && fresh.imsi === imsi) {
        applyAuthoritativeSnapshot(fresh);
      }
    } catch {
      // SWR refresh below will capture network errors or update SWR state
    }
    void refresh();
  }, [encoded, imsi, refresh, applyAuthoritativeSnapshot]);

  const adjustments = toAdjustmentListViewModel(adjustmentsData).records;
  const location = useLocation();
  const returnTo = resolveReturnTo(location.search, '/ocs/balances', ['/ocs/balances']);
  const backTo = { to: returnTo, label: t('ocs_back_to_list') };

  const bucketLabel = (bucket: string | null): string => {
    if (bucket === 'data') return t('ocs_bucket_data');
    if (bucket === 'voice') return t('ocs_bucket_voice');
    if (bucket === 'sms') return t('ocs_bucket_sms');
    return '\u2014';
  };

  const adjustmentSummary = (adjustment: OcsAdjustmentViewModel): string => {
    const operation = adjustment.operation === 'credit'
      ? t('ocs_adjust_credit')
      : adjustment.operation === 'debit'
        ? t('ocs_adjust_debit')
        : '\u2014';
    const bucket = bucketLabel(adjustment.bucket);
    const amount = adjustment.amount === null
      ? '\u2014'
      : adjustment.bucket === 'data'
        ? formatOcsBytes(adjustment.amount)
        : adjustment.bucket === 'voice'
          ? `${adjustment.amount}s`
          : String(adjustment.amount);
    return `${operation} ${bucket} ${amount}`;
  };

  const resultLabel = (result: string | null): string => {
    if (result === 'success') return t('ocs_adjust_result_success');
    if (result === 'failure' || result === 'failed') return t('ocs_adjust_result_failure');
    return result || '\u2014';
  };

  const isWaitingForCurrentImsi = !isCurrentImsiData;

  if (loading && !balance) {
    return (
      <div className="ocs-container">
        <OcsDetailState kind="loading" />
      </div>
    );
  }

  if (isWaitingForCurrentImsi && !balance) {
    if (error) {
      const status = (error as { status?: number }).status ?? 0;
      if (status === 403) {
        return <div className="ocs-container"><OcsDetailState kind="forbidden" backTo={backTo} /></div>;
      }
      if (status === 404) {
        return <div className="ocs-container"><OcsDetailState kind="notFound" backTo={backTo} /></div>;
      }
      return (
        <div className="ocs-container">
          <OcsDetailState kind="error" detail={error.message} onRetry={() => void refresh()} backTo={backTo} />
        </div>
      );
    }
    return (
      <div className="ocs-container">
        <OcsDetailState kind="loading" />
      </div>
    );
  }

  if (error && !balance) {
    const status = (error as { status?: number }).status ?? 0;
    if (status === 403) {
      return <div className="ocs-container"><OcsDetailState kind="forbidden" backTo={backTo} /></div>;
    }
    if (status === 404) {
      return <div className="ocs-container"><OcsDetailState kind="notFound" backTo={backTo} /></div>;
    }
    return (
      <div className="ocs-container">
        <OcsDetailState kind="error" detail={error.message} onRetry={() => void refresh()} backTo={backTo} />
      </div>
    );
  }

  if (!balance) {
    return <div className="ocs-container"><OcsDetailState kind="notFound" backTo={backTo} /></div>;
  }

  return (
    <div className="ocs-container">
      <PageHeader
        eyebrow={t('nav_ocs_balances')}
        title={balance.imsi ?? ''}
        description={t('ocs_balance_detail_desc')}
        actions={
          <div className="ocs-header-actions">
            <Link to={backTo.to} className="ocs-btn ocs-btn-secondary">
              <ArrowLeft size={14} aria-hidden="true" /> {t('ocs_back_to_list')}
            </Link>
            <Link to={`/ocs/contracts/${encodeURIComponent(balance.imsi ?? '')}`} className="ocs-btn ocs-btn-secondary">
              {t('ocs_balance_view_contract')}
            </Link>
            <Link to={`/subscribers/${encodeURIComponent(balance.imsi ?? '')}`} className="ocs-btn ocs-btn-secondary">
              {t('ocs_balance_view_subscriber')}
            </Link>
            <RefreshButton loading={loading} onClick={() => void handleManualRefresh()} label={t('refresh')} className="ocs-btn" />
            {canAdjust && balance.status !== 'terminated' && (
              <button
                type="button"
                className="ocs-btn ocs-btn-primary"
                disabled={!casEligible}
                aria-disabled={!casEligible}
                onClick={() => {
                  if (!casEligible) return;
                  setAdjustOpen(true);
                }}
              >
                <SlidersHorizontal size={14} aria-hidden="true" />
                <span>{t('ocs_balance_adjust')}</span>
              </button>
            )}
          </div>
        }
      />

      {hasConflict && (
        <div className="ocs-feedback-error ocs-feedback-spaced" role="alert">
          <span>{t('ocs_balance_snapshot_conflict')}</span>
        </div>
      )}

      {versionUnavailable && (
        <div className="ocs-feedback-warning ocs-feedback-spaced" role="alert">
          <span>
            {isValidCasVersion(balance.version)
              ? t('ocs_balance_version_watermark_retained', { version: `v${balance.version}` })
              : t('ocs_balance_version_unavailable')}
          </span>
        </div>
      )}

      {feedback && (
        <div className={feedback.type === 'success' ? 'ocs-feedback-success ocs-feedback-spaced' : 'ocs-feedback-error ocs-feedback-spaced'} role={feedback.type === 'error' ? 'alert' : 'status'}>
          <span>{feedback.message}</span>
        </div>
      )}

      <div className="ocs-detail-grid">
        <div className="ocs-detail-section">
          <h2><Database size={16} aria-hidden="true" /> {t('ocs_balance_data_bucket')}</h2>
          <div className="ocs-detail-fields">
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_detail_data_total')}</span>
              <span className="ocs-detail-value ocs-mono">{formatOcsBytes(balance.data.total)}</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_detail_data_used')}</span>
              <span className="ocs-detail-value ocs-mono">{formatOcsBytes(balance.data.used)}</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_detail_data_reserved')}</span>
              <span className="ocs-detail-value ocs-mono">{formatOcsBytes(balance.data.reserved)}</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_detail_data_available')}</span>
              <span className="ocs-detail-value ocs-mono ocs-detail-value-strong">{formatOcsBytes(balance.data.available)}</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_detail_data_invariant')}</span>
              <span className="ocs-detail-value"><OcsInvariantBadge value={balance.invariants.data} /></span>
            </div>
          </div>
        </div>

        <div className="ocs-detail-section">
          <h2><Phone size={16} aria-hidden="true" /> {t('ocs_balance_voice_bucket')}</h2>
          <div className="ocs-detail-fields">
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_col_voice_alloc')}</span>
              <span className="ocs-detail-value ocs-mono">{balance.voice.total === null ? '\u2014' : `${balance.voice.total}s`}</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_col_voice_used')}</span>
              <span className="ocs-detail-value ocs-mono">{balance.voice.used === null ? '\u2014' : `${balance.voice.used}s`}</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_col_voice_avail')}</span>
              <span className="ocs-detail-value ocs-mono ocs-detail-value-strong">{balance.voice.available === null ? '\u2014' : `${balance.voice.available}s`}</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_detail_voice_invariant')}</span>
              <span className="ocs-detail-value"><OcsInvariantBadge value={balance.invariants.voice} /></span>
            </div>
          </div>
        </div>

        <div className="ocs-detail-section">
          <h2><MessageSquare size={16} aria-hidden="true" /> {t('ocs_balance_sms_bucket')}</h2>
          <div className="ocs-detail-fields">
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_col_sms_alloc')}</span>
              <span className="ocs-detail-value ocs-mono">{formatOcsNumber(balance.sms.total)}</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_col_sms_used')}</span>
              <span className="ocs-detail-value ocs-mono">{formatOcsNumber(balance.sms.used)}</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_col_sms_avail')}</span>
              <span className="ocs-detail-value ocs-mono ocs-detail-value-strong">{formatOcsNumber(balance.sms.available)}</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_detail_sms_invariant')}</span>
              <span className="ocs-detail-value"><OcsInvariantBadge value={balance.invariants.sms} /></span>
            </div>
          </div>
        </div>

        <div className="ocs-detail-section">
          <h2><ShieldCheck size={16} aria-hidden="true" /> {t('ocs_balance_governance_info')}</h2>
          <div className="ocs-detail-fields">
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_balance_account_status')}</span>
              <span className="ocs-detail-value"><OcsStatusBadge status={balance.status ?? ''} /></span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_balance_version')}</span>
              <span className="ocs-detail-value ocs-mono">{balance.version ?? '\u2014'}</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_balance_invariant')}</span>
              <span className="ocs-detail-value"><OcsInvariantBadge value={balance.invariants.all} /></span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_tariff_col_updated')}</span>
              <span className="ocs-detail-value">{formatOcsTime(balance.updatedAt)}</span>
            </div>
          </div>
        </div>

        <div className="ocs-detail-section">
          <h2><Wallet size={16} aria-hidden="true" /> {t('ocs_balance_cycle')}</h2>
          <div className="ocs-detail-fields">
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_balance_cycle_start')}</span>
              <span className="ocs-detail-value">{formatOcsTime(balance.cycleStartAt)}</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_balance_cycle_reset')}</span>
              <span className="ocs-detail-value">{formatOcsTime(balance.cycleResetAt)}</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_balance_money')}</span>
              <span className="ocs-detail-value ocs-mono">{formatOcsNumber(balance.moneyBalance)}</span>
            </div>
          </div>
        </div>
      </div>

      <section className="ocs-detail-section ocs-detail-section-full">
        <h2><History size={16} aria-hidden="true" /> {t('ocs_adjustments_title')}</h2>
        <p className="ocs-detail-hint">{t('ocs_adjustments_note')}</p>
        {adjustmentsError ? (
          <div className="ocs-feedback-error ocs-feedback-spaced" role="alert">
            <span>{t('ocs_detail_load_failed')}</span>
            <button
              type="button"
              className="ocs-btn ocs-btn-secondary ocs-btn-compact-auto"
              onClick={() => { void refreshAdjustments(); }}
            >
              {t('retry')}
            </button>
          </div>
        ) : adjustmentsLoading && adjustments.length === 0 ? (
          <p className="ocs-empty">{t('loading')}</p>
        ) : adjustments.length === 0 ? (
          <p className="ocs-empty">{t('ocs_adjustments_empty')}</p>
        ) : (
          <div className="ocs-table-wrap">
            <table className="ocs-table">
              <caption className="sr-only">{t('ocs_adjustments_title')}</caption>
              <thead>
                <tr>
                  <th data-column-priority="essential">{t('ocs_adjustments_col_time')}</th>
                  <th data-column-priority="important">{t('ocs_adjustments_col_actor')}</th>
                  <th data-column-priority="essential">{t('ocs_adjustments_col_change')}</th>
                  <th data-column-priority="supplementary">{t('ocs_adjustments_col_reason')}</th>
                  <th data-column-priority="supplementary">{t('ocs_adjustments_col_result')}</th>
                  <th data-column-priority="supplementary">{t('ocs_balance_version')}</th>
                </tr>
              </thead>
              <tbody>
                {adjustments.map((adjustment, index) => (
                  <tr key={adjustment.id ?? `adjustment-${index}`}>
                    <td data-label={t('ocs_adjustments_col_time')} data-column-priority="essential" className="ocs-time-cell">
                      {formatOcsTime(adjustment.createdAt)}
                    </td>
                    <td data-label={t('ocs_adjustments_col_actor')} data-column-priority="important">
                      {adjustment.actor || '\u2014'}
                    </td>
                    <td data-label={t('ocs_adjustments_col_change')} data-column-priority="essential" className="ocs-mono">
                      {adjustmentSummary(adjustment)}
                    </td>
                    <td data-label={t('ocs_adjustments_col_reason')} data-column-priority="supplementary">
                      {adjustment.reason || '\u2014'}
                    </td>
                    <td data-label={t('ocs_adjustments_col_result')} data-column-priority="supplementary">
                      {resultLabel(adjustment.result)}
                    </td>
                    <td data-label={t('ocs_balance_version')} data-column-priority="supplementary" className="ocs-mono">
                      {adjustment.beforeVersion === null || adjustment.afterVersion === null
                        ? '\u2014'
                        : `${adjustment.beforeVersion} \u2192 ${adjustment.afterVersion}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {adjustOpen && !hasConflict && balance && balance.imsi === imsi && (
        <AdjustBalanceModal
          isOpen={true}
          imsi={balance.imsi ?? ''}
          balance={balance}
          dataAvailable={balance.data.available}
          voiceAvailable={balance.voice.available}
          smsAvailable={balance.sms.available}
          version={balance.version}
          hasHistoryOnSurface={true}
          casEligible={casEligible}
          onRefresh={async () => {
            const raw = await getJson<unknown>(`/api/ocs/balances/${encoded}`);
            const fresh = toBalanceViewModel(raw);
            if (fresh && fresh.imsi === imsi) {
              applyAuthoritativeSnapshot(fresh);
            }
            void refresh();
          }}
          onRefreshHistory={async () => {
            await getJson<unknown>(`/api/ocs/balances/${encoded}/adjustments?limit=20`);
            void refreshAdjustments();
          }}
          onBalanceUpdate={(fresh) => {
            if (fresh && fresh.imsi === imsi) {
              applyAuthoritativeSnapshot(fresh);
            }
          }}
          onClose={() => setAdjustOpen(false)}
          onSuccess={(result) => {
            setFeedback({
              type: result.outcome === 'executed_audit_warning' ? 'error' : 'success',
              message: result.message,
            });
            void handleManualRefresh();
            void refreshAdjustments();
          }}
        />
      )}
    </div>
  );
}
