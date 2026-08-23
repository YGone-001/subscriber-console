import { ArrowRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/components/I18nProvider";
import * as T from "../types";
import MetricStrip from "@/components/ui/MetricStrip";

export function UsersSummaryPanel({ 
  usersCount, 
  statusCounts, 
  approvalMetrics,
}: { 
  usersCount: number;
  statusCounts: { active: number; disabled: number };
  approvalMetrics?: T.ApprovalMetricResponse;
}) {
  const { t } = useI18n();
  const router = useRouter();
  return (
    <MetricStrip
      ariaLabel={t("users_summary")}
      items={[
        { key: "total", label: t("users_count_total"), value: usersCount },
        { key: "active", label: t("users_enabled"), value: statusCounts.active, tone: "success" },
        { key: "disabled", label: t("users_disabled_locked"), value: statusCounts.disabled, tone: "muted" },
        {
          key: "approval",
          label: t("users_pending_approval"),
          value: approvalMetrics?.pending ?? 0,
          tone: "warning",
          icon: <ArrowRight size={18} />,
          ariaLabel: t("users_open_pending_approvals"),
          onClick: () => router.push("/approvals?status=pending"),
        },
      ]}
    />
  );
}
