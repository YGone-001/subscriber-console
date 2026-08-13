"use client";

import React from "react";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { BarChart3, DatabaseZap, Signal, Zap } from "lucide-react";
import { TopConsumer } from "./types";
import { BYTES_IN_GB, formatGb } from "./utils";
import EmptyChartState from "./EmptyChartState";
import { formatEvents, formatSeconds } from "@/lib/unitParser";

const COLORS = ["var(--chart-1)", "var(--chart-3)", "var(--chart-2)", "var(--chart-4)", "var(--chart-5)", "var(--chart-6)"];

type TopConsumerTooltipPayload = {
  payload?: TopConsumer;
};

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

export default function TopConsumerChart({
  top5,
  theme,
  t,
}: {
  top5: TopConsumer[];
  theme: string;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const chartStroke = theme === "dark" ? "rgba(255,255,255,0.08)" : "rgba(15,23,42,0.08)";
  const tickColor = theme === "dark" ? "#CBD5E1" : "#475569";
  const tooltipStyle = {
    borderRadius: 8,
    backgroundColor: theme === "dark" ? "#1e293b" : "#fff",
    borderColor: theme === "dark" ? "#334155" : "#e2e8f0",
    color: theme === "dark" ? "#f8fafc" : "#334155",
    boxShadow: "0 14px 30px -18px rgba(15,23,42,0.45)",
  };

  return (
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
            <BarChart data={top5} layout="vertical" margin={{ top: 8, right: 28, left: 8, bottom: 8 }}>
              <CartesianGrid strokeDasharray="4 4" horizontal={false} stroke={chartStroke} />
              <XAxis
                type="number"
                stroke={tickColor}
                tick={{ fill: tickColor, fontSize: 11, fontWeight: 500 }}
                tickFormatter={(value: number) => `${(value / BYTES_IN_GB).toFixed(1)} GB`}
              />
              <YAxis
                type="category"
                dataKey="imsi"
                width={142}
                stroke={tickColor}
                tick={{ fontSize: 11.5, fill: tickColor, fontFamily: "monospace", fontWeight: 600 }}
              />
              <Tooltip
                cursor={{ fill: theme === "dark" ? "rgba(255,255,255,0.05)" : "rgba(15,23,42,0.04)" }}
                content={<TopConsumerTooltip contentStyle={tooltipStyle} t={t} />}
              />
              <Bar dataKey="balance" radius={[0, 6, 6, 0]} barSize={22}>
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
  );
}
