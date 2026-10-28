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
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowDown, ArrowUp, ArrowUpDown, Layers } from 'lucide-react';
import BatchCreateModal from '../../components/BatchCreateModal';
import SubscriberBatchUpdateModal from '../../components/SubscriberBatchUpdateModal';
import TrafficAdjustmentModal from '../../components/TrafficAdjustmentModal';
import { ConfirmActionPanel, OperationNotice } from '../../components/ui/OperationFeedback';
import { DataTablePagination } from '../../components/ui/DataTablePagination';
import { ErrorState } from '../../components/ui/StatePanel';
import PageHeader from '../../components/ui/PageHeader';
import SubscriberSummaryPanel from './components/SubscriberSummaryPanel';
import { SubscriberToolbar } from './components/SubscriberToolbar';
import { SubscriberTable } from './components/SubscriberTable';
import { SubscriberFilters, type SubscriberPlanOption } from './components/SubscriberFilters';
import { useI18n } from '../../providers/I18nProvider';
import { useAuth } from '../../providers/AuthProvider';
import { hasPermission } from '../../lib/permissions';
import { copyText } from '../../lib/clipboard';
import { useRead } from '../../lib/api/use-read';
import { deleteJson, postJson } from '../../lib/api/mutation-client';
import { useAppRouter } from '../../lib/ui-compat/router';
import { buildProfileApplyRequest } from './mutation-contract';
import type {
  FeedbackState,
  PendingDelete,
  PlmnRecord,
  ProfilesResponse,
  SubscriberFilters as SubscriberFilterState,
  SubscriberRow,
  SubscriberSummaryKey,
  SubscribersResponse,
  TrafficAdjustmentTarget,
} from './types';

const SUBSCRIBER_PAGE_SIZES = [10, 20, 50] as const;

/* The service addresses subscribers by a numeric IMSI prefix or a full MSISDN
 * (at most 15 digits). A term that can never match is not sent at all: the list
 * would answer with an empty page and every counter would read zero, which
 * describes an empty platform rather than an unanswered question. */
const SEARCH_TERM_PATTERN = /^\d{1,15}$/;

const isValidSearchTerm = (term: string) => term === '' || SEARCH_TERM_PATTERN.test(term);

const DEFAULT_FILTERS: SubscriberFilterState = {
  access: 'all',
  contract: 'all',
  provisioning: 'all',
  planId: '',
  balance: 'all',
};

export function SubscribersPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const router = useAppRouter();
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
  const [filters, setFilters] = useState<SubscriberFilterState>(DEFAULT_FILTERS);
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');

  const [isBatchOpen, setIsBatchOpen] = useState(false);
  const [profileApplyTarget, setProfileApplyTarget] = useState<SubscriberRow | null>(null);
  const [applyProfileName, setApplyProfileName] = useState('');
  const [isApplyingProfile, setIsApplyingProfile] = useState(false);

  /* Template drill-down arrives as ?profile=<name> from the template detail page. */
  const [searchParams, setSearchParams] = useSearchParams();
  const profileDrillDown = searchParams.get('profile') ?? '';

  const timeAgo = (dateStr: string) => {
    if (!dateStr) return t('unknown');
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

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearchQuery(searchQuery.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [searchQuery]);

  /* While the input cannot match anything, the previous valid term stays in
   * effect: the table keeps the rows it was showing and the toolbar says why. */
  const lastValidSearchRef = useRef('');
  useEffect(() => {
    if (isValidSearchTerm(debouncedSearchQuery)) lastValidSearchRef.current = debouncedSearchQuery;
  }, [debouncedSearchQuery]);
  const searchTermInvalid = !isValidSearchTerm(searchQuery.trim());
  const subscriberQuery = isValidSearchTerm(debouncedSearchQuery)
    ? debouncedSearchQuery
    : lastValidSearchRef.current;
  const filterParams = new URLSearchParams({
    detail: 'true',
    page: String(currentPage),
    limit: String(pageSize),
    searchBy: 'auto',
    sortField,
    sortDirection,
  });
  if (subscriberQuery) filterParams.set('q', subscriberQuery);
  if (filters.access !== 'all') filterParams.set('status', filters.access);
  if (filters.contract !== 'all') filterParams.set('contractStatus', filters.contract);
  if (filters.provisioning !== 'all') filterParams.set('provisioning', filters.provisioning);
  if (filters.planId) filterParams.set('planId', filters.planId);
  if (filters.balance !== 'all') filterParams.set('balanceStatus', filters.balance);
  if (profileDrillDown) filterParams.set('profile', profileDrillDown);
  const subscribersUrl = `/api/subscribers?${filterParams.toString()}`;
  const { data: subscribersData, isLoading, error: subscribersError, mutate: mutateSubscribers } = useRead<SubscribersResponse>(subscribersUrl);

  /* A failed read is not an empty list. Without a previous page there is nothing
   * truthful to render, so the table states the failure; with a previous page the
   * rows stay and the failure is appended instead of replacing them. */
  const listUnavailable = Boolean(subscribersError) && !subscribersData && !isLoading;
  const listReloadFailed = Boolean(subscribersError) && Boolean(subscribersData) && !isLoading;
  const listErrorMessage = subscribersError instanceof Error
    ? subscribersError.message
    : String(subscribersError ?? '');

  const subscribers = subscribersData?.subscribers || [];
  const totalSubscribers = subscribersData?.total || 0;
  const subscriberSummary = subscribersData?.summary || { total: totalSubscribers, active: 0, restricted: 0, lowTraffic: 0, lowBalance: 0, unprovisioned: 0 };

  const { data: profileData } = useRead<ProfilesResponse>('/api/profiles');
  const profileList = profileData?.profiles || [];
  const { data: tariffPlanData } = useRead<{ plans?: SubscriberPlanOption[] }>('/api/tariff-plans');
  const planOptions = tariffPlanData?.plans || [];

  const hasActiveFilters = filters.access !== 'all'
    || filters.contract !== 'all'
    || filters.provisioning !== 'all'
    || filters.balance !== 'all'
    || filters.planId !== ''
    || profileDrillDown !== '';
  const canAdjustBalance = hasPermission(user, 'ocs.balance.adjust');

  const handleOpenNew = () => {
    router.push('/subscribers/new');
  };

  const handleOpenView = (imsi: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    router.push(`/subscribers/${encodeURIComponent(imsi)}`);
  };

  const handleDelete = (imsi: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setActiveDropdown(null);
    setPendingDelete({ mode: 'single', imsis: [imsi] });
  };

  const handleOpenTrafficAdjustment = (sub: SubscriberRow, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setActiveDropdown(null);
    const used = sub.traffic?.used || 0;
    const total = sub.traffic?.total || 0;
    const balance = sub.traffic?.balance ?? Math.max(0, total - used);
    setTrafficAdjustmentTarget({ imsi: sub.imsi, traffic: { used, total, balance } });
  };

  const handleOpenProfileApply = (sub: SubscriberRow) => {
    setProfileApplyTarget(sub);
    setApplyProfileName('');
  };

  const executeProfileApply = async () => {
    if (!profileApplyTarget) return;
    const targetImsi = profileApplyTarget.imsi;
    const profileName = applyProfileName.trim();
    if (!profileName) return;
    setIsApplyingProfile(true);
    try {
      const data = await postJson<{ outcome?: string; message?: string }>(
        `/api/subscribers/${encodeURIComponent(targetImsi)}/profile`,
        buildProfileApplyRequest(profileName),
      );
      setProfileApplyTarget(null);
      setApplyProfileName('');
      setFeedback({
        tone: 'success',
        title: t('sub_feedback_success_title'),
        message: data?.outcome === 'no_effect'
          ? t('sub_apply_profile_no_effect', { imsi: targetImsi })
          : t('sub_apply_profile_success', { imsi: targetImsi, name: profileName }),
      });
      await mutateSubscribers();
    } catch (failure) {
      const detail = failure instanceof Error && failure.message ? failure.message : '';
      setFeedback({
        tone: 'danger',
        title: t('sub_feedback_error_title'),
        message: detail
          ? `${t('sub_apply_profile_error', { imsi: targetImsi })} (${detail})`
          : t('sub_apply_profile_error', { imsi: targetImsi }),
      });
      setProfileApplyTarget(null);
      setApplyProfileName('');
    } finally {
      setIsApplyingProfile(false);
    }
  };

  const clearProfileDrillDown = () => {
    const params = new URLSearchParams(searchParams);
    params.delete('profile');
    setSearchParams(params, { replace: true });
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
    setCurrentPage(1);
    setSelectedImsis([]);
  };

  const handleFiltersChange = (next: SubscriberFilterState) => {
    setFilters(next);
    setCurrentPage(1);
    setSelectedImsis([]);
  };

  const resetFilters = () => {
    setFilters(DEFAULT_FILTERS);
    setCurrentPage(1);
    setSelectedImsis([]);
  };

  const handleSummarySelect = (key: SubscriberSummaryKey) => {
    if (key === 'all') {
      resetFilters();
      return;
    }
    if (key === 'unprovisioned') {
      handleFiltersChange({ ...DEFAULT_FILTERS, provisioning: 'incomplete' });
      return;
    }
    if (key === 'lowBalance') {
      handleFiltersChange({ ...DEFAULT_FILTERS, balance: 'low' });
      return;
    }
    handleFiltersChange({ ...DEFAULT_FILTERS, access: key });
  };

  const activeCard: SubscriberSummaryKey | null = (() => {
    if (filters.provisioning === 'incomplete' && filters.access === 'all' && filters.contract === 'all' && filters.balance === 'all' && !filters.planId) return 'unprovisioned';
    if (filters.balance === 'low' && filters.access === 'all' && filters.contract === 'all' && filters.provisioning === 'all' && !filters.planId) return 'lowBalance';
    if (filters.access === 'active' && filters.contract === 'all' && filters.provisioning === 'all' && filters.balance === 'all' && !filters.planId) return 'active';
    if (filters.access === 'restricted' && filters.contract === 'all' && filters.provisioning === 'all' && filters.balance === 'all' && !filters.planId) return 'restricted';
    if (!hasActiveFilters) return 'all';
    return null;
  })();

  /* The first card is the result size, so it must stop claiming to be a platform
   * total as soon as any filter narrows the view. */
  const allCardLabel = subscriberQuery || hasActiveFilters
    ? t('subscriber_summary_matched')
    : t('subscriber_summary_total');

  const summaryCards = [
    { key: 'all' as const, label: allCardLabel, value: subscriberSummary.total, tone: 'primary' },
    { key: 'active' as const, label: t('subscriber_summary_active'), value: subscriberSummary.active, tone: 'success' },
    { key: 'restricted' as const, label: t('subscriber_summary_restricted'), value: subscriberSummary.restricted, tone: 'danger' },
    { key: 'lowBalance' as const, label: t('subscriber_summary_low_balance'), value: subscriberSummary.lowBalance ?? 0, tone: 'warning' },
    { key: 'unprovisioned' as const, label: t('subscriber_summary_unprovisioned'), value: subscriberSummary.unprovisioned ?? 0, tone: 'warning' },
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

  const handleCopyImsi = async (imsi: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    if (!(await copyText(imsi))) return;
    setCopiedImsi(imsi);
    window.setTimeout(() => setCopiedImsi((current) => (current === imsi ? null : current)), 1400);
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

        {/* A failed read explains itself; five zeroed counters would describe an
          * empty platform instead of an unanswered request. */}
        {!listUnavailable && (
          <SubscriberSummaryPanel
            summaryCards={summaryCards}
            activeCard={activeCard}
            onSelect={handleSummarySelect}
          />
        )}
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

        {profileApplyTarget && (
          <ConfirmActionPanel
            presentation="modal"
            tone="warning"
            title={t('sub_apply_profile_title', { imsi: profileApplyTarget.imsi })}
            message={t('sub_apply_profile_desc', { imsi: profileApplyTarget.imsi })}
            confirmLabel={t('sub_apply_profile_confirm')}
            cancelLabel={t('cancel')}
            isWorking={isApplyingProfile}
            confirmDisabled={!applyProfileName.trim() || profileList.length === 0}
            onConfirm={() => void executeProfileApply()}
            onCancel={() => { setProfileApplyTarget(null); setApplyProfileName(''); }}
          >
            <div>
              <label className="form-label" htmlFor="subscriber-apply-profile-select">{t('profile_template')}</label>
              <select
                id="subscriber-apply-profile-select"
                className="form-input"
                value={applyProfileName}
                onChange={(event) => setApplyProfileName(event.target.value)}
                disabled={profileList.length === 0}
              >
                <option value="">{profileList.length > 0 ? t('sub_apply_profile_pick') : t('sub_no_profiles')}</option>
                {profileList.map((profile: { name: string; title?: string }) => (
                  <option key={profile.name} value={profile.name}>{profile.title || profile.name}</option>
                ))}
              </select>
            </div>
          </ConfirmActionPanel>
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
        />

        {searchTermInvalid && (
          <p className="warning-text" role="alert">{t('sub_search_invalid_hint')}</p>
        )}

        <SubscriberFilters
          filters={filters}
          planOptions={planOptions}
          onChange={handleFiltersChange}
          onReset={resetFilters}
        />

        {profileDrillDown && (
          <div className="page-action-bar" role="status">
            <span className="form-label">{t('sub_filter_profile', { name: profileDrillDown })}</span>
            <button type="button" className="btn btn-outline" onClick={clearProfileDrillDown}>
              {t('sub_filter_reset')}
            </button>
          </div>
        )}

        <div className="dash-card shadow table-card">
          {listReloadFailed && (
            <p className="warning-text" role="alert">{t('sub_err_list_load')} {listErrorMessage}</p>
          )}
          {listUnavailable ? (
            <ErrorState
              title={t('sub_err_list_load')}
              message={listErrorMessage}
              retryLabel={t('retry')}
              onRetry={() => { void mutateSubscribers(); }}
            />
          ) : (
            <>
              <SubscriberTable
                isLoading={isLoading}
                totalSubscribers={totalSubscribers}
                searchQuery={subscriberQuery}
                hasActiveFilters={hasActiveFilters}
                canEditSubscribers={canEditSubscribers}
                canAdjustBalance={canAdjustBalance}
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
                formatFullDate={formatFullDate}
                timeAgo={timeAgo}
                handleOpenView={handleOpenView}
                handleDelete={handleDelete}
                isDeletingSingle={isDeletingSingle}
                pendingDelete={pendingDelete}
                activeDropdown={activeDropdown}
                setActiveDropdown={setActiveDropdown}
                handleOpenTrafficAdjustment={handleOpenTrafficAdjustment}
                handleOpenProfileApply={handleOpenProfileApply}
                profiles={profileList}
                profilesReady={Boolean(profileData)}
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
            </>
          )}
        </div>
      </div>

      <BatchCreateModal
        isOpen={isBatchOpen}
        onClose={() => setIsBatchOpen(false)}
        onSuccess={() => { void mutateSubscribers(); }}
        profileList={profileList}
      />

      {trafficAdjustmentTarget && (
        <TrafficAdjustmentModal
          imsi={trafficAdjustmentTarget.imsi}
          t={t}
          currentTraffic={trafficAdjustmentTarget.traffic}
          onClose={() => setTrafficAdjustmentTarget(null)}
          onSuccess={() => {
            void mutateSubscribers();
            setFeedback({ tone: 'success', title: t('success'), message: t('traffic_success') });
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
