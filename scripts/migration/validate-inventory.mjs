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
assert.deepEqual(counts, { GET: 32, POST: 28, PUT: 5, PATCH: 2, DELETE: 5 });
assert.equal(total, 72);
assert.equal(nonGet, 40);

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
assert.match(baseline, /\|\s*Total operations\s*\|\s*\*\*72\*\*\s*\|/);
assert.match(baseline, /\*\*40 non-GET/);

const jiti = createJiti(import.meta.url);
const { CUTOVER_TABLE } = jiti(resolve(root, 'frontend/src/lib/cutover-routing.ts'));
// Derived, never hard-coded: 47 Phase 7.5 baseline + 33 canonical residual
// + 2 legacy read aliases + 2 resolved Go-native residue reads.
const CANONICAL_RESIDUAL = 33;
const LEGACY_ALIASES = 2;
const GO_NATIVE_RESIDUE = 2;
const expectedCutover = 47 + CANONICAL_RESIDUAL + LEGACY_ALIASES + GO_NATIVE_RESIDUE;
assert.equal(CUTOVER_TABLE.length, expectedCutover, `CUTOVER_TABLE must be exactly ${expectedCutover}`);
assert.equal(CUTOVER_TABLE.filter((route) => route.owner === 'go').length, expectedCutover, `ACTUALLY_ROUTED must be exactly ${expectedCutover}`);

// Verify no duplicate METHOD+PATH entries
const seen = new Set();
for (const route of CUTOVER_TABLE) {
  const key = `${route.method} ${route.path}`;
  assert.equal(seen.has(key), false, `duplicate cutover route: ${key}`);
  seen.add(key);
}

// Platform Services production ownership delta (previously 36, now 47).
// The 11 additions must be exactly the frozen Phase 7 Platform Services
// operations, one METHOD+PATH each, and nothing else.
const platformServicesRoutes = [
  'GET /api/alerts',
  'POST /api/alerts/acknowledge',
  'POST /api/alerts/workflow',
  'GET /api/notifications/stream',
  'GET /api/system/health',
  'GET /api/system/mongo/health',
  'GET /api/system/audit/status',
  'POST /api/system/audit/scan',
  'POST /api/system/audit/heal',
  'POST /api/system/audit/batch-heal',
  'POST /api/analytics/init',
];
for (const key of platformServicesRoutes) {
  const [method, path] = key.split(' ');
  const entry = CUTOVER_TABLE.find((r) => r.method === method && r.path === path);
  assert.ok(entry, `missing Platform Services cutover route: ${key}`);
  assert.equal(entry.owner, 'go', `cutover route ${key} must be owner=go`);
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

// Verify Authentication canonical routes are present and owned by go
const authRoutes = [
  'POST /api/auth/login',
  'POST /api/auth/logout',
  'GET /api/auth/me',
  'GET /api/auth/permissions',
];
for (const key of authRoutes) {
  const [method, path] = key.split(' ');
  const entry = CUTOVER_TABLE.find((r) => r.method === method && r.path === path);
  assert.ok(entry, `missing cutover route: ${key}`);
  assert.equal(entry.owner, 'go', `cutover route ${key} must be owner=go`);
}

// Verify the two legacy read compatibility aliases moved to Go and that no
// mutation method was reintroduced under /api/auth/users (Phase 8.2 retirement).
const legacyAliasRoutes = ['GET /api/auth/users', 'GET /api/auth/users/{username}'];
for (const key of legacyAliasRoutes) {
  const [method, path] = key.split(' ');
  const entry = CUTOVER_TABLE.find((r) => r.method === method && r.path === path);
  assert.ok(entry, `missing legacy alias cutover route: ${key}`);
  assert.equal(entry.owner, 'go', `legacy alias ${key} must be owner=go`);
}
const retiredAuthMutations = [
  'POST /api/auth/users',
  'PUT /api/auth/users/{username}',
  'PATCH /api/auth/users/{username}',
  'DELETE /api/auth/users/{username}',
  'PUT /api/users/{username}',
  'DELETE /api/users/{username}',
];
for (const key of retiredAuthMutations) {
  const [method, path] = key.split(' ');
  assert.equal(CUTOVER_TABLE.some((r) => r.method === method && r.path === path), false, `retired mutation must not be routed: ${key}`);
}
// Retired mutations must also be gone from the current operation inventory.
// Inventory paths use the `:param` Next.js form, so canonicalize before comparing.
const toCanonical = (p) => p.replace(/:(\w+)/g, '{$1}');
const inventoryKeys = new Set(routes.flatMap((route) => route.methods.map((m) => `${m} ${toCanonical(route.path)}`)));
for (const key of retiredAuthMutations) {
  assert.equal(inventoryKeys.has(key), false, `retired mutation still exported: ${key}`);
}

// Both Phase 8.0 Go-native unrouted reads were resolved by production routing.
for (const key of ['GET /api/tariff-plans/{planId}/operations', 'GET /api/ocs/balances/{imsi}']) {
  const [method, path] = key.split(' ');
  const entry = CUTOVER_TABLE.find((r) => r.method === method && r.path === path);
  assert.ok(entry, `missing resolved Go-native residue route: ${key}`);
  assert.equal(entry.owner, 'go', `resolved residue ${key} must be owner=go`);
}

console.log('Migration inventory validation passed.');
console.log(`Routes=${routes.length} Operations=${total} GET=${counts.GET} POST=${counts.POST} PUT=${counts.PUT} PATCH=${counts.PATCH} DELETE=${counts.DELETE}`);
console.log(`CUTOVER_TABLE=${expectedCutover} ACTUALLY_ROUTED=${expectedCutover}`);
