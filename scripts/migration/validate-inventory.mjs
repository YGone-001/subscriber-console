#!/usr/bin/env node

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const inventoryPath = resolve(root, 'docs/backend-migration/generated/api-routes.json');
const baselinePath = resolve(root, 'docs/backend-migration/api-baseline.md');

assert.ok(existsSync(inventoryPath), 'run scripts/migration/inventory-api.mjs first');

const routes = JSON.parse(readFileSync(inventoryPath, 'utf8'));
const counts = { GET: 0, POST: 0, PUT: 0, PATCH: 0, DELETE: 0 };
for (const route of routes) {
  for (const method of route.methods) counts[method] += 1;
}
const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
const nonGet = total - counts.GET;

assert.equal(routes.length, 54, 'route file inventory drift');
assert.deepEqual(counts, { GET: 32, POST: 29, PUT: 7, PATCH: 3, DELETE: 7 });
assert.equal(total, 78);
assert.equal(nonGet, 46);

const removedPrefixes = ['/api/approvals', '/api/audit'];
for (const route of routes) {
  assert.equal(removedPrefixes.some((prefix) => route.path === prefix || route.path.startsWith(`${prefix}/`)), false, `retired route present: ${route.path}`);
}
assert.ok(routes.some((route) => route.path === '/api/system/audit/status'), 'system integrity audit status must remain');
assert.ok(routes.some((route) => route.path === '/api/system/audit/heal'), 'system integrity heal must remain');

const baseline = readFileSync(baselinePath, 'utf8');
for (const [method, count] of Object.entries(counts)) {
  assert.match(baseline, new RegExp(`\\|\\s*${method}\\s*\\|\\s*${count}\\s*\\|`), `${method} baseline count drift`);
}
assert.match(baseline, /\|\s*Total operations\s*\|\s*\*\*78\*\*\s*\|/);
assert.match(baseline, /\*\*46 non-GET/);

const jiti = createJiti(import.meta.url);
const { CUTOVER_TABLE } = jiti(resolve(root, 'frontend/src/lib/cutover-routing.ts'));
assert.equal(CUTOVER_TABLE.length, 32, 'CUTOVER_TABLE must be exactly 32');
assert.equal(CUTOVER_TABLE.filter((route) => route.owner === 'go').length, 32, 'ACTUALLY_ROUTED must be exactly 32');

// Verify no duplicate METHOD+PATH entries
const seen = new Set();
for (const route of CUTOVER_TABLE) {
  const key = `${route.method} ${route.path}`;
  assert.equal(seen.has(key), false, `duplicate cutover route: ${key}`);
  seen.add(key);
}

// Verify User Management canonical routes are present and owned by go
const userMgmtRoutes = [
  'GET /api/users',
  'POST /api/users',
  'GET /api/users/{username}',
  'PATCH /api/users/{username}',
  'POST /api/users/{username}/disable',
  'POST /api/users/{username}/password-reset',
];
for (const key of userMgmtRoutes) {
  const [method, path] = key.split(' ');
  const entry = CUTOVER_TABLE.find((r) => r.method === method && r.path === path);
  assert.ok(entry, `missing cutover route: ${key}`);
  assert.equal(entry.owner, 'go', `cutover route ${key} must be owner=go`);
}

console.log('Migration inventory validation passed.');
console.log(`Routes=${routes.length} Operations=${total} GET=${counts.GET} POST=${counts.POST} PUT=${counts.PUT} PATCH=${counts.PATCH} DELETE=${counts.DELETE}`);
console.log('CUTOVER_TABLE=32 ACTUALLY_ROUTED=32');
