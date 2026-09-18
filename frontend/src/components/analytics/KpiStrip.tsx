"use client";

import React, { useMemo } from "react";
import { Area, AreaChart, ResponsiveContainer } from "recharts";
import { normalizeRingValue } from "./utils";

export interface KpiStripItem {
  color: string;
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  detail?: string;
  sparkline?: number[];
  ringValue?: number;
  tone?: "normal" | "warning" | "danger";
}

function MiniSparkline({ data, color }: { data?: number[]; color: string }) {
  const reactId = React.useId();
  const chartData = useMemo(() => {
    if (!data?.length) return [];
    return data.map((value, index) => ({ index, value }));
  }, [data]);

  const gradientId = `strip-spark-${color.replace("#", "")}-${reactId.replace(/:/g, "")}`;

  if (chartData.length === 0) return null;

  return (
    <div className="kpi-strip-sparkline" aria-hidden="true">
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

function MiniRingInline({ value, color }: { value: number; color: string }) {
  const safeValue = normalizeRingValue(value);
  return (
    <div
      className="kpi-strip-ring"
      style={{
        background: `conic-gradient(${color} ${safeValue * 3.6}deg, var(--surface-border) 0deg)`,
      }}
      aria-hidden="true"
    >
      <div className="kpi-strip-ring-inner">{Math.round(safeValue)}</div>
    </div>
  );
}

export default function KpiStrip({ items }: { items: KpiStripItem[] }) {
  return (
    <div className="kpi-strip" role="list" aria-label="Key performance indicators">
      {items.map((item, i) => (
        <div
          key={i}
          className={`kpi-strip-item kpi-strip-${item.tone || "normal"}`}
          role="listitem"
        >
          <div className="kpi-strip-head">
            <div
              className="kpi-strip-icon"
              style={{
                color: item.color,
                background: `color-mix(in srgb, ${item.color} 9%, transparent)`,
                borderColor: `color-mix(in srgb, ${item.color} 19%, transparent)`,
              }}
            >
              {item.icon}
            </div>
            <span className="kpi-strip-label">{item.label}</span>
          </div>
          <div className="kpi-strip-value">{item.value}</div>
          {item.detail && <div className="kpi-strip-detail">{item.detail}</div>}
          <div className="kpi-strip-indicator">
            {item.ringValue !== undefined ? (
              <MiniRingInline value={item.ringValue} color={item.color} />
            ) : item.sparkline ? (
              <MiniSparkline data={item.sparkline} color={item.color} />
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}
