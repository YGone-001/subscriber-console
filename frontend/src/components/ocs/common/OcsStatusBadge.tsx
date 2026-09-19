"use client";

interface OcsStatusBadgeProps {
  status: string;
  className?: string;
}

const STATUS_STYLES: Record<string, string> = {
  active: "ocs-status-badge ocs-status-active",
  disabled: "ocs-status-badge ocs-status-disabled",
  suspended: "ocs-status-badge ocs-status-suspended",
  terminated: "ocs-status-badge ocs-status-terminated",
  pending: "ocs-status-badge ocs-status-pending",
  pending_approval: "ocs-status-badge ocs-status-pending",
  approved: "ocs-status-badge ocs-status-approved",
  rejected: "ocs-status-badge ocs-status-rejected",
  completed: "ocs-status-badge ocs-status-completed",
  executed: "ocs-status-badge ocs-status-completed",
  expired: "ocs-status-badge ocs-status-expired",
  cancelled: "ocs-status-badge ocs-status-cancelled",
  executing: "ocs-status-badge ocs-status-executing",
  failed: "ocs-status-badge ocs-status-failed",
};

export default function OcsStatusBadge({ status, className }: OcsStatusBadgeProps) {
  const normalized = status ? status.toLowerCase() : "";
  const baseClass = STATUS_STYLES[normalized] || "ocs-status-badge";
  return (
    <span className={className ? `${baseClass} ${className}` : baseClass}>
      {status}
    </span>
  );
}
