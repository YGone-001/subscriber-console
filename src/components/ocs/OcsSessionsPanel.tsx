"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Activity,
  CheckCircle,
  Clock,
  Eye,
  Lock,
  Radio,
  RefreshCw,
  Search,
  ShieldAlert,
  Zap,
} from "lucide-react";
import { useI18n } from "@/components/I18nProvider";
import { formatBytes } from "@/lib/unitParser";
import OcsDetailDrawer from "./OcsDetailDrawer";
import type { OcsSessionRecord } from "@/server/repositories/ocsOperationsRepository";

export default function OcsSessionsPanel() {
  const { t } = useI18n();
  const [loading, setLoading] = useState(false);
  const [records, setRecords] = useState<OcsSessionRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [search, setSearch] = useState("");
  const [stateFilter, setStateFilter] = useState("all");
  const [interfaceFilter, setInterfaceFilter] = useState("all");
  const [sortField, setSortField] = useState("last_update_at");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [selectedRecord, setSelectedRecord] = useState<OcsSessionRecord | null>(null);

  const [summary, setSummary] = useState({
    activeSessions: 0,
    closingSessions: 0,
    closedSessions: 0,
    totalGrantedOctets: 0,
    totalUsedOctets: 0,
  });

  const fetchSessions = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(limit),
        imsi: search.trim(),
        state: stateFilter,
        interfaceType: interfaceFilter,
        sortField,
        sortOrder,
      });
      const res = await fetch(`/api/ocs/sessions?${params.toString()}`);
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
      console.error("Failed to fetch OCS sessions:", e);
    } finally {
      setLoading(false);
    }
  }, [page, limit, search, stateFilter, interfaceFilter, sortField, sortOrder]);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  const totalPages = Math.ceil(total / limit) || 1;

  return (
    <div className="ocs-container">
      {/* Header */}
      <div className="ocs-header">
        <div className="ocs-header-title-area">
          <div className="ocs-header-title-row">
            <h1 className="ocs-header-title">{t("ocs_sessions_title")}</h1>
            <span className="ocs-badge status-active">
              <Lock size={12} /> {t("ocs_readonly_badge")}
            </span>
          </div>
          <p className="ocs-header-desc">{t("ocs_sessions_desc")}</p>
        </div>
        <div className="ocs-header-actions">
          <button
            type="button"
            className="ocs-btn"
            onClick={fetchSessions}
            disabled={loading}
          >
            <RefreshCw size={14} className={loading ? "spin" : ""} />
            <span>{t("refresh")}</span>
          </button>
        </div>
      </div>

      {/* Safety Notice */}
      <div className="ocs-readonly-banner">
        <ShieldAlert size={18} />
        <span>{t("ocs_readonly_notice")}</span>
      </div>

      {/* KPI Cards */}
      <div className="ocs-kpi-grid">
        <div className="ocs-kpi-card">
          <div className="ocs-kpi-top">
            <span className="ocs-kpi-label">{t("ocs_kpi_active_sessions")}</span>
            <div className="ocs-kpi-icon-wrap emerald">
              <Activity size={18} />
            </div>
          </div>
          <div className="ocs-kpi-value" style={{ color: "#34d399" }}>
            {summary.activeSessions.toLocaleString()}
          </div>
          <div className="ocs-kpi-sub">Currently handling Gy/Ro traffic</div>
        </div>

        <div className="ocs-kpi-card">
          <div className="ocs-kpi-top">
            <span className="ocs-kpi-label">{t("ocs_kpi_closing_sessions")}</span>
            <div className="ocs-kpi-icon-wrap amber">
              <Clock size={18} />
            </div>
          </div>
          <div className="ocs-kpi-value" style={{ color: "#fbbf24" }}>
            {summary.closingSessions.toLocaleString()}
          </div>
          <div className="ocs-kpi-sub">Lifecycle cleanup scanner in progress</div>
        </div>

        <div className="ocs-kpi-card">
          <div className="ocs-kpi-top">
            <span className="ocs-kpi-label">{t("ocs_kpi_closed_sessions")}</span>
            <div className="ocs-kpi-icon-wrap">
              <CheckCircle size={18} />
            </div>
          </div>
          <div className="ocs-kpi-value">{summary.closedSessions.toLocaleString()}</div>
          <div className="ocs-kpi-sub">Settled and archived sessions</div>
        </div>

        <div className="ocs-kpi-card">
          <div className="ocs-kpi-top">
            <span className="ocs-kpi-label">{t("ocs_kpi_granted_octets")}</span>
            <div className="ocs-kpi-icon-wrap cyan">
              <Zap size={18} />
            </div>
          </div>
          <div className="ocs-kpi-value">{formatBytes(summary.totalGrantedOctets)}</div>
          <div className="ocs-kpi-sub">Total CCA-I / CCA-U quota grants</div>
        </div>

        <div className="ocs-kpi-card">
          <div className="ocs-kpi-top">
            <span className="ocs-kpi-label">{t("ocs_kpi_consumed_octets")}</span>
            <div className="ocs-kpi-icon-wrap">
              <Radio size={18} />
            </div>
          </div>
          <div className="ocs-kpi-value">{formatBytes(summary.totalUsedOctets)}</div>
          <div className="ocs-kpi-sub">Total volume reported by SMF/P-GW</div>
        </div>
      </div>

      {/* Filters Bar */}
      <div className="ocs-controls-bar">
        <div className="ocs-search-group">
          <Search size={16} className="ocs-search-icon" />
          <input
            type="text"
            className="ocs-search-input"
            placeholder={t("search_placeholder") + " (IMSI / Session-ID)"}
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
            value={stateFilter}
            onChange={(e) => {
              setStateFilter(e.target.value);
              setPage(1);
            }}
          >
            <option value="all">{t("ocs_filter_all_states")}</option>
            <option value="active">{t("ocs_filter_active")}</option>
            <option value="closing">{t("ocs_filter_closing")}</option>
            <option value="closed">{t("ocs_filter_closed")}</option>
          </select>

          <select
            className="ocs-select"
            value={interfaceFilter}
            onChange={(e) => {
              setInterfaceFilter(e.target.value);
              setPage(1);
            }}
          >
            <option value="all">{t("ocs_filter_all_interfaces")}</option>
            <option value="gy">{t("ocs_filter_gy")}</option>
            <option value="ro">{t("ocs_filter_ro")}</option>
          </select>

          <select
            className="ocs-select"
            value={sortField}
            onChange={(e) => setSortField(e.target.value)}
          >
            <option value="last_update_at">{t("ocs_col_last_update")}</option>
            <option value="started_at">{t("ocs_col_started_at")}</option>
            <option value="used_total">{t("ocs_kpi_consumed_octets")}</option>
            <option value="granted_total">{t("ocs_kpi_granted_octets")}</option>
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
                <th>{t("ocs_col_session_id")}</th>
                <th>{t("ocs_col_imsi")}</th>
                <th>{t("ocs_col_apn")}</th>
                <th>{t("ocs_col_interface")}</th>
                <th>{t("ocs_col_state")}</th>
                <th>{t("ocs_col_cc_num")}</th>
                <th>{t("ocs_col_granted")} / {t("ocs_kpi_consumed_octets")}</th>
                <th>{t("ocs_col_rg_si")}</th>
                <th>{t("ocs_col_started_at")}</th>
                <th>{t("ocs_col_last_update")}</th>
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
                  const stateClass =
                    r.state === "active"
                      ? "status-active"
                      : r.state === "closing"
                      ? "status-closing"
                      : "status-closed";

                  const ifClass =
                    r.interface_type === "ro" ? "interface-ro" : "interface-gy";

                  return (
                    <tr key={r.id}>
                      <td className="ocs-mono" style={{ fontSize: "0.8rem", color: "#38bdf8", maxWidth: "200px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.session_id}>
                        {r.session_id}
                      </td>
                      <td className="ocs-mono" style={{ fontWeight: 600, color: "#93c5fd" }}>
                        {r.imsi}
                      </td>
                      <td className="ocs-mono">{r.apn}</td>
                      <td>
                        <span className={`ocs-badge ${ifClass}`}>
                          {r.interface_type.toUpperCase()}
                        </span>
                      </td>
                      <td>
                        <span className={`ocs-badge ${stateClass}`}>
                          {r.state}
                        </span>
                      </td>
                      <td className="ocs-mono">#{r.cc_request_number}</td>
                      <td className="ocs-mono">
                        <span style={{ color: "#34d399" }}>{formatBytes(r.granted_total)}</span>
                        <span style={{ color: "#64748b" }}> / </span>
                        <span style={{ color: "#fbbf24" }}>{formatBytes(r.used_total)}</span>
                      </td>
                      <td className="ocs-mono" style={{ fontSize: "0.8rem" }}>
                        {r.rating_group !== undefined ? `RG:${r.rating_group}` : "-"}
                        {r.service_identifier !== undefined ? ` / SI:${r.service_identifier}` : ""}
                      </td>
                      <td className="ocs-mono" style={{ fontSize: "0.775rem", color: "#64748b" }}>
                        {r.started_at ? new Date(r.started_at).toLocaleTimeString() : "-"}
                      </td>
                      <td className="ocs-mono" style={{ fontSize: "0.775rem", color: "#94a3b8" }}>
                        {r.last_update_at ? new Date(r.last_update_at).toLocaleTimeString() : "-"}
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
          title={`Diameter Session: ${selectedRecord.session_id}`}
          data={selectedRecord}
          onClose={() => setSelectedRecord(null)}
          fields={[
            { label: "Session-ID", value: selectedRecord.session_id },
            { label: "IMSI", value: selectedRecord.imsi },
            { label: "APN", value: selectedRecord.apn },
            { label: "Interface", value: selectedRecord.interface_type.toUpperCase() },
            { label: "State", value: selectedRecord.state },
            { label: "CC-Request-Number", value: `#${selectedRecord.cc_request_number}` },
            { label: "Granted Octets", value: `${formatBytes(selectedRecord.granted_total)} (${selectedRecord.granted_total} B)` },
            { label: "Used Octets", value: `${formatBytes(selectedRecord.used_total)} (${selectedRecord.used_total} B)` },
            { label: "Rating Group", value: selectedRecord.rating_group ?? "-" },
            { label: "Service Identifier", value: selectedRecord.service_identifier ?? "-" },
            { label: "Tariff Rule ID", value: selectedRecord.tariff_rule_id ?? "-" },
            { label: "Close Reason", value: selectedRecord.close_reason ?? "N/A (Active)" },
            { label: "Cleanup Stage", value: selectedRecord.cleanup_stage ?? "N/A" },
            { label: "Cleanup Token", value: selectedRecord.cleanup_token ?? "N/A" },
            { label: "Started At", value: selectedRecord.started_at || "-" },
            { label: "Last Update At", value: selectedRecord.last_update_at || "-" },
            { label: "Closed At", value: selectedRecord.closed_at || "-" },
          ]}
        />
      )}
    </div>
  );
}
