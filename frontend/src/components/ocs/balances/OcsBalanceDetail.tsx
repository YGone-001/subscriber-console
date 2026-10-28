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
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Database, MessageSquare, Phone, ShieldCheck, SlidersHorizontal, Wallet } from 'lucide-react';
import PageHeader from '../../ui/PageHeader';
import RefreshButton from '../../ui/RefreshButton';
import OcsStatusBadge from '../common/OcsStatusBadge';
import OcsInvariantBadge from '../common/OcsInvariantBadge';
import OcsDetailState from '../common/OcsDetailState';
import AdjustBalanceModal from './AdjustBalanceModal';
import { useRead } from '../../../lib/api/use-read';
import { hasPermission } from '../../../lib/permissions';
import { useAuth } from '../../../providers/AuthProvider';
import { useI18n } from '../../../providers/I18nProvider';
import { toBalanceViewModel } from '../../../features/ocs/ocs-view-models';
import { formatOcsBytes, formatOcsNumber, formatOcsTime } from '../../../features/ocs/ocs-format';

interface OcsBalanceDetailProps {
  imsi: string;
}

export default function OcsBalanceDetail({ imsi }: OcsBalanceDetailProps) {
  const { t } = useI18n();
  const { user } = useAuth();
  const canAdjust = hasPermission(user, 'ocs.balance.adjust');

  const [adjustOpen, setAdjustOpen] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const { data, error, isLoading: loading, mutate: refresh } = useRead<unknown>(
    `/api/ocs/balances/${encodeURIComponent(imsi)}`,
  );

  const balance = toBalanceViewModel(data);
  const backTo = { to: '/ocs/balances', label: t('ocs_back_to_list') };

  if (loading && !balance) {
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
            <Link to="/ocs/balances" className="ocs-btn ocs-btn-secondary">
              <ArrowLeft size={14} aria-hidden="true" /> {t('ocs_back_to_list')}
            </Link>
            <Link to={`/ocs/contracts/${encodeURIComponent(balance.imsi ?? '')}`} className="ocs-btn ocs-btn-secondary">
              {t('ocs_balance_view_contract')}
            </Link>
            <Link to={`/subscribers?q=${encodeURIComponent(balance.imsi ?? '')}`} className="ocs-btn ocs-btn-secondary">
              {t('ocs_balance_view_subscriber')}
            </Link>
            <RefreshButton loading={loading} onClick={() => void refresh()} label={t('refresh')} className="ocs-btn" />
            {canAdjust && (
              <button type="button" className="ocs-btn ocs-btn-primary" onClick={() => setAdjustOpen(true)}>
                <SlidersHorizontal size={14} aria-hidden="true" />
                <span>{t('ocs_balance_adjust')}</span>
              </button>
            )}
          </div>
        }
      />

      {feedback && (
        <div className={feedback.type === 'success' ? 'ocs-feedback-success ocs-feedback-spaced' : 'ocs-feedback-error ocs-feedback-spaced'} role={feedback.type === 'error' ? 'alert' : 'status'}>
          <span>{feedback.message}</span>
        </div>
      )}

      <div className="ocs-detail-grid">
        <div className="ocs-detail-section">
          <h3><Database size={16} aria-hidden="true" /> {t('ocs_balance_data_bucket')}</h3>
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
          <h3><Phone size={16} aria-hidden="true" /> {t('ocs_balance_voice_bucket')}</h3>
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
          <h3><MessageSquare size={16} aria-hidden="true" /> {t('ocs_balance_sms_bucket')}</h3>
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
          <h3><ShieldCheck size={16} aria-hidden="true" /> {t('ocs_balance_governance_info')}</h3>
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
          <h3><Wallet size={16} aria-hidden="true" /> {t('ocs_balance_cycle')}</h3>
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

      {adjustOpen && (
        <AdjustBalanceModal
          isOpen={true}
          imsi={balance.imsi ?? ''}
          dataAvailable={balance.data.available}
          voiceAvailable={balance.voice.available}
          smsAvailable={balance.sms.available}
          version={balance.version}
          onClose={() => setAdjustOpen(false)}
          onSuccess={(result) => {
            setFeedback({
              type: result.outcome === 'executed_audit_warning' ? 'error' : 'success',
              message: result.message,
            });
            void refresh();
          }}
        />
      )}
    </div>
  );
}
