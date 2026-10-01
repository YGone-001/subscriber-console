#!/usr/bin/env node
/**
 * API Route Inventory Validator.
 *
 * Architecture: the Next.js App Router business API tree (frontend/src/app/api) and the
 * Next.js business server layer (frontend/src/server) do not exist. Route ownership is no
 * longer resolved inside Next.js: Nginx owns /api and /api/* path selection at the edge and
 * forwards straight to the Go backend, whose router registration site is the authoritative
 * API surface.
 *
 * This validator therefore enforces, all from source:
 *   1. generated inventory == independent source scan (no drift, no faked routes);
 *   2. the empty Next.js surface (0 route files, 0 operations, removed trees absent);
 *   3. the frozen historical baseline record is preserved (history is not rewritten);
 *   4. the Go router registration site is the authoritative METHOD+PATH set
 *      (no duplicates, retired mutation surfaces absent, exact count derived);
 *   5. the edge deployment contract: /api and /api/* -> Go upstream, everything else ->
 *      Next.js UI upstream;
 *   6. the retired route-owner routing artifact must not reappear in production source.
 *
 * Usage: node scripts/migration/inventory-api.mjs && node scripts/migration/validate-inventory.mjs
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyGoRegistrations, deriveGoRegistrations, toInventoryPath } from '../lib/go-registrations.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const apiRoot = resolve(root, 'frontend/src/app/api');
const serverRoot = resolve(root, 'frontend/src/server');
const inventoryPath = resolve(root, 'docs/backend-migration/generated/api-routes.json');
const baselinePath = resolve(root, 'docs/backend-migration/api-baseline.md');
const nginxConfPath = resolve(root, 'deploy/nginx/xcloud.conf');
const retiredRoutingArtifact = resolve(root, 'frontend/src/lib/cutover-routing.ts');

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
// 3. Historical baseline record preserved (frozen historical evidence, not a live count)
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
// 4. Go router registration site is the authoritative API surface
// ---------------------------------------------------------------------------
const { keys: goKeys, duplicates } = deriveGoRegistrations(root);
assert.deepEqual(duplicates, [], 'Go router must not register a METHOD+PATH twice');
assert.equal(goKeys.length, 84, `Go registered operation count must be 84, found ${goKeys.length}`);

// Retired mutation surfaces must not be re-registered by Go.
const retiredAuthMutations = [
  'POST /api/auth/users',
  'PUT /api/auth/users/{username}',
  'PATCH /api/auth/users/{username}',
  'DELETE /api/auth/users/{username}',
  'PUT /api/users/{username}',
  'DELETE /api/users/{username}',
];
for (const key of retiredAuthMutations) {
  assert.equal(goKeys.includes(key), false, `retired mutation must not be registered: ${key}`);
}

// The read-only legacy compatibility aliases remain.
for (const key of ['GET /api/auth/users', 'GET /api/auth/users/{username}']) {
  assert.ok(goKeys.includes(key), `missing legacy read alias: ${key}`);
}

// Retired mutations must also be gone from the current operation inventory.
const inventoryKeys = new Set(routes.flatMap((route) => route.methods.map((m) => `${m} ${toInventoryPath(route.path)}`)));
for (const key of retiredAuthMutations) {
  assert.equal(inventoryKeys.has(key), false, `retired mutation still exported: ${key}`);
}

const { reads: goReads, mutations: goMutations } = classifyGoRegistrations(goKeys);
assert.equal(goReads.length + goMutations.length, goKeys.length, 'Go read/mutation classification must partition the set');

// The Next.js side owns zero business mutations (physical removal completed).
const nextBusinessMutations = routes.flatMap((route) => route.methods.map((m) => `${m} ${toInventoryPath(route.path)}`))
  .filter((key) => !key.startsWith('GET '));
assert.equal(nextBusinessMutations.length, 0, 'Next.js business mutation count must be zero');

// ---------------------------------------------------------------------------
// 5. Edge deployment contract: Nginx splits /api/* to Go and everything else to Next.js
// ---------------------------------------------------------------------------
assert.ok(existsSync(nginxConfPath), 'deploy/nginx/xcloud.conf must exist');
const nginxConf = readFileSync(nginxConfPath, 'utf8');

const upstreamOf = (name) => {
  const block = nginxConf.match(new RegExp(`upstream\\s+${name}\\s*\\{([^}]*)\\}`));
  assert.ok(block, `nginx upstream ${name} must be declared`);
  return block[1];
};
assert.match(upstreamOf('xcloud_go'), /127\.0\.0\.1:18888/, 'Go upstream must be the API service');
assert.match(upstreamOf('xcloud_next'), /127\.0\.0\.1:13333/, 'Next upstream must be the UI service');

const proxyTargetOf = (match) => {
  const location = nginxConf.match(match);
  assert.ok(location, `nginx location block not found for ${match}`);
  const proxyPass = location[0].match(/proxy_pass\s+http:\/\/(\w+)\s*;/);
  assert.ok(proxyPass, `nginx location block for ${match} must declare proxy_pass`);
  return proxyPass[1];
};
assert.equal(proxyTargetOf(/location\s+=\s+\/api\s*\{[\s\S]*?\n\s{4}\}/), 'xcloud_go', 'exact /api must route to Go');
assert.equal(proxyTargetOf(/location\s+\/api\/\s*\{[\s\S]*?\n\s{4}\}/), 'xcloud_go', '/api/* must route to Go');
assert.equal(proxyTargetOf(/location\s+\/\s*\{[\s\S]*?\n\s{4}\}/), 'xcloud_next', 'all non-API paths must route to Next.js UI');

// ---------------------------------------------------------------------------
// 6. The retired migration routing artifact must not survive in production source
// ---------------------------------------------------------------------------
assert.equal(existsSync(retiredRoutingArtifact), false, 'cutover-routing.ts must be retired');

console.log('Migration inventory validation passed.');
console.log(
  `Routes=${routes.length} Operations=${total} GET=${counts.GET} POST=${counts.POST} PUT=${counts.PUT} PATCH=${counts.PATCH} DELETE=${counts.DELETE}`,
);
console.log(`GoRegistered=${goKeys.length} GoReads=${goReads.length} GoMutations=${goMutations.length}`);
console.log(`EdgeApiOwner=nginx->go EdgeUiOwner=nginx->next`);
console.log(`NextBusinessMutations=${nextBusinessMutations.length}`);
