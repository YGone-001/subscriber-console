import { useI18n } from "@/components/I18nProvider";
import MetricStrip from "@/components/ui/MetricStrip";

export function UsersSummaryPanel({ 
  usersCount, 
  statusCounts,
}: { 
  usersCount: number;
  statusCounts: { active: number; disabled: number };
}) {
  const { t } = useI18n();
  return (
    <MetricStrip
      ariaLabel={t("users_summary")}
      items={[
        { key: "total", label: t("users_count_total"), value: usersCount },
        { key: "active", label: t("users_enabled"), value: statusCounts.active, tone: "success" },
        { key: "disabled", label: t("users_disabled_locked"), value: statusCounts.disabled, tone: "muted" },
      ]}
    />
  );
}
