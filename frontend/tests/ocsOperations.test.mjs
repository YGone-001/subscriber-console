import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const sidebarSource = readFileSync(new URL('../src/app/(dashboard)/components/AppSidebar.tsx', import.meta.url), 'utf8');
const zhLocale = readFileSync(new URL('../src/lib/locales/zh.ts', import.meta.url), 'utf8');
const enLocale = readFileSync(new URL('../src/lib/locales/en.ts', import.meta.url), 'utf8');

test('OCS operational pages and components exist', () => {
  assert.equal(existsSync(new URL('../src/app/(dashboard)/ocs/balances/page.tsx', import.meta.url)), true);
  assert.equal(existsSync(new URL('../src/app/(dashboard)/ocs/sessions/page.tsx', import.meta.url)), true);
  assert.equal(existsSync(new URL('../src/app/(dashboard)/ocs/usage/page.tsx', import.meta.url)), true);
  assert.equal(existsSync(new URL('../src/app/(dashboard)/ocs/page.tsx', import.meta.url)), true);
  assert.equal(existsSync(new URL('../src/components/ocs/OcsBalancesPanel.tsx', import.meta.url)), true);
  assert.equal(existsSync(new URL('../src/components/ocs/OcsSessionsPanel.tsx', import.meta.url)), true);
  assert.equal(existsSync(new URL('../src/components/ocs/OcsUsagePanel.tsx', import.meta.url)), true);
  assert.equal(existsSync(new URL('../src/components/ocs/OcsDetailDrawer.tsx', import.meta.url)), true);
  assert.equal(existsSync(new URL('../src/app/(dashboard)/ocs/ocs.css', import.meta.url)), true);
});

test('OCS navigation group is wired in AppSidebar with i18n support', () => {
  assert.match(sidebarSource, /nav_ocs/);
  const routeRegistry = readFileSync(new URL('../src/lib/navigationRoutes.ts', import.meta.url), 'utf8');
  assert.match(routeRegistry, /nav_ocs_balances/);
  assert.match(routeRegistry, /nav_ocs_sessions/);
  assert.match(routeRegistry, /nav_ocs_usage/);
  assert.match(zhLocale, /nav_ocs_balances/);
  assert.match(enLocale, /nav_ocs_balances/);
  assert.match(zhLocale, /ocs_balances_title/);
  assert.match(enLocale, /ocs_balances_title/);
});
