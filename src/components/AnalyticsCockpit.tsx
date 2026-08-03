"use client";
import './analytics.css';

import React, { useState } from "react";
import useSWR from "swr";
import {
  Activity,
  AlertCircle,
  Clock,
  Globe,
  TrendingUp,
  Radio,
  Layers,
  Database,
  ShieldCheck,
  AlertTriangle,
  LayoutGrid,
} from "lucide-react";
import { useTheme } from "./ThemeProvider";
import { fetcher } from "@/lib/fetcher";
import { useI18n } from "./I18nProvider";

import { MetricsData, SparklineData, AlertResponse, WorkItem, ChangeTask } from "./analytics/types";
import { BYTES_IN_GB, computeHourlyBurnGb, createDistributionSparkline, normalizeRingValue } from "./analytics/utils";
import CountUpNumber from "./analytics/CountUpNumber";
import KpiCard from "./analytics/KpiCard";
import SkeletonDashboard from "./analytics/SkeletonDashboard";
import TopConsumerChart from "./analytics/TopConsumerChart";
import PlmnDistributionChart from "./analytics/PlmnDistributionChart";
import WorkbenchPanel from "./analytics/WorkbenchPanel";
import ChangeQueuePanel from "./analytics/ChangeQueuePanel";
import OcsBalanceCapacityCard from "./analytics/OcsBalanceCapacityCard";
import OcsSessionTelemetryCard from "./analytics/OcsSessionTelemetryCard";
import TariffPlanDistributionChart from "./analytics/TariffPlanDistributionChart";

type DashboardTab = "all" | "ocs" | "network";

export default function AnalyticsCockpit() {
  const { theme } = useTheme();
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<DashboardTab>("all");

  const { data, error, isLoading } = useSWR<MetricsData>("/api/analytics/metrics", fetcher, { refreshInterval: 5000 });
  const { data: sparkData } = useSWR<SparklineData>("/api/analytics/sparkline", fetcher, { refreshInterval: 30000 });
  const { data: alertData } = useSWR<AlertResponse>("/api/alerts", fetcher, { refreshInterval: 5000 });

  if (isLoading) {
    return <SkeletonDashboard />;
  }

  if (error || data?.error) {
    return (
      <div className="analytics-offline">
        <AlertCircle size={34} />
        <span>{t("dash_offline")}</span>
      </div>
    );
  }

  const totalTraffic = data?.totalTraffic || 0;
  const plmnDist = data?.plmnDist || [];
  const ratesDist = data?.ratesDist || [];
  const top5 = data?.top5 || [];

  const ocsBalances = data?.ocsBalances;
  const ocsSessions = data?.ocsSessions;
  const ocsReservations = data?.ocsReservations;
  const tariffPlanDist = data?.tariffPlanDist || [];

  const trafficSparkline = sparkData?.traffic || [];
  const subscriberSparkline = sparkData?.subscribers || [];
  const plmnSparkline = createDistributionSparkline(plmnDist);
  const ratingSparkline = createDistributionSparkline(ratesDist);

  const gbTraffic = totalTraffic / BYTES_IN_GB;
  const burnRateGbHr = computeHourlyBurnGb(trafficSparkline);
  const theoreticalLifeHr = burnRateGbHr > 0 ? gbTraffic / burnRateGbHr : 0;
  const subscriberCount = sparkData?.currentSubCount || ocsBalances?.totalSubscribers || 0;
  const plmnCount = plmnDist.length;
  const ratingGroupCount = ratesDist.length;
  const topConsumerShare = totalTraffic > 0 && top5[0]?.balance ? (top5[0].balance / totalTraffic) * 100 : 0;
  const plmnCoverage = normalizeRingValue((plmnCount / 8) * 100);
  const ratingCoverage = normalizeRingValue((ratingGroupCount / 12) * 100);
  const exhaustionTone = theoreticalLifeHr > 0 && theoreticalLifeHr < 24 ? "danger" : theoreticalLifeHr > 0 && theoreticalLifeHr < 72 ? "warning" : "normal";
  const activeAlerts = (alertData?.alerts || []).filter((alert) => !alert.is_acknowledged);
  const activeCriticalCount = alertData?.activeCriticalCount || activeAlerts.filter((alert) => alert.level === "CRITICAL").length;
  const activeWarningCount = alertData?.activeWarningCount || activeAlerts.filter((alert) => alert.level === "WARNING").length;
  const activeAlertCount = alertData?.activeCount || activeAlerts.length;

  const brokenInvariants = ocsBalances?.brokenInvariantCount || 0;
  const orphanedReservations = ocsReservations?.orphanedReservations || 0;
  const utilizationRate = ocsBalances?.dataUtilizationRate || 0;

  const operationsScore = normalizeRingValue(
    100 -
    activeCriticalCount * 20 -
    activeWarningCount * 8 -
    (brokenInvariants > 0 ? 15 : 0) -
    (orphanedReservations > 0 ? 10 : 0) -
    (exhaustionTone === "danger" ? 15 : exhaustionTone === "warning" ? 8 : 0)
  );

  const topImsi = top5[0]?.imsi || "--";

  // Work Items generation with OCS telemetry awareness
  const workItems: WorkItem[] = [];
  if (activeCriticalCount > 0) {
    workItems.push({
      id: "critical-alerts",
      tone: "danger",
      title: t("dash_work_critical_title", { count: activeCriticalCount }),
      detail: t("dash_work_critical_detail"),
      href: "/system-health",
      action: t("dash_work_open_health"),
    });
  }
  if (brokenInvariants > 0) {
    workItems.push({
      id: "broken-invariants",
      tone: "danger",
      title: t("dash_work_invariant_title", { count: brokenInvariants }),
      detail: t("dash_work_invariant_detail"),
      href: "/ocs/balances",
      action: t("dash_work_open_ocs"),
    });
  }
  if (orphanedReservations > 0) {
    workItems.push({
      id: "orphaned-reservations",
      tone: "warning",
      title: t("dash_work_orphaned_title", { count: orphanedReservations }),
      detail: t("dash_work_orphaned_detail"),
      href: "/ocs/usage",
      action: t("dash_work_open_ocs"),
    });
  }
  if (activeWarningCount > 0) {
    workItems.push({
      id: "warning-alerts",
      tone: "warning",
      title: t("dash_work_warning_title", { count: activeWarningCount }),
      detail: t("dash_work_warning_detail"),
      href: "/system-health",
      action: t("dash_work_open_health"),
    });
  }
  if (exhaustionTone !== "normal") {
    workItems.push({
      id: "exhaustion",
      tone: exhaustionTone,
      title: t("dash_work_exhaustion_title"),
      detail: theoreticalLifeHr > 0 ? t("dash_work_exhaustion_detail", { hours: theoreticalLifeHr.toFixed(1) }) : t("dash_work_exhaustion_unknown"),
      href: "/subscribers",
      action: t("dash_work_open_subscribers"),
    });
  }
  if (topConsumerShare >= 35 && topImsi !== "--") {
    workItems.push({
      id: "top-consumer",
      tone: "warning",
      title: t("dash_work_top_consumer_title"),
      detail: t("dash_work_top_consumer_detail", { imsi: topImsi, share: topConsumerShare.toFixed(0) }),
      href: "/subscribers",
      action: t("dash_work_open_subscribers"),
    });
  }
  if (ratingGroupCount === 0) {
    workItems.push({
      id: "rating",
      tone: "warning",
      title: t("dash_work_rating_title"),
      detail: t("dash_work_rating_detail"),
      href: "/rating",
      action: t("dash_work_open_rating"),
    });
  }
  if (workItems.length === 0) {
    workItems.push({
      id: "healthy",
      tone: "normal",
      title: t("dash_work_healthy_title"),
      detail: t("dash_work_healthy_detail"),
      href: "/audit-logs",
      action: t("dash_work_open_audit"),
    });
  }

  const visibleWorkItems = workItems.slice(0, 4);
  const changeQueue: ChangeTask[] = [
    {
      id: "CHG-NOC-001",
      tone: activeAlertCount > 0 ? "danger" : "normal",
      title: activeAlertCount > 0 ? t("dash_change_alert_title") : t("dash_change_health_title"),
      scope: t("dash_change_alert_scope", { count: activeAlertCount }),
      phase: activeAlertCount > 0 ? t("dash_change_phase_review") : t("dash_change_phase_ready"),
      canary: activeAlertCount > 0 ? 0 : 100,
      owner: t("dept_noc"),
      href: "/system-health",
      rollbackHref: "/audit-logs",
    },
    {
      id: "CHG-RATE-002",
      tone: ratingGroupCount === 0 ? "warning" : "normal",
      title: ratingGroupCount === 0 ? t("dash_change_rating_title") : t("dash_change_rating_ready_title"),
      scope: t("dash_change_rating_scope", { count: ratingGroupCount }),
      phase: ratingGroupCount === 0 ? t("dash_change_phase_draft") : t("dash_change_phase_canary"),
      canary: ratingGroupCount === 0 ? 0 : 25,
      owner: t("dept_bss_ocs"),
      href: "/rating",
      rollbackHref: "/profile",
    },
    {
      id: "CHG-POL-003",
      tone: exhaustionTone === "danger" ? "danger" : exhaustionTone === "warning" || topConsumerShare >= 35 ? "warning" : "normal",
      title: t("dash_change_policy_title"),
      scope: t("dash_change_policy_scope", { imsi: topImsi, hours: theoreticalLifeHr > 0 ? theoreticalLifeHr.toFixed(1) : "--" }),
      phase: exhaustionTone === "normal" ? t("dash_change_phase_ready") : t("dash_change_phase_canary"),
      canary: exhaustionTone === "danger" ? 5 : exhaustionTone === "warning" ? 10 : 50,
      owner: t("dept_provisioning"),
      href: "/subscribers",
      rollbackHref: "/audit-logs",
    },
  ];

  return (
    <div className="analytics-root">
      {/* Dashboard View Switcher */}
      <div className="analytics-view-header">
        <div className="analytics-view-tabs" role="tablist">
          <button
            type="button"
            className={`analytics-view-tab ${activeTab === "all" ? "active" : ""}`}
            onClick={() => setActiveTab("all")}
            role="tab"
            aria-selected={activeTab === "all"}
          >
            <LayoutGrid size={15} />
            <span>{t("dash_view_all")}</span>
          </button>
          <button
            type="button"
            className={`analytics-view-tab ${activeTab === "ocs" ? "active" : ""}`}
            onClick={() => setActiveTab("ocs")}
            role="tab"
            aria-selected={activeTab === "ocs"}
          >
            <Database size={15} />
            <span>{t("dash_view_ocs")}</span>
            {ocsSessions?.activeSessions !== undefined && (
              <span className="analytics-view-tab-count">{ocsSessions.activeSessions}</span>
            )}
          </button>
          <button
            type="button"
            className={`analytics-view-tab ${activeTab === "network" ? "active" : ""}`}
            onClick={() => setActiveTab("network")}
            role="tab"
            aria-selected={activeTab === "network"}
          >
            <Globe size={15} />
            <span>{t("dash_view_network")}</span>
            <span className="analytics-view-tab-count">{subscriberCount}</span>
          </button>
        </div>
      </div>

      {/* Primary KPI Grid (Network & Core) */}
      {(activeTab === "all" || activeTab === "network") && (
        <div className="analytics-kpi-grid">
          <KpiCard
            color="#4e73df"
            icon={<TrendingUp size={20} />}
            label={t("dash_kpi_total_traffic")}
            value={
              <>
                <CountUpNumber value={gbTraffic} decimals={2} />
                <span>GB</span>
              </>
            }
            detail={burnRateGbHr > 0 ? t("dash_kpi_detail_burn_trend", { rate: burnRateGbHr.toFixed(2) }) : t("dash_kpi_detail_burn_none")}
            sparkline={trafficSparkline}
            ringValue={topConsumerShare}
          />

          <KpiCard
            color="#1cc88a"
            icon={<Activity size={20} />}
            label={t("dash_kpi_active_subs")}
            value={<CountUpNumber value={subscriberCount} />}
            detail={subscriberSparkline.length > 1 ? t("dash_kpi_detail_sub_trend") : t("dash_kpi_detail_sub_wait")}
            sparkline={subscriberSparkline}
            ringValue={subscriberCount > 0 ? 100 : 0}
          />

          <KpiCard
            color="#f6c23e"
            icon={<Globe size={20} />}
            label={t("dash_kpi_plmn_active")}
            value={<CountUpNumber value={plmnCount} />}
            detail={ratingGroupCount > 0 ? t("dash_kpi_detail_rating_mapped", { count: ratingGroupCount }) : t("dash_kpi_detail_rating_none")}
            sparkline={plmnSparkline}
            ringValue={plmnCoverage}
            tone="warning"
          />

          <KpiCard
            color="#e74a3b"
            icon={<Clock size={20} />}
            label={t("dash_kpi_exhaustion")}
            value={
              theoreticalLifeHr > 0 ? (
                <>
                  <CountUpNumber value={theoreticalLifeHr} decimals={1} />
                  <span>{t("dash_unit_hours")}</span>
                </>
              ) : (
                <>--</>
              )
            }
            detail={theoreticalLifeHr > 0 ? t("dash_kpi_detail_exhaust_based") : t("dash_kpi_detail_exhaust_stable")}
            sparkline={ratingSparkline.length ? ratingSparkline : trafficSparkline}
            ringValue={ratingCoverage}
            tone={exhaustionTone}
          />
        </div>
      )}

      {/* OCS Dedicated KPI Deck */}
      {(activeTab === "all" || activeTab === "ocs") && (
        <div className="analytics-kpi-grid">
          <KpiCard
            color="#1cc88a"
            icon={<Radio size={20} />}
            label={t("dash_ocs_kpi_active_sessions")}
            value={<CountUpNumber value={ocsSessions?.activeSessions || 0} />}
            detail={t("dash_ocs_kpi_active_sessions_detail")}
            ringValue={ocsSessions?.totalSessions ? normalizeRingValue(((ocsSessions.activeSessions || 0) / ocsSessions.totalSessions) * 100) : 0}
            tone="normal"
          />

          <KpiCard
            color="#36b9cc"
            icon={<Layers size={20} />}
            label={t("dash_ocs_kpi_reservations")}
            value={<CountUpNumber value={ocsReservations?.activeReservations || 0} />}
            detail={t("dash_ocs_kpi_reservations_detail", { count: ocsReservations?.activeReservations || 0 })}
            ringValue={ocsReservations?.totalReservations ? normalizeRingValue(((ocsReservations.activeReservations || 0) / ocsReservations.totalReservations) * 100) : 0}
          />

          <KpiCard
            color="#4e73df"
            icon={<Database size={20} />}
            label={t("dash_ocs_kpi_utilization")}
            value={
              <>
                <CountUpNumber value={utilizationRate} decimals={1} />
                <span>%</span>
              </>
            }
            detail={t("dash_ocs_kpi_utilization_detail", { rate: utilizationRate.toFixed(1) })}
            ringValue={utilizationRate}
            tone={utilizationRate >= 85 ? "danger" : utilizationRate >= 65 ? "warning" : "normal"}
          />

          <KpiCard
            color={brokenInvariants === 0 ? "#1cc88a" : "#e74a3b"}
            icon={brokenInvariants === 0 ? <ShieldCheck size={20} /> : <AlertTriangle size={20} />}
            label={t("dash_ocs_kpi_invariants")}
            value={brokenInvariants === 0 ? "100%" : `${brokenInvariants} !`}
            detail={brokenInvariants === 0 ? t("dash_ocs_kpi_invariants_ok") : t("dash_ocs_kpi_invariants_broken", { count: brokenInvariants })}
            ringValue={brokenInvariants === 0 ? 100 : Math.max(0, 100 - brokenInvariants * 10)}
            tone={brokenInvariants === 0 ? "normal" : "danger"}
          />
        </div>
      )}

      {/* OCS Telemetry Panels (Capacity Pool & Real-time Sessions) */}
      {(activeTab === "all" || activeTab === "ocs") && (
        <div className="analytics-chart-grid">
          <OcsBalanceCapacityCard metrics={ocsBalances} t={t} />
          <OcsSessionTelemetryCard sessions={ocsSessions} reservations={ocsReservations} t={t} />
        </div>
      )}

      {/* Charts (Tariff Plan, Top Consumers & PLMN Distribution) */}
      <div className="analytics-chart-grid">
        {(activeTab === "all" || activeTab === "ocs") && (
          <TariffPlanDistributionChart tariffPlanDist={tariffPlanDist} theme={theme} t={t} />
        )}
        {(activeTab === "all" || activeTab === "network") && (
          <TopConsumerChart top5={top5} theme={theme} t={t} />
        )}
        {(activeTab === "all" || activeTab === "network") && (
          <PlmnDistributionChart plmnDist={plmnDist} theme={theme} t={t} />
        )}
      </div>

      {/* Operational Workbench & Change Release Queue */}
      <WorkbenchPanel
        visibleWorkItems={visibleWorkItems}
        operationsScore={operationsScore}
        activeAlertCount={activeAlertCount}
        subscriberCount={subscriberCount}
        plmnCount={plmnCount}
        topImsi={topImsi}
        t={t}
      />

      <ChangeQueuePanel changeQueue={changeQueue} t={t} />
    </div>
  );
}
