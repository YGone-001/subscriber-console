import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  canAccessNavigationRoute,
  getBreadcrumbs,
  getNavigationRoute,
  getVisibleNavigation,
  matchesRoute,
  resolveNavigationRoute,
} from '../src/lib/navigation';
import { dictionaries, en, zh } from '../src/lib/locales';
import { normalizeRole } from '../src/lib/permissions';
import { isLocale, isThemePreference, resolveTheme } from '../src/lib/preferences';

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8');

test('uses only canonical roles for navigation presentation', () => {
  assert.equal(normalizeRole('admin'), 'admin');
  assert.equal(normalizeRole('ops_admin'), 'operator');
  assert.equal(normalizeRole('unknown'), null);
  assert.ok(getVisibleNavigation('admin').some((route) => route.targetRoute === '/users'));
  assert.ok(!getVisibleNavigation('operator').some((route) => route.targetRoute === '/users'));
});

test('matches dynamic inventory routes and builds raw-parameter breadcrumbs', () => {
  assert.equal(matchesRoute('/ocs/balances/:imsi', '/ocs/balances/001010123456789'), true);
  assert.equal(getNavigationRoute('/users/alice')?.targetRoute, '/users/:username');
  const breadcrumbs = getBreadcrumbs('/ocs/balances/001010123456789');
  assert.equal(breadcrumbs.at(-1)?.labelKey, '001010123456789');
});

test('keeps theme and language preferences bounded', () => {
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(isThemePreference('night'), false);
  assert.equal(isLocale('zh'), true);
  assert.equal(isLocale('fr'), false);
});

test('resolveNavigationRoute normalises trailing slashes before matching', () => {
  assert.equal(resolveNavigationRoute('/ocs/tariffs/')?.targetRoute, '/ocs/tariffs');
  assert.equal(resolveNavigationRoute('/ocs/tariffs')?.targetRoute, '/ocs/tariffs');
  assert.equal(resolveNavigationRoute('/')?.targetRoute, '/');
  assert.equal(resolveNavigationRoute('/does-not-exist'), undefined);
});

test('canAccessNavigationRoute mirrors the visible-route authority', () => {
  const usersRoute = getNavigationRoute('/users');
  assert.ok(usersRoute);
  assert.equal(canAccessNavigationRoute(usersRoute, 'admin'), true);
  assert.equal(canAccessNavigationRoute(usersRoute, 'operator'), false);
  assert.equal(canAccessNavigationRoute(usersRoute, 'viewer'), false);

  const dashboardRoute = getNavigationRoute('/');
  assert.ok(dashboardRoute);
  assert.equal(canAccessNavigationRoute(dashboardRoute, 'viewer'), true);
});

test('reference dictionary wins on overlap and the legacy fallback survives', () => {
  // Reference wording is authoritative for shared keys.
  assert.equal(en.nav_ocs, 'Charging Management');
  assert.equal(zh.nav_ocs, '计费管理');
  assert.equal(en.nav_ocs_tariffs, 'Tariff Plans');
  assert.equal(zh.nav_ocs_contracts, '签约用户');

  // Legacy-only keys the earlier shell introduced must not be lost.
  assert.equal(typeof en.nav_inventory, 'string');
  assert.equal(typeof en.sidebar_filter_ph, 'string');
  assert.equal(typeof en.breadcrumbs_home, 'string');

  // The merge must not be able to resolve a key to undefined.
  for (const key of ['nav_dashboard', 'nav_ocs', 'nav_system_health', 'refresh']) {
    assert.equal(typeof dictionaries.en[key], 'string', `en.${key}`);
    assert.equal(typeof dictionaries.zh[key], 'string', `zh.${key}`);
  }
});

test('the shell surface exposes the reference route label keys', () => {
  const navigation = read('../src/lib/navigation.ts');
  for (const key of ['nav_subscriber', 'nav_ocs_tariffs', 'nav_ocs_contracts', 'nav_ocs_balances', 'nav_system_users', 'nav_system_health']) {
    assert.ok(navigation.includes(`'${key}'`), `navigation authority must use ${key}`);
  }
  assert.ok(!navigation.includes("labelKey: 'nav_tariffs'"), 'legacy nav_tariffs label must be gone');
  assert.ok(!navigation.includes("labelKey: 'nav_health'"), 'legacy nav_health label must be gone');
});

test('the tab bar implements the visited-tab model, not a static route strip', () => {
  const tabBar = read('../src/app/components/NavigationTabBar.tsx');
  // Persistence + identity
  assert.ok(tabBar.includes('XCLOUD_OPEN_TABS'));
  // Close / pin / overflow / scroll affordances
  for (const className of ['nav-tab-close', 'nav-tab-pin-icon', 'nav-tab-dropdown', 'nav-tab-scroll-btn', 'nav-tab-actions-wrap', 'nav-tab-menu-btn']) {
    assert.ok(tabBar.includes(className), `tab bar must render ${className}`);
  }
  // The tab set is derived from visited routes, never enumerated from the route table.
  assert.ok(!/getVisibleNavigation\([^)]*\)\.map/.test(tabBar), 'tab bar must not render every visible route as a tab');
});

test('the breadcrumb bar exposes the reference tool cluster', () => {
  const breadcrumbs = read('../src/app/components/NavigationBreadcrumbs.tsx');
  assert.ok(breadcrumbs.includes('nav-breadcrumbs-right'));
  assert.ok(breadcrumbs.includes('XCLOUD_RECENT_PAGES'));
  for (const className of ['nav-crumb-tool-btn', 'nav-recent-dropdown', 'nav-recent-item', 'nav-recent-clear']) {
    assert.ok(breadcrumbs.includes(className), `breadcrumb bar must render ${className}`);
  }
  // Refresh must revalidate client data rather than call a server-render refresh.
  assert.ok(breadcrumbs.includes('useSWRConfig'));
});

test('the i18n provider follows the browser language instead of a hard-coded locale', () => {
  const provider = read('../src/providers/I18nProvider.tsx');
  assert.ok(provider.includes('navigator'));
  assert.ok(/startsWith\('zh'\)/.test(provider));
  assert.ok(provider.includes('formatDateTime'));
  assert.ok(provider.includes('formatRelativeTime'));
});
