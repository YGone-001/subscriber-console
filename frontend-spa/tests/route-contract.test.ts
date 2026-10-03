import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { COMPATIBILITY_REDIRECTS } from '../src/router/redirects';

type RouteEntry = {
  sourceRoute: string;
  targetRoute: string;
  dynamicParameters: string[];
  status: string;
};

const routes = JSON.parse(readFileSync(resolve(import.meta.dirname, '../migration-routes.json'), 'utf8')) as RouteEntry[];

test('foundation route inventory remains explicit and non-business', () => {
  const foundation = routes.filter((route) => route.status === 'foundation');
  assert.deepEqual(foundation.map((route) => route.sourceRoute), ['/login']);
  assert.equal(routes.filter((route) => route.status === 'read-parity').length, 11);
  assert.equal(routes.filter((route) => route.status === 'migrated').length, 10);
});

test('compatibility aliases use the established replacement targets', () => {
  assert.deepEqual(COMPATIBILITY_REDIRECTS, {
    '/ocs': '/ocs/tariffs', '/ocs/dashboard': '/ocs/tariffs', '/ocs/sessions': '/ocs/tariffs', '/ocs/usage': '/ocs/tariffs',
    '/ocs/subscribers': '/ocs/contracts', '/rating': '/ocs/tariffs', '/rating/plans': '/ocs/tariffs', '/rating/rules': '/ocs/tariffs', '/roles': '/users',
  });
});
