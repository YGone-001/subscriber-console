"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import useSWR from "swr";
import { fetcher } from "@/lib/fetcher";
import {
  Search,
  Users,
  ArrowLeftRight,
  Pause,
  Play,
  Trash2,
  Eye,
} from "lucide-react";
import { useI18n } from "@/components/I18nProvider";
import { DataTablePagination } from "@/components/ui/DataTablePagination";
import OcsPageShell from "../OcsPageShell";
import OcsStatusBadge from "../common/OcsStatusBadge";
import GovernanceBadge from "../common/GovernanceBadge";
import ConfirmDialog from "../common/ConfirmDialog";

interface OcsContractRecord {
  id: string;
  imsi: string;
  msisdn: string;
  status: string;
  plan_id: string;
  created_at?: string;
  updated_at?: string;
}

export default function OcsContractsPanel() {
  const { t } = useI18n();
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [sortField, setSortField] = useState("updated_at");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [confirmTerminate, setConfirmTerminate] = useState<string | null>(null);

  const getAriaSort = (field: string): "ascending" | "descending" | undefined =>
    sortField === field ? (sortOrder === "asc" ? "ascending" : "descending") : undefined;

  const url = useMemo(() => {
    const params = new URLSearchParams({
      page: String(page),
      limit: String(limit),
      imsi: search.trim(),
      status: statusFilter,
      sortField,
      sortOrder,
    });
    return `/api/ocs/subscribers?${params.toString()}`;
  }, [page, limit, search, statusFilter, sortField, sortOrder]);

  const { data, isLoading: loading, mutate: refresh } = useSWR(url, fetcher, {
    keepPreviousData: true,
  });

  const records: OcsContractRecord[] = data?.records || [];
  const total: number = data?.total || 0;

  const activeCount = records.filter((r) => r.status === "active").length;
  const suspendedCount = records.filter((r) => r.status === "suspended").length;

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
        const msg = data.outcome === "approval_required"
          ? t("ocs_contract_approval_created")
          : data.message || t("ocs_contract_action_success");
        setFeedback({ type: "success", message: msg });
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
    setConfirmTerminate(imsi);
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
    <div className="ocs-dashboard-grid">
      <div className="ocs-dashboard-card">
        <div className="ocs-dashboard-card-icon"><Users size={20} /></div>
        <div className="ocs-dashboard-card-content">
          <span className="ocs-dashboard-card-value">{total}</span>
          <span className="ocs-dashboard-card-label">{t("ocs_contract_total")}</span>
        </div>
      </div>
      <div className="ocs-dashboard-card">
        <div className="ocs-dashboard-card-icon"><Users size={20} /></div>
        <div className="ocs-dashboard-card-content">
          <span className="ocs-dashboard-card-value">{activeCount}</span>
          <span className="ocs-dashboard-card-label">{t("ocs_contract_active")}</span>
        </div>
      </div>
      <div className="ocs-dashboard-card">
        <div className="ocs-dashboard-card-icon"><Pause size={20} /></div>
        <div className="ocs-dashboard-card-content">
          <span className="ocs-dashboard-card-value">{suspendedCount}</span>
          <span className="ocs-dashboard-card-label">{t("ocs_contract_suspended")}</span>
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
          placeholder={t("ocs_contract_search_ph")}
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
      <caption className="sr-only">{t("ocs_contracts_title")}</caption>
      <thead>
        <tr>
          <th className="ocs-th-sortable" aria-sort={getAriaSort("imsi")} onClick={() => toggleSort("imsi")}>
            IMSI {sortField === "imsi" ? (sortOrder === "asc" ? "↑" : "↓") : ""}
          </th>
          <th>{t("ocs_contract_col_msisdn")}</th>
          <th className="ocs-th-sortable" aria-sort={getAriaSort("plan_id")} onClick={() => toggleSort("plan_id")}>
            {t("ocs_contract_col_tariff")} {sortField === "plan_id" ? (sortOrder === "asc" ? "↑" : "↓") : ""}
          </th>
          <th className="ocs-th-sortable" aria-sort={getAriaSort("status")} onClick={() => toggleSort("status")}>
            {t("ocs_contract_col_billing_status")} {sortField === "status" ? (sortOrder === "asc" ? "↑" : "↓") : ""}
          </th>
          <th className="ocs-th-sortable" aria-sort={getAriaSort("updated_at")} onClick={() => toggleSort("updated_at")}>
            {t("ocs_contract_col_updated")} {sortField === "updated_at" ? (sortOrder === "asc" ? "↑" : "↓") : ""}
          </th>
          <th>{t("ocs_contract_col_governance")}</th>
          <th>{t("actions")}</th>
        </tr>
      </thead>
      <tbody>
        {records.length === 0 ? (
          <tr><td colSpan={7} className="ocs-empty-cell">{t("no_data")}</td></tr>
        ) : (
          records.map((r) => (
            <tr key={r.id}>
              <td className="ocs-imsi-cell"><code>{r.imsi}</code></td>
              <td>{r.msisdn || "—"}</td>
              <td><span className="ocs-plan-badge">{r.plan_id}</span></td>
              <td><OcsStatusBadge status={r.status} /></td>
              <td className="ocs-time-cell">{formatTime(r.updated_at)}</td>
              <td><GovernanceBadge compact /></td>
              <td>
                <div className="ocs-action-group">
                  <Link
                    className="ocs-action-btn"
                    title={t("ocs_contract_view_detail")}
                    href={`/ocs/contracts/${r.imsi}`}
                  >
                    <Eye size={14} />
                  </Link>
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
    <>
      <OcsPageShell
        eyebrow={t("nav_ocs")}
        title={t("ocs_contracts_title")}
        readonly={false}
        description={t("ocs_contracts_desc")}
        loading={loading}
        onRefresh={refresh}
        kpiGrid={kpiGrid}
        controls={controls}
        tableContent={tableContent}
        pagination={pagination}
      />
      {confirmTerminate && (
        <ConfirmDialog
          title={t("ocs_confirm_terminate_title")}
          message={t("ocs_sub_confirm_terminate").replace("{imsi}", confirmTerminate)}
          confirmLabel={t("ocs_sub_action_terminate")}
          danger
          loading={!!actionLoading}
          onConfirm={() => {
            executeAction(confirmTerminate, "terminate", "DELETE", `/api/ocs/subscribers/${confirmTerminate}`);
            setConfirmTerminate(null);
          }}
          onCancel={() => setConfirmTerminate(null)}
        />
      )}
    </>
  );
}
