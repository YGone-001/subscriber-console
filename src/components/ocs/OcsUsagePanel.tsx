"use client";

import { useState, useEffect, useCallback } from "react";
import {
  ArrowDownCircle,
  ArrowUpCircle,
  BarChart3,
  CheckCircle,
  Clock,
  Eye,
  FileSpreadsheet,
  Lock,
  RefreshCw,
  Search,
  ShieldAlert,
  Zap,
} from "lucide-react";
import { useI18n } from "@/components/I18nProvider";
import PageHeader from "@/components/ui/PageHeader";
import { DataTablePagination } from "@/components/ui/DataTablePagination";
import { DataTableStateRow } from "@/components/ui/DataTableState";
import { formatBytes } from "@/lib/unitParser";
import OcsDetailDrawer from "./OcsDetailDrawer";
import type {
  OcsReservationRecord,
  OcsUsageRecord,
} from "@/server/repositories/ocsOperationsRepository";

export default function OcsUsagePanel() {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<"usage" | "reservations">("usage");
  const [loading, setLoading] = useState(false);

  // Tab 1: Usage Records state
  const [usageRecords, setUsageRecords] = useState<OcsUsageRecord[]>([]);
  const [usageTotal, setUsageTotal] = useState(0);
  const [usagePage, setUsagePage] = useState(1);
  const [usageLimit, setUsageLimit] = useState(20);
  const [usageSearch, setUsageSearch] = useState("");
  const [ccTypeFilter, setCcTypeFilter] = useState("all");
  const [chargedFilter, setChargedFilter] = useState("all");

  const [usageSummary, setUsageSummary] = useState({
    totalRecords: 0,
    totalChargedRecords: 0,
    totalInputOctets: 0,
    totalOutputOctets: 0,
    totalOctets: 0,
  });

  // Tab 2: Reservations state
  const [reservationRecords, setReservationRecords] = useState<OcsReservationRecord[]>([]);
  const [reservationTotal, setReservationTotal] = useState(0);
  const [reservationPage, setReservationPage] = useState(1);
  const [reservationLimit, setReservationLimit] = useState(20);
  const [reservationSearch, setReservationSearch] = useState("");
  const [stateFilter, setStateFilter] = useState("all");
  const [chargingTypeFilter, setChargingTypeFilter] = useState("all");

  const [reservationSummary, setReservationSummary] = useState({
    totalReservations: 0,
    activeReservations: 0,
    settledReservations: 0,
    orphanedReservations: 0,
    totalReservedOctets: 0,
    totalReleasedOctets: 0,
  });

  // Selected item for detail drawer
  const [selectedRecord, setSelectedRecord] = useState<Record<string, unknown> | null>(null);
  const [detailTitle, setDetailTitle] = useState("");

  const fetchUsage = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(usagePage),
        limit: String(usageLimit),
        imsi: usageSearch.trim(),
        ccRequestType: ccTypeFilter,
        charged: chargedFilter,
      });
      const res = await fetch(`/api/ocs/usage?${params.toString()}`);
      if (res.ok) {
        const data = await res.json();
        if (data.ok) {
          setUsageRecords(data.records || []);
          setUsageTotal(data.total || 0);
          if (data.summary) {
            setUsageSummary(data.summary);
          }
        }
      }
    } catch (e) {
      console.error("Failed to fetch OCS usage:", e);
    } finally {
      setLoading(false);
    }
  }, [usagePage, usageLimit, usageSearch, ccTypeFilter, chargedFilter]);

  const fetchReservations = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(reservationPage),
        limit: String(reservationLimit),
        imsi: reservationSearch.trim(),
        state: stateFilter,
        chargingType: chargingTypeFilter,
      });
      const res = await fetch(`/api/ocs/reservations?${params.toString()}`);
      if (res.ok) {
        const data = await res.json();
        if (data.ok) {
          setReservationRecords(data.records || []);
          setReservationTotal(data.total || 0);
          if (data.summary) {
            setReservationSummary(data.summary);
          }
        }
      }
    } catch (e) {
      console.error("Failed to fetch OCS reservations:", e);
    } finally {
      setLoading(false);
    }
  }, [reservationPage, reservationLimit, reservationSearch, stateFilter, chargingTypeFilter]);

  useEffect(() => {
    if (activeTab === "usage") {
      fetchUsage();
    } else {
      fetchReservations();
    }
  }, [activeTab, fetchUsage, fetchReservations]);

  const usageTotalPages = Math.ceil(usageTotal / usageLimit) || 1;
  const reservationTotalPages = Math.ceil(reservationTotal / reservationLimit) || 1;

  return (
    <div className="ocs-container">
      <PageHeader
        eyebrow="OCS / USAGE"
        title={t("ocs_usage_title")}
        description={t("ocs_usage_desc")}
        status={<><Lock size={12} /> {t("ocs_readonly_badge")}</>}
        actions={<div className="ocs-header-actions">
          <button
            type="button"
            className="ocs-btn"
            onClick={activeTab === "usage" ? fetchUsage : fetchReservations}
            disabled={loading}
          >
            <RefreshCw size={14} className={loading ? "spin" : ""} />
            <span>{t("refresh")}</span>
          </button>
        </div>}
      />

      {/* Safety Notice */}
      <div className="ocs-readonly-banner">
        <ShieldAlert size={18} />
        <span>{t("ocs_readonly_notice")}</span>
      </div>

      {/* Tabs */}
      <div className="ocs-tabs-wrap">
        <button
          type="button"
          className={`ocs-tab-btn ${activeTab === "usage" ? "active" : ""}`}
          onClick={() => setActiveTab("usage")}
        >
          <FileSpreadsheet size={16} />
          <span>{t("ocs_tab_usage_records")}</span>
        </button>
        <button
          type="button"
          className={`ocs-tab-btn ${activeTab === "reservations" ? "active" : ""}`}
          onClick={() => setActiveTab("reservations")}
        >
          <Zap size={16} />
          <span>{t("ocs_tab_reservations")}</span>
        </button>
      </div>

      {/* KPI Cards based on active tab */}
      {activeTab === "usage" ? (
        <div className="ocs-kpi-grid">
          <div className="ocs-kpi-card">
            <div className="ocs-kpi-top">
              <span className="ocs-kpi-label">{t("ocs_kpi_total_records")}</span>
              <div className="ocs-kpi-icon-wrap cyan">
                <FileSpreadsheet size={18} />
              </div>
            </div>
            <div className="ocs-kpi-value">{usageSummary.totalRecords.toLocaleString()}</div>
            <div className="ocs-kpi-sub">Total CCR-U & CCR-T events</div>
          </div>

          <div className="ocs-kpi-card">
            <div className="ocs-kpi-top">
              <span className="ocs-kpi-label">{t("ocs_kpi_charged_records")}</span>
              <div className="ocs-kpi-icon-wrap emerald">
                <CheckCircle size={18} />
              </div>
            </div>
            <div className="ocs-kpi-value" style={{ color: "var(--status-success)" }}>
              {usageSummary.totalChargedRecords.toLocaleString()}
            </div>
            <div className="ocs-kpi-sub">Successfully billed against balances</div>
          </div>

          <div className="ocs-kpi-card">
            <div className="ocs-kpi-top">
              <span className="ocs-kpi-label">{t("ocs_kpi_total_input")}</span>
              <div className="ocs-kpi-icon-wrap">
                <ArrowUpCircle size={18} />
              </div>
            </div>
            <div className="ocs-kpi-value">{formatBytes(usageSummary.totalInputOctets)}</div>
            <div className="ocs-kpi-sub">Uplink traffic volume</div>
          </div>

          <div className="ocs-kpi-card">
            <div className="ocs-kpi-top">
              <span className="ocs-kpi-label">{t("ocs_kpi_total_output")}</span>
              <div className="ocs-kpi-icon-wrap">
                <ArrowDownCircle size={18} />
              </div>
            </div>
            <div className="ocs-kpi-value">{formatBytes(usageSummary.totalOutputOctets)}</div>
            <div className="ocs-kpi-sub">Downlink traffic volume</div>
          </div>

          <div className="ocs-kpi-card">
            <div className="ocs-kpi-top">
              <span className="ocs-kpi-label">{t("ocs_col_total_octets")}</span>
              <div className="ocs-kpi-icon-wrap amber">
                <BarChart3 size={18} />
              </div>
            </div>
            <div className="ocs-kpi-value" style={{ color: "var(--status-warning)" }}>
              {formatBytes(usageSummary.totalOctets)}
            </div>
            <div className="ocs-kpi-sub">Cumulative combined volume</div>
          </div>
        </div>
      ) : (
        <div className="ocs-kpi-grid">
          <div className="ocs-kpi-card">
            <div className="ocs-kpi-top">
              <span className="ocs-kpi-label">Total Reservations</span>
              <div className="ocs-kpi-icon-wrap cyan">
                <Zap size={18} />
              </div>
            </div>
            <div className="ocs-kpi-value">{reservationSummary.totalReservations.toLocaleString()}</div>
            <div className="ocs-kpi-sub">All reservation grants recorded</div>
          </div>

          <div className="ocs-kpi-card">
            <div className="ocs-kpi-top">
              <span className="ocs-kpi-label">{t("ocs_kpi_active_reservations")}</span>
              <div className="ocs-kpi-icon-wrap emerald">
                <Clock size={18} />
              </div>
            </div>
            <div className="ocs-kpi-value" style={{ color: "var(--status-success)" }}>
              {reservationSummary.activeReservations.toLocaleString()}
            </div>
            <div className="ocs-kpi-sub">Currently holding active balance quota</div>
          </div>

          <div className="ocs-kpi-card">
            <div className="ocs-kpi-top">
              <span className="ocs-kpi-label">Settled Reservations</span>
              <div className="ocs-kpi-icon-wrap">
                <CheckCircle size={18} />
              </div>
            </div>
            <div className="ocs-kpi-value">{reservationSummary.settledReservations.toLocaleString()}</div>
            <div className="ocs-kpi-sub">Fully consumed and settled</div>
          </div>

          <div className="ocs-kpi-card">
            <div className="ocs-kpi-top">
              <span className="ocs-kpi-label">{t("ocs_kpi_released_octets")}</span>
              <div className="ocs-kpi-icon-wrap amber">
                <Zap size={18} />
              </div>
            </div>
            <div className="ocs-kpi-value">{formatBytes(reservationSummary.totalReleasedOctets)}</div>
            <div className="ocs-kpi-sub">Quota restored to balance pool</div>
          </div>
        </div>
      )}

      {/* Filter and Control Bar */}
      <div className="ocs-controls-bar">
        <div className="ocs-search-group">
          <Search size={16} className="ocs-search-icon" />
          <input
            type="text"
            className="ocs-search-input"
            placeholder={t("search_placeholder") + " (IMSI / Session-ID)"}
            value={activeTab === "usage" ? usageSearch : reservationSearch}
            onChange={(e) => {
              if (activeTab === "usage") {
                setUsageSearch(e.target.value);
                setUsagePage(1);
              } else {
                setReservationSearch(e.target.value);
                setReservationPage(1);
              }
            }}
          />
        </div>

        {activeTab === "usage" ? (
          <div className="ocs-filters-group">
            <select
              className="ocs-select"
              value={ccTypeFilter}
              onChange={(e) => {
                setCcTypeFilter(e.target.value);
                setUsagePage(1);
              }}
            >
              <option value="all">{t("ocs_filter_all_cc_types")}</option>
              <option value="UPDATE">{t("ocs_filter_cc_update")}</option>
              <option value="TERMINATION">{t("ocs_filter_cc_terminate")}</option>
            </select>

            <select
              className="ocs-select"
              value={chargedFilter}
              onChange={(e) => {
                setChargedFilter(e.target.value);
                setUsagePage(1);
              }}
            >
              <option value="all">{t("ocs_filter_all_charged")}</option>
              <option value="true">{t("ocs_filter_charged_true")}</option>
              <option value="false">{t("ocs_filter_charged_false")}</option>
            </select>
          </div>
        ) : (
          <div className="ocs-filters-group">
            <select
              className="ocs-select"
              value={stateFilter}
              onChange={(e) => {
                setStateFilter(e.target.value);
                setReservationPage(1);
              }}
            >
              <option value="all">{t("ocs_filter_all_states")}</option>
              <option value="active">{t("ocs_filter_active")}</option>
              <option value="settled">{t("ocs_filter_settled")}</option>
              <option value="released">{t("ocs_filter_released")}</option>
              <option value="orphaned">{t("ocs_filter_orphaned")}</option>
            </select>

            <select
              className="ocs-select"
              value={chargingTypeFilter}
              onChange={(e) => {
                setChargingTypeFilter(e.target.value);
                setReservationPage(1);
              }}
            >
              <option value="all">All Charging Types</option>
              <option value="data_volume">Data Volume</option>
              <option value="voice_time">Voice Time</option>
              <option value="sms_count">SMS Count</option>
            </select>
          </div>
        )}
      </div>

      {/* Main Table */}
      <div className="ocs-table-card">
        <div className="ocs-table-wrapper">
          {activeTab === "usage" ? (
            <table className="ocs-table">
              <caption className="sr-only">{t("ocs_tab_usage_records")}</caption>
              <thead>
                <tr>
                  <th data-column-priority="essential">{t("ocs_col_session_id")}</th>
                  <th data-column-priority="essential">{t("ocs_col_imsi")}</th>
                  <th data-column-priority="important">{t("ocs_col_apn")}</th>
                  <th data-column-priority="essential">{t("ocs_col_cc_type")}</th>
                  <th data-column-priority="supplementary">{t("ocs_col_cc_num")}</th>
                  <th data-column-priority="supplementary">{t("ocs_col_input")} / {t("ocs_col_output")}</th>
                  <th data-column-priority="essential">{t("ocs_col_total_octets")}</th>
                  <th data-column-priority="important">{t("ocs_col_charged")}</th>
                  <th data-column-priority="essential">{t("ocs_col_result_code")}</th>
                  <th data-column-priority="supplementary">{t("ocs_col_created_at")}</th>
                  <th data-column-priority="essential">{t("actions")}</th>
                </tr>
              </thead>
              <tbody>
                {usageRecords.length === 0 ? (
                  <DataTableStateRow colSpan={11} state={loading ? "loading" : "empty"}>
                    {loading ? t("loading") : t("no_data")}
                  </DataTableStateRow>
                ) : (
                  usageRecords.map((r) => (
                    <tr key={r.id}>
                      <td className="ocs-mono ocs-cell-session-id" title={r.session_id} data-column-priority="essential" data-label={t("ocs_col_session_id")}>
                        {r.session_id}
                      </td>
                      <td className="ocs-mono ocs-cell-imsi" data-column-priority="essential" data-label={t("ocs_col_imsi")}>
                        {r.imsi}
                      </td>
                      <td className="ocs-mono" data-column-priority="important" data-label={t("ocs_col_apn")}>{r.apn}</td>
                      <td data-column-priority="essential" data-label={t("ocs_col_cc_type")}>
                        <span className={`ocs-badge ${r.cc_request_type === "TERMINATION" ? "status-closed" : "status-active"}`}>
                          {r.cc_request_type}
                        </span>
                      </td>
                      <td className="ocs-mono" data-column-priority="supplementary" data-label={t("ocs_col_cc_num")}>#{r.cc_request_number}</td>
                      <td className="ocs-mono" data-column-priority="supplementary" data-label={t("ocs_col_input")}>
                        <span style={{ color: "var(--chart-2)" }}>{formatBytes(r.input_octets)}</span>
                        <span style={{ color: "var(--text-muted)" }}> / </span>
                        <span style={{ color: "var(--chart-5)" }}>{formatBytes(r.output_octets)}</span>
                      </td>
                      <td className="ocs-mono" style={{ fontWeight: 700, color: "var(--text-main)" }} data-column-priority="essential" data-label={t("ocs_col_total_octets")}>
                        {formatBytes(r.total_octets)}
                      </td>
                      <td data-column-priority="important" data-label={t("ocs_col_charged")}>
                        <span className={`ocs-badge ${r.charged ? "status-active" : "status-closed"}`}>
                          {r.charged ? "CHARGED" : "ZERO / FREE"}
                        </span>
                      </td>
                      <td data-column-priority="essential" data-label={t("ocs_col_result_code")}>
                        <span className={`ocs-badge ${r.result_code === 2001 ? "result-2001" : "result-error"}`}>
                          {r.result_code || 2001}
                        </span>
                      </td>
                      <td className="ocs-mono ocs-cell-timestamp" data-column-priority="supplementary" data-label={t("ocs_col_created_at")}>
                        {r.created_at ? new Date(r.created_at).toLocaleString() : "-"}
                      </td>
                      <td data-column-priority="essential">
                        <button
                          type="button"
                          className="ocs-btn ocs-action-btn"
                          onClick={() => {
                            setSelectedRecord(r as unknown as Record<string, unknown>);
                            setDetailTitle(`CDR Usage Record: ${r.session_id} (#${r.cc_request_number})`);
                          }}
                        >
                          <Eye size={13} />
                          <span>{t("ocs_inspect")}</span>
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          ) : (
            <table className="ocs-table">
              <caption className="sr-only">{t("ocs_tab_reservations")}</caption>
              <thead>
                <tr>
                  <th data-column-priority="essential">{t("ocs_col_session_id")}</th>
                  <th data-column-priority="essential">{t("ocs_col_imsi")}</th>
                  <th data-column-priority="important">{t("ocs_col_apn")}</th>
                  <th data-column-priority="essential">Charging Type</th>
                  <th data-column-priority="essential">State</th>
                  <th data-column-priority="important">Reserved / Used</th>
                  <th data-column-priority="supplementary">{t("ocs_col_released")}</th>
                  <th data-column-priority="important">{t("ocs_col_overuse")}</th>
                  <th data-column-priority="essential">{t("ocs_col_result_code")}</th>
                  <th data-column-priority="supplementary">{t("ocs_col_updated_at")}</th>
                  <th data-column-priority="essential">{t("actions")}</th>
                </tr>
              </thead>
              <tbody>
                {reservationRecords.length === 0 ? (
                  <DataTableStateRow colSpan={11} state={loading ? "loading" : "empty"}>
                    {loading ? t("loading") : t("no_data")}
                  </DataTableStateRow>
                ) : (
                  reservationRecords.map((r) => {
                    const stateClass =
                      r.state === "active"
                        ? "status-active"
                        : r.state === "settled"
                        ? "status-settled"
                        : r.state === "released"
                        ? "status-released"
                        : r.state === "orphaned"
                        ? "status-orphaned"
                        : "status-closed";

                    return (
                      <tr key={r.id}>
                        <td className="ocs-mono ocs-cell-session-id" title={r.session_id} data-column-priority="essential">
                          {r.session_id}
                        </td>
                        <td className="ocs-mono ocs-cell-imsi" data-column-priority="essential">
                          {r.imsi}
                        </td>
                        <td className="ocs-mono" data-column-priority="important">{r.apn}</td>
                        <td data-column-priority="essential">
                          <span className="ocs-badge ocs-badge--neutral">
                            {r.charging_type}
                          </span>
                        </td>
                        <td data-column-priority="essential">
                          <span className={`ocs-badge ${stateClass}`}>
                            {r.state}
                          </span>
                        </td>
                        <td className="ocs-mono" data-column-priority="important">
                          <span style={{ color: "var(--chart-5)" }}>{formatBytes(r.reserved_octets)}</span>
                          <span style={{ color: "var(--text-muted)" }}> / </span>
                          <span style={{ color: "var(--status-warning)" }}>{formatBytes(r.used_octets)}</span>
                        </td>
                        <td className="ocs-mono" style={{ color: "var(--status-success)" }} data-column-priority="supplementary">
                          {formatBytes(r.released_octets)}
                        </td>
                        <td className="ocs-mono" style={{ color: r.overuse_octets > 0 ? "var(--status-danger)" : "var(--text-muted)" }} data-column-priority="important">
                          {formatBytes(r.overuse_octets)}
                        </td>
                        <td data-column-priority="essential">
                          <span className={`ocs-badge ${r.result_code === 2001 ? "result-2001" : "result-error"}`}>
                            {r.result_code}
                          </span>
                        </td>
                        <td className="ocs-mono ocs-cell-timestamp" data-column-priority="supplementary">
                          {r.updated_at ? new Date(r.updated_at).toLocaleString() : "-"}
                        </td>
                        <td data-column-priority="essential">
                          <button
                            type="button"
                            className="ocs-btn ocs-action-btn"
                            onClick={() => {
                              setSelectedRecord(r as unknown as Record<string, unknown>);
                              setDetailTitle(`Quota Reservation: ${r.session_id} (#${r.grant_cc_request_number})`);
                            }}
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
          )}
        </div>

        <DataTablePagination
          page={activeTab === "usage" ? usagePage : reservationPage}
          pageSize={activeTab === "usage" ? usageLimit : reservationLimit}
          total={activeTab === "usage" ? usageTotal : reservationTotal}
          visibleCount={activeTab === "usage" ? usageRecords.length : reservationRecords.length}
          totalPages={activeTab === "usage" ? usageTotalPages : reservationTotalPages}
          labels={{
            showing: t("showing"),
            to: t("to"),
            of: t("of"),
            entries: t("entries"),
            previous: t("prev"),
            next: t("next"),
            perPage: t("per_page"),
          }}
          onPageChange={activeTab === "usage" ? setUsagePage : setReservationPage}
          onPageSizeChange={(nextLimit) => {
            if (activeTab === "usage") {
              setUsageLimit(nextLimit);
              setUsagePage(1);
            } else {
              setReservationLimit(nextLimit);
              setReservationPage(1);
            }
          }}
        />
      </div>

      {/* Detail Drawer */}
      {selectedRecord && (
        <OcsDetailDrawer
          title={detailTitle}
          data={selectedRecord}
          onClose={() => setSelectedRecord(null)}
        />
      )}
    </div>
  );
}
