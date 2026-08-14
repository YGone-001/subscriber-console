import type { CSSProperties, ReactNode } from "react";

export const CHART_SERIES_COLORS = [
  "var(--chart-1)",
  "var(--chart-3)",
  "var(--chart-2)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
] as const;

export const PLAN_CHART_COLORS = [
  "var(--chart-2)",
  "var(--chart-1)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--status-info)",
  "var(--status-warning)",
] as const;

export const CHART_GRID_COLOR = "var(--surface-border)";
export const CHART_TICK_COLOR = "var(--text-secondary)";
export const CHART_CURSOR_COLOR = "var(--surface-hover)";

export const CHART_TOOLTIP_STYLE: CSSProperties = {
  borderRadius: 8,
  backgroundColor: "var(--surface)",
  borderColor: "var(--surface-border)",
  color: "var(--text-main)",
  boxShadow: "var(--shadow-popover)",
};

export function ChartSummary({ id, children }: { id: string; children: ReactNode }) {
  return <p id={id} className="sr-only">{children}</p>;
}
