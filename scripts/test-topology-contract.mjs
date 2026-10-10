#!/usr/bin/env node
/**
 * Topology Contract & Security Evidence Suite
 *
 * Proves:
 * - Route count = 28 (26 -> 28 intentional Stage 2 transition)
 * - Topology frontend routes = 2
 * - Topology Go registrations = 7 (4 reads, 3 mutations)
 * - Go registrations = 119 (97 -> 119 intentional extension)
 * - Topology reads use core.read, mutations use core.configure
 * - Topology hard-delete endpoint = 0
 * - No generic command execution endpoint exists
 * - topology-contract.json exactly matches the authoritative route + API surface
 * - topology-request-contract.json exactly matches the authoritative request shapes
 * - Negative contract sentinels reject drift in memory
 * - Topology frontend security evidence:
 *   - raw fetch = 0
 *   - direct Go URLs = 0
 *   - JWT runtime = 0
 *   - auth cookie access = 0
 *   - trusted identity headers = 0
 *   - automatic mutation retries = 0
 *   - generic executor calls = 0
 *   - hard delete calls = 0
 * - Production request builders are referenced by production code
 */

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveGoRegistrations } from './lib/go-registrations.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const frontend = resolve(root, 'frontend');
const topologyFeatureDir = resolve(frontend, 'src/features/topology');

console.log('-- Topology Contract & Security Evidence Suite --\n');

// 1. Route contract
const routes = JSON.parse(readFileSync(resolve(frontend, 'route-contract.json'), 'utf8'));
assert.equal(routes.length, 32, `Total route count must be exactly 32, got ${routes.length}`);

const topologyRoutes = routes.filter((r) => r.route.startsWith('/topology'));
assert.equal(topologyRoutes.length, 2, `Topology frontend route count must be 2, got ${topologyRoutes.length}`);
for (const expected of ['/topology', '/topology/:resourceId']) {
  assert.ok(topologyRoutes.some((r) => r.route === expected), `Missing topology route: ${expected}`);
}

// 2. Go API registrations
const { keys: goRegistrations, duplicates: goDuplicates } = deriveGoRegistrations(root);
assert.equal(goDuplicates.length, 0, 'Go registrations must have 0 duplicates');
assert.equal(goRegistrations.length, 119, `Go registered operations must be exactly 119, got ${goRegistrations.length}`);

const topologyGoRoutes = goRegistrations.filter((r) => r.includes('/api/topology'));
assert.equal(topologyGoRoutes.length, 7, `Topology Go registrations must be exactly 7, got ${topologyGoRoutes.length}`);

const expectedTopologyGo = [
  'GET /api/topology/meta',
  'GET /api/topology/edges',
  'GET /api/topology/edges/{edgeId}',
  'GET /api/topology/resources/{resourceId}/neighbors',
  'POST /api/topology/edges',
  'PUT /api/topology/edges/{edgeId}',
  'POST /api/topology/edges/{edgeId}/retire',
];
for (const expected of expectedTopologyGo) {
  assert.ok(topologyGoRoutes.includes(expected), `Missing expected Topology Go route: ${expected}`);
}

const topologyReads = topologyGoRoutes.filter((r) => r.startsWith('GET '));
const topologyMutations = topologyGoRoutes.filter((r) => !r.startsWith('GET '));
assert.equal(topologyReads.length, 4, `Topology read count must be 4, got ${topologyReads.length}`);
assert.equal(topologyMutations.length, 3, `Topology mutation count must be 3, got ${topologyMutations.length}`);

// No hard delete and no generic command execution endpoint anywhere in topology
assert.equal(topologyGoRoutes.filter((r) => r.startsWith('DELETE ')).length, 0, 'Topology hard-delete endpoint must be 0');
for (const pattern of ['/execute', '/command', '/ssh', '/restart', '/reload', '/mml']) {
  assert.equal(
    topologyGoRoutes.filter((r) => r.includes(pattern)).length,
    0,
    `Topology must not expose a generic command endpoint (${pattern})`,
  );
}

// 3. topology-contract.json exact match
const topologyContract = JSON.parse(readFileSync(resolve(frontend, 'topology-contract.json'), 'utf8'));
assert.ok(Array.isArray(topologyContract.routes), 'topology-contract.json must declare routes');
assert.equal(topologyContract.routes.length, 2, 'topology-contract.json must declare 2 routes');
assert.ok(Array.isArray(topologyContract.apis), 'topology-contract.json must declare apis');
assert.equal(topologyContract.apis.length, 7, 'topology-contract.json must declare 7 APIs');

const declaredReads = topologyContract.apis.filter((api) => api.access === 'read');
const declaredWrites = topologyContract.apis.filter((api) => api.access === 'write');
assert.equal(declaredReads.length, 4, 'topology-contract.json must declare 4 reads');
assert.equal(declaredWrites.length, 3, 'topology-contract.json must declare 3 writes');
for (const api of declaredReads) {
  assert.equal(api.permission, 'core.read', `${api.method} ${api.path} read permission must be core.read`);
}
for (const api of declaredWrites) {
  assert.equal(api.permission, 'core.configure', `${api.method} ${api.path} write permission must be core.configure`);
}

// The declared API surface must be exactly the Go registration surface.
assert.deepEqual(
  topologyContract.apis.map((api) => `${api.method} ${api.path}`).sort(),
  [...topologyGoRoutes].sort(),
  'topology-contract.json APIs must exactly match the Go Topology registration surface',
);

const topologyOperations = topologyContract.routes.flatMap((entry) => entry.operations);
assert.equal(topologyOperations.length, 3, 'topology-contract.json must declare 3 mutation operations');
for (const op of topologyOperations) {
  assert.deepEqual(
    op.authorization,
    { kind: 'permission', value: 'core.configure' },
    `Operation ${op.name} authorization must be permission: core.configure`,
  );
}
assert.deepEqual(
  topologyOperations.map((op) => op.request).sort(),
  ['POST /api/topology/edges', 'POST /api/topology/edges/{edgeId}/retire', 'PUT /api/topology/edges/{edgeId}'].sort(),
  'topology operations must map create, update and retire',
);

// 4. topology-request-contract.json exact match
const topologyReqContract = JSON.parse(readFileSync(resolve(frontend, 'topology-request-contract.json'), 'utf8'));

const forbiddenBodyKeys = [
  'edgeId', 'schemaVersion', 'source', 'revision', 'lifecycleState', 'createdAt', 'createdBy',
  'updatedAt', 'updatedBy', 'retiredAt', 'retiredBy', 'retireReason',
];
const exactTopologyRequestContract = [
  {
    name: 'topology edge create',
    method: 'POST',
    path: '/api/topology/edges',
    queryMode: 'none',
    backendAuthority: 'backend/internal/topology/handler.go',
    productionBuilder: 'frontend/src/features/topology/topology-builders.ts',
    productionReference: 'frontend/src/features/topology/components/TopologyEdgeForm.tsx',
    requiredBodyKeys: ['relationshipType', 'fromResourceId', 'toResourceId'],
    optionalBodyKeys: ['description', 'labels', 'attributes'],
    forbiddenBodyKeys,
    responseSemantics: 'mutation-result',
  },
  {
    name: 'topology edge update',
    method: 'PUT',
    path: '/api/topology/edges/{edgeId}',
    queryMode: 'none',
    backendAuthority: 'backend/internal/topology/handler.go',
    productionBuilder: 'frontend/src/features/topology/topology-builders.ts',
    productionReference: 'frontend/src/features/topology/components/TopologyEdgeForm.tsx',
    requiredBodyKeys: ['expectedRevision', 'edge'],
    optionalBodyKeys: [],
    forbiddenBodyKeys,
    nestedContracts: {
      edge: {
        requiredKeys: [],
        allowedKeys: ['description', 'labels', 'attributes'],
        forbiddenKeys: [...forbiddenBodyKeys, 'relationshipType', 'fromResourceId', 'toResourceId'],
      },
    },
    responseSemantics: 'mutation-result',
  },
  {
    name: 'topology edge retire',
    method: 'POST',
    path: '/api/topology/edges/{edgeId}/retire',
    queryMode: 'none',
    backendAuthority: 'backend/internal/topology/handler.go',
    productionBuilder: 'frontend/src/features/topology/topology-builders.ts',
    productionReference: 'frontend/src/features/topology/TopologyPage.tsx',
    requiredBodyKeys: ['expectedRevision', 'reason'],
    optionalBodyKeys: [],
    forbiddenBodyKeys,
    responseSemantics: 'mutation-result',
  },
];

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])]));
  }
  return value;
}

function validateTopologyRequestContract(contractList) {
  assert.ok(Array.isArray(contractList), 'contract must be an array');
  assert.equal(contractList.length, 3, 'topology request contract must have 3 entries');
  assert.deepEqual(
    normalize(contractList),
    normalize(exactTopologyRequestContract),
    'topology request contract must exactly match the authoritative operation contracts',
  );
}

validateTopologyRequestContract(topologyReqContract);

// 4.1 Negative sentinels prove no set member or operation property drifts.
function expectExactContractRejection(mutate) {
  const bad = structuredClone(topologyReqContract);
  mutate(bad);
  assert.throws(() => validateTopologyRequestContract(bad));
}

expectExactContractRejection((bad) => { bad[0].requiredBodyKeys = bad[0].requiredBodyKeys.filter((k) => k !== 'relationshipType'); });
expectExactContractRejection((bad) => { bad[0].requiredBodyKeys.push('unexpected'); });
expectExactContractRejection((bad) => { bad[0].optionalBodyKeys.push('unexpected'); });
expectExactContractRejection((bad) => { bad[0].method = 'GET'; });
expectExactContractRejection((bad) => { bad[0].path = '/api/topology/wrong'; });
expectExactContractRejection((bad) => { bad[0].queryMode = 'optional'; });
expectExactContractRejection((bad) => { bad[0].responseSemantics = 'resource'; });
expectExactContractRejection((bad) => { bad[0].productionBuilder = 'frontend/src/features/other/other-builders.ts'; });
expectExactContractRejection((bad) => { bad[1].productionReference = 'frontend/src/features/other/OtherPage.tsx'; });
expectExactContractRejection((bad) => { bad[1].nestedContracts.edge.allowedKeys.push('relationshipType'); });
expectExactContractRejection((bad) => { bad[1].nestedContracts.edge.allowedKeys = bad[1].nestedContracts.edge.allowedKeys.filter((k) => k !== 'labels'); });
expectExactContractRejection((bad) => { bad[2].requiredBodyKeys = ['expectedRevision']; });
expectExactContractRejection((bad) => { bad[0].forbiddenBodyKeys = bad[0].forbiddenBodyKeys.filter((k) => k !== 'edgeId'); });

// 4.2 Mutation identity must be immutable: relationshipType/from/to are never mutable metadata.
assert.deepEqual(
  topologyReqContract[1].nestedContracts.edge.allowedKeys,
  ['description', 'labels', 'attributes'],
  'update must permit only mutable metadata fields',
);

// 4.3 Authorization sentinel
assert.throws(() => {
  const badOps = JSON.parse(JSON.stringify(topologyOperations));
  badOps[0].authorization = { kind: 'permission', value: 'core.read' };
  for (const op of badOps) {
    assert.deepEqual(op.authorization, { kind: 'permission', value: 'core.configure' });
  }
});

// 4.4 Production builder references are real and wired into production code.
const buildersPath = resolve(frontend, 'src/features/topology/topology-builders.ts');
assert.ok(existsSync(buildersPath), 'topology-builders.ts must exist');
const buildersSrc = readFileSync(buildersPath, 'utf8');
for (const fn of ['buildCreateEdgeRequest', 'buildUpdateEdgeRequest', 'buildRetireEdgeRequest']) {
  assert.ok(buildersSrc.includes(`export function ${fn}`), `topology-builders.ts must export ${fn}`);
}
const formSrc = readFileSync(resolve(topologyFeatureDir, 'components/TopologyEdgeForm.tsx'), 'utf8');
assert.ok(formSrc.includes('buildCreateEdgeRequest'), 'create builder must be referenced by production code');
assert.ok(formSrc.includes('buildUpdateEdgeRequest'), 'update builder must be referenced by production code');
const pageSrc = readFileSync(resolve(topologyFeatureDir, 'TopologyPage.tsx'), 'utf8');
assert.ok(pageSrc.includes('retireTopologyEdge'), 'retire path must be referenced by production code');

// 5. Topology frontend must not bypass the shared request boundary.
function walk(dir, files = []) {
  if (!existsSync(dir)) return files;
  for (const name of readdirSync(dir)) {
    const full = resolve(dir, name);
    if (statSync(full).isDirectory()) walk(full, files);
    else if (/\.(ts|tsx)$/.test(name)) files.push(full);
  }
  return files;
}

const topologyFiles = walk(topologyFeatureDir);
assert.ok(topologyFiles.length >= 8, 'Topology feature must have at least 8 source files');

let rawFetchCount = 0;
let directGoUrlCount = 0;
let jwtRuntimeCount = 0;
let authCookieCount = 0;
let trustedIdentityHeadersCount = 0;
let autoRetryCount = 0;
let genericExecutorCount = 0;
let hardDeleteCount = 0;

for (const file of topologyFiles) {
  const content = readFileSync(file, 'utf8');
  rawFetchCount += (content.match(/\bfetch\s*\(/g) ?? []).length;
  directGoUrlCount += (content.match(/127\.0\.0\.1:18888|localhost:18888/g) ?? []).length;
  jwtRuntimeCount += (content.match(/\b(jose|jsonwebtoken|SignJWT|jwtVerify)\b/g) ?? []).length;
  authCookieCount += (content.match(/document\.cookie|auth_token/g) ?? []).length;
  trustedIdentityHeadersCount += (content.match(/X-User|X-Role|X-Permissions/g) ?? []).length;
  autoRetryCount += (content.match(/retryCount|autoRetry|maxRetries/g) ?? []).length;
  genericExecutorCount += (content.match(/\/execute|\/command|\/ssh|\/restart/g) ?? []).length;
  hardDeleteCount += (content.match(/deleteJson\s*\(/g) ?? []).length;
}

assert.equal(rawFetchCount, 0, `topology raw fetch calls must be 0, got ${rawFetchCount}`);
assert.equal(directGoUrlCount, 0, `topology direct Go URLs must be 0, got ${directGoUrlCount}`);
assert.equal(jwtRuntimeCount, 0, `topology JWT runtime must be 0, got ${jwtRuntimeCount}`);
assert.equal(authCookieCount, 0, `topology auth cookie access must be 0, got ${authCookieCount}`);
assert.equal(trustedIdentityHeadersCount, 0, `topology trusted identity headers must be 0, got ${trustedIdentityHeadersCount}`);
assert.equal(autoRetryCount, 0, `topology automatic mutation retries must be 0, got ${autoRetryCount}`);
assert.equal(genericExecutorCount, 0, `topology generic executor calls must be 0, got ${genericExecutorCount}`);
assert.equal(hardDeleteCount, 0, `topology hard delete calls must be 0, got ${hardDeleteCount}`);

// 6. Existing business & operational contracts unchanged.
const businessContract = JSON.parse(readFileSync(resolve(frontend, 'mutation-contract.json'), 'utf8'));
const businessReqContract = JSON.parse(readFileSync(resolve(frontend, 'mutation-request-contract.json'), 'utf8'));
const operationalContract = JSON.parse(readFileSync(resolve(frontend, 'operational-contract.json'), 'utf8'));

const businessUniqueEndpoints = new Set(businessContract.flatMap((entry) => entry.operations).map((op) => op.request));
assert.equal(businessUniqueEndpoints.size, 29, `business mutation endpoints must remain 29, got ${businessUniqueEndpoints.size}`);
assert.equal(businessReqContract.length, 31, `business request contracts must remain 31, got ${businessReqContract.length}`);
const operationalUniqueEndpoints = new Set(operationalContract.flatMap((entry) => entry.operations).map((op) => op.request));
assert.equal(operationalUniqueEndpoints.size, 4, `operational endpoints must remain 4, got ${operationalUniqueEndpoints.size}`);

// 7. Inventory authority is untouched by topology.
const inventoryContract = JSON.parse(readFileSync(resolve(frontend, 'inventory-contract.json'), 'utf8'));
assert.equal(inventoryContract.flatMap((entry) => entry.operations).length, 3, 'inventory operations must remain 3');
const inventoryGoRoutes = goRegistrations.filter((r) => r.includes('/api/inventory'));
assert.equal(inventoryGoRoutes.length, 6, `inventory Go registrations must remain 6, got ${inventoryGoRoutes.length}`);

console.log('route_count=32');
console.log('topology_frontend_routes=2');
console.log('topology_api_registrations=7');
console.log('topology_reads=4');
console.log('topology_mutations=3');
console.log('go_registration_count=119');
console.log('topology_contract_apis=7');
console.log('topology_request_contract_exact=PASS');
console.log('topology_request_contract_negative_sentinels=PASS');
console.log('topology_contract_sentinels_verified=13');
console.log('topology_immutable_identity=PASS');
console.log('topology_builder_references=PASS');
console.log('topology_hard_delete_endpoint=0');
console.log('topology_generic_command_endpoint=0');
console.log('topology_raw_fetch=0');
console.log('topology_direct_go_urls=0');
console.log('topology_jwt_runtime=0');
console.log('topology_auth_cookie_access=0');
console.log('topology_trusted_identity_headers=0');
console.log('topology_automatic_mutation_retries=0');
console.log('topology_generic_executor_calls=0');
console.log('topology_hard_delete_calls=0');
console.log('inventory_regression_contract=PASS');
console.log('topology_contract_result=PASS');
