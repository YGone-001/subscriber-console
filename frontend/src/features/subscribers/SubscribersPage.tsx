/*
 * Forward-ported from the historical xCloud UI (reference commit 2c40903):
 * frontend/src/app/(dashboard)/subscribers/page.tsx
 *
 * Adaptations, all at the runtime boundary:
 *   - `useSWR(fetcher)` replaced by the current read client; raw `fetch` mutations
 *     replaced by the current mutation client.
 *   - `useAuth().canEditSubscribers` replaced by the shared capability helper for
 *     `subscribers.write`.
 *   - The retired and denied surfaces the reference composed are NOT ported: the
 *     Data Hub modal, the signalling trace modal and the bulk policy modal, plus
 *     their trigger buttons. The bulk policy modal is excluded because its
 *     mutation is on the project's absolute denylist, so the route must offer no
 *     entry point to it. The batch-update modal is kept: it owns the batch-update
 *     route, which the Go router registers. Forbidden endpoint paths are
 *     deliberately not written out here — the denylist gate scans raw text.
 *
 * Everything else — the PLMN longest-prefix resolver, the cross-page selection
 * model, the summary strip, the toolbar, the table and the modals — is unchanged.
 */
import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, Layers } from 'lucide-react';
import SubscriberModal from '../../components/SubscriberModal';
import BatchCreateModal from '../../components/BatchCreateModal';
import SubscriberBatchUpdateModal from '../../components/SubscriberBatchUpdateModal';
import TrafficAdjustmentModal from '../../components/TrafficAdjustmentModal';
import { ConfirmActionPanel, OperationNotice } from '../../components/ui/OperationFeedback';
import { DataTablePagination } from '../../components/ui/DataTablePagination';
import PageHeader from '../../components/ui/PageHeader';
import SubscriberSummaryPanel from './components/SubscriberSummaryPanel';
import { SubscriberToolbar } from './components/SubscriberToolbar';
import { SubscriberTable } from './components/SubscriberTable';
import { useI18n } from '../../providers/I18nProvider';
import { useAuth } from '../../providers/AuthProvider';
import { hasPermission } from '../../lib/permissions';
import { useRead } from '../../lib/api/use-read';
import { deleteJson, postJson } from '../../lib/api/mutation-client';
import { formatBytes } from '../../lib/unitParser';
import type {
  FeedbackState,
  PendingDelete,
  PlmnRecord,
  ProfilesResponse,
  SubscriberRow,
  SubscriberStatusFilter,
  SubscribersResponse,
  TrafficAdjustmentMode,
  TrafficAdjustmentTarget,
} from './types';

const SUBSCRIBER_PAGE_SIZES = [10, 20, 50] as const;

export function SubscribersPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const canEditSubscribers = hasPermission(user, 'subscribers.write');

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedImsis, setSelectedImsis] = useState<string[]>([]);
  const [isDeletingBulk, setIsDeletingBulk] = useState(false);
  const [isBatchUpdateModalOpen, setIsBatchUpdateModalOpen] = useState(false);
  const [activeDropdown, setActiveDropdown] = useState<string | null>(null);
  const [copiedImsi, setCopiedImsi] = useState<string | null>(null);
  const [trafficAdjustmentTarget, setTrafficAdjustmentTarget] = useState<TrafficAdjustmentTarget | null>(null);
  const [feedback, setFeedback] = useState<FeedbackState | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [isDeletingSingle, setIsDeletingSingle] = useState<string | null>(null);

  const [sortField, setSortField] = useState<string>('imsi');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [statusFilter, setStatusFilter] = useState<SubscriberStatusFilter>('all');

  const [modalImsi, setModalImsi] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isBatchOpen, setIsBatchOpen] = useState(false);

  const timeAgo = (dateStr: string) => {
    if (!dateStr) return t('never');
    const time = new Date(dateStr).getTime();
    const now = new Date().getTime();
    const diff = Math.floor((now - time) / 1000);
    if (diff < 60) return t('just_now');
    if (diff < 3600) return `${Math.floor(diff / 60)} ${t('mins_ago')}`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} ${t('hours_ago')}`;
    return `${Math.floor(diff / 86400)} ${t('days_ago')}`;
  };

  const formatFullDate = (dStr: string) => {
    if (!dStr) return '';
    const d = new Date(dStr);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  };

  const { data: mccMncDbData } = useRead<PlmnRecord[]>('/data/mcc-mnc-table.json');
  const mccMncDb = useMemo(() => (mccMncDbData || []) as PlmnRecord[], [mccMncDbData]);

  const subscriberQuery = searchQuery.trim();
  const subscribersUrl = `/api/subscribers?detail=true&page=${currentPage}&limit=${pageSize}${subscriberQuery ? `&q=${encodeURIComponent(subscriberQuery)}` : ''}${statusFilter !== 'all' ? `&status=${statusFilter}` : ''}&sortField=${sortField}&sortDirection=${sortDirection}`;
  const { data: subscribersData, isLoading, mutate: mutateSubscribers } = useRead<SubscribersResponse>(subscribersUrl);

  const subscribers = subscribersData?.subscribers || [];
  const totalSubscribers = subscribersData?.total || 0;
  const subscriberSummary = subscribersData?.summary || { total: totalSubscribers, active: 0, restricted: 0, lowTraffic: 0 };

  const { data: profileData } = useRead<ProfilesResponse>('/api/profiles');
  const profileList = profileData?.profiles || [];

  const handleOpenNew = () => {
    setModalImsi(null);
    setIsModalOpen(true);
  };

  const handleOpenEdit = (imsi: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setModalImsi(imsi);
    setIsModalOpen(true);
  };

  const handleDelete = (imsi: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setActiveDropdown(null);
    setPendingDelete({ mode: 'single', imsis: [imsi] });
  };

  const handleOpenTrafficAdjustment = (sub: SubscriberRow, mode: TrafficAdjustmentMode, e: React.MouseEvent) => {
    e.stopPropagation();
    setActiveDropdown(null);
    const used = sub.traffic?.used || 0;
    const total = sub.traffic?.total || 0;
    const balance = sub.traffic?.balance ?? Math.max(0, total - used);
    setTrafficAdjustmentTarget({ imsi: sub.imsi, traffic: { used, total, balance }, mode });
  };

  const handleBulkDelete = () => {
    if (selectedImsis.length === 0) return;
    setPendingDelete({ mode: 'bulk', imsis: [...selectedImsis] });
  };

  const executePendingDelete = async () => {
    if (!pendingDelete || pendingDelete.imsis.length === 0) return;

    const { mode, imsis } = pendingDelete;
    const singleImsi = imsis[0] || '';
    if (mode === 'bulk') setIsDeletingBulk(true);
    if (mode === 'single') setIsDeletingSingle(singleImsi);
    try {
      if (mode === 'bulk') {
        const data = await postJson<{ deletedCount?: number; deleted?: number }>('/api/subscribers/bulk-delete', { imsiList: imsis });
        setSelectedImsis([]);
        setPendingDelete(null);
        setFeedback({
          tone: 'success',
          title: t('sub_feedback_success_title'),
          message: t('sub_feedback_bulk_delete_success', { count: data?.deletedCount ?? data?.deleted ?? imsis.length }),
        });
        await mutateSubscribers();
        return;
      }

      await deleteJson(`/api/subscribers/${encodeURIComponent(singleImsi)}`);
      setFeedback({
        tone: 'success',
        title: t('sub_feedback_success_title'),
        message: t('sub_feedback_delete_success', { imsi: singleImsi }),
      });
      setPendingDelete(null);
      await mutateSubscribers();
    } catch (failure) {
      /*
       * Surface WHY the delete failed. Swallowing the reason left the operator with a
       * bare "failed" on a record that can never be deleted from here: the service
       * addresses subscribers by a 15-digit IMSI, so a malformed row (a literal
       * "UNKNOWN" created outside the validated write path) is unreachable by every
       * per-IMSI route. Say that plainly instead of inviting retries.
       */
      const code = (failure as { code?: string }).code;
      const detail = failure instanceof Error && failure.message ? failure.message : '';
      const base = mode === 'bulk'
        ? t('sub_feedback_bulk_delete_error')
        : t('sub_feedback_delete_error', { imsi: singleImsi });

      let message = base;
      if (code === 'INVALID_IMSI' || /IMSI must be exactly 15 digits/i.test(detail)) {
        message = `${base} ${t('sub_err_imsi_not_addressable', { imsi: singleImsi })}`;
      } else if (detail) {
        message = `${base} (${detail})`;
      }

      setFeedback({ tone: 'danger', title: t('sub_feedback_error_title'), message });
      /* Close the confirm dialog on failure as well. Leaving it mounted under the
       * error notice made its buttons unreachable. */
      setPendingDelete(null);
    } finally {
      setIsDeletingBulk(false);
      setIsDeletingSingle(null);
    }
  };

  const toggleSelectAll = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.checked) {
      setSelectedImsis((prev) => Array.from(new Set([...prev, ...pageImsis])));
    } else {
      setSelectedImsis((prev) => prev.filter((imsi) => !pageImsis.includes(imsi)));
    }
  };

  /* O(1) PLMN lookup: the catalog holds 20k+ records, so parsing is cached. */
  const plmnMap = useMemo(() => {
    const map = new Map<string, PlmnRecord>();
    mccMncDb.forEach((item) => { map.set(`${item.mcc}${item.mnc}`, item); });
    return map;
  }, [mccMncDb]);

  /* Longest-prefix match so both 2-digit and 3-digit MNC networks resolve. */
  const resolveNetwork = (imsi: string) => {
    if (!imsi || imsi.length < 5) return { plmn: 'N/A', network: 'Unknown', country: 'Unknown' };
    const prefix6 = imsi.substring(0, 6);
    if (plmnMap.has(prefix6)) return { plmn: prefix6, ...plmnMap.get(prefix6) };
    const prefix5 = imsi.substring(0, 5);
    if (plmnMap.has(prefix5)) return { plmn: prefix5, ...plmnMap.get(prefix5) };
    return { plmn: prefix5, network: 'Unknown', country: 'Unknown' };
  };

  const handleSort = (field: string) => {
    if (sortField === field) setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    else { setSortField(field); setSortDirection('asc'); }
  };

  const applyStatusFilter = (nextFilter: SubscriberStatusFilter) => {
    setStatusFilter(nextFilter);
    setCurrentPage(1);
    setSelectedImsis([]);
  };

  const summaryCards = [
    { key: 'all' as const, label: t('subscriber_summary_total'), value: subscriberSummary.total, tone: 'primary' },
    { key: 'active' as const, label: t('subscriber_summary_active'), value: subscriberSummary.active, tone: 'success' },
    { key: 'restricted' as const, label: t('subscriber_summary_restricted'), value: subscriberSummary.restricted, tone: 'danger' },
    { key: 'lowTraffic' as const, label: t('subscriber_summary_low_traffic'), value: subscriberSummary.lowTraffic, tone: 'warning' },
  ] as const;

  const totalPages = Math.max(1, Math.ceil(totalSubscribers / pageSize));
  const displayPage = Math.min(currentPage, totalPages);
  const paginatedSubscribers = subscribers;
  const pageImsis = paginatedSubscribers.map((s) => s.imsi);
  const selectedOnPageCount = pageImsis.filter((imsi) => selectedImsis.includes(imsi)).length;
  const isAllPageSelected = pageImsis.length > 0 && selectedOnPageCount === pageImsis.length;
  const pendingDeleteItems = pendingDelete?.imsis.slice(0, 3).join(', ') || '';
  const pendingDeleteOverflow = pendingDelete && pendingDelete.imsis.length > 3 ? ` +${pendingDelete.imsis.length - 3}` : '';

  useEffect(() => {
    if (subscribersData && currentPage > totalPages) setCurrentPage(totalPages);
  }, [currentPage, subscribersData, totalPages]);

  const handleCopyImsi = async (imsi: string, e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(imsi);
      setCopiedImsi(imsi);
      window.setTimeout(() => setCopiedImsi((current) => (current === imsi ? null : current)), 1400);
    } catch {
      /* Clipboard access can be denied; the affordance simply stays idle. */
    }
  };

  const renderSortIcon = (field: string) => {
    if (sortField !== field) return <ArrowUpDown size={14} className="sort-icon muted" />;
    return sortDirection === 'asc'
      ? <ArrowUp size={14} className="sort-icon active" />
      : <ArrowDown size={14} className="sort-icon active" />;
  };

  return (
    <>
      <div className="container animate-fade-in" onClick={() => setActiveDropdown(null)}>
        <PageHeader
          eyebrow={t('eyebrow_imsi_hss')}
          icon={<Layers size={23} />}
          title={t('subscriber_title')}
          description={t('subscriber_subtitle')}
        />

        <SubscriberSummaryPanel
          summaryCards={summaryCards}
          statusFilter={statusFilter}
          applyStatusFilter={applyStatusFilter}
        />

        {/* A page-level notice is modal so a destructive action is explicitly
          * acknowledged. It must not render while a confirm dialog is mounted, or it
          * would portal on top of it and make the dialog's buttons unreachable. */}
        {feedback && !pendingDelete && (
          <OperationNotice
            presentation="modal"
            tone={feedback.tone}
            title={feedback.title}
            message={feedback.message}
            onClose={() => setFeedback(null)}
          />
        )}

        {pendingDelete && (
          <ConfirmActionPanel
            presentation="modal"
            title={pendingDelete.mode === 'bulk' ? t('sub_confirm_bulk_delete_title', { count: pendingDelete.imsis.length }) : t('sub_confirm_delete_title')}
            message={
              pendingDelete.mode === 'bulk'
                ? t('sub_confirm_bulk_delete_desc', { items: `${pendingDeleteItems}${pendingDeleteOverflow}` })
                : t('sub_confirm_delete_desc', { items: pendingDeleteItems })
            }
            confirmLabel={t('delete')}
            cancelLabel={t('cancel')}
            isWorking={isDeletingBulk || Boolean(isDeletingSingle)}
            onConfirm={() => void executePendingDelete()}
            onCancel={() => setPendingDelete(null)}
          />
        )}

        <SubscriberToolbar
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          setCurrentPage={setCurrentPage}
          setSelectedImsis={setSelectedImsis}
          selectedImsis={selectedImsis}
          canEditSubscribers={canEditSubscribers}
          setIsBatchUpdateModalOpen={setIsBatchUpdateModalOpen}
          handleBulkDelete={handleBulkDelete}
          isDeletingBulk={isDeletingBulk}
          pendingDelete={pendingDelete}
          handleOpenNew={handleOpenNew}
          setIsBatchOpen={setIsBatchOpen}
          mutateSubscribers={() => { void mutateSubscribers(); }}
          setFeedback={setFeedback}
        />

        <div className="dash-card shadow table-card">
          <SubscriberTable
            isLoading={isLoading}
            totalSubscribers={totalSubscribers}
            searchQuery={searchQuery}
            statusFilter={statusFilter}
            canEditSubscribers={canEditSubscribers}
            handleOpenNew={handleOpenNew}
            isAllPageSelected={isAllPageSelected}
            selectedOnPageCount={selectedOnPageCount}
            pageImsis={pageImsis}
            toggleSelectAll={toggleSelectAll}
            sortField={sortField}
            sortDirection={sortDirection}
            handleSort={handleSort}
            renderSortIcon={renderSortIcon}
            paginatedSubscribers={paginatedSubscribers}
            selectedImsis={selectedImsis}
            setSelectedImsis={setSelectedImsis}
            copiedImsi={copiedImsi}
            handleCopyImsi={handleCopyImsi}
            resolveNetwork={resolveNetwork}
            formatBytes={formatBytes}
            formatFullDate={formatFullDate}
            timeAgo={timeAgo}
            handleOpenEdit={handleOpenEdit}
            handleDelete={handleDelete}
            isDeletingSingle={isDeletingSingle}
            pendingDelete={pendingDelete}
            activeDropdown={activeDropdown}
            setActiveDropdown={setActiveDropdown}
            handleOpenTrafficAdjustment={handleOpenTrafficAdjustment}
          />
          {!isLoading && (
            <DataTablePagination
              page={displayPage}
              pageSize={pageSize}
              total={totalSubscribers}
              visibleCount={subscribers.length}
              totalPages={totalPages}
              pageSizes={SUBSCRIBER_PAGE_SIZES}
              labels={{
                showing: t('showing'),
                to: t('to'),
                of: t('of'),
                entries: t('entries'),
                previous: t('prev'),
                next: t('next'),
                perPage: t('per_page'),
              }}
              onPageChange={(next) => setCurrentPage(next)}
              onPageSizeChange={(size) => { setPageSize(size); setCurrentPage(1); }}
            />
          )}
        </div>
      </div>

      <BatchCreateModal
        isOpen={isBatchOpen}
        onClose={() => setIsBatchOpen(false)}
        onSuccess={() => { void mutateSubscribers(); }}
        profileList={profileList}
      />

      {isModalOpen && (
        <SubscriberModal
          imsi={modalImsi}
          onClose={() => setIsModalOpen(false)}
          onRefresh={() => { void mutateSubscribers(); }}
        />
      )}

      {trafficAdjustmentTarget && (
        <TrafficAdjustmentModal
          imsi={trafficAdjustmentTarget.imsi}
          t={t}
          defaultMode={trafficAdjustmentTarget.mode}
          currentTraffic={trafficAdjustmentTarget.traffic}
          onClose={() => setTrafficAdjustmentTarget(null)}
          onSuccess={() => {
            void mutateSubscribers();
            setFeedback({ tone: 'success', title: t('success'), message: t('traffic_adjust_title') });
          }}
        />
      )}

      <SubscriberBatchUpdateModal
        isOpen={isBatchUpdateModalOpen}
        selectedImsis={selectedImsis}
        onClose={() => setIsBatchUpdateModalOpen(false)}
        onSuccess={(response) => {
          setSelectedImsis([]);
          setFeedback({
            tone: 'success',
            title: t('success'),
            message: t('sub_batch_update_success', { count: response.result?.modified ?? selectedImsis.length }),
          });
          void mutateSubscribers();
        }}
      />
    </>
  );
}
