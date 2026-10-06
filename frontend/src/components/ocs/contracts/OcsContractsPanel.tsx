/*
 * Forward-ported from the historical xCloud UI (reference commit 2c40903):
 * frontend/src/components/ocs/contracts/OcsContractsPanel.tsx
 *
 * Adaptations, all at the runtime and data boundary:
 *   - `"use client"` dropped; `@/` aliases replaced with relative imports.
 *   - the historical Next.js link component replaced by the React Router link (`href` -> `to`).
 *   - `useSWR(fetcher)` replaced by the current read client.
 *   - raw `fetch` actions replaced by the current mutation client.
 *   - `data.records` / `data.total` / `data.totalPages` read through the typed
 *     contract adapter instead of the raw envelope.
 *   - A manage-permission gate is applied, matching the current RBAC model.
 *
 * One deliberate deviation from the reference: the tariff-change action used
 * `window.prompt`, a blocking browser dialog that is neither accessible nor
 * keyboard-navigable. It is replaced by the inline plan picker the current app
 * already shipped, so no capability is lost and T22 accessibility holds. The
 * request is unchanged: `PATCH /api/ocs/subscribers/{imsi}` with `{ plan_id }`.
 *
 * Search, status filter, sortable headers, pagination and the four row actions
 * keep the reference DOM structure and class vocabulary.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeftRight, Eye, Pause, Play, Search, Trash2, Users } from 'lucide-react';
import { DataTablePagination } from '../../ui/DataTablePagination';
import { DataTableStateRow } from '../../ui/DataTableState';
import MetricStrip from '../../ui/MetricStrip';
import OcsPageShell from '../OcsPageShell';
import OcsStatusBadge from '../common/OcsStatusBadge';
import ConfirmDialog from '../common/ConfirmDialog';
import { useRead } from '../../../lib/api/use-read';
import { deleteJson, patchJson, postJson } from '../../../lib/api/mutation-client';
import { hasPermission } from '../../../lib/permissions';
import { useAuth } from '../../../providers/AuthProvider';
import { useI18n } from '../../../providers/I18nProvider';
import { toContractListViewModel, toTariffListViewModel } from '../../../features/ocs/ocs-view-models';

export default function OcsContractsPanel() {
  const { t } = useI18n();
  const { user } = useAuth();
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [sortField, setSortField] = useState('updated_at');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [confirmTerminate, setConfirmTerminate] = useState<string | null>(null);
  const [tariffTarget, setTariffTarget] = useState<{ imsi: string; planId: string } | null>(null);
  const [tariffDraft, setTariffDraft] = useState('');

  const canManage = hasPermission(user, 'ocs.plan.assign');

  const getAriaSort = (field: string): 'ascending' | 'descending' | undefined =>
    sortField === field ? (sortOrder === 'asc' ? 'ascending' : 'descending') : undefined;

  const url = useMemo(() => {
    const params = new URLSearchParams({
      page: String(page),
      limit: String(limit),
      imsi: search.trim(),
      status: statusFilter,
      sortField,
      sortOrder,
    });
    return `/api/ocs/subscribers?${params.toString()}`;
  }, [page, limit, search, statusFilter, sortField, sortOrder]);

  const { data, error, isLoading: loading, mutate: refresh } = useRead<unknown>(url);
  const tariffs = useRead<unknown>('/api/tariff-plans');

  const list = toContractListViewModel(data);
  const records = list.records;
  const total = list.total ?? 0;
  const planOptions = toTariffListViewModel(tariffs.data).records;

  const activeCount = records.filter((record) => record.status === 'active').length;
  const suspendedCount = records.filter((record) => record.status === 'suspended').length;

  const toggleSort = (field: string) => {
    if (sortField === field) {
      setSortOrder((previous) => (previous === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortOrder('desc');
    }
  };

  const executeAction = async (imsi: string, action: string, run: () => Promise<unknown>) => {
    const key = `${imsi}:${action}`;
    setActionLoading(key);
    setFeedback(null);
    try {
      await run();
      setFeedback({ type: 'success', message: t('ocs_contract_action_success') });
      await refresh();
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

  const handleTerminate = (imsi: string) => {
    setConfirmTerminate(imsi);
  };

  const requestChangeTariff = (imsi: string, currentPlanId: string | null) => {
    setTariffTarget({ imsi, planId: currentPlanId ?? '' });
    setTariffDraft(currentPlanId ?? '');
  };

  const handleChangeTariff = async () => {
    if (!tariffTarget) return;
    const nextPlanId = tariffDraft.trim();
    if (!nextPlanId || nextPlanId === tariffTarget.planId) {
      setTariffTarget(null);
      return;
    }
    const imsi = tariffTarget.imsi;
    setTariffTarget(null);
    await executeAction(imsi, 'change-tariff', () =>
      patchJson(`/api/ocs/subscribers/${encodeURIComponent(imsi)}`, { plan_id: nextPlanId }));
  };

  const formatTime = (iso: string | null) => {
    if (!iso) return '—';
    const parsed = new Date(iso);
    return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleString();
  };

  const kpiGrid = (
    <MetricStrip
      variant="cards"
      ariaLabel={t('ocs_contracts_title')}
      items={[
        { key: 'total', label: t('ocs_contract_total'), value: error ? '—' : total, icon: <Users size={20} /> },
        { key: 'active', label: t('ocs_contract_active'), value: error ? '—' : activeCount, icon: <Users size={20} /> },
        { key: 'suspended', label: t('ocs_contract_suspended'), value: error ? '—' : suspendedCount, icon: <Pause size={20} /> },
      ]}
    />
  );

  const controls = (
    <div className="ocs-controls-bar">
      <div className="ocs-search-group">
        <Search size={16} className="ocs-search-icon" />
        <input
          type="text"
          className="ocs-search-input"
          aria-label={t('ocs_contract_search_ph')}
          placeholder={t('ocs_contract_search_ph')}
          value={search}
          onChange={(event) => { setSearch(event.target.value); setPage(1); }}
        />
      </div>
      <div className="ocs-filters-group">
        <select
          className="ocs-select"
          aria-label={t('ocs_col_status')}
          value={statusFilter}
          onChange={(event) => { setStatusFilter(event.target.value); setPage(1); }}
        >
          <option value="">{t('ocs_filter_all_statuses')}</option>
          <option value="active">{t('status_active')}</option>
          <option value="suspended">{t('status_suspended')}</option>
          <option value="terminated">{t('ocs_contract_status_terminated')}</option>
        </select>
      </div>
    </div>
  );

  const tableContent = (
    <>
      {feedback && (
        <div className={feedback.type === 'success' ? 'ocs-feedback-success' : 'ocs-feedback-error'}>
          <span>{feedback.message}</span>
        </div>
      )}
      {error && (
        <div className="ocs-feedback-error ocs-feedback-spaced">
          <span>{error.message || t('ocs_load_failed')}</span>
        </div>
      )}
      <table className="ocs-table">
        <caption className="sr-only">{t('ocs_contracts_title')}</caption>
        <thead>
          <tr>
            <th data-column-priority="essential" className="ocs-th-sortable" aria-sort={getAriaSort('imsi')} onClick={() => toggleSort('imsi')}>
              IMSI {sortField === 'imsi' ? (sortOrder === 'asc' ? '↑' : '↓') : ''}
            </th>
            <th data-column-priority="essential">{t('ocs_contract_col_msisdn')}</th>
            <th data-column-priority="essential" className="ocs-th-sortable" aria-sort={getAriaSort('plan_id')} onClick={() => toggleSort('plan_id')}>
              {t('ocs_contract_col_tariff')} {sortField === 'plan_id' ? (sortOrder === 'asc' ? '↑' : '↓') : ''}
            </th>
            <th data-column-priority="essential" className="ocs-th-sortable" aria-sort={getAriaSort('status')} onClick={() => toggleSort('status')}>
              {t('ocs_contract_col_billing_status')} {sortField === 'status' ? (sortOrder === 'asc' ? '↑' : '↓') : ''}
            </th>
            <th data-column-priority="supplementary">{t('ocs_contract_col_created')}</th>
            <th data-column-priority="supplementary" className="ocs-th-sortable" aria-sort={getAriaSort('updated_at')} onClick={() => toggleSort('updated_at')}>
              {t('ocs_contract_col_last_change')} {sortField === 'updated_at' ? (sortOrder === 'asc' ? '↑' : '↓') : ''}
            </th>
            <th data-column-priority="essential">{t('actions')}</th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <DataTableStateRow colSpan={7} state="loading">{t('loading')}</DataTableStateRow>
          ) : error ? (
            <DataTableStateRow colSpan={7} state="error">{error.message || t('ocs_load_failed')}</DataTableStateRow>
          ) : records.length === 0 ? (
            <DataTableStateRow colSpan={7} state="empty">{t('no_data')}</DataTableStateRow>
          ) : (
            records.map((record) => {
              const imsi = record.imsi ?? '';
              return (
                <tr key={record.id ?? imsi}>
                  <td data-label="IMSI" data-column-priority="essential" className="ocs-imsi-cell"><code>{imsi}</code></td>
                  <td data-label={t('ocs_contract_col_msisdn')} data-column-priority="essential">{record.msisdn || '—'}</td>
                  <td data-label={t('ocs_contract_col_tariff')} data-column-priority="essential"><span className="ocs-plan-badge">{record.planId}</span></td>
                  <td data-label={t('ocs_contract_col_billing_status')} data-column-priority="essential"><OcsStatusBadge status={record.status ?? ''} /></td>
                  <td data-label={t('ocs_contract_col_created')} data-column-priority="supplementary" className="ocs-time-cell">{formatTime(record.createdAt)}</td>
                  <td data-label={t('ocs_contract_col_last_change')} data-column-priority="supplementary" className="ocs-time-cell">{formatTime(record.updatedAt)}</td>
                  <td data-label={t('actions')} data-column-priority="essential">
                    <div className="ocs-action-group">
                      <Link
                        className="ocs-action-btn"
                        title={t('ocs_contract_view_detail')}
                        to={`/ocs/contracts/${encodeURIComponent(imsi)}`}
                      >
                        <Eye size={14} />
                      </Link>
                      {canManage && (
                        <>
                          <button
                            type="button"
                            className="ocs-action-btn"
                            title={t('ocs_sub_action_change_tariff')}
                            disabled={actionLoading === `${imsi}:change-tariff`}
                            onClick={() => requestChangeTariff(imsi, record.planId)}
                          >
                            <ArrowLeftRight size={14} />
                          </button>
                          {record.status === 'active' ? (
                            <button
                              type="button"
                              className="ocs-action-btn"
                              title={t('ocs_sub_action_suspend')}
                              disabled={actionLoading === `${imsi}:suspend`}
                              onClick={() => void handleSuspend(imsi)}
                            >
                              <Pause size={14} />
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="ocs-action-btn"
                              title={t('ocs_sub_action_resume')}
                              disabled={actionLoading === `${imsi}:resume`}
                              onClick={() => void handleResume(imsi)}
                            >
                              <Play size={14} />
                            </button>
                          )}
                          <button
                            type="button"
                            className="ocs-action-btn ocs-action-danger"
                            title={t('ocs_sub_action_terminate')}
                            disabled={actionLoading === `${imsi}:terminate`}
                            onClick={() => handleTerminate(imsi)}
                          >
                            <Trash2 size={14} />
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
      totalPages={list.totalPages || 1}
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
      onPageChange={setPage}
      onPageSizeChange={(nextLimit: number) => {
        setLimit(nextLimit);
        setPage(1);
      }}
    />
  );

  return (
    <>
      <OcsPageShell
        eyebrow={t('nav_ocs')}
        title={t('ocs_contracts_title')}
        readonly={false}
        description={t('ocs_contracts_desc')}
        loading={loading}
        onRefresh={() => void refresh()}
        kpiGrid={kpiGrid}
        controls={controls}
        tableContent={tableContent}
        pagination={pagination}
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
              deleteJson(`/api/ocs/subscribers/${encodeURIComponent(imsi)}`));
          }}
          onCancel={() => setConfirmTerminate(null)}
        />
      )}
      {tariffTarget && (
        <div className="ocs-dialog-overlay" onClick={() => setTariffTarget(null)}>
          <div
            className="ocs-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="contract-tariff-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="ocs-dialog-header">
              <h3 id="contract-tariff-title">{t('ocs_sub_action_change_tariff')}</h3>
            </div>
            <div className="ocs-form-group">
              <label htmlFor="contract-tariff-select" className="ocs-form-label">
                {t('ocs_contract_col_tariff')}
              </label>
              <select
                id="contract-tariff-select"
                className="ocs-select"
                aria-label={t('ocs_contract_col_tariff')}
                value={tariffDraft}
                onChange={(event) => setTariffDraft(event.target.value)}
              >
                {planOptions.length === 0 && <option value={tariffDraft}>{tariffDraft}</option>}
                {planOptions.map((plan) => (
                  <option key={plan.planId ?? ''} value={plan.planId ?? ''}>{plan.name || plan.planId}</option>
                ))}
              </select>
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
                disabled={Boolean(actionLoading)}
              >
                {t('confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
