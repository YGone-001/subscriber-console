import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NAVIGATION_ROUTES } from '../src/lib/navigationRoutes.ts';

const sidebarSource = readFileSync(new URL('../src/app/(dashboard)/components/AppSidebar.tsx', import.meta.url), 'utf8');
const zhLocale = readFileSync(new URL('../src/lib/locales/zh.ts', import.meta.url), 'utf8');
const enLocale = readFileSync(new URL('../src/lib/locales/en.ts', import.meta.url), 'utf8');

test('Tariff Management navigation group contains exactly 3 visible child routes', () => {
  const ocsRoutes = NAVIGATION_ROUTES.filter((r) => r.group === 'ocs');
  assert.equal(ocsRoutes.length, 3, 'Tariff Management group must contain exactly 3 visible child routes');

  const paths = ocsRoutes.map((r) => r.path);
  assert.deepEqual(paths, ['/ocs/tariffs', '/ocs/contracts', '/ocs/balances']);

  for (const route of ocsRoutes) {
    assert.equal(route.groupPath, '/ocs/tariffs', `${route.path} groupPath must resolve to /ocs/tariffs`);
    assert.equal(route.groupLabelKey, 'nav_ocs');
  }
});

test('Forbidden legacy and charging-plane routes do NOT appear in Tariff Management navigation', () => {
  const ocsRoutes = NAVIGATION_ROUTES.filter((r) => r.group === 'ocs');
  const ocsPaths = ocsRoutes.map((r) => r.path);

  const forbiddenRoutes = [
    '/ocs/dashboard',
    '/ocs/approvals',
    '/ocs/audit',
    '/ocs/subscribers',
    '/ocs/sessions',
    '/ocs/usage',
    '/rating',
    '/rating/plans',
    '/rating/rules',
  ];

  for (const forbidden of forbiddenRoutes) {
    assert.equal(ocsPaths.includes(forbidden), false, `${forbidden} must not appear in Tariff Management navigation`);
  }
});

test('Global governance routes (/approvals and /audit-logs) remain available', () => {
  const governanceRoutes = NAVIGATION_ROUTES.filter((r) => r.group === 'governance');
  const paths = governanceRoutes.map((r) => r.path);

  assert.ok(paths.includes('/approvals'), 'global /approvals must remain available');
  assert.ok(paths.includes('/audit-logs'), 'global /audit-logs must remain available');
});

test('AppSidebar consolidates Tariff Management and eliminates legacy rating navigation', () => {
  // nav_ocs points to /ocs/tariffs
  assert.match(sidebarSource, /key:\s*"nav_ocs",\s*path:\s*"\/ocs\/tariffs"/);

  // AppSidebar does not contain rating expandable or route item
  assert.doesNotMatch(sidebarSource, /routeItem\("\/rating"\)/);
  assert.doesNotMatch(sidebarSource, /ratingNavOpen/);
  assert.doesNotMatch(sidebarSource, /ratingSubItems/);
});

test('Legacy routes redirect cleanly without redirect loops', () => {
  const readPage = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

  // /ocs and /ocs/dashboard redirect to /ocs/tariffs
  assert.match(readPage('../src/app/(dashboard)/ocs/page.tsx'), /redirect\("\/ocs\/tariffs"\)/);
  assert.match(readPage('../src/app/(dashboard)/ocs/dashboard/page.tsx'), /redirect\("\/ocs\/tariffs"\)/);

  // /ocs/subscribers redirects to /ocs/contracts
  assert.match(readPage('../src/app/(dashboard)/ocs/subscribers/page.tsx'), /redirect\("\/ocs\/contracts"\)/);

  // /ocs/approvals and /ocs/audit redirect to global governance
  assert.match(readPage('../src/app/(dashboard)/ocs/approvals/page.tsx'), /redirect\("\/approvals"\)/);
  assert.match(readPage('../src/app/(dashboard)/ocs/audit/page.tsx'), /redirect\("\/audit-logs"\)/);

  // /ocs/sessions and /ocs/usage redirect to /ocs/tariffs
  assert.match(readPage('../src/app/(dashboard)/ocs/sessions/page.tsx'), /redirect\("\/ocs\/tariffs"\)/);
  assert.match(readPage('../src/app/(dashboard)/ocs/usage/page.tsx'), /redirect\("\/ocs\/tariffs"\)/);

  // /rating* redirect to /ocs/tariffs
  assert.match(readPage('../src/app/(dashboard)/rating/page.tsx'), /redirect\("\/ocs\/tariffs"\)/);
  assert.match(readPage('../src/app/(dashboard)/rating/plans/page.tsx'), /redirect\("\/ocs\/tariffs"\)/);
  assert.match(readPage('../src/app/(dashboard)/rating/rules/page.tsx'), /redirect\("\/ocs\/tariffs"\)/);
});

test('Tariff Management terminology is properly localized in zh and en', () => {
  assert.match(zhLocale, /nav_ocs:\s*"计费管理"/);
  assert.match(enLocale, /nav_ocs:\s*"Charging Management"/);

  assert.match(zhLocale, /nav_ocs_tariffs:\s*"资费计划"/);
  assert.match(enLocale, /nav_ocs_tariffs:\s*"Tariff Plans"/);

  assert.match(zhLocale, /nav_ocs_contracts:\s*"签约用户"/);
  assert.match(enLocale, /nav_ocs_contracts:\s*"Contract Subscribers"/);

  assert.match(zhLocale, /nav_ocs_balances:\s*"余额管理"/);
  assert.match(enLocale, /nav_ocs_balances:\s*"Balance Management"/);
});
