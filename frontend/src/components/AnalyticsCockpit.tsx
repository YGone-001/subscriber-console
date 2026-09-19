"use client";
import './analytics.css';
import './analytics/KpiStrip.css';

import React from "react";
import Link from "next/link";
import useSWR from "swr";
import {
  Activity,
  AlertCircle,
  Globe,
  TrendingUp,
  Database,
  ShieldCheck,
  AlertTriangle,
  Users,
  ArrowUpRight,
} from "lucide-react";
import { fetcher } from "@/lib/fetcher";
import { useI18n } from "./I18nProvider";

import { MetricsData, SparklineData, AlertResponse, WorkItem } from "./analytics/types";
import { BYTES_IN_GB, computeHourlyBurnGb, createDistributionSparkline, normalizeRingValue } from "./analytics/utils";
import CountUpNumber from "./analytics/CountUpNumber";
import KpiStrip from "./analytics/KpiStrip";
import type { KpiStripItem } from "./analytics/KpiStrip";
import SkeletonDashboard from "./analytics/SkeletonDashboard";
import TopConsumerChart from "./analytics/TopConsumerChart";
import WorkbenchPanel from "./analytics/WorkbenchPanel";
import TariffPlanDistributionChart from "./analytics/TariffPlanDistributionChart";

export default function AnalyticsCockpit() {
  const { t } = useI18n();

  const { data, error, isLoading } = useSWR<MetricsData>("/api/analytics/metrics", fetcher, { refreshInterval: 5000 });
  const { data: sparkData } = useSWR<SparklineData>("/api/analytics/sparkline", fetcher, { refreshInterval: 30000 });
  const { data: alertData } = useSWR<AlertResponse>("/api/alerts", fetcher, { refreshInterval: 5000 });
  const { data: ocsSubData } = useSWR<{ total: number }>("/api/ocs/subscribers?limit=1", fetcher, { refreshInterval: 10000 });
  const { data: approvalData } = useSWR<{ total: number }>("/api/approvals?status=PENDING&limit=1", fetcher, { refreshInterval: 10000 });
  const { data: auditFailureData } = useSWR<{ total: number }>("/api/audit-logs?result=FAILURE&limit=1", fetcher, { refreshInterval: 10000 });
  const { data: tariffPlansData } = useSWR<any>("/api/tariff-plans", fetcher, { refreshInterval: 10000 });

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
  const tariffPlanDist = data?.tariffPlanDist || [];

  const tariffPlanCount = Array.isArray(tariffPlansData) ? tariffPlansData.length : (tariffPlansData?.records?.length ?? tariffPlanDist.length);
  const contractSubscriberCount = ocsSubData?.total ?? 0;
  const balanceAccountCount = ocsBalances?.totalSubscribers ?? 0;
  const pendingApprovalsCount = approvalData?.total ?? 0;
  const failedAuditCount = auditFailureData?.total ?? 0;

  const trafficSparkline = sparkData?.traffic || [];
  const subscriberSparkline = sparkData?.subscribers || [];
  const plmnSparkline = createDistributionSparkline(plmnDist);

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
      href: "/audit-logs",
      action: t("dash_work_open_audit"),
    });
  }

  const visibleWorkItems = workItems.slice(0, 4);

  // KPI Strip items
  const kpiItems: KpiStripItem[] = [
    {
      color: "var(--chart-1)",
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
      sparkline: trafficSparkline,
      tone: exhaustionTone,
    },
    {
      color: "var(--status-success)",
      icon: <Activity size={16} />,
      label: t("dash_kpi_active_subs"),
      value: <CountUpNumber value={subscriberCount} />,
      sparkline: subscriberSparkline,
      ringValue: subscriberCount > 0 ? 100 : 0,
      tone: "normal" as const,
    },
    {
      color: "var(--chart-4)",
      icon: <Globe size={16} />,
      label: t("dash_kpi_plmn_active"),
      value: <CountUpNumber value={plmnCount} />,
      detail: plmnDist.length > 0 ? `${plmnDist[0]?.name || "—"}${plmnDist.length > 1 ? ` +${plmnDist.length - 1}` : ""}` : undefined,
      sparkline: plmnSparkline,
      ringValue: plmnCoverage,
      tone: "normal" as const,
    },
    {
      color: "var(--chart-3)",
      icon: <Users size={16} />,
      label: t("nav_ocs_contracts"),
      value: <CountUpNumber value={contractSubscriberCount} />,
      ringValue: contractSubscriberCount > 0 ? 100 : 0,
      tone: "normal" as const,
    },
    {
      color: "var(--chart-2)",
      icon: <Database size={16} />,
      label: t("dash_ocs_kpi_utilization"),
      value: (
        <>
          <CountUpNumber value={utilizationRate} decimals={1} />
          <span>%</span>
        </>
      ),
      ringValue: utilizationRate,
      tone: (utilizationRate >= 85 ? "danger" : utilizationRate >= 65 ? "warning" : "normal") as "normal" | "warning" | "danger",
    },
    {
      color: brokenInvariants === 0 ? "var(--status-success)" : "var(--status-danger)",
      icon: brokenInvariants === 0 ? <ShieldCheck size={16} /> : <AlertTriangle size={16} />,
      label: t("dash_ocs_kpi_invariants"),
      value: healthValue,
      detail: healthDetail,
      ringValue: healthRingValue,
      tone: healthTone,
    },
  ];

  return (
    <div className="analytics-root">
      {/* 1. KPI Strip — core metrics at a glance */}
      <KpiStrip items={kpiItems} />

      {/* 2. Alerts & Score — only visible when issues exist, otherwise compact */}
      <WorkbenchPanel
        visibleWorkItems={visibleWorkItems}
        operationsScore={operationsScore}
        activeAlertCount={activeAlerts.length}
        t={t}
      />

      {/* 3. Management Overview — Charging Management & Platform Governance */}
      <div className="analytics-ocs-grid">
        <div className="analytics-ocs-card analytics-panel">
          <div className="analytics-panel-header">
            <div className="analytics-panel-title">
              <div className="analytics-ocs-icon" style={{ color: "var(--chart-1)", background: "var(--selection-soft)" }}>
                <Database size={20} />
              </div>
              <div>
                <h3>{t("nav_ocs")}</h3>
                <p className="analytics-ocs-subtitle">{t("ocs_contracts_desc")}</p>
              </div>
            </div>
            <div className="analytics-ocs-header-actions">
              <Link href="/ocs/tariffs" className="analytics-ocs-link-btn">
                <span>{t("nav_ocs_tariffs")}</span>
                <ArrowUpRight size={14} />
              </Link>
            </div>
          </div>
          <div className="analytics-ocs-body">
            <div className="analytics-ocs-capacity-summary">
              <Link href="/ocs/tariffs" className="analytics-ocs-metric-item">
                <span className="analytics-ocs-metric-label">{t("nav_ocs_tariffs")}</span>
                <span className="analytics-ocs-metric-val"><CountUpNumber value={tariffPlanCount} /></span>
                <span className="analytics-ocs-subtext">ocs_tariff_plans</span>
              </Link>
              <Link href="/ocs/contracts" className="analytics-ocs-metric-item">
                <span className="analytics-ocs-metric-label">{t("nav_ocs_contracts")}</span>
                <span className="analytics-ocs-metric-val"><CountUpNumber value={contractSubscriberCount} /></span>
                <span className="analytics-ocs-subtext">ocs_subscribers</span>
              </Link>
              <Link href="/ocs/balances" className="analytics-ocs-metric-item">
                <span className="analytics-ocs-metric-label">{t("nav_ocs_balances")}</span>
                <span className="analytics-ocs-metric-val"><CountUpNumber value={balanceAccountCount} /></span>
                <span className="analytics-ocs-subtext">ocs_balances</span>
              </Link>
            </div>
          </div>
        </div>

        <div className="analytics-ocs-card analytics-panel">
          <div className="analytics-panel-header">
            <div className="analytics-panel-title">
              <div className="analytics-ocs-icon" style={{ color: "var(--status-success)", background: "var(--status-success-soft)" }}>
                <ShieldCheck size={20} />
              </div>
              <div>
                <h3>{t("nav_operations_governance")}</h3>
                <p className="analytics-ocs-subtitle">{t("dash_work_healthy_detail")}</p>
              </div>
            </div>
            <div className="analytics-ocs-header-actions">
              <Link href="/approvals" className="analytics-ocs-link-btn">
                <span>{t("nav_approvals")}</span>
                <ArrowUpRight size={14} />
              </Link>
            </div>
          </div>
          <div className="analytics-ocs-body">
            <div className="analytics-ocs-capacity-summary">
              <Link href="/approvals" className="analytics-ocs-metric-item">
                <span className="analytics-ocs-metric-label">{t("nav_approvals")}</span>
                <span className="analytics-ocs-metric-val" style={{ color: pendingApprovalsCount > 0 ? "var(--status-warning)" : "inherit" }}>
                  <CountUpNumber value={pendingApprovalsCount} />
                </span>
                <span className="analytics-ocs-subtext">{pendingApprovalsCount > 0 ? t("ocs_dashboard_pending_governance_detail") : "—"}</span>
              </Link>
              <Link href="/audit-logs" className="analytics-ocs-metric-item">
                <span className="analytics-ocs-metric-label">{t("nav_audit_logs")}</span>
                <span className="analytics-ocs-metric-val" style={{ color: failedAuditCount > 0 ? "var(--status-danger)" : "inherit" }}>
                  <CountUpNumber value={failedAuditCount} />
                </span>
                <span className="analytics-ocs-subtext">{failedAuditCount > 0 ? t("dash_work_critical_detail") : "—"}</span>
              </Link>
              <Link href="/system-health" className="analytics-ocs-metric-item">
                <span className="analytics-ocs-metric-label">{t("nav_system_health")}</span>
                <span className="analytics-ocs-metric-val" style={{ color: activeCriticalCount > 0 ? "var(--status-danger)" : activeWarningCount > 0 ? "var(--status-warning)" : "var(--status-success)" }}>
                  {activeCriticalCount > 0 ? `${activeCriticalCount}!` : activeWarningCount > 0 ? `${activeWarningCount}▲` : "100%"}
                </span>
                <span className="analytics-ocs-subtext">{activeCriticalCount === 0 && activeWarningCount === 0 ? t("noc_status_online") : `${activeAlerts.length} issues`}</span>
              </Link>
            </div>
          </div>
        </div>
      </div>

      {/* 4. Charts — distribution and top consumers */}
      <div className="analytics-chart-grid">
        <TopConsumerChart top5={top5} t={t} />
        <TariffPlanDistributionChart tariffPlanDist={tariffPlanDist} t={t} />
      </div>
    </div>
  );
}
