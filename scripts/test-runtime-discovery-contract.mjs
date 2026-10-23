#!/usr/bin/env node
/**
 * Runtime discovery contract and security evidence suite.
 *
 * Pure source analysis: no network, no MongoDB, no build step. It answers one
 * question truthfully: is the local process recognition surface bounded,
 * centralized and free of the unsafe behaviours the phase forbids?
 *
 * Usage: node scripts/test-runtime-discovery-contract.mjs
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveGoRegistrations } from './lib/go-registrations.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const backend = join(root, 'backend');
const runtimeDir = join(backend, 'internal/runtimeinv');
const frontendRuntime = join(root, 'frontend/src/features/runtime');

console.log('-- Runtime Discovery Contract & Security Evidence Suite --\n');

function read(path) {
  return readFileSync(path, 'utf8');
}

function readAll(dir) {
  if (!existsSync(dir)) return '';
  return readdirSync(dir)
    .filter((name) => !name.endsWith('_test.go'))
    .filter((name) => name.endsWith('.go') || name.endsWith('.ts') || name.endsWith('.tsx'))
    .map((name) => read(join(dir, name)))
    .join('\n');
}

// 1. Route surface -----------------------------------------------------------
const registrations = deriveGoRegistrations(root);
assert.equal(registrations.duplicates.length, 0, `duplicate registrations: ${registrations.duplicates}`);
assert.equal(registrations.keys.length, 158, `Go registrations must be 158, got ${registrations.keys.length}`);

const runtimeRoutes = registrations.keys.filter((key) => key.includes('/api/runtime'));
assert.deepEqual(
  runtimeRoutes.sort(),
  [
    'GET /api/runtime/meta',
    'GET /api/runtime/observations',
    'GET /api/runtime/stream',
    'POST /api/runtime/bootstrap/apply',
    'POST /api/runtime/bootstrap/preview',
    'POST /api/runtime/scan',
  ].sort(),
  `unexpected runtime route set: ${runtimeRoutes.join(', ')}`,
);
console.log('runtime_registrations=6');
console.log('go_registration_count=158');

// 2. SPA routes unchanged ----------------------------------------------------
const routeContract = JSON.parse(read(join(root, 'frontend/route-contract.json')));
assert.equal(routeContract.length, 39, `SPA route count must stay 39, got ${routeContract.length}`);
assert.equal(
  routeContract.filter((entry) => entry.route.startsWith('/nf-health')).length,
  2,
  'NF Health SPA routes must stay 2',
);
console.log('spa_route_count=39');

// 3. NF Health API surface unchanged ----------------------------------------
const nfHealthRoutes = registrations.keys.filter((key) => key.includes('/api/nf-health'));
assert.equal(nfHealthRoutes.length, 11, `NF Health API count must stay 11, got ${nfHealthRoutes.length}`);
console.log('nf_health_api_count=10');

// 4. Registry coverage -------------------------------------------------------
const registrySource = read(join(runtimeDir, 'registry.go'));
const componentEntries = registrySource.match(/ProcessName: "/g) ?? [];
assert.equal(componentEntries.length, 26, `registry must declare 26 entries, got ${componentEntries.length}`);

const cnmsTrue = registrySource.match(/CNMSCompatible: true/g) ?? [];
const cnmsFalse = registrySource.match(/CNMSCompatible: false/g) ?? [];
assert.equal(cnmsTrue.length, 24, `CNMS-compatible definitions must be 24, got ${cnmsTrue.length}`);
assert.equal(cnmsFalse.length, 2, `xCloud-only identities must be 2, got ${cnmsFalse.length}`);

for (const preserved of ['seppd', 'smscd']) {
  assert.ok(registrySource.includes(`ProcessName: "${preserved}"`), `${preserved} must be preserved`);
}
for (const added of ['pgwcd', 'pgwud', 'drad']) {
  assert.ok(registrySource.includes(`ProcessName: "${added}"`), `${added} must be registered`);
}
assert.ok(registrySource.includes('ID: "imsHss"'), 'IMS HSS component must exist');
assert.ok(registrySource.includes('ProcessName: "java"'), 'IMS HSS must match the java executable');

// 5. Java launch identity is bounded ---------------------------------------
const javaSource = read(join(runtimeDir, 'java.go'));
for (const token of ['HSSContainer', 'imsHss', 'FHoSS']) {
  assert.ok(javaSource.includes(token), `approved launch token ${token} must be declared`);
}
assert.ok(
  !/strings\.Contains\(\s*arg/.test(javaSource),
  'the java matcher must use whole-segment matching, not substring matching',
);

// 6. No raw command line persistence or exposure ---------------------------
const modelSource = read(join(runtimeDir, 'model.go'));
assert.ok(!/json:"[^"]*cmdline/i.test(modelSource), 'the API model must not expose a command line field');
assert.ok(!/json:"[^"]*argv/i.test(modelSource), 'the API model must not expose argv');
const scannerSource = read(join(runtimeDir, 'scanner.go'));
assert.ok(
  !/CommandLine\s+string\s+`json/.test(scannerSource),
  'the scanner must never retain a raw command line',
);

// 7. Process safety ---------------------------------------------------------
const allRuntimeGo = readAll(runtimeDir);
for (const forbidden of ['os/exec', 'exec.Command', 'syscall.Kill', 'os.Remove', 'os.Rename']) {
  assert.ok(!allRuntimeGo.includes(forbidden), `runtime discovery must not use ${forbidden}`);
}
for (const forbidden of ['/bin/sh', 'sudo', 'systemctl']) {
  assert.ok(!allRuntimeGo.includes(forbidden), `runtime discovery must not reference ${forbidden}`);
}
assert.ok(
  !/net\.Dial|http\.Get|http\.Post/.test(allRuntimeGo),
  'runtime discovery must not perform network probing',
);

// 8. Authorization ----------------------------------------------------------
const handlerSource = read(join(runtimeDir, 'handler.go'));
const readGates = handlerSource.match(/requireRead\(/g) ?? [];
const configureGates = handlerSource.match(/requireConfigure\(/g) ?? [];
assert.ok(readGates.length >= 2, 'read endpoints must require core.read');
assert.ok(configureGates.length >= 3, 'mutation endpoints must require core.configure');
assert.ok(handlerSource.includes('"core.read"'), 'core.read gate missing');
assert.ok(handlerSource.includes('"core.configure"'), 'core.configure gate missing');
assert.ok(
  handlerSource.includes('DisallowUnknownFields'),
  'runtime requests must reject unknown fields so no client identity can be smuggled in',
);

// 9. Central recognition authority (no frontend duplicate registry) --------
const frontendSource = readAll(frontendRuntime);
for (const processName of ['amfd', 'smfd', 'upfd', 'mmed', 'pcscfd', 'ocsd', 'drad']) {
  assert.ok(
    !frontendSource.includes(`'${processName}'`) && !frontendSource.includes(`"${processName}"`),
    `the frontend must not define its own process registry (${processName})`,
  );
}
assert.ok(frontendSource.includes('/api/runtime/observations'), 'the surface must read the runtime API');

// 10. Bootstrap provenance and idempotency ---------------------------------
const bootstrapSource = read(join(runtimeDir, 'bootstrap.go'));
assert.ok(bootstrapSource.includes('SourceKindDiscovered'), 'discovered provenance must be explicit');
assert.ok(bootstrapSource.includes('xrt:'), 'the stable bootstrap key must be namespaced');
assert.ok(bootstrapSource.includes('ErrStalePreview'), 'stale previews must be rejected');
const inventorySource = read(join(backend, 'internal/inventory/discovered.go'));
assert.ok(inventorySource.includes('SourceKindDiscovered'), 'inventory creation must carry discovered provenance');
assert.ok(
  !inventorySource.includes('Kind:      "manual"'),
  'discovered resources must never be labelled as manually authored',
);
assert.ok(inventorySource.includes('LifecyclePlanned'), 'discovered resources must start as planned');

// 11. Binding governance ---------------------------------------------------
const bindingSource = read(join(backend, 'internal/nfhealth/bindings.go'));
assert.ok(bindingSource.includes('static'), 'static binding precedence must be documented');
assert.ok(bindingSource.includes('ErrBindingConflict'), 'binding conflicts must fail closed');
const storeSource = read(join(backend, 'internal/nfhealth/runtime_bindings.go'));
assert.ok(storeSource.includes('BindingKey'), 'bindings must be unique per host/process/type');
assert.ok(storeSource.includes('LoadAll'), 'bindings must be reloadable after a restart');

// 12. Documentation --------------------------------------------------------
const docPath = join(root, 'docs/architecture/runtime-discovery.md');
assert.ok(existsSync(docPath), 'the runtime discovery architecture document must exist');
const doc = read(docPath);
for (const topic of ['24', '26', 'stopped', 'permission_denied', 'not_detected', 'bootstrap']) {
  assert.ok(doc.includes(topic), `the architecture document must cover ${topic}`);
}
const agents = read(join(root, 'AGENTS.md'));
const claude = read(join(root, 'CLAUDE.md'));
assert.ok(agents.includes('158'), 'AGENTS.md must document the 158 registration authority');
assert.ok(claude.includes('158'), 'CLAUDE.md must document the 158 registration authority');
assert.ok(
  agents.includes('docs/architecture/runtime-discovery.md'),
  'AGENTS.md must reference the runtime discovery document',
);

console.log('runtime_contract_checks=passed');
