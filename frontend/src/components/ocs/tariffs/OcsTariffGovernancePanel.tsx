/*
 * Tariff plan governance surface (`/ocs/tariffs`).
 *
 * Forward-ported from the historical xCloud UI (reference commit 2c40903), then
 * reworked on the information-architecture level. The historical DOM, class
 * vocabulary and action order are preserved where they still carry meaning; what
 * changed is what the table actually says and what an operator can do from it:
 *
 *   - the "version" and "updated by" columns are gone. The plan projection never
 *     emits `version`, `created_by` or `updated_by`, so those two columns could
 *     only ever render `v1` and an em dash. They are replaced by the rule count,
 *     the data quota and the validity window, all of which the API does supply.
 *   - filtering and sorting moved to the URL, so a refresh or a bookmark keeps
 *     the operator's view. The unfiltered default keeps a single cache key.
 *   - delete is refused in the UI while contracts are still bound, with the
 *     reason stated on the control. The backend only protects the default plan,
 *     so this guard is the difference between a dangling `plan_id` and a clear
 *     refusal.
 *   - clone asks for the target identifier instead of inventing
 *     `{planId}_copy_{epoch}`.
 *   - export is exposed. `GET /api/tariff-plans/{planId}/export` has always been
 *     available and had no entry point.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  CheckCircle,
  Copy,
  Download,
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
import { SortableTableHeader } from '../../ui/SortableTableHeader';
import MetricStrip from '../../ui/MetricStrip';
import OcsPageShell from '../OcsPageShell';
import OcsStatusBadge from '../common/OcsStatusBadge';
import ConfirmDialog from '../common/ConfirmDialog';
import OcsSortIcon from '../common/OcsSortIcon';
import { OcsFilterSelect, OcsResetFilters, OcsSearchField, OcsToolbar } from '../common/OcsToolbar';
import TariffPlanModal from './TariffPlanModal';
import TariffCloneDialog from './TariffCloneDialog';
import { useRead } from '../../../lib/api/use-read';
import { deleteJson, postJson } from '../../../lib/api/mutation-client';
import { hasPermission } from '../../../lib/permissions';
import { useAuth } from '../../../providers/AuthProvider';
import { useI18n } from '../../../providers/I18nProvider';
import { toTariffListViewModel, type TariffPlanViewModel } from '../../../features/ocs/ocs-view-models';
import { downloadTariffPlanExport } from '../../../features/ocs/ocs-export';
import { formatOcsBytes, formatOcsDate, formatOcsSeconds } from '../../../features/ocs/ocs-format';
import { hasActiveOcsFilters, useOcsQueryState, type OcsQueryState } from '../../../features/ocs/use-ocs-query-state';

interface ActionFeedback {
  type: 'success' | 'error';
  message: string;
}

type TariffSortField = 'plan_id' | 'name' | 'subscriberCount' | 'rulesCount' | 'updatedAt';

const QUERY_DEFAULTS: OcsQueryState = {
  q: '',
  status: '',
  sort: 'plan_id',
  order: 'asc',
};

const SORT_FIELDS: TariffSortField[] = ['plan_id', 'name', 'subscriberCount', 'rulesCount', 'updatedAt'];

function readSortField(value: string): TariffSortField {
  return (SORT_FIELDS as string[]).includes(value) ? (value as TariffSortField) : 'plan_id';
}

function comparePlans(left: TariffPlanViewModel, right: TariffPlanViewModel, field: TariffSortField): number {
  if (field === 'updatedAt') {
    const leftTime = left.updatedAt ? Date.parse(left.updatedAt) : Number.NaN;
    const rightTime = right.updatedAt ? Date.parse(right.updatedAt) : Number.NaN;
    /* A plan without a timestamp sorts last in both directions: missing is not the smallest value. */
    if (Number.isNaN(leftTime) && Number.isNaN(rightTime)) return 0;
    if (Number.isNaN(leftTime)) return 1;
    if (Number.isNaN(rightTime)) return -1;
    return leftTime - rightTime;
  }
  if (field === 'subscriberCount' || field === 'rulesCount') {
    const leftValue = left[field] ?? -1;
    const rightValue = right[field] ?? -1;
    return leftValue - rightValue;
  }
  const leftText = (field === 'name' ? left.name ?? '' : left.planId ?? '').toLowerCase();
  const rightText = (field === 'name' ? right.name ?? '' : right.planId ?? '').toLowerCase();
  return leftText.localeCompare(rightText);
}

export default function OcsTariffGovernancePanel() {
  const { t } = useI18n();
  const { user } = useAuth();
  const [actionFeedback, setActionFeedback] = useState<ActionFeedback | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TariffPlanViewModel | null>(null);
  const [cloneSource, setCloneSource] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedPlanForEdit, setSelectedPlanForEdit] = useState<TariffPlanViewModel | null>(null);

  const canWrite = hasPermission(user, 'ocs.tariff.write');

  const { state, update, reset } = useOcsQueryState(QUERY_DEFAULTS);
  const query = state.q.trim().toLowerCase();
  const status = state.status;
  const sort = readSortField(state.sort);
  const order = state.order === 'desc' ? 'desc' : 'asc';

  const { data, error, isLoading: loading, mutate: refresh } = useRead<unknown>('/api/tariff-plans');

  const allPlans = toTariffListViewModel(data).records;

  const plans = useMemo(() => {
    const filtered = allPlans.filter((plan) => {
      if (status && plan.status !== status) return false;
      if (!query) return true;
      return (plan.planId ?? '').toLowerCase().includes(query)
        || (plan.name ?? '').toLowerCase().includes(query);
    });
    const direction = order === 'asc' ? 1 : -1;
    return [...filtered].sort((left, right) => {
      const primary = comparePlans(left, right, sort);
      if (primary !== 0) return primary * direction;
      return (left.planId ?? '').localeCompare(right.planId ?? '');
    });
  }, [allPlans, order, query, sort, status]);

  const activePlans = allPlans.filter((plan) => plan.status === 'active').length;
  const disabledPlans = allPlans.filter((plan) => plan.status === 'disabled').length;
  const totalSubscribers = allPlans.reduce((sum, plan) => sum + (plan.subscriberCount ?? 0), 0);
  const filtersActive = hasActiveOcsFilters(state, QUERY_DEFAULTS);

  const setSort = (field: TariffSortField) => {
    if (sort === field) update({ order: order === 'asc' ? 'desc' : 'asc' });
    else update({ sort: field, order: field === 'updatedAt' || field === 'subscriberCount' ? 'desc' : 'asc' });
  };

  const handleAction = async (action: string, planId: string) => {
    const actionKey = `${action}:${planId}`;
    setPendingAction(actionKey);
    setActionFeedback(null);
    setDeleteTarget(null);

    try {
      if (action === 'enable') {
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
    } catch (failure) {
      setActionFeedback({
        type: 'error',
        message: failure instanceof Error ? failure.message : t('ocs_tariff_action_failed'),
      });
    } finally {
      setPendingAction(null);
    }
  };

  const handleClone = async (targetPlanId: string) => {
    if (!cloneSource) return;
    const actionKey = `clone:${cloneSource}`;
    setPendingAction(actionKey);
    setActionFeedback(null);
    try {
      await postJson(`/api/tariff-plans/${encodeURIComponent(cloneSource)}/clone`, { target_plan_id: targetPlanId });
      setActionFeedback({ type: 'success', message: t('ocs_tariff_action_success') });
      await refresh();
    } catch (failure) {
      setActionFeedback({
        type: 'error',
        message: failure instanceof Error ? failure.message : t('ocs_tariff_action_failed'),
      });
      throw failure;
    } finally {
      setPendingAction(null);
    }
  };

  const handleExport = async (planId: string) => {
    setActionFeedback(null);
    try {
      await downloadTariffPlanExport(planId);
    } catch (failure) {
      setActionFeedback({
        type: 'error',
        message: failure instanceof Error ? failure.message : t('ocs_tariff_action_failed'),
      });
    }
  };

  const kpiGrid = (
    <MetricStrip
      variant="strip"
      ariaLabel={t('ocs_tariffs_title')}
      items={[
        { key: 'plans', label: t('ocs_tariff_total_plans'), value: allPlans.length, icon: <FileText size={20} /> },
        { key: 'active', label: t('ocs_tariff_active_plans'), value: activePlans, icon: <CheckCircle size={20} /> },
        { key: 'disabled', label: t('ocs_tariff_disabled_plans'), value: disabledPlans, icon: <XCircle size={20} /> },
        { key: 'subscribers', label: t('ocs_tariff_total_subscribers'), value: totalSubscribers, icon: <FileText size={20} /> },
      ]}
    />
  );

  const controls = (
    <OcsToolbar
      actions={(
        <>
          <OcsResetFilters active={filtersActive} onReset={reset} label={t('ocs_filters_reset')} />
          {canWrite && (
            <button
              type="button"
              className="ocs-btn ocs-btn-primary"
              onClick={() => {
                setSelectedPlanForEdit(null);
                setModalOpen(true);
              }}
            >
              <Plus size={16} aria-hidden="true" />
              <span>{t('ocs_tariff_create')}</span>
            </button>
          )}
        </>
      )}
    >
      <OcsSearchField
        value={state.q}
        onCommit={(value) => update({ q: value })}
        label={t('ocs_search_tariff')}
        placeholder={t('ocs_search_tariff')}
      />
      <OcsFilterSelect
        label={t('ocs_filter_status')}
        value={status}
        onChange={(value) => update({ status: value })}
        options={[
          { value: '', label: t('ocs_filter_all') },
          { value: 'active', label: t('ocs_status_active') },
          { value: 'disabled', label: t('ocs_status_disabled') },
        ]}
      />
    </OcsToolbar>
  );

  const tableContent = (
    <>
      {actionFeedback && (
        <div className={actionFeedback.type === 'success' ? 'ocs-feedback-success' : 'ocs-feedback-error'}>
          <span>{actionFeedback.message}</span>
        </div>
      )}
      {error && (
        <div className="ocs-feedback-error ocs-feedback-spaced" role="alert">
          <span>{t('ocs_detail_load_failed')}</span>
        </div>
      )}
      <div className="ocs-table-wrap">
        <table className="ocs-table">
          <caption className="sr-only">{t('ocs_tariffs_title')}</caption>
          <thead>
            <tr>
              <SortableTableHeader
                label={t('ocs_tariff_col_plan_id')}
                active={sort === 'plan_id'}
                direction={order}
                icon={<OcsSortIcon active={sort === 'plan_id'} direction={order} />}
                onSort={() => setSort('plan_id')}
              />
              <SortableTableHeader
                label={t('ocs_tariff_col_name')}
                active={sort === 'name'}
                direction={order}
                icon={<OcsSortIcon active={sort === 'name'} direction={order} />}
                onSort={() => setSort('name')}
              />
              <th data-column-priority="essential">{t('ocs_tariff_col_status')}</th>
              <SortableTableHeader
                label={t('ocs_tariff_col_rules')}
                active={sort === 'rulesCount'}
                direction={order}
                icon={<OcsSortIcon active={sort === 'rulesCount'} direction={order} />}
                onSort={() => setSort('rulesCount')}
                priority="important"
              />
              <th data-column-priority="important">{t('ocs_tariff_col_quota')}</th>
              <th data-column-priority="supplementary">{t('ocs_tariff_col_validity')}</th>
              <SortableTableHeader
                label={t('ocs_tariff_col_subscribers')}
                active={sort === 'subscriberCount'}
                direction={order}
                icon={<OcsSortIcon active={sort === 'subscriberCount'} direction={order} />}
                onSort={() => setSort('subscriberCount')}
                priority="important"
              />
              <SortableTableHeader
                label={t('ocs_tariff_col_updated')}
                active={sort === 'updatedAt'}
                direction={order}
                icon={<OcsSortIcon active={sort === 'updatedAt'} direction={order} />}
                onSort={() => setSort('updatedAt')}
                priority="supplementary"
              />
              <th data-column-priority="essential">{t('ocs_tariff_col_actions')}</th>
            </tr>
          </thead>
          <tbody>
            {loading && allPlans.length === 0 ? (
              <DataTableStateRow colSpan={9} state="loading">{t('loading')}</DataTableStateRow>
            ) : plans.length === 0 ? (
              <DataTableStateRow colSpan={9} state="empty">
                {filtersActive ? t('ocs_empty_filtered') : t('no_data')}
              </DataTableStateRow>
            ) : (
              plans.map((plan) => {
                const planId = plan.planId ?? '';
                const boundCount = plan.subscriberCount ?? 0;
                const deleteBlocked = boundCount > 0;
                return (
                  <tr key={planId}>
                    <td data-label={t('ocs_tariff_col_plan_id')} data-column-priority="essential" className="ocs-mono">{planId}</td>
                    <td data-label={t('ocs_tariff_col_name')} data-column-priority="essential">{plan.name}</td>
                    <td data-label={t('ocs_tariff_col_status')} data-column-priority="essential">
                      <span className="ocs-status-cluster">
                        <OcsStatusBadge status={plan.status ?? ''} />
                        {plan.isDefault ? (
                          <span className="ocs-default-badge">{t('ocs_tariff_default_badge')}</span>
                        ) : null}
                      </span>
                    </td>
                    <td data-label={t('ocs_tariff_col_rules')} data-column-priority="important" className="ocs-mono">{plan.rulesCount ?? 0}</td>
                    <td data-label={t('ocs_tariff_col_quota')} data-column-priority="important" className="ocs-mono">{formatOcsBytes(plan.quotaPerGrant)}</td>
                    <td data-label={t('ocs_tariff_col_validity')} data-column-priority="supplementary" className="ocs-mono">{formatOcsSeconds(plan.validityTime)}</td>
                    <td data-label={t('ocs_tariff_col_subscribers')} data-column-priority="important">{boundCount}</td>
                    <td data-label={t('ocs_tariff_col_updated')} data-column-priority="supplementary" className="ocs-time-cell">
                      <span title={plan.updatedAt ?? undefined}>{formatOcsDate(plan.updatedAt)}</span>
                    </td>
                    <td data-label={t('ocs_tariff_col_actions')} data-column-priority="essential">
                      <div className="ocs-action-group">
                        <Link
                          className="ocs-action-btn"
                          title={t('ocs_tariff_view_detail')}
                          aria-label={t('ocs_tariff_view_detail')}
                          to={`/ocs/tariffs/${encodeURIComponent(planId)}`}
                        >
                          <Eye size={14} aria-hidden="true" />
                        </Link>
                        <button
                          type="button"
                          className="ocs-action-btn"
                          title={t('ocs_tariff_export')}
                          aria-label={t('ocs_tariff_export')}
                          onClick={() => void handleExport(planId)}
                        >
                          <Download size={14} aria-hidden="true" />
                        </button>
                        {canWrite && (
                          <>
                            <button
                              type="button"
                              className="ocs-action-btn"
                              title={t('ocs_tariff_edit')}
                              aria-label={t('ocs_tariff_edit')}
                              onClick={() => {
                                setSelectedPlanForEdit(plan);
                                setModalOpen(true);
                              }}
                            >
                              <Pencil size={14} aria-hidden="true" />
                            </button>
                            {plan.status === 'active' ? (
                              <button
                                type="button"
                                className="ocs-action-btn"
                                title={t('ocs_tariff_disable')}
                                aria-label={t('ocs_tariff_disable')}
                                disabled={pendingAction === `disable:${planId}`}
                                onClick={() => void handleAction('disable', planId)}
                              >
                                <PowerOff size={14} aria-hidden="true" />
                              </button>
                            ) : (
                              <button
                                type="button"
                                className="ocs-action-btn"
                                title={t('ocs_tariff_enable')}
                                aria-label={t('ocs_tariff_enable')}
                                disabled={pendingAction === `enable:${planId}`}
                                onClick={() => void handleAction('enable', planId)}
                              >
                                <Power size={14} aria-hidden="true" />
                              </button>
                            )}
                            <button
                              type="button"
                              className="ocs-action-btn"
                              title={t('ocs_tariff_clone')}
                              aria-label={t('ocs_tariff_clone')}
                              disabled={pendingAction === `clone:${planId}`}
                              onClick={() => setCloneSource(planId)}
                            >
                              <Copy size={14} aria-hidden="true" />
                            </button>
                            {!plan.isDefault && (
                              <button
                                type="button"
                                className="ocs-action-btn ocs-action-danger"
                                title={deleteBlocked
                                  ? t('ocs_tariff_delete_in_use', { count: boundCount })
                                  : t('ocs_tariff_delete')}
                                aria-label={deleteBlocked
                                  ? t('ocs_tariff_delete_in_use', { count: boundCount })
                                  : t('ocs_tariff_delete')}
                                disabled={deleteBlocked || pendingAction === `delete:${planId}`}
                                onClick={() => setDeleteTarget(plan)}
                              >
                                <Trash2 size={14} aria-hidden="true" />
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </>
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
        controls={controls}
        tableContent={tableContent}
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
      <TariffCloneDialog
        open={Boolean(cloneSource)}
        sourcePlanId={cloneSource ?? ''}
        onClose={() => setCloneSource(null)}
        onClone={handleClone}
      />
      {deleteTarget && (
        <ConfirmDialog
          title={t('ocs_tariff_delete_title')}
          message={t('ocs_tariff_delete_message', {
            planId: deleteTarget.planId ?? '',
            name: deleteTarget.name ?? '',
          })}
          confirmLabel={t('ocs_tariff_delete')}
          danger
          loading={Boolean(pendingAction)}
          onConfirm={() => void handleAction('delete', deleteTarget.planId ?? '')}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </>
  );
}
