"use client";

import React, { useMemo } from "react";
import { Area, AreaChart, ResponsiveContainer } from "recharts";
import { KpiCardProps } from "./types";
import { normalizeRingValue } from "./utils";

function TrendSparkline({ data, color, height = 26 }: { data?: number[]; color: string; height?: number }) {
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
    <div className="analytics-sparkline" style={{ height }} aria-hidden="true">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={chartData} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
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
            strokeWidth={1.8}
            fill={`url(#${gradientId})`}
            dot={false}
            isAnimationActive
            animationDuration={600}
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
      <div className="analytics-ring-inner">{Math.round(safeValue)}%</div>
    </div>
  );
}

export default function KpiCard({
  color,
  icon,
  label,
  value,
  detail,
  sparkline,
  ringValue,
  tone = "normal",
  tag,
}: KpiCardProps) {
  return (
    <section className={`analytics-kpi-card analytics-kpi-${tone}`}>
      <div className="analytics-kpi-top">
        <div className="analytics-kpi-meta">
          <div
            className="analytics-kpi-icon"
            style={{ color, background: `${color}16`, borderColor: `${color}30` }}
          >
            {icon}
          </div>
          <span className="analytics-kpi-label" title={label}>
            {label}
          </span>
        </div>
        {ringValue !== undefined ? (
          <MiniRing value={ringValue} color={color} />
        ) : sparkline && sparkline.length > 0 ? (
          <div className="analytics-kpi-mini-sparkline">
            <TrendSparkline data={sparkline} color={color} height={24} />
          </div>
        ) : null}
      </div>

      <div className="analytics-kpi-body">
        <div className="analytics-kpi-value">
          {value}
          {tag && <span className="analytics-kpi-badge-tag">{tag}</span>}
        </div>
        {detail && (
          <div className="analytics-kpi-detail" title={detail}>
            {detail}
          </div>
        )}
      </div>
    </section>
  );
}
