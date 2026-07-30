"use client";
import './analytics.css';

import React from "react";
import useSWR from "swr";
import { Activity, AlertCircle, Clock, Globe, TrendingUp } from "lucide-react";
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

export default function AnalyticsCockpit() {
  const { theme } = useTheme();
  const { t } = useI18n();
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

  const trafficSparkline = sparkData?.traffic || [];
  const subscriberSparkline = sparkData?.subscribers || [];
  const plmnSparkline = createDistributionSparkline(plmnDist);
  const ratingSparkline = createDistributionSparkline(ratesDist);

  const gbTraffic = totalTraffic / BYTES_IN_GB;
  const burnRateGbHr = computeHourlyBurnGb(trafficSparkline);
  const theoreticalLifeHr = burnRateGbHr > 0 ? gbTraffic / burnRateGbHr : 0;
  const subscriberCount = sparkData?.currentSubCount || 0;
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
  const operationsScore = normalizeRingValue(100 - activeCriticalCount * 22 - activeWarningCount * 10 - (exhaustionTone === "danger" ? 20 : exhaustionTone === "warning" ? 10 : 0));
  const topImsi = top5[0]?.imsi || "--";

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
      owner: "NOC",
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
      owner: "BSS/OCS",
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
      owner: "Provisioning",
      href: "/subscribers",
      rollbackHref: "/audit-logs",
    },
  ];

  return (
    <div className="analytics-root">
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
          detail={burnRateGbHr > 0 ? `${burnRateGbHr.toFixed(2)} GB/hr 24h trend` : "No active burn trend"}
          sparkline={trafficSparkline}
          ringValue={topConsumerShare}
        />

        <KpiCard
          color="#1cc88a"
          icon={<Activity size={20} />}
          label={t("dash_kpi_active_subs")}
          value={<CountUpNumber value={subscriberCount} />}
          detail={subscriberSparkline.length > 1 ? "Subscriber trend online" : "Waiting for subscriber history"}
          sparkline={subscriberSparkline}
          ringValue={subscriberCount > 0 ? 100 : 0}
        />

        <KpiCard
          color="#f6c23e"
          icon={<Globe size={20} />}
          label={t("dash_kpi_plmn_active")}
          value={<CountUpNumber value={plmnCount} />}
          detail={ratingGroupCount > 0 ? `${ratingGroupCount} rating groups mapped` : "No rating spread yet"}
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
          detail={theoreticalLifeHr > 0 ? "Based on observed 24h burn" : "Stable until trend data accumulates"}
          sparkline={ratingSparkline.length ? ratingSparkline : trafficSparkline}
          ringValue={ratingCoverage}
          tone={exhaustionTone}
        />
      </div>

      <div className="analytics-chart-grid">
        <TopConsumerChart top5={top5} theme={theme} t={t} />
        <PlmnDistributionChart plmnDist={plmnDist} theme={theme} t={t} />
      </div>

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
