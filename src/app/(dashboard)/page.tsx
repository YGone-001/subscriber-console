"use client";

import AnalyticsCockpit from "@/components/AnalyticsCockpit";
import { RadioTower } from "lucide-react";
import { useI18n } from "@/components/I18nProvider";
import PageHeader from "@/components/ui/PageHeader";

/**
 * Dashboard (Overview) Page
 * --
 * This is the default landing page after login.
 * It renders the AnalyticsCockpit component which contains:
 * - KPI strip (traffic, subscribers, PLMN, sessions, utilization, invariants)
 * - Workbench panel (prioritized action items)
 * - OCS overview cards (balance capacity, session telemetry)
 * - Charts (top consumers, tariff plan distribution)
 */
export default function DashboardPage() {
  const { t } = useI18n();

  return (
    <div className="container animate-fade-in">
      <PageHeader
        eyebrow={t("dash_live")}
        icon={<RadioTower size={24} />}
        title={t("dashboard_title")}
        description={t("dash_workbench_subtitle")}
      />

      {/* Analytics Cockpit - Charts and Metric Cards */}
      <AnalyticsCockpit />
    </div>
  );
}
