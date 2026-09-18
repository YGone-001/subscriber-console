import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const sidebarSource = readFileSync(new URL('../src/app/(dashboard)/components/AppSidebar.tsx', import.meta.url), 'utf8');
const balancesRoute = readFileSync(new URL('../src/app/api/ocs/balances/route.ts', import.meta.url), 'utf8');
const sessionsRoute = readFileSync(new URL('../src/app/api/ocs/sessions/route.ts', import.meta.url), 'utf8');
const usageRoute = readFileSync(new URL('../src/app/api/ocs/usage/route.ts', import.meta.url), 'utf8');
const reservationsRoute = readFileSync(new URL('../src/app/api/ocs/reservations/route.ts', import.meta.url), 'utf8');
const repoSource = readFileSync(new URL('../src/server/repositories/ocsOperationsRepository.ts', import.meta.url), 'utf8');
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

test('OCS API routes enforce authentication and permissions', () => {
  assert.match(balancesRoute, /requireAuth\(request\)/);
  assert.match(sessionsRoute, /requireAuth\(request\)/);
  assert.match(usageRoute, /requireAuth\(request\)/);
  assert.match(reservationsRoute, /requireAuth\(request\)/);
});

test('OCS repository calculates balance invariants strictly (data_total == data_used + data_reserved + data_available)', () => {
  assert.match(repoSource, /data_total\s*===\s*\(balance\.data_used\s*\+\s*balance\.data_reserved\s*\+\s*balance\.data_available\)/);
  assert.match(repoSource, /voice_total\s*===\s*\(balance\.voice_used\s*\+\s*balance\.voice_reserved\s*\+\s*balance\.voice_available\)/);
  assert.match(repoSource, /sms_total\s*===\s*\(balance\.sms_used\s*\+\s*balance\.sms_available\)/);
});
