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

assert.equal(routes.length, 52, 'route file inventory drift');
assert.deepEqual(counts, { GET: 32, POST: 27, PUT: 7, PATCH: 3, DELETE: 7 });
assert.equal(total, 76);
assert.equal(nonGet, 44);

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
assert.match(baseline, /\|\s*Total operations\s*\|\s*\*\*76\*\*\s*\|/);
assert.match(baseline, /\*\*44 non-GET/);

const jiti = createJiti(import.meta.url);
const { CUTOVER_TABLE } = jiti(resolve(root, 'frontend/src/lib/cutover-routing.ts'));
assert.equal(CUTOVER_TABLE.length, 26, 'CUTOVER_TABLE must remain exactly 26');
assert.equal(CUTOVER_TABLE.filter((route) => route.owner === 'go').length, 26, 'ACTUALLY_ROUTED must remain exactly 26');

console.log('Migration inventory validation passed.');
console.log(`Routes=${routes.length} Operations=${total} GET=${counts.GET} POST=${counts.POST} PUT=${counts.PUT} PATCH=${counts.PATCH} DELETE=${counts.DELETE}`);
console.log('CUTOVER_TABLE=26 ACTUALLY_ROUTED=26');
