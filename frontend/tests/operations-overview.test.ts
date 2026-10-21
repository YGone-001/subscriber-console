/*
 * Operations overview projections.
 *
 * The overview KPIs must come from the platform-wide summary (full collection)
 * and the local runtime snapshot. An unavailable section is null, never zero.
 * The two status distributions stay on their own authority and never mix.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  buildOperationsPosture,
  healthStatusDistribution,
  runtimeAttentionItems,
  runtimeStatusDistribution,
} from '../src/features/operations/operations-overview-model';
import type { OperationsSummaryResponse } from '../src/features/operations/operations-summary';
import type { RuntimeComponent, RuntimeCounts } from '../src/features/runtime/runtime-types';
import { LOCALES } from '../src/lib/locales';

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8');

const counts = (overrides: Partial<RuntimeCounts> = {}): RuntimeCounts => ({
  total: 26,
  running: 21,
  stopped: 3,
  unverified: 1,
  permissionDenied: 0,
  unknown: 0,
  stale: 0,
  notDetected: 1,
  expected: 24,
  ...overrides,
});

const summary = (overrides: Partial<OperationsSummaryResponse> = {}): OperationsSummaryResponse => ({
  generatedAt: '2026-10-20T08:00:00Z',
  sections: ['inventory', 'health', 'alerts'],
  inventory: {
    completeness: 'complete',
    scope: 'full_collection',
    counts: { total: 40, byKind: {}, byLifecycleState: {}, byDomain: {} },
  },
  health: {
    completeness: 'complete',
    scope: 'full_collection',
    targets: {
      configured: 12,
      enabled: 10,
      failed: 1,
      freshnessByState: { fresh: 8, stale: 1, unknown: 1 },
      overallByState: { healthy: 8, degraded: 1, unhealthy: 1, unknown: 0 },
      layersByState: {},
    },
  },
  alerts: {
    completeness: 'complete',
    scope: 'full_collection',
    alerts: {
      totalRules: 4,
      enabledRules: 3,
      alertsByState: { active: 3, acknowledged: 1, resolved: 5 },
      openBySeverity: { critical: 1, warning: 2, info: 1 },
    },
  },
  ...overrides,
});

test('posture projects platform-wide health and alert counts', () => {
  const posture = buildOperationsPosture(summary(), counts());
  assert.equal(posture.runtime.running, 21);
  assert.equal(posture.runtime.total, 26);
  assert.equal(posture.runtime.attention, 1);
  assert.equal(posture.runtime.notDetected, 1);
  assert.equal(posture.monitored.enabled, 10);
  assert.equal(posture.monitored.configured, 12);
  assert.equal(posture.monitored.healthy, 8);
  assert.equal(posture.monitored.degraded, 1);
  assert.equal(posture.monitored.unhealthy, 1);
  assert.equal(posture.monitored.stale, 0);
  assert.equal(posture.fresh.fresh, 8);
  assert.equal(posture.fresh.staleUnknown, 1);
  assert.equal(posture.alerts.active, 3);
  assert.equal(posture.alerts.acknowledged, 1);
  assert.equal(posture.alerts.open, 4, 'open alerts are active + acknowledged, matching the severity queue');
  assert.equal(posture.alerts.critical, 1);
});

test('an unavailable section projects null instead of zero', () => {
  const posture = buildOperationsPosture(
    summary({
      health: { completeness: 'unavailable', scope: 'full_collection', error: 'SECTION_UNAVAILABLE' },
      alerts: { completeness: 'unavailable', scope: 'full_collection', error: 'SECTION_UNAVAILABLE' },
    }),
    undefined,
  );
  assert.equal(posture.runtime.running, null);
  assert.equal(posture.monitored.enabled, null);
  assert.equal(posture.monitored.configured, null);
  assert.equal(posture.monitored.healthy, null);
  assert.equal(posture.monitored.stale, null);
  assert.equal(posture.fresh.fresh, null);
  assert.equal(posture.alerts.active, null);
  assert.equal(posture.alerts.open, null);
  assert.equal(posture.alerts.critical, null);
});

test('partial health data is treated as unavailable', () => {
  const posture = buildOperationsPosture(
    summary({ health: { completeness: 'unavailable', scope: 'full_collection' } }),
    counts(),
  );
  assert.equal(posture.monitored.enabled, null);
  assert.equal(posture.fresh.fresh, null);
});

test('runtime distribution excludes the registry expectation and keeps exclusive buckets', () => {
  const distribution = runtimeStatusDistribution(counts());
  assert.ok(distribution);
  assert.deepEqual(distribution.map((item) => item.key), ['running', 'stopped', 'attention', 'not_detected']);
  assert.deepEqual(distribution.map((item) => item.value), [21, 3, 1, 1]);
  assert.equal(distribution.reduce((total, item) => total + item.value, 0), 26);
  assert.equal(runtimeStatusDistribution(undefined), null);
});

test('health distribution preserves canonical order and unknown states', () => {
  const distribution = healthStatusDistribution(summary({
    health: {
      completeness: 'complete',
      scope: 'full_collection',
      targets: {
        configured: 5,
        enabled: 5,
        failed: 0,
        freshnessByState: {},
        overallByState: { healthy: 2, degraded: 1, unhealthy: 1, maintenance: 1 },
        layersByState: {},
      },
    },
  }));
  assert.ok(distribution);
  assert.deepEqual(distribution.map((item) => item.key), ['healthy', 'degraded', 'unhealthy', 'maintenance']);
  assert.deepEqual(distribution.map((item) => item.value), [2, 1, 1, 1]);
  assert.equal(healthStatusDistribution(undefined), null);
});

test('the overview composes KPI, runtime attention and two authority summaries', () => {
  const source = read('../src/features/operations/OperationsOverview.tsx');
  assert.match(source, /sections=\$\{SUMMARY_SECTIONS\}/);
  assert.match(source, /const SUMMARY_SECTIONS = 'health,alerts'/);
  assert.match(source, /RuntimeSummaryPanel/);
  assert.match(source, /ManagedNfSummaryPanel/);
  assert.match(source, /runtimeAttentionItems/);
  assert.match(source, /ops_kpi_managed/);
  assert.doesNotMatch(source, /RuntimeDiscoveryEmbedded/);
  assert.doesNotMatch(source, /OperationalOverview variant="embedded"/);
  assert.doesNotMatch(source, /AnalyticsCockpit/);
});

test('the business cockpit is a sibling lazy view with a stable page title', () => {
  const page = read('../src/features/operations/OperationsOverviewPage.tsx');
  assert.match(page, /AnalyticsCockpit/);
  assert.match(page, /OperationsOverview/);
  assert.match(page, /t\('dashboard_title'\)/);
  assert.match(page, /ops_view_business/);
  assert.match(page, /searchParams\.get\('view'\) === 'business'/);
});

test('the overview reads the UE summary for the online-user KPI', () => {
  const source = read('../src/features/operations/OperationsOverview.tsx');
  assert.match(source, /UE_SUMMARY_PATH = '\/api\/ue-info\?summary=1'/);
  assert.match(source, /ops_kpi_epc_online/);
  assert.match(source, /ops_kpi_managed/);
  assert.doesNotMatch(source, /ops_kpi_ims_online/);
  assert.doesNotMatch(source, /ops_posture_monitored/);
});

const runtimeComponent = (overrides: Partial<RuntimeComponent>): RuntimeComponent => ({
  componentId: 'amf',
  displayName: 'AMF',
  processName: 'amfd',
  category: '5gc',
  runtimeStatus: 'running',
  statusReason: 'verified_process_running',
  ...overrides,
} as RuntimeComponent);

test('runtime attention excludes not-detected components and ranks stopped first', () => {
  const projection = runtimeAttentionItems([
    runtimeComponent({ componentId: 'stale', displayName: 'Stale', runtimeStatus: 'stale' }),
    runtimeComponent({ componentId: 'stopped', displayName: 'Stopped', runtimeStatus: 'stopped' }),
    runtimeComponent({ componentId: 'stopped-2', displayName: 'Stopped 2', runtimeStatus: 'stopped' }),
    runtimeComponent({ componentId: 'not-detected', displayName: 'Never seen', runtimeStatus: 'not_detected' }),
    runtimeComponent({ componentId: 'unverified', displayName: 'Unverified', runtimeStatus: 'unverified' }),
    runtimeComponent({ componentId: 'denied', displayName: 'Denied', runtimeStatus: 'permission_denied' }),
    runtimeComponent({ componentId: 'unknown', displayName: 'Unknown', runtimeStatus: 'unknown' }),
    runtimeComponent({ componentId: 'running', displayName: 'Running', runtimeStatus: 'running' }),
  ]);

  assert.equal(projection.total, 6);
  assert.deepEqual(
    projection.items.map((item) => item.componentId),
    ['stopped', 'stopped-2', 'unverified', 'denied', 'unknown'],
  );
  assert.deepEqual(runtimeAttentionItems(undefined), { items: [], total: 0 });
  assert.deepEqual(runtimeAttentionItems([], 2), { items: [], total: 0 });
});

test('runtime tables expose responsive column priorities and labels', () => {
  const source = read('../src/features/runtime/RuntimeDiscovery.tsx');
  assert.match(source, /data-column-priority="essential"/);
  assert.match(source, /data-column-priority="important"/);
  assert.match(source, /data-column-priority="supplementary"/);
  assert.match(source, /data-label=\{t\('runtime_col_status'\)\}/);
});

test('the default dashboard is named operations overview in both locales', () => {
  assert.equal(LOCALES.en.nav_dashboard, 'Operations Overview');
  assert.equal(LOCALES.zh.nav_dashboard, '运维总览');
  assert.equal(LOCALES.en.dashboard_title, 'Operations Overview');
  assert.equal(LOCALES.zh.dashboard_title, '运维总览');
});
