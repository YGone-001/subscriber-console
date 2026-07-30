import { useI18n } from "@/components/I18nProvider";
import * as T from "../types";

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
    <section className="users-summary" aria-label={t("users_summary")}>
      <div className="users-metric">
        <span>{t("users_count_total")}</span>
        <strong>{usersCount}</strong>
      </div>
      <div className="users-metric success">
        <span>{t("users_enabled")}</span>
        <strong>{statusCounts.active}</strong>
      </div>
      <div className="users-metric muted">
        <span>{t("users_disabled_locked")}</span>
        <strong>{statusCounts.disabled}</strong>
      </div>
      <button
        type="button"
        className="users-metric warning"
        onClick={() => setNotice({ type: "info", text: t("users_approval_center_reserved") })}
      >
        <span>{t("users_pending_approval")}</span>
        <strong>{approvalMetrics?.pending ?? 0}</strong>
      </button>
    </section>
  );
}
