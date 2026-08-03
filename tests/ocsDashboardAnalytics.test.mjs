import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const analyticsCockpitSource = readFileSync(new URL('../src/components/AnalyticsCockpit.tsx', import.meta.url), 'utf8');
const analyticsRepoSource = readFileSync(new URL('../src/server/repositories/analyticsRepository.ts', import.meta.url), 'utf8');
const zhLocale = readFileSync(new URL('../src/lib/locales/zh.ts', import.meta.url), 'utf8');
const enLocale = readFileSync(new URL('../src/lib/locales/en.ts', import.meta.url), 'utf8');

test('Dashboard OCS components exist', () => {
  assert.equal(existsSync(new URL('../src/components/analytics/OcsBalanceCapacityCard.tsx', import.meta.url)), true);
  assert.equal(existsSync(new URL('../src/components/analytics/OcsSessionTelemetryCard.tsx', import.meta.url)), true);
  assert.equal(existsSync(new URL('../src/components/analytics/TariffPlanDistributionChart.tsx', import.meta.url)), true);
});

test('AnalyticsCockpit integrates OCS telemetry and view switchers', () => {
  assert.match(analyticsCockpitSource, /OcsBalanceCapacityCard/);
  assert.match(analyticsCockpitSource, /OcsSessionTelemetryCard/);
  assert.match(analyticsCockpitSource, /TariffPlanDistributionChart/);
  assert.match(analyticsCockpitSource, /dash_view_all/);
  assert.match(analyticsCockpitSource, /dash_view_ocs/);
  assert.match(analyticsCockpitSource, /dash_view_network/);
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

test('Dashboard OCS i18n keys are fully aligned across zh and en', () => {
  const ocsKeys = [
    'dash_view_all',
    'dash_view_ocs',
    'dash_view_network',
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
