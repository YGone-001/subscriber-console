import assert from 'node:assert/strict';
import test from 'node:test';
import { getBreadcrumbs, getNavigationRoute, getVisibleNavigation, matchesRoute } from '../src/lib/navigation';
import { normalizeRole } from '../src/lib/permissions';
import { isLocale, isThemePreference, resolveTheme } from '../src/lib/preferences';

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
