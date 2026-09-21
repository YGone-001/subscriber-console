"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { fetcher } from "@/lib/fetcher";
import { Search, Wallet, CheckCircle, Clock, SlidersHorizontal, Eye } from "lucide-react";
import { useI18n } from "@/components/I18nProvider";
import { DataTablePagination } from "@/components/ui/DataTablePagination";
import { formatBytes } from "@/lib/unitParser";
import OcsPageShell from "../OcsPageShell";
import AdjustBalanceModal from "./AdjustBalanceModal";
import { useAuth } from "@/hooks/useAuth";
import { capabilityDecision } from "@/lib/permissions";

interface BalanceRecordUI {
  id: string;
  imsi: string;
  plan_id?: string;
  status: string;
  data_total: number;
  data_used: number;
  data_reserved: number;
  data_available: number;
  voice_total: number;
  voice_used: number;
  voice_reserved: number;
  voice_available: number;
  sms_total: number;
  sms_used: number;
  sms_available: number;
  version: number;
  updated_at?: string;
}

export default function OcsBalancePlaceholder() {
  const { t } = useI18n();
  const { user } = useAuth();
  const canAdjust = user?.role ? capabilityDecision(user.role, "balance_adjust") !== "deny" : false;
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  // Modal state
  const [adjustTarget, setAdjustTarget] = useState<BalanceRecordUI | null>(null);
  const [feedback, setFeedback] = useState<{
    type: "success" | "error";
    message: string;
    approvalId?: string;
  } | null>(null);

  const url = useMemo(() => {
    const params = new URLSearchParams({
      page: String(page),
      limit: String(limit),
      imsi: search.trim(),
      status: statusFilter,
    });
    return `/api/ocs/balances?${params.toString()}`;
  }, [page, limit, search, statusFilter]);

  const { data, error, isLoading: loading, mutate: refresh } = useSWR(url, fetcher, {
    keepPreviousData: true,
  });

  // Approvals SWR for Pending Adjustments KPI
  const { data: pendingApprovalsData } = useSWR(
    "/api/approvals?action=TRAFFIC_ADJUSTMENT&status=pending",
    fetcher,
    { refreshInterval: 15000 }
  );

  const records: BalanceRecordUI[] = data?.records || [];
  const total = data?.total || 0;
  const activeCount = data?.summary?.activeAccounts ?? records.filter((r) => r.status === "active").length;
  const pendingCount =
    pendingApprovalsData?.total ??
    data?.summary?.pendingAdjustments ??
    0;

  const formatTime = (iso?: string) => {
    if (!iso) return "—";
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  };

  const kpiGrid = (
    <div className="ocs-dashboard-grid">
      <div className="ocs-dashboard-card">
        <div className="ocs-dashboard-card-icon"><Wallet size={20} /></div>
        <div className="ocs-dashboard-card-content">
          <span className="ocs-dashboard-card-value">{error ? "—" : total}</span>
          <span className="ocs-dashboard-card-label">{t("ocs_balance_total_accounts")}</span>
        </div>
      </div>
      <div className="ocs-dashboard-card">
        <div className="ocs-dashboard-card-icon"><CheckCircle size={20} /></div>
        <div className="ocs-dashboard-card-content">
          <span className="ocs-dashboard-card-value">{error ? "—" : activeCount}</span>
          <span className="ocs-dashboard-card-label">{t("ocs_balance_active_accounts")}</span>
        </div>
      </div>
      <div className="ocs-dashboard-card">
        <div className="ocs-dashboard-card-icon"><Clock size={20} /></div>
        <div className="ocs-dashboard-card-content">
          <span className="ocs-dashboard-card-value">{error ? "—" : pendingCount}</span>
          <span className="ocs-dashboard-card-label">{t("ocs_balance_pending_adjustments")}</span>
        </div>
      </div>
    </div>
  );

  const controls = (
    <div className="ocs-controls-bar">
      <div className="ocs-search-group">
        <Search size={16} className="ocs-search-icon" />
        <input
          type="text"
          className="ocs-search-input"
          placeholder={t("ocs_subscribers_search_ph")}
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
        />
      </div>
      <div className="ocs-filters-group">
        <select
          className="ocs-select"
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
        >
          <option value="">{t("ocs_filter_all_statuses")}</option>
          <option value="active">{t("status_active") || "active"}</option>
          <option value="suspended">{t("status_suspended") || "suspended"}</option>
        </select>
      </div>
    </div>
  );

  const tableContent = (
    <>
      {feedback && (
        <div
          className={feedback.type === "success" ? "ocs-feedback-success" : "ocs-feedback-error"}
          style={{ marginBottom: "1rem" }}
        >
          <span>{feedback.message}</span>
          {feedback.approvalId && (
            <Link
              href={`/approvals?id=${encodeURIComponent(feedback.approvalId)}`}
              className="ocs-feedback-link"
              style={{ marginLeft: "0.5rem", textDecoration: "underline" }}
            >
              {t("view_approval") || "查看审批"} →
            </Link>
          )}
        </div>
      )}

      {error && (
        <div className="ocs-feedback-error" style={{ marginBottom: "1rem" }}>
          <span>{error.message || "Failed to load balance accounts"}</span>
        </div>
      )}

      <table className="ocs-table">
        <caption className="sr-only">{t("ocs_balances_title")}</caption>
        <thead>
          <tr>
            <th>IMSI</th>
            <th>{t("ocs_col_data_available")}</th>
            <th>{t("ocs_col_voice_avail")}</th>
            <th>{t("ocs_col_sms_avail")}</th>
            <th>{t("ocs_col_status")}</th>
            <th>{t("ocs_col_version")}</th>
            <th>{t("ocs_tariff_col_updated")}</th>
            <th style={{ textAlign: "right" }}>{t("actions")}</th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr><td colSpan={8} className="ocs-empty-cell"><div className="ocs-loading">{t("loading") || "加载中..."}</div></td></tr>
          ) : error ? (
            <tr><td colSpan={8} className="ocs-empty-cell ocs-error-cell"><div style={{ color: "var(--status-danger)" }}>{error?.message || "加载失败，请检查网络或后端服务"}</div></td></tr>
          ) : records.length === 0 ? (
            <tr><td colSpan={8} className="ocs-empty-cell">{t("no_data")}</td></tr>
          ) : (
            records.map((r) => (
              <tr key={r.id || r.imsi}>
                <td className="ocs-mono">{r.imsi}</td>
                <td className="ocs-mono">{formatBytes(r.data_available)}</td>
                <td className="ocs-mono">{r.voice_available}s</td>
                <td className="ocs-mono">{r.sms_available}</td>
                <td>
                  <span className={`ocs-status-badge ocs-status-${r.status}`}>
                    {r.status}
                  </span>
                </td>
                <td className="ocs-mono">v{r.version || 1}</td>
                <td className="ocs-time-cell">{formatTime(r.updated_at)}</td>
                <td style={{ textAlign: "right" }}>
                  <div className="ocs-action-group" style={{ justifyContent: "flex-end" }}>
                    <Link
                      className="ocs-action-btn"
                      title={t("ocs_balance_view_detail")}
                      href={`/ocs/balances/${r.imsi}`}
                    >
                      <Eye size={14} />
                    </Link>
                    <button
                      type="button"
                      className="ocs-btn-sm ocs-btn-secondary"
                      disabled={!canAdjust}
                      onClick={() => canAdjust && setAdjustTarget(r)}
                      title={canAdjust ? t("ocs_balance_adjust") : t("permission_denied")}
                      style={!canAdjust ? { opacity: 0.5, cursor: "not-allowed" } : undefined}
                    >
                      <SlidersHorizontal size={14} />
                      <span>{t("ocs_balance_adjust")}</span>
                    </button>
                  </div>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      {adjustTarget && (
        <AdjustBalanceModal
          isOpen={true}
          imsi={adjustTarget.imsi}
          dataAvailable={adjustTarget.data_available}
          voiceAvailable={adjustTarget.voice_available}
          smsAvailable={adjustTarget.sms_available}
          onClose={() => setAdjustTarget(null)}
          onSuccess={(result) => {
            setFeedback({
              type: result.outcome === "executed_audit_warning" ? "error" : "success",
              message: result.message,
              approvalId: result.approvalId,
            });
            refresh();
          }}
        />
      )}
    </>
  );

  const pagination = (
    <DataTablePagination
      page={page}
      totalPages={Math.ceil(total / limit) || 1}
      total={total}
      pageSize={limit}
      visibleCount={records.length}
      labels={{
        showing: t("showing"),
        to: t("to"),
        of: t("of"),
        entries: t("entries"),
        previous: t("prev"),
        next: t("next"),
        perPage: t("per_page"),
      }}
      onPageChange={setPage}
      onPageSizeChange={(nextLimit: number) => { setLimit(nextLimit); setPage(1); }}
    />
  );

  return (
    <OcsPageShell
      eyebrow={t("nav_ocs")}
      title={t("ocs_balances_title")}
      description={t("ocs_balances_desc")}
      loading={loading}
      onRefresh={() => refresh()}
      kpiGrid={kpiGrid}
      controls={controls}
      tableContent={tableContent}
      pagination={pagination}
    />
  );
}
