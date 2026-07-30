"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { Bell, ChevronRight, AlertTriangle, GitBranch } from "lucide-react";
import { useI18n } from "@/components/I18nProvider";
import { useAuth } from "@/hooks/useAuth";
import { fetcher } from "@/lib/fetcher";

type ApprovalStatus = "pending" | "approved" | "rejected" | "executed" | "failed";

export type ApprovalDigest = {
  id: string;
  action: string;
  status: ApprovalStatus;
  requester: string;
  targetId: string;
  summary: string;
  createdAt: string;
  updatedAt?: string;
  error?: string;
};

export default function ApprovalMenu() {
  const [approvalOpen, setApprovalOpen] = useState(false);
  const router = useRouter();
  const { t } = useI18n();
  const { user, isRoot } = useAuth();

  const approvalUrl = user ? `/api/approvals?limit=5&status=${isRoot ? "pending" : "all"}` : null;
  const { data: approvalDigestData } = useSWR<{ approvals: ApprovalDigest[]; pending: number }>(approvalUrl, fetcher, {
    refreshInterval: 30000,
    revalidateOnFocus: true,
  });

  const approvalDigests = approvalDigestData?.approvals || [];
  const approvalPendingCount = approvalDigestData?.pending || 0;
  const approvalAttentionCount = isRoot
    ? approvalPendingCount
    : approvalDigests.filter((approval) => approval.status === "pending" || approval.status === "failed").length;

  const handleApprovalCenter = () => {
    setApprovalOpen(false);
    router.push("/approvals");
  };

  const renderApprovalStatus = (status: ApprovalStatus) => {
    const className = status === "pending" ? "pending" : status === "failed" || status === "rejected" ? "danger" : "success";
    return <span className={`approval-status ${className}`}>{t(`approval_status_${status}`)}</span>;
  };

  return (
    <div className="approval-menu">
      <button className="approval-button" onClick={() => setApprovalOpen((open) => !open)} aria-expanded={approvalOpen} title={t("approval_digest_title")}>
        <Bell size={17} />
        <span>{isRoot ? t("approval_digest_root") : t("approval_digest_mine")}</span>
        {approvalAttentionCount > 0 ? <strong>{approvalAttentionCount > 99 ? "99+" : approvalAttentionCount}</strong> : null}
      </button>

      {approvalOpen && (
        <>
          <div className="dropdown-backdrop" onClick={() => setApprovalOpen(false)} />
          <div className="approval-dropdown">
            <div className="approval-dropdown-head">
              <div>
                <strong>{t("approval_digest_title")}</strong>
                <span>{isRoot ? t("approval_digest_root_desc", { count: approvalPendingCount }) : t("approval_digest_mine_desc", { count: approvalPendingCount })}</span>
              </div>
              <GitBranch size={18} />
            </div>

            <div className="approval-list">
              {approvalDigests.length === 0 ? (
                <div className="approval-empty">
                  <AlertTriangle size={18} />
                  {t("approval_digest_empty")}
                </div>
              ) : approvalDigests.map((approval) => (
                <div key={approval.id} className="approval-row">
                  <div className="approval-row-top">
                    <strong>{t(`approval_action_${approval.action}`)}</strong>
                    {renderApprovalStatus(approval.status)}
                  </div>
                  <span className="approval-row-summary">{approval.summary}</span>
                  {approval.error ? <span className="approval-row-error">{approval.error}</span> : null}
                  <div className="approval-row-meta">
                    <span>{approval.targetId}</span>
                    <time>{new Date(approval.updatedAt || approval.createdAt).toLocaleString()}</time>
                  </div>
                </div>
              ))}
            </div>

            {isRoot ? (
              <button className="approval-footer" onClick={handleApprovalCenter}>
                {t("approval_digest_open_center")}
                <ChevronRight size={15} />
              </button>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
