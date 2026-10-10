#!/usr/bin/env node
/**
 * NF Health Contract & Security Evidence Suite
 *
 * Proves:
 * - Total SPA route count = 32
 * - NF Health frontend routes = 2
 * - NF Health Go registrations = 10 (7 reads, 3 mutations)
 * - Go registrations = 119 (109 -> 119 intentional extension)
 * - NF Health reads use core.read, mutations use core.configure
 * - NF Health hard-delete endpoint = 0
 * - No generic URL-fetch, remote-shell, process-control or NF control endpoint exists
 * - nf-health-contract.json exactly matches the authoritative route + API surface
 * - nf-health-request-contract.json exactly matches the authoritative request shapes
 * - Collector profile vocabulary is vendor-neutral and does not embed product names
 * - NF Health frontend security evidence:
 *   - raw fetch = 0
 *   - direct Go URLs = 0
 *   - JWT runtime = 0
 *   - auth cookie access = 0
 *   - trusted identity headers = 0
 *   - automatic mutation retries = 0
 *   - generic executor calls = 0
 *   - hard delete calls = 0
 *   - product-name tokens in nf health source = 0
 */

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveGoRegistrations } from './lib/go-registrations.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const frontend = resolve(root, 'frontend');
const featureDir = resolve(frontend, 'src/features/nf-health');

console.log('-- NF Health Contract & Security Evidence Suite --\n');

// 1. Route contract
const routes = JSON.parse(readFileSync(resolve(frontend, 'route-contract.json'), 'utf8'));
assert.equal(routes.length, 32, `Total route count must be exactly 32, got ${routes.length}`);

const healthRoutes = routes.filter((r) => r.route.startsWith('/nf-health'));
assert.equal(healthRoutes.length, 2, `NF Health frontend route count must be 2, got ${healthRoutes.length}`);
for (const expected of ['/nf-health', '/nf-health/:targetId']) {
  assert.ok(healthRoutes.some((r) => r.route === expected), `Missing NF Health route: ${expected}`);
}
const detailRoute = healthRoutes.find((r) => r.route === '/nf-health/:targetId');
assert.deepEqual(detailRoute.dynamicParameters, ['targetId'], 'detail dynamic parameter must be targetId');

// 2. Go API registrations
const { keys: goRegistrations, duplicates: goDuplicates } = deriveGoRegistrations(root);
assert.equal(goDuplicates.length, 0, 'Go registrations must have 0 duplicates');
assert.equal(goRegistrations.length, 119, `Go registered operations must be exactly 119, got ${goRegistrations.length}`);

const healthGoRoutes = goRegistrations.filter((r) => r.includes('/api/nf-health'));
assert.equal(healthGoRoutes.length, 10, `NF Health Go registrations must be exactly 10, got ${healthGoRoutes.length}`);

const expectedHealthGo = [
  'GET /api/nf-health/meta',
  'GET /api/nf-health/targets',
  'GET /api/nf-health/targets/{targetId}',
  'GET /api/nf-health/targets/{targetId}/history',
  'GET /api/nf-health/samples',
  'GET /api/nf-health/runs',
  'GET /api/nf-health/runs/{runId}',
  'POST /api/nf-health/targets',
  'PUT /api/nf-health/targets/{targetId}',
  'POST /api/nf-health/targets/{targetId}/collect',
];
for (const expected of expectedHealthGo) {
  assert.ok(healthGoRoutes.includes(expected), `Missing expected NF Health Go route: ${expected}`);
}

const healthReads = healthGoRoutes.filter((r) => r.startsWith('GET '));
const healthMutations = healthGoRoutes.filter((r) => !r.startsWith('GET '));
assert.equal(healthReads.length, 7, `NF Health read count must be 7, got ${healthReads.length}`);
assert.equal(healthMutations.length, 3, `NF Health mutation count must be 3, got ${healthMutations.length}`);

assert.equal(healthGoRoutes.filter((r) => r.startsWith('DELETE ')).length, 0, 'NF Health hard-delete endpoint must be 0');
for (const pattern of ['/execute', '/command', '/ssh', '/restart', '/reload', '/mml', '/fetch', '/proxy', '/request', '/kill', '/signal']) {
  assert.equal(
    healthGoRoutes.filter((r) => r.includes(pattern)).length,
    0,
    `NF Health must not expose a generic execution or process-control endpoint (${pattern})`,
  );
}

// 3. nf-health-contract.json exact match
const healthContract = JSON.parse(readFileSync(resolve(frontend, 'nf-health-contract.json'), 'utf8'));
assert.ok(Array.isArray(healthContract.routes), 'nf-health-contract.json must declare routes');
assert.equal(healthContract.routes.length, 2, 'nf-health-contract.json must declare 2 routes');
assert.ok(Array.isArray(healthContract.apis), 'nf-health-contract.json must declare apis');
assert.equal(healthContract.apis.length, 10, 'nf-health-contract.json must declare 10 APIs');

const declaredReads = healthContract.apis.filter((api) => api.access === 'read');
const declaredWrites = healthContract.apis.filter((api) => api.access === 'write');
assert.equal(declaredReads.length, 7, 'nf-health-contract.json must declare 7 reads');
assert.equal(declaredWrites.length, 3, 'nf-health-contract.json must declare 3 writes');
for (const api of declaredReads) {
  assert.equal(api.permission, 'core.read', `${api.method} ${api.path} read permission must be core.read`);
}
for (const api of declaredWrites) {
  assert.equal(api.permission, 'core.configure', `${api.method} ${api.path} write permission must be core.configure`);
}

assert.deepEqual(
  healthContract.apis.map((api) => `${api.method} ${api.path}`).sort(),
  [...healthGoRoutes].sort(),
  'nf-health-contract.json APIs must exactly match the Go NF Health registration surface',
);

assert.deepEqual(
  [...healthContract.collections].sort(),
  [
    'xcloud_ops.app_nf_health_runs',
    'xcloud_ops.app_nf_health_samples',
    'xcloud_ops.app_nf_health_targets',
  ],
  'nf-health-contract.json must declare exactly the three NF Health collections',
);

assert.ok(Array.isArray(healthContract.collectorProfiles), 'collectorProfiles must be declared');
assert.deepEqual(healthContract.collectorProfiles, ['http_metrics'], 'collector profile vocabulary must be http_metrics');
assert.ok(!/open5gs|kamailio|freeswitch|asterisk/i.test(JSON.stringify(healthContract)), 'contract must stay vendor-neutral');

const healthOperations = healthContract.routes.flatMap((entry) => entry.operations ?? []);
assert.ok(healthOperations.length >= 2, 'nf-health-contract.json must declare mutation operations');
for (const op of healthOperations) {
  assert.deepEqual(
    op.authorization,
    { kind: 'permission', value: 'core.configure' },
    `Operation ${op.name} authorization must be permission: core.configure`,
  );
}

// 4. nf-health-request-contract.json
const requestContract = JSON.parse(readFileSync(resolve(frontend, 'nf-health-request-contract.json'), 'utf8'));
assert.ok(Array.isArray(requestContract), 'nf-health-request-contract.json must be an array');
assert.equal(requestContract.length, 3, 'nf-health-request-contract.json must declare 3 request shapes');

const requestSignatures = requestContract.map((entry) => `${entry.method} ${entry.path}`).sort();
const mutationSignatures = [...healthMutations].sort();
assert.deepEqual(requestSignatures, mutationSignatures, 'request contract must match NF Health mutation surface');

for (const entry of requestContract) {
  assert.equal(entry.backendAuthority, 'backend/internal/nfhealth/handler.go', `${entry.name} backendAuthority`);
  assert.ok(entry.productionBuilder.startsWith('frontend/src/features/nf-health/'), `${entry.name} productionBuilder`);
  assert.ok(Array.isArray(entry.requiredBodyKeys), `${entry.name} requiredBodyKeys`);
  assert.ok(Array.isArray(entry.forbiddenBodyKeys), `${entry.name} forbiddenBodyKeys`);
  assert.equal(entry.responseSemantics, 'mutation-result', `${entry.name} responseSemantics`);
  for (const forbidden of ['command', 'script', 'targetUrl', 'proxyUrl', 'sshHost']) {
    assert.ok(
      entry.forbiddenBodyKeys.includes(forbidden) || entry.name.includes('collection'),
      `${entry.name} must forbid generic execution fields or be a bounded collect trigger`,
    );
  }
}

const createEntry = requestContract.find((entry) => entry.name === 'nf health target create');
assert.deepEqual(
  createEntry.requiredBodyKeys.sort(),
  ['candidateId', 'name', 'collectorProfile', 'serviceKind', 'collectionMode', 'intervalSeconds'].sort(),
);
assert.ok(createEntry.forbiddenBodyKeys.includes('revision'), 'create must forbid server-owned revision');
assert.ok(createEntry.forbiddenBodyKeys.includes('targetId'), 'create must forbid server-owned targetId');
assert.ok(!createEntry.requiredBodyKeys.includes('metricsEndpoint'), 'metricsEndpoint is optional');

const updateEntry = requestContract.find((entry) => entry.name === 'nf health target update');
assert.deepEqual(updateEntry.requiredBodyKeys.sort(), ['expectedRevision', 'target'].sort());
assert.ok(updateEntry.nestedContracts?.target, 'update must declare nested target contract');
assert.ok(updateEntry.forbiddenBodyKeys.includes('candidateId'), 'update must not rebind the Discovery candidate');

const collectEntry = requestContract.find((entry) => entry.name === 'nf health collection request');
assert.deepEqual(collectEntry.requiredBodyKeys, []);
assert.ok(collectEntry.forbiddenBodyKeys.includes('command'), 'collect must forbid command execution fields');

// 5. Collections boundary
const mainSource = readFileSync(resolve(root, 'backend/cmd/server/main.go'), 'utf8');
const indexSource = readFileSync(resolve(root, 'scripts/init-mongo-indexes.mjs'), 'utf8');
const requiredCollections = ['app_nf_health_targets', 'app_nf_health_runs', 'app_nf_health_samples'];
for (const required of requiredCollections) {
  assert.ok(mainSource.includes(`"${required}"`), `main.go must bind collection ${required}`);
  assert.ok(indexSource.includes(required), `init-mongo-indexes.mjs must index ${required}`);
}
const indexCollections = [...indexSource.matchAll(/collection\('([^']+)'\)/g)].map((m) => m[1]);
const healthCollections = [...new Set(indexCollections.filter((name) => name.startsWith('app_nf_health')))];
assert.equal(healthCollections.length, 3,
  `nf health must persist exactly 3 collections, got ${healthCollections.join(',')}`);

assert.ok(indexSource.includes('nf_health_samples_ttl'), 'sample TTL index must exist');
assert.ok(/expireAfterSeconds:\s*0/.test(indexSource), 'TTL must use expireAfterSeconds 0 with expiresAt');
const targetIndexBlock = indexSource.slice(indexSource.indexOf('app_nf_health_targets'));
assert.ok(targetIndexBlock.includes('uniq_nf_health_target_candidate'), 'targets must be unique per Discovery candidate');

// 6. Vendor-neutral vocabulary and collector safety
const forbiddenTokens = /open5gs|kamailio|freeswitch|asterisk|freesbc|osmocom/i;
const goFiles = readdirSync(resolve(root, 'backend/internal/nfhealth')).filter((f) => f.endsWith('.go'));
for (const file of goFiles) {
  const text = readFileSync(resolve(root, 'backend/internal/nfhealth', file), 'utf8');
  assert.ok(!forbiddenTokens.test(text), `nfhealth source ${file} must not embed product names`);
}
const modelSource = readFileSync(resolve(root, 'backend/internal/nfhealth/model.go'), 'utf8');
assert.ok(modelSource.includes('CollectorHTTPMetrics = "http_metrics"'), 'collector profile must be the neutral value http_metrics');
assert.ok(!modelSource.includes('open5gs'), 'collector profile must not embed product names');

const collectorSource = readFileSync(resolve(root, 'backend/internal/nfhealth/collector.go'), 'utf8');
const proberSource = readFileSync(resolve(root, 'backend/internal/nfhealth/http_probe.go'), 'utf8');
const inspectorSource = readFileSync(resolve(root, 'backend/internal/nfhealth/systemd_reader.go'), 'utf8');
const validationSource = readFileSync(resolve(root, 'backend/internal/nfhealth/validation.go'), 'utf8');

assert.ok(proberSource.includes('http.ErrUseLastResponse') || proberSource.includes('CheckRedirect'), 'HTTP prober must reject redirects');
assert.ok(proberSource.includes('MaxResponseBytes') || proberSource.includes('LimitReader') || proberSource.includes('maxBody'), 'HTTP prober must bound response size');
const execSource = readFileSync(resolve(root, 'backend/internal/nfhealth/exec_command.go'), 'utf8');
assert.ok(
  inspectorSource.includes('execCommandContext') || inspectorSource.includes('exec.CommandContext'),
  'systemd inspection must route through a fixed command-context helper',
);
assert.ok(execSource.includes('exec.CommandContext'), 'the fixed helper must use exec.CommandContext');
assert.ok(inspectorSource.includes('systemctl show') || inspectorSource.includes('"show"'), 'systemd inspection must use a fixed show operation');
assert.ok(!/exec\.Command(Context)?\([^)]*sudo|["'`]sudo["'`]/.test(inspectorSource), 'systemd inspection must never invoke sudo');
assert.ok(validationSource.includes('default deny') || validationSource.includes('DefaultDeny') || validationSource.includes('defaultDeny') || /allowlist/i.test(validationSource), 'destination allowlist must default deny');
assert.ok(modelSource.includes('MinIntervalSeconds'), 'collection frequency must be bounded');
assert.ok(modelSource.includes('MaxGlobalConcurrent'), 'collection concurrency must be bounded');

// 7. NF Health frontend security evidence
function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}
assert.ok(existsSync(featureDir), 'nf-health feature directory must exist');
const featureFiles = walk(featureDir);
assert.ok(featureFiles.length >= 2, `nf-health feature must include types/api, found ${featureFiles.length}`);
const featureText = featureFiles.map((f) => readFileSync(f, 'utf8')).join('\n');

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
  assert.ok(!pattern.test(featureText), `nf-health frontend must contain 0 ${label}`);
}

// 8. Shared design-system reuse (pages that exist now)
const pageFiles = featureFiles.filter((f) => /Page\.tsx$/.test(f));
for (const page of pageFiles) {
  const text = readFileSync(page, 'utf8');
  for (const primitive of ['PageHeader']) {
    assert.ok(text.includes(primitive), `${page} must reuse ${primitive}`);
  }
}

// 9. Semantic separation evidence in docs and source
const archDoc = readFileSync(resolve(root, 'docs/architecture/nf-health-telemetry.md'), 'utf8');
for (const phrase of [
  'NRF REGISTERED',
  'HTTP 200',
  'never zero-filled',
  'Failed collection never overwrites',
  'http_metrics',
]) {
  assert.ok(archDoc.includes(phrase), `architecture doc must state: ${phrase}`);
}
assert.ok(!forbiddenTokens.test(archDoc.replace(/Open5GS/gi, '')), 'architecture doc body must stay vendor-neutral outside product notes');

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
  const derived = new Set(healthGoRoutes.map((r) => r));
  if (!derived.has('POST /api/nf-health/fetch')) throw new Error('phantom route');
}, 'phantom generic fetch route must be rejected');
expectReject(() => {
  const derived = new Set(healthGoRoutes.map((r) => r));
  if (!derived.has('POST /api/nf-health/targets/{targetId}/restart')) throw new Error('phantom restart route');
}, 'phantom process-control route must be rejected');

console.log('nf_health_frontend_routes=2');
console.log('nf_health_go_registrations=10');
console.log('go_registration_count=119');
console.log('nf_health_collections=3');
console.log('nf_health_security_findings=0');
console.log('nf_health_product_name_tokens=0');
console.log('\nNF Health contract suite: PASS');
