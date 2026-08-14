"use client";

import React from "react";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { BarChart3, DatabaseZap, Signal, Zap } from "lucide-react";
import { TopConsumer } from "./types";
import { BYTES_IN_GB, formatGb } from "./utils";
import EmptyChartState from "./EmptyChartState";
import { formatEvents, formatSeconds } from "@/lib/unitParser";
import {
  CHART_CURSOR_COLOR,
  CHART_GRID_COLOR,
  CHART_SERIES_COLORS,
  CHART_TICK_COLOR,
  CHART_TOOLTIP_STYLE,
  ChartSummary,
} from "@/components/ui/chartPrimitives";

type TopConsumerTooltipPayload = {
  payload?: TopConsumer;
};

function TopConsumerTooltip({
  active,
  payload,
  t,
}: {
  active?: boolean;
  payload?: TopConsumerTooltipPayload[];
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const consumer = payload?.[0]?.payload;
  if (!active || !consumer) return null;

  return (
    <div style={{ ...CHART_TOOLTIP_STYLE, padding: "0.75rem 0.85rem", minWidth: 210 }}>
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
  t,
}: {
  top5: TopConsumer[];
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const titleId = React.useId();
  const summaryId = React.useId();
  const leadingConsumer = top5[0];
  const chartSummary = leadingConsumer
    ? t("dash_chart_top5_summary", {
        count: top5.length,
        imsi: leadingConsumer.imsi,
        value: formatGb(leadingConsumer.balance),
      })
    : "";

  return (
    <section className="analytics-panel">
      <div className="analytics-panel-header">
        <div className="analytics-panel-title">
          <Zap size={18} color="var(--primary)" />
          <h3 id={titleId}>{t("dash_chart_top5_title")}</h3>
        </div>
        <span className="analytics-panel-badge">
          <Signal size={13} />
          Live
        </span>
      </div>
      <div
        className="analytics-panel-body"
        role={top5.length > 0 ? "img" : undefined}
        aria-labelledby={top5.length > 0 ? titleId : undefined}
        aria-describedby={top5.length > 0 ? summaryId : undefined}
      >
        {top5.length > 0 ? (
          <>
            <ChartSummary id={summaryId}>{chartSummary}</ChartSummary>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={top5} layout="vertical" margin={{ top: 8, right: 28, left: 8, bottom: 8 }}>
              <CartesianGrid strokeDasharray="4 4" horizontal={false} stroke={CHART_GRID_COLOR} />
              <XAxis
                type="number"
                stroke={CHART_TICK_COLOR}
                tick={{ fill: CHART_TICK_COLOR, fontSize: 11, fontWeight: 500 }}
                tickFormatter={(value: number) => `${(value / BYTES_IN_GB).toFixed(1)} GB`}
              />
              <YAxis
                type="category"
                dataKey="imsi"
                width={142}
                stroke={CHART_TICK_COLOR}
                tick={{ fontSize: 11.5, fill: CHART_TICK_COLOR, fontFamily: "monospace", fontWeight: 600 }}
              />
              <Tooltip
                cursor={{ fill: CHART_CURSOR_COLOR }}
                content={<TopConsumerTooltip t={t} />}
              />
              <Bar dataKey="balance" radius={[0, 6, 6, 0]} barSize={22}>
                {top5.map((entry, index) => (
                  <Cell key={`${entry.imsi}-${index}`} fill={CHART_SERIES_COLORS[index % CHART_SERIES_COLORS.length]} />
                ))}
              </Bar>
              </BarChart>
            </ResponsiveContainer>
          </>
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
