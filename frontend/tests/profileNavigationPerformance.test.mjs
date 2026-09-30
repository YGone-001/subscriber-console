import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getNavigationDataKeys } from '../src/lib/navigationPrefetch.ts';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('primary dashboard routes expose a bounded first-screen prefetch plan', () => {
  const expectedRoutes = [
    '/',
    '/subscribers',
    '/ocs/tariffs',
    '/ocs/contracts',
    '/ocs/balances',
    '/profile',
    '/users',
    '/system-health',
  ];

  for (const route of expectedRoutes) {
    const keys = getNavigationDataKeys(route);
    assert.ok(keys.length >= 1, `${route} should prefetch its primary data`);
    assert.ok(keys.length <= 2, `${route} should not fan out into unbounded prefetches`);
  }
  assert.deepEqual(getNavigationDataKeys('/profile?source=recent'), ['/api/profiles']);
  assert.deepEqual(getNavigationDataKeys('/unknown'), []);
});

test('sidebar and workspace tabs preload data on navigation intent', () => {
  const sidebar = read('../src/app/(dashboard)/components/AppSidebar.tsx');
  const tabs = read('../src/components/NavigationTabBar.tsx');

  for (const [source, pathExpression] of [[sidebar, 'item\\.path'], [tabs, 'tab\\.path']]) {
    assert.match(source, new RegExp(`onMouseEnter=\\{\\(\\) => prefetchNavigationData\\(${pathExpression}\\)\\}`));
    assert.match(source, new RegExp(`onFocus=\\{\\(\\) => prefetchNavigationData\\(${pathExpression}\\)\\}`));
    assert.match(source, new RegExp(`onPointerDown=\\{\\(\\) => prefetchNavigationData\\(${pathExpression}\\)\\}`));
  }
});
