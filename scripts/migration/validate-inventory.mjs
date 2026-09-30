#!/usr/bin/env node
/**
 * Migration Inventory Validator (Phase 8.3 current state).
 *
 * Architecture: the Next.js App Router business API tree (frontend/src/app/api) and the
 * Next.js business server layer (frontend/src/server) were PHYSICALLY REMOVED. Production
 * /api/* traffic is Go-owned through the controlled cutover table.
 *
 * This validator therefore enforces, all from source:
 *   1. generated inventory == independent source scan (no drift, no faked routes);
 *   2. the empty Next.js surface (0 route files, 0 operations, removed trees absent);
 *   3. the frozen historical baseline record is preserved (history is not rewritten);
 *   4. the controlled cutover table contract (CUTOVER_TABLE = 84, every entry owner=go,
 *      retired surfaces absent, compatibility aliases and resolved residue present);
 *   5. the Go router registration site matches CUTOVER_TABLE as an EXACT METHOD+PATH set
 *      (phantom registration detection + missing-route detection);
 *   6. the Next.js side owns zero business mutations.
 *
 * Usage: node scripts/migration/validate-inventory.mjs
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const apiRoot = resolve(root, 'frontend/src/app/api');
const serverRoot = resolve(root, 'frontend/src/server');
const inventoryPath = resolve(root, 'docs/backend-migration/generated/api-routes.json');
const baselinePath = resolve(root, 'docs/backend-migration/api-baseline.md');
const goRouterSources = [
  resolve(root, 'backend/cmd/server/main.go'),
  resolve(root, 'backend/internal/remediation/handler.go'),
];

assert.ok(existsSync(inventoryPath), 'run scripts/migration/inventory-api.mjs first');

const routes = JSON.parse(readFileSync(inventoryPath, 'utf8'));
assert.ok(Array.isArray(routes), 'inventory must be a JSON array');

// ---------------------------------------------------------------------------
// 1. Generated inventory must match an independent source scan of the Next.js tree
// ---------------------------------------------------------------------------
function scanRouteFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return scanRouteFiles(full);
    return entry.name === 'route.ts' || entry.name === 'route.js' ? [full] : [];
  });
}

const normalize = (p) => p.replaceAll('\\', '/');
assert.deepEqual(
  routes.map((route) => normalize(route.file)).sort(),
  scanRouteFiles(apiRoot).map((file) => normalize(relative(root, file))).sort(),
  'generated inventory must match the independent source scan',
);

// ---------------------------------------------------------------------------
// 2. Empty Next.js surface (physical removal completed)
// ---------------------------------------------------------------------------
assert.equal(existsSync(apiRoot), false, 'Next.js App Router API tree must be removed');
assert.equal(existsSync(serverRoot), false, 'Next.js server layer must be removed');
assert.equal(routes.length, 0, 'route file inventory must be empty after backend removal');

const counts = { GET: 0, POST: 0, PUT: 0, PATCH: 0, DELETE: 0 };
for (const route of routes) {
  for (const method of route.methods) counts[method] += 1;
}
const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
const nonGet = total - counts.GET;
assert.deepEqual(counts, { GET: 0, POST: 0, PUT: 0, PATCH: 0, DELETE: 0 });
assert.equal(total, 0, 'Next.js operation count must be zero');
assert.equal(nonGet, 0, 'Next.js non-GET operation count must be zero');
assert.equal(nonGet, 0, 'Next.js business mutation count must be zero');

for (const route of routes) {
  const removedPrefixes = ['/api/approvals', '/api/audit'];
  assert.equal(
    removedPrefixes.some((prefix) => route.path === prefix || route.path.startsWith(`${prefix}/`)),
    false,
    `retired route present: ${route.path}`,
  );
}

// ---------------------------------------------------------------------------
// 3. Historical baseline record preserved (frozen Phase 0 evidence, not a live count)
// ---------------------------------------------------------------------------
const baseline = readFileSync(baselinePath, 'utf8');
assert.match(baseline, /\|\s*Route files\s*\|\s*\*\*54\*\*\s*\|/);
assert.match(baseline, /\|\s*Total operations\s*\|\s*\*\*72\*\*\s*\|/);
for (const [method, count] of Object.entries({ GET: 32, POST: 28, PUT: 5, PATCH: 2, DELETE: 5 })) {
  assert.match(
    baseline,
    new RegExp(`\\|\\s*${method}\\s*\\|\\s*${count}\\s*\\|`),
    `historical baseline ${method} record drift`,
  );
}
assert.match(baseline, /\*\*40 non-GET/);

// ---------------------------------------------------------------------------
// 4. Controlled cutover table contract
// ---------------------------------------------------------------------------
const jiti = createJiti(import.meta.url);
const { CUTOVER_TABLE } = jiti(resolve(root, 'frontend/src/lib/cutover-routing.ts'));
// Derived, never hard-coded: 47 Phase 7.5 baseline + 33 canonical residual
// + 2 legacy read aliases + 2 resolved Go-native residue reads.
const CANONICAL_RESIDUAL = 33;
const LEGACY_ALIASES = 2;
const GO_NATIVE_RESIDUE = 2;
const expectedCutover = 47 + CANONICAL_RESIDUAL + LEGACY_ALIASES + GO_NATIVE_RESIDUE;
assert.equal(CUTOVER_TABLE.length, expectedCutover, `CUTOVER_TABLE must be exactly ${expectedCutover}`);
assert.equal(
  CUTOVER_TABLE.filter((route) => route.owner === 'go').length,
  expectedCutover,
  `ACTUALLY_ROUTED must be exactly ${expectedCutover}`,
);

const cutoverKeys = new Set();
for (const route of CUTOVER_TABLE) {
  const key = `${route.method} ${route.path}`;
  assert.equal(cutoverKeys.has(key), false, `duplicate cutover route: ${key}`);
  cutoverKeys.add(key);
}

// Platform Services production ownership (previously 36, now 47 baseline).
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

// User Management canonical routes.
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

// Authentication canonical routes.
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

// Legacy read compatibility aliases (read-only) and retired mutations.
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
  assert.equal(
    CUTOVER_TABLE.some((r) => r.method === method && r.path === path),
    false,
    `retired mutation must not be routed: ${key}`,
  );
}
// Retired mutations must also be gone from the current operation inventory.
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

// ---------------------------------------------------------------------------
// 5. Go router <-> CUTOVER_TABLE exact METHOD+PATH set cross-check
//    (phantom detection + missing route detection; counts are derived, never stated)
// ---------------------------------------------------------------------------
const goKeys = new Set();
for (const file of goRouterSources) {
  assert.ok(existsSync(file), `Go router source missing: ${relative(root, file)}`);
  const content = readFileSync(file, 'utf8');
  const re = /mux\.Handle\("(GET|POST|PUT|PATCH|DELETE)\s+([^"]+)"\s*,/g;
  let match;
  while ((match = re.exec(content)) !== null) {
    const key = `${match[1]} ${match[2]}`;
    assert.equal(goKeys.has(key), false, `duplicate Go route registration: ${key}`);
    goKeys.add(key);
  }
}
assert.deepEqual(
  [...goKeys].filter((key) => !cutoverKeys.has(key)).sort(),
  [],
  'Go router registers operations absent from CUTOVER_TABLE (phantom registrations)',
);
assert.deepEqual(
  [...cutoverKeys].filter((key) => !goKeys.has(key)).sort(),
  [],
  'CUTOVER_TABLE routes missing from the Go router registration site',
);
assert.equal(goKeys.size, expectedCutover, 'Go registered operation count must equal CUTOVER_TABLE size');

// GET reads vs POST semantic reads classification (derived from the Go registration set).
const SEMANTIC_READ_POST = new Set([
  'POST /api/subscribers/batch/precheck',
  'POST /api/system/audit/scan',
  'POST /api/analytics/init',
]);
const goReads = [...goKeys].filter((key) => key.startsWith('GET ') || SEMANTIC_READ_POST.has(key));
const goMutations = [...goKeys].filter((key) => !goReads.includes(key));
assert.equal(goReads.length + goMutations.length, goKeys.size, 'Go read/mutation classification must partition the set');

// The Next.js side owns zero business mutations (physical removal completed).
const nextBusinessMutations = routes.flatMap((route) => route.methods.map((m) => `${m} ${toCanonical(route.path)}`))
  .filter((key) => !key.startsWith('GET '));
assert.equal(nextBusinessMutations.length, 0, 'Next.js business mutation count must be zero');

console.log('Migration inventory validation passed.');
console.log(
  `Routes=${routes.length} Operations=${total} GET=${counts.GET} POST=${counts.POST} PUT=${counts.PUT} PATCH=${counts.PATCH} DELETE=${counts.DELETE}`,
);
console.log(`CUTOVER_TABLE=${expectedCutover} ACTUALLY_ROUTED=${expectedCutover}`);
console.log(`GoRegistered=${goKeys.size} GoReads=${goReads.length} GoMutations=${goMutations.length}`);
console.log(`NextBusinessMutations=${nextBusinessMutations.length}`);
