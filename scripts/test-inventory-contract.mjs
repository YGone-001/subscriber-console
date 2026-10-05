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
 * - Inventory request contract schema & semantic validation
 * - Negative contract sentinels in memory throw assertions as required
 * - UI rules verified (q query param, create/edit exclude retired, kind read-only)
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

function validateInventoryRequestContract(contractList) {
  assert.ok(Array.isArray(contractList), 'contract must be an array');
  assert.equal(contractList.length, 3, 'inventory request contract must have 3 entries');

  const requiredFields = [
    'name',
    'method',
    'path',
    'queryMode',
    'backendAuthority',
    'productionReference',
    'requiredBodyKeys',
    'optionalBodyKeys',
    'forbiddenBodyKeys',
    'responseSemantics',
  ];

  for (const entry of contractList) {
    for (const f of requiredFields) {
      assert.ok(f in entry, `Entry ${entry.name || 'unknown'} missing field: ${f}`);
    }
    assert.ok(['POST', 'PUT', 'GET', 'DELETE'].includes(entry.method), `Invalid method ${entry.method}`);
    assert.ok(entry.path.startsWith('/api/inventory/'), `Invalid path ${entry.path}`);
    assert.equal(entry.queryMode, 'none', `queryMode must be 'none'`);
    assert.equal(entry.backendAuthority, 'backend/internal/inventory/handler.go', `Invalid backendAuthority`);
    assert.ok(
      entry.productionReference.startsWith('frontend/src/features/inventory/'),
      `Invalid productionReference: ${entry.productionReference}`,
    );
    assert.equal(entry.responseSemantics, 'mutation-result', `responseSemantics must be 'mutation-result'`);

    // Forbidden keys must contain server-owned fields
    const serverOwned = ['resourceId', 'schemaVersion', 'source', 'revision', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy'];
    for (const k of serverOwned) {
      assert.ok(entry.forbiddenBodyKeys.includes(k), `Entry ${entry.name} must forbid server-owned field ${k}`);
      assert.ok(!entry.requiredBodyKeys.includes(k), `Entry ${entry.name} must not require server-owned field ${k}`);
      assert.ok(!entry.optionalBodyKeys.includes(k), `Entry ${entry.name} must not allow optional server-owned field ${k}`);
    }
  }

  // Check create entry
  const createEntry = contractList.find((e) => e.method === 'POST' && e.path === '/api/inventory/resources');
  assert.ok(createEntry, 'Missing create contract entry');
  assert.ok(createEntry.requiredBodyKeys.includes('kind'), 'create must require kind');
  assert.ok(createEntry.requiredBodyKeys.includes('name'), 'create must require name');
  assert.ok(createEntry.requiredBodyKeys.includes('domain'), 'create must require domain');

  // Check update entry
  const updateEntry = contractList.find((e) => e.method === 'PUT' && e.path === '/api/inventory/resources/{resourceId}');
  assert.ok(updateEntry, 'Missing update contract entry');
  assert.ok(updateEntry.requiredBodyKeys.includes('expectedRevision'), 'update must require expectedRevision');
  assert.ok(updateEntry.requiredBodyKeys.includes('resource'), 'update must require resource');
  assert.ok(updateEntry.nestedContracts?.resource, 'Update contract must have nestedContracts.resource');
  const resNested = updateEntry.nestedContracts.resource;
  assert.ok(resNested.requiredKeys.includes('kind'), 'nested resource must require kind');
  assert.ok(resNested.requiredKeys.includes('name'), 'nested resource must require name');
  assert.ok(resNested.requiredKeys.includes('domain'), 'nested resource must require domain');
  assert.ok(resNested.requiredKeys.includes('lifecycleState'), 'nested resource must require lifecycleState');
  assert.ok(!resNested.allowedKeys.includes('source'), 'nested resource must not allow source');
  assert.ok(!resNested.allowedKeys.includes('revision'), 'nested resource must not allow revision');

  // Check retire entry
  const retireEntry = contractList.find((e) => e.method === 'POST' && e.path === '/api/inventory/resources/{resourceId}/retire');
  assert.ok(retireEntry, 'Missing retire contract entry');
  assert.ok(retireEntry.requiredBodyKeys.includes('expectedRevision'), 'retire must require expectedRevision');
  assert.ok(retireEntry.requiredBodyKeys.includes('reason'), 'retire must require reason');
  assert.deepEqual(retireEntry.optionalBodyKeys, [], 'Retire entry must have empty optionalBodyKeys');
}

// Validate production request contract
validateInventoryRequestContract(invReqContract);

// 4.1 Negative Contract Sentinels in Memory
// Negative 1: update missing kind
assert.throws(() => {
  const bad = JSON.parse(JSON.stringify(invReqContract));
  const u = bad.find((e) => e.method === 'PUT');
  u.nestedContracts.resource.requiredKeys = u.nestedContracts.resource.requiredKeys.filter((k) => k !== 'kind');
  validateInventoryRequestContract(bad);
}, /nested resource must require kind/);

// Negative 2: update allowing source
assert.throws(() => {
  const bad = JSON.parse(JSON.stringify(invReqContract));
  const u = bad.find((e) => e.method === 'PUT');
  u.nestedContracts.resource.allowedKeys.push('source');
  validateInventoryRequestContract(bad);
}, /nested resource must not allow source/);

// Negative 3: update allowing revision
assert.throws(() => {
  const bad = JSON.parse(JSON.stringify(invReqContract));
  const u = bad.find((e) => e.method === 'PUT');
  u.nestedContracts.resource.allowedKeys.push('revision');
  validateInventoryRequestContract(bad);
}, /nested resource must not allow revision/);

// Negative 4: create allowing schemaVersion
assert.throws(() => {
  const bad = JSON.parse(JSON.stringify(invReqContract));
  const c = bad.find((e) => e.method === 'POST' && e.path === '/api/inventory/resources');
  c.optionalBodyKeys.push('schemaVersion');
  validateInventoryRequestContract(bad);
}, /must not allow optional server-owned field schemaVersion/);

// Negative 5: retire allowing invented optional key
assert.throws(() => {
  const bad = JSON.parse(JSON.stringify(invReqContract));
  const r = bad.find((e) => e.method === 'POST' && e.path.endsWith('/retire'));
  r.optionalBodyKeys.push('invented');
  validateInventoryRequestContract(bad);
}, /Retire entry must have empty optionalBodyKeys/);

// Negative 6: wrong backendAuthority
assert.throws(() => {
  const bad = JSON.parse(JSON.stringify(invReqContract));
  bad[0].backendAuthority = 'backend/internal/other/handler.go';
  validateInventoryRequestContract(bad);
}, /Invalid backendAuthority/);

// Negative 7: wrong productionReference
assert.throws(() => {
  const bad = JSON.parse(JSON.stringify(invReqContract));
  bad[0].productionReference = 'src/wrong/path.tsx';
  validateInventoryRequestContract(bad);
}, /Invalid productionReference/);

// Negative 8: wrong authorization requirement
assert.throws(() => {
  const badOps = JSON.parse(JSON.stringify(invOperations));
  badOps[0].authorization = { kind: 'permission', value: 'core.read' };
  for (const op of badOps) {
    assert.deepEqual(op.authorization, { kind: 'permission', value: 'core.configure' });
  }
});

// Negative 9: wrong HTTP method
assert.throws(() => {
  const bad = JSON.parse(JSON.stringify(invReqContract));
  bad[0].method = 'PATCH';
  validateInventoryRequestContract(bad);
}, /Invalid method/);

// Negative 10: wrong path
assert.throws(() => {
  const bad = JSON.parse(JSON.stringify(invReqContract));
  bad[0].path = '/api/subscribers/test';
  validateInventoryRequestContract(bad);
}, /Invalid path/);

// 4.2 UI Code Invariant Assertions
const typesSrc = readFileSync(resolve(inventoryFeatureDir, 'inventory-types.ts'), 'utf8');
assert.ok(typesSrc.includes('q?: string;'), 'ResourceListQueryParams must declare q?: string');
assert.ok(!typesSrc.includes('search?: string;'), 'ResourceListQueryParams must not declare search?: string');

const apiSrc = readFileSync(resolve(inventoryFeatureDir, 'inventory-api.ts'), 'utf8');
assert.ok(apiSrc.includes('params.q'), 'inventory-api.ts must map params.q');
assert.ok(!apiSrc.includes('params.search'), 'inventory-api.ts must not map params.search');

const createSrc = readFileSync(resolve(inventoryFeatureDir, 'InventoryCreatePage.tsx'), 'utf8');
assert.ok(
  createSrc.includes(".filter((s) => s !== 'retired')"),
  'InventoryCreatePage must filter out retired from lifecycle select',
);

const detailSrc = readFileSync(resolve(inventoryFeatureDir, 'InventoryDetailPage.tsx'), 'utf8');
assert.ok(
  detailSrc.includes(".filter((s) => s !== 'retired')"),
  'InventoryDetailPage must filter out retired from edit lifecycle select',
);
assert.ok(
  detailSrc.includes('value={editKind}') && detailSrc.includes('readOnly'),
  'InventoryDetailPage must render editKind as readOnly',
);

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
console.log('inventory_contract_sentinels_verified=10');
console.log('inventory_ui_invariants_verified=true');
console.log('inventory_raw_fetch=0');
console.log('inventory_direct_go_urls=0');
console.log('inventory_jwt_runtime=0');
console.log('inventory_auth_cookie_access=0');
console.log('inventory_trusted_identity_headers=0');
console.log('inventory_automatic_mutation_retries=0');
console.log('inventory_generic_executor_calls=0');
console.log('inventory_contract_result=PASS');
