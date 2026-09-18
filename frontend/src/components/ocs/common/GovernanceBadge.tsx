"use client";

import { useI18n } from "@/components/I18nProvider";
import { ShieldCheck, Clock, CheckCircle2, XCircle, AlertTriangle } from "lucide-react";

interface GovernanceBadgeProps {
  status?: string;
  mode?: string;
  compact?: boolean;
}

export default function GovernanceBadge({ status, mode, compact }: GovernanceBadgeProps) {
  const { t } = useI18n();

  if (mode === "DIRECT_GOVERNED") {
    return (
      <span className="ocs-governance-badge ocs-governance-direct">
        <ShieldCheck size={compact ? 10 : 12} />
        {!compact && <span>{t("ocs_governance_direct")}</span>}
      </span>
    );
  }

  if (!status || status === "none") {
    return (
      <span className="ocs-governance-badge ocs-governance-none">
        <ShieldCheck size={compact ? 10 : 12} />
        {!compact && <span>{t("ocs_governance_none")}</span>}
      </span>
    );
  }

  if (status === "pending") {
    return (
      <span className="ocs-governance-badge ocs-governance-pending">
        <Clock size={compact ? 10 : 12} />
        {!compact && <span>{t("ocs_governance_pending")}</span>}
      </span>
    );
  }

  if (status === "approved" || status === "completed" || status === "executed") {
    return (
      <span className="ocs-governance-badge ocs-governance-approved">
        <CheckCircle2 size={compact ? 10 : 12} />
        {!compact && <span>{t("ocs_governance_approved")}</span>}
      </span>
    );
  }

  if (status === "rejected") {
    return (
      <span className="ocs-governance-badge ocs-governance-rejected">
        <XCircle size={compact ? 10 : 12} />
        {!compact && <span>{t("ocs_governance_rejected")}</span>}
      </span>
    );
  }

  return (
    <span className="ocs-governance-badge ocs-governance-unknown">
      <AlertTriangle size={compact ? 10 : 12} />
      {!compact && <span>{status}</span>}
    </span>
  );
}
