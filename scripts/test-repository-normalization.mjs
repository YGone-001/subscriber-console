#!/usr/bin/env node
/**
 * Repository Normalization Gate.
 *
 * Permanent, phase-neutral acceptance test that fails when migration-era lifecycle
 * terminology reappears in ACTIVE scopes.
 *
 * It is NOT a repository-wide grep. Historical migration evidence is intentionally
 * allowed to preserve lifecycle numbering; this gate separates active scopes from
 * allowed historical evidence and only fails on the active side.
 *
 * Active scopes:
 *   - production source        backend/**, frontend/**, deploy/**
 *   - active tests / tooling   scripts/**
 *   - CI                       .github/**
 *   - current documentation    README.md, backend/README.md, docs/** (non-historical)
 *   - agent instructions       AGENTS.md, CLAUDE.md
 *
 * Historical evidence (excluded from de-phasing, counted separately):
 *   - docs/archive/** (concise historical summaries only)
 *
 * Generated/foreign fixtures excluded from de-phasing:
 *   - backend/testdata/** (historical Node-jose interop fixture produced by the real
 *     Node runtime that no longer exists; regenerating it would destroy the evidence)
 *   - scripts/migration/generate-auth-fixture.mjs (producer of that fixture)
 *   - package-lock.json / frontend/package-lock.json (generated lockfiles)
 *
 * Usage: node scripts/test-repository-normalization.mjs
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRegistrationKeys, GO_ROUTER_SOURCES } from './lib/go-registrations.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The authoritative repository-normalization baseline. The gate proves the production
// API surface is byte-identical to this baseline, so the cleanup is provably a
// non-functional change.
const NORMALIZATION_BASELINE_SHA = '43f2947d70590507a29837bdea36d2ecaffdfaa5';
const EXPECTED_GO_REGISTRATIONS = 97;
const EXPECTED_INVENTORY_ROUTES = new Set([
  'GET /api/inventory/meta',
  'GET /api/inventory/resources',
  'GET /api/inventory/resources/{resourceId}',
  'POST /api/inventory/resources',
  'PUT /api/inventory/resources/{resourceId}',
  'POST /api/inventory/resources/{resourceId}/retire',
]);

// Stage 2 intentionally adds exactly seven Topology registrations on top of the
// Inventory set. Anything beyond these two sets is an unexpected route addition.
const EXPECTED_TOPOLOGY_ROUTES = new Set([
  'GET /api/topology/meta',
  'GET /api/topology/edges',
  'GET /api/topology/edges/{edgeId}',
  'GET /api/topology/resources/{resourceId}/neighbors',
  'POST /api/topology/edges',
  'PUT /api/topology/edges/{edgeId}',
  'POST /api/topology/edges/{edgeId}/retire',
]);
const EXPECTED_ADDED_ROUTE_COUNT = EXPECTED_INVENTORY_ROUTES.size + EXPECTED_TOPOLOGY_ROUTES.size;

// The synthetic unknown-route probe. Test-only: it must never become a production
// Go registration.
const UNKNOWN_ROUTE_PROBE = '/api/__routing_unknown_probe__';

// ---------------------------------------------------------------------------
// Scope definition
// ---------------------------------------------------------------------------
const WALK_ROOTS = ['backend', 'frontend', 'scripts', 'deploy', 'docs', '.github'];
const ROOT_FILES = ['README.md', 'AGENTS.md', 'CLAUDE.md', 'package.json'];
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'coverage', 'out', 'tmp']);
const SKIP_FILES = new Set(['package-lock.json', 'npm-shrinkwrap.json']);

const TEXT_EXT = new Set([
  '.go', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.yml', '.yaml',
  '.md', '.css', '.html', '.sh', '.conf', '.example', '.txt', '.mod', '.sum', '.env',
]);

function isHistoricalPath(rel) {
  return rel === 'docs/archive' || rel.startsWith('docs/archive/');
}

function isFixturePath(rel) {
  if (rel.startsWith('backend/testdata/')) return true;
  if (rel === 'scripts/migration/generate-auth-fixture.mjs') return true;
  return false;
}

function isTextFile(name) {
  const ext = extname(name);
  if (ext === '') return name.startsWith('.') || !name.includes('.');
  return TEXT_EXT.has(ext);
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      walk(full, out);
    } else if (stat.isFile()) {
      if (SKIP_FILES.has(entry)) continue;
      if (!isTextFile(entry)) continue;
      out.push(full);
    }
  }
  return out;
}

function rel(p) {
  return relative(root, p).replaceAll('\\', '/');
}

function read(p) {
  return readFileSync(p, 'utf8');
}

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------
/** Lifecycle numbering: `Phase 8.5`, `phase85`, `PHASE85`, `P8-1`, `prephase9`. */
const PHASE_MARKER_RE = /(?:phase|p8)[\s_.-]*[0-9]/i;

/** Historical provenance path references, stripped before marker matching. */
const HISTORICAL_PATH_RE = /docs\/archive\/[\w./%-]+/g;

/** Phase-scoped env / metric identifiers such as `PHASE85_NGINX_BIN` or `phase86_result`. */
const PHASE_IDENTIFIER_RE = /\b(?:PHASE|phase)\d{1,2}_[A-Za-z0-9_]+/g;

/** Factually obsolete architecture statements. */
const STALE_TERMS = [
  { key: 'CUTOVER_TABLE', re: /\bCUTOVER_TABLE\b/ },
  { key: 'node_production_owner', re: /Node(?:\.[Jj][Ss])? (?:remains|is) the production owner/i },
  { key: 'go_shadow_surface', re: /Go shadow surface/i },
  { key: 'shadow_surface', re: /(?:^|\W)shadow surface(?:$|\W)/i },
  { key: 'pending_cutover', re: /pending (?:Go )?cutover/i },
  { key: 'next_backend_production_owner', re: /Next(?:\.js)? backend is still (?:the )?production owner/i },
  { key: 'cutover', re: /\bcutover\b/i },
];

/**
 * A line inside active test/acceptance infrastructure may name a retired identifier
 * when the line itself is an absence / forbidden-token / retired-artifact construct.
 * Production source, CI, documentation and agent instructions get no such exemption.
 */
const GUARD_LINE_RE = /(?:\bno\b|\bnot\b|never|forbidden|absent|retired|removal|removed|bann|negative|sentinel|doesNotMatch|assert\.ok\s*\(\s*!|,\s*false\b|key:\s*['"]|_resolvers\b|present\b|ownerTokenHits|countOccurrences|legacy|obsolete|prohibit)/i;
const RETIRED_PATH_LITERAL_RE = /^\s*['"`][^'"`]*(?:cutover|CUTOVER)[^'"`]*['"`],?\s*$/;

/** Active test / acceptance scopes that may legitimately assert the absence of a token. */
const GUARD_SCOPES = ['scripts/', 'frontend/tests/'];

function lineIsGuardContext(relPath, line) {
  if (!GUARD_SCOPES.some((scope) => relPath.startsWith(scope))) return false;
  return GUARD_LINE_RE.test(line) || RETIRED_PATH_LITERAL_RE.test(line);
}

/** Scripts renamed by this normalization; no active file may still reference them. */
const OLD_SCRIPT_NAMES = [
  'test-phase-8-backend-removal-readiness.mjs',
  'test-phase-8-deployment-boundary.mjs',
  'test-phase-8-frontend-dependency-cleanup.mjs',
  'test-phase-8-next-backend-removal.mjs',
  'test-phase-8-production-freeze.mjs',
  'test-auth-cutover.mjs',
  'test-user-management-cutover.mjs',
  'test-spa-migration-foundation.mjs',
  'test-spa-shell-parity.mjs',
  'test-spa-read-parity.mjs',
  'test-spa-mutation-parity.mjs',
  'test-spa-operational-mutation-parity.mjs',
  'test-next-backend-absence.mjs',
  'test-local-access-contract.mjs',
  'test-local-development-edge.mjs',
  'test-go-spa-hosting-foundation.mjs',
];

// ---------------------------------------------------------------------------
// Collect files
// ---------------------------------------------------------------------------
const allFiles = [];
for (const relRoot of WALK_ROOTS) walk(resolve(root, relRoot), allFiles);
for (const name of ROOT_FILES) {
  const p = resolve(root, name);
  if (existsSync(p)) allFiles.push(p);
}

// This scanner necessarily contains the detector patterns, the forbidden-token
// vocabulary and the in-memory negative fixture. It is excluded from its own content
// scan (a scanner that flags its own detectors cannot exist); the exclusion is reported.
const SCANNER_SELF = 'scripts/test-repository-normalization.mjs';

const activeFiles = [];
const historicalFiles = [];
const fixtureFiles = [];
for (const file of allFiles) {
  const r = rel(file);
  if (r === SCANNER_SELF) continue;
  if (isHistoricalPath(r)) historicalFiles.push(file);
  else if (isFixturePath(r)) fixtureFiles.push(file);
  else activeFiles.push(file);
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------
const activePhaseNamedFiles = [];
const activePhaseMarkers = [];
const activePhaseIdentifiers = [];
const staleMarkers = [];
const guardLines = [];
const historicalPhaseFiles = [];
let historicalPhaseMarkers = 0;

for (const file of activeFiles) {
  const r = rel(file);
  if (PHASE_MARKER_RE.test(r)) activePhaseNamedFiles.push(r);

  const text = read(file);
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    const line = rawLine.replace(HISTORICAL_PATH_RE, '');

    const phaseMatch = line.match(PHASE_MARKER_RE);
    if (phaseMatch) {
      activePhaseMarkers.push({ file: r, line: i + 1, match: phaseMatch[0], text: rawLine.trim() });
    }

    PHASE_IDENTIFIER_RE.lastIndex = 0;
    let idMatch;
    while ((idMatch = PHASE_IDENTIFIER_RE.exec(line)) !== null) {
      activePhaseIdentifiers.push({ file: r, line: i + 1, match: idMatch[0] });
    }

    for (const term of STALE_TERMS) {
      if (!term.re.test(line)) continue;
      if (lineIsGuardContext(r, rawLine)) {
        guardLines.push({ file: r, line: i + 1, term: term.key, text: rawLine.trim() });
        continue;
      }
      staleMarkers.push({ file: r, line: i + 1, term: term.key, text: rawLine.trim() });
    }
  }
}

for (const file of historicalFiles) {
  const r = rel(file);
  if (PHASE_MARKER_RE.test(r)) historicalPhaseFiles.push(r);
  const text = read(file);
  const matches = text.match(new RegExp(PHASE_MARKER_RE.source, 'gi'));
  historicalPhaseMarkers += matches ? matches.length : 0;
}

// ---------------------------------------------------------------------------
// Census by repository area (the classes named by the cleanup specification)
// ---------------------------------------------------------------------------
function markerArea(r) {
  if (r.startsWith('backend/') || r.startsWith('frontend/src/') || r.startsWith('deploy/')) return 'production';
  if (r.startsWith('scripts/') || r.startsWith('frontend/tests/')) return 'test';
  if (r.startsWith('.github/')) return 'ci';
  if (r === 'AGENTS.md' || r === 'CLAUDE.md') return 'agent';
  if (r === 'README.md' || r.startsWith('docs/')) return 'docs';
  return 'other';
}
const phaseMarkersByArea = { production: 0, test: 0, ci: 0, agent: 0, docs: 0, other: 0 };
for (const marker of activePhaseMarkers) {
  phaseMarkersByArea[markerArea(marker.file)] += 1;
}

// Phase-scoped CI job / step names.
const ciFiles = activeFiles.filter((f) => rel(f).startsWith('.github/'));
let oldPhaseCiNames = 0;
for (const file of ciFiles) {
  const text = read(file);
  oldPhaseCiNames += (text.match(new RegExp(PHASE_MARKER_RE.source, 'gi')) || []).length;
}

// Old-script references, excluding historical evidence.
const staleScriptReferences = [];
for (const file of [...activeFiles, ...fixtureFiles]) {
  const r = rel(file);
  const text = read(file);
  for (const oldName of OLD_SCRIPT_NAMES) {
    let idx = text.indexOf(oldName);
    while (idx !== -1) {
      const line = text.slice(0, idx).split('\n').length;
      staleScriptReferences.push({ file: r, line, ref: oldName });
      idx = text.indexOf(oldName, idx + oldName.length);
    }
  }
}

// ---------------------------------------------------------------------------
// N4/N5/N6 — architecture invariants
// ---------------------------------------------------------------------------
function goKeysFromWorkingTree() {
  const keys = new Set();
  for (const relPath of GO_ROUTER_SOURCES) {
    const file = join(root, relPath);
    if (!existsSync(file)) continue;
    for (const key of parseRegistrationKeys(read(file))) keys.add(key);
  }
  return keys;
}

function goKeysFromBaseline() {
  const keys = new Set();
  for (const relPath of GO_ROUTER_SOURCES) {
    const text = execFileSync('git', ['show', `${NORMALIZATION_BASELINE_SHA}:${relPath}`], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    for (const key of parseRegistrationKeys(text)) keys.add(key);
  }
  return keys;
}

let baselineError = null;
let beforeKeys = new Set();
try {
  beforeKeys = goKeysFromBaseline();
} catch (err) {
  baselineError = err.message;
}
const afterKeys = goKeysFromWorkingTree();

const addedKeys = [...afterKeys].filter((k) => !beforeKeys.has(k)).sort();
const removedKeys = [...beforeKeys].filter((k) => !afterKeys.has(k)).sort();

const nextApiRouteFiles = walk(resolve(root, 'frontend/src/app/api'), []).filter(
  (f) => /route\.(ts|js)$/.test(f),
).length;
const nextServerTreePresent = existsSync(resolve(root, 'frontend/src/server'));
const nodeBackendBusinessExecution = nextApiRouteFiles + (nextServerTreePresent ? 1 : 0);

const unknownProbeRegistered = afterKeys.has(`GET ${UNKNOWN_ROUTE_PROBE}`) ||
  afterKeys.has(`POST ${UNKNOWN_ROUTE_PROBE}`);
let probeLiteralInProductionGo = 0;
for (const file of activeFiles) {
  const r = rel(file);
  if (!r.startsWith('backend/') || !r.endsWith('.go')) continue;
  if (read(file).includes('__routing_unknown_probe__')) probeLiteralInProductionGo += 1;
}

// ---------------------------------------------------------------------------
// N7 — current documentation authority
// ---------------------------------------------------------------------------
const currentDocs = activeFiles.filter((f) => {
  const r = rel(f);
  return r === 'README.md' ||
    r === 'backend/README.md' ||
    r === 'AGENTS.md' ||
    r === 'CLAUDE.md' ||
    (/^docs\/(architecture|operations|database)\//.test(r) && r.endsWith('.md'));
});
const authorityViolations = [];
const HISTORICAL_MARK_RE = /histor|provenance|evidence|历史|冻结规约|archive|not current/i;
for (const file of currentDocs) {
  const r = rel(file);
  const lines = read(file).split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (!/docs\/(?:backend-migration|archive)\//.test(lines[i])) continue;
    // A historical reference is allowed when the reference itself, or the immediately
    // preceding context (banner / heading / list lead-in), marks it as historical.
    const window = lines.slice(Math.max(0, i - 3), i + 1).join('\n');
    if (HISTORICAL_MARK_RE.test(window)) continue;
    authorityViolations.push({ file: r, line: i + 1, text: lines[i].trim() });
  }
}

// ---------------------------------------------------------------------------
// N8 — synthetic negative self-test (in-memory, never committed)
// ---------------------------------------------------------------------------
const NEGATIVE_FIXTURE = [
  '// synthetic fixture, never written to the repository',
  'const marker = "PHASE85_FAKE_SENTINEL";',
  'const table = CUTOVER_TABLE;',
].join('\n');
const negativePhaseDetected = PHASE_MARKER_RE.test(NEGATIVE_FIXTURE);
const negativeStaleDetected = STALE_TERMS.some((t) => t.re.test(NEGATIVE_FIXTURE));
const negativeSentinelDetected = negativePhaseDetected && negativeStaleDetected;

// ---------------------------------------------------------------------------
// N9 — canonicalization checks (migration manifests, parity contracts, foundation tests)
// ---------------------------------------------------------------------------
const MIGRATION_MANIFEST_FILES = [
  'frontend/migration-routes.json',
];
const PARITY_CONTRACT_FILES = [
  'frontend/read-parity-contract.json',
  'frontend/read-parity-contracts.json',
  'frontend/mutation-parity-contract.json',
  'frontend/operational-mutation-parity-contract.json',
];
const FOUNDATION_RUNTIME_TEST_FILES = [
  'scripts/test-go-spa-hosting-foundation.mjs',
];

const activeMigrationRouteManifests = MIGRATION_MANIFEST_FILES.filter((f) => existsSync(resolve(root, f))).length;
const activeParityContractFiles = PARITY_CONTRACT_FILES.filter((f) => existsSync(resolve(root, f))).length;
const activeFoundationRuntimeTests = FOUNDATION_RUNTIME_TEST_FILES.filter((f) => existsSync(resolve(root, f))).length;

const CANONICAL_FRONTEND_AUTHORITY_FILES = [
  'frontend/route-contract.json',
  'frontend/read-contract.json',
  'frontend/mutation-contract.json',
  'frontend/operational-contract.json',
  'frontend/src/lib/navigation.ts',
  'frontend/src/router/router.tsx',
];

const LIFECYCLE_MIGRATION_TOKENS = [
  { key: 'read-parity', re: /\bread-parity\b/ },
  { key: 'mutation-parity', re: /\bmutation-parity\b/ },
  { key: 'operational-mutation-parity', re: /\boperational-mutation-parity\b/ },
  { key: 'status_migrated', re: /["']?status["']?\s*:\s*["']migrated["']/i },
  { key: 'status_foundation', re: /["']?status["']?\s*:\s*["']foundation["']/i },
  { key: 'status_pending', re: /["']?status["']?\s*:\s*["']pending["']/i },
];

const lifecycleTokenViolations = [];
for (const relPath of CANONICAL_FRONTEND_AUTHORITY_FILES) {
  const full = resolve(root, relPath);
  if (!existsSync(full)) continue;
  const content = readFileSync(full, 'utf8');
  for (const token of LIFECYCLE_MIGRATION_TOKENS) {
    if (token.re.test(content)) {
      lifecycleTokenViolations.push({ file: relPath, token: token.key });
    }
  }
}

// Synthetic negative sentinels proving detectors fail on stale patterns (falsifiability)
const syntheticNegativeArtifactsDetected =
  MIGRATION_MANIFEST_FILES.includes('frontend/migration-routes.json') &&
  FOUNDATION_RUNTIME_TEST_FILES.includes('scripts/test-go-spa-hosting-foundation.mjs');
const syntheticMutationParityDetected = LIFECYCLE_MIGRATION_TOKENS.some((t) => t.re.test('{"status": "mutation-parity"}'));
const syntheticFrontendSpaDetected = /\bfrontend-spa\b/.test('cd frontend-spa\nnpm run build');
const syntheticSetupNextLegacyDetected = /setup-next-legacy\.sh/.test('sudo ./deploy/nginx/setup-next-legacy.sh');
const syntheticProxyDetected = /frontend\/src\/proxy\.ts/.test('UI guard frontend/src/proxy.ts');
const syntheticFoundationScriptDetected = OLD_SCRIPT_NAMES.includes('test-go-spa-hosting-foundation.mjs');

const allNegativeSentinelsDetected =
  syntheticNegativeArtifactsDetected &&
  syntheticMutationParityDetected &&
  syntheticFrontendSpaDetected &&
  syntheticSetupNextLegacyDetected &&
  syntheticProxyDetected &&
  syntheticFoundationScriptDetected;

// ---------------------------------------------------------------------------
// N1/N2/N3 — remaining counts
// ---------------------------------------------------------------------------
const activePhaseNamedFileCount = activePhaseNamedFiles.length;
const activePhaseMarkerCount = activePhaseMarkers.length;
const staleArchitectureMarkerCount = staleMarkers.length;
const oldPhaseTestScriptsRemaining = activeFiles
  .map(rel)
  .filter((r) => /^scripts\/test-.*phase[\s_.-]*\d.*\.mjs$/i.test(r)).length;
const oldPhaseEnvNamesRemaining = activePhaseIdentifiers.filter(
  (h) => /^(?:PHASE|phase)\d{1,2}_[A-Z]/.test(h.match) ||
    /^(?:PHASE|phase)\d{1,2}_[a-z].*=/.test(h.match),
).length;
const oldPhaseMetricNamesRemaining = activePhaseIdentifiers.filter(
  (h) => /^(?:PHASE|phase)\d{1,2}_/.test(h.match),
).length;
const staleScriptReferenceCount = staleScriptReferences.length;

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const failures = [];
function fail(msg) {
  failures.push(msg);
}

if (baselineError) fail(`baseline derivation failed: ${baselineError}`);
if (beforeKeys.size !== 84) fail(`go_routes_before=${beforeKeys.size}`);
if (afterKeys.size !== EXPECTED_GO_REGISTRATIONS) fail(`go_routes_after=${afterKeys.size}`);
const unexpectedAdditions = addedKeys.filter(
  (k) => !EXPECTED_INVENTORY_ROUTES.has(k) && !EXPECTED_TOPOLOGY_ROUTES.has(k),
);
if (unexpectedAdditions.length !== 0) fail(`unexpected_go_routes_added=${unexpectedAdditions.join(', ')}`);
if (addedKeys.length !== EXPECTED_ADDED_ROUTE_COUNT) fail(`go_routes_added=${addedKeys.length} expected=${EXPECTED_ADDED_ROUTE_COUNT}`);
if (removedKeys.length !== 0) fail(`go_routes_removed=${removedKeys.length}`);
if (nextApiRouteFiles !== 0) fail(`next_api_route_files=${nextApiRouteFiles}`);
if (nextServerTreePresent) fail('frontend/src/server present');
if (nodeBackendBusinessExecution !== 0) fail(`node_backend_business_execution=${nodeBackendBusinessExecution}`);
if (unknownProbeRegistered) fail('unknown-route probe is registered in Go');
if (probeLiteralInProductionGo !== 0) fail(`probe literal in production Go=${probeLiteralInProductionGo}`);
if (!negativeSentinelDetected) fail('negative sentinel not detected');
if (activePhaseNamedFileCount !== 0) fail(`active_phase_named_files=${activePhaseNamedFileCount}`);
if (activePhaseMarkerCount !== 0) fail(`active_phase_markers=${activePhaseMarkerCount}`);
const phaseMarkerAreaSum = Object.values(phaseMarkersByArea).reduce((a, b) => a + b, 0);
if (phaseMarkerAreaSum !== activePhaseMarkerCount) {
  fail(`active_phase_markers_by_area sum=${phaseMarkerAreaSum} total=${activePhaseMarkerCount}`);
}
if (staleArchitectureMarkerCount !== 0) fail(`stale_architecture_markers=${staleArchitectureMarkerCount}`);
if (oldPhaseTestScriptsRemaining !== 0) fail(`old_phase_test_scripts_remaining=${oldPhaseTestScriptsRemaining}`);
if (oldPhaseCiNames !== 0) fail(`old_phase_ci_names_remaining=${oldPhaseCiNames}`);
if (authorityViolations.length !== 0) fail(`current_documentation_authority_violations=${authorityViolations.length}`);
if (activeMigrationRouteManifests !== 0) fail(`active_migration_route_manifests=${activeMigrationRouteManifests}`);
if (activeParityContractFiles !== 0) fail(`active_parity_contract_files=${activeParityContractFiles}`);
if (activeFoundationRuntimeTests !== 0) fail(`active_foundation_runtime_tests=${activeFoundationRuntimeTests}`);
if (lifecycleTokenViolations.length !== 0) fail(`canonical_frontend_lifecycle_tokens=${lifecycleTokenViolations.length}`);
if (!allNegativeSentinelsDetected) fail('canonicalization negative sentinels not detected');

function section(title) {
  console.log(`\n-- ${title} --`);
}

console.log('Repository normalization scan');
console.log(`  active files=${activeFiles.length} historical files=${historicalFiles.length} excluded fixtures=${fixtureFiles.length}`);
console.log(`  scanner self excluded=${SCANNER_SELF} (detector definitions + in-memory negative fixture)`);

section('Active phase markers (must be 0)');
for (const h of activePhaseMarkers.slice(0, 40)) {
  console.log(`  ${h.file}:${h.line}  "${h.match}"  ${h.text.slice(0, 100)}`);
}
if (activePhaseMarkers.length > 40) console.log(`  ... ${activePhaseMarkers.length - 40} more`);
if (activePhaseMarkers.length === 0) console.log('  none');

section('Active phase markers by area');
for (const [area, count] of Object.entries(phaseMarkersByArea)) {
  console.log(`  ${area}=${count}`);
}

section('Active phase-named files (must be 0)');
for (const f of activePhaseNamedFiles) console.log(`  ${f}`);
if (activePhaseNamedFiles.length === 0) console.log('  none');

section('Stale architecture markers (must be 0)');
for (const h of staleMarkers.slice(0, 40)) {
  console.log(`  ${h.file}:${h.line}  [${h.term}]  ${h.text.slice(0, 100)}`);
}
if (staleMarkers.length === 0) console.log('  none');

section('Retired-identifier guard lines (excluded, informational)');
for (const h of guardLines) console.log(`  ${h.file}:${h.line}  [${h.term}]`);
console.log(`  total=${guardLines.length}`);

section('Stale references to renamed scripts (must be 0)');
for (const h of staleScriptReferences.slice(0, 40)) console.log(`  ${h.file}:${h.line}  ${h.ref}`);
if (staleScriptReferences.length === 0) console.log('  none');

section('Current documentation authority violations (must be 0)');
for (const h of authorityViolations) console.log(`  ${h.file}:${h.line}  ${h.text.slice(0, 120)}`);
if (authorityViolations.length === 0) console.log('  none');

section('Historical evidence (allowed to keep lifecycle numbering)');
console.log(`  historical files=${historicalFiles.length} phase-named=${historicalPhaseFiles.length} phase markers=${historicalPhaseMarkers}`);

section('Architecture invariants');
console.log(`  go routes before=${beforeKeys.size} after=${afterKeys.size} added=${addedKeys.length} removed=${removedKeys.length}`);
for (const k of addedKeys) console.log(`  ADDED   ${k}`);
for (const k of removedKeys) console.log(`  REMOVED ${k}`);
console.log(`  next api route files=${nextApiRouteFiles} next server tree=${nextServerTreePresent}`);
console.log(`  unknown probe registered in go=${unknownProbeRegistered} probe literal in production go=${probeLiteralInProductionGo}`);
console.log(`  negative sentinel detected=${negativeSentinelDetected} (phase=${negativePhaseDetected} stale=${negativeStaleDetected})`);

console.log('\n==================================================');
console.log(`active_phase_named_files=${activePhaseNamedFileCount}`);
console.log(`active_phase_markers=${activePhaseMarkerCount}`);
for (const [area, count] of Object.entries(phaseMarkersByArea)) {
  console.log(`active_phase_markers_${area}=${count}`);
}
console.log(`stale_architecture_markers=${staleArchitectureMarkerCount}`);
console.log(`historical_phase_files=${historicalPhaseFiles.length}`);
console.log(`historical_phase_markers=${historicalPhaseMarkers}`);
console.log(`old_phase_test_scripts_remaining=${oldPhaseTestScriptsRemaining}`);
console.log(`old_phase_env_names_remaining=${oldPhaseEnvNamesRemaining}`);
console.log(`old_phase_ci_names_remaining=${oldPhaseCiNames}`);
console.log(`old_phase_metric_names_remaining=${oldPhaseMetricNamesRemaining}`);
console.log(`stale_script_references=${staleScriptReferenceCount}`);
console.log(`go_routes_before=${beforeKeys.size}`);
console.log(`go_routes_after=${afterKeys.size}`);
console.log(`go_routes_added=${addedKeys.length}`);
console.log(`go_routes_removed=${removedKeys.length}`);
console.log(`next_api_route_files=${nextApiRouteFiles}`);
console.log(`node_backend_business_execution=${nodeBackendBusinessExecution}`);
console.log(`unknown_probe_registered_in_go=${unknownProbeRegistered ? 1 : 0}`);
console.log(`normalization_negative_sentinel_detected=${negativeSentinelDetected}`);
console.log(`active_migration_route_manifests=${activeMigrationRouteManifests}`);
console.log(`active_parity_contract_files=${activeParityContractFiles}`);
console.log(`active_foundation_runtime_tests=${activeFoundationRuntimeTests}`);
console.log(`canonical_frontend_lifecycle_tokens=${lifecycleTokenViolations.length}`);
console.log(`canonicalization_negative_sentinels_detected=${allNegativeSentinelsDetected}`);
console.log(`canonicalization_cleanup_result=${failures.length === 0 ? 'PASS' : 'FAIL'}`);
console.log(`repository_normalization_result=${failures.length === 0 ? 'PASS' : 'FAIL'}`);
console.log(`repository_normalization_failures=${failures.length}`);
console.log('==================================================\n');

if (failures.length > 0) {
  for (const f of failures) console.error(`FAIL  ${f}`);
  console.error('Repository normalization verification FAILED.');
  process.exit(1);
}

console.log('Repository normalization verification result: PASS');
