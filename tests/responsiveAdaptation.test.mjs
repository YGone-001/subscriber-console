import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('dashboard shell exposes a compact mobile context and accessible off-canvas navigation', () => {
  const layout = read('../src/app/(dashboard)/layout.tsx');
  const header = read('../src/app/(dashboard)/components/AppHeader.tsx');
  const sidebar = read('../src/app/(dashboard)/components/AppSidebar.tsx');
  const tabBar = read('../src/components/NavigationTabBar.tsx');
  const css = read('../src/app/(dashboard)/layout.css');

  assert.match(layout, /useSyncExternalStore/);
  assert.match(layout, /\(min-width: 981px\)/);
  assert.match(layout, /document\.body\.style\.overflow = "hidden"/);
  assert.match(header, /aria-controls="xcloud-primary-sidebar"/);
  assert.match(header, /aria-expanded=\{sidebarOpen\}/);
  assert.match(sidebar, /id="xcloud-primary-sidebar"/);
  assert.match(sidebar, /inert=\{isMobileShell && !sidebarOpen \? true : undefined\}/);
  assert.match(tabBar, /nav-mobile-current/);
  assert.match(css, /\.nav-mobile-current\s*\{[\s\S]*?display:\s*flex/);
});

test('high-density data tables switch to labelled record cards on narrow screens', () => {
  const subscriberTable = read('../src/app/(dashboard)/subscribers/components/SubscriberTable.tsx');
  const subscriberCss = read('../src/app/(dashboard)/subscribers/subscribers.css');
  const usersTable = read('../src/app/(dashboard)/users/components/UsersTable.tsx');
  const usersCss = read('../src/app/(dashboard)/users/users.css');
  const ratingTable = read('../src/components/rating/PccRuleList.tsx');
  const ratingCss = read('../src/components/rating/rating.css');

  for (const source of [subscriberTable, usersTable, ratingTable]) {
    assert.match(source, /data-label=/);
  }

  for (const source of [subscriberCss, usersCss, ratingCss]) {
    assert.match(source, /display:\s*grid/);
    assert.match(source, /content:\s*attr\(data-label\)/);
  }

  assert.match(subscriberTable, /mobile-sort-strip/);
  assert.match(usersTable, /mobile-sort-strip/);
});

test('critical shell and row actions share the 44px touch-target floor', () => {
  const layoutCss = read('../src/app/(dashboard)/layout.css');
  const globalCss = read('../src/app/globals.css');
  const subscriberCss = read('../src/app/(dashboard)/subscribers/subscribers.css');
  const usersCss = read('../src/app/(dashboard)/users/users.css');

  assert.match(globalCss, /\.btn-icon\s*\{[\s\S]*?width:\s*44px;[\s\S]*?height:\s*44px/);
  assert.match(layoutCss, /\.icon-button\s*\{[\s\S]*?width:\s*44px;[\s\S]*?height:\s*44px/);
  assert.match(subscriberCss, /\.action-btn\s*\{[\s\S]*?width:\s*44px;[\s\S]*?height:\s*44px/);
  assert.match(usersCss, /\.users-row-actions \.btn\s*\{[\s\S]*?min-height:\s*44px/);
});
