"use client";

import React from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { DatabaseZap, PieChart as PieChartIcon, Server } from "lucide-react";
import { DistributionPoint } from "./types";
import { formatGb } from "./utils";
import EmptyChartState from "./EmptyChartState";

const COLORS = ["var(--chart-1)", "var(--chart-3)", "var(--chart-2)", "var(--chart-4)", "var(--chart-5)", "var(--chart-6)"];

export default function PlmnDistributionChart({
  plmnDist,
  theme,
  t,
}: {
  plmnDist: DistributionPoint[];
  theme: string;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const titleId = React.useId();
  const summaryId = React.useId();
  const tooltipStyle = {
    borderRadius: 8,
    backgroundColor: theme === "dark" ? "#1e293b" : "#fff",
    borderColor: theme === "dark" ? "#334155" : "#e2e8f0",
    color: theme === "dark" ? "#f8fafc" : "#334155",
    boxShadow: "0 14px 30px -18px rgba(15,23,42,0.45)",
  };
  const leadingNetwork = plmnDist.reduce<DistributionPoint | undefined>(
    (largest, item) => (!largest || item.value > largest.value ? item : largest),
    undefined,
  );
  const chartSummary = leadingNetwork
    ? t("dash_chart_plmn_summary", {
        count: plmnDist.length,
        name: leadingNetwork.name,
        value: formatGb(leadingNetwork.value),
      })
    : "";

  return (
    <section className="analytics-panel">
      <div className="analytics-panel-header">
        <div className="analytics-panel-title">
          <Server size={18} color="var(--chart-3)" />
          <h3 id={titleId}>{t("dash_chart_plmn_title")}</h3>
        </div>
        <span className="analytics-panel-badge">{plmnDist.length} {t("dash_unit_plmn")}</span>
      </div>
      <div
        className="analytics-panel-body"
        role={plmnDist.length > 0 ? "img" : undefined}
        aria-labelledby={plmnDist.length > 0 ? titleId : undefined}
        aria-describedby={plmnDist.length > 0 ? summaryId : undefined}
      >
        {plmnDist.length > 0 ? (
          <>
            <p id={summaryId} className="sr-only">{chartSummary}</p>
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
          </>
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
  );
}
