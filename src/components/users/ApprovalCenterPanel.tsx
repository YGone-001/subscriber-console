"use client";
import "./ApprovalCenterPanel.css";

import { useMemo, useState } from "react";
import useSWR from "swr";
import { AlertTriangle, CheckCircle2, Copy, Eye, GitBranch, RefreshCw, Search, X } from "lucide-react";
import { fetcher } from "@/lib/fetcher";
import { useAuth } from "@/hooks/useAuth";
import { useI18n } from "@/components/I18nProvider";
import { EmptyState, LoadingRows, OperationNotice } from "@/components/OperationFeedback";
import VisualDiffViewer from "@/components/VisualDiffViewer";
import PageHeader from "@/components/ui/PageHeader";
import MetricStrip from "@/components/ui/MetricStrip";

type ApprovalStatus = "pending" | "approved" | "rejected" | "executed" | "failed";
type ApprovalAction =
  | "POLICY_CHANGE"
  | "TRAFFIC_ADJUSTMENT"
  | "RATING_CREATE"
  | "RATING_UPDATE"
  | "RATING_DELETE"
  | "TARIFF_PLAN_MIGRATE"
  | "PROFILE_RESTORE"
  | "SYSTEM_HEAL"
  | "SUBSCRIBER_BATCH_CREATE"
  | "SUBSCRIBER_IMPORT"
  | "SUBSCRIBER_BULK_DELETE";

type ApprovalDocument = {
  id: string;
  action: ApprovalAction;
  status: ApprovalStatus;
  requester: string;
  reviewer?: string;
  targetId: string;
  summary: string;
  payload: Record<string, unknown>;
  note?: string;
  result?: unknown;
  error?: string;
  createdAt: string;
  reviewedAt?: string;
  executedAt?: string;
  updatedAt: string;
};

type ApprovalListResponse = {
  approvals: ApprovalDocument[];
  total: number;
  pending: number;
  sla?: {
    ok: number;
    warning: number;
    danger: number;
    oldestHours: number;
  };
};

type AuditRecord = {
  id: string;
  timestamp: string;
  action: string;
  targetId: string;
  level: string;
};

type ApprovalAuditResponse = {
  logs: AuditRecord[];
  summary: {
    total: number;
    lifecycle: number;
    execution: number;
  };
};

type ApprovalTab = "pending" | "mine" | "completed" | "exceptions";
type RiskFilter = "all" | "low" | "medium" | "high";

function formatDateTime(value?: string) {
  if (!value) return "--";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "--" : date.toLocaleString();
}

function waitingHours(createdAt: string) {
  const created = new Date(createdAt).getTime();
  if (!Number.isFinite(created)) return 0;
  return Math.max(0, Math.floor((Date.now() - created) / 3600000));
}

function riskLevel(approval: ApprovalDocument): Exclude<RiskFilter, "all"> {
  if (approval.status === "failed") return "high";
  if (approval.action === "SYSTEM_HEAL" || approval.action.includes("DELETE") || waitingHours(approval.createdAt) >= 48) return "high";
  if (waitingHours(approval.createdAt) >= 24 || approval.action.includes("IMPORT") || approval.action.includes("MIGRATE")) return "medium";
  return "low";
}

function includesDateRange(value: string, from: string, to: string) {
  if (!from && !to) return true;
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return false;
  if (from && time < new Date(`${from}T00:00:00.000`).getTime()) return false;
  if (to && time > new Date(`${to}T23:59:59.999`).getTime()) return false;
  return true;
}

function jsonPreview(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export default function ApprovalCenterPanel() {
  const { user, isRoot } = useAuth();
  const { t } = useI18n();
  const [tab, setTab] = useState<ApprovalTab>("pending");
  const [query, setQuery] = useState("");
  const [requester, setRequester] = useState("");
  const [action, setAction] = useState("all");
  const [status, setStatus] = useState<ApprovalStatus | "all">("all");
  const [risk, setRisk] = useState<RiskFilter>("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reviewNote, setReviewNote] = useState("");
  const [saving, setSaving] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "danger" | "info"; text: string } | null>(null);

  const apiStatus = tab === "pending" ? "pending" : tab === "exceptions" ? "failed" : "all";
  const approvalUrl = user ? `/api/approvals?limit=300&status=${apiStatus}${isRoot && requester.trim() ? `&requester=${encodeURIComponent(requester.trim())}` : ""}` : null;
  const { data, error, isLoading, mutate, isValidating } = useSWR<ApprovalListResponse>(approvalUrl, fetcher, {
    refreshInterval: 30000,
  });
  const selectedApproval = selectedId ? data?.approvals.find((item) => item.id === selectedId) || null : null;
  const auditUrl = selectedApproval ? `/api/approvals/${selectedApproval.id}/audit` : null;
  const { data: auditData, error: auditError, isLoading: auditLoading, mutate: mutateAudit } = useSWR<ApprovalAuditResponse>(auditUrl, fetcher);

  const approvals = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return (data?.approvals || []).filter((item) => {
      if (tab === "mine" && user && item.requester !== user.username) return false;
      if (tab === "completed" && !["approved", "rejected", "executed"].includes(item.status)) return false;
      if (status !== "all" && item.status !== status) return false;
      if (action !== "all" && item.action !== action) return false;
      if (risk !== "all" && riskLevel(item) !== risk) return false;
      if (!includesDateRange(item.createdAt, from, to)) return false;
      if (!keyword) return true;
      return [item.id, item.action, item.targetId, item.requester, item.status, item.summary].join(" ").toLowerCase().includes(keyword);
    });
  }, [action, data?.approvals, from, query, risk, status, tab, to, user]);

  if (!user) {
    return (
      <div className="approvals-page">
        <EmptyState icon={<GitBranch size={48} />} title={t("users_access_denied")} description={t("users_access_denied_desc")} />
      </div>
    );
  }

  const submitDecision = async (decision: "approve" | "reject") => {
    if (!selectedApproval) return;
    if (decision === "reject" && reviewNote.trim().length < 3) {
      setNotice({ tone: "danger", text: t("approvals_reject_reason_required") });
      return;
    }
    setSaving(decision);
    try {
      const res = await fetch(`/api/approvals/${selectedApproval.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, note: reviewNote.trim() }),
      });
      if (res.ok) {
        setNotice({ tone: "success", text: decision === "reject" ? t("approvals_rejected") : t("approvals_approved_executed") });
        setReviewNote("");
        await mutate();
        await mutateAudit();
      } else {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setNotice({ tone: "danger", text: body.error || t("approvals_action_failed") });
      }
    } catch (requestError) {
      console.error(requestError);
      setNotice({ tone: "danger", text: t("approvals_action_failed") });
    } finally {
      setSaving(null);
    }
  };

  const copyPayload = async () => {
    if (!selectedApproval) return;
    await navigator.clipboard.writeText(jsonPreview(selectedApproval.payload));
    setNotice({ tone: "info", text: t("approvals_payload_copied") });
  };

  const canReview = isRoot && selectedApproval?.status === "pending";

  return (
    <>
      <div className="approvals-page">
        <PageHeader
          eyebrow="CHANGE / GATE"
          icon={<GitBranch size={23} />}
          title={t("approvals_title")}
          description={t("approvals_subtitle")}
          actions={<button type="button" className="btn btn-outline" onClick={() => void mutate()} disabled={isValidating}>
            <RefreshCw size={15} className={isValidating ? "approvals-spin" : undefined} />
            {t("refresh")}
          </button>}
        />

        <MetricStrip
          ariaLabel={t("approvals_title")}
          items={[
            { key: "pending", label: t("approval_filter_pending"), value: data?.pending ?? 0, tone: "primary" },
            { key: "ok", label: t("approvals_sla_ok"), value: data?.sla?.ok ?? 0, tone: "success" },
            { key: "warning", label: t("approvals_sla_warning"), value: data?.sla?.warning ?? 0, tone: "warning" },
            { key: "danger", label: t("approvals_sla_danger"), value: data?.sla?.danger ?? 0, tone: "danger" },
          ]}
        />

        <section className="approvals-panel">
          <nav className="approvals-tabs">
            {(["pending", "mine", "completed", "exceptions"] as ApprovalTab[]).map((item) => (
              <button key={item} type="button" className={tab === item ? "active" : undefined} onClick={() => setTab(item)}>
                {t(`approvals_tab_${item}`)}
              </button>
            ))}
          </nav>

          <div className="approvals-filters">
            <label className="approvals-search">
              <Search size={15} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("approvals_search_ph")} />
            </label>
            <input className="form-input" value={requester} onChange={(event) => setRequester(event.target.value)} placeholder={t("approval_export_requester")} disabled={!isRoot} />
            <select className="form-input" value={action} onChange={(event) => setAction(event.target.value)}>
              <option value="all">{t("approval_filter_all")}</option>
              {(["POLICY_CHANGE", "TRAFFIC_ADJUSTMENT", "RATING_CREATE", "RATING_UPDATE", "RATING_DELETE", "TARIFF_PLAN_MIGRATE", "PROFILE_RESTORE", "SYSTEM_HEAL", "SUBSCRIBER_BATCH_CREATE", "SUBSCRIBER_IMPORT", "SUBSCRIBER_BULK_DELETE"] as ApprovalAction[]).map((item) => (
                <option key={item} value={item}>{t(`approval_action_${item}`)}</option>
              ))}
            </select>
            <select className="form-input" value={status} onChange={(event) => setStatus(event.target.value as ApprovalStatus | "all")}>
              <option value="all">{t("approval_filter_all")}</option>
              {(["pending", "approved", "rejected", "executed", "failed"] as ApprovalStatus[]).map((item) => (
                <option key={item} value={item}>{t(`approval_status_${item}`)}</option>
              ))}
            </select>
            <select className="form-input" value={risk} onChange={(event) => setRisk(event.target.value as RiskFilter)}>
              <option value="all">{t("approvals_risk_all")}</option>
              <option value="low">{t("approvals_risk_low")}</option>
              <option value="medium">{t("approvals_risk_medium")}</option>
              <option value="high">{t("approvals_risk_high")}</option>
            </select>
            <input type="date" className="form-input" value={from} onChange={(event) => setFrom(event.target.value)} />
            <input type="date" className="form-input" value={to} onChange={(event) => setTo(event.target.value)} />
          </div>

          <div className="approvals-table-scroll">
            <table className="approvals-table">
              <caption className="sr-only">{t("approvals_title")}</caption>
              <thead>
                <tr>
                  <th>{t("approvals_id")}</th>
                  <th>{t("approvals_action")}</th>
                  <th>{t("approvals_target")}</th>
                  <th>{t("approval_export_requester")}</th>
                  <th>{t("users_status")}</th>
                  <th>{t("approvals_risk")}</th>
                  <th>{t("users_created")}</th>
                  <th>{t("approvals_waiting")}</th>
                  <th>{t("users_actions")}</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr><td colSpan={9}><LoadingRows columns={9} rows={6} /></td></tr>
                ) : error ? (
                  <tr><td colSpan={9}><EmptyState icon={<AlertTriangle size={42} />} title={t("approvals_error_title")} description={t("approvals_error_desc")} action={<button type="button" className="btn btn-outline" onClick={() => void mutate()}>{t("refresh")}</button>} /></td></tr>
                ) : approvals.length === 0 ? (
                  <tr><td colSpan={9}><EmptyState icon={<CheckCircle2 size={42} />} title={t("approvals_empty_title")} description={t("approvals_empty_desc")} /></td></tr>
                ) : approvals.map((approval) => (
                  <tr key={approval.id}>
                    <td><button type="button" className="approvals-link" onClick={() => setSelectedId(approval.id)}>{approval.id.slice(0, 8)}</button></td>
                    <td>{t(`approval_action_${approval.action}`)}</td>
                    <td>{approval.targetId}</td>
                    <td>{approval.requester}</td>
                    <td><span className={`approval-chip ${approval.status}`}>{t(`approval_status_${approval.status}`)}</span></td>
                    <td><span className={`risk-chip ${riskLevel(approval)}`}>{t(`approvals_risk_${riskLevel(approval)}`)}</span></td>
                    <td>{formatDateTime(approval.createdAt)}</td>
                    <td>{t("approvals_waiting_hours", { hours: waitingHours(approval.createdAt) })}</td>
                    <td><button type="button" className="btn btn-outline" onClick={() => setSelectedId(approval.id)}><Eye size={15} />{t("users_view")}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {selectedApproval ? (
        <div className="approval-drawer-layer" role="dialog" aria-modal="true" aria-label={t("approvals_detail_title")}>
          <button type="button" className="approval-drawer-backdrop" aria-label={t("close")} onClick={() => setSelectedId(null)} />
          <aside className="approval-drawer">
            <header>
              <div>
                <h2>{selectedApproval.id}</h2>
                <p>{selectedApproval.summary}</p>
              </div>
              <button type="button" className="btn-icon" onClick={() => setSelectedId(null)} aria-label={t("close")}><X size={18} /></button>
            </header>

            <div className="approval-detail">
              <section>
                <h3>{t("users_detail_tab_basic")}</h3>
                <dl>
                  <div><dt>{t("approvals_action")}</dt><dd>{t(`approval_action_${selectedApproval.action}`)}</dd></div>
                  <div><dt>{t("approvals_target")}</dt><dd>{selectedApproval.targetId}</dd></div>
                  <div><dt>{t("approval_export_requester")}</dt><dd>{selectedApproval.requester}</dd></div>
                  <div><dt>{t("users_status")}</dt><dd>{t(`approval_status_${selectedApproval.status}`)}</dd></div>
                  <div><dt>{t("approvals_risk")}</dt><dd>{t(`approvals_risk_${riskLevel(selectedApproval)}`)}</dd></div>
                  <div><dt>{t("users_created")}</dt><dd>{formatDateTime(selectedApproval.createdAt)}</dd></div>
                </dl>
              </section>

              <section>
                <h3>{t("approvals_reason")}</h3>
                <p>{selectedApproval.note || selectedApproval.summary}</p>
              </section>

              <section>
                <h3>{t("approvals_business_diff")}</h3>
                <div style={{ marginTop: '0.5rem' }}>
                  <VisualDiffViewer
                    oldData={(selectedApproval.payload as any)?.previous || (selectedApproval.payload as any)?.current || null}
                    newData={(selectedApproval.payload as any)?.changes || selectedApproval.payload}
                    title={`${selectedApproval.action} · ${selectedApproval.targetId}`}
                    defaultMode="semantic"
                    compact
                  />
                </div>
              </section>

              <section>
                <h3>{t("approvals_advanced_payload")}</h3>
                <button type="button" className="btn btn-outline" onClick={copyPayload}><Copy size={15} />{t("approvals_copy_payload")}</button>
                <details>
                  <summary>{t("approvals_show_json")}</summary>
                  <pre>{jsonPreview(selectedApproval.payload)}</pre>
                </details>
              </section>

              <section>
                <h3>{t("approvals_history")}</h3>
                <div className="approval-history">
                  <div><span>{t("users_created")}</span><strong>{formatDateTime(selectedApproval.createdAt)}</strong></div>
                  {selectedApproval.reviewedAt ? <div><span>{t("approvals_reviewed")}</span><strong>{formatDateTime(selectedApproval.reviewedAt)} · {selectedApproval.reviewer}</strong></div> : null}
                  {selectedApproval.executedAt ? <div><span>{t("approvals_executed")}</span><strong>{formatDateTime(selectedApproval.executedAt)}</strong></div> : null}
                  {selectedApproval.error ? <div><span>{t("error")}</span><strong>{selectedApproval.error}</strong></div> : null}
                </div>
              </section>

              <section>
                <h3>{t("users_detail_tab_activity")}</h3>
                {auditLoading ? <LoadingRows columns={4} rows={3} /> : auditError ? (
                  <EmptyState icon={<AlertTriangle size={36} />} title={t("users_audit_error_title")} description={t("users_audit_error_desc")} />
                ) : auditData?.logs.length ? (
                  <div className="approval-history">
                    {auditData.logs.map((log) => <div key={log.id}><span>{formatDateTime(log.timestamp)}</span><strong>{log.action} · {log.targetId} · {log.level}</strong></div>)}
                  </div>
                ) : <p>{t("users_no_activity_data_desc")}</p>}
              </section>
            </div>

            <footer>
              {canReview ? (
                <>
                  <textarea value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} placeholder={t("approvals_review_note_ph")} rows={3} />
                  <div>
                    <button type="button" className="btn btn-outline danger" disabled={saving != null} onClick={() => void submitDecision("reject")}>{t("approvals_reject")}</button>
                    <button type="button" className="btn btn-outline" disabled title={t("approvals_approve_only_unavailable")}>{t("approvals_approve_only")}</button>
                    <button type="button" className="btn btn-primary" disabled={saving != null} onClick={() => void submitDecision("approve")}>{t("approvals_approve_execute")}</button>
                  </div>
                </>
              ) : <span>{t("approvals_no_actions")}</span>}
            </footer>
          </aside>
        </div>
      ) : null}

      {notice ? <OperationNotice presentation="modal" tone={notice.tone} title={notice.tone === "danger" ? t("error") : notice.tone === "success" ? t("success") : t("info")} message={notice.text} onClose={() => setNotice(null)} /> : null}
      
    </>
  );
}
