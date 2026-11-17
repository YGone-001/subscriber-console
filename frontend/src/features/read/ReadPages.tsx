/*
 * Read/dashboard entry module.
 *
 * The default landing page is now the operations overview
 * (`features/operations/OperationsOverviewPage`). It owns the operations posture,
 * the unified network-status panel and the secondary business analytics view.
 *
 * This module is a route entry point only. It must not import another page:
 * every business page is loaded by its own `route.lazy` boundary, and a static
 * re-export here would drag that page back into the dashboard chunk (the route
 * table imports each page module directly).
 *
 * `ReadBarChart` and `text` stay available to existing callers.
 */
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { OperationsOverviewPage } from '../operations/OperationsOverviewPage';
import { text, toChartPoints, type UnknownRecord } from './dashboard-model';

/**
 * Dashboard (overview) page — the default landing page after sign-in.
 *
 * The page previously stacked the analytics cockpit, the operational overview
 * and the local runtime panel as three independent sections. The consolidated
 * surface keeps those authorities but presents operations first and mounts the
 * business cockpit only when its view is selected.
 */
export function DashboardPage() {
  return <OperationsOverviewPage />;
}

export function ReadBarChart({ rows }: { rows: UnknownRecord[] }) {
  const chartRows = toChartPoints(rows);
  return (
    <ResponsiveContainer width="100%" height={180}>
      <BarChart data={chartRows}>
        <XAxis dataKey="name" />
        <YAxis />
        <Tooltip />
        <Bar dataKey="value" fill="var(--primary)" />
      </BarChart>
    </ResponsiveContainer>
  );
}

export { text };
