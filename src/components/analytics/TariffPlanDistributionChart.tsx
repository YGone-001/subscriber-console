"use client";

import React from "react";
import Link from "next/link";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { Layers, ArrowUpRight, Tag } from "lucide-react";
import { TariffPlanDistItem } from "./types";
import EmptyChartState from "./EmptyChartState";
import { ChartDataTable } from "@/components/ui/ChartDataTable";
import { CHART_TOOLTIP_STYLE, ChartSummary, PLAN_CHART_COLORS } from "@/components/ui/chartPrimitives";

interface TariffPlanDistributionChartProps {
  tariffPlanDist?: TariffPlanDistItem[];
  t: (key: string, params?: Record<string, string | number>) => string;
}

export default function TariffPlanDistributionChart({
  tariffPlanDist = [],
  t,
}: TariffPlanDistributionChartProps) {
  const titleId = React.useId();
  const summaryId = React.useId();
  const chartData = tariffPlanDist.map((p) => ({
    name: p.name || p.planId,
    value: p.subscriberCount,
    planId: p.planId,
    percentage: p.percentage,
    status: p.status,
  }));

  const hasData = chartData.some((d) => d.value > 0);
  const totalSubscribers = chartData.reduce((sum, item) => sum + item.value, 0);
  const largestPlan = chartData.reduce<(typeof chartData)[number] | undefined>(
    (largest, item) => (!largest || item.value > largest.value ? item : largest),
    undefined,
  );
  const chartSummary = largestPlan
    ? t("dash_chart_tariff_plan_summary", {
        count: chartData.length,
        subscribers: totalSubscribers,
        name: largestPlan.name,
        percentage: largestPlan.percentage,
      })
    : "";

  return (
    <section className="analytics-panel">
      <div className="analytics-panel-header">
        <div className="analytics-panel-title">
          <Layers size={18} color="var(--status-info)" />
          <h3 id={titleId}>{t("dash_chart_tariff_plan_title")}</h3>
        </div>
        <div className="analytics-ocs-header-actions">
          <span className="analytics-panel-badge">{tariffPlanDist.length} {t("dash_unit_plans")}</span>
          <Link href="/rating" className="analytics-ocs-link-btn">
            <span>{t("dash_ocs_view_plans")}</span>
            <ArrowUpRight size={14} />
          </Link>
        </div>
      </div>

      <div className="analytics-panel-body analytics-plan-body">
        {hasData ? (
          <div className="analytics-plan-grid">
            <div className="analytics-plan-chart-container" role="img" aria-labelledby={titleId} aria-describedby={summaryId}>
              <ChartSummary id={summaryId}>{chartSummary}</ChartSummary>
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie
                    data={chartData}
                    cx="50%"
                    cy="50%"
                    innerRadius={55}
                    outerRadius={85}
                    paddingAngle={4}
                    dataKey="value"
                    stroke="none"
                  >
                    {chartData.map((entry, index) => (
                      <Cell key={`${entry.planId}-${index}`} fill={PLAN_CHART_COLORS[index % PLAN_CHART_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={CHART_TOOLTIP_STYLE}
                    formatter={(value: number, name: string) => [
                      `${value} ${t("dash_ops_subscribers", { count: "" }).trim()}`,
                      name,
                    ]}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>

            <div className="analytics-plan-legend-list">
              {tariffPlanDist.map((plan, index) => {
                const color = PLAN_CHART_COLORS[index % PLAN_CHART_COLORS.length];
                return (
                  <div key={`${plan.planId}-${index}`} className="analytics-plan-legend-row">
                    <div className="legend-row-left">
                      <span className="plan-color-dot" style={{ backgroundColor: color }} />
                      <div className="plan-info">
                        <span className="plan-name">{plan.name}</span>
                        <code className="plan-id-code">{plan.planId}</code>
                      </div>
                    </div>
                    <div className="legend-row-right">
                      <strong className="plan-sub-count">{plan.subscriberCount}</strong>
                      <span className="plan-pct-badge">{plan.percentage}%</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <EmptyChartState
            icon={<Tag size={42} />}
            title={t("dash_chart_tariff_plan_empty")}
            action={
              <Link href="/rating" className="btn btn-outline analytics-empty-button">
                {t("dash_ocs_create_plan_hint")}
              </Link>
            }
          />
        )}
      </div>
      {hasData ? (
        <ChartDataTable
          label={t("chart_data_table")}
          caption={t("dash_chart_tariff_plan_title")}
          columns={[
            { key: "plan", label: t("chart_col_plan") },
            { key: "subscribers", label: t("chart_col_subscribers"), numeric: true },
            { key: "share", label: t("chart_col_share"), numeric: true },
          ]}
          rows={chartData.map((plan) => ({
            key: plan.planId,
            cells: [plan.name, plan.value, `${plan.percentage}%`],
          }))}
        />
      ) : null}
    </section>
  );
}
