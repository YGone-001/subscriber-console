"use client";

import React from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { DatabaseZap, PieChart as PieChartIcon, Server } from "lucide-react";
import { DistributionPoint } from "./types";
import { formatGb } from "./utils";
import EmptyChartState from "./EmptyChartState";
import { ChartDataTable } from "@/components/ui/ChartDataTable";
import { CHART_SERIES_COLORS, CHART_TOOLTIP_STYLE, ChartSummary } from "@/components/ui/chartPrimitives";

export default function PlmnDistributionChart({
  plmnDist,
  t,
}: {
  plmnDist: DistributionPoint[];
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const titleId = React.useId();
  const summaryId = React.useId();
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
            <ChartSummary id={summaryId}>{chartSummary}</ChartSummary>
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
                  <Cell key={`${entry.name}-${index}`} fill={CHART_SERIES_COLORS[index % CHART_SERIES_COLORS.length]} />
                ))}
              </Pie>
              <Tooltip contentStyle={CHART_TOOLTIP_STYLE} formatter={(value: number) => [`${formatGb(value)} GB`, t("dash_chart_plmn_tooltip")]} />
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
      {plmnDist.length > 0 ? (
        <ChartDataTable
          label={t("chart_data_table")}
          caption={t("dash_chart_plmn_title")}
          columns={[
            { key: "network", label: t("chart_col_network") },
            { key: "traffic", label: t("chart_col_traffic"), numeric: true },
          ]}
          rows={plmnDist.map((network) => ({
            key: network.name,
            cells: [network.name, `${formatGb(network.value)} GB`],
          }))}
        />
      ) : null}
    </section>
  );
}
