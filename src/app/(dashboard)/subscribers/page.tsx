"use client";

import React, { useEffect, useState, useMemo } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Plus, Layers, Download, Users, Trash2, DatabaseZap, PenLine, MoreHorizontal, Settings2, FileUp, Copy, CheckCircle2 } from "lucide-react";
import SubscriberModal from "@/components/SubscriberModal";
import BatchCreateModal from "@/components/BatchCreateModal";
import BulkPolicyModal from "@/components/BulkPolicyModal";
import DataHub from "@/components/DataHub";
import { ConfirmActionPanel, EmptyState, LoadingRows, OperationNotice, type FeedbackTone } from "@/components/OperationFeedback";
import { useI18n } from "@/components/I18nProvider";
import useSWR from "swr";
import { fetcher } from "@/lib/fetcher";
import { useAuth } from "@/hooks/useAuth";
import TrafficAdjustmentModal from "@/components/TrafficAdjustmentModal";
import SubscriberTraceModal from "@/components/SubscriberTraceModal";
import SubscriberSummaryPanel from "./components/SubscriberSummaryPanel";
import SubscriberPagination from "./components/SubscriberPagination";
import "./subscribers.css";

interface PlmnRecord {
  mcc: string;
  mnc: string;
  network?: string;
  country?: string;
  country_code?: string;
}

interface SubscriberRow {
  imsi: string;
  status: string;
  policy?: string;
  policyName?: string;
  policyStatus?: string;
  lastActive: string;
  ard?: number;
  traffic?: {
    used: number;
    total: number;
    balance?: number;
  };
  [key: string]: unknown;
}

type TrafficAdjustmentMode = "recharge" | "set_available" | "set_total" | "reset";

type TrafficAdjustmentTarget = {
  imsi: string;
  traffic: {
    used: number;
    total: number;
    balance: number;
  };
  mode: TrafficAdjustmentMode;
};

type FeedbackState = {
  tone: FeedbackTone;
  title?: string;
  message: string;
};

type PendingDelete = {
  mode: "single" | "bulk";
  imsis: string[];
};

type SubscriberStatusFilter = "all" | "active" | "restricted" | "lowTraffic";

type SubscriberSummary = {
  total: number;
  active: number;
  restricted: number;
  lowTraffic: number;
};

interface ProfilesResponse {
  profiles: Array<{ name: string; title?: string }>;
}

interface SubscribersResponse {
  subscribers: SubscriberRow[];
  total: number;
  page: number;
  limit: number;
  summary?: SubscriberSummary;
}

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
  const subscribersUrl = `/api/subscribers?detail=true&page=${currentPage}&limit=${pageSize}${subscriberQuery ? `&q=${encodeURIComponent(subscriberQuery)}` : ""}${statusFilter !== "all" ? `&status=${statusFilter}` : ""}`;
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
      // 瀛樺偍鏍煎紡: "MCCMNC" -> Record
      map.set(`${item.mcc}${item.mnc}`, item);
    });
    return map;
  }, [mccMncDb]);

  /**
   * 鏍稿績瑙ｆ瀽绠楁硶 (Longest Prefix Match)
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
  ];

  const sortedSubscribers = [...subscribers].sort((a, b) => {
    let valA = a[sortField] as any;
    let valB = b[sortField] as any;

    if (sortField === "usage") {
       valA = a.traffic?.used || 0;
       valB = b.traffic?.used || 0;
    } else if (sortField === "lastActive") {
       valA = new Date(a.lastActive).getTime();
       valB = new Date(b.lastActive).getTime();
    } else if (sortField === "plmn") {
       valA = resolveNetwork(a.imsi).plmn;
       valB = resolveNetwork(b.imsi).plmn;
    } else if (sortField === "policy") {
       valA = a.policyName || a.policy || "";
       valB = b.policyName || b.policy || "";
    }

    if (valA < valB) return sortDirection === "asc" ? -1 : 1;
    if (valA > valB) return sortDirection === "asc" ? 1 : -1;
    return 0;
  });

  const totalPages = Math.max(1, Math.ceil(totalSubscribers / pageSize));
  const displayPage = Math.min(currentPage, totalPages);
  const paginatedSubscribers = sortedSubscribers;
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

      {/* Page Header */}
      <div className="subscribers-page-header">
        <div>
          <h2 className="subscribers-page-title">
            {t("subscriber_title")}
          </h2>
          <p className="subscribers-page-subtitle">
            {t("subscriber_subtitle")}
          </p>
        </div>
      </div>

      <SubscriberSummaryPanel 
        summaryCards={summaryCards as any} 
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

      {/* Search, Bulk Action & Data Sync Bar */}
      <div className="page-action-bar">
        <div className="action-bar-left">
          <input
            type="search"
            className="form-input hover-glass search-input"
            placeholder={t("search_imsi")}
            value={searchQuery}
            onChange={e => { setSearchQuery(e.target.value); setCurrentPage(1); setSelectedImsis([]); }}
          />
          {selectedImsis.length > 0 && (
            <div className="bulk-actions-container animate-fade-in">
              <span className="bulk-actions-count">{selectedImsis.length} {t("selected")}</span>
              <div className="bulk-actions-buttons">
                {canEditSubscribers && (
                  <button className="btn btn-bulk-outline" onClick={() => setIsPolicyModalOpen(true)}>
                    <Settings2 size={14}/> {t("change_policy")}
                  </button>
                )}
                <button className="btn btn-bulk-outline" onClick={() => setIsDataHubOpen(true)}>
                  <Download size={14}/> {t("export_csv")}
                </button>
                {canEditSubscribers && (
                  <button className="btn-bulk-danger" onClick={handleBulkDelete} disabled={isDeletingBulk || Boolean(pendingDelete)}>
                    {isDeletingBulk ? <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }}/> : <Trash2 size={14}/>}
                    {t("delete")}
                  </button>
                )}
              </div>
            </div>
            )}
        </div>
        <div className="page-action-buttons">
           {canEditSubscribers && (
             <>
               <button
                 className="btn btn-primary btn-primary-padded"
                 onClick={handleOpenNew}
                 title={t("add_subscriber")}
               >
                 <Plus size={16} /> {t("add_subscriber")}
               </button>
               <button
                 className="btn btn-outline btn-primary-padded"
                 onClick={() => setIsBatchOpen(true)}
                 title={t("batch_create")}
               >
                 <Layers size={16} /> {t("batch_create")}
               </button>
             </>
           )}
           {/* Mini Sync Button replaces the giant banner */}
           <button
             onClick={async (e) => {
               const btn = e.currentTarget;
               const originalHTML = btn.innerHTML;
               btn.disabled = true;
               btn.classList.add('radar-animating');
               btn.innerHTML = `<span style="opacity: 0.5;">Scanning...</span>`;
               try {
                 const res = await fetch('/api/analytics/init', { method: 'POST' });
                 if (!res.ok) throw new Error(t("sync_error"));
                 await mutateSubscribers();
                 btn.innerHTML = `<span style="color:var(--success)">OK</span>`;
                 setFeedback({
                   tone: "success",
                   title: t("success"),
                   message: `${t("sync_telemetry")} ${t("sync_ok")}`,
                 });
                 setTimeout(() => {
                   btn.innerHTML = originalHTML;
                   btn.classList.remove('radar-animating');
                   btn.disabled = false;
                 }, 2000);
               } catch (error) {
                 btn.innerHTML = `Error`;
                 setFeedback({
                   tone: "danger",
                   title: t("error"),
                   message: error instanceof Error ? error.message : t("sync_error"),
                 });
                 setTimeout(() => {
                   btn.innerHTML = originalHTML;
                   btn.classList.remove('radar-animating');
                   btn.disabled = false;
                 }, 2000);
               }
             }}
             title={t("sync_tooltip")}
             className="btn-sync-telemetry"
           >
             <DatabaseZap size={14} color="var(--primary)" /> {t("sync_telemetry")}
           </button>
           <button
             onClick={() => setIsDataHubOpen(true)}
             title={t("datahub_tooltip")}
             className="btn-sync-telemetry"
           >
             <FileUp size={14} color="var(--primary)" /> {t("data_hub")}
           </button>
        </div>
      </div>

      {/* Main Data Table */}
      <div className="dash-card shadow table-card">
        {isLoading ? (
          <LoadingRows columns={canEditSubscribers ? 8 : 7} rows={5} />
        ) : totalSubscribers === 0 ? (
          <EmptyState
            icon={<Users size={48} />}
            title={searchQuery || statusFilter !== "all" ? t("no_subscribers_search") : t("no_subscribers_empty")}
            description={searchQuery || statusFilter !== "all" ? t("sub_empty_search_desc") : t("sub_empty_create_desc")}
            action={
              canEditSubscribers && !searchQuery && statusFilter === "all" ? (
                <button type="button" className="btn btn-primary" onClick={handleOpenNew}>
                  <Plus size={16} /> {t("add_subscriber")}
                </button>
              ) : undefined
            }
          />
        ) : (
          <div className="table-wrapper">
            <table className="subscribers-table">
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      className="checkbox-custom"
                      checked={isAllPageSelected}
                      ref={input => { if (input) input.indeterminate = selectedOnPageCount > 0 && selectedOnPageCount < pageImsis.length }}
                      onChange={toggleSelectAll}
                    />
                  </th>
                  <th className={sortField === "status" ? "sortable-th active" : "sortable-th"} onClick={() => handleSort("status")}>
                    <span>{t("col_status")}</span> {renderSortIcon("status")}
                  </th>
                  <th className={sortField === "imsi" ? "sortable-th active" : "sortable-th"} onClick={() => handleSort("imsi")}>
                    <span>{t("col_imsi")}</span> {renderSortIcon("imsi")}
                  </th>
                  <th className={sortField === "plmn" ? "sortable-th active" : "sortable-th"} onClick={() => handleSort("plmn")}>
                    <span>{t("col_plmn")}</span> {renderSortIcon("plmn")}
                  </th>
                  <th className={sortField === "policy" ? "sortable-th active" : "sortable-th"} onClick={() => handleSort("policy")}>
                    <span>{t("col_policy")}</span> {renderSortIcon("policy")}
                  </th>
                  <th className={sortField === "usage" ? "sortable-th active" : "sortable-th"} style={{ minWidth: "150px" }} onClick={() => handleSort("usage")}>
                    <span>{t("col_traffic")}</span> {renderSortIcon("usage")}
                  </th>
                  <th className={sortField === "lastActive" ? "sortable-th active" : "sortable-th"} onClick={() => handleSort("lastActive")}>
                    <span>{t("col_last_active")}</span> {renderSortIcon("lastActive")}
                  </th>
                  {canEditSubscribers && <th style={{ padding: "1rem", color: "var(--text-secondary)", fontWeight: 600, textAlign: "center" }}>{t("col_actions")}</th>}
                </tr>
              </thead>
              <tbody>
                {paginatedSubscribers.map((sub, index) => {
                   const uRatio = sub.traffic?.total ? (sub.traffic.used / sub.traffic.total) * 100 : 0;
                   const isSelected = selectedImsis.includes(sub.imsi);
                   return (
                     <tr key={sub.imsi} className={isSelected ? "selected-row" : ""}>
                       <td>
                         <input type="checkbox" className="checkbox-custom" checked={isSelected} onChange={() => setSelectedImsis(prev => prev.includes(sub.imsi) ? prev.filter(i => i !== sub.imsi) : [...prev, sub.imsi])} />
                       </td>
                       <td>
                         {(() => {
                           const isSuspended = sub.status === 'Suspended';
                           const isActive = sub.status === 'Active';
                           const isPartial = sub.status === 'Partial Restricted';

                           const MAPPING = [
                             { bit: 128, label: "5G" },
                             { bit: 64, label: "NB" },
                             { bit: 32, label: "Non-3GPP" },
                             { bit: 16, label: "4G" },
                             { bit: 8, label: "HSPA" },
                             { bit: 4, label: "GAN" },
                             { bit: 2, label: "2G" },
                             { bit: 1, label: "3G" }
                           ];

                           let tooltip = "";
                           if (isPartial && sub.ard != null) {
                             const ard = sub.ard;
                             tooltip = MAPPING.filter(item => (ard & item.bit)).map(item => item.label).join(', ');
                           }

                           return (
                             <span className={`status-badge ${isActive ? "active pill-active-pulse" : isSuspended ? "suspended" : "partial"} ${tooltip ? "has-tooltip" : ""}`} title={tooltip || undefined}>
                               {isActive ? t("status_active") : isSuspended ? t("status_suspended") : isPartial ? t("status_partial") : sub.status}
                             </span>
                           );
                         })()}
                       </td>
                       <td>
                         <div className="imsi-text-container">
                           <span className="imsi-text">{sub.imsi}</span>
                           <button
                             className={copiedImsi === sub.imsi ? "copy-btn copied" : "copy-btn"}
                             onClick={(event) => handleCopyImsi(sub.imsi, event)}
                             title={copiedImsi === sub.imsi ? "Copied" : "Copy IMSI"}
                           >
                             {copiedImsi === sub.imsi ? <CheckCircle2 size={14} /> : <Copy size={14} />}
                           </button>
                         </div>
                       </td>
                       <td>
                         {(() => {
                            const net = resolveNetwork(sub.imsi);
                            const tooltipText = net.network !== 'Unknown'
                              ? `${net.network} - ${net.country}${net.country_code ? ' (+' + net.country_code + ')' : ''}`
                              : t("unknown_network");
                            return (
                              <span title={tooltipText} className="plmn-badge">{net.plmn}</span>
                            );
                         })()}
                       </td>
                        <td>
                           {sub.policy ? (
                             <div className="policy-container">
                               <span title={sub.policy} className="policy-text">
                                 {sub.policyName || sub.policy}
                               </span>
                               <span className="policy-subtext">
                                 {sub.policy}
                                 {sub.policyStatus === "disabled" && (
                                   <span className="policy-disabled">
                                     {t("users_disabled")}
                                   </span>
                                 )}
                               </span>
                             </div>
                           ) : (
                             <span className="no-policy">{t("no_policy")}</span>
                           )}
                       </td>
                       <td>
                         <div className="traffic-container">
                            <div className="traffic-stats">
                              <span>{formatBytes(sub.traffic?.used || 0)}</span>
                              <span>{formatBytes(sub.traffic?.total || 1)}</span>
                            </div>
                            <div className="traffic-bar-container">
                              <div className={`traffic-bar ${uRatio > 90 ? "high" : uRatio > 70 ? "medium" : "low"}`} style={{ width: `${Math.min(uRatio, 100)}%` }} />
                            </div>
                          </div>
                        </td>
                        <td className="last-active-cell">
                          <span title={formatFullDate(sub.lastActive)} className="last-active-text">
                            {timeAgo(sub.lastActive)}
                          </span>
                        </td>
                        {canEditSubscribers && (
                          <td className="actions-cell">
                             <button className="action-btn action-btn-primary" onClick={() => handleOpenEdit(sub.imsi)} title={t("action_edit")}>
                               <PenLine size={18} />
                             </button>
                             <button className="action-btn action-btn-danger" onClick={(e) => handleDelete(sub.imsi, e)} title={t("action_delete")} disabled={isDeletingSingle === sub.imsi || Boolean(pendingDelete)}>
                               {isDeletingSingle === sub.imsi ? <span className="spinner" style={{ width: 18, height: 18, borderWidth: 2 }} /> : <Trash2 size={18} />}
                             </button>
                             <div className="dropdown-container">
                               <button className="action-btn action-btn-muted" title={t("action_more")} onClick={(e) => { e.stopPropagation(); setActiveDropdown(activeDropdown === sub.imsi ? null : sub.imsi); }}>
                                 <MoreHorizontal size={18} />
                               </button>
                               {activeDropdown === sub.imsi && (
                                 <div className="dropdown-menu">
                                   <button className="dropdown-menu-item" onClick={(e) => {e.stopPropagation(); setActiveDropdown(null); setTraceImsi(sub.imsi);}}>{t("action_trace")}</button>
                                   <button className="dropdown-menu-item" onClick={(e) => handleOpenTrafficAdjustment(sub, "recharge", e)}>{t("traffic_adjust")}</button>
                                   <button className="dropdown-menu-item" onClick={(e) => handleOpenTrafficAdjustment(sub, "reset", e)}>{t("action_reset")}</button>
                                 </div>
                               )}
                             </div>
                          </td>
                        )}
                     </tr>
                   );
                })}
              </tbody>
            </table>
          </div>
        )}
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
        className="fab"
        onClick={() => setIsBatchOpen(true)}
        title={t("batch_create")}
        aria-label={t("batch_create")}
        style={{ bottom: "120px", background: "#6366f1" }}
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
        subscribers={sortedSubscribers}
        selectedImsis={selectedImsis}
      />
    </>
  );
}
