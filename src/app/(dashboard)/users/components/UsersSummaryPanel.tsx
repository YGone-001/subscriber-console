import { useI18n } from "@/components/I18nProvider";
import * as T from "../types";
import MetricStrip from "@/components/ui/MetricStrip";

export function UsersSummaryPanel({ 
  usersCount, 
  statusCounts, 
  approvalMetrics, 
  setNotice 
}: { 
  usersCount: number;
  statusCounts: { active: number; disabled: number };
  approvalMetrics?: T.ApprovalMetricResponse;
  setNotice: (notice: T.Notice | null) => void;
}) {
  const { t } = useI18n();
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
          onClick: () => setNotice({ type: "info", text: t("users_approval_center_reserved") }),
        },
      ]}
    />
  );
}
