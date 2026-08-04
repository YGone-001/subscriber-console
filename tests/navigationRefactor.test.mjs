import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const tabBarPath = new URL('../src/components/NavigationTabBar.tsx', import.meta.url);
const breadcrumbsPath = new URL('../src/components/NavigationBreadcrumbs.tsx', import.meta.url);
const sidebarPath = new URL('../src/app/(dashboard)/components/AppSidebar.tsx', import.meta.url);
const layoutPath = new URL('../src/app/(dashboard)/layout.tsx', import.meta.url);
const commandPalettePath = new URL('../src/components/CommandPalette.tsx', import.meta.url);
const layoutCssPath = new URL('../src/app/(dashboard)/layout.css', import.meta.url);
const zhLocaleSource = readFileSync(new URL('../src/lib/locales/zh.ts', import.meta.url), 'utf8');
const enLocaleSource = readFileSync(new URL('../src/lib/locales/en.ts', import.meta.url), 'utf8');

test('navigation components exist and are mounted in dashboard layout', () => {
  assert.equal(existsSync(tabBarPath), true);
  assert.equal(existsSync(breadcrumbsPath), true);

  const layoutContent = readFileSync(layoutPath, 'utf8');
  assert.match(layoutContent, /NavigationTabBar/);
  assert.match(layoutContent, /NavigationBreadcrumbs/);
  assert.match(layoutContent, /Ctrl\+B|ctrlKey/i);
});

test('NavigationTabBar manages tabs and default pinned home', () => {
  const tabBarContent = readFileSync(tabBarPath, 'utf8');
  assert.match(tabBarContent, /XCLOUD_OPEN_TABS/);
  assert.match(tabBarContent, /nav_tab_close_others/);
  assert.match(tabBarContent, /nav_tab_close_all/);
  assert.match(tabBarContent, /isPinned:\s*true/);
});

test('NavigationBreadcrumbs tracks route hierarchy and recent history', () => {
  const crumbsContent = readFileSync(breadcrumbsPath, 'utf8');
  assert.match(crumbsContent, /XCLOUD_RECENT_PAGES/);
  assert.match(crumbsContent, /nav_crumb_recent_title/);
  assert.match(crumbsContent, /nav_crumb_copy_link/);
  assert.match(crumbsContent, /nav_crumb_refresh/);
});

test('AppSidebar supports instant menu filtering and keyboard shortcut toggle', () => {
  const sidebarContent = readFileSync(sidebarPath, 'utf8');
  assert.match(sidebarContent, /sidebar-filter-input/);
  assert.match(sidebarContent, /sidebar_filter_ph/);
  assert.match(sidebarContent, /sidebar-toggle-btn/);
  assert.match(sidebarContent, /Ctrl B/);
});

test('CommandPalette contains all routes, categories, and quick actions', () => {
  const cpContent = readFileSync(commandPalettePath, 'utf8');
  assert.match(cpContent, /cp_cat_all/);
  assert.match(cpContent, /cp_cat_pages/);
  assert.match(cpContent, /cp_cat_actions/);
  assert.match(cpContent, /cp_cat_data/);
  assert.match(cpContent, /\/ocs\/balances/);
  assert.match(cpContent, /\/ocs\/sessions/);
  assert.match(cpContent, /\/ocs\/usage/);
  assert.match(cpContent, /\/rating\/plans/);
  assert.match(cpContent, /\/rating\/rules/);
  assert.match(cpContent, /\/users/);
  assert.match(cpContent, /\/roles/);
  assert.match(cpContent, /\/approvals/);
  assert.match(cpContent, /\/audit-logs/);
  assert.match(cpContent, /\/system-health/);
  assert.match(cpContent, /toggle-theme/);
  assert.match(cpContent, /clear-recent-history/);
});

test('layout.css contains complete styles for navigation subsystems', () => {
  const cssContent = readFileSync(layoutCssPath, 'utf8');
  assert.match(cssContent, /\.layout-content-area/);
  assert.match(cssContent, /\.nav-tab-bar/);
  assert.match(cssContent, /\.nav-breadcrumbs-bar/);
  assert.match(cssContent, /\.sidebar-filter-wrap/);
  assert.match(cssContent, /\.sidebar-footer-wrap/);
});

test('navigation i18n keys are 100% matched between en.ts and zh.ts', () => {
  const requiredKeys = [
    'sidebar_filter_ph',
    'sidebar_collapse',
    'sidebar_collapse_hint',
    'sidebar_expand_hint',
    'nav_tab_scroll_left',
    'nav_tab_scroll_right',
    'nav_tab_close',
    'nav_tab_options',
    'nav_tab_close_others',
    'nav_tab_close_all',
    'nav_crumb_recent_title',
    'nav_crumb_recent_btn',
    'nav_crumb_clear_recent',
    'nav_crumb_no_recent',
    'nav_crumb_copy_link',
    'nav_crumb_copied',
    'nav_crumb_refresh',
    'cp_cat_all',
    'cp_cat_pages',
    'cp_cat_actions',
    'cp_cat_data',
    'cp_act_theme_desc',
    'cp_act_clear_history_desc',
  ];

  for (const key of requiredKeys) {
    assert.match(zhLocaleSource, new RegExp(`${key}:`), `zh.ts missing key: ${key}`);
    assert.match(enLocaleSource, new RegExp(`${key}:`), `en.ts missing key: ${key}`);
  }
});
