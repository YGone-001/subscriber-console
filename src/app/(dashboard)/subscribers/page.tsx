"use client";

import React, { useEffect, useState, useMemo } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Plus, Layers } from "lucide-react";
import SubscriberModal from "@/components/SubscriberModal";
import BatchCreateModal from "@/components/BatchCreateModal";
import BulkPolicyModal from "@/components/BulkPolicyModal";
import DataHub from "@/components/DataHub";
import { ConfirmActionPanel, OperationNotice } from "@/components/OperationFeedback";
import { useI18n } from "@/components/I18nProvider";
import useSWR from "swr";
import { fetcher } from "@/lib/fetcher";
import { useAuth } from "@/hooks/useAuth";
import TrafficAdjustmentModal from "@/components/TrafficAdjustmentModal";
import SubscriberTraceModal from "@/components/SubscriberTraceModal";
import SubscriberSummaryPanel from "./components/SubscriberSummaryPanel";
import SubscriberPagination from "./components/SubscriberPagination";
import "./subscribers.css";
import { SubscriberToolbar } from "./components/SubscriberToolbar";
import { SubscriberTable } from "./components/SubscriberTable";
import PageHeader from "@/components/ui/PageHeader";

import { PlmnRecord, SubscriberRow, TrafficAdjustmentMode, TrafficAdjustmentTarget, FeedbackState, PendingDelete, SubscriberStatusFilter, ProfilesResponse, SubscribersResponse } from "./types";

/**
 * Subscriber Management Page
 * Dedicated to IMSI data table operations:
 * 1. Search, sort, paginate subscriber roster
 * 2. Single subscriber add/edit modal (SubscriberModal)
 * 3. Batch creation modal (BatchModal)
 * Note: Analytics dashboard has been moved to the root Dashboard page.
 */
export default function SubscriberPage() {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedImsis, setSelectedImsis] = useState<string[]>([]);
  const [isDeletingBulk, setIsDeletingBulk] = useState(false);
  const [isPolicyModalOpen, setIsPolicyModalOpen] = useState(false);
  const [activeDropdown, setActiveDropdown] = useState<string | null>(null);
  const [isDataHubOpen, setIsDataHubOpen] = useState(false);
  const [copiedImsi, setCopiedImsi] = useState<string | null>(null);
  const [traceImsi, setTraceImsi] = useState<string | null>(null);
  const [trafficAdjustmentTarget, setTrafficAdjustmentTarget] = useState<TrafficAdjustmentTarget | null>(null);
  const [feedback, setFeedback] = useState<FeedbackState | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [isDeletingSingle, setIsDeletingSingle] = useState<string | null>(null);
  const { t } = useI18n();
  const { canEditSubscribers } = useAuth();

  /**
   * Batch selection state management - Hook notes:
   * `selectedImsis` stores all cross-page checked IMSI primary keys.
   * Select-all `toggleSelectAll` filters based on current page visible items.
   * Single-select toggles existence state.
   */

  // Relative time conversion
  const timeAgo = (dateStr: string) => {
    if (!dateStr) return t("never");
    const time = new Date(dateStr).getTime();
    const now = new Date().getTime();
    const diff = Math.floor((now - time) / 1000);
    if (diff < 60) return t("just_now");
    if (diff < 3600) return `${Math.floor(diff / 60)} ${t("mins_ago")}`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} ${t("hours_ago")}`;
    return `${Math.floor(diff / 86400)} ${t("days_ago")}`;
  };

  // Full date format (YYYY-MM-DD HH:mm:ss)
  const formatFullDate = (dStr: string) => {
    if (!dStr) return '';
    const d = new Date(dStr);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
  };

  // Global PLMN Database
  const { data: mccMncDbData } = useSWR("/data/mcc-mnc-table.json", fetcher, { revalidateOnFocus: false });
  const mccMncDb = useMemo(() => (mccMncDbData || []) as PlmnRecord[], [mccMncDbData]);

  // Table Additions
  const [sortField, setSortField] = useState<string>("imsi");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [statusFilter, setStatusFilter] = useState<SubscriberStatusFilter>("all");

  const subscriberQuery = searchQuery.trim();
  const subscribersUrl = `/api/subscribers?detail=true&page=${currentPage}&limit=${pageSize}${subscriberQuery ? `&q=${encodeURIComponent(subscriberQuery)}` : ""}${statusFilter !== "all" ? `&status=${statusFilter}` : ""}&sortField=${sortField}&sortDirection=${sortDirection}`;
  const { data: subscribersData, isLoading, mutate: mutateSubscribers } = useSWR<SubscribersResponse>(subscribersUrl, fetcher, {
    keepPreviousData: true,
  });
  const subscribers = subscribersData?.subscribers || [];
  const totalSubscribers = subscribersData?.total || 0;
  const subscriberSummary = subscribersData?.summary || {
    total: totalSubscribers,
    active: 0,
    restricted: 0,
    lowTraffic: 0,
  };

  // General modal state
  const [modalImsi, setModalImsi] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);

  // Batch creation modal state
  const [isBatchOpen, setIsBatchOpen] = useState(false);

  // Profile list for batch creation dropdowns
  const { data: profileData } = useSWR<ProfilesResponse>("/api/profiles", fetcher);
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
    setPendingDelete({ mode: "single", imsis: [imsi] });
  };

  const handleOpenTrafficAdjustment = (sub: SubscriberRow, mode: TrafficAdjustmentMode, e: React.MouseEvent) => {
    e.stopPropagation();
    setActiveDropdown(null);
    const used = sub.traffic?.used || 0;
    const total = sub.traffic?.total || 0;
    const balance = sub.traffic?.balance ?? Math.max(0, total - used);
    setTrafficAdjustmentTarget({
      imsi: sub.imsi,
      traffic: { used, total, balance },
      mode,
    });
  };

  const handleBulkDelete = () => {
    if (selectedImsis.length === 0) return;
    setPendingDelete({ mode: "bulk", imsis: [...selectedImsis] });
  };

  const executePendingDelete = async () => {
    if (!pendingDelete || pendingDelete.imsis.length === 0) return;

    const { mode, imsis } = pendingDelete;
    const singleImsi = imsis[0] || "";
    if (mode === "bulk") setIsDeletingBulk(true);
    if (mode === "single") setIsDeletingSingle(singleImsi);
    try {
      if (mode === "bulk") {
        const res = await fetch("/api/subscribers/bulk-delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ imsiList: imsis }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Bulk delete failed.");
        setSelectedImsis([]);
        setPendingDelete(null);
        setFeedback({
          tone: "success",
          title: t("sub_feedback_success_title"),
          message: data.approval?.id
            ? t("approval_msg_submitted", { id: data.approval.id })
            : t("sub_feedback_bulk_delete_success", { count: data.deleted ?? imsis.length }),
        });
        if (!data.approval?.id) await mutateSubscribers();
        return;
      }

      const res = await fetch(`/api/subscribers/${singleImsi}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Delete request failed.");
      setFeedback({
        tone: "success",
        title: t("sub_feedback_success_title"),
        message: t("sub_feedback_delete_success", { imsi: singleImsi }),
      });
      setPendingDelete(null);
      await mutateSubscribers();
    } catch (error) {
      console.error("Failed to perform subscriber delete", error);
      setFeedback({
        tone: "danger",
        title: t("sub_feedback_error_title"),
        message: mode === "bulk" ? t("sub_feedback_bulk_delete_error") : t("sub_feedback_delete_error", { imsi: singleImsi }),
      });
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

  /**
   * Build high-performance PLMN lookup index (O(1)).
   * Uses useMemo to cache parsing logic, avoiding lag from 20k+ records.
   */
  const plmnMap = useMemo(() => {
    const map = new Map<string, PlmnRecord>();
    mccMncDb.forEach((item) => {
      // 存储格式: "MCCMNC" -> Record
      map.set(`${item.mcc}${item.mnc}`, item);
    });
    return map;
  }, [mccMncDb]);

  /**
   * 核心解析算法 (Longest Prefix Match)
   * Supports global 2-digit and 3-digit MNC identification.
   */
  const resolveNetwork = (imsi: string) => {
    if (!imsi || imsi.length < 5) return { plmn: "N/A", network: "Unknown", country: "Unknown" };

    // 1. Try 6-digit match first (MCC + 3-digit MNC) - highest priority
    const prefix6 = imsi.substring(0, 6);
    if (plmnMap.has(prefix6)) {
      const match = plmnMap.get(prefix6);
      return { plmn: prefix6, ...match };
    }

    // 2. Then try 5-digit match (MCC + 2-digit MNC)
    const prefix5 = imsi.substring(0, 5);
    if (plmnMap.has(prefix5)) {
      const match = plmnMap.get(prefix5);
      return { plmn: prefix5, ...match };
    }

    // 3. No match found
    return { plmn: prefix5, network: "Unknown", country: "Unknown" };
  };

  const handleSort = (field: string) => {
    if (sortField === field) {
      setSortDirection(sortDirection === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDirection("asc");
    }
  };

  const applyStatusFilter = (nextFilter: SubscriberStatusFilter) => {
    setStatusFilter(nextFilter);
    setCurrentPage(1);
    setSelectedImsis([]);
  };

  const summaryCards = [
    { key: "all" as const, label: t("subscriber_summary_total"), value: subscriberSummary.total, tone: "primary" },
    { key: "active" as const, label: t("subscriber_summary_active"), value: subscriberSummary.active, tone: "success" },
    { key: "restricted" as const, label: t("subscriber_summary_restricted"), value: subscriberSummary.restricted, tone: "danger" },
    { key: "lowTraffic" as const, label: t("subscriber_summary_low_traffic"), value: subscriberSummary.lowTraffic, tone: "warning" },
  ] as const;

  const totalPages = Math.max(1, Math.ceil(totalSubscribers / pageSize));
  const displayPage = Math.min(currentPage, totalPages);
  const paginatedSubscribers = subscribers;
  const pageImsis = paginatedSubscribers.map((s) => s.imsi);
  const selectedOnPageCount = pageImsis.filter((imsi) => selectedImsis.includes(imsi)).length;
  const isAllPageSelected = pageImsis.length > 0 && selectedOnPageCount === pageImsis.length;
  const pendingDeleteItems = pendingDelete?.imsis.slice(0, 3).join(", ") || "";
  const pendingDeleteOverflow = pendingDelete && pendingDelete.imsis.length > 3 ? ` +${pendingDelete.imsis.length - 3}` : "";

  useEffect(() => {
    if (subscribersData && currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, subscribersData, totalPages]);

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024, sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const handleCopyImsi = async (imsi: string, e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(imsi);
      setCopiedImsi(imsi);
      window.setTimeout(() => setCopiedImsi((current) => current === imsi ? null : current), 1400);
    } catch (error) {
      console.error("Failed to copy IMSI", error);
    }
  };

  const renderSortIcon = (field: string) => {
    if (sortField !== field) return <ArrowUpDown size={14} className="sort-icon muted" />;
    return sortDirection === "asc" ? <ArrowUp size={14} className="sort-icon active" /> : <ArrowDown size={14} className="sort-icon active" />;
  };

  const getPageNumbers = () => {
    const maxButtons = 5;
    const start = Math.max(1, Math.min(displayPage - 2, totalPages - maxButtons + 1));
    const end = Math.min(totalPages, start + maxButtons - 1);
    return Array.from({ length: end - start + 1 }, (_, index) => start + index);
  };

  return (
    <>
    <div className="subscribers-page-container animate-fade-in" onClick={() => setActiveDropdown(null)}>

      <PageHeader
        eyebrow="IMSI / HSS"
        icon={<Layers size={23} />}
        title={t("subscriber_title")}
        description={t("subscriber_subtitle")}
      />

      <SubscriberSummaryPanel
        summaryCards={summaryCards}
        statusFilter={statusFilter} 
        applyStatusFilter={applyStatusFilter} 
      />

      {feedback && (
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
          title={pendingDelete.mode === "bulk" ? t("sub_confirm_bulk_delete_title", { count: pendingDelete.imsis.length }) : t("sub_confirm_delete_title")}
          message={
            pendingDelete.mode === "bulk"
              ? t("sub_confirm_bulk_delete_desc", { items: `${pendingDeleteItems}${pendingDeleteOverflow}` })
              : t("sub_confirm_delete_desc", { items: pendingDeleteItems })
          }
          confirmLabel={t("delete")}
          cancelLabel={t("cancel")}
          isWorking={isDeletingBulk || Boolean(isDeletingSingle)}
          onConfirm={executePendingDelete}
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
        setIsPolicyModalOpen={setIsPolicyModalOpen}
        setIsDataHubOpen={setIsDataHubOpen}
        handleBulkDelete={handleBulkDelete}
        isDeletingBulk={isDeletingBulk}
        pendingDelete={pendingDelete}
        handleOpenNew={handleOpenNew}
        setIsBatchOpen={setIsBatchOpen}
        mutateSubscribers={mutateSubscribers}
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
          setTraceImsi={setTraceImsi}
          handleOpenTrafficAdjustment={handleOpenTrafficAdjustment}
        />
        {!isLoading && (
          <SubscriberPagination
            currentPage={currentPage}
            totalPages={totalPages}
            displayPage={displayPage}
            pageSize={pageSize}
            totalSubscribers={totalSubscribers}
            getPageNumbers={getPageNumbers}
            setPageSize={setPageSize}
            setCurrentPage={setCurrentPage}
          />
        )}
      </div>
    </div>

      {/* FAB: Single Add */}
      <button
        className="fab"
        onClick={handleOpenNew}
        title={t("add_subscriber")}
        aria-label={t("add_subscriber")}
      >
        <Plus size={28} />
      </button>

      {/* FAB: Batch Create (positioned above single FAB) */}
      <button
        className="fab fab-secondary"
        onClick={() => setIsBatchOpen(true)}
        title={t("batch_create")}
        aria-label={t("batch_create")}
        style={{ bottom: "120px" }}
      >
        <Layers size={24} />
      </button>

      <BatchCreateModal
        isOpen={isBatchOpen}
        onClose={() => setIsBatchOpen(false)}
        onSuccess={() => mutateSubscribers()}
        profileList={profileList}
      />

      {isModalOpen && (
        <SubscriberModal
          imsi={modalImsi}
          onClose={() => setIsModalOpen(false)}
          onRefresh={() => mutateSubscribers()}
        />
      )}

      {trafficAdjustmentTarget && (
        <TrafficAdjustmentModal
          imsi={trafficAdjustmentTarget.imsi}
          t={t}
          defaultMode={trafficAdjustmentTarget.mode}
          currentTraffic={trafficAdjustmentTarget.traffic}
          onClose={() => setTrafficAdjustmentTarget(null)}
          onSuccess={(response) => {
            if (response?.approval?.id) {
              setFeedback({
                tone: "success",
                title: t("success"),
                message: t("approval_msg_submitted", { id: response.approval.id }),
              });
              return;
            }
            mutateSubscribers();
            setFeedback({
              tone: "success",
              title: t("success"),
              message: t("traffic_adjust_title"),
            });
          }}
        />
      )}

      <BulkPolicyModal
        isOpen={isPolicyModalOpen}
        selectedImsis={selectedImsis}
        t={t}
        onClose={() => setIsPolicyModalOpen(false)}
        onSuccess={(response) => {
          setSelectedImsis([]);
          if (response?.approval?.id) {
            setFeedback({
              tone: "success",
              title: t("success"),
              message: t("approval_msg_submitted", { id: response.approval.id }),
            });
            return;
          }
          mutateSubscribers();
          setFeedback({
            tone: "success",
            title: t("success"),
            message: t("policy_change_title"),
          });
        }}
      />

      {traceImsi && (
        <SubscriberTraceModal
          imsi={traceImsi}
          t={t}
          onClose={() => setTraceImsi(null)}
        />
      )}

      {/* Data Hub Modal */}
      <DataHub
        isOpen={isDataHubOpen}
        onClose={() => setIsDataHubOpen(false)}
        onOperation={setFeedback}
        onComplete={() => {
          mutateSubscribers();
          setFeedback({
            tone: "success",
            title: t("success"),
            message: t("dh_import_complete"),
          });
        }}
        subscribers={subscribers}
        selectedImsis={selectedImsis}
      />
    </>
  );
}
