"use client";

import { useState, useMemo } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/fetcher";
import {
  Search,
  Users,
  ArrowLeftRight,
  Pause,
  Play,
  Trash2,
} from "lucide-react";
import { useI18n } from "@/components/I18nProvider";
import { DataTablePagination } from "@/components/ui/DataTablePagination";
import OcsPageShell from "./OcsPageShell";

interface OcsSubscriberRecord {
  id: string;
  imsi: string;
  msisdn: string;
  status: string;
  plan_id: string;
  created_at?: string;
  updated_at?: string;
}

export default function OcsSubscribersPanel() {
  const { t } = useI18n();
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [search, setSearch] = useState("");
  const [planFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [sortField, setSortField] = useState("updated_at");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const getAriaSort = (field: string): "ascending" | "descending" | undefined =>
    sortField === field ? (sortOrder === "asc" ? "ascending" : "descending") : undefined;

  const url = useMemo(() => {
    const params = new URLSearchParams({
      page: String(page),
      limit: String(limit),
      imsi: search.trim(),
      planId: planFilter,
      status: statusFilter,
      sortField,
      sortOrder,
    });
    return `/api/ocs/subscribers?${params.toString()}`;
  }, [page, limit, search, planFilter, statusFilter, sortField, sortOrder]);

  const { data, isLoading: loading, mutate: refresh } = useSWR(url, fetcher, {
    keepPreviousData: true,
  });

  const records: OcsSubscriberRecord[] = data?.records || [];
  const total: number = data?.total || 0;

  const toggleSort = (field: string) => {
    if (sortField === field) {
      setSortOrder((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortOrder("desc");
    }
  };

  const executeAction = async (imsi: string, action: string, method: string, url: string, body?: Record<string, string>) => {
    const key = `${imsi}:${action}`;
    setActionLoading(key);
    setFeedback(null);
    try {
      const opts: RequestInit = { method, headers: { "Content-Type": "application/json" } };
      if (body) opts.body = JSON.stringify(body);
      const res = await fetch(url, opts);
      const data = await res.json();
      if (!res.ok) {
        setFeedback({ type: "error", message: data.message || data.error || `Action failed (${res.status})` });
      } else {
        setFeedback({ type: "success", message: data.message || `${action} successful` });
        refresh();
      }
    } catch {
      setFeedback({ type: "error", message: t("ocs_sub_action_network_error") });
    } finally {
      setActionLoading(null);
    }
  };

  const handleSuspend = (imsi: string) => executeAction(imsi, "suspend", "POST", `/api/ocs/subscribers/${imsi}/suspend`);
  const handleResume = (imsi: string) => executeAction(imsi, "resume", "POST", `/api/ocs/subscribers/${imsi}/resume`);
  const handleTerminate = (imsi: string) => {
    if (!window.confirm(t("ocs_sub_confirm_terminate").replace("{imsi}", imsi))) return;
    executeAction(imsi, "terminate", "DELETE", `/api/ocs/subscribers/${imsi}`);
  };
  const handleChangeTariff = (imsi: string, currentPlanId: string) => {
    const newPlanId = window.prompt(t("ocs_sub_prompt_change_tariff").replace("{plan}", currentPlanId));
    if (!newPlanId || newPlanId.trim() === "" || newPlanId === currentPlanId) return;
    executeAction(imsi, "change-tariff", "PATCH", `/api/ocs/subscribers/${imsi}`, { plan_id: newPlanId.trim() });
  };

  const formatTime = (iso?: string) => {
    if (!iso) return "—";
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  };

  const kpiGrid = (
    <div className="ocs-kpi-grid">
      <div className="ocs-kpi-card">
        <Users size={20} />
        <div>
          <span className="ocs-kpi-value">{total}</span>
          <span className="ocs-kpi-label">{t("ocs_subscribers_total")}</span>
        </div>
      </div>
    </div>
  );

  const controls = (
    <div className="ocs-controls">
      <div className="ocs-search-wrap">
        <Search size={14} className="ocs-search-icon" />
        <input
          type="text"
          className="ocs-search-input"
          placeholder={t("ocs_subscribers_search_ph")}
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
        />
      </div>
      <select
        className="ocs-filter-select"
        value={statusFilter}
        onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
      >
        <option value="">{t("ocs_filter_all_statuses")}</option>
        <option value="active">active</option>
        <option value="suspended">suspended</option>
      </select>
    </div>
  );

  const feedbackBanner = feedback && (
    <div className={`ocs-feedback-${feedback.type}`}>
      {feedback.message}
    </div>
  );

  const tableContent = (
    <>
      {feedbackBanner}
      <table className="ocs-table">
      <caption className="sr-only">{t("ocs_subscribers_title")}</caption>
      <thead>
        <tr>
          <th
            className="ocs-th-sortable"
            aria-sort={getAriaSort("imsi")}
            onClick={() => toggleSort("imsi")}
          >
            IMSI {sortField === "imsi" ? (sortOrder === "asc" ? "↑" : "↓") : ""}
          </th>
          <th>{t("ocs_subscribers_col_msisdn")}</th>
          <th
            className="ocs-th-sortable"
            aria-sort={getAriaSort("plan_id")}
            onClick={() => toggleSort("plan_id")}
          >
            {t("ocs_subscribers_col_plan")} {sortField === "plan_id" ? (sortOrder === "asc" ? "↑" : "↓") : ""}
          </th>
          <th
            className="ocs-th-sortable"
            aria-sort={getAriaSort("status")}
            onClick={() => toggleSort("status")}
          >
            {t("status")} {sortField === "status" ? (sortOrder === "asc" ? "↑" : "↓") : ""}
          </th>
          <th
            className="ocs-th-sortable"
            aria-sort={getAriaSort("updated_at")}
            onClick={() => toggleSort("updated_at")}
          >
            {t("ocs_subscribers_col_updated")} {sortField === "updated_at" ? (sortOrder === "asc" ? "↑" : "↓") : ""}
          </th>
          <th>{t("actions")}</th>
        </tr>
      </thead>
      <tbody>
        {records.length === 0 ? (
          <tr><td colSpan={6} className="ocs-empty-cell">{t("no_data")}</td></tr>
        ) : (
          records.map((r) => (
            <tr key={r.id}>
              <td className="ocs-imsi-cell"><code>{r.imsi}</code></td>
              <td>{r.msisdn || "—"}</td>
              <td><span className="ocs-plan-badge">{r.plan_id}</span></td>
              <td>
                <span className={`ocs-status-badge ocs-status-${r.status}`}>
                  {r.status}
                </span>
              </td>
              <td className="ocs-time-cell">{formatTime(r.updated_at)}</td>
              <td>
                <div className="ocs-action-group">
                  <button
                    className="ocs-action-btn"
                    title={t("ocs_sub_action_change_tariff")}
                    disabled={actionLoading === `${r.imsi}:change-tariff`}
                    onClick={() => handleChangeTariff(r.imsi, r.plan_id)}
                  >
                    <ArrowLeftRight size={14} />
                  </button>
                  {r.status === "active" ? (
                    <button
                      className="ocs-action-btn"
                      title={t("ocs_sub_action_suspend")}
                      disabled={actionLoading === `${r.imsi}:suspend`}
                      onClick={() => handleSuspend(r.imsi)}
                    >
                      <Pause size={14} />
                    </button>
                  ) : (
                    <button
                      className="ocs-action-btn"
                      title={t("ocs_sub_action_resume")}
                      disabled={actionLoading === `${r.imsi}:resume`}
                      onClick={() => handleResume(r.imsi)}
                    >
                      <Play size={14} />
                    </button>
                  )}
                  <button
                    className="ocs-action-btn ocs-action-danger"
                    title={t("ocs_sub_action_terminate")}
                    disabled={actionLoading === `${r.imsi}:terminate`}
                    onClick={() => handleTerminate(r.imsi)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </td>
            </tr>
          ))
        )}
      </tbody>
    </table>
    </>
  );

  const pagination = (
    <DataTablePagination
      page={page}
      totalPages={data?.totalPages || 1}
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
      onPageSizeChange={(nextLimit: number) => {
        setLimit(nextLimit);
        setPage(1);
      }}
    />
  );

  return (
    <OcsPageShell
      eyebrow={t("nav_ocs")}
      title={t("ocs_subscribers_title")}
      description={t("ocs_subscribers_desc")}
      loading={loading}
      onRefresh={refresh}
      kpiGrid={kpiGrid}
      controls={controls}
      tableContent={tableContent}
      pagination={pagination}
    />
  );
}
