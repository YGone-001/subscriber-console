"use client";

import { useState, useMemo } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/fetcher";
import { Eye, History, AlertCircle, CheckCircle2 } from "lucide-react";
import { useI18n } from "@/components/I18nProvider";
import { DataTablePagination } from "@/components/ui/DataTablePagination";
import OcsPageShell from "../OcsPageShell";
import OcsStatusBadge from "../common/OcsStatusBadge";

export default function OcsAuditTimeline() {
  const { t } = useI18n();
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [actionFilter, setActionFilter] = useState("");
  const [resultFilter, setResultFilter] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const url = useMemo(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(limit) });
    if (actionFilter) params.set("action", actionFilter);
    if (resultFilter) params.set("result", resultFilter);
    return `/api/audit?${params.toString()}`;
  }, [page, limit, actionFilter, resultFilter]);

  const { data, isLoading: loading, mutate: refresh } = useSWR(url, fetcher, {
    keepPreviousData: true,
  });

  const { data: detailData } = useSWR(
    selectedId ? `/api/audit/${selectedId}` : null,
    fetcher,
  );

  const logs = data?.logs || [];
  const total = data?.pagination?.total || 0;
  const totalPages = data?.pagination?.totalPages || 1;
  const summary = data?.summary || { totalToday: 0, failures: 0, criticalActions: 0 };

  const kpiGrid = (
    <div className="ocs-dashboard-grid">
      <div className="ocs-dashboard-card">
        <div className="ocs-dashboard-card-icon"><History size={20} /></div>
        <div className="ocs-dashboard-card-content">
          <span className="ocs-dashboard-card-value">{summary.totalToday || total}</span>
          <span className="ocs-dashboard-card-label">{t("ocs_audit_total_today")}</span>
        </div>
      </div>
      <div className="ocs-dashboard-card">
        <div className="ocs-dashboard-card-icon"><AlertCircle size={20} /></div>
        <div className="ocs-dashboard-card-content">
          <span className="ocs-dashboard-card-value">{summary.failures || 0}</span>
          <span className="ocs-dashboard-card-label">{t("ocs_audit_failures")}</span>
        </div>
      </div>
      <div className="ocs-dashboard-card">
        <div className="ocs-dashboard-card-icon"><CheckCircle2 size={20} /></div>
        <div className="ocs-dashboard-card-content">
          <span className="ocs-dashboard-card-value">{summary.criticalActions || 0}</span>
          <span className="ocs-dashboard-card-label">{t("ocs_audit_critical_actions")}</span>
        </div>
      </div>
    </div>
  );

  const controls = (
    <div className="ocs-controls">
      <select
        className="ocs-filter-select"
        value={resultFilter}
        onChange={(e) => { setResultFilter(e.target.value); setPage(1); }}
      >
        <option value="">{t("ocs_filter_all_results")}</option>
        <option value="success">{t("ocs_audit_result_success")}</option>
        <option value="failure">{t("ocs_audit_result_failure")}</option>
      </select>
    </div>
  );

  const formatTime = (iso?: string) => {
    if (!iso) return "—";
    try { return new Date(iso).toLocaleString(); } catch { return iso; }
  };

  const tableContent = (
    <table className="ocs-table">
      <thead>
        <tr>
          <th>{t("ocs_audit_col_timestamp")}</th>
          <th>{t("ocs_audit_col_action")}</th>
          <th>{t("ocs_audit_col_object")}</th>
          <th>{t("ocs_audit_col_operator")}</th>
          <th>{t("ocs_audit_col_result")}</th>
          <th>{t("actions")}</th>
        </tr>
      </thead>
      <tbody>
        {logs.length === 0 && !loading ? (
          <tr><td colSpan={6} className="ocs-empty-cell">{t("no_data")}</td></tr>
        ) : (
          logs.map((log: any) => (
            <tr key={log._id}>
              <td className="ocs-time-cell">{formatTime(log.timestamp)}</td>
              <td>{log.action}</td>
              <td>{log.resource?.id || log.targetId || "—"}</td>
              <td>{log.actorContext?.displayName || log.actor || "—"}</td>
              <td>
                <OcsStatusBadge status={log.result === "success" ? "active" : "failed"} />
              </td>
              <td>
                <button
                  className="ocs-action-btn"
                  title={t("ocs_audit_view_detail")}
                  onClick={() => setSelectedId(log._id)}
                >
                  <Eye size={14} />
                </button>
              </td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  );

  const pagination = (
    <DataTablePagination
      page={page}
      totalPages={totalPages}
      total={total}
      pageSize={limit}
      visibleCount={logs.length}
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
      title={t("ocs_audit_title")}
      description={t("ocs_audit_desc")}
      loading={loading}
      onRefresh={refresh}
      kpiGrid={kpiGrid}
      controls={controls}
      tableContent={tableContent}
      pagination={pagination}
    >
      {selectedId && detailData?.log && (
        <div className="ocs-detail-drawer" onClick={() => setSelectedId(null)}>
          <div className="ocs-detail-drawer-content" onClick={(e) => e.stopPropagation()}>
            <div className="ocs-detail-drawer-header">
              <h3>{t("ocs_audit_detail_title")}</h3>
              <button className="ocs-action-btn" onClick={() => setSelectedId(null)}>✕</button>
            </div>
            <div className="ocs-detail-fields">
              <div className="ocs-detail-field">
                <span className="ocs-detail-label">{t("ocs_audit_col_timestamp")}</span>
                <span className="ocs-detail-value">{formatTime(detailData.log.timestamp)}</span>
              </div>
              <div className="ocs-detail-field">
                <span className="ocs-detail-label">{t("ocs_audit_col_action")}</span>
                <span className="ocs-detail-value">{detailData.log.action}</span>
              </div>
              <div className="ocs-detail-field">
                <span className="ocs-detail-label">{t("ocs_audit_col_operator")}</span>
                <span className="ocs-detail-value">{detailData.log.actorContext?.displayName || detailData.log.actor}</span>
              </div>
              <div className="ocs-detail-field">
                <span className="ocs-detail-label">{t("ocs_audit_col_result")}</span>
                <span className="ocs-detail-value"><OcsStatusBadge status={detailData.log.result === "success" ? "active" : "failed"} /></span>
              </div>
              {detailData.log.metadata && (
                <div className="ocs-detail-field">
                  <span className="ocs-detail-label">{t("ocs_audit_detail_metadata")}</span>
                  <pre className="ocs-detail-pre">{JSON.stringify(detailData.log.metadata, null, 2)}</pre>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </OcsPageShell>
  );
}
