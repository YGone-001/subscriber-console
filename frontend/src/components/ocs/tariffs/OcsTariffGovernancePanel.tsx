/*
 * Forward-ported from the historical xCloud UI (reference commit 2c40903):
 * frontend/src/components/ocs/tariffs/OcsTariffGovernancePanel.tsx
 *
 * This is the component the historical `/ocs/tariffs` route actually rendered
 * (`app/(dashboard)/ocs/tariffs/page.tsx` forwards to it), not `OcsTariffsPanel`.
 *
 * Adaptations, all at the runtime and data boundary only:
 *   - `"use client"` dropped; `@/` aliases replaced with relative imports.
 *   - the historical Next.js link component replaced by the React Router link, with `href` -> `to`.
 *   - `useSWR(fetcher)` replaced by the current read client.
 *   - raw `fetch` mutations replaced by the current mutation client, so 401
 *     session revalidation, 403/409/429 error surfacing and no-store semantics
 *     are inherited rather than reimplemented.
 *   - `data.plans` replaced by the typed tariff adapter, which unwraps the
 *     `{plans}` envelope and preserves missing vs zero.
 *   - A write-permission gate is applied, because the current RBAC model denies
 *     tariff mutation to viewers.
 *
 * The DOM structure, class vocabulary, column order and action ordering are
 * unchanged from the reference.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  CheckCircle,
  Copy,
  Eye,
  FileText,
  Pencil,
  Plus,
  Power,
  PowerOff,
  Trash2,
  XCircle,
} from 'lucide-react';
import { DataTableStateRow } from '../../ui/DataTableState';
import MetricStrip from '../../ui/MetricStrip';
import OcsPageShell from '../OcsPageShell';
import OcsStatusBadge from '../common/OcsStatusBadge';
import ConfirmDialog from '../common/ConfirmDialog';
import TariffPlanModal from './TariffPlanModal';
import { useRead } from '../../../lib/api/use-read';
import { deleteJson, postJson } from '../../../lib/api/mutation-client';
import { hasPermission } from '../../../lib/permissions';
import { useAuth } from '../../../providers/AuthProvider';
import { useI18n } from '../../../providers/I18nProvider';
import { toTariffListViewModel, type TariffPlanViewModel } from '../../../features/ocs/ocs-view-models';

interface ActionFeedback {
  type: 'success' | 'error';
  message: string;
}

export default function OcsTariffGovernancePanel() {
  const { t } = useI18n();
  const { user } = useAuth();
  const [actionFeedback, setActionFeedback] = useState<ActionFeedback | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<{ action: string; planId: string } | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedPlanForEdit, setSelectedPlanForEdit] = useState<TariffPlanViewModel | null>(null);

  const canWrite = hasPermission(user, 'ocs.tariff.write');

  const { data, isLoading: loading, mutate: refresh } = useRead<unknown>('/api/tariff-plans');

  const plans = toTariffListViewModel(data).records;

  const activePlans = plans.filter((plan) => plan.status === 'active').length;
  const disabledPlans = plans.filter((plan) => plan.status === 'disabled').length;
  const totalSubscribers = plans.reduce((sum, plan) => sum + (plan.subscriberCount ?? 0), 0);

  const handleAction = async (action: string, planId: string) => {
    const actionKey = `${action}:${planId}`;
    setPendingAction(actionKey);
    setActionFeedback(null);
    setConfirmAction(null);

    try {
      if (action === 'clone') {
        const targetPlanId = `${planId}_copy_${Date.now()}`;
        await postJson(`/api/tariff-plans/${encodeURIComponent(planId)}/clone`, { target_plan_id: targetPlanId });
      } else if (action === 'enable') {
        await postJson(`/api/tariff-plans/${encodeURIComponent(planId)}/enable`);
      } else if (action === 'disable') {
        await postJson(`/api/tariff-plans/${encodeURIComponent(planId)}/disable`);
      } else if (action === 'delete') {
        await deleteJson(`/api/tariff-plans/${encodeURIComponent(planId)}`);
      } else {
        return;
      }

      setActionFeedback({ type: 'success', message: t('ocs_tariff_action_success') });
      await refresh();
    } catch (error) {
      setActionFeedback({
        type: 'error',
        message: error instanceof Error ? error.message : t('ocs_tariff_action_failed'),
      });
    } finally {
      setPendingAction(null);
    }
  };

  const requestDelete = (planId: string) => {
    setConfirmAction({ action: 'delete', planId });
  };

  const kpiGrid = (
    <MetricStrip
      variant="strip"
      ariaLabel={t('ocs_tariffs_title')}
      items={[
        { key: 'plans', label: t('ocs_tariff_total_plans'), value: plans.length, icon: <FileText size={20} /> },
        { key: 'active', label: t('ocs_tariff_active_plans'), value: activePlans, icon: <CheckCircle size={20} /> },
        { key: 'disabled', label: t('ocs_tariff_disabled_plans'), value: disabledPlans, icon: <XCircle size={20} /> },
        { key: 'subscribers', label: t('ocs_tariff_total_subscribers'), value: totalSubscribers, icon: <FileText size={20} /> },
      ]}
    />
  );

  return (
    <>
      <OcsPageShell
        eyebrow={t('nav_ocs')}
        title={t('ocs_tariffs_title')}
        readonly={false}
        description={t('ocs_tariffs_desc')}
        loading={loading}
        onRefresh={() => void refresh()}
        kpiGrid={kpiGrid}
        controls={
          canWrite ? (
            <div className="ocs-controls-bar ocs-controls-bar-end">
              <button
                type="button"
                className="ocs-btn ocs-btn-primary"
                onClick={() => {
                  setSelectedPlanForEdit(null);
                  setModalOpen(true);
                }}
              >
                <Plus size={16} />
                <span>{t('ocs_tariff_create')}</span>
              </button>
            </div>
          ) : null
        }
        tableContent={
          <>
            {actionFeedback && (
              <div className={actionFeedback.type === 'success' ? 'ocs-feedback-success' : 'ocs-feedback-error'}>
                <span>{actionFeedback.message}</span>
              </div>
            )}
            <div className="ocs-table-wrap">
              <table className="ocs-table">
                <caption className="sr-only">{t('ocs_tariffs_title')}</caption>
                <thead>
                  <tr>
                    <th data-column-priority="essential">{t('ocs_tariff_col_plan_id')}</th>
                    <th data-column-priority="essential">{t('ocs_tariff_col_name')}</th>
                    <th data-column-priority="essential">{t('ocs_tariff_col_status')}</th>
                    <th data-column-priority="supplementary">{t('ocs_tariff_governance_col_version')}</th>
                    <th data-column-priority="important">{t('ocs_tariff_col_subscribers')}</th>
                    <th data-column-priority="supplementary">{t('ocs_tariff_governance_col_updated_by')}</th>
                    <th data-column-priority="supplementary">{t('ocs_tariff_col_updated')}</th>
                    <th data-column-priority="essential">{t('ocs_tariff_col_actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {plans.length === 0 && !loading && (
                    <DataTableStateRow colSpan={8} state="empty">{t('no_data')}</DataTableStateRow>
                  )}
                  {plans.map((plan) => {
                    const planId = plan.planId ?? '';
                    return (
                      <tr key={planId}>
                        <td data-label={t('ocs_tariff_col_plan_id')} data-column-priority="essential" className="ocs-mono">{planId}</td>
                        <td data-label={t('ocs_tariff_col_name')} data-column-priority="essential">{plan.name}</td>
                        <td data-label={t('ocs_tariff_col_status')} data-column-priority="essential"><OcsStatusBadge status={plan.status ?? ''} /></td>
                        <td data-label={t('ocs_tariff_governance_col_version')} data-column-priority="supplementary" className="ocs-mono">v{plan.version || 1}</td>
                        <td data-label={t('ocs_tariff_col_subscribers')} data-column-priority="important">{plan.subscriberCount}</td>
                        <td data-label={t('ocs_tariff_governance_col_updated_by')} data-column-priority="supplementary">{plan.updatedBy || '—'}</td>
                        <td data-label={t('ocs_tariff_col_updated')} data-column-priority="supplementary">{plan.updatedAt ? new Date(plan.updatedAt).toLocaleDateString() : '—'}</td>
                        <td data-label={t('ocs_tariff_col_actions')} data-column-priority="essential">
                          <div className="ocs-action-group">
                            <Link
                              className="ocs-action-btn"
                              title={t('ocs_tariff_view_detail')}
                              to={`/ocs/tariffs/${encodeURIComponent(planId)}`}
                            >
                              <Eye size={14} />
                            </Link>
                            {canWrite && (
                              <>
                                <button
                                  type="button"
                                  className="ocs-action-btn"
                                  title={t('ocs_tariff_edit')}
                                  onClick={() => {
                                    setSelectedPlanForEdit(plan);
                                    setModalOpen(true);
                                  }}
                                >
                                  <Pencil size={14} />
                                </button>
                                {plan.status === 'active' ? (
                                  <button
                                    type="button"
                                    className="ocs-action-btn"
                                    title={t('ocs_tariff_disable')}
                                    disabled={pendingAction === `disable:${planId}`}
                                    onClick={() => void handleAction('disable', planId)}
                                  >
                                    <PowerOff size={14} />
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    className="ocs-action-btn"
                                    title={t('ocs_tariff_enable')}
                                    disabled={pendingAction === `enable:${planId}`}
                                    onClick={() => void handleAction('enable', planId)}
                                  >
                                    <Power size={14} />
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className="ocs-action-btn"
                                  title={t('ocs_tariff_clone')}
                                  disabled={pendingAction === `clone:${planId}`}
                                  onClick={() => void handleAction('clone', planId)}
                                >
                                  <Copy size={14} />
                                </button>
                                {!plan.isDefault && (
                                  <button
                                    type="button"
                                    className="ocs-action-btn ocs-action-danger"
                                    title={t('ocs_tariff_delete')}
                                    disabled={pendingAction === `delete:${planId}`}
                                    onClick={() => requestDelete(planId)}
                                  >
                                    <Trash2 size={14} />
                                  </button>
                                )}
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        }
        pagination={null}
      />
      {modalOpen && (
        <TariffPlanModal
          isOpen={modalOpen}
          plan={selectedPlanForEdit}
          onClose={() => {
            setModalOpen(false);
            setSelectedPlanForEdit(null);
          }}
          onSuccess={(result) => {
            setActionFeedback({ type: 'success', message: result.message });
            void refresh();
          }}
        />
      )}
      {confirmAction && (
        <ConfirmDialog
          title={t('ocs_confirm_danger_title')}
          message={t('ocs_confirm_danger_message').replace('{action}', confirmAction.action)}
          danger
          loading={Boolean(pendingAction)}
          onConfirm={() => void handleAction(confirmAction.action, confirmAction.planId)}
          onCancel={() => setConfirmAction(null)}
        />
      )}
    </>
  );
}
