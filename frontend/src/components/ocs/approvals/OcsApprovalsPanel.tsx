"use client";

import { useState, useMemo } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/fetcher";
import { Eye, ShieldCheck, Clock, CheckCircle2, XCircle } from "lucide-react";
import { useI18n } from "@/components/I18nProvider";
import { DataTablePagination } from "@/components/ui/DataTablePagination";
import OcsPageShell from "../OcsPageShell";
import OcsStatusBadge from "../common/OcsStatusBadge";

export default function OcsApprovalsPanel() {
  const { t } = useI18n();
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [statusFilter, setStatusFilter] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const url = useMemo(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(limit) });
    if (statusFilter) params.set("status", statusFilter);
    return `/api/approvals?${params.toString()}`;
  }, [page, limit, statusFilter]);

  const { data, isLoading: loading, mutate: refresh } = useSWR(url, fetcher, {
    keepPreviousData: true,
  });

  const { data: detailData } = useSWR(
    selectedId ? `/api/approvals/${selectedId}` : null,
    fetcher,
  );

  const approvals = data?.approvals || [];
  const total = data?.pagination?.total || 0;
  const totalPages = data?.pagination?.totalPages || 1;
  const summary = data?.summary || { canReview: 0, awaiting: 0, todayApproved: 0, highRiskPending: 0 };

  const kpiGrid = (
    <div className="ocs-dashboard-grid">
      <div className="ocs-dashboard-card">
        <div className="ocs-dashboard-card-icon"><Clock size={20} /></div>
        <div className="ocs-dashboard-card-content">
          <span className="ocs-dashboard-card-value">{summary.awaiting}</span>
          <span className="ocs-dashboard-card-label">{t("ocs_approval_awaiting")}</span>
        </div>
      </div>
      <div className="ocs-dashboard-card">
        <div className="ocs-dashboard-card-icon"><ShieldCheck size={20} /></div>
        <div className="ocs-dashboard-card-content">
          <span className="ocs-dashboard-card-value">{summary.canReview}</span>
          <span className="ocs-dashboard-card-label">{t("ocs_approval_can_review")}</span>
        </div>
      </div>
      <div className="ocs-dashboard-card">
        <div className="ocs-dashboard-card-icon"><CheckCircle2 size={20} /></div>
        <div className="ocs-dashboard-card-content">
          <span className="ocs-dashboard-card-value">{summary.todayApproved}</span>
          <span className="ocs-dashboard-card-label">{t("ocs_approval_today_approved")}</span>
        </div>
      </div>
      <div className="ocs-dashboard-card">
        <div className="ocs-dashboard-card-icon"><XCircle size={20} /></div>
        <div className="ocs-dashboard-card-content">
          <span className="ocs-dashboard-card-value">{summary.highRiskPending}</span>
          <span className="ocs-dashboard-card-label">{t("ocs_approval_high_risk")}</span>
        </div>
      </div>
    </div>
  );

  const controls = (
    <div className="ocs-controls">
      <select
        className="ocs-filter-select"
        value={statusFilter}
        onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
      >
        <option value="">{t("ocs_filter_all_statuses")}</option>
        <option value="pending">pending</option>
        <option value="approved">approved</option>
        <option value="rejected">rejected</option>
        <option value="completed">completed</option>
        <option value="cancelled">cancelled</option>
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
          <th>{t("ocs_approval_col_action")}</th>
          <th>{t("ocs_approval_col_resource")}</th>
          <th>{t("ocs_approval_col_requester")}</th>
          <th>{t("ocs_approval_col_created")}</th>
          <th>{t("ocs_approval_col_status")}</th>
          <th>{t("actions")}</th>
        </tr>
      </thead>
      <tbody>
        {approvals.length === 0 && !loading ? (
          <tr><td colSpan={6} className="ocs-empty-cell">{t("no_data")}</td></tr>
        ) : (
          approvals.map((a: any) => (
            <tr key={a._id}>
              <td>{a.action}</td>
              <td>
                <span className="ocs-mono">{a.resourceType}</span>
                {a.resourceId ? <span className="ocs-mono ocs-ml-4">{a.resourceId}</span> : null}
              </td>
              <td>{a.requester || "—"}</td>
              <td className="ocs-time-cell">{formatTime(a.createdAt)}</td>
              <td><OcsStatusBadge status={a.status} /></td>
              <td>
                <button
                  className="ocs-action-btn"
                  title={t("ocs_approval_view_detail")}
                  onClick={() => setSelectedId(a._id)}
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
      visibleCount={approvals.length}
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
      title={t("ocs_approvals_title")}
      description={t("ocs_approvals_desc")}
      loading={loading}
      onRefresh={refresh}
      kpiGrid={kpiGrid}
      controls={controls}
      tableContent={tableContent}
      pagination={pagination}
    >
      {selectedId && detailData?.approval && (
        <div className="ocs-detail-drawer" onClick={() => setSelectedId(null)}>
          <div className="ocs-detail-drawer-content" onClick={(e) => e.stopPropagation()}>
            <div className="ocs-detail-drawer-header">
              <h3>{t("ocs_approval_detail_title")}</h3>
              <button className="ocs-action-btn" onClick={() => setSelectedId(null)}>✕</button>
            </div>
            <div className="ocs-detail-fields">
              <div className="ocs-detail-field">
                <span className="ocs-detail-label">{t("ocs_approval_col_action")}</span>
                <span className="ocs-detail-value">{detailData.approval.action}</span>
              </div>
              <div className="ocs-detail-field">
                <span className="ocs-detail-label">{t("ocs_approval_col_resource")}</span>
                <span className="ocs-detail-value ocs-mono">{detailData.approval.resourceType} / {detailData.approval.resourceId}</span>
              </div>
              <div className="ocs-detail-field">
                <span className="ocs-detail-label">{t("ocs_approval_col_requester")}</span>
                <span className="ocs-detail-value">{detailData.approval.requester}</span>
              </div>
              <div className="ocs-detail-field">
                <span className="ocs-detail-label">{t("ocs_approval_col_status")}</span>
                <span className="ocs-detail-value"><OcsStatusBadge status={detailData.approval.status} /></span>
              </div>
              <div className="ocs-detail-field">
                <span className="ocs-detail-label">{t("ocs_approval_col_created")}</span>
                <span className="ocs-detail-value">{formatTime(detailData.approval.createdAt)}</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </OcsPageShell>
  );
}
