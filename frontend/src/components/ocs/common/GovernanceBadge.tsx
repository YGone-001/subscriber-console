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
  const normalizedStatus = status?.toLowerCase();
  const normalizedMode = mode?.toUpperCase();

  let className = "ocs-governance-badge ocs-governance-unknown";
  let label = status || t("ocs_status_unknown");
  let Icon = AlertTriangle;

  if (normalizedMode === "DIRECT_GOVERNED") {
    className = "ocs-governance-badge ocs-governance-direct";
    label = t("ocs_governance_direct");
    Icon = ShieldCheck;
  } else if (!normalizedStatus || normalizedStatus === "none") {
    className = "ocs-governance-badge ocs-governance-none";
    label = t("ocs_governance_none");
    Icon = ShieldCheck;
  } else if (normalizedStatus === "pending") {
    className = "ocs-governance-badge ocs-governance-pending";
    label = t("ocs_governance_pending");
    Icon = Clock;
  } else if (["approved", "completed", "executed"].includes(normalizedStatus)) {
    className = "ocs-governance-badge ocs-governance-approved";
    label = t("ocs_governance_approved");
    Icon = CheckCircle2;
  } else if (normalizedStatus === "rejected") {
    className = "ocs-governance-badge ocs-governance-rejected";
    label = t("ocs_governance_rejected");
    Icon = XCircle;
  }

  return (
    <span className={className} aria-label={label} title={label}>
      <Icon size={compact ? 11 : 12} aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}
