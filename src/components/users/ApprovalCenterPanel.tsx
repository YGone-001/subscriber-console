"use client";
import "./ApprovalCenterPanel.css";

import { useId, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { AlertTriangle, CheckCircle2, Copy, Eye, GitBranch, RefreshCw, Search, X } from "lucide-react";
import { fetcher } from "@/lib/fetcher";
import { ROLE_CAPABILITIES } from "@/lib/permissions";
import { normalizePermissionEffect } from "@/lib/userAccessManagement";
import { useAuth } from "@/hooks/useAuth";
import { useI18n } from "@/components/I18nProvider";
import { EmptyState, LoadingRows, OperationNotice } from "@/components/OperationFeedback";
import { ChangeDiff } from "@/components/governance/ChangeDiff";
import { ApprovalStatusBadge, RiskBadge } from "@/components/governance/GovernanceBadges";
import { EventTimeline } from "@/components/governance/EventTimeline";
import { sanitizeAuditPayload } from "@/lib/audit/sanitize";
import type { RiskLevel } from "@/types/governance";
import PageHeader from "@/components/ui/PageHeader";
import MetricStrip from "@/components/ui/MetricStrip";
import { Dialog } from "@/components/ui/Dialog";

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
  | "SUBSCRIBER_BATCH_UPDATE"
  | "SUBSCRIBER_IMPORT"
  | "SUBSCRIBER_BULK_DELETE"
  | "ACCESS_REQUEST";

type ApprovalDocument = {
  id: string;
  action: ApprovalAction;
  status: ApprovalStatus;
  riskLevel?: RiskLevel;
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
  actor?: string;
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

function formatDateTime(value?: string) {
  if (!value) return "--";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "--" : date.toLocaleString();
}

function jsonPreview(value: unknown) {
  try {
    return JSON.stringify(sanitizeAuditPayload(value), null, 2);
  } catch {
    return String(value);
  }
}

export default function ApprovalCenterPanel() {
  const { user, isRoot } = useAuth();
  const { t } = useI18n();
  const [tab, setTab] = useState<ApprovalTab>("pending");
  const [query, setQuery] = useState("");
  const [accessReason, setAccessReason] = useState("");
  const [requestingAccess, setRequestingAccess] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reviewNote, setReviewNote] = useState("");
  const [saving, setSaving] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "danger" | "info"; text: string } | null>(null);
  const dialogTitleId = useId();
  const dialogDescriptionId = useId();
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const apiStatus = tab === "pending" ? "pending" : tab === "exceptions" ? "failed" : "all";
  const approvalUrl = user ? `/api/approvals?limit=300&status=${apiStatus}` : null;
  const { data, error, isLoading, mutate, isValidating } = useSWR<ApprovalListResponse>(approvalUrl, fetcher, {
    refreshInterval: 30000,
  });
  const accessRequestUrl = user?.role === "viewer" ? "/api/approvals?limit=20&status=pending" : null;
  const { data: pendingAccessData, mutate: mutatePendingAccess } = useSWR<ApprovalListResponse>(accessRequestUrl, fetcher);
  const selectedApproval = selectedId ? data?.approvals.find((item) => item.id === selectedId) || null : null;
  const auditUrl = selectedApproval ? `/api/approvals/${selectedApproval.id}/audit` : null;
  const { data: auditData, error: auditError, isLoading: auditLoading, mutate: mutateAudit } = useSWR<ApprovalAuditResponse>(auditUrl, fetcher);

  const approvals = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return (data?.approvals || []).filter((item) => {
      if (tab === "mine" && user && item.requester !== user.username) return false;
      if (tab === "completed" && !["approved", "rejected", "executed"].includes(item.status)) return false;
      if (!keyword) return true;
      return [item.id, item.action, item.targetId, item.requester, item.status, item.summary].join(" ").toLowerCase().includes(keyword);
    });
  }, [data?.approvals, query, tab, user]);

  const accessSummary = useMemo(() => {
    if (!user) return { allowed: 0, approvals: 0, denied: 0 };
    const effects = Object.values(ROLE_CAPABILITIES[user.role]).map(normalizePermissionEffect);
    return {
      allowed: effects.filter((effect) => effect === "allow").length,
      approvals: effects.filter((effect) => effect === "approval_required").length,
      denied: effects.filter((effect) => effect === "deny").length,
    };
  }, [user]);
  const hasPendingAccessRequest = pendingAccessData?.approvals.some((item) => item.action === "ACCESS_REQUEST") ?? false;

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

  const submitAccessRequest = async () => {
    if (accessReason.trim().length < 8) {
      setNotice({ tone: "danger", text: t("access_request_reason_required") });
      return;
    }
    setRequestingAccess(true);
    try {
      const response = await fetch("/api/approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: accessReason.trim() }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        setNotice({ tone: "danger", text: body.error || t("access_request_failed") });
        return;
      }
      setAccessReason("");
      setNotice({ tone: "success", text: t("access_request_submitted") });
      await Promise.all([mutate(), mutatePendingAccess()]);
    } catch (requestError) {
      console.error(requestError);
      setNotice({ tone: "danger", text: t("access_request_failed") });
    } finally {
      setRequestingAccess(false);
    }
  };

  const copyPayload = async () => {
    if (!selectedApproval) return;
    await navigator.clipboard.writeText(jsonPreview(selectedApproval.payload));
    setNotice({ tone: "info", text: t("approvals_payload_copied") });
  };

  const canReview = isRoot && selectedApproval?.status === "pending" && selectedApproval.requester !== user.username;

  return (
    <>
      <div className="approvals-page">
        <PageHeader
          eyebrow={t("eyebrow_change_gate")}
          icon={<GitBranch size={23} />}
          title={t("approvals_title")}
          description={t("approvals_subtitle")}
          actions={<button type="button" className="btn btn-outline" onClick={() => void mutate()} disabled={isValidating}>
            <RefreshCw size={15} className={isValidating ? "approvals-spin" : undefined} />
            {t("refresh")}
          </button>}
        />

        <section className="self-access-panel" aria-labelledby="self-access-title">
          <div>
            <p className="self-access-label">{t("access_request_current_access")}</p>
            <h2 id="self-access-title">{t(`users_${user.role}`)}</h2>
            <p>{t("access_request_scope")}</p>
          </div>
          <dl>
            <div><dt>{t("roles_allow_count")}</dt><dd>{accessSummary.allowed}</dd></div>
            <div><dt>{t("roles_approval_count")}</dt><dd>{accessSummary.approvals}</dd></div>
            <div><dt>{t("roles_deny_count")}</dt><dd>{accessSummary.denied}</dd></div>
          </dl>
          {user.role === "viewer" ? (
            <form className="access-request-form" onSubmit={(event) => { event.preventDefault(); void submitAccessRequest(); }}>
              <label htmlFor="access-request-reason">{t("access_request_reason")}</label>
              <textarea id="access-request-reason" value={accessReason} onChange={(event) => setAccessReason(event.target.value)} placeholder={t("access_request_reason_ph")} rows={2} disabled={hasPendingAccessRequest || requestingAccess} />
              <button type="submit" className="btn btn-primary" disabled={hasPendingAccessRequest || requestingAccess}>
                {hasPendingAccessRequest ? t("access_request_pending") : requestingAccess ? t("access_request_submitting") : t("access_request_submit")}
              </button>
            </form>
          ) : <p className="self-access-state">{t("access_request_not_needed")}</p>}
        </section>

        {isRoot ? <MetricStrip
          ariaLabel={t("approvals_title")}
          items={[
            { key: "pending", label: t("approval_filter_pending"), value: data?.pending ?? 0, tone: "primary" },
            { key: "ok", label: t("approvals_sla_ok"), value: data?.sla?.ok ?? 0, tone: "success" },
            { key: "warning", label: t("approvals_sla_warning"), value: data?.sla?.warning ?? 0, tone: "warning" },
            { key: "danger", label: t("approvals_sla_danger"), value: data?.sla?.danger ?? 0, tone: "danger" },
          ]}
        /> : null}

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
          </div>

          <div className="approvals-table-scroll">
            <table className="approvals-table">
              <caption className="sr-only">{t("approvals_title")}</caption>
              <thead>
                <tr>
                  <th data-column-priority="essential">{t("approvals_id")}</th>
                  <th data-column-priority="essential">{t("approvals_action")}</th>
                  <th data-column-priority="essential">{t("approvals_target")}</th>
                  <th data-column-priority="supplementary">{t("approval_export_requester")}</th>
                  <th data-column-priority="essential">{t("users_status")}</th>
                  <th data-column-priority="supplementary">{t("users_created")}</th>
                  <th data-column-priority="essential">{t("users_actions")}</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr className="approvals-state-row"><td colSpan={7}><LoadingRows columns={7} rows={6} /></td></tr>
                ) : error ? (
                  <tr className="approvals-state-row"><td colSpan={7}><EmptyState icon={<AlertTriangle size={42} />} title={t("approvals_error_title")} description={t("approvals_error_desc")} action={<button type="button" className="btn btn-outline" onClick={() => void mutate()}>{t("refresh")}</button>} /></td></tr>
                ) : approvals.length === 0 ? (
                  <tr className="approvals-state-row"><td colSpan={7}><EmptyState icon={<CheckCircle2 size={42} />} title={t("approvals_empty_title")} description={t("approvals_empty_desc")} /></td></tr>
                ) : approvals.map((approval) => (
                  <tr key={approval.id}>
                    <td data-label={t("approvals_id")} data-column-priority="essential"><button type="button" className="approvals-link" onClick={() => setSelectedId(approval.id)}>{approval.id.slice(0, 8)}</button></td>
                    <td data-label={t("approvals_action")} data-column-priority="essential">{t(`approval_action_${approval.action}`)}</td>
                    <td data-label={t("approvals_target")} data-column-priority="essential">{approval.targetId}</td>
                    <td data-label={t("approval_export_requester")} data-column-priority="supplementary">{approval.requester}</td>
                    <td data-label={t("users_status")} data-column-priority="essential"><ApprovalStatusBadge status={approval.status} /></td>
                    <td data-label={t("users_created")} data-column-priority="supplementary">{formatDateTime(approval.createdAt)}</td>
                    <td data-label={t("users_actions")} data-column-priority="essential"><button type="button" className="btn btn-outline" onClick={() => setSelectedId(approval.id)}><Eye size={15} />{t("users_view")}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {selectedApproval ? (
        <Dialog
          open
          onClose={() => setSelectedId(null)}
          overlayClassName="approval-drawer-layer"
          className="approval-drawer"
          labelledBy={dialogTitleId}
          describedBy={dialogDescriptionId}
          initialFocusRef={closeButtonRef}
        >
            <header>
              <div>
                <h2 id={dialogTitleId}>{selectedApproval.id}</h2>
                <p id={dialogDescriptionId}>{selectedApproval.summary}</p>
              </div>
              <button ref={closeButtonRef} type="button" className="btn-icon" onClick={() => setSelectedId(null)} aria-label={t("close")}><X size={18} /></button>
            </header>

            <div className="approval-detail">
              <section>
                <h3>{t("users_detail_tab_basic")}</h3>
                <dl>
                  <div><dt>{t("approvals_action")}</dt><dd>{t(`approval_action_${selectedApproval.action}`)}</dd></div>
                  <div><dt>{t("approvals_target")}</dt><dd>{selectedApproval.targetId}</dd></div>
                  <div><dt>{t("approval_export_requester")}</dt><dd>{selectedApproval.requester}</dd></div>
                  <div><dt>{t("users_status")}</dt><dd><ApprovalStatusBadge status={selectedApproval.status} /></dd></div>
                  <div><dt>{t("approvals_risk")}</dt><dd><RiskBadge risk={selectedApproval.riskLevel} /></dd></div>
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
                  <ChangeDiff
                    before={selectedApproval.payload.previous ?? selectedApproval.payload.current}
                    after={selectedApproval.payload.changes ?? selectedApproval.payload}
                    title={`${selectedApproval.action} · ${selectedApproval.targetId}`}
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
                  <EventTimeline events={auditData.logs.map((log) => ({
                    id: log.id, timestamp: log.timestamp, type: log.action,
                    actor: log.actor, message: `${log.action} · ${log.targetId} · ${log.level}`,
                  }))} />
                ) : <p>{t("users_no_activity_data_desc")}</p>}
              </section>
            </div>

            <footer>
              {canReview ? (
                <>
                  <textarea value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} placeholder={t("approvals_review_note_ph")} rows={3} />
                  <div>
                    <button type="button" className="btn btn-outline danger" disabled={saving != null} onClick={() => void submitDecision("reject")}>{t("approvals_reject")}</button>
                    <button type="button" className="btn btn-primary" disabled={saving != null} onClick={() => void submitDecision("approve")}>{t("approvals_approve_execute")}</button>
                  </div>
                </>
              ) : <span>{t("approvals_no_actions")}</span>}
            </footer>
        </Dialog>
      ) : null}

      {notice ? <OperationNotice presentation="modal" tone={notice.tone} title={notice.tone === "danger" ? t("error") : notice.tone === "success" ? t("success") : t("info")} message={notice.text} onClose={() => setNotice(null)} /> : null}
      
    </>
  );
}
