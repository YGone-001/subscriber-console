#!/usr/bin/env node
/**
 * Inventory Contract Validator
 *
 * Proves:
 * - Route count = 26
 * - Inventory frontend routes = 3
 * - Inventory API registrations = 6
 * - Inventory reads = 3
 * - Inventory mutations = 3
 * - Business mutation endpoints = 29 (unchanged)
 * - Business request contracts = 31 (unchanged)
 * - Operational endpoints = 4 (unchanged)
 * - Inventory authorization = core.read / core.configure
 * - Inventory hard-delete endpoint = 0
 * - Inventory frontend security evidence:
 *   - raw fetch = 0
 *   - direct Go URLs = 0
 *   - JWT runtime = 0
 *   - auth cookie access = 0
 *   - trusted identity headers = 0
 *   - automatic mutation retries = 0
 *   - generic executor calls = 0
 */

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveGoRegistrations } from './lib/go-registrations.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const frontend = resolve(root, 'frontend');
const inventoryFeatureDir = resolve(frontend, 'src/features/inventory');

console.log('-- Inventory Contract & Security Evidence Suite --\n');

// 1. Route contract checks
const routes = JSON.parse(readFileSync(resolve(frontend, 'route-contract.json'), 'utf8'));
assert.equal(routes.length, 26, `Total route count must be exactly 26, got ${routes.length}`);

const inventoryRoutes = routes.filter((r) => r.route.startsWith('/inventory'));
assert.equal(inventoryRoutes.length, 3, `Inventory frontend route count must be 3, got ${inventoryRoutes.length}`);
const expectedInventoryRoutes = ['/inventory', '/inventory/:resourceId', '/inventory/create'];
for (const r of expectedInventoryRoutes) {
  assert.ok(inventoryRoutes.some((ir) => ir.route === r), `Missing inventory route: ${r}`);
}

// 2. Go API registrations checks
const { keys: goRegistrations, duplicates: goDuplicates } = deriveGoRegistrations(root);
assert.equal(goDuplicates.length, 0, 'Go registrations must have 0 duplicates');
assert.equal(goRegistrations.length, 90, `Go registered operations must be exactly 90, got ${goRegistrations.length}`);

const inventoryGoRoutes = goRegistrations.filter((r) => r.includes('/api/inventory'));
assert.equal(inventoryGoRoutes.length, 6, `Inventory Go registrations must be exactly 6, got ${inventoryGoRoutes.length}`);

const expectedInventoryGo = [
  'GET /api/inventory/meta',
  'GET /api/inventory/resources',
  'GET /api/inventory/resources/{resourceId}',
  'POST /api/inventory/resources',
  'PUT /api/inventory/resources/{resourceId}',
  'POST /api/inventory/resources/{resourceId}/retire',
];

for (const r of expectedInventoryGo) {
  assert.ok(inventoryGoRoutes.includes(r), `Missing expected Inventory Go route: ${r}`);
}

const inventoryReads = inventoryGoRoutes.filter((r) => r.startsWith('GET '));
const inventoryMutations = inventoryGoRoutes.filter((r) => !r.startsWith('GET '));
assert.equal(inventoryReads.length, 3, `Inventory read count must be 3, got ${inventoryReads.length}`);
assert.equal(inventoryMutations.length, 3, `Inventory mutation count must be 3, got ${inventoryMutations.length}`);

// No hard delete endpoint
const hardDeleteEndpoints = inventoryGoRoutes.filter((r) => r.startsWith('DELETE '));
assert.equal(hardDeleteEndpoints.length, 0, `Inventory hard-delete endpoint must be 0, got ${hardDeleteEndpoints.length}`);

// 3. Separate inventory contract verification
const invContract = JSON.parse(readFileSync(resolve(frontend, 'inventory-contract.json'), 'utf8'));
assert.ok(Array.isArray(invContract), 'inventory-contract.json must be an array');
assert.equal(invContract.length, 2, 'inventory-contract.json must have 2 route entries (/inventory/create, /inventory/:resourceId)');

const invOperations = invContract.flatMap((entry) => entry.operations);
assert.equal(invOperations.length, 3, `inventory-contract.json must have 3 operations, got ${invOperations.length}`);
for (const op of invOperations) {
  assert.deepEqual(
    op.authorization,
    { kind: 'permission', value: 'core.configure' },
    `Operation ${op.name} authorization must be permission: core.configure`,
  );
}

// 4. Inventory request contract verification
const invReqContract = JSON.parse(readFileSync(resolve(frontend, 'inventory-request-contract.json'), 'utf8'));
assert.ok(Array.isArray(invReqContract), 'inventory-request-contract.json must be an array');
assert.equal(invReqContract.length, 3, `inventory-request-contract.json must have 3 entries, got ${invReqContract.length}`);

// 5. Existing business & operational contracts unchanged
const businessContract = JSON.parse(readFileSync(resolve(frontend, 'mutation-contract.json'), 'utf8'));
const businessReqContract = JSON.parse(readFileSync(resolve(frontend, 'mutation-request-contract.json'), 'utf8'));
const operationalContract = JSON.parse(readFileSync(resolve(frontend, 'operational-contract.json'), 'utf8'));

const businessOps = businessContract.flatMap((entry) => entry.operations);
const businessUniqueEndpoints = new Set(businessOps.map((op) => op.request));
assert.equal(businessUniqueEndpoints.size, 29, `business mutation endpoints must remain 29, got ${businessUniqueEndpoints.size}`);
assert.equal(businessReqContract.length, 31, `business request contracts must remain 31, got ${businessReqContract.length}`);

const operationalOps = operationalContract.flatMap((entry) => entry.operations);
const operationalUniqueEndpoints = new Set(operationalOps.map((op) => op.request));
assert.equal(operationalUniqueEndpoints.size, 4, `operational endpoints must remain 4, got ${operationalUniqueEndpoints.size}`);

// 6. Security evidence in inventory feature
function walk(dir, files = []) {
  if (!existsSync(dir)) return files;
  for (const name of readdirSync(dir)) {
    const full = resolve(dir, name);
    if (statSync(full).isDirectory()) walk(full, files);
    else if (/\.(ts|tsx)$/.test(name)) files.push(full);
  }
  return files;
}

const inventoryFiles = walk(inventoryFeatureDir);
assert.ok(inventoryFiles.length >= 4, 'Inventory feature must have at least 4 source files');

let rawFetchCount = 0;
let directGoUrlCount = 0;
let jwtRuntimeCount = 0;
let authCookieCount = 0;
let trustedIdentityHeadersCount = 0;
let autoRetryCount = 0;
let genericExecutorCount = 0;

for (const f of inventoryFiles) {
  const content = readFileSync(f, 'utf8');

  // Match standalone fetch( calls (not getJson/postJson)
  const fetchMatches = content.match(/\bfetch\s*\(/g);
  if (fetchMatches) rawFetchCount += fetchMatches.length;

  // Match 127.0.0.1:18888 or localhost:18888
  const goUrlMatches = content.match(/127\.0\.0\.1:18888|localhost:18888/g);
  if (goUrlMatches) directGoUrlCount += goUrlMatches.length;

  // Match jose, jsonwebtoken
  const jwtMatches = content.match(/\b(jose|jsonwebtoken|SignJWT|jwtVerify)\b/g);
  if (jwtMatches) jwtRuntimeCount += jwtMatches.length;

  // Match cookie manipulation
  const cookieMatches = content.match(/document\.cookie|auth_token/g);
  if (cookieMatches) authCookieCount += cookieMatches.length;

  // Match identity header spoofing
  const headerMatches = content.match(/X-User|X-Role|X-Permissions/g);
  if (headerMatches) trustedIdentityHeadersCount += headerMatches.length;

  // Match automatic retry loops on mutation
  const retryMatches = content.match(/retryCount|autoRetry|maxRetries/g);
  if (retryMatches) autoRetryCount += retryMatches.length;

  // Match generic executor API concepts
  const execMatches = content.match(/\/execute|\/command|\/ssh|\/restart/g);
  if (execMatches) genericExecutorCount += execMatches.length;
}

assert.equal(rawFetchCount, 0, `inventory raw fetch calls must be 0, got ${rawFetchCount}`);
assert.equal(directGoUrlCount, 0, `inventory direct Go URLs must be 0, got ${directGoUrlCount}`);
assert.equal(jwtRuntimeCount, 0, `inventory JWT runtime must be 0, got ${jwtRuntimeCount}`);
assert.equal(authCookieCount, 0, `inventory auth cookie access must be 0, got ${authCookieCount}`);
assert.equal(trustedIdentityHeadersCount, 0, `inventory trusted identity headers must be 0, got ${trustedIdentityHeadersCount}`);
assert.equal(autoRetryCount, 0, `inventory automatic mutation retries must be 0, got ${autoRetryCount}`);
assert.equal(genericExecutorCount, 0, `inventory generic executor calls must be 0, got ${genericExecutorCount}`);

console.log('route_count=26');
console.log('inventory_frontend_routes=3');
console.log('inventory_api_registrations=6');
console.log('inventory_reads=3');
console.log('inventory_mutations=3');
console.log('business_mutation_endpoints=29');
console.log('business_request_contracts=31');
console.log('operational_endpoints=4');
console.log('inventory_hard_delete_endpoint=0');
console.log('inventory_raw_fetch=0');
console.log('inventory_direct_go_urls=0');
console.log('inventory_jwt_runtime=0');
console.log('inventory_auth_cookie_access=0');
console.log('inventory_trusted_identity_headers=0');
console.log('inventory_automatic_mutation_retries=0');
console.log('inventory_generic_executor_calls=0');
console.log('inventory_contract_result=PASS');
