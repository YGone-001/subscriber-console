"use client";

import React from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { DatabaseZap, PieChart as PieChartIcon, Server } from "lucide-react";
import { DistributionPoint } from "./types";
import { formatGb } from "./utils";
import EmptyChartState from "./EmptyChartState";

const COLORS = ["#4e73df", "#1cc88a", "#36b9cc", "#f6c23e", "#e74a3b", "#858796"];

export default function PlmnDistributionChart({
  plmnDist,
  theme,
  t,
}: {
  plmnDist: DistributionPoint[];
  theme: string;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
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
          <Server size={18} color="#1cc88a" />
          <h3>{t("dash_chart_plmn_title")}</h3>
        </div>
        <span className="analytics-panel-badge">{plmnDist.length} PLMN</span>
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
  );
}
