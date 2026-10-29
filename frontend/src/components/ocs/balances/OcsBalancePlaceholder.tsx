/*
 * Balance management surface (`/ocs/balances`).
 *
 * Reworked from the historical forward port. The write path and the read
 * contract are unchanged; what changed is what the page is allowed to claim:
 *
 *   - the page no longer carries the "strictly read-only" banner. It never was:
 *     `ocs.balance.adjust` has always been writable from this surface, and a
 *     read-only notice directly above an adjustment button is a contradiction an
 *     operator has to resolve by guessing.
 *   - the KPI strip reports the whole collection from the `summary` block the
 *     endpoint already returns, instead of counting the rows on screen.
 *   - a missing measurement renders as an em dash. The previous `?? 0` turned
 *     "not reported" into "0 B available", which is indistinguishable from an
 *     exhausted bucket.
 *   - the invariant column exposes the conservation check that silently blocks an
 *     adjustment; the status is tri-state, so an unreported check never reads as
 *     a mismatch.
 *   - page, filters and sort live in the URL, and the IMSI box only accepts
 *     digits: the value reaches a database regular expression, so a metacharacter
 *     either widens the search or fails the request outright.
 */
import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle, Copy, Eye, SlidersHorizontal, Wallet } from 'lucide-react';
import { DataTablePagination } from '../../ui/DataTablePagination';
import { DataTableStateRow } from '../../ui/DataTableState';
import { SortableTableHeader } from '../../ui/SortableTableHeader';
import MetricStrip from '../../ui/MetricStrip';
import OcsPageShell from '../OcsPageShell';
import OcsStatusBadge from '../common/OcsStatusBadge';
import OcsSortIcon from '../common/OcsSortIcon';
import OcsInvariantBadge from '../common/OcsInvariantBadge';
import { OcsFilterSelect, OcsResetFilters, OcsSearchField, OcsToolbar } from '../common/OcsToolbar';
import AdjustBalanceModal from './AdjustBalanceModal';
import { useRead } from '../../../lib/api/use-read';
import { hasPermission } from '../../../lib/permissions';
import { useAuth } from '../../../providers/AuthProvider';
import { useI18n } from '../../../providers/I18nProvider';
import { copyText } from '../../../lib/clipboard';
import {
  toBalanceListViewModel,
  toBalanceSummaryViewModel,
  toOcsPageViewModel,
  toTariffListViewModel,
  type OcsBalanceViewModel,
} from '../../../features/ocs/ocs-view-models';
import {
  formatOcsBytes,
  formatOcsNumber,
  formatOcsTime,
  pageCountFor,
  sanitizeImsiInput,
} from '../../../features/ocs/ocs-format';
import { hasActiveOcsFilters, useOcsQueryState, type OcsQueryState } from '../../../features/ocs/use-ocs-query-state';

type BalanceSortField = 'imsi' | 'data_available' | 'updated_at';

const QUERY_DEFAULTS: OcsQueryState = {
  q: '',
  status: '',
  plan: '',
  sort: 'updated_at',
  order: 'desc',
  page: '1',
  limit: '20',
};

const SORT_OPTIONS: BalanceSortField[] = ['imsi', 'data_available', 'updated_at'];

function readSortField(value: string): BalanceSortField {
  return (SORT_OPTIONS as string[]).includes(value) ? (value as BalanceSortField) : 'updated_at';
}

export default function OcsBalancePlaceholder() {
  const { t } = useI18n();
  const { user } = useAuth();
  const canAdjust = hasPermission(user, 'ocs.balance.adjust');

  const { state, update, reset } = useOcsQueryState(QUERY_DEFAULTS);
  const page = Math.max(1, Number.parseInt(state.page, 10) || 1);
  const limit = Math.max(1, Math.min(100, Number.parseInt(state.limit, 10) || 20));
  const sort = readSortField(state.sort);
  const order = state.order === 'asc' ? 'asc' : 'desc';

  const [copiedImsi, setCopiedImsi] = useState<string | null>(null);
  const [adjustTarget, setAdjustTarget] = useState<OcsBalanceViewModel | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

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
    return `/api/ocs/balances?${params.toString()}`;
  }, [limit, order, page, sort, state.plan, state.q, state.status]);

  const { data, error, isLoading: loading, mutate: refresh } = useRead<unknown>(url);
  const { data: plansData } = useRead<unknown>('/api/tariff-plans');

  const list = toBalanceListViewModel(data);
  const records = list.records;
  const paging = toOcsPageViewModel(data);
  const summary = toBalanceSummaryViewModel(data);
  const total = paging.total ?? 0;
  const totalPages = pageCountFor(total, limit);
  const filtersActive = hasActiveOcsFilters(state, QUERY_DEFAULTS);

  const planNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const plan of toTariffListViewModel(plansData).records) {
      if (plan.planId) map.set(plan.planId, plan.name || plan.planId);
    }
    return map;
  }, [plansData]);

  const planOptions = useMemo(() => {
    const entries = Array.from(planNames.entries())
      .sort((left, right) => left[1].localeCompare(right[1]))
      .map(([value, label]) => ({ value, label }));
    return [{ value: '', label: t('ocs_filter_all_plans') }, ...entries];
  }, [planNames, t]);

  const handleCopyImsi = useCallback(async (imsi: string) => {
    if (!(await copyText(imsi))) return;
    setCopiedImsi(imsi);
    window.setTimeout(() => setCopiedImsi((current) => (current === imsi ? null : current)), 1400);
  }, []);

  const toggleSort = (field: BalanceSortField) => {
    if (sort === field) update({ order: order === 'asc' ? 'desc' : 'asc', page: '1' });
    else update({ sort: field, order: field === 'imsi' ? 'asc' : 'desc', page: '1' });
  };

  const kpiGrid = (
    <MetricStrip
      variant="strip"
      ariaLabel={t('ocs_balances_title')}
      items={[
        {
          key: 'accounts',
          label: t('ocs_balance_total_accounts'),
          value: error ? '\u2014' : summary.totalSubscribers ?? total,
          icon: <Wallet size={20} />,
        },
        {
          key: 'allocated',
          label: t('ocs_balance_total_data'),
          value: error ? '\u2014' : formatOcsBytes(summary.totalDataAllocated),
          icon: <CheckCircle size={20} />,
        },
        {
          key: 'used',
          label: t('ocs_balance_total_used'),
          value: error ? '\u2014' : formatOcsBytes(summary.totalDataUsed),
          icon: <CheckCircle size={20} />,
        },
        {
          key: 'available',
          label: t('ocs_balance_total_available'),
          value: error ? '\u2014' : formatOcsBytes(summary.totalDataAvailable),
          icon: <CheckCircle size={20} />,
        },
      ]}
    />
  );

  const controls = (
    <OcsToolbar
      actions={<OcsResetFilters active={filtersActive} onReset={reset} label={t('ocs_filters_reset')} />}
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
        ]}
      />
      <OcsFilterSelect
        label={t('ocs_filter_plan')}
        value={state.plan}
        onChange={(value) => update({ plan: value, page: '1' })}
        options={planOptions}
      />
    </OcsToolbar>
  );

  const tableContent = (
    <>
      {feedback && (
        <div className={`${feedback.type === 'success' ? 'ocs-feedback-success' : 'ocs-feedback-error'} ocs-feedback-spaced`}>
          <span>{feedback.message}</span>
        </div>
      )}

      {error && (
        <div className="ocs-feedback-error ocs-feedback-spaced" role="alert">
          <span>{error.message || t('ocs_detail_load_failed')}</span>
        </div>
      )}

      <table className="ocs-table">
        <caption className="sr-only">{t('ocs_balances_title')}</caption>
        <thead>
          <tr>
            <SortableTableHeader
              label="IMSI"
              active={sort === 'imsi'}
              direction={order}
              icon={<OcsSortIcon active={sort === 'imsi'} direction={order} />}
              onSort={() => toggleSort('imsi')}
            />
            <th data-column-priority="important">{t('ocs_filter_plan')}</th>
            <SortableTableHeader
              label={t('ocs_balance_total_available')}
              active={sort === 'data_available'}
              direction={order}
              icon={<OcsSortIcon active={sort === 'data_available'} direction={order} />}
              onSort={() => toggleSort('data_available')}
              priority="essential"
            />
            <th data-column-priority="important">{t('ocs_col_voice_avail')}</th>
            <th data-column-priority="important">{t('ocs_col_sms_avail')}</th>
            <th data-column-priority="supplementary">{t('ocs_balance_money')}</th>
            <th data-column-priority="essential">{t('ocs_col_status')}</th>
            <th data-column-priority="important">{t('ocs_balance_invariant')}</th>
            <SortableTableHeader
              label={t('ocs_tariff_col_updated')}
              active={sort === 'updated_at'}
              direction={order}
              icon={<OcsSortIcon active={sort === 'updated_at'} direction={order} />}
              onSort={() => toggleSort('updated_at')}
              priority="supplementary"
            />
            <th className="ocs-col-actions" data-column-priority="essential">{t('actions')}</th>
          </tr>
        </thead>
        <tbody>
          {loading && records.length === 0 ? (
            <DataTableStateRow colSpan={10} state="loading">{t('loading')}</DataTableStateRow>
          ) : records.length === 0 ? (
            <DataTableStateRow colSpan={10} state="empty">
              {filtersActive ? t('ocs_empty_filtered') : t('no_data')}
            </DataTableStateRow>
          ) : (
            records.map((record) => {
              const imsi = record.imsi ?? '';
              return (
                <tr key={record.id ?? imsi}>
                  <td data-label="IMSI" data-column-priority="essential" className="ocs-mono">
                    <span className="ocs-imsi-cell-inline">
                      {imsi}
                      <button
                        type="button"
                        className={copiedImsi === imsi ? 'copy-btn copied' : 'copy-btn'}
                        onClick={() => void handleCopyImsi(imsi)}
                        title={t('sub_copy_imsi')}
                        aria-label={`${t('sub_copy_imsi')} ${imsi}`}
                      >
                        <Copy size={12} aria-hidden="true" />
                      </button>
                    </span>
                  </td>
                  <td data-label={t('ocs_filter_plan')} data-column-priority="important">
                    {record.planId
                      ? (
                        <Link className="ocs-link" to={`/ocs/tariffs/${encodeURIComponent(record.planId)}`}>
                          {planNames.get(record.planId) ?? record.planId}
                        </Link>
                      )
                      : '\u2014'}
                  </td>
                  <td data-label={t('ocs_balance_total_available')} data-column-priority="essential" className="ocs-mono">{formatOcsBytes(record.data.available)}</td>
                  <td data-label={t('ocs_col_voice_avail')} data-column-priority="important" className="ocs-mono">
                    {record.voice.available === null ? '\u2014' : `${record.voice.available}s`}
                  </td>
                  <td data-label={t('ocs_col_sms_avail')} data-column-priority="important" className="ocs-mono">{formatOcsNumber(record.sms.available)}</td>
                  <td data-label={t('ocs_balance_money')} data-column-priority="supplementary" className="ocs-mono">{formatOcsNumber(record.moneyBalance)}</td>
                  <td data-label={t('ocs_col_status')} data-column-priority="essential"><OcsStatusBadge status={record.status ?? ''} /></td>
                  <td data-label={t('ocs_balance_invariant')} data-column-priority="important"><OcsInvariantBadge value={record.invariants.all} /></td>
                  <td data-label={t('ocs_tariff_col_updated')} data-column-priority="supplementary" className="ocs-time-cell">
                    <span title={record.updatedAt ?? undefined}>{formatOcsTime(record.updatedAt)}</span>
                  </td>
                  <td className="ocs-col-actions" data-label={t('actions')} data-column-priority="essential">
                    <div className="ocs-action-group ocs-action-group-end">
                      <Link
                        className="ocs-action-btn"
                        title={t('ocs_balance_view_detail')}
                        aria-label={t('ocs_balance_view_detail')}
                        to={`/ocs/balances/${encodeURIComponent(imsi)}`}
                      >
                        <Eye size={14} aria-hidden="true" />
                      </Link>
                      {canAdjust && record.status !== 'terminated' && (
                        <button
                          type="button"
                          className="ocs-btn-sm ocs-btn-secondary"
                          onClick={() => setAdjustTarget(record)}
                          title={t('ocs_balance_adjust')}
                          aria-label={`${t('ocs_balance_adjust')} ${imsi}`}
                        >
                          <SlidersHorizontal size={14} aria-hidden="true" />
                          <span>{t('ocs_balance_adjust')}</span>
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>

      {adjustTarget && (
        <AdjustBalanceModal
          isOpen={true}
          imsi={adjustTarget.imsi ?? ''}
          dataAvailable={adjustTarget.data.available}
          voiceAvailable={adjustTarget.voice.available}
          smsAvailable={adjustTarget.sms.available}
          version={adjustTarget.version}
          onRefresh={() => { void refresh(); }}
          onClose={() => setAdjustTarget(null)}
          onSuccess={(result) => {
            setFeedback({
              type: result.outcome === 'executed_audit_warning' ? 'error' : 'success',
              message: result.message,
            });
            void refresh();
          }}
        />
      )}
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

  return (
    <OcsPageShell
      eyebrow={t('nav_ocs')}
      title={t('ocs_balances_title')}
      readonly={false}
      description={t('ocs_balances_desc')}
      loading={loading}
      onRefresh={() => void refresh()}
      kpiGrid={kpiGrid}
      controls={controls}
      tableContent={tableContent}
      pagination={pagination}
    />
  );
}
