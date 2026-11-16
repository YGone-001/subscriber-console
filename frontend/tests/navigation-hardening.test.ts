import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  canAccessDestinationRoute,
  canAccessNavigationRoute,
  getBreadcrumbs,
  getNavigationRoute,
  isNavigableDestination,
  normalizePathname,
} from '../src/lib/navigation';
import { getStoredTabsSnapshot, getTabsStorageKey } from '../src/app/components/NavigationTabBar';
import { getRecentPagesStorageKey, getStoredRecentSnapshot } from '../src/app/components/NavigationBreadcrumbs';

const frontendRoot = resolve(import.meta.dirname, '..');
const readSource = (relPath: string) => readFileSync(resolve(frontendRoot, relPath), 'utf8');

test('normalizes pathname by trimming and collapsing multiple slashes', () => {
  assert.equal(normalizePathname('/subscribers//460020000000400/'), '/subscribers/460020000000400');
  assert.equal(normalizePathname('///'), '/');
  assert.equal(normalizePathname(''), '/');
  assert.equal(normalizePathname('   /users/alice   '), '/users/alice');
});

test('validates the eight required regression paths for navigability and role boundaries', () => {
  // 1. /subscribers/460020000000400 -> true for admin, operator, viewer
  assert.equal(isNavigableDestination('/subscribers/460020000000400', 'admin'), true);
  assert.equal(isNavigableDestination('/subscribers/460020000000400', 'operator'), true);
  assert.equal(isNavigableDestination('/subscribers/460020000000400', 'viewer'), true);

  // 2. /ocs/balances/460020000000400 -> true for all roles
  assert.equal(isNavigableDestination('/ocs/balances/460020000000400', 'admin'), true);
  assert.equal(isNavigableDestination('/ocs/balances/460020000000400', 'operator'), true);
  assert.equal(isNavigableDestination('/ocs/balances/460020000000400', 'viewer'), true);

  // 3. /inventory/00000000-0000-4000-8000-000000000001 -> true for all roles
  assert.equal(isNavigableDestination('/inventory/00000000-0000-4000-8000-000000000001', 'admin'), true);
  assert.equal(isNavigableDestination('/inventory/00000000-0000-4000-8000-000000000001', 'operator'), true);
  assert.equal(isNavigableDestination('/inventory/00000000-0000-4000-8000-000000000001', 'viewer'), true);

  // 4. /users/alice -> true for admin, FALSE for operator and viewer (RBAC boundary)
  assert.equal(isNavigableDestination('/users/alice', 'admin'), true);
  assert.equal(isNavigableDestination('/users/alice', 'operator'), false);
  assert.equal(isNavigableDestination('/users/alice', 'viewer'), false);

  // 5. /knowledge/example-entry -> true for all roles
  assert.equal(isNavigableDestination('/knowledge/example-entry', 'admin'), true);
  assert.equal(isNavigableDestination('/knowledge/example-entry', 'operator'), true);
  assert.equal(isNavigableDestination('/knowledge/example-entry', 'viewer'), true);

  // 6. /knowledge/new -> true for all roles
  assert.equal(isNavigableDestination('/knowledge/new', 'admin'), true);
  assert.equal(isNavigableDestination('/knowledge/new', 'operator'), true);
  assert.equal(isNavigableDestination('/knowledge/new', 'viewer'), true);

  // 7. /subscribers/new -> true for all roles
  assert.equal(isNavigableDestination('/subscribers/new', 'admin'), true);
  assert.equal(isNavigableDestination('/subscribers/new', 'operator'), true);
  assert.equal(isNavigableDestination('/subscribers/new', 'viewer'), true);

  // 8. /does-not-exist -> false for all roles
  assert.equal(isNavigableDestination('/does-not-exist', 'admin'), false);
  assert.equal(isNavigableDestination('/does-not-exist', 'operator'), false);
  assert.equal(isNavigableDestination('/does-not-exist', 'viewer'), false);
});

test('strictly rejects uninstantiated route templates and parameter placeholders', () => {
  const templates = [
    '/subscribers/:imsi',
    '/inventory/:resourceId',
    '/topology/:resourceId',
    '/ocs/balances/:imsi',
    '/ocs/contracts/:imsi',
    '/ocs/tariffs/:planId',
    '/profile/:name',
    '/users/:username',
    '/agents/:agentId',
    '/discovery/sources/:sourceId',
    '/nf-health/:targetId',
    '/knowledge/:entryId',
    '/knowledge/:entryId/edit',
    '/investigations/:investigationId',
    '/config-snapshots/:sourceId',
  ];

  for (const tpl of templates) {
    assert.equal(isNavigableDestination(tpl, 'admin'), false, `template ${tpl} must not be a navigable destination`);
    assert.equal(isNavigableDestination(tpl, 'operator'), false, `template ${tpl} must not be a navigable destination`);
  }
});

test('strictly rejects compatibility redirect aliases as direct history destinations', () => {
  const redirectSources = ['/ocs', '/ocs/dashboard', '/ocs/sessions', '/ocs/usage', '/ocs/subscribers', '/rating', '/rating/plans', '/rating/rules', '/roles'];
  for (const redirectPath of redirectSources) {
    assert.equal(isNavigableDestination(redirectPath, 'admin'), false, `redirect alias ${redirectPath} must not be recorded as a direct destination`);
  }
});

test('separates sidebar navigation visibility from destination navigability without weakening authorization', () => {
  const subscriberDetailRoute = getNavigationRoute('/subscribers/:imsi');
  assert.ok(subscriberDetailRoute, 'route definition for /subscribers/:imsi must exist');

  // Sidebar visibility contract: detail route does not have visible: true, so canAccessNavigationRoute returns false
  assert.equal(Boolean(subscriberDetailRoute?.visible), false);
  assert.equal(canAccessNavigationRoute(subscriberDetailRoute!, 'admin'), false);
  assert.equal(canAccessNavigationRoute(subscriberDetailRoute!, 'operator'), false);

  // Destination navigability contract: canAccessDestinationRoute returns true for detail route
  assert.equal(canAccessDestinationRoute(subscriberDetailRoute!, 'admin'), true);
  assert.equal(canAccessDestinationRoute(subscriberDetailRoute!, 'operator'), true);
  assert.equal(canAccessDestinationRoute(subscriberDetailRoute!, 'viewer'), true);

  // For /users/:username, destination navigability requires users.read permission
  const userDetailRoute = getNavigationRoute('/users/:username');
  assert.ok(userDetailRoute, 'route definition for /users/:username must exist');
  assert.equal(canAccessDestinationRoute(userDetailRoute!, 'admin'), true);
  assert.equal(canAccessDestinationRoute(userDetailRoute!, 'operator'), false);
  assert.equal(canAccessDestinationRoute(userDetailRoute!, 'viewer'), false);
});

test('scopes navigation history keys to authenticated username to prevent cross-user leakage', () => {
  assert.equal(getTabsStorageKey('alice'), 'XCLOUD_OPEN_TABS:alice');
  assert.equal(getTabsStorageKey('bob'), 'XCLOUD_OPEN_TABS:bob');
  assert.equal(getTabsStorageKey(undefined), 'XCLOUD_OPEN_TABS');
  assert.equal(getTabsStorageKey(''), 'XCLOUD_OPEN_TABS');

  assert.equal(getRecentPagesStorageKey('alice'), 'XCLOUD_RECENT_PAGES:alice');
  assert.equal(getRecentPagesStorageKey('bob'), 'XCLOUD_RECENT_PAGES:bob');
  assert.equal(getRecentPagesStorageKey(undefined), 'XCLOUD_RECENT_PAGES');
  assert.equal(getRecentPagesStorageKey(''), 'XCLOUD_RECENT_PAGES');

  // Verify that distinct operators have distinct isolated keys
  assert.notEqual(getTabsStorageKey('alice'), getTabsStorageKey('bob'));
  assert.notEqual(getRecentPagesStorageKey('alice'), getRecentPagesStorageKey('bob'));
});

test('tab bar and breadcrumbs components store real normalized pathnames and purge legacy templates', () => {
  const tabBarSource = readSource('src/app/components/NavigationTabBar.tsx');
  const breadcrumbsSource = readSource('src/app/components/NavigationBreadcrumbs.tsx');
  const navSource = readSource('src/lib/navigation.ts');

  // Both must import and use isNavigableDestination
  assert.match(tabBarSource, /isNavigableDestination/);
  assert.match(breadcrumbsSource, /isNavigableDestination/);

  // Both must use user-scoped storage keys
  assert.match(tabBarSource, /getTabsStorageKey/);
  assert.match(breadcrumbsSource, /getRecentPagesStorageKey/);

  // Navigation authority rejects parameter templates containing ':'
  assert.match(navSource, /normalized\.includes\(':'\)/);

  // Both must clean up legacy unpartitioned storage on migration
  assert.match(tabBarSource, /localStorage\.removeItem\(STORAGE_KEY\)/);
  assert.match(breadcrumbsSource, /localStorage\.removeItem\(RECENT_PAGES_STORAGE_KEY\)/);
});

test('router binds authenticated 404 inside application shell without breaking unauthenticated redirects', () => {
  const routerSource = readSource('src/router/router.tsx');
  const notFoundSource = readSource('src/app/NotFoundPage.tsx');

  // The AuthGate-wrapped AppShell must contain a wildcard catch-all route child
  assert.match(routerSource, /element:\s*<AuthGate><AppShell\s*\/><\/AuthGate>,\s*children:\s*\[[\s\S]*?\{\s*path:\s*'\*',\s*element:\s*<NotFoundPage\s*\/>\s*\}/);

  // Top-level fallback wildcard route is also preserved
  assert.match(routerSource, /\{\s*path:\s*'\*',\s*element:\s*<NotFoundPage\s*\/>\s*\}\s*,\s*\]\);/);

  // NotFoundPage renders location.pathname and safe link to home
  assert.match(notFoundSource, /useLocation/);
  assert.match(notFoundSource, /location\.pathname/);
  assert.match(notFoundSource, /<Link to="\/"/);
});

test('notification center removes misleading nonfunctional audio and desktop controls', () => {
  const notifCenterSource = readSource('src/app/components/NotificationCenter.tsx');

  // Nonfunctional controls and state must be absent
  assert.doesNotMatch(notifCenterSource, /Volume2/);
  assert.doesNotMatch(notifCenterSource, /VolumeX/);
  assert.doesNotMatch(notifCenterSource, /ShieldAlert/);
  assert.doesNotMatch(notifCenterSource, /notif-settings-drawer/);
  assert.doesNotMatch(notifCenterSource, /notif_sound_alerts/);
  assert.doesNotMatch(notifCenterSource, /notif_volume/);
  assert.doesNotMatch(notifCenterSource, /notif_enable_desktop/);
  assert.doesNotMatch(notifCenterSource, /requestDesktopPermission/);

  // Authentic live stream indicator and notification management affordances must be preserved
  assert.match(notifCenterSource, /notif-stream-badge/);
  assert.match(notifCenterSource, /notif-status-dot/);
  assert.match(notifCenterSource, /notif-badge/);
  assert.match(notifCenterSource, /notif-tabs/);
  assert.match(notifCenterSource, /markAsRead/);
  assert.match(notifCenterSource, /markAllAsRead/);
  assert.match(notifCenterSource, /clearAllNotifications/);
});

test('breadcrumbs resolve valid labels and navigable parent hierarchy for dynamic paths', () => {
  // /subscribers/460020000000400
  const subCrumbs = getBreadcrumbs('/subscribers/460020000000400');
  assert.equal(subCrumbs.length, 3);
  assert.equal(subCrumbs[0].labelKey, 'breadcrumbs_home');
  assert.equal(subCrumbs[0].path, '/');
  assert.equal(subCrumbs[1].labelKey, 'nav_subscriber');
  assert.equal(subCrumbs[1].path, '/subscribers');
  assert.equal(subCrumbs[2].labelKey, '460020000000400');
  assert.equal(subCrumbs[2].current, true);

  // /inventory/00000000-0000-4000-8000-000000000001
  const invCrumbs = getBreadcrumbs('/inventory/00000000-0000-4000-8000-000000000001');
  assert.equal(invCrumbs.length, 3);
  assert.equal(invCrumbs[0].labelKey, 'breadcrumbs_home');
  assert.equal(invCrumbs[1].labelKey, 'nav_inventory');
  assert.equal(invCrumbs[2].labelKey, 'breadcrumbs_detail');
  assert.equal(invCrumbs[2].current, true);

  // /users/alice
  const userCrumbs = getBreadcrumbs('/users/alice');
  assert.equal(userCrumbs.length, 3);
  assert.equal(userCrumbs[1].labelKey, 'nav_system_users');
  assert.equal(userCrumbs[2].labelKey, 'alice');
});

test('functional migration purges invalid templates and migrates legacy unpartitioned storage', () => {
  const store = new Map<string, string>();
  const mockStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  };

  const originalWindow = globalThis.window;
  const originalLocalStorage = (globalThis as unknown as { localStorage: unknown }).localStorage;

  try {
    // Provide window and localStorage in test environment
    (globalThis as unknown as { localStorage: unknown }).localStorage = mockStorage;
    (globalThis as unknown as { window: unknown }).window = {
      localStorage: mockStorage,
    };

    // 1. Tab Bar Legacy Migration
    store.set('XCLOUD_OPEN_TABS', JSON.stringify([
      { path: '/subscribers/:imsi' },
      { path: '/subscribers/460020000000400' },
      { path: '/inventory/:resourceId' },
      { path: '/does-not-exist' },
    ]));

    const tabs = getStoredTabsSnapshot('operator1', 'operator');

    // Legacy un-scoped key must be cleared after migration
    assert.equal(store.has('XCLOUD_OPEN_TABS'), false, 'legacy XCLOUD_OPEN_TABS must be cleared on migration');

    // Migrated tabs must contain the pinned home tab and the valid real destination, with templates removed
    const paths = tabs.map((t) => t.path);
    assert.ok(paths.includes('/'), 'home tab must be present');
    assert.ok(paths.includes('/subscribers/460020000000400'), 'real dynamic subscriber destination must be preserved');
    assert.ok(!paths.includes('/subscribers/:imsi'), 'unresolved :imsi template must be purged');
    assert.ok(!paths.includes('/inventory/:resourceId'), 'unresolved :resourceId template must be purged');
    assert.ok(!paths.includes('/does-not-exist'), 'nonexistent route must be purged');

    // 2. Recent Pages Legacy Migration
    store.set('XCLOUD_RECENT_PAGES', JSON.stringify([
      { path: '/users/:username', timestamp: 1000 },
      { path: '/subscribers/460020000000400', timestamp: 2000 },
      { path: '/does-not-exist', timestamp: 3000 },
    ]));

    const recent = getStoredRecentSnapshot('operator1', 'operator');

    // Legacy un-scoped key must be cleared after migration
    assert.equal(store.has('XCLOUD_RECENT_PAGES'), false, 'legacy XCLOUD_RECENT_PAGES must be cleared on migration');

    const recentPaths = recent.map((r) => r.path);
    assert.ok(recentPaths.includes('/subscribers/460020000000400'), 'real subscriber destination must be preserved');
    assert.ok(!recentPaths.includes('/users/:username'), 'unresolved :username template must be purged');
    assert.ok(!recentPaths.includes('/does-not-exist'), 'nonexistent route must be purged');
  } finally {
    (globalThis as unknown as { window: unknown }).window = originalWindow;
    (globalThis as unknown as { localStorage: unknown }).localStorage = originalLocalStorage;
  }
});
