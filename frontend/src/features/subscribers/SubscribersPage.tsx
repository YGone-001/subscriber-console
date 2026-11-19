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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { ArrowDown, ArrowUp, ArrowUpDown, Layers } from 'lucide-react';
import BatchCreateModal from '../../components/BatchCreateModal';
import SubscriberBatchUpdateModal from '../../components/SubscriberBatchUpdateModal';
import { SubscriberImportModal } from './components/SubscriberImportModal';
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
import { currentListLocation, withReturnTo } from '../../lib/return-to';
import { buildProfileApplyPreviewRequest, buildProfileApplyRequest } from './mutation-contract';
import { ProfileApplyPreviewNotice } from '../profiles/components/ProfileApplyPreviewNotice';
import type { ProfileApplyPreview } from '../profiles/profile-apply-preview';
import {
  DEFAULT_SUBSCRIBER_FILTERS,
  SUBSCRIBER_PAGE_SIZES,
  buildSubscriberListApiUrl,
  clampSubscriberPage,
  isValidSubscriberSearchTerm,
  subscriberSelectionScopeKey,
  type SubscriberSortField,
} from './subscriber-list-query';
import { useSubscriberListQuery } from './use-subscriber-list-query';
import { useSubscriberSelection } from './use-subscriber-selection';
import type {
  FeedbackState,
  PendingDelete,
  PlmnRecord,
  ProfilesResponse,
  SubscriberFilters as SubscriberFilterState,
  SubscriberRow,
  SubscriberSummaryKey,
  SubscribersResponse,
} from './types';

function formatFullDate(dStr: string) {
  if (!dStr) return '';
  const d = new Date(dStr);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

export function SubscribersPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const router = useAppRouter();
  const canEditSubscribers = hasPermission(user, 'subscribers.write');

  const [searchQuery, setSearchQuery] = useState('');
  const [isDeletingBulk, setIsDeletingBulk] = useState(false);
  const [isBatchUpdateModalOpen, setIsBatchUpdateModalOpen] = useState(false);
  const [activeDropdown, setActiveDropdown] = useState<string | null>(null);
  const [copiedImsi, setCopiedImsi] = useState<string | null>(null);
  const [trafficAdjustmentTarget, setTrafficAdjustmentTarget] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<FeedbackState | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [isDeletingSingle, setIsDeletingSingle] = useState<string | null>(null);

  /* Persistent list state (page, size, sort, filters, profile drill-down) is
   * owned by the URL. Search is intentionally memory-only: a search term can be
   * an IMSI, so it is never written into browser history or shared links. */
  const {
    query: listQuery,
    setPage: setQueryPage,
    setSize: setQuerySize,
    setSort: setQuerySort,
    setFilters: setQueryFilters,
    clearProfile,
  } = useSubscriberListQuery();
  const {
    filters,
    page: currentPage,
    size: pageSize,
    sort: sortField,
    order: sortDirection,
    profile: profileDrillDown,
  } = listQuery;

  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');

  const [isBatchOpen, setIsBatchOpen] = useState(false);
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [profileApplyTarget, setProfileApplyTarget] = useState<SubscriberRow | null>(null);
  const [applyProfileName, setApplyProfileName] = useState('');
  const [isApplyingProfile, setIsApplyingProfile] = useState(false);
  const [applyPreview, setApplyPreview] = useState<ProfileApplyPreview | null>(null);
  const [isPreviewingProfile, setIsPreviewingProfile] = useState(false);
  const [applyPreviewError, setApplyPreviewError] = useState('');
  const applyPreviewToken = useRef(0);

  const location = useLocation();
  const listLocation = currentListLocation(location.pathname, location.search);

  const timeAgo = useCallback((dateStr: string) => {
    if (!dateStr) return t('unknown');
    const time = new Date(dateStr).getTime();
    const now = new Date().getTime();
    const diff = Math.floor((now - time) / 1000);
    if (diff < 60) return t('just_now');
    if (diff < 3600) return `${Math.floor(diff / 60)} ${t('mins_ago')}`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} ${t('hours_ago')}`;
    return `${Math.floor(diff / 86400)} ${t('days_ago')}`;
  }, [t]);

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
    if (isValidSubscriberSearchTerm(debouncedSearchQuery)) lastValidSearchRef.current = debouncedSearchQuery;
  }, [debouncedSearchQuery]);
  const searchTermInvalid = !isValidSubscriberSearchTerm(searchQuery.trim());
  const subscriberQuery = isValidSubscriberSearchTerm(debouncedSearchQuery)
    ? debouncedSearchQuery
    : lastValidSearchRef.current;

  const selectionScope = useMemo(
    () => subscriberSelectionScopeKey(listQuery, searchQuery),
    [listQuery, searchQuery],
  );
  const { selectedImsis, setSelectedImsis } = useSubscriberSelection(selectionScope);
  const selectionScopeRef = useRef(selectionScope);
  selectionScopeRef.current = selectionScope;
  const listStaleRef = useRef(false);

  const subscribersUrl = buildSubscriberListApiUrl(listQuery, subscriberQuery);
  const { data: subscribersData, isLoading, error: subscribersError, isValidating, mutate: mutateSubscribers } = useRead<SubscribersResponse>(subscribersUrl);

  /* Query-to-data identity: `keepPreviousData` may display the previous page
   * while a new key loads. Only a successful settle of the active URL confirms
   * the rows; until then they are explicitly stale and cannot authorize
   * selection or destructive actions. */
  const [confirmedListUrl, setConfirmedListUrl] = useState(subscribersUrl);
  useEffect(() => {
    if (isValidating || subscribersError || !subscribersData) return;
    setConfirmedListUrl(subscribersUrl);
  }, [isValidating, subscribersData, subscribersError, subscribersUrl]);
  const listStale = Boolean(subscribersData) && confirmedListUrl !== subscribersUrl;
  listStaleRef.current = listStale;
  /* SWR reports `isLoading` for a new key even when previous data is retained.
   * The table can still render those rows when they exist; the stale banner
   * distinguishes them and every action callback refuses stale input. */
  const listLoading = isLoading && !subscribersData;

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

  /* The draft is memory-only and is never written into the URL. A search change
   * still resets pagination, using `replace` so typing cannot fill history. */
  const handleSearchDraftChange = useCallback((value: string) => {
    setSearchQuery(value);
    if (currentPage !== 1) setQueryPage(1, { replace: true });
  }, [currentPage, setQueryPage]);

  /* A filter, sort, size, profile or search change invalidates every workflow
   * target that was chosen under the previous query. Page navigation is excluded
   * from this scope and therefore preserves the established selection. */
  useEffect(() => {
    setPendingDelete(null);
    setIsBatchUpdateModalOpen(false);
    setProfileApplyTarget(null);
    setApplyProfileName('');
    setApplyPreview(null);
    setApplyPreviewError('');
    setTrafficAdjustmentTarget(null);
    setActiveDropdown(null);
  }, [selectionScope]);

  const handleOpenNew = useCallback(() => {
    router.push(withReturnTo('/subscribers/new', listLocation));
  }, [router, listLocation]);

  const handleOpenView = useCallback((imsi: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    router.push(withReturnTo(`/subscribers/${encodeURIComponent(imsi)}`, listLocation));
  }, [router, listLocation]);

  const handleDelete = useCallback((imsi: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    if (listStaleRef.current) return;
    setActiveDropdown(null);
    setPendingDelete({ mode: 'single', imsis: [imsi], scope: selectionScopeRef.current });
  }, []);

  const handleOpenTrafficAdjustment = useCallback((sub: SubscriberRow, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    if (listStaleRef.current) return;
    setActiveDropdown(null);
    setTrafficAdjustmentTarget(sub.imsi);
  }, []);

  const handleOpenProfileApply = useCallback((sub: SubscriberRow) => {
    if (listStaleRef.current) return;
    setProfileApplyTarget(sub);
    setApplyProfileName('');
    setApplyPreview(null);
    setApplyPreviewError('');
  }, []);

  /* The memoized table must keep a stable selection setter even while a query
   * transition makes the currently visible rows provisional. */
  const handleSelectedImsisChange = useCallback<React.Dispatch<React.SetStateAction<string[]>>>((value) => {
    if (listStaleRef.current) return;
    setSelectedImsis(value);
  }, [setSelectedImsis]);

  useEffect(() => {
    if (!profileApplyTarget || !applyProfileName) {
      setApplyPreview(null);
      setApplyPreviewError('');
      return;
    }
    const token = ++applyPreviewToken.current;
    const timer = window.setTimeout(async () => {
      setIsPreviewingProfile(true);
      setApplyPreview(null);
      setApplyPreviewError('');
      try {
        const response = await postJson<{ preview?: ProfileApplyPreview }>(
          `/api/subscribers/${encodeURIComponent(profileApplyTarget.imsi)}/profile`,
          buildProfileApplyPreviewRequest(applyProfileName),
        );
        if (applyPreviewToken.current !== token) return;
        setApplyPreview(response?.preview ?? null);
      } catch (error) {
        if (applyPreviewToken.current !== token) return;
        setApplyPreviewError(error instanceof Error ? error.message : String(error));
      } finally {
        if (applyPreviewToken.current === token) setIsPreviewingProfile(false);
      }
    }, 250);
    return () => {
      window.clearTimeout(timer);
      applyPreviewToken.current += 1;
    };
  }, [applyProfileName, profileApplyTarget]);

  const executeProfileApply = async () => {
    if (!profileApplyTarget) return;
    const targetImsi = profileApplyTarget.imsi;
    const profileName = applyProfileName.trim();
    if (!profileName || !applyPreview?.previewToken || applyPreview.noEffect) return;
    setIsApplyingProfile(true);
    try {
      const data = await postJson<{ outcome?: string; message?: string }>(
        `/api/subscribers/${encodeURIComponent(targetImsi)}/profile`,
        buildProfileApplyRequest(profileName, applyPreview.previewToken),
      );
      setProfileApplyTarget(null);
      setApplyProfileName('');
      setApplyPreview(null);
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
      setApplyPreview(null);
      setApplyPreviewError(detail || t('error'));
    } finally {
      setIsApplyingProfile(false);
    }
  };

  const clearProfileDrillDown = () => {
    clearProfile();
  };

  const handleBulkDelete = () => {
    if (selectedImsis.length === 0 || listStale || !subscribersData) return;
    setPendingDelete({ mode: 'bulk', imsis: [...selectedImsis], scope: selectionScope });
  };

  const executePendingDelete = async () => {
    if (!pendingDelete || pendingDelete.imsis.length === 0) return;
    /* A queued destructive action belongs to the query that produced it. If the
     * query changed after confirmation opened, the target set is obsolete. */
    if (pendingDelete.scope !== selectionScope || listStale) {
      setPendingDelete(null);
      return;
    }

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

  /* O(1) PLMN lookup: the catalog holds 20k+ records, so parsing is cached. */
  const plmnMap = useMemo(() => {
    const map = new Map<string, PlmnRecord>();
    mccMncDb.forEach((item) => { map.set(`${item.mcc}${item.mnc}`, item); });
    return map;
  }, [mccMncDb]);

  /* Longest-prefix match so both 2-digit and 3-digit MNC networks resolve. */
  const resolveNetwork = useCallback((imsi: string) => {
    if (!imsi || imsi.length < 5) return { plmn: 'N/A', network: 'Unknown', country: 'Unknown' };
    const prefix6 = imsi.substring(0, 6);
    if (plmnMap.has(prefix6)) return { plmn: prefix6, ...plmnMap.get(prefix6) };
    const prefix5 = imsi.substring(0, 5);
    if (plmnMap.has(prefix5)) return { plmn: prefix5, ...plmnMap.get(prefix5) };
    return { plmn: prefix5, network: 'Unknown', country: 'Unknown' };
  }, [plmnMap]);

  const handleSort = useCallback((field: string) => {
    setQuerySort(field as SubscriberSortField);
  }, [setQuerySort]);

  const handleFiltersChange = (next: SubscriberFilterState) => {
    setQueryFilters(next);
  };

  const resetFilters = () => {
    setQueryFilters(DEFAULT_SUBSCRIBER_FILTERS);
  };

  const handleSummarySelect = (key: SubscriberSummaryKey) => {
    if (key === 'all') {
      resetFilters();
      return;
    }
    if (key === 'unprovisioned') {
      handleFiltersChange({ ...DEFAULT_SUBSCRIBER_FILTERS, provisioning: 'incomplete' });
      return;
    }
    if (key === 'lowBalance') {
      handleFiltersChange({ ...DEFAULT_SUBSCRIBER_FILTERS, balance: 'low' });
      return;
    }
    handleFiltersChange({ ...DEFAULT_SUBSCRIBER_FILTERS, access: key });
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
  /* The table is memoized, so its props must stay referentially stable while
   * the query state changes. Deriving this array on every page render rebuilt
   * both pageImsis and toggleSelectAll and defeated the memo on every keystroke. */
  const pageImsis = useMemo(() => paginatedSubscribers.map((s) => s.imsi), [paginatedSubscribers]);
  const selectedOnPageCount = pageImsis.filter((imsi) => selectedImsis.includes(imsi)).length;
  const isAllPageSelected = pageImsis.length > 0 && selectedOnPageCount === pageImsis.length;

  const toggleSelectAll = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (listStaleRef.current) return;
    if (e.target.checked) {
      setSelectedImsis((prev) => Array.from(new Set([...prev, ...pageImsis])));
    } else {
      setSelectedImsis((prev) => prev.filter((imsi) => !pageImsis.includes(imsi)));
    }
  }, [pageImsis]);
  const pendingDeleteItems = pendingDelete?.imsis.slice(0, 3).join(', ') || '';
  const pendingDeleteOverflow = pendingDelete && pendingDelete.imsis.length > 3 ? ` +${pendingDelete.imsis.length - 3}` : '';

  /* A successful read may prove the URL page is past the end (for example after
   * deletion). Correct it with `replace`, and never derive a clamp from rows that
   * are still marked stale for a newer query. */
  useEffect(() => {
    if (!subscribersData || listStale) return;
    const clamped = clampSubscriberPage(listQuery, totalSubscribers, pageSize);
    if (clamped !== listQuery.page) setQueryPage(clamped, { replace: true });
  }, [listQuery, listStale, pageSize, setQueryPage, subscribersData, totalSubscribers]);

  const handleCopyImsi = useCallback(async (imsi: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    if (!(await copyText(imsi))) return;
    setCopiedImsi(imsi);
    window.setTimeout(() => setCopiedImsi((current) => (current === imsi ? null : current)), 1400);
  }, []);

  const renderSortIcon = useCallback((field: string) => {
    if (sortField !== field) return <ArrowUpDown size={14} className="sort-icon muted" />;
    return sortDirection === 'asc'
      ? <ArrowUp size={14} className="sort-icon active" />
      : <ArrowDown size={14} className="sort-icon active" />;
  }, [sortDirection, sortField]);

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
        {!listUnavailable && !listStale && (
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
            confirmDisabled={!applyProfileName.trim() || profileList.length === 0 || !applyPreview || applyPreview.noEffect || isPreviewingProfile || Boolean(applyPreviewError)}
            onConfirm={() => void executeProfileApply()}
            onCancel={() => {
              setProfileApplyTarget(null);
              setApplyProfileName('');
              setApplyPreview(null);
              setApplyPreviewError('');
            }}
          >
            <div>
              <label className="form-label" htmlFor="subscriber-apply-profile-select">{t('profile_template')}</label>
              <select
                id="subscriber-apply-profile-select"
                className="form-input"
                value={applyProfileName}
                onChange={(event) => {
                  setApplyProfileName(event.target.value);
                  setApplyPreview(null);
                  setApplyPreviewError('');
                }}
                disabled={profileList.length === 0}
              >
                <option value="">{profileList.length > 0 ? t('sub_apply_profile_pick') : t('sub_no_profiles')}</option>
                {profileList.map((profile: { name: string; title?: string }) => (
                  <option key={profile.name} value={profile.name}>{profile.title || profile.name}</option>
                ))}
              </select>
            </div>
            <ProfileApplyPreviewNotice preview={applyPreview} loading={isPreviewingProfile} error={applyPreviewError} />
          </ConfirmActionPanel>
        )}

        <SubscriberToolbar
          searchQuery={searchQuery}
          onSearchChange={handleSearchDraftChange}
          selectedImsis={selectedImsis}
          canEditSubscribers={canEditSubscribers}
          bulkActionsDisabled={listStale || !subscribersData}
          setIsBatchUpdateModalOpen={setIsBatchUpdateModalOpen}
          handleBulkDelete={handleBulkDelete}
          isDeletingBulk={isDeletingBulk}
          pendingDelete={pendingDelete}
          handleOpenNew={handleOpenNew}
          setIsBatchOpen={setIsBatchOpen}
          onOpenImport={() => setIsImportOpen(true)}
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
          {listStale && (
            <p className="warning-text" role="status" data-subscriber-list-stale="true">{t('sub_list_updating')}</p>
          )}
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
                isLoading={listLoading}
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
                setSelectedImsis={handleSelectedImsisChange}
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
              {!isLoading && !listStale && (
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
                  onPageChange={(next) => setQueryPage(next)}
                  onPageSizeChange={(size) => setQuerySize(size as (typeof SUBSCRIBER_PAGE_SIZES)[number])}
                />
              )}
            </>
          )}
        </div>
      </div>

      <SubscriberImportModal
        isOpen={isImportOpen}
        onClose={() => setIsImportOpen(false)}
        onImported={() => { void mutateSubscribers(); }}
      />

      <BatchCreateModal
        isOpen={isBatchOpen}
        onClose={() => setIsBatchOpen(false)}
        onSuccess={() => { void mutateSubscribers(); }}
        profileList={profileList}
      />

      {trafficAdjustmentTarget && (
        <TrafficAdjustmentModal
          imsi={trafficAdjustmentTarget}
          t={t}
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
