"use client";

import { useState } from "react";
import AnalyticsCockpit from "@/components/AnalyticsCockpit";
import { DatabaseZap } from "lucide-react";
import { useI18n } from "@/components/I18nProvider";
import { OperationNotice, type FeedbackTone } from "@/components/OperationFeedback";

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

  return (
    <div className="container animate-fade-in p-12">
      {feedback && (
        <OperationNotice
          presentation="modal"
          tone={feedback.tone}
          title={feedback.title}
          message={feedback.message}
          onClose={() => setFeedback(null)}
        />
      )}

      {/* Page Header */}
      <div className="flex justify-between items-center mb-8">
        <div>
          <h2 className="m-0 text-2xl font-bold text-[var(--text-main)]">
            {t("dashboard_title")}
          </h2>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">
            {t("dashboard_subtitle")}
          </p>
        </div>
        {/* Sync Telemetry Button */}
        <button
          onClick={async (e) => {
            const btn = e.currentTarget;
            const originalHTML = btn.innerHTML;
            btn.disabled = true;
            btn.classList.add('radar-animating');
            btn.innerHTML = `<span style="opacity: 0.5;">${t("sync_scanning")}</span>`;
            try {
              const res = await fetch('/api/analytics/init', { method: 'POST' });
              if (!res.ok) throw new Error(t("sync_error"));
              btn.innerHTML = `<span style="color:var(--success)">${t("sync_ok")}</span>`;
              setFeedback({ tone: "success", title: t("success"), message: `${t("sync_telemetry")} ${t("sync_ok")}` });
              setTimeout(() => {
                btn.innerHTML = originalHTML;
                btn.classList.remove('radar-animating');
                btn.disabled = false;
              }, 2000);
            } catch (error) {
              btn.innerHTML = t("sync_error");
              setFeedback({ tone: "danger", title: t("error"), message: error instanceof Error ? error.message : t("sync_error") });
              setTimeout(() => {
                btn.innerHTML = originalHTML;
                btn.classList.remove('radar-animating');
                btn.disabled = false;
              }, 2000);
            }
          }}
          title={t("sync_tooltip")}
          style={{
            display: "flex", alignItems: "center", gap: "0.5rem",
            border: "1px solid var(--surface-border)", background: "var(--surface)",
            padding: "0.5rem 1rem", borderRadius: "20px",
            fontSize: "0.85rem", fontWeight: 600,
            color: "var(--text-secondary)", cursor: "pointer",
            transition: "all 0.2s"
          }}
        >
          <DatabaseZap size={14} color="var(--primary)" /> {t("sync_telemetry")}
        </button>
      </div>

      {/* Analytics Cockpit - Charts and Metric Cards */}
      <AnalyticsCockpit />

    </div>
  );
}
