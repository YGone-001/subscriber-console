import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

type RouteEntry = {
  sourceRoute: string;
  targetRoute: string;
  dynamicParameters: string[];
  status: string;
};

const routes = JSON.parse(readFileSync(resolve(import.meta.dirname, '../migration-routes.json'), 'utf8')) as RouteEntry[];

test('foundation route inventory remains explicit and non-business', () => {
  const foundation = routes.filter((route) => route.status === 'foundation');
  assert.deepEqual(foundation.map((route) => route.sourceRoute).sort(), ['/', '/login']);
  assert.equal(routes.filter((route) => route.status === 'migrated').length, 0);
});
