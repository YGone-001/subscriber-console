import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { summarizeProfiles } from '../src/server/repositories/profileRepository.ts';
import { getNavigationDataKeys } from '../src/lib/navigationPrefetch.ts';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('profile list API derives its summary without repeating the list query', () => {
  const route = read('../src/app/api/profiles/route.ts');

  assert.match(route, /const profiles = await listProfiles\(\)/);
  assert.match(route, /const summary = summarizeProfiles\(profiles\)/);
  assert.doesNotMatch(route, /getProfilesGlobalSummary/);
});

test('profile summary is derived from the already loaded rows', () => {
  const summary = summarizeProfiles([
    {
      name: 'default',
      title: 'Default',
      sliceCount: 1,
      createdAt: null,
      updatedAt: null,
      updatedBy: null,
      subscriberCount: 3,
      impactedSubscribers: 3,
      activeSubscribers: 2,
      suspendedSubscribers: 1,
      restrictedSubscribers: 0,
    },
    {
      name: 'unused',
      title: 'Unused',
      sliceCount: 0,
      createdAt: null,
      updatedAt: null,
      updatedBy: null,
      subscriberCount: 0,
      impactedSubscribers: 0,
      activeSubscribers: 0,
      suspendedSubscribers: 0,
      restrictedSubscribers: 0,
    },
  ]);

  assert.deepEqual(summary, {
    totalProfiles: 2,
    totalGovernedSubscribers: 3,
    activeSubscribers: 2,
    suspendedSubscribers: 1,
    restrictedSubscribers: 0,
    unassignedProfiles: 1,
  });
});

test('primary dashboard routes expose a bounded first-screen prefetch plan', () => {
  const expectedRoutes = [
    '/',
    '/subscribers',
    '/ocs/tariffs',
    '/ocs/contracts',
    '/ocs/balances',
    '/profile',
    '/approvals',
    '/audit-logs',
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
