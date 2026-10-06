/*
 * Forward-ported from the historical xCloud UI (reference commit 2c40903):
 * frontend/src/components/ocs/contracts/OcsContractDetail.tsx
 *
 * Adaptations: "use client" dropped; `@/` aliases replaced with relative imports;
 * the historical Next.js link component replaced by the React Router link (`href` -> `to`); `useSWR(fetcher)`
 * replaced by the current read client; the `{records}` envelope unwrapped by the
 * typed contract adapter rather than read raw.
 *
 * The reference located its record with `records.find(...) || records[0]`, which
 * renders a different subscriber when the filter matched nothing. The adapter
 * keeps that lookup but only over records whose IMSI actually matches.
 */
import { Link } from 'react-router-dom';
import { ArrowLeft, FileText, History, Users } from 'lucide-react';
import PageHeader from '../../ui/PageHeader';
import RefreshButton from '../../ui/RefreshButton';
import OcsStatusBadge from '../common/OcsStatusBadge';
import { useRead } from '../../../lib/api/use-read';
import { useI18n } from '../../../providers/I18nProvider';
import { toContractListViewModel } from '../../../features/ocs/ocs-view-models';

interface OcsContractDetailProps {
  imsi: string;
}

export default function OcsContractDetail({ imsi }: OcsContractDetailProps) {
  const { t } = useI18n();

  const { data, isLoading: loading, mutate: refresh } = useRead<unknown>(
    `/api/ocs/subscribers?imsi=${encodeURIComponent(imsi)}&limit=1`,
  );

  const records = toContractListViewModel(data).records;
  const contract = records.find((record) => record.imsi === imsi) ?? records[0];

  if (loading) {
    return (
      <div className="ocs-container">
        <div className="ocs-loading">{t('loading')}</div>
      </div>
    );
  }

  if (!contract) {
    return (
      <div className="ocs-container">
        <div className="ocs-empty">{t('ocs_contract_not_found')}</div>
      </div>
    );
  }

  return (
    <div className="ocs-container">
      <PageHeader
        eyebrow={t('nav_ocs_contracts')}
        title={contract.imsi ?? ''}
        description={contract.msisdn || ''}
        actions={
          <div className="ocs-header-actions">
            <Link to="/ocs/contracts" className="ocs-btn ocs-btn-secondary">
              <ArrowLeft size={14} /> {t('ocs_back_to_list')}
            </Link>
            <RefreshButton loading={loading} onClick={() => void refresh()} label={t('refresh')} className="ocs-btn" />
          </div>
        }
      />

      <div className="ocs-detail-grid">
        <div className="ocs-detail-section">
          <h3><Users size={16} /> {t('ocs_contract_detail_identity')}</h3>
          <div className="ocs-detail-fields">
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">IMSI</span>
              <span className="ocs-detail-value ocs-mono">{contract.imsi}</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">MSISDN</span>
              <span className="ocs-detail-value">{contract.msisdn || '—'}</span>
            </div>
          </div>
        </div>

        <div className="ocs-detail-section">
          <h3><FileText size={16} /> {t('ocs_contract_detail_billing')}</h3>
          <div className="ocs-detail-fields">
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_contract_col_tariff')}</span>
              <span className="ocs-detail-value">
                <Link to={`/ocs/tariffs/${encodeURIComponent(contract.planId ?? '')}`} className="ocs-link">{contract.planId}</Link>
              </span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_contract_col_billing_status')}</span>
              <span className="ocs-detail-value"><OcsStatusBadge status={contract.status ?? ''} /></span>
            </div>
          </div>
        </div>

        <div className="ocs-detail-section">
          <h3><History size={16} /> {t('ocs_tariff_detail_history')}</h3>
          <div className="ocs-detail-fields">
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_contract_col_created')}</span>
              <span className="ocs-detail-value">{contract.createdAt ? new Date(contract.createdAt).toLocaleString() : '—'}</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_contract_col_updated')}</span>
              <span className="ocs-detail-value">{contract.updatedAt ? new Date(contract.updatedAt).toLocaleString() : '—'}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
