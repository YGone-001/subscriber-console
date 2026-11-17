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
import { clearTabsMemoryCache, getStoredTabsSnapshot, getTabsStorageKey, writeTabs } from '../src/app/components/NavigationTabBar';
import { clearRecentMemoryCache, getRecentPagesStorageKey, getStoredRecentSnapshot, writeRecentPages } from '../src/app/components/NavigationBreadcrumbs';
import { isValidElement } from 'react';
import { matchRoutes } from 'react-router-dom';
import { AuthGate } from '../src/auth/AuthGate';
import { appRoutes } from '../src/router/routes';

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
  const notFoundSource = readSource('src/app/NotFoundPage.tsx');

  /*
   * Behavioural check against the real route table. Route implementations are
   * lazy now, so the previous source-text pattern would only describe an
   * implementation detail; matching an unknown path proves the actual
   * structure: the shell route (AuthGate) plus a wildcard child that renders
   * NotFoundPage.
   */
  const shellRoute = appRoutes.find((route) => isValidElement(route.element) && route.element.type === AuthGate);
  assert.ok(shellRoute, 'the route table must mount the application shell behind AuthGate');

  const unknownMatches = matchRoutes(appRoutes, '/no-such-page');
  assert.ok(unknownMatches && unknownMatches.length >= 2, 'an unknown path must match the shell plus a wildcard child');
  assert.equal(unknownMatches[unknownMatches.length - 1].route.path, '*', 'the unknown path must terminate at the wildcard route');

  // Top-level fallback wildcard route is also preserved
  assert.ok(
    appRoutes.some((route) => route.path === '*' && isValidElement(route.element)),
    'the unauthenticated fallback wildcard must stay at the top level',
  );

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

test('unpartitioned legacy history is purged and discarded upon authentication without disclosure to the new operator', () => {
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
    (globalThis as unknown as { localStorage: unknown }).localStorage = mockStorage;
    (globalThis as unknown as { window: unknown }).window = { localStorage: mockStorage };
    clearTabsMemoryCache();
    clearRecentMemoryCache();

    // 1. Pre-seed unpartitioned legacy history containing sensitive Alice destinations
    store.set('XCLOUD_OPEN_TABS', JSON.stringify([
      { path: '/subscribers/460020000000400' },
      { path: '/users/alice' },
      { path: '/subscribers/:imsi' },
    ]));
    store.set('XCLOUD_RECENT_PAGES', JSON.stringify([
      { path: '/subscribers/460020000000400', timestamp: 1000 },
      { path: '/users/alice', timestamp: 2000 },
    ]));

    // 2. Operator Bob logs in (first time, no scoped history yet)
    const bobTabs = getStoredTabsSnapshot('bob', 'operator');
    const bobRecent = getStoredRecentSnapshot('bob', 'operator');

    // 3. Invariants:
    // a) Legacy unpartitioned storage must be purged
    assert.equal(store.has('XCLOUD_OPEN_TABS'), false, 'legacy XCLOUD_OPEN_TABS must be purged');
    assert.equal(store.has('XCLOUD_RECENT_PAGES'), false, 'legacy XCLOUD_RECENT_PAGES must be purged');

    // b) Bob must NOT inherit Alice's legacy tabs or recent pages
    const bobTabPaths = bobTabs.map((t) => t.path);
    assert.deepEqual(bobTabPaths, ['/'], 'Bob must only have the default home tab');
    assert.equal(bobRecent.length, 0, 'Bob must have an empty recent pages list');

    // c) Sensitive paths from Alice must never appear in Bob's view
    assert.ok(!bobTabPaths.includes('/subscribers/460020000000400'), 'Alice subscriber detail must not leak to Bob');
    assert.ok(!bobTabPaths.includes('/users/alice'), 'Alice user management must not leak to Bob');
  } finally {
    clearTabsMemoryCache();
    clearRecentMemoryCache();
    (globalThis as unknown as { window: unknown }).window = originalWindow;
    (globalThis as unknown as { localStorage: unknown }).localStorage = originalLocalStorage;
  }
});

test('account switching keeps distinct user history isolated and prevents disclosure from Alice to Bob', () => {
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
    (globalThis as unknown as { localStorage: unknown }).localStorage = mockStorage;
    (globalThis as unknown as { window: unknown }).window = { localStorage: mockStorage };
    clearTabsMemoryCache();
    clearRecentMemoryCache();

    // Alice (admin) has valid user-scoped history
    writeTabs([
      { path: '/', labelKey: 'nav_dashboard', icon: null, isPinned: true },
      { path: '/subscribers/460020000000400', labelKey: 'nav_subscriber', icon: null },
      { path: '/users/alice', labelKey: 'nav_system_users', icon: null },
    ], 'alice');

    writeRecentPages([
      { path: '/subscribers/460020000000400', labelKey: 'nav_subscriber', timestamp: 1000 },
      { path: '/users/alice', labelKey: 'nav_system_users', timestamp: 2000 },
    ], 'alice');

    // Clear memory caches as occurs on logout
    clearTabsMemoryCache();
    clearRecentMemoryCache();

    // Bob (operator) authenticates
    const bobTabs = getStoredTabsSnapshot('bob', 'operator');
    const bobRecent = getStoredRecentSnapshot('bob', 'operator');

    // Bob sees clean default state with no Alice history
    assert.deepEqual(bobTabs.map((t) => t.path), ['/']);
    assert.equal(bobRecent.length, 0);

    // Bob visits his own destinations
    writeTabs([
      { path: '/', labelKey: 'nav_dashboard', icon: null, isPinned: true },
      { path: '/inventory/00000000-0000-4000-8000-000000000001', labelKey: 'nav_inventory', icon: null },
    ], 'bob');

    writeRecentPages([
      { path: '/inventory/00000000-0000-4000-8000-000000000001', labelKey: 'nav_inventory', timestamp: 3000 },
    ], 'bob');

    // Verify Bob's storage is isolated
    assert.ok(store.has('XCLOUD_OPEN_TABS:bob'));
    assert.ok(store.has('XCLOUD_OPEN_TABS:alice'));

    // Re-verify Alice's history is intact under her own key
    clearTabsMemoryCache();
    const aliceTabs = getStoredTabsSnapshot('alice', 'admin');
    assert.deepEqual(aliceTabs.map((t) => t.path), ['/', '/subscribers/460020000000400', '/users/alice']);
  } finally {
    clearTabsMemoryCache();
    clearRecentMemoryCache();
    (globalThis as unknown as { window: unknown }).window = originalWindow;
    (globalThis as unknown as { localStorage: unknown }).localStorage = originalLocalStorage;
  }
});

test('user-scoped history persists across simulated reload and restores valid destinations', () => {
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
    (globalThis as unknown as { localStorage: unknown }).localStorage = mockStorage;
    (globalThis as unknown as { window: unknown }).window = { localStorage: mockStorage };
    clearTabsMemoryCache();

    // Bob saves tabs during his session
    writeTabs([
      { path: '/', labelKey: 'nav_dashboard', icon: null, isPinned: true },
      { path: '/subscribers/460020000000400', labelKey: 'nav_subscriber', icon: null },
      { path: '/inventory/00000000-0000-4000-8000-000000000001', labelKey: 'nav_inventory', icon: null },
      { path: '/knowledge/example-entry', labelKey: 'nav_knowledge', icon: null },
    ], 'bob');

    // Simulate page reload (F5) by evicting memory cache
    clearTabsMemoryCache();

    // Reload tabs from persistent storage
    const reloaded = getStoredTabsSnapshot('bob', 'operator');
    const paths = reloaded.map((t) => t.path);

    assert.equal(paths.length, 4);
    assert.equal(paths[0], '/');
    assert.ok(paths.includes('/subscribers/460020000000400'));
    assert.ok(paths.includes('/inventory/00000000-0000-4000-8000-000000000001'));
    assert.ok(paths.includes('/knowledge/example-entry'));
    assert.equal(reloaded[0].isPinned, true, 'home tab must remain pinned across reload');
  } finally {
    clearTabsMemoryCache();
    (globalThis as unknown as { window: unknown }).window = originalWindow;
    (globalThis as unknown as { localStorage: unknown }).localStorage = originalLocalStorage;
  }
});

test('role downgrade prunes unauthorized destinations upon storage read and revalidation', () => {
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
    (globalThis as unknown as { localStorage: unknown }).localStorage = mockStorage;
    (globalThis as unknown as { window: unknown }).window = { localStorage: mockStorage };
    clearTabsMemoryCache();

    // User Charlie stored tabs when previously having admin role
    store.set('XCLOUD_OPEN_TABS:charlie', JSON.stringify([
      { path: '/' },
      { path: '/subscribers/460020000000400' },
      { path: '/users/alice' },
      { path: '/system/retention' },
    ]));

    // 1. When evaluated under 'operator' role: user-management destinations are pruned
    const operatorTabs = getStoredTabsSnapshot('charlie', 'operator');
    const operatorPaths = operatorTabs.map((t) => t.path);
    assert.ok(operatorPaths.includes('/'));
    assert.ok(operatorPaths.includes('/subscribers/460020000000400'));
    assert.ok(!operatorPaths.includes('/users/alice'), '/users/alice must be pruned for operator');
    assert.ok(!operatorPaths.includes('/system/retention'), '/system/retention must be pruned for operator');

    // 2. When evaluated under 'viewer' role: user-management destinations are also pruned
    clearTabsMemoryCache();
    const viewerTabs = getStoredTabsSnapshot('charlie', 'viewer');
    const viewerPaths = viewerTabs.map((t) => t.path);
    assert.ok(viewerPaths.includes('/'));
    assert.ok(viewerPaths.includes('/subscribers/460020000000400'));
    assert.ok(!viewerPaths.includes('/users/alice'), '/users/alice must be pruned for viewer');
  } finally {
    clearTabsMemoryCache();
    (globalThis as unknown as { window: unknown }).window = originalWindow;
    (globalThis as unknown as { localStorage: unknown }).localStorage = originalLocalStorage;
  }
});

test('unauthenticated and session-checking states never read or write unpartitioned storage', () => {
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
    (globalThis as unknown as { localStorage: unknown }).localStorage = mockStorage;
    (globalThis as unknown as { window: unknown }).window = { localStorage: mockStorage };
    clearTabsMemoryCache();
    clearRecentMemoryCache();

    // Reading with undefined or null returns defaults and never touches storage
    const tabsUndef = getStoredTabsSnapshot(undefined);
    const tabsNull = getStoredTabsSnapshot(null);
    assert.deepEqual(tabsUndef.map((t) => t.path), ['/']);
    assert.deepEqual(tabsNull.map((t) => t.path), ['/']);

    const recentUndef = getStoredRecentSnapshot(undefined);
    const recentNull = getStoredRecentSnapshot(null);
    assert.deepEqual(recentUndef, []);
    assert.deepEqual(recentNull, []);

    // Writing with undefined or null is a safe no-op that never writes to unscoped keys
    writeTabs([{ path: '/subscribers/460020000000400', labelKey: 'nav_subscriber', icon: null }], undefined);
    writeTabs([{ path: '/subscribers/460020000000400', labelKey: 'nav_subscriber', icon: null }], null);
    writeRecentPages([{ path: '/subscribers/460020000000400', labelKey: 'nav_subscriber', timestamp: 1 }], undefined);
    writeRecentPages([{ path: '/subscribers/460020000000400', labelKey: 'nav_subscriber', timestamp: 1 }], null);

    assert.equal(store.has('XCLOUD_OPEN_TABS'), false, 'unscoped XCLOUD_OPEN_TABS must not be written');
    assert.equal(store.has('XCLOUD_RECENT_PAGES'), false, 'unscoped XCLOUD_RECENT_PAGES must not be written');
    assert.equal(store.size, 0, 'no unauthenticated storage keys must be created');
  } finally {
    clearTabsMemoryCache();
    clearRecentMemoryCache();
    (globalThis as unknown as { window: unknown }).window = originalWindow;
    (globalThis as unknown as { localStorage: unknown }).localStorage = originalLocalStorage;
  }
});

test('corrupted or malformed storage payloads fail safe to default tabs and empty recent list', () => {
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
    (globalThis as unknown as { localStorage: unknown }).localStorage = mockStorage;
    (globalThis as unknown as { window: unknown }).window = { localStorage: mockStorage };
    clearTabsMemoryCache();
    clearRecentMemoryCache();

    // 1. Malformed JSON
    store.set('XCLOUD_OPEN_TABS:bob', '{not valid json');
    store.set('XCLOUD_RECENT_PAGES:bob', '<<<bad json>>>');

    const tabsMalformed = getStoredTabsSnapshot('bob', 'operator');
    const recentMalformed = getStoredRecentSnapshot('bob', 'operator');

    assert.deepEqual(tabsMalformed.map((t) => t.path), ['/']);
    assert.deepEqual(recentMalformed, []);

    // 2. Non-array JSON
    clearTabsMemoryCache();
    clearRecentMemoryCache();
    store.set('XCLOUD_OPEN_TABS:bob', JSON.stringify({ path: '/subscribers/123' }));
    store.set('XCLOUD_RECENT_PAGES:bob', JSON.stringify("string"));

    const tabsNonArray = getStoredTabsSnapshot('bob', 'operator');
    const recentNonArray = getStoredRecentSnapshot('bob', 'operator');

    assert.deepEqual(tabsNonArray.map((t) => t.path), ['/']);
    assert.deepEqual(recentNonArray, []);

    // 3. Duplicate paths in stored tabs are de-duplicated
    clearTabsMemoryCache();
    store.set('XCLOUD_OPEN_TABS:bob', JSON.stringify([
      { path: '/subscribers/460020000000400' },
      { path: '/subscribers/460020000000400' },
      { path: '/' },
    ]));
    const tabsDedup = getStoredTabsSnapshot('bob', 'operator');
    const dedupPaths = tabsDedup.map((t) => t.path);
    assert.equal(dedupPaths.filter((p) => p === '/subscribers/460020000000400').length, 1);
  } finally {
    clearTabsMemoryCache();
    clearRecentMemoryCache();
    (globalThis as unknown as { window: unknown }).window = originalWindow;
    (globalThis as unknown as { localStorage: unknown }).localStorage = originalLocalStorage;
  }
});

test('static paths take precedence over dynamic route templates', () => {
  // /subscribers/new vs /subscribers/:imsi
  const subNew = getNavigationRoute('/subscribers/new');
  assert.equal(subNew?.route, '/subscribers/new');
  assert.deepEqual(subNew?.dynamicParameters, []);

  // /inventory/create vs /inventory/:resourceId
  const invCreate = getNavigationRoute('/inventory/create');
  assert.equal(invCreate?.route, '/inventory/create');
  assert.deepEqual(invCreate?.dynamicParameters, []);

  // /knowledge/new vs /knowledge/:entryId
  const knowNew = getNavigationRoute('/knowledge/new');
  assert.equal(knowNew?.route, '/knowledge/new');
  assert.deepEqual(knowNew?.dynamicParameters, []);

  // /users/create vs /users/:username
  const userCreate = getNavigationRoute('/users/create');
  assert.equal(userCreate?.route, '/users/create');
  assert.deepEqual(userCreate?.dynamicParameters, []);
});
