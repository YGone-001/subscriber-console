/*
 * Forward-ported from the historical xCloud UI (reference commit 2c40903):
 * frontend/src/components/ocs/balances/OcsBalancePlaceholder.tsx
 *
 * This is the component the historical `/ocs/balances` route actually rendered
 * (`app/(dashboard)/ocs/balances/page.tsx` forwards to it), not `OcsBalancesPanel`.
 *
 * Adaptations: "use client" dropped; `@/` aliases replaced with relative imports;
 * the historical Next.js link component replaced by the React Router link (`href` -> `to`); `useSWR(fetcher)`
 * replaced by the current read client; the `{ok, records, total, summary}` envelope
 * unwrapped by the typed balance adapter; the capability check replaced by the
 * current `hasPermission` gate for `ocs.balance.adjust`.
 *
 * Balance reset is intentionally absent: this surface exposes adjustment only.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle, Eye, Search, SlidersHorizontal, Wallet } from 'lucide-react';
import { DataTablePagination } from '../../ui/DataTablePagination';
import { DataTableStateRow } from '../../ui/DataTableState';
import MetricStrip from '../../ui/MetricStrip';
import OcsPageShell from '../OcsPageShell';
import OcsStatusBadge from '../common/OcsStatusBadge';
import AdjustBalanceModal from './AdjustBalanceModal';
import { useRead } from '../../../lib/api/use-read';
import { hasPermission } from '../../../lib/permissions';
import { useAuth } from '../../../providers/AuthProvider';
import { useI18n } from '../../../providers/I18nProvider';
import { formatBytes } from '../../../lib/unitParser';
import { toBalanceListViewModel, toOcsPageViewModel, type OcsBalanceViewModel } from '../../../features/ocs/ocs-view-models';

export default function OcsBalancePlaceholder() {
  const { t } = useI18n();
  const { user } = useAuth();
  const canAdjust = hasPermission(user, 'ocs.balance.adjust');

  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const [adjustTarget, setAdjustTarget] = useState<OcsBalanceViewModel | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const url = useMemo(() => {
    const params = new URLSearchParams({
      page: String(page),
      limit: String(limit),
      imsi: search.trim(),
      status: statusFilter,
    });
    return `/api/ocs/balances?${params.toString()}`;
  }, [page, limit, search, statusFilter]);

  const { data, error, isLoading: loading, mutate: refresh } = useRead<unknown>(url);

  const list = toBalanceListViewModel(data);
  const records = list.records;
  const paging = toOcsPageViewModel(data);
  const total = paging.total ?? 0;
  const activeCount = records.filter((record) => record.status === 'active').length;

  const formatTime = (iso: string | null) => {
    if (!iso) return '—';
    const parsed = new Date(iso);
    return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleString();
  };

  const kpiGrid = (
    <MetricStrip
      variant="strip"
      ariaLabel={t('ocs_balances_title')}
      items={[
        { key: 'total', label: t('ocs_balance_total_accounts'), value: error ? '—' : total, icon: <Wallet size={20} /> },
        { key: 'active', label: t('ocs_balance_active_accounts'), value: error ? '—' : activeCount, icon: <CheckCircle size={20} /> },
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
          aria-label={t('ocs_subscribers_search_ph')}
          placeholder={t('ocs_subscribers_search_ph')}
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
        </select>
      </div>
    </div>
  );

  const tableContent = (
    <>
      {feedback && (
        <div className={`${feedback.type === 'success' ? 'ocs-feedback-success' : 'ocs-feedback-error'} ocs-feedback-spaced`}>
          <span>{feedback.message}</span>
        </div>
      )}

      {error && (
        <div className="ocs-feedback-error ocs-feedback-spaced">
          <span>{error.message || t('ocs_load_failed')}</span>
        </div>
      )}

      <table className="ocs-table">
        <caption className="sr-only">{t('ocs_balances_title')}</caption>
        <thead>
          <tr>
            <th data-column-priority="essential">IMSI</th>
            <th data-column-priority="essential">{t('ocs_col_data_available')}</th>
            <th data-column-priority="essential">{t('ocs_col_voice_avail')}</th>
            <th data-column-priority="essential">{t('ocs_col_sms_avail')}</th>
            <th data-column-priority="essential">{t('ocs_col_status')}</th>
            <th data-column-priority="supplementary">{t('ocs_col_version')}</th>
            <th data-column-priority="supplementary">{t('ocs_tariff_col_updated')}</th>
            <th className="ocs-col-actions" data-column-priority="essential">{t('actions')}</th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <DataTableStateRow colSpan={8} state="loading">{t('loading')}</DataTableStateRow>
          ) : error ? (
            <DataTableStateRow colSpan={8} state="error">{error.message || t('ocs_load_failed')}</DataTableStateRow>
          ) : records.length === 0 ? (
            <DataTableStateRow colSpan={8} state="empty">{t('no_data')}</DataTableStateRow>
          ) : (
            records.map((record) => {
              const imsi = record.imsi ?? '';
              return (
                <tr key={record.id ?? imsi}>
                  <td data-label="IMSI" data-column-priority="essential" className="ocs-mono">{imsi}</td>
                  <td data-label={t('ocs_col_data_available')} data-column-priority="essential" className="ocs-mono">{formatBytes(record.data.available ?? 0)}</td>
                  <td data-label={t('ocs_col_voice_avail')} data-column-priority="essential" className="ocs-mono">{record.voice.available ?? 0}s</td>
                  <td data-label={t('ocs_col_sms_avail')} data-column-priority="essential" className="ocs-mono">{record.sms.available ?? 0}</td>
                  <td data-label={t('ocs_col_status')} data-column-priority="essential"><OcsStatusBadge status={record.status ?? ''} /></td>
                  <td data-label={t('ocs_col_version')} data-column-priority="supplementary" className="ocs-mono">v{record.version || 1}</td>
                  <td data-label={t('ocs_tariff_col_updated')} data-column-priority="supplementary" className="ocs-time-cell">{formatTime(record.updatedAt)}</td>
                  <td className="ocs-col-actions" data-label={t('actions')} data-column-priority="essential">
                    <div className="ocs-action-group ocs-action-group-end">
                      <Link
                        className="ocs-action-btn"
                        title={t('ocs_balance_view_detail')}
                        to={`/ocs/balances/${encodeURIComponent(imsi)}`}
                      >
                        <Eye size={14} />
                      </Link>
                      <button
                        type="button"
                        className="ocs-btn-sm ocs-btn-secondary"
                        disabled={!canAdjust}
                        onClick={() => canAdjust && setAdjustTarget(record)}
                        title={canAdjust ? t('ocs_balance_adjust') : t('permission_denied')}
                        style={!canAdjust ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
                      >
                        <SlidersHorizontal size={14} />
                        <span>{t('ocs_balance_adjust')}</span>
                      </button>
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
      totalPages={paging.totalPages || Math.ceil(total / limit) || 1}
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
      onPageSizeChange={(nextLimit: number) => { setLimit(nextLimit); setPage(1); }}
    />
  );

  return (
    <OcsPageShell
      eyebrow={t('nav_ocs')}
      title={t('ocs_balances_title')}
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
