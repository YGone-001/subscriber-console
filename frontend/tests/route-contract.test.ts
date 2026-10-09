import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { COMPATIBILITY_REDIRECTS } from '../src/router/redirects';

type RouteEntry = {
  route: string;
  dynamicParameters: string[];
};

const routes = JSON.parse(readFileSync(resolve(import.meta.dirname, '../route-contract.json'), 'utf8')) as RouteEntry[];

test('route contract inventory contains all 28 canonical routes', () => {
  assert.equal(routes.length, 28);
  const routePaths = routes.map((r) => r.route);
  assert.ok(routePaths.includes('/'));
  assert.ok(routePaths.includes('/login'));
  assert.ok(routePaths.includes('/inventory'));
  assert.ok(routePaths.includes('/inventory/:resourceId'));
  assert.ok(routePaths.includes('/inventory/create'));
  assert.ok(routePaths.includes('/topology'));
  assert.ok(routePaths.includes('/topology/:resourceId'));
  assert.ok(routePaths.includes('/users'));
  assert.ok(routePaths.includes('/users/:username'));
  assert.ok(routePaths.includes('/users/create'));
  assert.ok(routePaths.includes('/system-health'));
  for (const entry of routes) {
    for (const param of entry.dynamicParameters) {
      assert.ok(entry.route.includes(`:${param}`), `dynamic parameter ${param} missing in ${entry.route}`);
    }
  }
});

test('compatibility aliases use the established replacement targets', () => {
  assert.deepEqual(COMPATIBILITY_REDIRECTS, {
    '/ocs': '/ocs/tariffs', '/ocs/dashboard': '/ocs/tariffs', '/ocs/sessions': '/ocs/tariffs', '/ocs/usage': '/ocs/tariffs',
    '/ocs/subscribers': '/ocs/contracts', '/rating': '/ocs/tariffs', '/rating/plans': '/ocs/tariffs', '/rating/rules': '/ocs/tariffs', '/roles': '/users',
  });
});
