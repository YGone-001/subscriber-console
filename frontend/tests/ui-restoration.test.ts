import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  APP_ROUTES,
  filterNavigation,
  getBreadcrumbs,
  getSidebarGroups,
  getVisibleNavigation,
  SHELL_GEOMETRY,
} from '../src/lib/navigation';
import { buildDashboardModel, formatBytes, toChartPoints } from '../src/features/read/dashboard-model';

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8');
const identity = (key: string) => key;

test('shell geometry matches the restored xCloud reference', () => {
  assert.equal(SHELL_GEOMETRY.expandedWidth, 264);
  assert.equal(SHELL_GEOMETRY.collapsedWidth, 72);
  assert.equal(SHELL_GEOMETRY.breakpoint, 981);
});

test('sidebar groups expose the restored navigation hierarchy for an administrator', () => {
  const groups = getSidebarGroups('admin');
  const keys = groups.map((group) => group.key);
  assert.ok(keys.includes('nav_dashboard'));
  assert.ok(keys.includes('nav_subscriber'));
  assert.ok(keys.includes('nav_ocs'));
  assert.ok(keys.includes('nav_profile'));
  assert.ok(keys.includes('nav_system_settings'));
  assert.ok(keys.includes('nav_system_health'));
  assert.ok(keys.includes('nav_inventory'));
  // The reference sidebar renders no Rating entry: the rating routes redirect to
  // the tariff surface, so exposing them would be a dead link.
  assert.ok(!keys.includes('nav_rating'), 'sidebar must not expose a Rating entry');

  const ocs = groups.find((group) => group.key === 'nav_ocs');
  assert.ok(ocs);
  // Canonical reference order, not alphabetical.
  assert.deepEqual(
    ocs.children.map((child) => child.targetRoute),
    ['/ocs/tariffs', '/ocs/contracts', '/ocs/balances'],
  );

  const system = groups.find((group) => group.key === 'nav_system_settings');
  assert.ok(system);
  assert.deepEqual(system.children.map((child) => child.targetRoute), ['/users']);
});

test('sidebar grouping is role-aware and never exposes an unauthorised group', () => {
  const operator = getSidebarGroups('operator').map((group) => group.key);
  assert.ok(!operator.includes('nav_system_settings'), 'operator must not see the administration group');
  assert.ok(operator.includes('nav_inventory'));

  const viewer = getSidebarGroups('viewer').map((group) => group.key);
  assert.ok(!viewer.includes('nav_system_settings'), 'viewer must not see the administration group');
  assert.ok(viewer.includes('nav_ocs'), 'viewer retains read-only OCS navigation');
  assert.ok(viewer.includes('nav_inventory'));
});

test('role-filtered navigation hides administration routes from non-admins', () => {
  assert.ok(getVisibleNavigation('admin').some((route) => route.targetRoute === '/users'));
  assert.ok(!getVisibleNavigation('operator').some((route) => route.targetRoute === '/users'));
  assert.ok(!getVisibleNavigation('viewer').some((route) => route.targetRoute === '/users'));
});

test('command palette route search filters by label and by path without inventing routes', () => {
  const routes = getVisibleNavigation('admin');
  assert.equal(filterNavigation(routes, '', identity).length, routes.length);
  const byPath = filterNavigation(routes, '/inventory', identity);
  assert.ok(byPath.length >= 1);
  assert.ok(byPath.every((route) => route.targetRoute.includes('/inventory')));
  assert.deepEqual(filterNavigation(routes, 'zzz-not-a-route', identity), []);
});

test('breadcrumbs resolve dynamic inventory segments from the current route authority', () => {
  const crumbs = getBreadcrumbs('/inventory/router-01');
  assert.equal(crumbs[0].labelKey, 'breadcrumbs_home');
  assert.equal(crumbs.at(-1)?.labelKey, 'router-01');
  assert.equal(crumbs.at(-1)?.current, true);
});

test('dashboard model reports an explicit unavailable state when the contract returns nothing', () => {
  const model = buildDashboardModel({ metrics: undefined, sparkline: undefined, alerts: undefined, contracts: undefined });
  assert.equal(model.available, false);
  assert.equal(model.trafficSeries.length, 0);
  assert.equal(model.plmnPoints.length, 0);
  assert.equal(model.workbench.length, 0);
  assert.equal(model.balances, null);
});

test('dashboard model derives KPIs and chart series from contract data only', () => {
  const model = buildDashboardModel({
    metrics: {
      totalTraffic: 1024,
      timestamp: 1700000000000,
      plmnDist: [{ name: 'MCC-MNC', value: 12 }],
      tariffPlanDist: [{ planId: 'plan_a', name: 'plan_a', subscriberCount: 3 }],
      top5: [{ imsi: '001010000000001', balance: 9 }],
      ocsBalances: { totalSubscribers: 42, dataUtilizationRate: 12.5, allInvariantsOk: true, brokenInvariantCount: 0 },
      ocsSessions: { totalSessions: 5, activeSessions: 2, interfaceGyCount: 1, interfaceRoCount: 4 },
      ocsReservations: { totalReservations: 3 },
      ocsUsage: { totalRecords: 7 },
    },
    sparkline: { traffic: [1, 2, 3], subscribers: [4, 5] },
    alerts: { activeCount: 2, activeCriticalCount: 1, alerts: [{ id: 'a1', level: 'critical', reason: 'r', imsi: '001', is_acknowledged: false }] },
    contracts: { total: 11 },
  });

  assert.equal(model.available, true);
  assert.equal(model.trafficSeries.length, 3);
  assert.equal(model.subscriberSeries.length, 2);
  assert.equal(model.plmnPoints[0].value, 12);
  assert.equal(model.tariffPoints[0].value, 3);
  assert.equal(model.topConsumers[0].name, '001010000000001');

  const byId = new Map(model.kpis.map((kpi) => [kpi.id, kpi]));
  assert.equal(byId.get('subscribers')?.value, '42');
  assert.equal(byId.get('contracts')?.value, '11');
  assert.equal(byId.get('active-sessions')?.value, '2');
  assert.equal(byId.get('utilization')?.value, '12.5');
  assert.equal(byId.get('invariants')?.tone, 'success');
  assert.equal(byId.get('alerts')?.tone, 'danger');
  assert.equal(byId.get('traffic')?.value, '1.0');
  assert.equal(byId.get('traffic')?.unit, 'KiB');
});

test('dashboard workbench only lists alerts that the alert authority reports as unacknowledged', () => {
  const model = buildDashboardModel({
    metrics: { totalTraffic: 1 },
    sparkline: {},
    alerts: {
      activeCount: 2,
      alerts: [
        { id: 'a1', level: 'critical', reason: 'open', imsi: '001', is_acknowledged: false },
        { id: 'a2', level: 'warning', reason: 'closed', imsi: '002', is_acknowledged: true },
      ],
    },
    contracts: {},
  });
  assert.equal(model.workbench.length, 1);
  assert.equal(model.workbench[0].id, 'a1');
});

test('byte and chart formatting never fabricates values', () => {
  assert.deepEqual(formatBytes(0), { value: '0', unit: 'B' });
  assert.deepEqual(formatBytes(Number.NaN), { value: '0', unit: 'B' });
  assert.deepEqual(toChartPoints(undefined), []);
  assert.deepEqual(toChartPoints([{ name: '' }]), []);
});

test('dashboard renders the forward-ported analytics cockpit', () => {
  const page = read('../src/features/read/ReadPages.tsx');
  assert.match(page, /AnalyticsCockpit/);

  // The cockpit owns the reference composition: KPI strip, workbench, OCS strip,
  // top-consumer chart and tariff-plan distribution.
  const cockpit = read('../src/components/AnalyticsCockpit.tsx');
  for (const part of ['MetricStrip', 'WorkbenchPanel', 'OcsResourceStrip', 'TopConsumerChart', 'TariffPlanDistributionChart']) {
    assert.match(cockpit, new RegExp(part), `cockpit must render ${part}`);
  }

  // It must read the accepted read contracts rather than aggregate on its own.
  for (const endpoint of ['/api/analytics/metrics', '/api/analytics/sparkline', '/api/alerts', '/api/ocs/subscribers']) {
    assert.ok(cockpit.includes(endpoint), `cockpit must read ${endpoint}`);
  }

  // Loading / offline / empty states are explicit, never fabricated.
  assert.match(cockpit, /SkeletonDashboard/);
  assert.match(cockpit, /analytics-offline/);
  assert.match(read('../src/components/analytics/EmptyChartState.tsx'), /EmptyChartState/);
});

test('shell composition is implemented as dedicated restored components', () => {
  const header = read('../src/app/components/AppHeader.tsx');
  assert.match(header, /xCloud_picture\.png/);
  assert.match(header, /brand-lockup/);
  assert.match(header, /header-divider/);
  assert.match(header, /command-button/);
  assert.match(header, /NocSentinel/);
  assert.match(header, /NotificationCenter/);
  assert.match(header, /LanguageSwitcher/);
  assert.match(header, /ThemeSwitcher/);
  assert.match(header, /UserMenu/);

  const sidebar = read('../src/app/components/AppSidebar.tsx');
  assert.match(sidebar, /sidebar-filter-wrap/);
  assert.match(sidebar, /sidebar-active-bar/);
  assert.match(sidebar, /sidebar-tooltip/);
  assert.match(sidebar, /sidebar-subnav/);

  const shell = read('../src/app/AppShell.tsx');
  assert.match(shell, /NavigationTabBar/);
  assert.match(shell, /NavigationBreadcrumbs/);
  assert.match(shell, /CommandPalette|AppHeader/);
  assert.match(shell, /sidebar-mobile-backdrop/);
});

test('shell shortcut and responsive contracts are present in the orchestrator', () => {
  const shell = read('../src/app/AppShell.tsx');
  assert.match(shell, /'b'/, 'Ctrl+B sidebar toggle must be wired');
  assert.match(shell, /'k'/, 'Ctrl+K command palette must be wired');
  assert.match(shell, /Escape/, 'Escape handling must be wired');
  assert.match(shell, /981/, 'the restored shell breakpoint must be preserved');
  assert.match(shell, /document\.body\.style\.overflow/, 'mobile body scroll locking must be preserved');
});

test('navigation authority stays the single source of truth for shell presentation', () => {
  const sources = [
    read('../src/app/components/AppSidebar.tsx'),
    read('../src/app/components/NavigationTabBar.tsx'),
    read('../src/app/components/CommandPalette.tsx'),
    read('../src/app/components/NavigationBreadcrumbs.tsx'),
  ].join('\n');
  assert.match(sources, /from '\.\.\/\.\.\/lib\/navigation'/);
  for (const forbidden of ['oldNavigationRoutes', 'legacyRoutes', 'historicalRoutes']) {
    assert.ok(!sources.includes(forbidden), `shell must not introduce ${forbidden}`);
  }
  assert.ok(APP_ROUTES.some((route) => route.targetRoute === '/inventory'));
});
