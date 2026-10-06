/*
 * Forward-ported from the historical xCloud UI (reference commit 2c40903):
 * frontend/src/components/ocs/tariffs/OcsTariffDetail.tsx
 *
 * Adaptations: "use client" dropped; `@/` aliases replaced with relative imports;
 * the historical Next.js link component replaced by the React Router link (`href` -> `to`); `useSWR(fetcher)`
 * replaced by the current read client; the `{plan}`, `{rules}` and `{subscribers}`
 * envelopes unwrapped by the typed tariff adapter instead of being read raw.
 *
 * The reference read `data.plan` directly and left `plan.rulesCount` unused when
 * the rules call was still in flight; the adapter keeps missing and zero apart so
 * an unloaded count renders as 0 only when the contract says zero.
 */
import { Link } from 'react-router-dom';
import { ArrowLeft, FileText, History, Users } from 'lucide-react';
import PageHeader from '../../ui/PageHeader';
import RefreshButton from '../../ui/RefreshButton';
import OcsStatusBadge from '../common/OcsStatusBadge';
import { useRead } from '../../../lib/api/use-read';
import { useI18n } from '../../../providers/I18nProvider';
import { toTariffDetailViewModel } from '../../../features/ocs/ocs-view-models';
import { asArray, asRecord } from '../../../lib/api/envelope';

interface OcsTariffDetailProps {
  planId: string;
}

export default function OcsTariffDetail({ planId }: OcsTariffDetailProps) {
  const { t } = useI18n();

  const encoded = encodeURIComponent(planId);
  const { data, isLoading: loading, mutate: refresh } = useRead<unknown>(`/api/tariff-plans/${encoded}`);
  const { data: rulesData } = useRead<unknown>(`/api/tariff-plans/${encoded}/rules`);
  const { data: subsData } = useRead<unknown>(`/api/tariff-plans/${encoded}/subscribers`);

  const plan = toTariffDetailViewModel(data);
  const rules = asArray(asRecord(rulesData).rules) ?? [];
  const subscriberList = asArray(asRecord(subsData).subscribers);
  const subscriberCount = subscriberList?.length ?? plan?.subscriberCount ?? 0;

  if (loading) {
    return (
      <div className="ocs-container">
        <div className="ocs-loading">{t('loading')}</div>
      </div>
    );
  }

  if (!plan) {
    return (
      <div className="ocs-container">
        <div className="ocs-empty">{t('ocs_tariff_not_found')}</div>
      </div>
    );
  }

  return (
    <div className="ocs-container">
      <PageHeader
        eyebrow={t('nav_ocs_tariffs')}
        title={plan.name || plan.planId || ''}
        description={plan.description || ''}
        actions={
          <div className="ocs-header-actions">
            <Link to="/ocs/tariffs" className="ocs-btn ocs-btn-secondary">
              <ArrowLeft size={14} /> {t('ocs_back_to_list')}
            </Link>
            <RefreshButton loading={loading} onClick={() => void refresh()} label={t('refresh')} className="ocs-btn" />
          </div>
        }
      />

      <div className="ocs-detail-grid">
        <div className="ocs-detail-section">
          <h3><FileText size={16} /> {t('ocs_tariff_detail_basic')}</h3>
          <div className="ocs-detail-fields">
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_tariff_col_plan_id')}</span>
              <span className="ocs-detail-value ocs-mono">{plan.planId}</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_tariff_col_name')}</span>
              <span className="ocs-detail-value">{plan.name}</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_tariff_col_status')}</span>
              <span className="ocs-detail-value"><OcsStatusBadge status={plan.status ?? ''} /></span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_tariff_governance_col_version')}</span>
              <span className="ocs-detail-value ocs-mono">v{plan.version || 1}</span>
            </div>
          </div>
        </div>

        <div className="ocs-detail-section">
          <h3><FileText size={16} /> {t('ocs_tariff_detail_quota')}</h3>
          <div className="ocs-detail-fields">
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_tariff_detail_data_quota')}</span>
              <span className="ocs-detail-value ocs-mono">{plan.quotaPerGrant ? `${plan.quotaPerGrant} B` : '—'}</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_tariff_detail_voice_quota')}</span>
              <span className="ocs-detail-value">{t('ocs_tariff_detail_per_rules')}</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_tariff_detail_sms_quota')}</span>
              <span className="ocs-detail-value">{t('ocs_tariff_detail_per_rules')}</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_tariff_detail_rules_count')}</span>
              <span className="ocs-detail-value">{rules.length || plan.rulesCount || 0}</span>
            </div>
          </div>
        </div>

        <div className="ocs-detail-section">
          <h3><Users size={16} /> {t('ocs_tariff_detail_subscriber_binding')}</h3>
          <div className="ocs-detail-fields">
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_tariff_detail_bound_count')}</span>
              <span className="ocs-detail-value">{subscriberCount}</span>
            </div>
          </div>
        </div>

        <div className="ocs-detail-section">
          <h3><History size={16} /> {t('ocs_tariff_detail_history')}</h3>
          <div className="ocs-detail-fields">
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_tariff_detail_created')}</span>
              <span className="ocs-detail-value">{plan.createdAt ? new Date(plan.createdAt).toLocaleString() : '—'}</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_tariff_col_updated')}</span>
              <span className="ocs-detail-value">{plan.updatedAt ? new Date(plan.updatedAt).toLocaleString() : '—'}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
