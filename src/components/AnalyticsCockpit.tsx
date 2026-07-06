"use client";

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
  BarChart3,
  Clock,
  DatabaseZap,
  Globe,
  PieChart as PieChartIcon,
  Server,
  Signal,
  TrendingUp,
  Zap,
} from "lucide-react";
import { useTheme } from "./ThemeProvider";
import { fetcher } from "@/lib/fetcher";
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
                    contentStyle={tooltipStyle}
                    formatter={(value: number) => [`${formatGb(value)} GB`, t("dash_chart_top5_tooltip")]}
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

      <style dangerouslySetInnerHTML={{ __html: analyticsStyles }} />
    </div>
  );
}

const analyticsStyles = `
  .analytics-root {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    margin-bottom: 2.5rem;
  }

  .analytics-kpi-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 1rem;
  }

  .analytics-kpi-card,
  .analytics-panel {
    background: var(--surface);
    border: 1px solid var(--surface-border);
    border-radius: 8px;
    box-shadow: 0 14px 32px -24px rgba(15, 23, 42, 0.55);
  }

  .analytics-kpi-card {
    min-height: 190px;
    padding: 1rem;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    transition: transform 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
  }

  .analytics-kpi-card:hover {
    transform: translateY(-2px);
    border-color: color-mix(in srgb, var(--primary) 34%, var(--surface-border));
    box-shadow: 0 18px 36px -26px rgba(15, 23, 42, 0.72);
  }

  .analytics-kpi-warning {
    border-color: color-mix(in srgb, #f6c23e 28%, var(--surface-border));
  }

  .analytics-kpi-danger {
    border-color: color-mix(in srgb, #e74a3b 30%, var(--surface-border));
  }

  .analytics-kpi-top,
  .analytics-panel-header,
  .analytics-panel-title,
  .analytics-panel-badge {
    display: flex;
    align-items: center;
  }

  .analytics-kpi-top {
    justify-content: space-between;
    margin-bottom: 0.85rem;
  }

  .analytics-kpi-icon {
    width: 38px;
    height: 38px;
    border: 1px solid;
    border-radius: 8px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .analytics-ring {
    width: 42px;
    height: 42px;
    border-radius: 50%;
    padding: 4px;
    flex-shrink: 0;
  }

  .analytics-ring-inner {
    width: 100%;
    height: 100%;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--surface);
    color: var(--text-secondary);
    font-size: 0.68rem;
    font-weight: 700;
  }

  .analytics-kpi-label {
    color: var(--text-muted);
    font-size: 0.75rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0;
    line-height: 1.3;
    min-height: 1.1rem;
  }

  .analytics-kpi-value {
    display: flex;
    align-items: baseline;
    gap: 0.35rem;
    min-height: 2.6rem;
    margin-top: 0.15rem;
    color: var(--text-main);
    font-size: 1.9rem;
    font-weight: 800;
    line-height: 1.15;
  }

  .analytics-kpi-value span {
    color: var(--text-muted);
    font-size: 0.9rem;
    font-weight: 700;
  }

  .analytics-kpi-detail {
    min-height: 1.2rem;
    margin-top: 0.2rem;
    color: var(--text-secondary);
    font-size: 0.78rem;
    font-weight: 600;
    line-height: 1.35;
  }

  .analytics-sparkline,
  .analytics-sparkline-placeholder {
    width: 100%;
    margin-top: auto;
  }

  .analytics-sparkline-placeholder {
    border-radius: 6px;
    background: linear-gradient(90deg, transparent, var(--surface-hover), transparent);
    opacity: 0.65;
  }

  .analytics-chart-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 1rem;
  }

  .analytics-panel {
    min-height: 370px;
    overflow: hidden;
  }

  .analytics-panel-header {
    justify-content: space-between;
    gap: 1rem;
    min-height: 62px;
    padding: 1rem 1.25rem;
    border-bottom: 1px solid var(--surface-border);
    background: var(--header-bg);
  }

  .analytics-panel-title {
    gap: 0.65rem;
    min-width: 0;
  }

  .analytics-panel-title h3 {
    margin: 0;
    color: var(--text-main);
    font-size: 1rem;
    font-weight: 700;
    line-height: 1.25;
  }

  .analytics-panel-badge {
    gap: 0.35rem;
    min-height: 28px;
    padding: 0.35rem 0.55rem;
    border: 1px solid var(--surface-border);
    border-radius: 999px;
    color: var(--text-secondary);
    font-size: 0.75rem;
    font-weight: 700;
    white-space: nowrap;
  }

  .analytics-panel-body {
    height: 308px;
    padding: 1rem 1.1rem 1.25rem;
  }

  .analytics-empty-state,
  .analytics-offline {
    min-height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.85rem;
    text-align: center;
    color: var(--text-muted);
  }

  .analytics-empty-visual {
    width: 76px;
    height: 76px;
    border: 1px solid var(--surface-border);
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--primary);
    background: var(--header-bg);
  }

  .analytics-empty-title {
    max-width: 260px;
    color: var(--text-secondary);
    font-size: 0.9rem;
    font-weight: 700;
    line-height: 1.4;
  }

  .analytics-empty-button {
    min-height: 34px;
    padding: 0.45rem 0.7rem;
    border-radius: 6px;
    font-size: 0.78rem;
  }

  .analytics-offline {
    min-height: 280px;
    border: 1px dashed color-mix(in srgb, var(--danger) 34%, var(--surface-border));
    border-radius: 8px;
    background: color-mix(in srgb, var(--danger) 7%, transparent);
    color: var(--danger);
    font-weight: 700;
  }

  .analytics-skeleton-card {
    gap: 0.75rem;
  }

  .analytics-skeleton-icon {
    width: 38px;
    height: 38px;
    border-radius: 8px;
  }

  .analytics-skeleton-label {
    width: 62%;
    height: 13px;
  }

  .analytics-skeleton-value {
    width: 45%;
    height: 36px;
  }

  .analytics-skeleton-line {
    width: 70%;
    height: 12px;
  }

  .analytics-skeleton-chart {
    width: 100%;
    height: 42px;
    margin-top: auto;
  }

  .analytics-panel-body .recharts-wrapper {
    outline: none;
  }

  .analytics-skeleton-panel-title {
    width: 180px;
    height: 18px;
    border-radius: 6px;
    margin: 1.2rem;
  }

  .analytics-skeleton-panel-body {
    height: 285px;
    margin: 0 1.2rem 1.2rem;
    border-radius: 8px;
  }

  @media (max-width: 1280px) {
    .analytics-kpi-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  @media (max-width: 980px) {
    .analytics-chart-grid {
      grid-template-columns: 1fr;
    }
  }

  @media (max-width: 640px) {
    .analytics-kpi-grid {
      grid-template-columns: 1fr;
    }

    .analytics-panel-header {
      align-items: flex-start;
      flex-direction: column;
    }

    .analytics-panel-body {
      height: 280px;
      padding: 0.85rem;
    }
  }
`;
