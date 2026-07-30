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
    <div className="container animate-fade-in" style={{ padding: "3rem" }} onClick={() => setActiveDropdown(null)}>

      {/* Page Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "2rem" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: "1.5rem", fontWeight: 700, color: "var(--text-main)" }}>
            {t("subscriber_title")}
          </h2>
          <p style={{ margin: "0.25rem 0 0 0", fontSize: "0.9rem", color: "var(--text-secondary)" }}>
            {t("subscriber_subtitle")}
          </p>
        </div>
      </div>

      <section className="subscriber-summary-panel" aria-label={t("subscriber_summary_label")}>
        {summaryCards.map((item) => {
          const isActive = statusFilter === item.key;
          return (
            <button
              key={item.key}
              type="button"
              className={`subscriber-summary-card subscriber-summary-${item.tone}${isActive ? " active" : ""}`}
              onClick={(event) => {
                event.stopPropagation();
                applyStatusFilter(item.key);
              }}
              aria-pressed={isActive}
            >
              <span>{item.label}</span>
              <strong>{item.value}</strong>
            </button>
          );
        })}
      </section>

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
        <div style={{ display: "flex", alignItems: "center", gap: "1.5rem" }}>
          <input
            type="search"
            className="form-input hover-glass"
            style={{ width: "350px", borderRadius: "20px", padding: "0.6rem 1.2rem" }}
            placeholder={t("search_imsi")}
            value={searchQuery}
            onChange={e => { setSearchQuery(e.target.value); setCurrentPage(1); setSelectedImsis([]); }}
          />
          {selectedImsis.length > 0 && (
            <div className="animate-fade-in" style={{ display: "flex", alignItems: "center", gap: "1.5rem", background: "rgba(59, 130, 246, 0.1)", borderRadius: "8px", padding: "0.4rem 1.2rem", border: "1px solid rgba(59, 130, 246, 0.2)" }}>
              <span style={{ fontWeight: 600, color: "var(--primary)", fontSize: "0.9rem" }}>{selectedImsis.length} {t("selected")}</span>
              <div style={{ paddingLeft: "1.5rem", borderLeft: "1px solid rgba(59, 130, 246, 0.2)", display: "flex", gap: "0.75rem" }}>
                {canEditSubscribers && (
                  <button className="btn btn-outline" style={{ display: "flex", alignItems: "center", gap: "0.4rem", padding: "0.4rem 1rem", fontSize: "0.85rem", borderColor: "var(--primary)", color: "var(--primary)", background: "var(--surface)" }} onClick={() => setIsPolicyModalOpen(true)}>
                    <Settings2 size={14}/> {t("change_policy")}
                  </button>
                )}
                <button className="btn btn-outline" style={{ display: "flex", alignItems: "center", gap: "0.4rem", padding: "0.4rem 1rem", fontSize: "0.85rem", borderColor: "var(--primary)", color: "var(--primary)", background: "var(--surface)" }} onClick={() => setIsDataHubOpen(true)}>
                  <Download size={14}/> {t("export_csv")}
                </button>
                {canEditSubscribers && (
                  <button className="btn" style={{ background: "var(--danger)", padding: "0.4rem 1rem", display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.85rem" }} onClick={handleBulkDelete} disabled={isDeletingBulk || Boolean(pendingDelete)}>
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
                 className="btn btn-primary"
                 onClick={handleOpenNew}
                 title={t("add_subscriber")}
                 style={{ padding: "0.55rem 1rem" }}
               >
                 <Plus size={16} /> {t("add_subscriber")}
               </button>
               <button
                 className="btn btn-outline"
                 onClick={() => setIsBatchOpen(true)}
                 title={t("batch_create")}
                 style={{ padding: "0.55rem 1rem" }}
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
             style={{ display: "flex", alignItems: "center", gap: "0.5rem", border: "1px solid var(--surface-border)", background: "var(--surface)", padding: "0.5rem 1rem", borderRadius: "20px", fontSize: "0.85rem", fontWeight: 600, color: "var(--text-secondary)", cursor: "pointer", transition: "all 0.2s" }}
           >
             <DatabaseZap size={14} color="var(--primary)" /> {t("sync_telemetry")}
           </button>
           <button
             onClick={() => setIsDataHubOpen(true)}
             title={t("datahub_tooltip")}
             style={{ display: "flex", alignItems: "center", gap: "0.5rem", border: "1px solid var(--surface-border)", background: "var(--surface)", padding: "0.5rem 1rem", borderRadius: "20px", fontSize: "0.85rem", fontWeight: 600, color: "var(--text-secondary)", cursor: "pointer", transition: "all 0.2s" }}
           >
             <FileUp size={14} color="var(--primary)" /> {t("data_hub")}
           </button>
        </div>
      </div>

      {/* Main Data Table */}
      <div className="dash-card shadow" style={{ borderRadius: "12px", overflow: "hidden", padding: 0 }}>
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
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left", fontSize: "0.9rem" }}>
              <thead style={{ background: "var(--surface-hover)", borderBottom: "2px solid var(--surface-border)" }}>
                <tr>
                  <th style={{ padding: "1rem" }}>
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
                     <tr key={sub.imsi} style={{ borderBottom: "1px solid var(--surface-border)", background: isSelected ? "rgba(59, 130, 246, 0.1)" : (index % 2 === 0 ? "transparent" : "rgba(0,0,0,0.015)"), transition: "background 0.2s" }} onMouseEnter={(e) => { if(!isSelected) e.currentTarget.style.background = "var(--surface-hover)" }} onMouseLeave={(e) => { if(!isSelected) e.currentTarget.style.background = index % 2 === 0 ? "transparent" : "rgba(0,0,0,0.015)" }}>
                       <td style={{ padding: "1rem" }}>
                         <input type="checkbox" className="checkbox-custom" checked={isSelected} onChange={() => setSelectedImsis(prev => prev.includes(sub.imsi) ? prev.filter(i => i !== sub.imsi) : [...prev, sub.imsi])} />
                       </td>
                       <td style={{ padding: "1rem" }}>
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
                             <span
                               className={isActive ? "pill-active-pulse" : ""}
                               title={tooltip || undefined}
                               style={{
                                 background: isActive ? "rgba(16, 185, 129, 0.15)" : (isSuspended ? "rgba(239, 68, 68, 0.15)" : "rgba(245, 158, 11, 0.15)"),
                                 color: isActive ? "#4ade80" : (isSuspended ? "#f87171" : "#fbbf24"),
                                 padding: "0.25rem 0.5rem",
                                 borderRadius: "20px",
                                 fontSize: "0.75rem",
                                 fontWeight: 700,
                                 whiteSpace: "nowrap",
                                 cursor: tooltip ? "help" : "default",
                                 display: "inline-block"
                               }}>
                               {isActive ? t("status_active") : isSuspended ? t("status_suspended") : isPartial ? t("status_partial") : sub.status}
                             </span>
                           );
                         })()}
                       </td>
                       <td style={{ padding: "1rem" }}>
                         <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                           <span style={{ fontWeight: 600, fontFamily: "monospace", fontSize: "0.95rem" }}>{sub.imsi}</span>
                           <button
                             className={copiedImsi === sub.imsi ? "copy-btn copied" : "copy-btn"}
                             onClick={(event) => handleCopyImsi(sub.imsi, event)}
                             title={copiedImsi === sub.imsi ? "Copied" : "Copy IMSI"}
                           >
                             {copiedImsi === sub.imsi ? <CheckCircle2 size={14} /> : <Copy size={14} />}
                           </button>
                         </div>
                       </td>
                       <td style={{ padding: "1rem" }}>
                         {(() => {
                            const net = resolveNetwork(sub.imsi);
                            const tooltipText = net.network !== 'Unknown'
                              ? `${net.network} - ${net.country}${net.country_code ? ' (+' + net.country_code + ')' : ''}`
                              : t("unknown_network");
                            return (
                              <span
                                title={tooltipText}
                                style={{
                                  color: "var(--primary)",
                                  padding: "0.2rem 0.6rem",
                                  borderRadius: "4px",
                                  fontSize: "0.85rem",
                                  fontWeight: 800,
                                  border: "1px solid rgba(78, 115, 233, 0.2)",
                                  background: "rgba(78, 115, 233, 0.03)",
                                  cursor: "default",
                                  fontFamily: "monospace"
                                }}>
                                {net.plmn}
                              </span>
                            );
                         })()}
                       </td>
                        <td style={{ padding: "1rem" }}>
                           {sub.policy ? (
                             <div style={{ display: "grid", gap: "0.25rem" }}>
                               <span title={sub.policy} style={{ color: "var(--text-main)", fontWeight: 700, fontSize: "0.86rem" }}>
                                 {sub.policyName || sub.policy}
                               </span>
                               <span style={{ display: "flex", alignItems: "center", gap: "0.4rem", color: "var(--text-muted)", fontSize: "0.74rem", fontFamily: "monospace" }}>
                                 {sub.policy}
                                 {sub.policyStatus === "disabled" && (
                                   <span style={{ color: "var(--warning)", fontFamily: "inherit", fontWeight: 800 }}>
                                     {t("users_disabled")}
                                   </span>
                                 )}
                               </span>
                             </div>
                           ) : (
                             <span style={{ color: "#94a3b8", fontSize: "0.85rem", fontStyle: "italic" }}>{t("no_policy")}</span>
                           )}
                       </td>
                       <td style={{ padding: "1rem" }}>
                         <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
                            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.75rem", color: "var(--text-muted)" }}>
                              <span>{formatBytes(sub.traffic?.used || 0)}</span>
                              <span>{formatBytes(sub.traffic?.total || 1)}</span>
                            </div>
                            <div style={{ height: "6px", background: "var(--surface-border)", borderRadius: "3px", overflow: "hidden" }}>
                              <div style={{ height: "100%", width: `${Math.min(uRatio, 100)}%`, background: uRatio > 90 ? "linear-gradient(90deg, #f59e0b 0%, #ef4444 100%)" : uRatio > 70 ? "linear-gradient(90deg, #10b981 0%, #f59e0b 100%)" : "linear-gradient(90deg, #3b82f6 0%, #10b981 100%)", transition: "width 0.5s ease" }} />
                            </div>
                          </div>
                        </td>
                        <td style={{ padding: "1rem", color: "var(--text-secondary)", fontSize: "0.85rem" }}>
                          <span title={formatFullDate(sub.lastActive)} style={{ cursor: "help", borderBottom: "1px dotted var(--surface-border)" }}>
                            {timeAgo(sub.lastActive)}
                          </span>
                        </td>
                        {canEditSubscribers && (
                          <td style={{ padding: "1rem", display: "flex", gap: "0.75rem", justifyContent: "center", alignItems: "center", position: "relative" }}>
                             <button onClick={() => handleOpenEdit(sub.imsi)} title={t("action_edit")} style={{ background: "transparent", border: "none", color: "var(--primary)", cursor: "pointer", display: "flex" }}>
                               <PenLine size={18} />
                             </button>
                             <button
                               onClick={(e) => handleDelete(sub.imsi, e)}
                               title={t("action_delete")}
                               disabled={isDeletingSingle === sub.imsi || Boolean(pendingDelete)}
                               style={{ background: "transparent", border: "none", color: "var(--danger)", cursor: pendingDelete ? "not-allowed" : "pointer", display: "flex", opacity: isDeletingSingle === sub.imsi ? 0.6 : 1 }}
                             >
                               {isDeletingSingle === sub.imsi ? <span className="spinner" style={{ width: 18, height: 18, borderWidth: 2 }} /> : <Trash2 size={18} />}
                             </button>
                             <div style={{ position: "static" }}>
                               <button title={t("action_more")} onClick={(e) => { e.stopPropagation(); setActiveDropdown(activeDropdown === sub.imsi ? null : sub.imsi); }} style={{ background: "transparent", border: "none", color: "var(--text-muted)", cursor: "pointer", display: "flex", padding: "0.2rem" }}>
                                 <MoreHorizontal size={18} />
                               </button>
                               {activeDropdown === sub.imsi && (
                                 <div style={{ position: "absolute", right: "2rem", top: "70%", background: "var(--surface)", backdropFilter: "blur(12px)", boxShadow: "0 4px 12px rgba(0,0,0,0.3)", borderRadius: "6px", width: "180px", zIndex: 50, border: "1px solid var(--surface-border)", overflow: "hidden" }}>
                                   <button style={{ width: "100%", padding: "0.6rem 1rem", textAlign: "left", background: "transparent", border: "none", borderBottom: "1px solid var(--surface-border)", fontSize: "0.85rem", cursor: "pointer", color: "var(--text-main)" }} onClick={(e) => {e.stopPropagation(); setActiveDropdown(null); setTraceImsi(sub.imsi);}}>{t("action_trace")}</button>
                                   <button style={{ width: "100%", padding: "0.6rem 1rem", textAlign: "left", background: "transparent", border: "none", borderBottom: "1px solid var(--surface-border)", fontSize: "0.85rem", cursor: "pointer", color: "var(--text-main)" }} onClick={(e) => handleOpenTrafficAdjustment(sub, "recharge", e)}>{t("traffic_adjust")}</button>
                                   <button style={{ width: "100%", padding: "0.6rem 1rem", textAlign: "left", background: "transparent", border: "none", fontSize: "0.85rem", cursor: "pointer", color: "var(--text-main)" }} onClick={(e) => handleOpenTrafficAdjustment(sub, "reset", e)}>{t("action_reset")}</button>
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

        {/* Pagination Controls */}
        {!isLoading && totalSubscribers > 0 && (
          <div className="table-pagination">
             <div style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>
               {t("showing")} {((displayPage - 1) * pageSize) + 1} {t("to")} {Math.min(displayPage * pageSize, totalSubscribers)} {t("of")} {totalSubscribers} {t("entries")}
             </div>
             <div className="pagination-controls">
               <select className="page-size-select" value={pageSize} onChange={e => { setPageSize(Number(e.target.value)); setCurrentPage(1); }}>
                 <option value={10}>10 {t("per_page")}</option>
                 <option value={20}>20 {t("per_page")}</option>
                 <option value={50}>50 {t("per_page")}</option>
               </select>
               <div className="page-buttons" aria-label="Subscriber pagination">
                 <button className="page-button icon" onClick={() => setCurrentPage(1)} disabled={displayPage === 1} title="First page">
                   <ChevronsLeft size={15} />
                 </button>
                 <button className="page-button icon" onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={displayPage === 1} title={t("prev")}>
                   <ChevronLeft size={15} />
                 </button>
                 {getPageNumbers().map((page) => (
                   <button
                     key={page}
                     className={page === displayPage ? "page-button active" : "page-button"}
                     onClick={() => setCurrentPage(page)}
                     aria-current={page === displayPage ? "page" : undefined}
                   >
                     {page}
                   </button>
                 ))}
                 <button className="page-button icon" onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))} disabled={displayPage === totalPages} title={t("next")}>
                   <ChevronRight size={15} />
                 </button>
                 <button className="page-button icon" onClick={() => setCurrentPage(totalPages)} disabled={displayPage === totalPages} title="Last page">
                   <ChevronsRight size={15} />
                 </button>
               </div>
             </div>
          </div>
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
