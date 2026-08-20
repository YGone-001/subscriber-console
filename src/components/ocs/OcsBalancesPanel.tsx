"use client";

import { useState, useMemo } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/fetcher";
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
import { DataTablePagination } from "@/components/ui/DataTablePagination";
import { DataTableStateRow } from "@/components/ui/DataTableState";
import { formatBytes } from "@/lib/unitParser";
import OcsDetailDrawer from "./OcsDetailDrawer";
import type { OcsBalanceRecord } from "@/server/repositories/ocsOperationsRepository";

export default function OcsBalancesPanel() {
  const { t } = useI18n();
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [search, setSearch] = useState("");
  const [invariantFilter, setInvariantFilter] = useState<"all" | "valid" | "broken">("all");
  const [statusFilter, setStatusFilter] = useState("");
  const [sortField, setSortField] = useState("updated_at");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [selectedRecord, setSelectedRecord] = useState<OcsBalanceRecord | null>(null);

  const getAriaSort = (fields: string | string[]): "ascending" | "descending" | undefined => {
    const activeFields = Array.isArray(fields) ? fields : [fields];
    return activeFields.includes(sortField) ? (sortOrder === "asc" ? "ascending" : "descending") : undefined;
  };

  const balancesUrl = useMemo(() => {
    const params = new URLSearchParams({
      page: String(page),
      limit: String(limit),
      imsi: search.trim(),
      invariant: invariantFilter,
      status: statusFilter,
      sortField,
      sortOrder,
    });
    return `/api/ocs/balances?${params.toString()}`;
  }, [page, limit, search, invariantFilter, statusFilter, sortField, sortOrder]);

  const { data, isLoading: loading, mutate: refreshBalances } = useSWR(balancesUrl, fetcher, {
    keepPreviousData: true,
  });

  const records: OcsBalanceRecord[] = data?.records || [];
  const total: number = data?.total || 0;
  const summary = data?.summary || {
    totalSubscribers: 0,
    totalDataAllocated: 0,
    totalDataUsed: 0,
    totalDataReserved: 0,
    totalDataAvailable: 0,
  };

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
            onClick={() => refreshBalances()}
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
          <div className="ocs-kpi-value" style={{ color: brokenCount > 0 ? "var(--status-danger)" : "var(--status-success)" }}>
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
            <caption className="sr-only">{t("ocs_balances_title")}</caption>
            <thead>
              <tr>
                <th aria-sort={getAriaSort("imsi")} data-column-priority="essential">{t("ocs_col_imsi")}</th>
                <th data-column-priority="important">{t("ocs_col_plan")}</th>
                <th data-column-priority="essential">{t("ocs_col_status")}</th>
                <th aria-sort={getAriaSort(["data_total", "data_used"])} data-column-priority="important">{t("ocs_col_data_alloc")} / {t("ocs_col_data_used")} / {t("ocs_col_data_reserved")}</th>
                <th aria-sort={getAriaSort("data_available")} data-column-priority="essential">{t("ocs_col_data_available")}</th>
                <th data-column-priority="important">{t("ocs_col_voice_avail")}</th>
                <th data-column-priority="important">{t("ocs_col_sms_avail")}</th>
                <th data-column-priority="essential">{t("ocs_col_invariant")}</th>
                <th data-column-priority="supplementary">{t("ocs_col_version")}</th>
                <th aria-sort={getAriaSort("updated_at")} data-column-priority="supplementary">{t("ocs_col_updated_at")}</th>
                <th data-column-priority="essential">{t("actions")}</th>
              </tr>
            </thead>
            <tbody>
              {records.length === 0 ? (
                <DataTableStateRow colSpan={11} state={loading ? "loading" : "empty"}>
                  {loading ? t("loading") : t("no_data")}
                </DataTableStateRow>
              ) : (
                records.map((r) => {
                  const usedPct = r.data_total > 0 ? (r.data_used / r.data_total) * 100 : 0;
                  const resPct = r.data_total > 0 ? (r.data_reserved / r.data_total) * 100 : 0;
                  const availPct = r.data_total > 0 ? (r.data_available / r.data_total) * 100 : 100;

                  return (
                    <tr key={r.id}>
                      <td className="ocs-mono ocs-cell-imsi" data-column-priority="essential" data-label={t("ocs_col_imsi")}>
                        {r.imsi}
                      </td>
                      <td data-column-priority="important" data-label={t("ocs_col_plan")}>
                        <span className="ocs-badge ocs-badge--neutral">
                          {r.plan_id}
                        </span>
                      </td>
                      <td data-column-priority="essential" data-label={t("ocs_col_status")}>
                        <span className={`ocs-badge status-${r.status}`}>
                          {r.status}
                        </span>
                      </td>
                      <td data-column-priority="important" data-label={t("ocs_col_data_alloc")}>
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
                      <td className="ocs-mono" style={{ fontWeight: 700, color: r.data_available > 0 ? "var(--status-success)" : "var(--status-danger)" }} data-column-priority="essential" data-label={t("ocs_col_data_available")}>
                        {formatBytes(r.data_available)}
                      </td>
                      <td className="ocs-mono" data-column-priority="important" data-label={t("ocs_col_voice_avail")}>
                        {r.voice_available}s / {r.voice_total}s
                      </td>
                      <td className="ocs-mono" data-column-priority="important" data-label={t("ocs_col_sms_avail")}>
                        {r.sms_available} / {r.sms_total}
                      </td>
                      <td data-column-priority="essential" data-label={t("ocs_col_invariant")}>
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
                      <td className="ocs-mono" style={{ color: "var(--text-muted)" }} data-column-priority="supplementary" data-label={t("ocs_col_version")}>v{r.version}</td>
                      <td className="ocs-mono ocs-cell-timestamp" data-column-priority="supplementary" data-label={t("ocs_col_updated_at")}>
                        {r.updated_at ? new Date(r.updated_at).toLocaleString() : "-"}
                      </td>
                      <td data-column-priority="essential">
                        <button
                          type="button"
                          className="ocs-btn ocs-action-btn"
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

        <DataTablePagination
          page={page}
          pageSize={limit}
          total={total}
          visibleCount={records.length}
          totalPages={totalPages}
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
          onPageSizeChange={(nextLimit) => {
            setLimit(nextLimit);
            setPage(1);
          }}
        />
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
