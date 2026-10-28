/*
 * Charging contract detail (`/ocs/contracts/:imsi`).
 *
 * The historical page located its record with
 * `records.find(...) || records[0]`, which rendered a different subscriber when
 * the filter matched nothing. The lookup here is exact or absent: a non-matching
 * identifier produces the "not found" state, never a neighbouring record.
 *
 * Contract mutations live here as well, because the detail page is where an
 * operator lands after selecting a contract. A terminated contract exposes no
 * mutation at all: `POST /resume` would otherwise move it back to `active`, which
 * is a lifecycle resurrection rather than a resume.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, ArrowLeftRight, FileText, Pause, Play, Trash2, Users, Wallet } from 'lucide-react';
import PageHeader from '../../ui/PageHeader';
import RefreshButton from '../../ui/RefreshButton';
import { Dialog } from '../../ui/Dialog';
import OcsStatusBadge from '../common/OcsStatusBadge';
import ConfirmDialog from '../common/ConfirmDialog';
import OcsDetailState from '../common/OcsDetailState';
import { useRead } from '../../../lib/api/use-read';
import { deleteJson, patchJson, postJson } from '../../../lib/api/mutation-client';
import { hasPermission } from '../../../lib/permissions';
import { useAuth } from '../../../providers/AuthProvider';
import { useI18n } from '../../../providers/I18nProvider';
import {
  toContractViewModel,
  toTariffListViewModel,
  type TariffPlanViewModel,
} from '../../../features/ocs/ocs-view-models';
import { formatOcsBytes, formatOcsTime, sanitizeImsiInput } from '../../../features/ocs/ocs-format';

interface OcsContractDetailProps {
  imsi: string;
}

export default function OcsContractDetail({ imsi }: OcsContractDetailProps) {
  const { t } = useI18n();
  const { user } = useAuth();
  const canManage = hasPermission(user, 'ocs.plan.assign');

  const requested = sanitizeImsiInput(imsi);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmTerminate, setConfirmTerminate] = useState(false);
  const [tariffOpen, setTariffOpen] = useState(false);
  const [tariffDraft, setTariffDraft] = useState('');

  const { data, error, isLoading: loading, mutate: refresh } = useRead<unknown>(
    requested ? `/api/ocs/subscribers/${encodeURIComponent(requested)}` : null,
  );
  const { data: tariffs } = useRead<unknown>('/api/tariff-plans');

  /* The endpoint answers with exactly the requested contract, so a missing
   * identifier can no longer fall back to a neighbouring record whose IMSI
   * merely contains the same digits. */
  const contract = toContractViewModel(data);

  const plans = useMemo<TariffPlanViewModel[]>(() => toTariffListViewModel(tariffs).records, [tariffs]);
  const planById = useMemo(() => {
    const map = new Map<string, TariffPlanViewModel>();
    for (const plan of plans) if (plan.planId) map.set(plan.planId, plan);
    return map;
  }, [plans]);

  const planOptions = useMemo(() => {
    return plans
      .filter((plan) => plan.status === 'active' || plan.planId === contract?.planId)
      .sort((left, right) => (left.name ?? '').localeCompare(right.name ?? ''))
      .map((plan) => ({
        value: plan.planId ?? '',
        label: `${plan.name || plan.planId} \u00b7 ${formatOcsBytes(plan.quotaPerGrant)}`,
      }));
  }, [contract?.planId, plans]);

  const backTo = { to: '/ocs/contracts', label: t('ocs_back_to_list') };

  const run = async (action: string, fn: () => Promise<unknown>) => {
    setBusy(action);
    setFeedback(null);
    try {
      await fn();
      setFeedback({ type: 'success', message: t('ocs_contract_action_success') });
      await refresh();
    } catch (failure) {
      setFeedback({
        type: 'error',
        message: failure instanceof Error ? failure.message : t('ocs_sub_action_network_error'),
      });
    } finally {
      setBusy(null);
    }
  };

  if (loading && !contract) {
    return <div className="ocs-container"><OcsDetailState kind="loading" /></div>;
  }

  if (!requested) {
    return <div className="ocs-container"><OcsDetailState kind="notFound" backTo={backTo} /></div>;
  }

  if (error && !contract) {
    const status = (error as { status?: number }).status ?? 0;
    if (status === 403) {
      return <div className="ocs-container"><OcsDetailState kind="forbidden" backTo={backTo} /></div>;
    }
    /* A malformed identifier and an absent contract are the same outcome for the
     * operator: there is nothing to open at this address. */
    if (status === 404 || status === 400) {
      return <div className="ocs-container"><OcsDetailState kind="notFound" backTo={backTo} /></div>;
    }
    return (
      <div className="ocs-container">
        <OcsDetailState kind="error" detail={error.message} onRetry={() => void refresh()} backTo={backTo} />
      </div>
    );
  }

  if (!contract) {
    return <div className="ocs-container"><OcsDetailState kind="notFound" backTo={backTo} /></div>;
  }

  const terminated = contract.status === 'terminated';
  const plan = contract.planId ? planById.get(contract.planId) : undefined;

  return (
    <div className="ocs-container">
      <PageHeader
        eyebrow={t('nav_ocs_contracts')}
        title={contract.imsi ?? ''}
        description={contract.msisdn || ''}
        actions={
          <div className="ocs-header-actions">
            <Link to="/ocs/contracts" className="ocs-btn ocs-btn-secondary">
              <ArrowLeft size={14} aria-hidden="true" /> {t('ocs_back_to_list')}
            </Link>
            <Link to={`/ocs/balances/${encodeURIComponent(contract.imsi ?? '')}`} className="ocs-btn ocs-btn-secondary">
              <Wallet size={14} aria-hidden="true" /> {t('ocs_contract_view_balance')}
            </Link>
            <Link to={`/subscribers?q=${encodeURIComponent(contract.imsi ?? '')}`} className="ocs-btn ocs-btn-secondary">
              {t('ocs_balance_view_subscriber')}
            </Link>
            <RefreshButton loading={loading} onClick={() => void refresh()} label={t('refresh')} className="ocs-btn" />
            {canManage && !terminated && (
              <>
                <button
                  type="button"
                  className="ocs-btn ocs-btn-secondary"
                  disabled={Boolean(busy)}
                  onClick={() => {
                    setTariffDraft(contract.planId ?? '');
                    setTariffOpen(true);
                  }}
                >
                  <ArrowLeftRight size={14} aria-hidden="true" /> {t('ocs_sub_action_change_tariff')}
                </button>
                {contract.status === 'active' ? (
                  <button
                    type="button"
                    className="ocs-btn ocs-btn-secondary"
                    disabled={Boolean(busy)}
                    onClick={() => void run('suspend', () => postJson(`/api/ocs/subscribers/${encodeURIComponent(contract.imsi ?? '')}/suspend`))}
                  >
                    <Pause size={14} aria-hidden="true" /> {t('ocs_sub_action_suspend')}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="ocs-btn ocs-btn-secondary"
                    disabled={Boolean(busy)}
                    onClick={() => void run('resume', () => postJson(`/api/ocs/subscribers/${encodeURIComponent(contract.imsi ?? '')}/resume`))}
                  >
                    <Play size={14} aria-hidden="true" /> {t('ocs_sub_action_resume')}
                  </button>
                )}
                <button
                  type="button"
                  className="ocs-btn ocs-btn-danger"
                  disabled={Boolean(busy)}
                  onClick={() => setConfirmTerminate(true)}
                >
                  <Trash2 size={14} aria-hidden="true" /> {t('ocs_sub_action_terminate')}
                </button>
              </>
            )}
          </div>
        }
      />

      {feedback && (
        <div className={feedback.type === 'success' ? 'ocs-feedback-success ocs-feedback-spaced' : 'ocs-feedback-error ocs-feedback-spaced'} role={feedback.type === 'error' ? 'alert' : 'status'}>
          <span>{feedback.message}</span>
        </div>
      )}

      {terminated && (
        <div className="ocs-detail-hint" role="note">{t('ocs_contract_terminated_hint')}</div>
      )}

      <div className="ocs-detail-grid">
        <div className="ocs-detail-section">
          <h3><Users size={16} aria-hidden="true" /> {t('ocs_contract_detail_identity')}</h3>
          <div className="ocs-detail-fields">
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">IMSI</span>
              <span className="ocs-detail-value ocs-mono">{contract.imsi ?? '\u2014'}</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">MSISDN</span>
              <span className="ocs-detail-value">{contract.msisdn || '\u2014'}</span>
            </div>
          </div>
        </div>

        <div className="ocs-detail-section">
          <h3><FileText size={16} aria-hidden="true" /> {t('ocs_contract_detail_billing')}</h3>
          <div className="ocs-detail-fields">
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_contract_col_tariff')}</span>
              <span className="ocs-detail-value">
                <Link to={`/ocs/tariffs/${encodeURIComponent(contract.planId ?? '')}`} className="ocs-link">
                  {plan?.name || contract.planId}
                </Link>
              </span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_tariff_col_quota')}</span>
              <span className="ocs-detail-value ocs-mono">{formatOcsBytes(plan?.quotaPerGrant ?? null)}</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_contract_col_billing_status')}</span>
              <span className="ocs-detail-value"><OcsStatusBadge status={contract.status ?? ''} /></span>
            </div>
          </div>
        </div>

        <div className="ocs-detail-section">
          <h3><FileText size={16} aria-hidden="true" /> {t('ocs_tariff_detail_history')}</h3>
          <div className="ocs-detail-fields">
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_contract_col_created')}</span>
              <span className="ocs-detail-value">{formatOcsTime(contract.createdAt)}</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_contract_col_updated')}</span>
              <span className="ocs-detail-value">{formatOcsTime(contract.updatedAt)}</span>
            </div>
          </div>
        </div>
      </div>

      <Dialog
        open={tariffOpen}
        onClose={() => setTariffOpen(false)}
        className="ocs-dialog"
        overlayClassName="ocs-dialog-overlay"
        labelledBy="contract-detail-tariff-title"
      >
        <div className="ocs-dialog-header">
          <h3 id="contract-detail-tariff-title">{t('ocs_sub_action_change_tariff')}</h3>
        </div>
        <div className="ocs-form-group">
          <label htmlFor="contract-detail-tariff" className="ocs-form-label">{t('ocs_filter_plan')}</label>
          <select
            id="contract-detail-tariff"
            className="ocs-select"
            value={tariffDraft}
            onChange={(event) => setTariffDraft(event.target.value)}
          >
            {planOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>
        <div className="ocs-dialog-actions">
          <button type="button" className="ocs-btn ocs-btn-secondary" onClick={() => setTariffOpen(false)} disabled={Boolean(busy)}>
            {t('cancel')}
          </button>
          <button
            type="button"
            className="ocs-btn ocs-btn-primary"
            disabled={Boolean(busy) || !tariffDraft || tariffDraft === contract.planId}
            onClick={() => {
              const target = tariffDraft;
              setTariffOpen(false);
              void run('change-tariff', () =>
                patchJson(`/api/ocs/subscribers/${encodeURIComponent(contract.imsi ?? '')}`, { plan_id: target }));
            }}
          >
            {t('confirm')}
          </button>
        </div>
      </Dialog>

      {confirmTerminate && (
        <ConfirmDialog
          title={t('ocs_confirm_terminate_title')}
          message={t('ocs_sub_confirm_terminate').replace('{imsi}', contract.imsi ?? '')}
          confirmLabel={t('ocs_sub_action_terminate')}
          danger
          loading={Boolean(busy)}
          onConfirm={() => {
            setConfirmTerminate(false);
            void run('terminate', () => deleteJson(`/api/ocs/subscribers/${encodeURIComponent(contract.imsi ?? '')}`));
          }}
          onCancel={() => setConfirmTerminate(false)}
        />
      )}
    </div>
  );
}
