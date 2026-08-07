import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const analyticsCockpitSource = readFileSync(new URL('../src/components/AnalyticsCockpit.tsx', import.meta.url), 'utf8');
const workbenchPanelSource = readFileSync(new URL('../src/components/analytics/WorkbenchPanel.tsx', import.meta.url), 'utf8');
const analyticsRepoSource = readFileSync(new URL('../src/server/repositories/analyticsRepository.ts', import.meta.url), 'utf8');
const zhLocale = readFileSync(new URL('../src/lib/locales/zh.ts', import.meta.url), 'utf8');
const enLocale = readFileSync(new URL('../src/lib/locales/en.ts', import.meta.url), 'utf8');

test('Dashboard OCS components exist', () => {
  assert.equal(existsSync(new URL('../src/components/analytics/OcsBalanceCapacityCard.tsx', import.meta.url)), true);
  assert.equal(existsSync(new URL('../src/components/analytics/OcsSessionTelemetryCard.tsx', import.meta.url)), true);
  assert.equal(existsSync(new URL('../src/components/analytics/TariffPlanDistributionChart.tsx', import.meta.url)), true);
  assert.equal(existsSync(new URL('../src/components/analytics/WorkbenchPanel.tsx', import.meta.url)), true);
});

test('AnalyticsCockpit integrates OCS telemetry and elevated workbench layout', () => {
  assert.match(analyticsCockpitSource, /OcsBalanceCapacityCard/);
  assert.match(analyticsCockpitSource, /OcsSessionTelemetryCard/);
  assert.match(analyticsCockpitSource, /TariffPlanDistributionChart/);
  assert.match(analyticsCockpitSource, /WorkbenchPanel/);
  assert.match(analyticsCockpitSource, /analytics-kpi-grid/);
  assert.match(analyticsCockpitSource, /analytics-ocs-grid/);
  assert.match(analyticsCockpitSource, /analytics-chart-grid/);
});

test('WorkbenchPanel incorporates both Action Items and Change Queue subtabs', () => {
  assert.match(workbenchPanelSource, /dash_workbench_tab_tasks/);
  assert.match(workbenchPanelSource, /dash_workbench_tab_changes/);
  assert.match(workbenchPanelSource, /analytics-workqueue/);
  assert.match(workbenchPanelSource, /analytics-change-grid/);
});

test('Analytics repository performs robust concurrent OCS aggregations', () => {
  assert.match(analyticsRepoSource, /mongoCollections\.ocsBalances/);
  assert.match(analyticsRepoSource, /mongoCollections\.ocsSessions/);
  assert.match(analyticsRepoSource, /mongoCollections\.ocsReservations/);
  assert.match(analyticsRepoSource, /mongoCollections\.ocsUsageRecords/);
  assert.match(analyticsRepoSource, /mongoCollections\.ocsTariffPlans/);
  assert.match(analyticsRepoSource, /dataUtilizationRate/);
  assert.match(analyticsRepoSource, /brokenInvariantCount/);
  assert.match(analyticsRepoSource, /activeSessions/);
  assert.match(analyticsRepoSource, /orphanedReservations/);
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

  // PLMN is reduced to a Tag in KpiCard rather than a separate heavy chart in the main grid
  assert.match(analyticsCockpitSource, /tag=\{plmnDist\.length > 0/);
  // Bottom grid is 2-column asymmetric (Top 5 + Tariff Plan)
  assert.match(analyticsCockpitSource, /<TopConsumerChart/);
  assert.match(analyticsCockpitSource, /<TariffPlanDistributionChart/);
  assert.doesNotMatch(analyticsCockpitSource, /PlmnDistributionChart/);

  // TopConsumerChart width and formatting is expanded for long IMSI strings
  assert.match(topConsumerSource, /width=\{142\}/);
  assert.match(topConsumerSource, /fontFamily:\s*"monospace"/);
  assert.match(analyticsCssSource, /\.analytics-chart-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1\.65fr\)\s*minmax\(0,\s*1fr\)/);
});
