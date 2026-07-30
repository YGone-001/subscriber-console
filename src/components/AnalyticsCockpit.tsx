"use client";
import './analytics.css';

import React, { useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  Clock,
  DatabaseZap,
  ExternalLink,
  GitBranch,
  Globe,
  ListChecks,
  PieChart as PieChartIcon,
  Rocket,
  RotateCcw,
  Server,
  ShieldCheck,
  Signal,
  TrendingUp,
  Users,
  Zap,
} from "lucide-react";
import { useTheme } from "./ThemeProvider";
import { fetcher } from "@/lib/fetcher";
import { formatEvents, formatSeconds } from "@/lib/unitParser";
import { useI18n } from "./I18nProvider";

const COLORS = ["#4e73df", "#1cc88a", "#36b9cc", "#f6c23e", "#e74a3b", "#858796"];
const BYTES_IN_GB = 1024 ** 3;

type DistributionPoint = {
  name: string;
  value: number;
};

type TopConsumer = {
  imsi: string;
  balance: number;
  voiceBalance: number;
  smsBalance: number;
};

type MetricsData = {
  totalTraffic: number;
  plmnDist?: DistributionPoint[];
  ratesDist?: DistributionPoint[];
  top5?: TopConsumer[];
  timestamp?: number;
  error?: string;
};

type SparklineData = {
  subscribers?: number[];
  traffic?: number[];
  currentSubCount?: number;
  currentTraffic?: number;
};

type AlertItem = {
  id: string;
  timestamp: string;
  level: "CRITICAL" | "WARNING" | string;
  imsi?: string;
  reason: string;
  is_acknowledged?: boolean;
};

type AlertResponse = {
  alerts?: AlertItem[];
  activeCriticalCount?: number;
  activeWarningCount?: number;
  activeCount?: number;
};

type KpiCardProps = {
  color: string;
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  detail: string;
  sparkline?: number[];
  ringValue?: number;
  tone?: "normal" | "warning" | "danger";
};

type TopConsumerTooltipPayload = {
  payload?: TopConsumer;
};

type WorkItem = {
  id: string;
  tone: "danger" | "warning" | "normal";
  title: string;
  detail: string;
  href: string;
  action: string;
};

type ChangeTask = {
  id: string;
  tone: "danger" | "warning" | "normal";
  title: string;
  scope: string;
  phase: string;
  canary: number;
  owner: string;
  href: string;
  rollbackHref: string;
};

function CountUpNumber({ value, decimals = 0, suffix = "" }: { value: number; decimals?: number; suffix?: string }) {
  const [displayValue, setDisplayValue] = useState(value);
  const previousValue = useRef(value);

  useEffect(() => {
    const startValue = previousValue.current;
    const delta = value - startValue;
    let frame = 0;
    let raf = 0;
    const totalFrames = 32;

    const tick = () => {
      frame += 1;
      const progress = Math.min(frame / totalFrames, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplayValue(startValue + delta * eased);

      if (progress < 1) {
        raf = requestAnimationFrame(tick);
      } else {
        previousValue.current = value;
      }
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);

  return (
    <>
      {displayValue.toFixed(decimals)}
      {suffix}
    </>
  );
}

function formatGb(bytes: number, decimals = 2) {
  return (bytes / BYTES_IN_GB).toFixed(decimals);
}

function TopConsumerTooltip({
  active,
  payload,
  contentStyle,
  t,
}: {
  active?: boolean;
  payload?: TopConsumerTooltipPayload[];
  contentStyle: React.CSSProperties;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const consumer = payload?.[0]?.payload;
  if (!active || !consumer) return null;

  return (
    <div style={{ ...contentStyle, padding: "0.75rem 0.85rem", minWidth: 210 }}>
      <div style={{ fontFamily: "monospace", fontWeight: 700, marginBottom: "0.55rem" }}>{consumer.imsi}</div>
      <div style={{ display: "grid", gap: "0.35rem", fontSize: "0.82rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem" }}>
          <span>{t("dash_chart_top5_tooltip")}</span>
          <strong>{formatGb(consumer.balance)} GB</strong>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem" }}>
          <span>{t("dash_chart_top5_voice_tooltip")}</span>
          <strong>{formatSeconds(consumer.voiceBalance)}</strong>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem" }}>
          <span>{t("dash_chart_top5_sms_tooltip")}</span>
          <strong>{formatEvents(consumer.smsBalance)} SMS</strong>
        </div>
      </div>
    </div>
  );
}

function computeHourlyBurnGb(points: number[]) {
  if (!Array.isArray(points) || points.length < 2) return 0;

  const positiveDeltas: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const delta = points[i] - points[i - 1];
    if (Number.isFinite(delta) && delta > 0) {
      positiveDeltas.push(delta);
    }
  }

  if (positiveDeltas.length === 0) return 0;
  const averageBytesPerStep = positiveDeltas.reduce((sum, value) => sum + value, 0) / positiveDeltas.length;
  return averageBytesPerStep / BYTES_IN_GB;
}

function createDistributionSparkline(points: DistributionPoint[]) {
  if (!points?.length) return [];
  return points.map((point) => point.value);
}

function normalizeRingValue(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function TrendSparkline({ data, color, height = 42 }: { data?: number[]; color: string; height?: number }) {
  const reactId = React.useId();
  const chartData = useMemo(() => {
    if (!data?.length) return [];
    return data.map((value, index) => ({ index, value }));
  }, [data]);

  const gradientId = `spark-${color.replace("#", "")}-${reactId.replace(/:/g, "")}`;

  if (chartData.length === 0) {
    return <div className="analytics-sparkline-placeholder" style={{ height }} />;
  }

  return (
    <div className="analytics-sparkline" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={chartData} margin={{ top: 3, right: 0, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.34} />
              <stop offset="100%" stopColor={color} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <Area
            type="monotone"
            dataKey="value"
            stroke={color}
            strokeWidth={2}
            fill={`url(#${gradientId})`}
            dot={false}
            isAnimationActive
            animationDuration={700}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function MiniRing({ value, color }: { value: number; color: string }) {
  const safeValue = normalizeRingValue(value);

  return (
    <div
      className="analytics-ring"
      style={{
        background: `conic-gradient(${color} ${safeValue * 3.6}deg, var(--surface-border) 0deg)`,
      }}
      aria-hidden="true"
    >
      <div className="analytics-ring-inner">{Math.round(safeValue)}</div>
    </div>
  );
}

function KpiCard({ color, icon, label, value, detail, sparkline, ringValue, tone = "normal" }: KpiCardProps) {
  return (
    <section className={`analytics-kpi-card analytics-kpi-${tone}`}>
      <div className="analytics-kpi-top">
        <div className="analytics-kpi-icon" style={{ color, background: `${color}18`, borderColor: `${color}33` }}>
          {icon}
        </div>
        {ringValue !== undefined ? <MiniRing value={ringValue} color={color} /> : null}
      </div>
      <div className="analytics-kpi-label">{label}</div>
      <div className="analytics-kpi-value">{value}</div>
      <div className="analytics-kpi-detail">{detail}</div>
      <TrendSparkline data={sparkline} color={color} />
    </section>
  );
}

function SkeletonDashboard() {
  return (
    <div className="analytics-root">
      <div className="analytics-kpi-grid">
        {Array.from({ length: 4 }).map((_, index) => (
          <div className="analytics-kpi-card analytics-skeleton-card" key={index}>
            <div className="skeleton-loader analytics-skeleton-icon" />
            <div className="skeleton-loader analytics-skeleton-label" />
            <div className="skeleton-loader analytics-skeleton-value" />
            <div className="skeleton-loader analytics-skeleton-line" />
            <div className="skeleton-loader analytics-skeleton-chart" />
          </div>
        ))}
      </div>
      <div className="analytics-chart-grid">
        <div className="analytics-panel">
          <div className="skeleton-loader analytics-skeleton-panel-title" />
          <div className="skeleton-loader analytics-skeleton-panel-body" />
        </div>
        <div className="analytics-panel">
          <div className="skeleton-loader analytics-skeleton-panel-title" />
          <div className="skeleton-loader analytics-skeleton-panel-body" />
        </div>
      </div>
    </div>
  );
}

function EmptyChartState({ icon, title, action }: { icon: React.ReactNode; title: string; action?: React.ReactNode }) {
  return (
    <div className="analytics-empty-state">
      <div className="analytics-empty-visual">{icon}</div>
      <div className="analytics-empty-title">{title}</div>
      {action ? <div className="analytics-empty-action">{action}</div> : null}
    </div>
  );
}

export default function AnalyticsCockpit() {
  const { theme } = useTheme();
  const { t } = useI18n();
  const { data, error, isLoading } = useSWR<MetricsData>("/api/analytics/metrics", fetcher, { refreshInterval: 5000 });
  const { data: sparkData } = useSWR<SparklineData>("/api/analytics/sparkline", fetcher, { refreshInterval: 30000 });
  const { data: alertData } = useSWR<AlertResponse>("/api/alerts", fetcher, { refreshInterval: 5000 });

  const chartStroke = theme === "dark" ? "rgba(255,255,255,0.08)" : "rgba(15,23,42,0.08)";
  const tickColor = theme === "dark" ? "#CBD5E1" : "#475569";
  const tooltipStyle = {
    borderRadius: 8,
    backgroundColor: theme === "dark" ? "#1e293b" : "#fff",
    borderColor: theme === "dark" ? "#334155" : "#e2e8f0",
    color: theme === "dark" ? "#f8fafc" : "#334155",
    boxShadow: "0 14px 30px -18px rgba(15,23,42,0.45)",
  };

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
        <section className="analytics-panel">
          <div className="analytics-panel-header">
            <div className="analytics-panel-title">
              <Zap size={18} color="var(--primary)" />
              <h3>{t("dash_chart_top5_title")}</h3>
            </div>
            <span className="analytics-panel-badge">
              <Signal size={13} />
              Live
            </span>
          </div>
          <div className="analytics-panel-body">
            {top5.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={top5} layout="vertical" margin={{ top: 4, right: 18, left: 0, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="4 4" horizontal={false} stroke={chartStroke} />
                  <XAxis
                    type="number"
                    stroke={tickColor}
                    tick={{ fill: tickColor, fontSize: 11 }}
                    tickFormatter={(value: number) => `${(value / BYTES_IN_GB).toFixed(1)}G`}
                  />
                  <YAxis
                    type="category"
                    dataKey="imsi"
                    width={118}
                    stroke={tickColor}
                    tick={{ fontSize: 11, fill: tickColor }}
                  />
                  <Tooltip
                    cursor={{ fill: theme === "dark" ? "rgba(255,255,255,0.04)" : "rgba(15,23,42,0.04)" }}
                    content={<TopConsumerTooltip contentStyle={tooltipStyle} t={t} />}
                  />
                  <Bar dataKey="balance" radius={[0, 6, 6, 0]} barSize={18}>
                    {top5.map((entry, index) => (
                      <Cell key={`${entry.imsi}-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <EmptyChartState
                icon={<BarChart3 size={42} />}
                title={t("dash_chart_top5_empty")}
                action={
                  <button className="btn btn-outline analytics-empty-button" type="button" onClick={() => fetch("/api/analytics/init", { method: "POST" })}>
                    <DatabaseZap size={14} />
                    {t("sync_telemetry")}
                  </button>
                }
              />
            )}
          </div>
        </section>

        <section className="analytics-panel">
          <div className="analytics-panel-header">
            <div className="analytics-panel-title">
              <Server size={18} color="#1cc88a" />
              <h3>{t("dash_chart_plmn_title")}</h3>
            </div>
            <span className="analytics-panel-badge">{plmnCount} PLMN</span>
          </div>
          <div className="analytics-panel-body">
            {plmnDist.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={plmnDist}
                    cx="50%"
                    cy="50%"
                    innerRadius={68}
                    outerRadius={102}
                    paddingAngle={5}
                    dataKey="value"
                    stroke="none"
                    label={({ name, percent }: { name: string; percent: number }) => `${name} ${(percent * 100).toFixed(0)}%`}
                  >
                    {plmnDist.map((entry, index) => (
                      <Cell key={`${entry.name}-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={tooltipStyle} formatter={(value: number) => [`${formatGb(value)} GB`, t("dash_chart_plmn_tooltip")]} />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <EmptyChartState
                icon={<PieChartIcon size={42} />}
                title={t("dash_chart_plmn_empty")}
                action={
                  <button className="btn btn-outline analytics-empty-button" type="button" onClick={() => fetch("/api/analytics/init", { method: "POST" })}>
                    <DatabaseZap size={14} />
                    {t("sync_telemetry")}
                  </button>
                }
              />
            )}
          </div>
        </section>
      </div>

      <section className="analytics-workbench">
        <div className="analytics-workbench-main">
          <div className="analytics-workbench-title">
            <ListChecks size={19} color="var(--primary)" />
            <div>
              <h3>{t("dash_workbench_title")}</h3>
              <p>{t("dash_workbench_subtitle")}</p>
            </div>
          </div>

          <div className="analytics-workqueue">
            {visibleWorkItems.map((item) => (
              <a key={item.id} href={item.href} className={`analytics-workitem analytics-workitem-${item.tone}`}>
                <div className="analytics-workitem-icon">
                  {item.tone === "danger" ? <AlertTriangle size={17} /> : item.tone === "warning" ? <AlertCircle size={17} /> : <CheckCircle2 size={17} />}
                </div>
                <div className="analytics-workitem-copy">
                  <strong>{item.title}</strong>
                  <span>{item.detail}</span>
                </div>
                <div className="analytics-workitem-action">
                  {item.action}
                  <ExternalLink size={13} />
                </div>
              </a>
            ))}
          </div>
        </div>

        <div className="analytics-readiness">
          <div className="analytics-readiness-score">
            <MiniRing value={operationsScore} color={operationsScore < 70 ? "#e74a3b" : operationsScore < 88 ? "#f6c23e" : "#1cc88a"} />
            <div>
              <span>{t("dash_ops_score")}</span>
              <strong>{Math.round(operationsScore)}</strong>
            </div>
          </div>
          <div className="analytics-readiness-list">
            <div><ShieldCheck size={15} /> {t("dash_ops_alerts", { count: activeAlertCount })}</div>
            <div><Users size={15} /> {t("dash_ops_subscribers", { count: subscriberCount })}</div>
            <div><Globe size={15} /> {t("dash_ops_plmn", { count: plmnCount })}</div>
            <div><Zap size={15} /> {t("dash_ops_top_imsi", { imsi: topImsi })}</div>
          </div>
          <div className="analytics-quicklinks">
            <a href="/subscribers">{t("dash_quick_subscribers")}</a>
            <a href="/rating">{t("dash_quick_rating")}</a>
            <a href="/audit-logs">{t("dash_quick_audit")}</a>
          </div>
        </div>
      </section>

      <section className="analytics-change-queue">
        <div className="analytics-change-header">
          <div>
            <h3>
              <GitBranch size={18} />
              {t("dash_change_title")}
            </h3>
            <p>{t("dash_change_subtitle")}</p>
          </div>
          <span>{t("dash_change_count", { count: changeQueue.length })}</span>
        </div>
        <div className="analytics-change-grid">
          {changeQueue.map((task) => (
            <article className={`analytics-change-card analytics-change-${task.tone}`} key={task.id}>
              <div className="analytics-change-top">
                <span className="analytics-change-id">{task.id}</span>
                <span className="analytics-change-phase">{task.phase}</span>
              </div>
              <div className="analytics-change-title">{task.title}</div>
              <div className="analytics-change-scope">{task.scope}</div>
              <div className="analytics-change-meta">
                <span>{task.owner}</span>
                <span>{t("dash_change_canary", { percent: task.canary })}</span>
              </div>
              <div className="analytics-change-progress" aria-hidden="true">
                <span style={{ width: `${task.canary}%` }} />
              </div>
              <div className="analytics-change-actions">
                <a href={task.href}>
                  <Rocket size={13} />
                  {t("dash_change_open")}
                </a>
                <a href={task.rollbackHref}>
                  <RotateCcw size={13} />
                  {t("dash_change_rollback")}
                </a>
              </div>
            </article>
          ))}
        </div>
      </section>

      
    </div>
  );
}

