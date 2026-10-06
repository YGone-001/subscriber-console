/*
 * Forward-ported from the historical xCloud UI (reference commit 2c40903):
 * frontend/src/components/ocs/balances/OcsBalanceDetail.tsx
 *
 * Adaptations: "use client" dropped; `@/` aliases replaced with relative imports;
 * the historical Next.js link component replaced by the React Router link (`href` -> `to`); `useSWR(fetcher)`
 * replaced by the current read client; the `{ok, records}` envelope unwrapped by
 * the typed balance adapter; the capability check replaced by the current
 * `hasPermission` gate for `ocs.balance.adjust`.
 *
 * Balance reset remains unavailable on this surface.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Database, MessageSquare, Phone, ShieldCheck, SlidersHorizontal } from 'lucide-react';
import PageHeader from '../../ui/PageHeader';
import RefreshButton from '../../ui/RefreshButton';
import OcsStatusBadge from '../common/OcsStatusBadge';
import AdjustBalanceModal from './AdjustBalanceModal';
import { useRead } from '../../../lib/api/use-read';
import { hasPermission } from '../../../lib/permissions';
import { useAuth } from '../../../providers/AuthProvider';
import { useI18n } from '../../../providers/I18nProvider';
import { formatBytes } from '../../../lib/unitParser';
import { toBalanceListViewModel } from '../../../features/ocs/ocs-view-models';

interface OcsBalanceDetailProps {
  imsi: string;
}

export default function OcsBalanceDetail({ imsi }: OcsBalanceDetailProps) {
  const { t } = useI18n();
  const { user } = useAuth();
  const canAdjust = hasPermission(user, 'ocs.balance.adjust');

  const [adjustOpen, setAdjustOpen] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const { data, isLoading: loading, mutate: refresh } = useRead<unknown>(
    `/api/ocs/balances?imsi=${encodeURIComponent(imsi)}&limit=1`,
  );

  const balance = toBalanceListViewModel(data).records[0] ?? null;

  const formatTime = (iso: string | null) => {
    if (!iso) return '—';
    const parsed = new Date(iso);
    return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleString();
  };

  if (loading) {
    return (
      <div className="ocs-container">
        <div className="ocs-loading">{t('loading')}</div>
      </div>
    );
  }

  if (!balance) {
    return (
      <div className="ocs-container">
        <div className="ocs-empty">{t('ocs_balance_not_found')}</div>
      </div>
    );
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
              <ArrowLeft size={14} /> {t('ocs_back_to_list')}
            </Link>
            <RefreshButton loading={loading} onClick={() => void refresh()} label={t('refresh')} className="ocs-btn" />
            {canAdjust && (
              <button
                type="button"
                className="ocs-btn ocs-btn-primary"
                onClick={() => setAdjustOpen(true)}
              >
                <SlidersHorizontal size={14} />
                <span>{t('ocs_balance_adjust')}</span>
              </button>
            )}
          </div>
        }
      />

      {feedback && (
        <div className={feedback.type === 'success' ? 'ocs-feedback-success ocs-feedback-spaced' : 'ocs-feedback-error ocs-feedback-spaced'}>
          <span>{feedback.message}</span>
        </div>
      )}

      <div className="ocs-detail-grid">
        <div className="ocs-detail-section">
          <h3><Database size={16} /> {t('ocs_balance_data_bucket')}</h3>
          <div className="ocs-detail-fields">
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_detail_data_total')}</span>
              <span className="ocs-detail-value ocs-mono">{formatBytes(balance.data.total ?? 0)}</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_detail_data_used')}</span>
              <span className="ocs-detail-value ocs-mono">{formatBytes(balance.data.used ?? 0)}</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_detail_data_reserved')}</span>
              <span className="ocs-detail-value ocs-mono">{formatBytes(balance.data.reserved ?? 0)}</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_detail_data_available')}</span>
              <span className="ocs-detail-value ocs-mono ocs-detail-value-strong">
                {formatBytes(balance.data.available ?? 0)}
              </span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_detail_data_invariant')}</span>
              <span className="ocs-detail-value">
                {balance.invariants.data ? t('ocs_detail_true') : t('ocs_detail_false_mismatch')}
              </span>
            </div>
          </div>
        </div>

        <div className="ocs-detail-section">
          <h3><Phone size={16} /> {t('ocs_balance_voice_bucket')}</h3>
          <div className="ocs-detail-fields">
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_col_voice_alloc')}</span>
              <span className="ocs-detail-value ocs-mono">{balance.voice.total ?? 0}s</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_col_voice_used')}</span>
              <span className="ocs-detail-value ocs-mono">{balance.voice.used ?? 0}s</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_col_voice_avail')}</span>
              <span className="ocs-detail-value ocs-mono ocs-detail-value-strong">
                {balance.voice.available ?? 0}s
              </span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_detail_voice_invariant')}</span>
              <span className="ocs-detail-value">
                {balance.invariants.voice ? t('ocs_detail_true') : t('ocs_detail_false_mismatch')}
              </span>
            </div>
          </div>
        </div>

        <div className="ocs-detail-section">
          <h3><MessageSquare size={16} /> {t('ocs_balance_sms_bucket')}</h3>
          <div className="ocs-detail-fields">
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_col_sms_alloc')}</span>
              <span className="ocs-detail-value ocs-mono">{balance.sms.total ?? 0}</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_col_sms_used')}</span>
              <span className="ocs-detail-value ocs-mono">{balance.sms.used ?? 0}</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_col_sms_avail')}</span>
              <span className="ocs-detail-value ocs-mono ocs-detail-value-strong">
                {balance.sms.available ?? 0}
              </span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_detail_sms_invariant')}</span>
              <span className="ocs-detail-value">
                {balance.invariants.sms ? t('ocs_detail_true') : t('ocs_detail_false_mismatch')}
              </span>
            </div>
          </div>
        </div>

        <div className="ocs-detail-section">
          <h3><ShieldCheck size={16} /> {t('ocs_balance_governance_info')}</h3>
          <div className="ocs-detail-fields">
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_balance_account_status')}</span>
              <span className="ocs-detail-value"><OcsStatusBadge status={balance.status ?? ''} /></span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_balance_version')}</span>
              <span className="ocs-detail-value ocs-mono">v{balance.version}</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_tariff_col_updated')}</span>
              <span className="ocs-detail-value">{formatTime(balance.updatedAt)}</span>
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
