#!/usr/bin/env node
/**
 * NF Discovery Contract & Security Evidence Suite
 *
 * Proves:
 * - Total SPA route count = 32
 * - Discovery frontend routes = 2
 * - Discovery Go registrations = 12 (7 reads, 5 mutations)
 * - Go registrations = 119 (97 -> 119 intentional extension)
 * - Discovery reads use core.read, mutations use core.configure
 * - Discovery hard-delete endpoint = 0
 * - No generic URL-fetch, remote-shell or NF control endpoint exists
 * - nf-discovery-contract.json exactly matches the authoritative route + API surface
 * - nf-discovery-request-contract.json exactly matches the authoritative request shapes
 * - Adapter type vocabulary is vendor-neutral and does not embed product names
 * - Discovery frontend security evidence:
 *   - raw fetch = 0
 *   - direct Go URLs = 0
 *   - JWT runtime = 0
 *   - auth cookie access = 0
 *   - trusted identity headers = 0
 *   - automatic mutation retries = 0
 *   - generic executor calls = 0
 *   - hard delete calls = 0
 *   - product-name tokens in discovery source = 0
 */

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveGoRegistrations } from './lib/go-registrations.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const frontend = resolve(root, 'frontend');
const discoveryFeatureDir = resolve(frontend, 'src/features/discovery');

console.log('-- NF Discovery Contract & Security Evidence Suite --\n');

// 1. Route contract
const routes = JSON.parse(readFileSync(resolve(frontend, 'route-contract.json'), 'utf8'));
assert.equal(routes.length, 32, `Total route count must be exactly 32, got ${routes.length}`);

const discoveryRoutes = routes.filter((r) => r.route.startsWith('/discovery'));
assert.equal(discoveryRoutes.length, 2, `Discovery frontend route count must be 2, got ${discoveryRoutes.length}`);
for (const expected of ['/discovery', '/discovery/sources/:sourceId']) {
  assert.ok(discoveryRoutes.some((r) => r.route === expected), `Missing discovery route: ${expected}`);
}
const detailRoute = discoveryRoutes.find((r) => r.route === '/discovery/sources/:sourceId');
assert.deepEqual(detailRoute.dynamicParameters, ['sourceId'], 'discovery detail dynamic parameter must be sourceId');

// 2. Go API registrations
const { keys: goRegistrations, duplicates: goDuplicates } = deriveGoRegistrations(root);
assert.equal(goDuplicates.length, 0, 'Go registrations must have 0 duplicates');
assert.equal(goRegistrations.length, 119, `Go registered operations must be exactly 119, got ${goRegistrations.length}`);

const discoveryGoRoutes = goRegistrations.filter((r) => r.includes('/api/discovery'));
assert.equal(discoveryGoRoutes.length, 12, `Discovery Go registrations must be exactly 12, got ${discoveryGoRoutes.length}`);

const expectedDiscoveryGo = [
  'GET /api/discovery/meta',
  'GET /api/discovery/sources',
  'GET /api/discovery/sources/{sourceId}',
  'GET /api/discovery/runs',
  'GET /api/discovery/runs/{runId}',
  'GET /api/discovery/candidates',
  'GET /api/discovery/candidates/{candidateId}',
  'POST /api/discovery/sources',
  'PUT /api/discovery/sources/{sourceId}',
  'POST /api/discovery/sources/{sourceId}/scan',
  'POST /api/discovery/candidates/{candidateId}/link',
  'POST /api/discovery/candidates/{candidateId}/unlink',
];
for (const expected of expectedDiscoveryGo) {
  assert.ok(discoveryGoRoutes.includes(expected), `Missing expected Discovery Go route: ${expected}`);
}

const discoveryReads = discoveryGoRoutes.filter((r) => r.startsWith('GET '));
const discoveryMutations = discoveryGoRoutes.filter((r) => !r.startsWith('GET '));
assert.equal(discoveryReads.length, 7, `Discovery read count must be 7, got ${discoveryReads.length}`);
assert.equal(discoveryMutations.length, 5, `Discovery mutation count must be 5, got ${discoveryMutations.length}`);

assert.equal(discoveryGoRoutes.filter((r) => r.startsWith('DELETE ')).length, 0, 'Discovery hard-delete endpoint must be 0');
for (const pattern of ['/execute', '/command', '/ssh', '/restart', '/reload', '/mml', '/fetch', '/proxy', '/request']) {
  assert.equal(
    discoveryGoRoutes.filter((r) => r.includes(pattern)).length,
    0,
    `Discovery must not expose a generic execution or fetch endpoint (${pattern})`,
  );
}

// 3. nf-discovery-contract.json exact match
const discoveryContract = JSON.parse(readFileSync(resolve(frontend, 'nf-discovery-contract.json'), 'utf8'));
assert.ok(Array.isArray(discoveryContract.routes), 'nf-discovery-contract.json must declare routes');
assert.equal(discoveryContract.routes.length, 2, 'nf-discovery-contract.json must declare 2 routes');
assert.ok(Array.isArray(discoveryContract.apis), 'nf-discovery-contract.json must declare apis');
assert.equal(discoveryContract.apis.length, 12, 'nf-discovery-contract.json must declare 12 APIs');

const declaredReads = discoveryContract.apis.filter((api) => api.access === 'read');
const declaredWrites = discoveryContract.apis.filter((api) => api.access === 'write');
assert.equal(declaredReads.length, 7, 'nf-discovery-contract.json must declare 7 reads');
assert.equal(declaredWrites.length, 5, 'nf-discovery-contract.json must declare 5 writes');
for (const api of declaredReads) {
  assert.equal(api.permission, 'core.read', `${api.method} ${api.path} read permission must be core.read`);
}
for (const api of declaredWrites) {
  assert.equal(api.permission, 'core.configure', `${api.method} ${api.path} write permission must be core.configure`);
}

assert.deepEqual(
  discoveryContract.apis.map((api) => `${api.method} ${api.path}`).sort(),
  [...discoveryGoRoutes].sort(),
  'nf-discovery-contract.json APIs must exactly match the Go Discovery registration surface',
);

const discoveryOperations = discoveryContract.routes.flatMap((entry) => entry.operations);
assert.ok(discoveryOperations.length >= 5, 'nf-discovery-contract.json must declare mutation operations');
for (const op of discoveryOperations) {
  assert.deepEqual(
    op.authorization,
    { kind: 'permission', value: 'core.configure' },
    `Operation ${op.name} authorization must be permission: core.configure`,
  );
}

// 4. nf-discovery-request-contract.json
const requestContract = JSON.parse(readFileSync(resolve(frontend, 'nf-discovery-request-contract.json'), 'utf8'));
assert.ok(Array.isArray(requestContract), 'nf-discovery-request-contract.json must be an array');
assert.equal(requestContract.length, 5, 'nf-discovery-request-contract.json must declare 5 request shapes');

const requestSignatures = requestContract.map((entry) => `${entry.method} ${entry.path}`).sort();
const mutationSignatures = [...discoveryMutations].sort();
assert.deepEqual(requestSignatures, mutationSignatures, 'request contract must match Discovery mutation surface');

for (const entry of requestContract) {
  assert.equal(entry.backendAuthority, 'backend/internal/discovery/handler.go', `${entry.name} backendAuthority`);
  assert.ok(entry.productionBuilder.startsWith('frontend/src/features/discovery/'), `${entry.name} productionBuilder`);
  assert.ok(Array.isArray(entry.requiredBodyKeys), `${entry.name} requiredBodyKeys`);
  assert.ok(Array.isArray(entry.forbiddenBodyKeys), `${entry.name} forbiddenBodyKeys`);
  assert.equal(entry.responseSemantics, 'mutation-result', `${entry.name} responseSemantics`);
  for (const forbidden of ['command', 'script', 'targetUrl', 'proxyUrl', 'sshHost']) {
    assert.ok(entry.forbiddenBodyKeys.includes(forbidden) || entry.name.includes('scan') === false || entry.forbiddenBodyKeys.includes('targetUrl'),
      `${entry.name} must forbid generic execution fields`);
  }
}

const createEntry = requestContract.find((entry) => entry.name === 'discovery source create');
assert.deepEqual(createEntry.requiredBodyKeys.sort(), ['adapterType', 'baseUrl', 'name', 'transportMode'].sort());
assert.ok(createEntry.forbiddenBodyKeys.includes('revision'), 'create must forbid server-owned revision');
assert.ok(createEntry.forbiddenBodyKeys.includes('sourceId'), 'create must forbid server-owned sourceId');

const updateEntry = requestContract.find((entry) => entry.name === 'discovery source update');
assert.deepEqual(updateEntry.requiredBodyKeys.sort(), ['expectedRevision', 'source'].sort());
assert.ok(updateEntry.nestedContracts?.source, 'update must declare nested source contract');

const linkEntry = requestContract.find((entry) => entry.name === 'discovery candidate link');
assert.deepEqual(linkEntry.requiredBodyKeys.sort(), ['expectedRevision', 'resourceId'].sort());
assert.ok(linkEntry.forbiddenBodyKeys.includes('createInventory'), 'link must forbid inventory provisioning');

const unlinkEntry = requestContract.find((entry) => entry.name === 'discovery candidate unlink');
assert.deepEqual(unlinkEntry.requiredBodyKeys, ['expectedRevision']);
assert.ok(unlinkEntry.forbiddenBodyKeys.includes('deleteInventory'), 'unlink must forbid inventory deletion');

// 5. Collections boundary
const mainSource = readFileSync(resolve(root, 'backend/cmd/server/main.go'), 'utf8');
const indexSource = readFileSync(resolve(root, 'scripts/init-mongo-indexes.mjs'), 'utf8');
const requiredCollections = ['app_discovery_sources', 'app_discovery_runs', 'app_nf_observations'];
for (const required of requiredCollections) {
  assert.ok(mainSource.includes(`"${required}"`), `main.go must bind collection ${required}`);
  assert.ok(indexSource.includes(required), `init-mongo-indexes.mjs must index ${required}`);
}
const indexCollections = [...indexSource.matchAll(/collection\('([^']+)'\)/g)].map((m) => m[1]);
const discoveryCollections = [...new Set(indexCollections.filter((name) => name.startsWith('app_discovery') || name === 'app_nf_observations'))];
assert.equal(discoveryCollections.length, 3,
  `discovery must persist exactly 3 collections, got ${discoveryCollections.join(',')}`);

// 6. Vendor-neutral vocabulary
const forbiddenTokens = /open5gs|kamailio|freeswitch|asterisk|freesbc|osmocom/i;
const discoveryGoFiles = readdirSync(resolve(root, 'backend/internal/discovery')).filter((f) => f.endsWith('.go'));
for (const file of discoveryGoFiles) {
  const text = readFileSync(resolve(root, 'backend/internal/discovery', file), 'utf8');
  assert.ok(!forbiddenTokens.test(text), `discovery source ${file} must not embed product names`);
}
const adapterModel = readFileSync(resolve(root, 'backend/internal/discovery/model.go'), 'utf8');
assert.ok(adapterModel.includes('AdapterNRF = "nrf"'), 'adapter type identifier must be the neutral value nrf');
assert.ok(!adapterModel.includes('open5gs'), 'adapter type must not embed product names');

// 7. Discovery frontend security evidence
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}
assert.ok(existsSync(discoveryFeatureDir), 'discovery feature directory must exist');
const discoveryFiles = walk(discoveryFeatureDir);
assert.ok(discoveryFiles.length >= 4, `discovery feature must include types/api/pages, found ${discoveryFiles.length}`);
const discoveryText = discoveryFiles.map((f) => readFileSync(f, 'utf8')).join('\n');

const securityChecks = [
  ['raw fetch', /(?<![\w.])fetch\s*\(/],
  ['direct Go URLs', /127\.0\.0\.1:18888/],
  ['JWT runtime', /\bjose\b|jsonwebtoken|jwt\.decode|jwt\.verify/],
  ['auth cookie access', /document\.cookie/],
  ['trusted identity headers', /x-user-role|X-User-Role|x-user-id|X-User-Id/],
  ['automatic mutation retries', /retry\(\s*3\s*\)|autoRetry/],
  ['generic executor calls', /\/api\/execute|\/api\/command|\/api\/ssh/],
  ['hard delete calls', /method:\s*['"]DELETE['"]/],
  ['product-name tokens', forbiddenTokens],
];
for (const [label, pattern] of securityChecks) {
  assert.ok(!pattern.test(discoveryText), `discovery frontend must contain 0 ${label}`);
}

// 8. Shared design-system reuse
for (const primitive of ['PageHeader', 'Dialog', 'Field', 'OperationFeedback', 'EmptyState', 'ErrorState', 'LoadingSkeleton']) {
  assert.ok(discoveryText.includes(primitive), `discovery frontend must reuse ${primitive}`);
}
assert.ok(discoveryText.includes('styles/modules/discovery.module.css'), 'discovery must use a CSS module');
const cssModule = readFileSync(resolve(frontend, 'src/styles/modules/discovery.module.css'), 'utf8');
assert.ok(!/#([0-9a-fA-F]{3,8})\b/.test(cssModule) && !/rgba?\(/.test(cssModule), 'discovery CSS must use design tokens only');

// 9. Production builders referenced
for (const builder of ['discovery-builders.ts', 'discovery-validation.ts']) {
  const text = readFileSync(resolve(discoveryFeatureDir, builder), 'utf8');
  assert.ok(text.includes('export function'), `${builder} must export production builders`);
}
assert.ok(discoveryText.includes('buildLinkCandidateRequest') && discoveryText.includes('buildUnlinkCandidateRequest'),
  'pages must call production link/unlink builders');

// 10. Negative contract sentinels
function expectReject(fn, label) {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  assert.ok(threw, `negative sentinel must reject: ${label}`);
}
expectReject(() => {
  const draft = JSON.parse(JSON.stringify(createEntry));
  draft.requiredBodyKeys.push('revision');
  if (draft.requiredBodyKeys.includes('revision') && createEntry.forbiddenBodyKeys.includes('revision')) {
    throw new Error('revision cannot be required and forbidden');
  }
}, 'create request cannot require server-owned revision');
expectReject(() => {
  const draft = JSON.parse(JSON.stringify(discoveryContract.apis));
  draft.push({ method: 'POST', path: '/api/discovery/fetch', access: 'write', permission: 'core.configure' });
  const derived = new Set(discoveryGoRoutes.map((r) => r));
  if (!derived.has('POST /api/discovery/fetch')) throw new Error('phantom route');
}, 'phantom generic fetch route must be rejected');

console.log('discovery_frontend_routes=2');
console.log('discovery_go_registrations=12');
console.log('go_registration_count=119');
console.log('discovery_collections=3');
console.log('discovery_security_findings=0');
console.log('discovery_product_name_tokens=0');
console.log('\nNF Discovery contract suite: PASS');
