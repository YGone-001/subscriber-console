import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const analyticsCockpitSource = readFileSync(new URL('../src/components/AnalyticsCockpit.tsx', import.meta.url), 'utf8');
const workbenchPanelSource = readFileSync(new URL('../src/components/analytics/WorkbenchPanel.tsx', import.meta.url), 'utf8');
const zhLocale = readFileSync(new URL('../src/lib/locales/zh.ts', import.meta.url), 'utf8');
const enLocale = readFileSync(new URL('../src/lib/locales/en.ts', import.meta.url), 'utf8');

test('Dashboard OCS components exist', () => {
  assert.equal(existsSync(new URL('../src/components/analytics/OcsBalanceCapacityCard.tsx', import.meta.url)), true);
  assert.equal(existsSync(new URL('../src/components/analytics/OcsSessionTelemetryCard.tsx', import.meta.url)), true);
  assert.equal(existsSync(new URL('../src/components/analytics/TariffPlanDistributionChart.tsx', import.meta.url)), true);
  assert.equal(existsSync(new URL('../src/components/analytics/WorkbenchPanel.tsx', import.meta.url)), true);
});

test('AnalyticsCockpit enforces platform overview and does NOT mount runtime telemetry', () => {
  assert.doesNotMatch(analyticsCockpitSource, /OcsSessionTelemetryCard/);
  assert.doesNotMatch(analyticsCockpitSource, /dash_ocs_kpi_active_sessions/);
  assert.match(analyticsCockpitSource, /TariffPlanDistributionChart/);
  assert.match(analyticsCockpitSource, /WorkbenchPanel/);
  assert.match(analyticsCockpitSource, /MetricStrip/);
  assert.match(analyticsCockpitSource, /(?:analytics-ocs-grid|OcsResourceStrip)/);
  assert.match(analyticsCockpitSource, /analytics-chart-grid/);
});

test('WorkbenchPanel renders action items with score summary', () => {
  assert.match(workbenchPanelSource, /dash_workbench_title/);
  assert.match(workbenchPanelSource, /analytics-alerts-items/);
  assert.match(workbenchPanelSource, /analytics-readiness-score/);
  assert.match(workbenchPanelSource, /operationsScore/);
});

test('Dashboard OCS and Workbench i18n keys are fully aligned across zh and en', () => {
  const ocsKeys = [
    'dash_workbench_tab_tasks',
    'dash_workbench_tab_changes',
    'dash_kpi_detail_burn_exhaust',
    'dash_ocs_kpi_active_sessions',
    'dash_ocs_kpi_reservations',
    'dash_ocs_kpi_utilization',
    'dash_ocs_kpi_invariants',
    'dash_ocs_balance_pool_title',
    'dash_ocs_session_telemetry_title',
    'dash_chart_tariff_plan_title',
    'dash_work_invariant_title',
    'dash_work_orphaned_title',
  ];

  for (const key of ocsKeys) {
    assert.match(zhLocale, new RegExp(key), `Missing ${key} in zh.ts`);
    assert.match(enLocale, new RegExp(key), `Missing ${key} in en.ts`);
  }
});

test('Option A: Semantic risk perception enforces P0/P1 priority tones and readiness linkage', () => {
  assert.match(analyticsCockpitSource, /priority:\s*"P0"/);
  assert.match(analyticsCockpitSource, /priority:\s*"P1"/);
  assert.match(analyticsCockpitSource, /exhaustionTone === "danger"/);
  assert.match(workbenchPanelSource, /analytics-semantic-badge badge-danger/);
  assert.match(workbenchPanelSource, /live-pulse-dot/);
  assert.match(workbenchPanelSource, /operationsScore < 70/);
});

test('Option B: Spatial dimensionality reduction integrates PLMN tag and expands Top 5 chart', () => {
  const topConsumerSource = readFileSync(new URL('../src/components/analytics/TopConsumerChart.tsx', import.meta.url), 'utf8');
  const analyticsCssSource = readFileSync(new URL('../src/components/analytics.css', import.meta.url), 'utf8');

  // PLMN detail is shown in MetricStrip rather than a separate heavy chart
  assert.match(analyticsCockpitSource, /plmnDist\.length > 0/);
  // Bottom grid is 2-column asymmetric (Top 5 + Tariff Plan)
  assert.match(analyticsCockpitSource, /<TopConsumerChart/);
  assert.match(analyticsCockpitSource, /<TariffPlanDistributionChart/);
  assert.doesNotMatch(analyticsCockpitSource, /PlmnDistributionChart/);

  // TopConsumerChart width and formatting is expanded for long IMSI strings
  assert.match(topConsumerSource, /width=\{142\}/);
  assert.match(topConsumerSource, /fontFamily:\s*"monospace"/);
  assert.match(analyticsCssSource, /\.analytics-chart-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1\.65fr\)\s*minmax\(0,\s*1fr\)/);
});
