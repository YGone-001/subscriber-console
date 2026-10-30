/*
 * Charging contract surface (`/ocs/contracts`).
 *
 * A contract is the charging-side binding of a subscriber: tariff plan plus
 * lifecycle status. The historical panel listed it but could not create one,
 * counted only the current page in the KPI strip, advertised an extra empty page
 * whenever the total was an exact multiple of the page size, offered a
 * "resume" action on terminated contracts, and let an operator pick a disabled
 * plan only to have the write rejected. Creation now opens the shared
 * insert-only provisioning dialog for an existing subscriber.
 *
 * This rewrite keeps the same endpoints and request bodies:
 *
 *   - KPI counts are collection-wide. `total` comes from the list envelope and
 *     the per-status counts come from three bounded `limit=1` reads, because the
 *     contract list envelope has no `summary` block and this change must not
 *     alter the read contract.
 *   - the pager count is derived from `total` rather than trusted from
 *     `totalPages` (the server answers `floor(total/limit) + 1`).
 *   - a terminated contract exposes read-only actions only. `POST /resume` on a
 *     terminated contract would otherwise move it back to `active`.
 *   - the tariff picker lists active plans plus the contract's current plan, and
 *     shows the plan name with its quota, so the operator sees what they choose.
 *   - page, filters and sort live in the URL.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeftRight, Copy, Eye, Pause, Play, Plus, Trash2, Users } from 'lucide-react';
import { DataTablePagination } from '../../ui/DataTablePagination';
import { DataTableStateRow } from '../../ui/DataTableState';
import { SortableTableHeader } from '../../ui/SortableTableHeader';
import { Dialog } from '../../ui/Dialog';
import MetricStrip from '../../ui/MetricStrip';
import OcsPageShell from '../OcsPageShell';
import OcsStatusBadge from '../common/OcsStatusBadge';
import ConfirmDialog from '../common/ConfirmDialog';
import CreateContractDialog from './CreateContractDialog';
import OcsSortIcon from '../common/OcsSortIcon';
import { OcsFilterSelect, OcsResetFilters, OcsSearchField, OcsToolbar } from '../common/OcsToolbar';
import { useRead } from '../../../lib/api/use-read';
import { patchJson, postJson } from '../../../lib/api/mutation-client';
import { hasPermission } from '../../../lib/permissions';
import { useAuth } from '../../../providers/AuthProvider';
import { useI18n } from '../../../providers/I18nProvider';
import { copyText } from '../../../lib/clipboard';
import {
  toContractListViewModel,
  toOcsPageViewModel,
  toTariffListViewModel,
  type OcsContractViewModel,
  type TariffPlanViewModel,
} from '../../../features/ocs/ocs-view-models';
import { formatOcsBytes, formatOcsTime, pageCountFor, sanitizeImsiInput } from '../../../features/ocs/ocs-format';
import { hasActiveOcsFilters, useOcsQueryState, type OcsQueryState } from '../../../features/ocs/use-ocs-query-state';

type ContractSortField = 'imsi' | 'plan_id' | 'status' | 'updated_at';

const QUERY_DEFAULTS: OcsQueryState = {
  q: '',
  status: '',
  plan: '',
  sort: 'updated_at',
  order: 'desc',
  page: '1',
  limit: '20',
};

const SORT_FIELDS: ContractSortField[] = ['imsi', 'plan_id', 'status', 'updated_at'];

function readSortField(value: string): ContractSortField {
  return (SORT_FIELDS as string[]).includes(value) ? (value as ContractSortField) : 'updated_at';
}

function statusCount(data: unknown): number | null {
  return toOcsPageViewModel(data).total;
}

export default function OcsContractsPanel() {
  const { t } = useI18n();
  const { user } = useAuth();
  const canManage = hasPermission(user, 'ocs.plan.assign');

  const { state, update, reset } = useOcsQueryState(QUERY_DEFAULTS);
  const page = Math.max(1, Number.parseInt(state.page, 10) || 1);
  const limit = Math.max(1, Math.min(100, Number.parseInt(state.limit, 10) || 20));
  const sort = readSortField(state.sort);
  const order = state.order === 'asc' ? 'asc' : 'desc';

  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [copiedImsi, setCopiedImsi] = useState<string | null>(null);
  const [confirmTerminate, setConfirmTerminate] = useState<string | null>(null);
  const [tariffTarget, setTariffTarget] = useState<OcsContractViewModel | null>(null);
  const [tariffDraft, setTariffDraft] = useState('');
  const [isCreateOpen, setIsCreateOpen] = useState(false);

  const url = useMemo(() => {
    const params = new URLSearchParams({
      page: String(page),
      limit: String(limit),
      imsi: state.q.trim(),
      status: state.status,
      planId: state.plan,
      sortField: sort,
      sortOrder: order,
    });
    return `/api/ocs/subscribers?${params.toString()}`;
  }, [limit, order, page, sort, state.plan, state.q, state.status]);

  const { data, error, isLoading: loading, mutate: refresh } = useRead<unknown>(url);
  const { data: tariffs } = useRead<unknown>('/api/tariff-plans');
  /* Four bounded counts, one per lifecycle state. The list envelope carries no
   * summary block, and this change must not alter the read contract, so the KPI
   * strip is fed by `limit=1` reads rather than by the current page's rows. */
  const allRead = useRead<unknown>('/api/ocs/subscribers?page=1&limit=1');
  const activeRead = useRead<unknown>('/api/ocs/subscribers?status=active&page=1&limit=1');
  const suspendedRead = useRead<unknown>('/api/ocs/subscribers?status=suspended&page=1&limit=1');
  const terminatedRead = useRead<unknown>('/api/ocs/subscribers?status=terminated&page=1&limit=1');

  const list = toContractListViewModel(data);
  const records = list.records;
  const total = list.total ?? 0;
  const totalPages = pageCountFor(total, limit);
  const filtersActive = hasActiveOcsFilters(state, QUERY_DEFAULTS);

  const plans = useMemo<TariffPlanViewModel[]>(() => toTariffListViewModel(tariffs).records, [tariffs]);
  const planById = useMemo(() => {
    const map = new Map<string, TariffPlanViewModel>();
    for (const plan of plans) if (plan.planId) map.set(plan.planId, plan);
    return map;
  }, [plans]);

  /*
   * Two option lists on purpose: the filter offers "all plans" plus every plan,
   * while the reassignment dialog must never offer an empty choice or a disabled
   * plan (the API rejects a disabled plan with OCS_TARIFF_DISABLED).
   */
  const activePlanOptions = useMemo(() => {
    return plans
      .filter((plan) => plan.status === 'active' || plan.planId === tariffTarget?.planId)
      .sort((left, right) => (left.name ?? '').localeCompare(right.name ?? ''))
      .map((plan) => ({
        value: plan.planId ?? '',
        label: `${plan.name || plan.planId} \u00b7 ${formatOcsBytes(plan.quotaPerGrant)}`,
      }));
  }, [plans, tariffTarget?.planId]);

  const planFilterOptions = useMemo(() => {
    const options = plans
      .slice()
      .sort((left, right) => (left.name ?? '').localeCompare(right.name ?? ''))
      .map((plan) => ({ value: plan.planId ?? '', label: plan.name || plan.planId || '' }));
    return [{ value: '', label: t('ocs_filter_all_plans') }, ...options];
  }, [plans, t]);

  const toggleSort = (field: ContractSortField) => {
    if (sort === field) update({ order: order === 'asc' ? 'desc' : 'asc', page: '1' });
    else update({ sort: field, order: field === 'updated_at' ? 'desc' : 'asc', page: '1' });
  };

  const applyStatusFilter = (status: string) => {
    update({ status: state.status === status ? '' : status, page: '1' });
  };

  const handleCopyImsi = async (imsi: string) => {
    if (!(await copyText(imsi))) return;
    setCopiedImsi(imsi);
    window.setTimeout(() => setCopiedImsi((current) => (current === imsi ? null : current)), 1400);
  };

  const executeAction = async (imsi: string, action: string, run: () => Promise<unknown>) => {
    const key = `${imsi}:${action}`;
    setActionLoading(key);
    setFeedback(null);
    try {
      await run();
      setFeedback({ type: 'success', message: t('ocs_contract_action_success') });
      await refresh();
      await Promise.all([allRead.mutate(), activeRead.mutate(), suspendedRead.mutate(), terminatedRead.mutate()]);
    } catch (failure) {
      setFeedback({
        type: 'error',
        message: failure instanceof Error ? failure.message : t('ocs_sub_action_network_error'),
      });
    } finally {
      setActionLoading(null);
    }
  };

  const handleSuspend = (imsi: string) =>
    executeAction(imsi, 'suspend', () => postJson(`/api/ocs/subscribers/${encodeURIComponent(imsi)}/suspend`));

  const handleResume = (imsi: string) =>
    executeAction(imsi, 'resume', () => postJson(`/api/ocs/subscribers/${encodeURIComponent(imsi)}/resume`));

  const requestChangeTariff = (record: OcsContractViewModel) => {
    setTariffTarget(record);
    setTariffDraft(record.planId ?? '');
  };

  const handleChangeTariff = async () => {
    if (!tariffTarget) return;
    const nextPlanId = tariffDraft.trim();
    const imsi = tariffTarget.imsi ?? '';
    setTariffTarget(null);
    if (!nextPlanId || nextPlanId === tariffTarget.planId || !imsi) return;
    await executeAction(imsi, 'change-tariff', () =>
      patchJson(`/api/ocs/subscribers/${encodeURIComponent(imsi)}`, { plan_id: nextPlanId }));
  };

  const kpiGrid = (
    <MetricStrip
      variant="strip"
      ariaLabel={t('ocs_contracts_title')}
      items={[
        {
          key: 'all',
          label: t('ocs_filter_all'),
          value: error ? '\u2014' : statusCount(allRead.data) ?? total,
          icon: <Users size={20} />,
          active: state.status === '',
          onClick: () => update({ status: '', page: '1' }),
          ariaLabel: t('ocs_filter_all'),
        },
        {
          key: 'active',
          label: t('ocs_contract_active'),
          value: error ? '\u2014' : statusCount(activeRead.data) ?? '\u2014',
          icon: <Users size={20} />,
          active: state.status === 'active',
          onClick: () => applyStatusFilter('active'),
          ariaLabel: t('ocs_contract_active'),
        },
        {
          key: 'suspended',
          label: t('ocs_contract_suspended'),
          value: error ? '\u2014' : statusCount(suspendedRead.data) ?? '\u2014',
          icon: <Pause size={20} />,
          active: state.status === 'suspended',
          onClick: () => applyStatusFilter('suspended'),
          ariaLabel: t('ocs_contract_suspended'),
        },
        {
          key: 'terminated',
          label: t('ocs_contract_status_terminated'),
          value: error ? '\u2014' : statusCount(terminatedRead.data) ?? '\u2014',
          icon: <Play size={20} />,
          active: state.status === 'terminated',
          onClick: () => applyStatusFilter('terminated'),
          ariaLabel: t('ocs_contract_status_terminated'),
        },
      ]}
    />
  );

  const controls = (
    <OcsToolbar
      actions={
        <>
          {canManage ? (
            <button type="button" className="ocs-btn ocs-btn-primary ocs-btn-compact-auto" onClick={() => setIsCreateOpen(true)}>
              <Plus size={14} aria-hidden="true" /> {t('ocs_contract_create_action')}
            </button>
          ) : null}
          <OcsResetFilters active={filtersActive} onReset={reset} label={t('ocs_filters_reset')} />
        </>
      }
    >
      <OcsSearchField
        value={state.q}
        onCommit={(value) => update({ q: value, page: '1' })}
        label={t('ocs_search_imsi')}
        placeholder={t('ocs_search_imsi')}
        normalize={sanitizeImsiInput}
      />
      <OcsFilterSelect
        label={t('ocs_filter_status')}
        value={state.status}
        onChange={(value) => update({ status: value, page: '1' })}
        options={[
          { value: '', label: t('ocs_filter_all') },
          { value: 'active', label: t('ocs_status_active') },
          { value: 'suspended', label: t('ocs_status_suspended') },
          { value: 'terminated', label: t('ocs_contract_status_terminated') },
        ]}
      />
      <OcsFilterSelect
        label={t('ocs_filter_plan')}
        value={state.plan}
        onChange={(value) => update({ plan: value, page: '1' })}
        options={planFilterOptions}
      />
    </OcsToolbar>
  );

  const tableContent = (
    <>
      {feedback && (
        <div className={feedback.type === 'success' ? 'ocs-feedback-success' : 'ocs-feedback-error'}>
          <span>{feedback.message}</span>
        </div>
      )}
      {error && (
        <div className="ocs-feedback-error ocs-feedback-spaced" role="alert">
          <span>{error.message || t('ocs_detail_load_failed')}</span>
        </div>
      )}
      <table className="ocs-table">
        <caption className="sr-only">{t('ocs_contracts_title')}</caption>
        <thead>
          <tr>
            <SortableTableHeader
              label="IMSI"
              active={sort === 'imsi'}
              direction={order}
              icon={<OcsSortIcon active={sort === 'imsi'} direction={order} />}
              onSort={() => toggleSort('imsi')}
            />
            <th data-column-priority="essential">{t('ocs_contract_col_msisdn')}</th>
            <SortableTableHeader
              label={t('ocs_contract_col_tariff')}
              active={sort === 'plan_id'}
              direction={order}
              icon={<OcsSortIcon active={sort === 'plan_id'} direction={order} />}
              onSort={() => toggleSort('plan_id')}
            />
            <SortableTableHeader
              label={t('ocs_contract_col_billing_status')}
              active={sort === 'status'}
              direction={order}
              icon={<OcsSortIcon active={sort === 'status'} direction={order} />}
              onSort={() => toggleSort('status')}
            />
            <th data-column-priority="supplementary">{t('ocs_contract_col_created')}</th>
            <SortableTableHeader
              label={t('ocs_contract_col_last_change')}
              active={sort === 'updated_at'}
              direction={order}
              icon={<OcsSortIcon active={sort === 'updated_at'} direction={order} />}
              onSort={() => toggleSort('updated_at')}
              priority="supplementary"
            />
            <th data-column-priority="essential">{t('actions')}</th>
          </tr>
        </thead>
        <tbody>
          {loading && records.length === 0 ? (
            <DataTableStateRow colSpan={7} state="loading">{t('loading')}</DataTableStateRow>
          ) : records.length === 0 ? (
            <DataTableStateRow colSpan={7} state="empty">
              {filtersActive ? t('ocs_empty_filtered') : t('no_data')}
            </DataTableStateRow>
          ) : (
            records.map((record) => {
              const imsi = record.imsi ?? '';
              const terminated = record.status === 'terminated';
              const plan = record.planId ? planById.get(record.planId) : undefined;
              return (
                <tr key={record.id ?? imsi}>
                  <td data-label="IMSI" data-column-priority="essential" className="ocs-imsi-cell">
                    <code>{imsi}</code>
                    <button
                      type="button"
                      className={copiedImsi === imsi ? 'copy-btn copied' : 'copy-btn'}
                      onClick={() => void handleCopyImsi(imsi)}
                      title={t('sub_copy_imsi')}
                      aria-label={`${t('sub_copy_imsi')} ${imsi}`}
                    >
                      <Copy size={12} aria-hidden="true" />
                    </button>
                  </td>
                  <td data-label={t('ocs_contract_col_msisdn')} data-column-priority="essential">{record.msisdn || '\u2014'}</td>
                  <td data-label={t('ocs_contract_col_tariff')} data-column-priority="essential">
                    <Link className="ocs-plan-badge" to={`/ocs/tariffs/${encodeURIComponent(record.planId ?? '')}`}>
                      {plan?.name || record.planId}
                    </Link>
                  </td>
                  <td data-label={t('ocs_contract_col_billing_status')} data-column-priority="essential"><OcsStatusBadge status={record.status ?? ''} /></td>
                  <td data-label={t('ocs_contract_col_created')} data-column-priority="supplementary" className="ocs-time-cell">{formatOcsTime(record.createdAt)}</td>
                  <td data-label={t('ocs_contract_col_last_change')} data-column-priority="supplementary" className="ocs-time-cell">{formatOcsTime(record.updatedAt)}</td>
                  <td data-label={t('actions')} data-column-priority="essential">
                    <div className="ocs-action-group">
                      <Link
                        className="ocs-action-btn"
                        title={t('ocs_contract_view_detail')}
                        aria-label={t('ocs_contract_view_detail')}
                        to={`/ocs/contracts/${encodeURIComponent(imsi)}`}
                      >
                        <Eye size={14} aria-hidden="true" />
                      </Link>
                      {canManage && !terminated && (
                        <>
                          <button
                            type="button"
                            className="ocs-action-btn"
                            title={t('ocs_sub_action_change_tariff')}
                            aria-label={t('ocs_sub_action_change_tariff')}
                            disabled={actionLoading === `${imsi}:change-tariff`}
                            onClick={() => requestChangeTariff(record)}
                          >
                            <ArrowLeftRight size={14} aria-hidden="true" />
                          </button>
                          {record.status === 'active' ? (
                            <button
                              type="button"
                              className="ocs-action-btn"
                              title={t('ocs_sub_action_suspend')}
                              aria-label={t('ocs_sub_action_suspend')}
                              disabled={actionLoading === `${imsi}:suspend`}
                              onClick={() => void handleSuspend(imsi)}
                            >
                              <Pause size={14} aria-hidden="true" />
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="ocs-action-btn"
                              title={t('ocs_sub_action_resume')}
                              aria-label={t('ocs_sub_action_resume')}
                              disabled={actionLoading === `${imsi}:resume`}
                              onClick={() => void handleResume(imsi)}
                            >
                              <Play size={14} aria-hidden="true" />
                            </button>
                          )}
                          <button
                            type="button"
                            className="ocs-action-btn ocs-action-danger"
                            title={t('ocs_sub_action_terminate')}
                            aria-label={t('ocs_sub_action_terminate')}
                            disabled={actionLoading === `${imsi}:terminate`}
                            onClick={() => setConfirmTerminate(imsi)}
                          >
                            <Trash2 size={14} aria-hidden="true" />
                          </button>
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
    </>
  );

  const pagination = (
    <DataTablePagination
      page={page}
      totalPages={totalPages}
      total={total}
      pageSize={limit}
      visibleCount={records.length}
      labels={{
        showing: t('showing'),
        to: t('to'),
        of: t('of'),
        entries: t('entries'),
        previous: t('prev'),
        next: t('next'),
        perPage: t('per_page'),
      }}
      onPageChange={(nextPage) => update({ page: String(nextPage) })}
      onPageSizeChange={(nextLimit) => update({ limit: String(nextLimit), page: '1' })}
    />
  );

  const selectedPlan = tariffDraft ? planById.get(tariffDraft) : undefined;
  const tariffUnchanged = !tariffDraft || tariffDraft === tariffTarget?.planId;

  return (
    <>
      <OcsPageShell
        eyebrow={t('nav_ocs')}
        title={t('ocs_contracts_title')}
        readonly={false}
        description={t('ocs_contracts_desc')}
        loading={loading}
        onRefresh={() => {
          void refresh();
          void allRead.mutate();
          void activeRead.mutate();
          void suspendedRead.mutate();
          void terminatedRead.mutate();
        }}
        kpiGrid={kpiGrid}
        controls={controls}
        tableContent={tableContent}
        pagination={pagination}
      />
      <CreateContractDialog
        open={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        onCreated={(imsi, balanceAdopted) => {
          setIsCreateOpen(false);
          setFeedback({
            type: 'success',
            message: t(balanceAdopted ? 'ocs_contract_create_success_adopted' : 'ocs_contract_create_success', { imsi }),
          });
          void refresh();
          void allRead.mutate();
          void activeRead.mutate();
          void suspendedRead.mutate();
          void terminatedRead.mutate();
        }}
      />
      {confirmTerminate && (
        <ConfirmDialog
          title={t('ocs_confirm_terminate_title')}
          message={t('ocs_sub_confirm_terminate').replace('{imsi}', confirmTerminate)}
          confirmLabel={t('ocs_sub_action_terminate')}
          danger
          loading={Boolean(actionLoading)}
          onConfirm={() => {
            const imsi = confirmTerminate;
            setConfirmTerminate(null);
            void executeAction(imsi, 'terminate', () =>
              patchJson(`/api/ocs/subscribers/${encodeURIComponent(imsi)}`, { status: 'terminated' }));
          }}
          onCancel={() => setConfirmTerminate(null)}
        />
      )}
      <Dialog
        open={Boolean(tariffTarget)}
        onClose={() => setTariffTarget(null)}
        className="ocs-dialog"
        overlayClassName="ocs-dialog-overlay"
        labelledBy="contract-tariff-title"
      >
        <div className="ocs-dialog-header">
          <h3 id="contract-tariff-title">{t('ocs_sub_action_change_tariff')}</h3>
        </div>
        <p className="ocs-dialog-copy">
          {t('ocs_contract_col_tariff')}: <code className="ocs-mono">{tariffTarget?.planId ?? '\u2014'}</code>
        </p>
        <div className="ocs-form-group">
          <label htmlFor="contract-tariff-select" className="ocs-form-label">
            {t('ocs_filter_plan')}
          </label>
          <select
            id="contract-tariff-select"
            className="ocs-select"
            value={tariffDraft}
            onChange={(event) => setTariffDraft(event.target.value)}
          >
            {activePlanOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          {selectedPlan ? (
            <span className="ocs-form-hint">
              {t('ocs_tariff_col_quota')}: {formatOcsBytes(selectedPlan.quotaPerGrant)}
            </span>
          ) : null}
        </div>
        <div className="ocs-dialog-actions">
          <button
            type="button"
            className="ocs-btn ocs-btn-secondary"
            onClick={() => setTariffTarget(null)}
            disabled={Boolean(actionLoading)}
          >
            {t('cancel')}
          </button>
          <button
            type="button"
            className="ocs-btn ocs-btn-primary"
            onClick={() => void handleChangeTariff()}
            disabled={Boolean(actionLoading) || tariffUnchanged}
          >
            {t('confirm')}
          </button>
        </div>
      </Dialog>
    </>
  );
}
