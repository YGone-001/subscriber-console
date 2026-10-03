"use client";
import './analytics.css';

import React, { useMemo } from "react";
import useSWR from "swr";
import { Area, AreaChart, ResponsiveContainer } from "recharts";
import {
  Activity,
  AlertCircle,
  Globe,
  TrendingUp,
  Database,
  ShieldCheck,
  AlertTriangle,
  Users,
} from "lucide-react";
import { fetcher } from "@/lib/fetcher";
import { useI18n } from "./I18nProvider";
import MetricStrip, { type MetricStripItem } from "@/components/ui/MetricStrip";
import uiStyles from "@/components/ui/ConsolePrimitives.module.css";

import { MetricsData, SparklineData, AlertResponse, WorkItem } from "./analytics/types";
import { BYTES_IN_GB, computeHourlyBurnGb, normalizeRingValue } from "./analytics/utils";
import CountUpNumber from "./analytics/CountUpNumber";
import SkeletonDashboard from "./analytics/SkeletonDashboard";
import TopConsumerChart from "./analytics/TopConsumerChart";
import WorkbenchPanel from "./analytics/WorkbenchPanel";
import TariffPlanDistributionChart from "./analytics/TariffPlanDistributionChart";
import OcsResourceStrip from "./analytics/OcsResourceStrip";

function MetricSparkline({ data, color }: { data?: number[]; color: string }) {
  const reactId = React.useId();
  const chartData = useMemo(() => {
    if (!data?.length) return [];
    return data.map((value, index) => ({ index, value }));
  }, [data]);

  const gradientId = `metric-spark-${color.replace(/[^a-zA-Z0-9]/g, "")}-${reactId.replace(/:/g, "")}`;

  if (chartData.length === 0) return null;

  return (
    <div className={uiStyles.metricSparkline} aria-hidden="true">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={chartData} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.3} />
              <stop offset="100%" stopColor={color} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <Area
            type="monotone"
            dataKey="value"
            stroke={color}
            strokeWidth={1.5}
            fill={`url(#${gradientId})`}
            dot={false}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function MetricRing({ value, color }: { value: number; color: string }) {
  const safeValue = normalizeRingValue(value);
  return (
    <div
      className={uiStyles.metricRing}
      style={{ background: `conic-gradient(${color} ${safeValue * 3.6}deg, var(--surface-border) 0deg)` }}
      aria-hidden="true"
    >
      <div className={uiStyles.metricRingInner}>{Math.round(safeValue)}</div>
    </div>
  );
}

export default function AnalyticsCockpit() {
  const { t } = useI18n();

  const { data, error, isLoading } = useSWR<MetricsData>("/api/analytics/metrics", fetcher, { refreshInterval: 5000 });
  const { data: sparkData } = useSWR<SparklineData>("/api/analytics/sparkline", fetcher, { refreshInterval: 30000 });
  const { data: alertData } = useSWR<AlertResponse>("/api/alerts", fetcher, { refreshInterval: 5000 });
  const { data: ocsSubData, error: ocsSubError, isLoading: ocsSubLoading } = useSWR<{ total?: number; pagination?: { total?: number } }>("/api/ocs/subscribers?limit=1", fetcher, { refreshInterval: 10000 });

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
  const tariffPlanDist = data?.tariffPlanDist || [];

  // Contract Subscribers metric state
  const isContractSubscribersUnavailable = Boolean(ocsSubError || (!ocsSubData && ocsSubLoading));
  const contractSubscriberCount = !isContractSubscribersUnavailable && ocsSubData != null
    ? (typeof ocsSubData.total === "number" ? ocsSubData.total : (ocsSubData.pagination?.total ?? 0))
    : null;

  const trafficSparkline = sparkData?.traffic || [];

  const gbTraffic = totalTraffic / BYTES_IN_GB;
  const burnRateGbHr = computeHourlyBurnGb(trafficSparkline);
  const theoreticalLifeHr = burnRateGbHr > 0 ? gbTraffic / burnRateGbHr : 0;
  const subscriberCount = sparkData?.currentSubCount || ocsBalances?.totalSubscribers || 0;
  const plmnCount = plmnDist.length;
  const ratingGroupCount = ratesDist.length;
  const topConsumerShare = totalTraffic > 0 && top5[0]?.balance ? (top5[0].balance / totalTraffic) * 100 : 0;
  const plmnCoverage = normalizeRingValue((plmnCount / 8) * 100);
  const exhaustionTone = theoreticalLifeHr > 0 && theoreticalLifeHr < 24 ? "danger" : theoreticalLifeHr > 0 && theoreticalLifeHr < 72 ? "warning" : "normal";
  const activeAlerts = (alertData?.alerts || []).filter((alert) => !alert.is_acknowledged);
  const activeCriticalCount = alertData?.activeCriticalCount || activeAlerts.filter((alert) => alert.level === "CRITICAL").length;
  const activeWarningCount = alertData?.activeWarningCount || activeAlerts.filter((alert) => alert.level === "WARNING").length;

  const brokenInvariants = ocsBalances?.brokenInvariantCount || 0;
  const utilizationRate = ocsBalances?.dataUtilizationRate || 0;

  const operationsScore = normalizeRingValue(
    100 -
    activeCriticalCount * 20 -
    activeWarningCount * 8 -
    (brokenInvariants > 0 ? 15 : 0) -
    (exhaustionTone === "danger" ? 15 : exhaustionTone === "warning" ? 8 : 0)
  );

  const topImsi = top5[0]?.imsi || "--";

  // Health indicator for KPI strip rightmost column
  const healthTone = brokenInvariants > 0 ? "danger" : activeCriticalCount > 0 ? "warning" : "normal";
  const healthValue = brokenInvariants === 0 ? "100%" : `${brokenInvariants}!`;
  const healthDetail = brokenInvariants === 0 ? t("dash_ocs_kpi_invariants_ok") : t("dash_ocs_kpi_invariants_broken", { count: brokenInvariants });
  const healthRingValue = brokenInvariants === 0 ? 100 : Math.max(0, 100 - brokenInvariants * 10);

  // Work Items generation
  const workItems: WorkItem[] = [];
  if (activeCriticalCount > 0) {
    workItems.push({
      id: "critical-alerts",
      tone: "danger",
      priority: "P0",
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
      priority: "P0",
      title: t("dash_work_invariant_title", { count: brokenInvariants }),
      detail: t("dash_work_invariant_detail"),
      href: "/ocs/balances",
      action: t("dash_work_open_ocs"),
    });
  }
  if (exhaustionTone === "danger") {
    workItems.push({
      id: "exhaustion",
      tone: "danger",
      priority: "P0",
      title: t("dash_work_exhaustion_title"),
      detail: theoreticalLifeHr > 0 ? t("dash_work_exhaustion_detail", { hours: theoreticalLifeHr.toFixed(1) }) : t("dash_work_exhaustion_unknown"),
      href: "/subscribers",
      action: t("dash_work_open_subscribers"),
    });
  }
  if (topConsumerShare >= 50 && topImsi !== "--") {
    workItems.push({
      id: "top-consumer-danger",
      tone: "danger",
      priority: "P0",
      title: t("dash_work_top_consumer_title"),
      detail: t("dash_work_top_consumer_detail", { imsi: topImsi, share: topConsumerShare.toFixed(0) }),
      href: "/subscribers",
      action: t("dash_work_open_subscribers"),
    });
  }
  if (activeWarningCount > 0) {
    workItems.push({
      id: "warning-alerts",
      tone: "warning",
      priority: "P1",
      title: t("dash_work_warning_title", { count: activeWarningCount }),
      detail: t("dash_work_warning_detail"),
      href: "/system-health",
      action: t("dash_work_open_health"),
    });
  }
  if (exhaustionTone === "warning") {
    workItems.push({
      id: "exhaustion",
      tone: "warning",
      priority: "P1",
      title: t("dash_work_exhaustion_title"),
      detail: theoreticalLifeHr > 0 ? t("dash_work_exhaustion_detail", { hours: theoreticalLifeHr.toFixed(1) }) : t("dash_work_exhaustion_unknown"),
      href: "/subscribers",
      action: t("dash_work_open_subscribers"),
    });
  }
  if (topConsumerShare >= 35 && topConsumerShare < 50 && topImsi !== "--") {
    workItems.push({
      id: "top-consumer",
      tone: "warning",
      priority: "P1",
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
      priority: "P1",
      title: t("dash_work_rating_title"),
      detail: t("dash_work_rating_detail"),
      href: "/ocs/tariffs",
      action: t("dash_work_open_rating"),
    });
  }
  if (workItems.length === 0) {
    workItems.push({
      id: "healthy",
      tone: "normal",
      title: t("dash_work_healthy_title"),
      detail: t("dash_work_healthy_detail"),
      href: "/system-health",
      action: t("dash_work_open_health"),
    });
  }

  const visibleWorkItems = workItems.slice(0, 4);

  // KPI Strip items
  const kpiItems: MetricStripItem[] = [
    {
      key: "traffic",
      accent: "var(--chart-1)",
      icon: <TrendingUp size={16} />,
      label: t("dash_kpi_total_traffic"),
      value: (
        <>
          <CountUpNumber value={gbTraffic} decimals={2} />
          <span>GB</span>
        </>
      ),
      detail: burnRateGbHr > 0
        ? (theoreticalLifeHr > 0
            ? `${burnRateGbHr.toFixed(2)} GB/hr · ~${theoreticalLifeHr.toFixed(0)}h`
            : `${burnRateGbHr.toFixed(2)} GB/hr`)
        : undefined,
      indicator: trafficSparkline.length > 0 ? <MetricSparkline data={trafficSparkline} color="var(--chart-1)" /> : undefined,
      tone: exhaustionTone === "danger" ? "danger" : exhaustionTone === "warning" ? "warning" : undefined,
    },
    {
      key: "subscribers",
      accent: "var(--status-success)",
      icon: <Activity size={16} />,
      label: t("dash_kpi_active_subs"),
      value: <CountUpNumber value={subscriberCount} />,
      indicator: <MetricRing value={subscriberCount > 0 ? 100 : 0} color="var(--status-success)" />,
    },
    {
      key: "plmn",
      accent: "var(--chart-4)",
      icon: <Globe size={16} />,
      label: t("dash_kpi_plmn_active"),
      value: <CountUpNumber value={plmnCount} />,
      detail: plmnDist.length > 0 ? `${plmnDist[0]?.name || "—"}${plmnDist.length > 1 ? ` +${plmnDist.length - 1}` : ""}` : undefined,
      indicator: <MetricRing value={plmnCoverage} color="var(--chart-4)" />,
    },
    {
      key: "contracts",
      accent: "var(--chart-3)",
      icon: <Users size={16} />,
      label: t("nav_ocs_contracts"),
      value: contractSubscriberCount !== null ? <CountUpNumber value={contractSubscriberCount} /> : "—",
      indicator: <MetricRing value={contractSubscriberCount !== null && contractSubscriberCount > 0 ? 100 : 0} color="var(--chart-3)" />,
    },
    {
      key: "utilization",
      accent: "var(--chart-2)",
      icon: <Database size={16} />,
      label: t("dash_ocs_kpi_utilization"),
      value: (
        <>
          <CountUpNumber value={utilizationRate} decimals={1} />
          <span>%</span>
        </>
      ),
      indicator: <MetricRing value={utilizationRate} color="var(--chart-2)" />,
      tone: utilizationRate >= 85 ? "danger" : utilizationRate >= 65 ? "warning" : undefined,
    },
    {
      key: "invariants",
      accent: brokenInvariants === 0 ? "var(--status-success)" : "var(--status-danger)",
      icon: brokenInvariants === 0 ? <ShieldCheck size={16} /> : <AlertTriangle size={16} />,
      label: t("dash_ocs_kpi_invariants"),
      value: healthValue,
      detail: healthDetail,
      indicator: <MetricRing value={healthRingValue} color={brokenInvariants === 0 ? "var(--status-success)" : "var(--status-danger)"} />,
      tone: healthTone === "danger" ? "danger" : healthTone === "warning" ? "warning" : undefined,
    },
  ];

  return (
    <div className="analytics-root">
      {/* 1. KPI Strip — core metrics at a glance */}
      <MetricStrip variant="cards" columns={6} ariaLabel="Key performance indicators" items={kpiItems} />

      {/* 2. Alerts & Score — only visible when issues exist, otherwise compact */}
      <WorkbenchPanel
        visibleWorkItems={visibleWorkItems}
        operationsScore={operationsScore}
        activeAlertCount={activeAlerts.length}
        t={t}
      />

      {/* 3. OCS Resource Health — compact utilization overview */}
      <OcsResourceStrip ocsBalances={ocsBalances} ocsSessions={ocsSessions} t={t} />

      {/* 4. Charts — distribution and top consumers */}
      <div className="analytics-chart-grid">
        <TopConsumerChart top5={top5} t={t} />
        <TariffPlanDistributionChart tariffPlanDist={tariffPlanDist} t={t} />
      </div>
    </div>
  );
}
