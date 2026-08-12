"use client";

import { useState, useEffect, useCallback } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  Eye,
  Lock,
  RefreshCw,
  Search,
  ShieldAlert,
  Users,
  Wallet,
  Zap,
} from "lucide-react";
import { useI18n } from "@/components/I18nProvider";
import PageHeader from "@/components/ui/PageHeader";
import { formatBytes } from "@/lib/unitParser";
import OcsDetailDrawer from "./OcsDetailDrawer";
import type { OcsBalanceRecord } from "@/server/repositories/ocsOperationsRepository";

export default function OcsBalancesPanel() {
  const { t } = useI18n();
  const [loading, setLoading] = useState(false);
  const [records, setRecords] = useState<OcsBalanceRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [search, setSearch] = useState("");
  const [invariantFilter, setInvariantFilter] = useState<"all" | "valid" | "broken">("all");
  const [statusFilter, setStatusFilter] = useState("");
  const [sortField, setSortField] = useState("updated_at");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [selectedRecord, setSelectedRecord] = useState<OcsBalanceRecord | null>(null);

  const [summary, setSummary] = useState({
    totalSubscribers: 0,
    totalDataAllocated: 0,
    totalDataUsed: 0,
    totalDataReserved: 0,
    totalDataAvailable: 0,
  });

  const fetchBalances = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(limit),
        imsi: search.trim(),
        invariant: invariantFilter,
        status: statusFilter,
        sortField,
        sortOrder,
      });
      const res = await fetch(`/api/ocs/balances?${params.toString()}`);
      if (res.ok) {
        const data = await res.json();
        if (data.ok) {
          setRecords(data.records || []);
          setTotal(data.total || 0);
          if (data.summary) {
            setSummary(data.summary);
          }
        }
      }
    } catch (e) {
      console.error("Failed to fetch OCS balances:", e);
    } finally {
      setLoading(false);
    }
  }, [page, limit, search, invariantFilter, statusFilter, sortField, sortOrder]);

  useEffect(() => {
    fetchBalances();
  }, [fetchBalances]);

  const totalPages = Math.ceil(total / limit) || 1;
  const brokenCount = records.filter((r) => !r.invariant_ok).length;

  return (
    <div className="ocs-container">
      <PageHeader
        eyebrow="OCS / BALANCE"
        title={t("ocs_balances_title")}
        description={t("ocs_balances_desc")}
        status={<><Lock size={12} /> {t("ocs_readonly_badge")}</>}
        actions={<div className="ocs-header-actions">
          <button
            type="button"
            className="ocs-btn"
            onClick={fetchBalances}
            disabled={loading}
          >
            <RefreshCw size={14} className={loading ? "spin" : ""} />
            <span>{t("refresh")}</span>
          </button>
        </div>}
      />

      {/* Read-Only Safety Notice */}
      <div className="ocs-readonly-banner">
        <ShieldAlert size={18} />
        <span>{t("ocs_readonly_notice")}</span>
      </div>

      {/* KPI Cards */}
      <div className="ocs-kpi-grid">
        <div className="ocs-kpi-card">
          <div className="ocs-kpi-top">
            <span className="ocs-kpi-label">{t("ocs_kpi_total_subs")}</span>
            <div className="ocs-kpi-icon-wrap cyan">
              <Users size={18} />
            </div>
          </div>
          <div className="ocs-kpi-value">{summary.totalSubscribers.toLocaleString()}</div>
          <div className="ocs-kpi-sub">Total OCS registered profiles</div>
        </div>

        <div className="ocs-kpi-card">
          <div className="ocs-kpi-top">
            <span className="ocs-kpi-label">{t("ocs_kpi_allocated_data")}</span>
            <div className="ocs-kpi-icon-wrap">
              <Database size={18} />
            </div>
          </div>
          <div className="ocs-kpi-value">{formatBytes(summary.totalDataAllocated)}</div>
          <div className="ocs-kpi-sub">Total data quota provisioned</div>
        </div>

        <div className="ocs-kpi-card">
          <div className="ocs-kpi-top">
            <span className="ocs-kpi-label">{t("ocs_kpi_available_data")}</span>
            <div className="ocs-kpi-icon-wrap emerald">
              <Wallet size={18} />
            </div>
          </div>
          <div className="ocs-kpi-value">{formatBytes(summary.totalDataAvailable)}</div>
          <div className="ocs-kpi-sub">
            {summary.totalDataAllocated > 0
              ? `${((summary.totalDataAvailable / summary.totalDataAllocated) * 100).toFixed(1)}% remaining`
              : "0%"}
          </div>
        </div>

        <div className="ocs-kpi-card">
          <div className="ocs-kpi-top">
            <span className="ocs-kpi-label">{t("ocs_kpi_reserved_data")}</span>
            <div className="ocs-kpi-icon-wrap amber">
              <Zap size={18} />
            </div>
          </div>
          <div className="ocs-kpi-value">{formatBytes(summary.totalDataReserved)}</div>
          <div className="ocs-kpi-sub">In-flight CCR-U reservations</div>
        </div>

        <div className={`ocs-kpi-card ${brokenCount > 0 ? "warning" : ""}`}>
          <div className="ocs-kpi-top">
            <span className="ocs-kpi-label">{t("ocs_kpi_broken_invariants")}</span>
            <div className={`ocs-kpi-icon-wrap ${brokenCount > 0 ? "rose" : "emerald"}`}>
              {brokenCount > 0 ? <AlertTriangle size={18} /> : <CheckCircle2 size={18} />}
            </div>
          </div>
          <div className="ocs-kpi-value" style={{ color: brokenCount > 0 ? "#f87171" : "#34d399" }}>
            {brokenCount}
          </div>
          <div className="ocs-kpi-sub">
            {brokenCount === 0 ? "100% Invariant Compliant" : "Requires DB consistency review"}
          </div>
        </div>
      </div>

      {/* Search & Filter Bar */}
      <div className="ocs-controls-bar">
        <div className="ocs-search-group">
          <Search size={16} className="ocs-search-icon" />
          <input
            type="text"
            className="ocs-search-input"
            placeholder={t("search_placeholder") + " (IMSI)"}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </div>

        <div className="ocs-filters-group">
          <select
            className="ocs-select"
            value={invariantFilter}
            onChange={(e) => {
              setInvariantFilter(e.target.value as "all" | "valid" | "broken");
              setPage(1);
            }}
          >
            <option value="all">{t("ocs_filter_all_invariants")}</option>
            <option value="valid">{t("ocs_filter_valid_invariants")}</option>
            <option value="broken">{t("ocs_filter_broken_invariants")}</option>
          </select>

          <select
            className="ocs-select"
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              setPage(1);
            }}
          >
            <option value="">{t("ocs_filter_all_states")}</option>
            <option value="active">{t("ocs_filter_active")}</option>
            <option value="suspended">Suspended</option>
          </select>

          <select
            className="ocs-select"
            value={sortField}
            onChange={(e) => setSortField(e.target.value)}
          >
            <option value="updated_at">{t("ocs_col_updated_at")}</option>
            <option value="data_available">{t("ocs_col_data_available")}</option>
            <option value="data_used">{t("ocs_col_data_used")}</option>
            <option value="data_total">{t("ocs_col_data_alloc")}</option>
            <option value="imsi">{t("ocs_col_imsi")}</option>
          </select>

          <button
            type="button"
            className="ocs-btn"
            onClick={() => setSortOrder((o) => (o === "asc" ? "desc" : "asc"))}
            title="Toggle sort order"
          >
            {sortOrder.toUpperCase()}
          </button>
        </div>
      </div>

      {/* Main Table */}
      <div className="ocs-table-card">
        <div className="ocs-table-wrapper">
          <table className="ocs-table">
            <thead>
              <tr>
                <th>{t("ocs_col_imsi")}</th>
                <th>{t("ocs_col_plan")}</th>
                <th>{t("ocs_col_status")}</th>
                <th>{t("ocs_col_data_alloc")} / {t("ocs_col_data_used")} / {t("ocs_col_data_reserved")}</th>
                <th>{t("ocs_col_data_available")}</th>
                <th>{t("ocs_col_voice_avail")}</th>
                <th>{t("ocs_col_sms_avail")}</th>
                <th>{t("ocs_col_invariant")}</th>
                <th>{t("ocs_col_version")}</th>
                <th>{t("ocs_col_updated_at")}</th>
                <th>{t("actions")}</th>
              </tr>
            </thead>
            <tbody>
              {records.length === 0 ? (
                <tr>
                  <td colSpan={11} style={{ textAlign: "center", padding: "3rem 1rem", color: "#64748b" }}>
                    {loading ? t("loading") : t("no_data")}
                  </td>
                </tr>
              ) : (
                records.map((r) => {
                  const usedPct = r.data_total > 0 ? (r.data_used / r.data_total) * 100 : 0;
                  const resPct = r.data_total > 0 ? (r.data_reserved / r.data_total) * 100 : 0;
                  const availPct = r.data_total > 0 ? (r.data_available / r.data_total) * 100 : 100;

                  return (
                    <tr key={r.id}>
                      <td className="ocs-mono" style={{ fontWeight: 600, color: "#93c5fd" }}>
                        {r.imsi}
                      </td>
                      <td>
                        <span className="ocs-badge" style={{ background: "rgba(255,255,255,0.06)", color: "#e2e8f0" }}>
                          {r.plan_id}
                        </span>
                      </td>
                      <td>
                        <span className={`ocs-badge status-${r.status}`}>
                          {r.status}
                        </span>
                      </td>
                      <td>
                        <div className="ocs-quota-bar-wrap">
                          <div className="ocs-quota-track">
                            <div className="ocs-quota-seg-used" style={{ width: `${usedPct}%` }} title={`Used: ${formatBytes(r.data_used)}`} />
                            <div className="ocs-quota-seg-reserved" style={{ width: `${resPct}%` }} title={`Reserved: ${formatBytes(r.data_reserved)}`} />
                            <div className="ocs-quota-seg-available" style={{ width: `${availPct}%` }} title={`Available: ${formatBytes(r.data_available)}`} />
                          </div>
                          <div className="ocs-quota-labels ocs-mono">
                            <span>{formatBytes(r.data_used)}</span>
                            <span>/</span>
                            <span>{formatBytes(r.data_total)}</span>
                          </div>
                        </div>
                      </td>
                      <td className="ocs-mono" style={{ fontWeight: 700, color: r.data_available > 0 ? "#34d399" : "#f87171" }}>
                        {formatBytes(r.data_available)}
                      </td>
                      <td className="ocs-mono">
                        {r.voice_available}s / {r.voice_total}s
                      </td>
                      <td className="ocs-mono">
                        {r.sms_available} / {r.sms_total}
                      </td>
                      <td>
                        {r.invariant_ok ? (
                          <span className="ocs-badge invariant-valid">
                            <CheckCircle2 size={12} /> {t("ocs_invariant_valid_badge")}
                          </span>
                        ) : (
                          <span className="ocs-badge invariant-broken">
                            <AlertTriangle size={12} /> {t("ocs_invariant_broken_badge")}
                          </span>
                        )}
                      </td>
                      <td className="ocs-mono" style={{ color: "#94a3b8" }}>v{r.version}</td>
                      <td className="ocs-mono" style={{ fontSize: "0.8rem", color: "#64748b" }}>
                        {r.updated_at ? new Date(r.updated_at).toLocaleString() : "-"}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="ocs-btn"
                          style={{ padding: "0.35rem 0.65rem", fontSize: "0.775rem" }}
                          onClick={() => setSelectedRecord(r)}
                        >
                          <Eye size={13} />
                          <span>{t("ocs_inspect")}</span>
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div className="ocs-pagination">
          <div>
            {t("showing")} {records.length > 0 ? (page - 1) * limit + 1 : 0} {t("to")}{" "}
            {Math.min(page * limit, total)} {t("of")} {total} {t("entries")}
          </div>
          <div className="ocs-pagination-btns">
            <select
              className="ocs-select"
              value={limit}
              onChange={(e) => {
                setLimit(Number(e.target.value));
                setPage(1);
              }}
              style={{ padding: "0.35rem 1.5rem 0.35rem 0.5rem", fontSize: "0.8rem" }}
            >
              <option value="10">10 / page</option>
              <option value="20">20 / page</option>
              <option value="50">50 / page</option>
              <option value="100">100 / page</option>
            </select>
            <button
              type="button"
              className="ocs-btn"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              {t("prev")}
            </button>
            <span className="ocs-mono" style={{ fontSize: "0.85rem", padding: "0 0.5rem" }}>
              {page} / {totalPages}
            </span>
            <button
              type="button"
              className="ocs-btn"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              {t("next")}
            </button>
          </div>
        </div>
      </div>

      {/* Detail Drawer */}
      {selectedRecord && (
        <OcsDetailDrawer
          title={`Balance Details: ${selectedRecord.imsi}`}
          data={selectedRecord}
          onClose={() => setSelectedRecord(null)}
          fields={[
            { label: "IMSI", value: selectedRecord.imsi },
            { label: "Plan ID", value: selectedRecord.plan_id },
            { label: "Status", value: selectedRecord.status },
            { label: "Data Total", value: `${formatBytes(selectedRecord.data_total)} (${selectedRecord.data_total} B)` },
            { label: "Data Used", value: `${formatBytes(selectedRecord.data_used)} (${selectedRecord.data_used} B)` },
            { label: "Data Reserved", value: `${formatBytes(selectedRecord.data_reserved)} (${selectedRecord.data_reserved} B)` },
            { label: "Data Available", value: `${formatBytes(selectedRecord.data_available)} (${selectedRecord.data_available} B)` },
            { label: "Data Invariant OK", value: selectedRecord.data_invariant_ok ? "TRUE" : "FALSE (Mismatch)" },
            { label: "Voice Invariant OK", value: selectedRecord.voice_invariant_ok ? "TRUE" : "FALSE" },
            { label: "SMS Invariant OK", value: selectedRecord.sms_invariant_ok ? "TRUE" : "FALSE" },
            { label: "Version Counter", value: selectedRecord.version },
            { label: "Updated Timestamp", value: selectedRecord.updated_at || "-" },
          ]}
        />
      )}
    </div>
  );
}
