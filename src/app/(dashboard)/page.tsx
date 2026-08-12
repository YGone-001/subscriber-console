"use client";

import { useState } from "react";
import AnalyticsCockpit from "@/components/AnalyticsCockpit";
import { DatabaseZap, RadioTower } from "lucide-react";
import { useI18n } from "@/components/I18nProvider";
import { OperationNotice, type FeedbackTone } from "@/components/OperationFeedback";
import PageHeader from "@/components/ui/PageHeader";

type FeedbackState = {
  tone: FeedbackTone;
  title: string;
  message: string;
};

/**
 * Dashboard (Overview) Page
 * --
 * This is the default landing page after login.
 * It renders the AnalyticsCockpit component which contains:
 * - 4 Metric summary cards (Total Traffic, PLMN Regions, Rating Groups, Traffic Exhaustion)
 * - Top 5 Traffic Consumers bar chart
 * - PLMN Traffic Density pie chart
 * - Sync Telemetry button for backfill initialization
 */
export default function DashboardPage() {
  const { t } = useI18n();
  const [feedback, setFeedback] = useState<FeedbackState | null>(null);
  const [syncState, setSyncState] = useState<"idle" | "syncing" | "success" | "error">("idle");

  const handleSync = async () => {
    if (syncState === "syncing") return;
    setSyncState("syncing");
    try {
      const res = await fetch("/api/analytics/init", { method: "POST" });
      if (!res.ok) throw new Error(t("sync_error"));
      
      setSyncState("success");
      setFeedback({ tone: "success", title: t("success"), message: `${t("sync_telemetry")} ${t("sync_ok")}` });
      setTimeout(() => setSyncState("idle"), 2000);
    } catch (error) {
      setSyncState("error");
      setFeedback({ tone: "danger", title: t("error"), message: error instanceof Error ? error.message : t("sync_error") });
      setTimeout(() => setSyncState("idle"), 2000);
    }
  };

  return (
    <div className="container animate-fade-in">
      {feedback && (
        <OperationNotice
          presentation="modal"
          tone={feedback.tone}
          title={feedback.title}
          message={feedback.message}
          onClose={() => setFeedback(null)}
        />
      )}

      <PageHeader
        eyebrow={t("dash_live")}
        icon={<RadioTower size={24} />}
        title={t("dashboard_title")}
        description={t("dash_workbench_subtitle")}
        actions={(
          <button
            onClick={handleSync}
            disabled={syncState === "syncing"}
            className={`btn btn-outline analytics-sync-btn ${syncState === "syncing" ? "radar-animating" : ""}`}
            title={t("sync_tooltip")}
          >
            {syncState === "syncing" ? (
              <span>{t("sync_scanning")}</span>
            ) : syncState === "success" ? (
              <span className="text-success">{t("sync_ok")}</span>
            ) : syncState === "error" ? (
              <span className="text-danger">{t("sync_error")}</span>
            ) : (
              <>
                <DatabaseZap size={15} /> {t("sync_telemetry")}
              </>
            )}
          </button>
        )}
      />

      {/* Analytics Cockpit - Charts and Metric Cards */}
      <AnalyticsCockpit />

    </div>
  );
}
