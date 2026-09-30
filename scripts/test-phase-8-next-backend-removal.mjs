#!/usr/bin/env node
/**
 * Phase 8.3 - Next.js Business Backend Physical Removal Acceptance Suite.
 *
 * This is the RUNTIME acceptance suite for the Phase 8.3 removal. The static,
 * database-free verification lives in scripts/test-phase-8-backend-removal-readiness.mjs
 * and stays authoritative for pure source analysis; this suite adds the evidence that can
 * only be produced by exercising the REAL production stack.
 *
 * Real topology (no handler mocks, no direct proxy() invocation):
 *
 *   HTTP client (real fetch)
 *        |
 *        v
 *   real Next.js production server (next build + next start)
 *        |  frontend/src/proxy.ts  (JWT verify -> Mongo session revalidation -> routing)
 *        v
 *   GO_BACKEND_URL  (test-side capture proxy; measures only, never alters semantics)
 *        |
 *        v
 *   real production Go server (backend/cmd/server)
 *        |
 *        v
 *   isolated MongoDB (dedicated test databases)
 *
 * There is no production fault-injection switch: the fail-closed evidence reuses the real
 * branch by pointing GO_BACKEND_URL at a closed port, and the Mongo-unavailable evidence
 * reuses the real branch by pointing the Next server's MONGODB_URI at a closed port.
 *
 * Machine-identifiable case groups:
 *   P83-Sxx  source-removal invariants
 *   P83-Axx  API route absence
 *   P83-Bxx  server business tree absence
 *   P83-Pxx  proxy / session preservation (incl. Mongo-unavailable 503)
 *   P83-Rxx  84-route Go routing integrity (real HTTP, exactly-once)
 *   P83-Fxx  fail-closed / no fallback
 *   P83-Uxx  unknown API behaviour
 *   P83-Dxx  retired API behaviour
 *   P83-Cxx  CI / test supersession integrity
 *   P83-Gxx  Go registration equality
 *   P83-Mxx  Mongo session-store read-only boundary
 *
 * Emits the mandatory Phase 8.3 machine-readable block and exits non-zero on any failure.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { execSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import { MongoClient } from 'mongodb';
import { createJiti } from 'jiti';
import nextEnv from '@next/env';
import bcrypt from 'bcryptjs';

const selfPath = path.resolve(fileURLToPath(import.meta.url));
const root = path.resolve(path.dirname(selfPath), '..');

// Path segments are joined (never written as one literal) so this suite never contains a
// live-looking reference to the trees it is proving absent.
const frontendRoot = path.join(root, 'frontend');
const srcRoot = path.join(frontendRoot, 'src');
const apiRoot = path.join(srcRoot, 'app', 'api');
const serverRoot = path.join(srcRoot, 'server');
const testsRoot = path.join(frontendRoot, 'tests');
const scriptsRoot = path.join(root, 'scripts');
const githubRoot = path.join(root, '.github');
const ciPath = path.join(githubRoot, 'workflows', 'ci.yml');

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'];
const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

// Historical pre-deletion values (Phase 8.3 started from this state). Reported, never used
// as a live expectation: the live expectation is "both are now 0".
const PHASE83_START_API_ROUTE_FILES = 54;
const PHASE83_START_API_OPERATIONS = 72;

// The routing table size asserted by the Phase 8.3 contract. The route LIST is always
// derived from CUTOVER_TABLE at runtime; only the count is pinned.
const PHASE83_CUTOVER_TABLE_SIZE = 84;

const REQUEST_BODY_FOR_METHOD = { POST: {}, PUT: {}, PATCH: {} };

// ---------------------------------------------------------------------------
// Test Mongo URI must be explicitly controlled: never inherit a developer `.env`.
// ---------------------------------------------------------------------------
const PRELOAD_MONGODB_URI = process.env.MONGODB_URI;
nextEnv.loadEnvConfig(process.cwd());
process.env.MONGODB_URI = PRELOAD_MONGODB_URI
  || process.env.P83_TEST_MONGODB_URI
  || 'mongodb://127.0.0.1:27017/xcloud';

const suffix = `${Date.now()}_${process.pid}_${Math.floor(Math.random() * 100000)}`;
const xcloudDbName = `xcloud_p83_removal_${suffix}`;
const appDbName = `xcloud_ops_p83_removal_${suffix}`;
const uri = process.env.MONGODB_URI;

process.env.MONGODB_XCLOUD_DB = xcloudDbName;
process.env.MONGODB_APP_DB = appDbName;
const JWT_SECRET_STRING = process.env.JWT_SECRET || 'p83-removal-suite-secret-at-least-32-bytes!';
process.env.JWT_SECRET = JWT_SECRET_STRING;

// Deliberately unreachable endpoints used to exercise the real fail-closed branches.
const UNREACHABLE_GO_URL = 'http://127.0.0.1:1';
const UNREACHABLE_MONGO_URI = 'mongodb://127.0.0.1:1/xcloud';

// Suppress known intentional unreachable noise during the run.
const originalConsoleError = console.error;
console.error = (...args) => {
  if (typeof args[0] === 'string' && (args[0].includes('Audit scheduling failed') || args[0].includes('Go backend unreachable'))) {
    return;
  }
  originalConsoleError(...args);
};

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  alias: {
    '@': new URL('../frontend/src/', import.meta.url).pathname,
  },
});

const { CUTOVER_TABLE, resolveRouteOwner } = jiti('../frontend/src/lib/cutover-routing.ts');
const { getJwtSecretKey } = jiti('../frontend/src/lib/security.ts');
const { validateAccountSnapshot, AccountSessionError } = jiti('../frontend/src/lib/accountSession.ts');

const client = new MongoClient(uri, {
  serverSelectionTimeoutMS: Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS || 5000),
});

// ---------------------------------------------------------------------------
// Harness state
// ---------------------------------------------------------------------------

let goProc = null;
let goPort = null;
let binPath = null;
let capture = null;
let capturePort = null;
let nextProc = null;
let nextPort = null;
const nextProcs = [];
const nextStdout = [];

let total = 0;
let passed = 0;
let failed = 0;

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

function check(label, fn) {
  total++;
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  PASS  ${label}`);
    })
    .catch((err) => {
      failed++;
      console.error(`  FAIL  ${label}`);
      console.error(`        ${err && err.message ? err.message : err}`);
    });
}

function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function walk(dir, filter, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, filter, out);
    else if (filter(full)) out.push(full);
  }
  return out;
}

function rel(p) {
  return path.relative(root, p).replaceAll('\\', '/');
}

function key(method, p) {
  return `${method} ${p}`;
}

/** Convert a Go/Node route path (:param, *) into the canonical `{param}` form. */
function canonicalize(nodePath) {
  return nodePath.replace(/:(\w+)\*?/g, '{$1}');
}

function concretePath(canonical) {
  return canonical
    .replace('{planId}', 'default-standard')
    .replace('{ruleId}', 'rule-01')
    .replace('{versionId}', 'v1')
    .replace('{username}', 'p83_admin')
    .replace('{imsi}', '001010000000001')
    .replace('{name}', 'default')
    .replace('{id}', 'p83-rating-01');
}

/**
 * Blank out code comments while preserving line numbers exactly, so documentation prose
 * inside comments is never counted as a live reference.
 */
function stripComments(source) {
  const out = [];
  let inBlock = false;
  for (const raw of source.split('\n')) {
    let i = 0;
    let built = '';
    while (i < raw.length) {
      if (inBlock) {
        const end = raw.indexOf('*/', i);
        if (end === -1) {
          i = raw.length;
          break;
        }
        inBlock = false;
        i = end + 2;
        continue;
      }
      if (raw.startsWith('/*', i)) {
        inBlock = true;
        i += 2;
        continue;
      }
      if (raw.startsWith('//', i) && (i === 0 || raw[i - 1] !== ':')) break;
      built += raw[i];
      i += 1;
    }
    out.push(built);
  }
  return out.join('\n');
}

function methodExportsOf(file) {
  const content = readFileSync(file, 'utf8');
  const found = new Set();
  const patterns = [
    /export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s*\(/g,
    /export\s+function\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s*\(/g,
    /export\s+const\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s*=/g,
  ];
  for (const pattern of patterns) {
    let m;
    while ((m = pattern.exec(content)) !== null) found.add(m[1]);
  }
  const reExport = /export\s*\{([^}]+)\}/g;
  let rm;
  while ((rm = reExport.exec(content)) !== null) {
    for (const name of rm[1].split(',').map((n) => n.trim().split(/\s+as\s+/)[0].trim())) {
      if (HTTP_METHODS.includes(name)) found.add(name);
    }
  }
  return { content, methods: found };
}

// ---------------------------------------------------------------------------
// Source scans
// ---------------------------------------------------------------------------

/** Walk the (now deleted) Next.js App Router API tree. Absent dir is reported as 0. */
function scanApiTree() {
  const files = walk(apiRoot, (p) => p.endsWith('route.ts') || p.endsWith('route.js'));
  const ops = [];
  for (const file of files) {
    const { methods } = methodExportsOf(file);
    for (const method of methods) ops.push({ method, file });
  }
  return { files, ops };
}

/** Production Go route registrations (authoritative source). */
function loadGoRegistrations() {
  const sources = [
    path.join(root, 'backend', 'cmd', 'server', 'main.go'),
    path.join(root, 'backend', 'internal', 'remediation', 'handler.go'),
  ].filter(existsSync);
  const ops = [];
  for (const file of sources) {
    const content = readFileSync(file, 'utf8');
    const re = /mux\.Handle\("(GET|POST|PUT|PATCH|DELETE)\s+([^"]+)"\s*,/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      ops.push({ method: m[1], canonicalPath: canonicalize(m[2]), file: rel(file) });
    }
  }
  return ops;
}

// Real dependency edges naming the removed Next.js server tree.
const SERVER_TREE_RE = /@\/server\/|src\/server\//;
const RESOLUTION_OP_RE =
  /(?:\bimport\b|\brequire\s*\(|jiti|loadModule\s*\(|readFileSync|readFile\b|existsSync|statSync|readdirSync|new\s+URL\s*\(|path\s*\.\s*(?:join|resolve)\s*\(|\bresolve\s*\(|\bjoin\s*\()/;

function scanActiveServerImports() {
  const roots = [srcRoot, testsRoot, scriptsRoot, githubRoot];
  const hits = [];
  const literalOnly = [];
  for (const base of roots) {
    if (!existsSync(base)) continue;
    const files = walk(base, (p) => CODE_EXT.test(p) || /\.ya?ml$/.test(p));
    for (const file of files) {
      if (path.resolve(file) === selfPath) continue;
      stripComments(readFileSync(file, 'utf8')).split('\n').forEach((line, idx) => {
        if (!SERVER_TREE_RE.test(line)) return;
        const entry = { file: rel(file), line: idx + 1, text: line.trim() };
        if (RESOLUTION_OP_RE.test(line)) hits.push(entry);
        else literalOnly.push(entry);
      });
    }
  }
  return { hits, literalOnly };
}

/** Assert no surviving frontend/src file imports the removed trees by tsconfig alias. */
function scanAliasImports() {
  const serverAlias = [];
  const apiAlias = [];
  const files = walk(srcRoot, (p) => CODE_EXT.test(p));
  const re = /(?:import\s+(?:type\s+)?[^;]*?from\s*|import\s*\(\s*|require\s*\(\s*|jiti\s*\(\s*)['"]([^'"]+)['"]/g;
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(content)) !== null) {
      const spec = m[1];
      if (spec.startsWith('@/server/') || spec === '@/server') serverAlias.push(`${rel(file)} -> ${spec}`);
      if (spec.startsWith('@/app/api/') || spec === '@/app/api') apiAlias.push(`${rel(file)} -> ${spec}`);
    }
  }
  return { serverAlias, apiAlias };
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function declaredDependencies(pkg) {
  return { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
}

// ---------------------------------------------------------------------------
// Executable test / CI supersession manifests
// ---------------------------------------------------------------------------
// Phase 8.3 deliberately deleted or adapted a known set of test and CI artifacts. Those
// transitions are declared here as data (never as prose) and reconciled below against the
// real Git delta by exact path identity. Every current / historical evidence target
// declared here must resolve on disk, so a stale or invented mapping fails acceptance.

const SUPERSESSION_ACTIONS = {
  ADAPT: 'ADAPT_TO_CURRENT_RUNTIME',
  REMOVE: 'REMOVE_DELETED_NODE_IMPLEMENTATION_UNIT_TEST',
  RETIRE: 'RETIRE_AS_HISTORICAL_PARITY',
  REPLACE: 'REPLACE_WITH_CURRENT_RUNTIME_SUITE',
};

const CI_SUPERSESSION_ACTIONS = {
  KEEP: 'KEEP_UNCHANGED',
  ADAPT: 'ADAPT_TO_CURRENT_RUNTIME',
  RETIRE: 'RETIRE_AS_HISTORICAL_PARITY',
  REPLACE: 'REPLACE_WITH_CURRENT_RUNTIME_SUITE',
  ADDED: 'ADDED',
};

const PHASE7_FREEZE_DOC = 'docs/architecture/phase-7-platform-services-architecture.md';
const AUTH_MODEL_DOC = 'docs/operations/authentication-model.md';
const AUTH_ARCH_DOC = 'docs/architecture/phase-6-auth-architecture.md';
const PHASE81_DOC = 'docs/backend-migration/phase-8.1-residual-go-parity.md';
const PHASE82_DOC = 'docs/backend-migration/phase-8.2-residual-production-cutover.md';
const REMOVAL_SUITE = 'scripts/test-phase-8-next-backend-removal.mjs';

// `replacement` defaults to the artifact itself for ADAPT / REPLACE: the surviving artifact
// is the current-runtime evidence that the transition happened instead of a silent drop.
const TEST_SUPERSESSION_MANIFEST = [
  // Adapted frontend unit tests: assertions re-pointed at surviving sources.
  { path: 'frontend/tests/authSecurity.test.mjs', action: SUPERSESSION_ACTIONS.ADAPT, deletedDependency: 'deleted Next.js auth route source' },
  { path: 'frontend/tests/ocsDashboardAnalytics.test.mjs', action: SUPERSESSION_ACTIONS.ADAPT, deletedDependency: 'deleted analytics repository source read' },
  { path: 'frontend/tests/ocsOperations.test.mjs', action: SUPERSESSION_ACTIONS.ADAPT, deletedDependency: 'deleted OCS API routes + OCS operations repository source read' },
  { path: 'frontend/tests/profileNavigationPerformance.test.mjs', action: SUPERSESSION_ACTIONS.ADAPT, deletedDependency: 'summarizeProfiles from the deleted profile repository' },
  { path: 'frontend/tests/realtimeNotifications.test.mjs', action: SUPERSESSION_ACTIONS.ADAPT, deletedDependency: 'deleted SSE route existence check' },
  { path: 'frontend/tests/systemHealthDiagnostics.test.mjs', action: SUPERSESSION_ACTIONS.ADAPT, deletedDependency: 'deleted system health / audit repositories' },
  { path: 'frontend/tests/userAccessManagement.test.mjs', action: SUPERSESSION_ACTIONS.ADAPT, deletedDependency: 'deleted user repository + Mongo fixture harness' },
  { path: 'frontend/tests/userManagementUx.test.mjs', action: SUPERSESSION_ACTIONS.ADAPT, deletedDependency: 'deleted users/[username] route source' },
  { path: 'frontend/tests/xcloudSubscriber.test.mjs', action: SUPERSESSION_ACTIONS.ADAPT, deletedDependency: 'prepareSubscriberLegacyUpdate from the deleted server tree' },
  // Adapted validators: formerly proved readiness against a still-present Node backend.
  { path: 'scripts/migration/inventory-api.mjs', action: SUPERSESSION_ACTIONS.ADAPT, deletedDependency: 'scanned the deleted Next.js API tree', replacement: 'scripts/migration/validate-inventory.mjs' },
  { path: 'scripts/migration/validate-inventory.mjs', action: SUPERSESSION_ACTIONS.ADAPT, deletedDependency: 'cross-checked the deleted Next.js route matrix', replacement: 'scripts/test-phase-8-backend-removal-readiness.mjs' },
  { path: 'scripts/test-phase-8-backend-removal-readiness.mjs', action: SUPERSESSION_ACTIONS.ADAPT, deletedDependency: 'proved removal readiness of an existing Node backend', replacement: REMOVAL_SUITE },

  // Removed frontend unit tests: they tested the deleted Node implementation itself.
  { path: 'frontend/tests/batchUpdateFixtures.test.mjs', action: SUPERSESSION_ACTIONS.REMOVE, deletedDependency: 'src/server/__tests__/batch-update-fixtures.ts', replacement: 'backend/internal/subscriber/handler_write_test.go' },
  { path: 'frontend/tests/bulkDeleteFixtures.test.mjs', action: SUPERSESSION_ACTIONS.REMOVE, deletedDependency: 'src/server/__tests__/bulk-delete-fixtures.ts', replacement: 'backend/internal/subscriber/handler_write_test.go' },
  { path: 'frontend/tests/profileRestore.test.mjs', action: SUPERSESSION_ACTIONS.REMOVE, deletedDependency: 'src/server/profileRestoreGovernance.ts', replacement: 'backend/internal/profile/restore_integration_test.go' },
  { path: 'frontend/tests/profileRestoreFixtures.test.mjs', action: SUPERSESSION_ACTIONS.REMOVE, deletedDependency: 'src/server/profileRestoreGovernance.ts', replacement: 'backend/internal/profile/restore_integration_test.go' },
  { path: 'frontend/tests/subscriberBatchCrossRuntime.test.mjs', action: SUPERSESSION_ACTIONS.REMOVE, deletedDependency: 'src/server/__tests__/batch-create-fixtures.ts', replacement: 'backend/internal/subscriber/batch_create_fixture_test.go' },
  { path: 'frontend/tests/subscriberBatchExecution.test.mjs', action: SUPERSESSION_ACTIONS.REMOVE, deletedDependency: 'deleted Next.js batch route module', replacement: 'backend/internal/subscriber/handler_http_test.go' },
  { path: 'frontend/tests/subscriberBatchUpdateCrossRuntime.test.mjs', action: SUPERSESSION_ACTIONS.REMOVE, deletedDependency: 'src/server/__tests__/batch-update-fixtures.ts', replacement: 'backend/internal/subscriber/handler_write_test.go' },
  { path: 'frontend/tests/subscriberBatchUpdateIntegrity.test.mjs', action: SUPERSESSION_ACTIONS.REMOVE, deletedDependency: 'src/server/subscriberOperationPolicy.ts', replacement: 'backend/internal/subscriber/validation_test.go' },
  { path: 'frontend/tests/subscriberImportFrozenInvariant.test.mjs', action: SUPERSESSION_ACTIONS.REMOVE, deletedDependency: 'deleted Next.js import route module', replacement: 'backend/internal/subscriber/import_fixture_test.go' },
  { path: 'frontend/tests/subscriberOperationPolicy.test.mjs', action: SUPERSESSION_ACTIONS.REMOVE, deletedDependency: 'deleted Next.js subscriber operation policy', replacement: 'backend/internal/subscriber/governance_test.go' },
  { path: 'frontend/tests/subscriberProfileApplyCrossRuntime.test.mjs', action: SUPERSESSION_ACTIONS.REMOVE, deletedDependency: 'src/server/__tests__/profile-apply-fixtures.ts', replacement: 'backend/internal/subscriber/profile_apply_test.go' },

  // Retired historical parity scripts: structurally bound to deleted Node modules; their
  // claims stay frozen in the cited phase documents and are re-proved by the removal suite.
  { path: 'scripts/test-auth-go-parity.mjs', action: SUPERSESSION_ACTIONS.RETIRE, deletedDependency: 'deleted Next.js auth routes', historicalEvidence: AUTH_ARCH_DOC },
  { path: 'scripts/test-auth-security-hardening.mjs', action: SUPERSESSION_ACTIONS.RETIRE, deletedDependency: 'deleted Next.js auth route source', historicalEvidence: AUTH_MODEL_DOC },
  { path: 'scripts/test-phase-7-architecture-freeze.mjs', action: SUPERSESSION_ACTIONS.RETIRE, deletedDependency: 'deleted Next.js platform sources', historicalEvidence: PHASE7_FREEZE_DOC },
  { path: 'scripts/test-phase-7-read-parity.mjs', action: SUPERSESSION_ACTIONS.RETIRE, deletedDependency: 'deleted Next.js platform routes', historicalEvidence: PHASE7_FREEZE_DOC },
  { path: 'scripts/test-phase-7-alert-mutation-parity.mjs', action: SUPERSESSION_ACTIONS.RETIRE, deletedDependency: 'deleted alert repository', historicalEvidence: PHASE7_FREEZE_DOC },
  { path: 'scripts/test-phase-7-notification-stream-parity.mjs', action: SUPERSESSION_ACTIONS.RETIRE, deletedDependency: 'deleted SSE route', historicalEvidence: PHASE7_FREEZE_DOC },
  { path: 'scripts/test-phase-7-system-heal-parity.mjs', action: SUPERSESSION_ACTIONS.RETIRE, deletedDependency: 'deleted remediation routes', historicalEvidence: PHASE7_FREEZE_DOC },
  { path: 'scripts/test-phase-7-platform-cutover.mjs', action: SUPERSESSION_ACTIONS.RETIRE, deletedDependency: 'deleted Next.js platform routes', historicalEvidence: PHASE7_FREEZE_DOC },
  { path: 'scripts/test-phase-8-residual-api-parity.mjs', action: SUPERSESSION_ACTIONS.RETIRE, deletedDependency: 'deleted residual Next.js routes', historicalEvidence: PHASE81_DOC },
  { path: 'scripts/test-phase-8-residual-cutover.mjs', action: SUPERSESSION_ACTIONS.RETIRE, deletedDependency: 'deleted residual Next.js route modules', historicalEvidence: PHASE82_DOC },
  { path: 'scripts/instrumented-account-session.mjs', action: SUPERSESSION_ACTIONS.RETIRE, deletedDependency: 'deleted Next.js session module', historicalEvidence: AUTH_MODEL_DOC },
  { path: 'scripts/instrumented-alert-repository.mjs', action: SUPERSESSION_ACTIONS.RETIRE, deletedDependency: 'deleted alert repository', historicalEvidence: PHASE7_FREEZE_DOC },

  // Replacement current-runtime suite.
  { path: REMOVAL_SUITE, action: SUPERSESSION_ACTIONS.REPLACE, deletedDependency: 'retired Node parity harnesses', replacement: REMOVAL_SUITE },
];

// Steps that carry no acceptance contract (pure runner plumbing). They are classified once
// here instead of being re-declared for every job.
const CI_INFRA_STEPS = new Set([
  'Checkout',
  'Setup Node',
  'Setup Go',
  'Install dependencies',
  'Install repository script dependencies',
  'Install frontend dependencies',
]);

// Every CI job that exists in the Phase 8.3 delta, current or retired.
const CI_JOB_MANIFEST = [
  { job: 'node', action: CI_SUPERSESSION_ACTIONS.KEEP, evidence: 'frontend/package.json' },
  { job: 'go', action: CI_SUPERSESSION_ACTIONS.KEEP, evidence: 'backend/go.mod' },
  { job: 'direct-operations', action: CI_SUPERSESSION_ACTIONS.ADAPT, evidence: 'scripts/test-direct-operations.mjs' },
  { job: 'user-management-e2e', action: CI_SUPERSESSION_ACTIONS.KEEP, evidence: 'scripts/test-user-management-e2e.mjs' },
  { job: 'auth-cutover', action: CI_SUPERSESSION_ACTIONS.KEEP, evidence: 'scripts/test-auth-cutover.mjs' },
  { job: 'next-backend-removal', action: CI_SUPERSESSION_ACTIONS.ADDED, evidence: REMOVAL_SUITE },
  { job: 'auth-security', action: CI_SUPERSESSION_ACTIONS.RETIRE, historicalEvidence: AUTH_MODEL_DOC },
  { job: 'auth-go-parity', action: CI_SUPERSESSION_ACTIONS.RETIRE, historicalEvidence: AUTH_ARCH_DOC },
  { job: 'platform-read-parity', action: CI_SUPERSESSION_ACTIONS.RETIRE, historicalEvidence: PHASE7_FREEZE_DOC },
  { job: 'residual-api-parity', action: CI_SUPERSESSION_ACTIONS.RETIRE, historicalEvidence: PHASE81_DOC },
];

// Every current contract step, plus every retired step that the removal deleted.
const CI_STEP_MANIFEST = [
  { job: 'node', step: 'Lint', action: CI_SUPERSESSION_ACTIONS.KEEP, evidence: 'frontend/package.json' },
  { job: 'node', step: 'Typecheck', action: CI_SUPERSESSION_ACTIONS.KEEP, evidence: 'frontend/package.json' },
  { job: 'node', step: 'Test', action: CI_SUPERSESSION_ACTIONS.ADAPT, evidence: 'frontend/tests' },
  { job: 'node', step: 'Build', action: CI_SUPERSESSION_ACTIONS.KEEP, evidence: 'frontend/package.json' },
  { job: 'node', step: 'Migration inventory', action: CI_SUPERSESSION_ACTIONS.ADAPT, evidence: 'scripts/migration/inventory-api.mjs' },
  { job: 'node', step: 'Migration validator', action: CI_SUPERSESSION_ACTIONS.ADAPT, evidence: 'scripts/migration/validate-inventory.mjs' },
  { job: 'node', step: 'Phase 8 backend removal readiness', action: CI_SUPERSESSION_ACTIONS.ADAPT, evidence: 'scripts/test-phase-8-backend-removal-readiness.mjs' },

  { job: 'go', step: 'Format check', action: CI_SUPERSESSION_ACTIONS.KEEP, evidence: 'backend/go.mod' },
  { job: 'go', step: 'Vet', action: CI_SUPERSESSION_ACTIONS.KEEP, evidence: 'backend/go.mod' },
  { job: 'go', step: 'Test', action: CI_SUPERSESSION_ACTIONS.KEEP, evidence: 'backend/go.mod' },
  { job: 'go', step: 'Build', action: CI_SUPERSESSION_ACTIONS.KEEP, evidence: 'backend/go.mod' },

  { job: 'direct-operations', step: 'Governance surface removal contract', action: CI_SUPERSESSION_ACTIONS.KEEP, evidence: 'scripts/test-direct-operations.mjs' },
  { job: 'direct-operations', step: 'OCS management suite', action: CI_SUPERSESSION_ACTIONS.KEEP, evidence: 'scripts/test-ocs-management-suite.mjs' },
  { job: 'direct-operations', step: 'RBAC simplification acceptance', action: CI_SUPERSESSION_ACTIONS.KEEP, evidence: 'scripts/test-rbac-simplification.mjs' },
  { job: 'direct-operations', step: 'RBAC role migration acceptance', action: CI_SUPERSESSION_ACTIONS.KEEP, evidence: 'scripts/test-rbac-role-migration.mjs' },
  { job: 'direct-operations', step: 'User management controlled cutover', action: CI_SUPERSESSION_ACTIONS.KEEP, evidence: 'scripts/test-user-management-cutover.mjs' },
  { job: 'direct-operations', step: 'Authentication controlled cutover', action: CI_SUPERSESSION_ACTIONS.KEEP, evidence: 'scripts/test-auth-cutover.mjs' },
  { job: 'direct-operations', step: 'Authentication & User Management UI integration', action: CI_SUPERSESSION_ACTIONS.KEEP, evidence: 'scripts/test-auth-user-ui-integration.mjs' },

  { job: 'user-management-e2e', step: 'User management HTTP E2E', action: CI_SUPERSESSION_ACTIONS.KEEP, evidence: 'scripts/test-user-management-e2e.mjs' },
  { job: 'auth-cutover', step: 'Authentication controlled cutover', action: CI_SUPERSESSION_ACTIONS.KEEP, evidence: 'scripts/test-auth-cutover.mjs' },

  { job: 'next-backend-removal', step: 'Build frontend for the real Next.js production runtime proof', action: CI_SUPERSESSION_ACTIONS.ADDED, evidence: 'frontend/package.json' },
  { job: 'next-backend-removal', step: 'Phase 8.3 Next.js business backend removal acceptance', action: CI_SUPERSESSION_ACTIONS.ADDED, evidence: REMOVAL_SUITE },

  // Retired steps.
  { job: 'direct-operations', step: 'Platform services architecture freeze', action: CI_SUPERSESSION_ACTIONS.RETIRE, historicalEvidence: PHASE7_FREEZE_DOC },
  { job: 'auth-security', step: 'Authentication security integration', action: CI_SUPERSESSION_ACTIONS.RETIRE, historicalEvidence: AUTH_MODEL_DOC },
  { job: 'auth-go-parity', step: 'Authentication Go contract parity', action: CI_SUPERSESSION_ACTIONS.RETIRE, historicalEvidence: AUTH_ARCH_DOC },
  { job: 'platform-read-parity', step: 'Platform services Go read parity', action: CI_SUPERSESSION_ACTIONS.RETIRE, historicalEvidence: PHASE7_FREEZE_DOC },
  { job: 'platform-read-parity', step: 'Alert domain mutation parity', action: CI_SUPERSESSION_ACTIONS.RETIRE, historicalEvidence: PHASE7_FREEZE_DOC },
  { job: 'platform-read-parity', step: 'Notification streaming SSE parity', action: CI_SUPERSESSION_ACTIONS.RETIRE, historicalEvidence: PHASE7_FREEZE_DOC },
  { job: 'platform-read-parity', step: 'System integrity controlled remediation parity', action: CI_SUPERSESSION_ACTIONS.RETIRE, historicalEvidence: PHASE7_FREEZE_DOC },
  { job: 'platform-read-parity', step: 'Controlled platform services cutover', action: CI_SUPERSESSION_ACTIONS.RETIRE, historicalEvidence: PHASE7_FREEZE_DOC },
  { job: 'residual-api-parity', step: 'Phase 8.1 residual API parity', action: CI_SUPERSESSION_ACTIONS.RETIRE, historicalEvidence: PHASE81_DOC },
  { job: 'residual-api-parity', step: 'Build frontend for real Next.js retired-surface HTTP runtime verification', action: CI_SUPERSESSION_ACTIONS.REPLACE, replacement: REMOVAL_SUITE },
  { job: 'residual-api-parity', step: 'Phase 8.2 residual production cutover (real Next.js App Router HTTP evidence)', action: CI_SUPERSESSION_ACTIONS.RETIRE, historicalEvidence: PHASE82_DOC },
];

const RETIRED_SCRIPTS = TEST_SUPERSESSION_MANIFEST
  .filter((entry) => entry.action === SUPERSESSION_ACTIONS.RETIRE)
  .map((entry) => entry.path);

const repoPath = (repoRelative) => path.join(root, ...repoRelative.split('/'));
const repoExists = (repoRelative) => existsSync(repoPath(repoRelative));

/** Parse `git diff --name-status` output into `{ status, path }` records. */
function parseNameStatus(output) {
  const entries = [];
  for (const line of output.split('\n')) {
    const m = line.trim().match(/^([A-Z])\s+(.+)$/);
    if (m) entries.push({ status: m[1], path: m[2].trim().replaceAll('\\', '/') });
  }
  return entries;
}

/**
 * Reconcile the declared test supersession manifest against the artifacts the Phase 8.3 Git
 * delta actually touched. `exists` is injected so the negative sentinel can run purely in
 * memory instead of fabricating files.
 */
function reconcileTestSupersession(actualArtifacts, manifest, { exists }) {
  const actual = new Set(actualArtifacts);
  const manifested = new Set(manifest.map((entry) => entry.path));
  const unmapped = [...actual].filter((p) => !manifested.has(p)).sort();
  const missing = [...new Set(manifest.map((entry) => entry.path))].filter((p) => !actual.has(p)).sort();
  const replacementEvidenceMissing = [];
  const historicalEvidenceMissing = [];
  const reintroduced = [];

  for (const entry of manifest) {
    if (entry.action === SUPERSESSION_ACTIONS.RETIRE) {
      if (exists(entry.path)) reintroduced.push(entry.path);
      if (!entry.historicalEvidence) historicalEvidenceMissing.push(`${entry.path} (no historical evidence declared)`);
      else if (!exists(entry.historicalEvidence)) historicalEvidenceMissing.push(`${entry.path} -> ${entry.historicalEvidence}`);
      continue;
    }
    const target = entry.replacement || entry.path;
    if (!exists(target)) replacementEvidenceMissing.push(`${entry.path} -> ${target}`);
    if (entry.action !== SUPERSESSION_ACTIONS.REMOVE && !exists(entry.path)) {
      replacementEvidenceMissing.push(`${entry.path} (adapted artifact is absent)`);
    }
  }

  return { actual, manifested, unmapped, missing, replacementEvidenceMissing, historicalEvidenceMissing, reintroduced };
}

/** Minimal structural parser for the workflow file: jobs, job names, steps and step runs. */
function parseCiWorkflow(source) {
  const jobs = [];
  let current = null;
  let step = null;
  let inJobs = false;
  for (const raw of source.split('\n')) {
    if (/^jobs:\s*$/.test(raw)) { inJobs = true; continue; }
    if (!inJobs) continue;
    const jobKey = raw.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (jobKey) { current = { key: jobKey[1], name: '', steps: [] }; step = null; jobs.push(current); continue; }
    if (!current) continue;
    const jobName = raw.match(/^ {4}name:\s*(.+?)\s*$/);
    if (jobName) { current.name = jobName[1]; continue; }
    const stepName = raw.match(/^ {6}- name:\s*(.+?)\s*$/);
    if (stepName) { step = { name: stepName[1], run: '' }; current.steps.push(step); continue; }
    const runLine = raw.match(/^ {8}run:\s*(.*)$/);
    if (runLine && step) step.run = runLine[1].trim();
  }
  return jobs;
}

/**
 * Reconcile the declared CI supersession manifest against the live workflow: every current
 * contract must be present, every retired one must be gone, and every declared evidence
 * target must resolve.
 */
function reconcileCiSupersession(jobs, jobManifest, stepManifest, { exists }) {
  const PRESENT_ACTIONS = new Set([
    CI_SUPERSESSION_ACTIONS.KEEP,
    CI_SUPERSESSION_ACTIONS.ADAPT,
    CI_SUPERSESSION_ACTIONS.ADDED,
  ]);
  const jobKeys = new Set(jobs.map((j) => j.key));
  const stepKeys = new Set(jobs.flatMap((j) => j.steps.map((s) => `${j.key}/${s.name}`)));
  const contractSteps = jobs
    .flatMap((j) => j.steps.map((s) => ({ job: j.key, name: s.name })))
    .filter((s) => !CI_INFRA_STEPS.has(s.name));

  const expected = [
    ...jobManifest.filter((e) => PRESENT_ACTIONS.has(e.action)).map((e) => ({ kind: 'job', id: e.job, action: e.action })),
    ...stepManifest.filter((e) => PRESENT_ACTIONS.has(e.action)).map((e) => ({ kind: 'step', id: `${e.job}/${e.step}`, action: e.action })),
  ];
  const reconciled = [];
  const missing = [];
  for (const item of expected) {
    const present = item.kind === 'job' ? jobKeys.has(item.id) : stepKeys.has(item.id);
    if (present) reconciled.push(item.id); else missing.push(item.id);
  }

  const declaredJobs = new Set(jobManifest.map((e) => e.job));
  const declaredSteps = new Set(stepManifest.map((e) => `${e.job}/${e.step}`));
  const unexpected = [
    ...[...jobKeys].filter((k) => !declaredJobs.has(k)).map((k) => `job:${k}`),
    ...contractSteps.filter((s) => !declaredSteps.has(`${s.job}/${s.name}`)).map((s) => `step:${s.job}/${s.name}`),
  ];

  const replacementEvidenceMissing = [];
  const historicalEvidenceMissing = [];
  const reintroduced = [];
  for (const entry of [...jobManifest, ...stepManifest]) {
    const isJob = !('step' in entry);
    const id = isJob ? entry.job : `${entry.job}/${entry.step}`;
    const stillPresent = isJob ? jobKeys.has(entry.job) : stepKeys.has(id);
    if (entry.action === CI_SUPERSESSION_ACTIONS.RETIRE) {
      if (stillPresent) reintroduced.push(id);
      if (!entry.historicalEvidence) historicalEvidenceMissing.push(`${id} (no historical evidence declared)`);
      else if (!exists(entry.historicalEvidence)) historicalEvidenceMissing.push(`${id} -> ${entry.historicalEvidence}`);
      continue;
    }
    if (entry.action === CI_SUPERSESSION_ACTIONS.REPLACE) {
      if (stillPresent) reintroduced.push(id);
      if (!entry.replacement) replacementEvidenceMissing.push(`${id} (no replacement declared)`);
      else if (!exists(entry.replacement)) replacementEvidenceMissing.push(`${id} -> ${entry.replacement}`);
      continue;
    }
    const target = entry.evidence || entry.replacement;
    if (!target) replacementEvidenceMissing.push(`${id} (no current evidence declared)`);
    else if (!exists(target)) replacementEvidenceMissing.push(`${id} -> ${target}`);
  }

  return { expected, reconciled, missing, unexpected, replacementEvidenceMissing, historicalEvidenceMissing, reintroduced };
}

// ---------------------------------------------------------------------------
// Caller inventory (frontend_api_callers_unmapped)
// ---------------------------------------------------------------------------
const CALLER_DIRS = ['app', 'components', 'hooks', 'lib'];
const CALLER_EXCLUDE = [
  /\/app\/api\//,
  /lib\/cutover-routing\.ts$/,
];
const RETIRED_CALLER_TARGETS = ['/api/audit', '/api/approvals'];

function patternRegex(canonicalPath) {
  const escaped = canonicalPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const withParams = escaped.replace(/\\\{[^}]+\\\}/g, '[^/]+');
  return new RegExp(`^${withParams}$`);
}

function scanCallers() {
  const files = [];
  for (const dir of CALLER_DIRS) {
    const base = path.join(srcRoot, dir);
    if (!existsSync(base)) continue;
    files.push(...walk(base, (p) => CODE_EXT.test(p)));
  }
  const callers = [];
  const literalRe = /[`'"]([^`'"\n]*\/api\/[^`'"\n]*)[`'"]/g;
  for (const file of files) {
    const relFile = rel(file).replaceAll('\\', '/');
    if (CALLER_EXCLUDE.some((re) => re.test(relFile))) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, idx) => {
      let m;
      literalRe.lastIndex = 0;
      while ((m = literalRe.exec(line)) !== null) {
        const raw = m[1];
        if (!raw.includes('/api/')) continue;
        const noQuery = raw.split('?')[0];
        const normalised = noQuery.replace(/\$\{[^}]*\}/g, '*').replace(/\/+$/, '');
        if (!normalised.startsWith('/api/')) continue;
        callers.push({ file: relFile, line: idx + 1, literal: raw, normalised });
      }
    });
  }
  return callers;
}

// ---------------------------------------------------------------------------
// Next.js runtime session-store Mongo boundary
// ---------------------------------------------------------------------------
const BUSINESS_COLLECTIONS = new Set([
  'subscribers',
  'app_profiles',
  'profiles',
  'app_profile_versions',
  'app_ratings',
  'ratings',
  'ocs_tariff_plans',
  'ocs_subscribers',
  'ocs_balances',
  'ocs_sessions',
  'ocs_reservations',
  'ocs_usage',
  'ocs_usage_records',
  'ocs_events',
  'ocs_config',
  'ocs_balance_adjustments',
  'app_alerts',
  'alerts',
  'app_audit_logs',
  'app_approvals',
]);

const MONGO_OP_RE =
  /\.(findOneAndUpdate|findOneAndDelete|findOneAndReplace|findOne|find|insertMany|insertOne|updateMany|updateOne|replaceOne|deleteMany|deleteOne|bulkWrite|aggregate|countDocuments|distinct|estimatedDocumentCount|createIndexes|createIndex|drop)\s*\(/g;
const MONGO_READ_OPS = new Set(['findOne', 'find', 'aggregate', 'countDocuments', 'distinct', 'estimatedDocumentCount']);
const MONGO_WRITE_OPS = new Set([
  'findOneAndUpdate', 'findOneAndDelete', 'findOneAndReplace', 'insertOne', 'insertMany',
  'updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany', 'bulkWrite',
  'createIndex', 'createIndexes', 'drop',
]);

const MONGO_ACCESS_RE = /(?:getAppCollection|getXcloudCollection|getMongoCollection|\.collection)\s*(?:<[^>]*>)?\s*\(/;

/** Collection key -> physical name map, derived from the surviving mongo lib source. */
function loadCollectionMap() {
  const map = new Map();
  const mongoLibPath = path.join(srcRoot, 'lib', 'mongo.ts');
  if (!existsSync(mongoLibPath)) return map;
  const block = readFileSync(mongoLibPath, 'utf8').match(/mongoCollections\s*=\s*\{([\s\S]*?)\}\s*as const/);
  if (!block) return map;
  const re = /(\w+)\s*:\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(block[1])) !== null) map.set(m[1], m[2]);
  return map;
}

function scanNextBusinessMongo() {
  const collectionMap = loadCollectionMap();
  const files = walk(srcRoot, (p) => CODE_EXT.test(p)
    && !/lib[\\/]locales[\\/]/.test(p)
    && !/__tests__|\.test\.|\.spec\./.test(p));
  const readers = [];
  const writers = [];
  const accessFiles = [];
  for (const file of files) {
    const relFile = rel(file);
    const content = readFileSync(file, 'utf8');
    if (!MONGO_ACCESS_RE.test(content)) continue;
    accessFiles.push(relFile);
    const names = new Set();
    for (const m of content.matchAll(/mongoCollections\.(\w+)/g)) names.add(collectionMap.get(m[1]) ?? m[1]);
    for (const m of content.matchAll(/(?:getAppCollection|getXcloudCollection|getMongoCollection|\.collection)\s*(?:<[^>]*>)?\s*\(\s*['"]([^'"]+)['"]/g)) names.add(m[1]);
    const business = [...names].filter((name) => BUSINESS_COLLECTIONS.has(name));
    if (business.length === 0) continue;
    const ops = new Set();
    let om;
    MONGO_OP_RE.lastIndex = 0;
    while ((om = MONGO_OP_RE.exec(content)) !== null) ops.add(om[1]);
    if ([...ops].some((op) => MONGO_READ_OPS.has(op))) readers.push({ file: relFile, collections: business });
    if ([...ops].some((op) => MONGO_WRITE_OPS.has(op))) writers.push({ file: relFile, collections: business });
  }
  return { readers, writers, accessFiles };
}

/** Static read-only verification of the surviving proxy session-validation store. */
function scanSessionStore() {
  const sessionStorePath = path.join(srcRoot, 'lib', 'sessionAccountStore.ts');
  if (!existsSync(sessionStorePath)) return { present: false, readOnly: false, ops: [], collections: [] };
  const content = stripComments(readFileSync(sessionStorePath, 'utf8'));
  const ops = [];
  let m;
  MONGO_OP_RE.lastIndex = 0;
  while ((m = MONGO_OP_RE.exec(content)) !== null) ops.push(m[1]);
  const collections = [...content.matchAll(/mongoCollections\.(\w+)/g)].map((x) => x[1]);
  const readOnly = ops.length > 0 && ops.every((op) => MONGO_READ_OPS.has(op));
  const usersOnly = collections.length > 0 && collections.every((k) => k === 'users');
  const findOneOnly = ops.length > 0 && ops.every((op) => op === 'findOne');
  const referencesAppUsers = content.includes('app_users') || usersOnly;
  return { present: true, readOnly: readOnly && usersOnly && findOneOnly, ops, collections, referencesAppUsers };
}

// ---------------------------------------------------------------------------
// Go registration classification
// ---------------------------------------------------------------------------
const GO_REG_CLASS = {
  GO_NATIVE: 'GO_NATIVE_CUTOVER_OPERATION',
  UNCLASSIFIED: 'UNCLASSIFIED_GO_REGISTRATION',
};

function classifyGoRegistration(k, cutoverKeys) {
  if (cutoverKeys.has(k)) return GO_REG_CLASS.GO_NATIVE;
  return GO_REG_CLASS.UNCLASSIFIED;
}

const GO_SENTINEL_KEY = 'GET /api/__phase83_unclassified_sentinel__';

// ---------------------------------------------------------------------------
// Frontend build + servers
// ---------------------------------------------------------------------------

function ensureFrontendBuild() {
  const buildId = path.join(frontendRoot, '.next', 'BUILD_ID');
  if (existsSync(buildId) && !process.env.P83_FORCE_FRONTEND_BUILD) {
    console.log('  reusing existing frontend production build (.next/BUILD_ID present)');
    return;
  }
  console.log('  building frontend production bundle (next build)...');
  execSync('npm run build', { cwd: frontendRoot, stdio: 'inherit' });
}

async function startNextServer(port, extraEnv = {}) {
  const nextBin = path.join(frontendRoot, 'node_modules', 'next', 'dist', 'bin', 'next');
  const proc = spawn(process.execPath, [nextBin, 'start', '-p', String(port), '-H', '127.0.0.1'], {
    cwd: frontendRoot,
    env: { ...process.env, NODE_ENV: 'production', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (chunk) => nextStdout.push(chunk.toString()));
  proc.stderr.on('data', (chunk) => nextStdout.push(chunk.toString()));

  let ready = false;
  for (let i = 0; i < 400; i++) {
    if (proc.exitCode !== null) break;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/login`, { redirect: 'manual' });
      const ok = res.status > 0;
      try { await res.body?.cancel(); } catch {}
      if (ok) { ready = true; break; }
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!ready) {
    throw new Error(`real Next.js server failed to become ready on 127.0.0.1:${port}\n${nextStdout.join('')}`);
  }
  nextProcs.push(proc);
  return proc;
}

function stopProcess(proc) {
  if (!proc || !proc.pid) return;
  if (process.platform === 'win32') {
    try { execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: 'ignore' }); } catch {}
  } else {
    try { proc.kill('SIGTERM'); } catch {}
  }
}

function makeToken(username, role, sv, expiresInSec = 3600) {
  return new SignJWT({ username, role, sv })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt(Math.floor(Date.now() / 1000))
    .setExpirationTime(Math.floor(Date.now() / 1000) + expiresInSec)
    .sign(getJwtSecretKey());
}

/**
 * Real HTTP probe against the running Next.js production server. SSE responses are
 * recognised by content-type and their body cancelled (never awaited to completion).
 */
async function httpProbe(method, port, pathname, { token, body, timeoutMs = 20000 } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.cookie = `auth_token=${token}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'manual',
      signal: controller.signal,
    });
    const contentType = res.headers.get('content-type') || '';
    let text = '';
    if (contentType.includes('text/event-stream')) {
      try { await res.body?.cancel(); } catch {}
    } else {
      try { text = await res.text(); } catch {}
    }
    return { ok: true, status: res.status, text, contentType };
  } catch (err) {
    return { ok: false, status: 0, text: '', contentType: '', error: String(err && err.message ? err.message : err) };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Test-side capture proxy (faithful pipe; measures only)
// ---------------------------------------------------------------------------
function createCaptureProxy(targetPort) {
  const counts = new Map();
  const server = http.createServer((req, res) => {
    const pathname = (req.url || '').split('?')[0];
    const k = key(req.method, pathname);
    counts.set(k, (counts.get(k) || 0) + 1);
    const upstream = http.request(
      { host: '127.0.0.1', port: targetPort, method: req.method, path: req.url, headers: req.headers },
      (upRes) => {
        res.writeHead(upRes.statusCode || 502, upRes.headers);
        upRes.pipe(res);
      },
    );
    res.on('close', () => { if (!upstream.destroyed) upstream.destroy(); });
    req.socket?.on('close', () => { if (!upstream.destroyed) upstream.destroy(); });
    upstream.on('error', () => {
      try {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'capture proxy upstream error' }));
      } catch {}
    });
    req.pipe(upstream);
  });
  return {
    server,
    reset() { counts.clear(); },
    countOf(method, pathname) { return counts.get(key(method, pathname)) || 0; },
    totalRequests() {
      let n = 0;
      for (const v of counts.values()) n += v;
      return n;
    },
  };
}

// ---------------------------------------------------------------------------
// MongoDB fingerprints + fixtures
// ---------------------------------------------------------------------------
async function businessStateFingerprint() {
  const aDb = client.db(appDbName);
  const xDb = client.db(xcloudDbName);
  const rateDocs = await aDb.collection('app_rate_limits').find({}).toArray();
  return {
    auditTotal: await aDb.collection('app_audit_logs').countDocuments(),
    rateLimitTotal: rateDocs.reduce((sum, d) => sum + (typeof d.count === 'number' ? d.count : 0), 0),
    ratings: await aDb.collection('app_ratings').countDocuments(),
    profiles: await aDb.collection('app_profiles').countDocuments(),
    profileVersions: await aDb.collection('app_profile_versions').countDocuments(),
    subscribers: await xDb.collection('subscribers').countDocuments(),
    ocsSubscribers: await xDb.collection('ocs_subscribers').countDocuments(),
    ocsBalances: await xDb.collection('ocs_balances').countDocuments(),
    tariffPlans: await xDb.collection('ocs_tariff_plans').countDocuments(),
    reservations: await xDb.collection('ocs_reservations').countDocuments(),
  };
}

async function userManagementFingerprint() {
  const aDb = client.db(appDbName);
  const users = await aDb.collection('app_users').find({}).sort({ username: 1 }).toArray();
  return {
    users: users.length,
    digest: users.map((u) => [
      u.username,
      u.role,
      u.status,
      u.locked ? 1 : 0,
      u.security?.sessionVersion ?? '',
      u.security?.failedLoginAttempts ?? '',
      u.passwordChangedAt ?? '',
      u.updatedAt ?? '',
    ].join('|')).join(';'),
  };
}

async function seed() {
  const xDb = client.db(xcloudDbName);
  const aDb = client.db(appDbName);
  const hash = await bcrypt.hash('P83Pass123!', 10);
  const now = new Date().toISOString();

  await aDb.collection('app_users').insertMany([
    { username: 'p83_admin', passwordHash: hash, role: 'admin', status: 'active', displayName: 'P83 Admin', email: 'p83admin@test.local', createdAt: now, updatedAt: now, security: { sessionVersion: 1, failedLoginAttempts: 0 } },
    { username: 'p83_viewer', passwordHash: hash, role: 'viewer', status: 'active', displayName: 'P83 Viewer', email: 'p83viewer@test.local', createdAt: now, updatedAt: now, security: { sessionVersion: 1, failedLoginAttempts: 0 } },
  ]);

  await aDb.collection('app_profiles').insertOne({ name: 'default', title: 'Default Profile', created_at: now });
  await xDb.collection('ocs_tariff_plans').insertOne({
    plan_id: 'default-standard',
    name: 'Standard Default Tariff Plan',
    status: 'enabled',
    version: 1,
    rules: [{ rule_id: 'rule-01', charging_type: 'data_volume', rating_group: 1 }],
  });
  await xDb.collection('subscribers').insertOne({
    imsi: '001010000000001',
    security: { k: '465B5CE8B199B49FAA5F0A2EE238A6BC', opc: 'E8ED289DEBA952E4283B54E88E6183CA' },
    slice: [{ sst: 1, session_list: [{ name: 'sess-1', pcc_rule: [{}] }] }],
    ambr: { dl: 10000000, ul: 10000000 },
    profile: 'default',
  });
  await xDb.collection('ocs_subscribers').insertOne({ imsi: '001010000000001', plan_id: 'default-standard', status: 'active', version: 1 });
  await xDb.collection('ocs_balances').insertOne({
    imsi: '001010000000001', version: 1,
    data_total: 1000000, data_used: 200000, data_reserved: 100000, data_available: 700000,
    voice_total: 1000, voice_used: 200, voice_reserved: 100, voice_available: 700,
    sms_total: 500, sms_used: 50, sms_available: 450,
  });
  await xDb.collection('ocs_sessions').insertOne({ session_id: 'sess-active-01', state: 'active', imsi: '001010000000001' });
  await xDb.collection('ocs_reservations').insertOne({ reservation_id: 'res-active-01', imsi: '001010000000001', state: 'active' });
  await aDb.collection('app_audit_logs').insertOne({ action: 'system.bootstrap', module: 'system', timestamp: now });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('-- Phase 8.3 Next.js Business Backend Removal Acceptance Suite --\n');
  console.log(`  test Mongo URI: ${uri}`);

  // ---- Mongo gate (REQUIRED) ------------------------------------------------
  try {
    await client.connect();
    await client.db('admin').command({ ping: 1 });
  } catch (err) {
    console.error('');
    console.error('FATAL: MongoDB is not reachable.');
    console.error(`  MONGODB_URI = ${uri}`);
    console.error(`  set MONGODB_URI (or P83_TEST_MONGODB_URI) to a reachable MongoDB instance.`);
    console.error(`  cause: ${err && err.message ? err.message : err}`);
    process.exit(1);
  }
  await seed();

  // ===========================================================================
  // Static source evidence
  // ===========================================================================
  const { files: apiFiles, ops: apiOps } = scanApiTree();
  const nodeServerTreeFiles = walk(serverRoot, () => true).length;
  const { hits: serverImportHits, literalOnly: serverImportLiterals } = scanActiveServerImports();
  const { serverAlias, apiAlias } = scanAliasImports();
  const goRegs = loadGoRegistrations();

  const nextApiRouteFiles = apiFiles.length;
  const nextApiOperations = apiOps.length;
  const activeServerImports = serverImportHits.length;
  const removalReferenceLiterals = serverImportLiterals.length;

  // Derived routing sets.
  const cutoverKeys = new Set(CUTOVER_TABLE.map((r) => key(r.method, r.path)));
  const cutoverByKey = new Map(CUTOVER_TABLE.map((r) => [key(r.method, r.path), r]));
  const goKeys = new Set(goRegs.map((r) => key(r.method, r.canonicalPath)));

  // ---------------------------------------------------------------------------
  console.log('\n[1] Source-Removal Invariants (P83-S)');

  await check('P83-S01 removed Next.js API tree derives 0 route files and 0 operations', () => {
    assert.equal(existsSync(apiRoot), false, `the App Router API tree must be absent: ${rel(apiRoot)}`);
    assert.equal(nextApiRouteFiles, 0, `next_api_route_files must derive 0, found ${nextApiRouteFiles}`);
    assert.equal(nextApiOperations, 0, `next_api_operations must derive 0, found ${nextApiOperations}`);
  });

  await check('P83-S02 removed Next.js server tree derives 0 files', () => {
    assert.equal(existsSync(serverRoot), false, `the Next.js server tree must be absent: ${rel(serverRoot)}`);
    assert.equal(nodeServerTreeFiles, 0, `node_server_tree_files must derive 0, found ${nodeServerTreeFiles}`);
  });

  await check('P83-S03 zero real dependency edges on the removed Next.js server tree', () => {
    assert.equal(activeServerImports, 0,
      `active_server_imports must be 0; found: ${serverImportHits.map((h) => `${h.file}:${h.line}`).join(', ')}`);
  });

  await check('P83-S04 no surviving frontend/src file imports @/server or @/app/api', () => {
    assert.equal(serverAlias.length, 0, `@/server imports: ${serverAlias.join(', ')}`);
    assert.equal(apiAlias.length, 0, `@/app/api imports: ${apiAlias.join(', ')}`);
  });

  await check('P83-S05 mongodb / jose / bcryptjs still declared in both manifests', () => {
    const rootPkg = declaredDependencies(readJson(path.join(root, 'package.json')));
    const frontendPkg = declaredDependencies(readJson(path.join(frontendRoot, 'package.json')));
    for (const mod of ['mongodb', 'jose', 'bcryptjs']) {
      assert.ok(rootPkg[mod], `${mod} must remain declared in package.json`);
      assert.ok(frontendPkg[mod], `${mod} must remain declared in frontend/package.json`);
    }
  });

  const BASELINE_SHA = '6a8352dc3892957e12751f14182328f054fc42ff';

  // The baseline commit must be resolvable in the local clone (CI must not use a shallow
  // checkout). Probed without throwing so every later P83 group still runs and reports.
  const gitProbe = (args) => {
    try {
      return { ok: true, out: execSync(`git ${args}`, { cwd: root, encoding: 'utf8' }).trim() };
    } catch (err) {
      return { ok: false, out: '', error: String(err.stderr || err.stdout || err.message).trim() };
    }
  };

  const baselineResolved = gitProbe(`cat-file -t ${BASELINE_SHA}`);

  // Only test-scoped Go paths may differ from the frozen baseline: the cross-language
  // fixture had to move out of the removed Next.js server tree for `go test` to run.
  const backendTestOnlyPath = (file) => file.endsWith('_test.go') || file.includes('/testdata/');

  const manifestDiff = gitProbe(
    `diff --name-only --no-renames ${BASELINE_SHA}..HEAD -- frontend/package.json frontend/package-lock.json`,
  );
  const backendDiff = gitProbe(`diff --name-only --no-renames ${BASELINE_SHA}..HEAD -- backend`);

  const frontendManifestChanged = manifestDiff.ok ? manifestDiff.out : '';
  const backendChangedFiles = backendDiff.ok
    ? backendDiff.out.split('\n').map((line) => line.trim()).filter(Boolean)
    : [];
  const backendProductionChanges = backendChangedFiles.filter((file) => !backendTestOnlyPath(file));

  await check('P83-S06 package manifests unchanged and only test-scoped Go changes vs the Phase 8.3 baseline SHA', () => {
    assert.ok(
      baselineResolved.ok && baselineResolved.out === 'commit',
      `baseline commit ${BASELINE_SHA} must be present locally: ${baselineResolved.error}`,
    );
    assert.ok(
      manifestDiff.ok && backendDiff.ok,
      `baseline diff must be computable: ${manifestDiff.error || backendDiff.error}`,
    );
    assert.equal(frontendManifestChanged, '', `frontend manifests changed vs baseline: ${frontendManifestChanged}`);
    assert.equal(
      backendProductionChanges.length,
      0,
      `production Go tree changed vs baseline: ${backendProductionChanges.join(', ')}`,
    );
  });

  await check('P83-S07 every Go change vs the baseline is test-scoped', () => {
    const offenders = backendChangedFiles.filter((file) => !backendTestOnlyPath(file));
    assert.equal(offenders.length, 0, `non-test Go changes: ${offenders.join(', ')}`);
  });

  // ---------------------------------------------------------------------------
  console.log('\n[2] API Route Absence (P83-A)');

  await check('P83-A01 app/api directory is physically absent', () => {
    assert.equal(existsSync(apiRoot), false, `${rel(apiRoot)} must not exist`);
  });

  await check('P83-A02 zero route.ts / route.js files under the API tree', () => {
    assert.equal(nextApiRouteFiles, 0, `found ${nextApiRouteFiles} route files`);
  });

  await check('P83-A03 zero HTTP method exports under the API tree', () => {
    assert.equal(nextApiOperations, 0, `found ${nextApiOperations} operations`);
  });

  // ---------------------------------------------------------------------------
  console.log('\n[3] Server Business Tree Absence (P83-B)');

  await check('P83-B01 frontend/src/server directory is physically absent', () => {
    assert.equal(existsSync(serverRoot), false, `${rel(serverRoot)} must not exist`);
  });

  await check('P83-B02 zero surviving files under the removed server tree', () => {
    assert.equal(nodeServerTreeFiles, 0, `found ${nodeServerTreeFiles} files`);
  });

  // ---------------------------------------------------------------------------
  console.log('\n[4] Proxy / Session Preservation (P83-P)');

  const proxySource = readFileSync(path.join(srcRoot, 'proxy.ts'), 'utf8');
  const sessionStore = scanSessionStore();
  const accountSessionSource = readFileSync(path.join(srcRoot, 'lib', 'accountSession.ts'), 'utf8');

  await check('P83-P01 proxy verifies JWT before Mongo revalidation before binding identity headers', () => {
    const iVerify = proxySource.indexOf('jwtVerify');
    const iValidate = proxySource.indexOf('validateCurrentAccount');
    const iHeader = proxySource.indexOf("requestHeaders.set('x-user'");
    assert.ok(iVerify >= 0, 'jwtVerify must be present');
    assert.ok(iValidate >= 0, 'validateCurrentAccount must be present');
    assert.ok(iHeader >= 0, "x-user header assignment must be present");
    assert.ok(iVerify < iValidate, 'jwtVerify must precede validateCurrentAccount');
    assert.ok(iValidate < iHeader, 'validateCurrentAccount must precede the x-user header binding');
  });

  await check('P83-P02 proxy pins HS256 and never casts the JWT role', () => {
    assert.ok(proxySource.includes("algorithms: ['HS256']"), 'HS256 algorithm must be pinned');
    assert.equal(proxySource.includes('payload.role as string'), false, 'payload.role must never be cast');
  });

  await check('P83-P03 proxy keeps the fail-closed GO_BACKEND_UNREACHABLE branch', () => {
    assert.ok(proxySource.includes('GO_BACKEND_UNREACHABLE'), 'GO_BACKEND_UNREACHABLE must be present');
    assert.ok(proxySource.includes('AUTH_UNAVAILABLE'), 'the non-auth 503 branch must be present');
  });

  await check('P83-P04 session store is present, read-only and scoped to app_users', () => {
    const storeSource = readFileSync(path.join(srcRoot, 'lib', 'sessionAccountStore.ts'), 'utf8');
    assert.ok(storeSource.includes('findOne'), 'session store must read via findOne');
    const writeOp = /\b(insertOne|insertMany|updateOne|updateMany|replaceOne|deleteOne|deleteMany|bulkWrite|findOneAndUpdate|findOneAndDelete|createIndex|drop)\s*\(/;
    assert.equal(writeOp.test(storeSource), false, 'session store must contain no write operations');
    assert.ok(storeSource.includes('app_users') || storeSource.includes('users'), 'session store must reference app_users');
    assert.equal(sessionStore.present, true, 'session store must be present');
    assert.equal(sessionStore.readOnly, true, `session store must be read-only (ops=${sessionStore.ops.join(',')})`);
    assert.equal(sessionStore.referencesAppUsers, true, 'session store must target the users collection');
  });

  await check('P83-P05 session regression matrix (validateAccountSnapshot)', () => {
    const active = { username: 'p83_admin', role: 'admin', status: 'active', security: { sessionVersion: 1 } };
    const claims = { username: 'p83_admin', role: 'admin', sv: 1 };

    const accepted = validateAccountSnapshot(claims, active);
    assert.equal(accepted.username, 'p83_admin', 'active account with matching claims must be accepted');

    const expectCode = (fn, code, label) => {
      try {
        fn();
      } catch (err) {
        assert.ok(err instanceof AccountSessionError, `${label}: expected AccountSessionError`);
        assert.equal(err.code, code, `${label}: expected ${code}, got ${err.code}`);
        return;
      }
      assert.fail(`${label}: expected ${code} but call succeeded`);
    };

    expectCode(() => validateAccountSnapshot(claims, null), 'ACCOUNT_NOT_FOUND', 'missing account');
    expectCode(() => validateAccountSnapshot(claims, { ...active, status: 'disabled' }), 'ACCOUNT_DISABLED', 'disabled account');
    expectCode(() => validateAccountSnapshot(claims, { ...active, status: 'locked' }), 'ACCOUNT_LOCKED', 'locked status');
    expectCode(() => validateAccountSnapshot(claims, { ...active, locked: true }), 'ACCOUNT_LOCKED', 'locked flag');
    expectCode(
      () => validateAccountSnapshot(claims, { ...active, security: { sessionVersion: 2 } }),
      'SESSION_REVOKED',
      'session version mismatch',
    );
    expectCode(
      () => validateAccountSnapshot(claims, { ...active, role: 'viewer' }),
      'SESSION_REVOKED',
      'role mismatch',
    );
    expectCode(() => validateAccountSnapshot({}, active), 'AUTH_INVALID_TOKEN', 'malformed claims');
  });

  await check('P83-P06 proxy session-validation contract is wired end to end', () => {
    assert.ok(proxySource.includes('validateCurrentAccount'), 'proxy must call validateCurrentAccount');
    assert.ok(accountSessionSource.includes('validateCurrentAccount'), 'accountSession must export validateCurrentAccount');
    assert.ok(proxySource.includes("from '@/lib/accountSession'"), 'proxy must import the account session module');
  });

  // ---------------------------------------------------------------------------
  console.log('\n[5] CI / Test Supersession Integrity (P83-C)');

  const ciSource = existsSync(ciPath) ? readFileSync(ciPath, 'utf8') : '';
  const stillPresent = RETIRED_SCRIPTS.filter((s) => existsSync(path.join(root, s)));
  const stillReferenced = RETIRED_SCRIPTS.filter((s) => ciSource.includes(path.basename(s)));

  await check('P83-C01 all retired phase 7/8 test harness scripts are gone from disk', () => {
    assert.equal(stillPresent.length, 0, `retired scripts still present: ${stillPresent.join(', ')}`);
  });

  await check('P83-C02 CI no longer references any retired script', () => {
    assert.equal(stillReferenced.length, 0, `CI still references: ${stillReferenced.join(', ')}`);
  });

  await check('P83-C03 CI exposes the Phase 8.3 removal job and this suite', () => {
    assert.ok(ciSource.includes('Phase 8.3 Next.js business backend removal'), 'Phase 8.3 job name must be visible');
    assert.ok(ciSource.includes('scripts/test-phase-8-next-backend-removal.mjs'), 'CI must run this suite');
  });

  await check('P83-C04 historical pre-deletion surface constants are recorded', () => {
    assert.equal(PHASE83_START_API_ROUTE_FILES, 54, 'historical api route file count must be 54');
    assert.equal(PHASE83_START_API_OPERATIONS, 72, 'historical api operation count must be 72');
  });

  // ---- Derived supersession reconciliation ----------------------------------
  // The Phase 8.3 transitions are reconciled against the real Git delta and the live
  // workflow. Nothing below is hard-coded: unmapped / missing / evidence gaps are computed
  // set relationships, and the negative sentinels prove the classifiers can fail.
  const SUPERSESSION_SCOPE = ['frontend/tests', 'scripts', '.github/workflows/ci.yml'];
  const deltaProbe = gitProbe(
    `diff --name-status --no-renames ${BASELINE_SHA}..HEAD -- ${SUPERSESSION_SCOPE.join(' ')}`,
  );
  const deltaEntries = deltaProbe.ok ? parseNameStatus(deltaProbe.out) : [];
  const changedArtifacts = deltaEntries
    .map((e) => e.path)
    .filter((p) => p.startsWith('frontend/tests/') || p.startsWith('scripts/'))
    .sort();
  const ciWorkflowChanged = deltaEntries.some((e) => e.path === '.github/workflows/ci.yml');

  const testSupersession = reconcileTestSupersession(
    changedArtifacts,
    TEST_SUPERSESSION_MANIFEST,
    { exists: repoExists },
  );

  const ciJobs = parseCiWorkflow(ciSource);
  const ciSupersession = reconcileCiSupersession(
    ciJobs,
    CI_JOB_MANIFEST,
    CI_STEP_MANIFEST,
    { exists: repoExists },
  );

  let testSupersessionNegativeSentinel = false;
  let ciSupersessionNegativeSentinel = false;

  await check('P83-C05 the Phase 8.3 Git delta against the frozen predecessor is computable', () => {
    assert.ok(
      baselineResolved.ok && baselineResolved.out === 'commit',
      `baseline commit ${BASELINE_SHA} must be present locally: ${baselineResolved.error}`,
    );
    assert.ok(deltaProbe.ok, `the supersession delta must be computable: ${deltaProbe.error}`);
    assert.ok(changedArtifacts.length > 0, 'the delta must contain test or script artifacts');
    assert.ok(ciWorkflowChanged, 'the CI workflow must be part of the Phase 8.3 delta');
  });

  await check('P83-C06 test supersession manifest reconciles with the real delta by exact path identity', () => {
    assert.equal(testSupersession.unmapped.length, 0,
      `changed test artifacts outside the manifest: ${testSupersession.unmapped.join(', ')}`);
    assert.equal(testSupersession.missing.length, 0,
      `manifest entries that did not participate in the delta: ${testSupersession.missing.join(', ')}`);
    assert.equal(testSupersession.reintroduced.length, 0,
      `retired artifacts still present on disk: ${testSupersession.reintroduced.join(', ')}`);
  });

  await check('P83-C07 every test supersession entry resolves its current or historical evidence target', () => {
    assert.equal(testSupersession.replacementEvidenceMissing.length, 0,
      `unresolvable current evidence: ${testSupersession.replacementEvidenceMissing.join(', ')}`);
    assert.equal(testSupersession.historicalEvidenceMissing.length, 0,
      `unresolvable historical evidence: ${testSupersession.historicalEvidenceMissing.join(', ')}`);
  });

  await check('P83-C08 negative sentinel: the test coverage classifier is not tautological', () => {
    const synthetic = reconcileTestSupersession(
      [...changedArtifacts, 'frontend/tests/p83_synthetic_unmapped.test.mjs'],
      [
        ...TEST_SUPERSESSION_MANIFEST,
        { path: 'frontend/tests/p83_synthetic_manifest_only.test.mjs', action: SUPERSESSION_ACTIONS.ADAPT },
        { path: 'frontend/tests/p83_synthetic_evidence.test.mjs', action: SUPERSESSION_ACTIONS.ADAPT, replacement: 'scripts/p83-synthetic-missing-evidence.mjs' },
      ],
      { exists: repoExists },
    );
    assert.ok(synthetic.unmapped.includes('frontend/tests/p83_synthetic_unmapped.test.mjs'),
      'an undeclared changed artifact must be reported as unmapped');
    assert.ok(synthetic.missing.includes('frontend/tests/p83_synthetic_manifest_only.test.mjs'),
      'a declared artifact absent from the delta must be reported as missing');
    assert.ok(synthetic.replacementEvidenceMissing.some((e) => e.includes('p83_synthetic_evidence')),
      'an unresolvable evidence target must be reported');
    testSupersessionNegativeSentinel = true;
  });

  await check('P83-C09 CI supersession manifest reconciles with the live workflow', () => {
    assert.ok(ciSupersession.expected.length > 0, 'the CI manifest must declare current runtime contracts');
    assert.equal(ciSupersession.missing.length, 0,
      `declared current CI contracts absent from the workflow: ${ciSupersession.missing.join(', ')}`);
    assert.equal(ciSupersession.unexpected.length, 0,
      `undeclared CI contracts present in the workflow: ${ciSupersession.unexpected.join(', ')}`);
    assert.equal(ciSupersession.reintroduced.length, 0,
      `retired CI jobs or steps still present: ${ciSupersession.reintroduced.join(', ')}`);
    assert.equal(ciSupersession.reconciled.length, ciSupersession.expected.length,
      'every expected current contract must reconcile');
  });

  await check('P83-C10 every CI supersession entry resolves its current or historical evidence target', () => {
    assert.equal(ciSupersession.replacementEvidenceMissing.length, 0,
      `unresolvable CI replacement evidence: ${ciSupersession.replacementEvidenceMissing.join(', ')}`);
    assert.equal(ciSupersession.historicalEvidenceMissing.length, 0,
      `unresolvable CI historical evidence: ${ciSupersession.historicalEvidenceMissing.join(', ')}`);
  });

  await check('P83-C11 negative sentinel: the CI coverage classifier is not tautological', () => {
    const synthetic = reconcileCiSupersession(
      [{
        key: 'node',
        name: 'Node quality gates',
        steps: [
          { name: 'Lint', run: 'npm run lint' },
          { name: 'Platform services architecture freeze', run: 'node scripts/test-phase-7-architecture-freeze.mjs' },
          { name: 'Undeclared extra step', run: 'true' },
        ],
      }],
      [{ job: 'node', action: CI_SUPERSESSION_ACTIONS.KEEP, evidence: 'frontend/package.json' }],
      [
        { job: 'node', step: 'Lint', action: CI_SUPERSESSION_ACTIONS.KEEP, evidence: 'frontend/package.json' },
        { job: 'node', step: 'Missing current step', action: CI_SUPERSESSION_ACTIONS.ADAPT, evidence: 'frontend/package.json' },
        { job: 'node', step: 'Platform services architecture freeze', action: CI_SUPERSESSION_ACTIONS.RETIRE },
      ],
      { exists: repoExists },
    );
    assert.deepEqual(synthetic.missing, ['node/Missing current step'],
      'an absent declared contract must be reported as missing');
    assert.ok(synthetic.unexpected.includes('step:node/Undeclared extra step'),
      'an undeclared workflow step must be reported as unexpected');
    assert.ok(synthetic.reintroduced.includes('node/Platform services architecture freeze'),
      'a retired workflow item that is still present must be reported');
    assert.ok(synthetic.historicalEvidenceMissing.some((e) => e.includes('Platform services architecture freeze')),
      'a retired item without resolvable evidence must be reported');
    ciSupersessionNegativeSentinel = true;
  });

  const unexplainedTestCoverageLoss = testSupersession.unmapped.length
    + testSupersession.missing.length
    + testSupersession.replacementEvidenceMissing.length
    + testSupersession.historicalEvidenceMissing.length
    + testSupersession.reintroduced.length;

  const ciCoverageGaps = ciSupersession.missing.length
    + ciSupersession.unexpected.length
    + ciSupersession.replacementEvidenceMissing.length
    + ciSupersession.historicalEvidenceMissing.length
    + ciSupersession.reintroduced.length
    + stillPresent.length
    + stillReferenced.length;

  await check('P83-C12 coverage losses are derived from the reconciliation and are genuinely zero', () => {
    assert.equal(unexplainedTestCoverageLoss, 0, `unexplained_test_coverage_loss=${unexplainedTestCoverageLoss}`);
    assert.equal(ciCoverageGaps, 0, `ci_coverage_gaps=${ciCoverageGaps}`);
    assert.ok(testSupersessionNegativeSentinel && ciSupersessionNegativeSentinel,
      'both negative supersession sentinels must have passed');
  });

  // ---------------------------------------------------------------------------
  console.log('\n[6] Go Registration Equality (P83-G)');

  const goRegisteredUnrouted = [...goKeys].filter((k) => !cutoverKeys.has(k)).sort();
  const cutoverWithoutGoRegistration = [...cutoverKeys].filter((k) => !goKeys.has(k)).sort();
  const goUnclassified = goRegs
    .map((r) => ({ key: key(r.method, r.canonicalPath), category: classifyGoRegistration(key(r.method, r.canonicalPath), cutoverKeys) }))
    .filter((r) => r.category === GO_REG_CLASS.UNCLASSIFIED);

  await check('P83-G01 CUTOVER_TABLE length equals the Phase 8.3 contract size', () => {
    assert.equal(CUTOVER_TABLE.length, PHASE83_CUTOVER_TABLE_SIZE,
      `CUTOVER_TABLE must hold ${PHASE83_CUTOVER_TABLE_SIZE} routes, found ${CUTOVER_TABLE.length}`);
    assert.equal(CUTOVER_TABLE.filter((r) => r.owner === 'go').length, CUTOVER_TABLE.length, 'every entry must be owner=go');
  });

  await check('P83-G02 Go production registration set exactly equals the CUTOVER_TABLE set', () => {
    assert.equal(goKeys.size, goRegs.length, `duplicate Go registrations detected (${goRegs.length} vs ${goKeys.size})`);
    assert.equal(goKeys.size, cutoverKeys.size, `go_registered_operations=${goKeys.size} cutover=${cutoverKeys.size}`);
    for (const k of cutoverKeys) assert.ok(goKeys.has(k), `cutover route without a Go registration: ${k}`);
    for (const k of goKeys) assert.ok(cutoverKeys.has(k), `Go registration outside CUTOVER_TABLE: ${k}`);
    assert.equal(cutoverWithoutGoRegistration.length, 0, 'cutover_without_go_registration must be 0');
    assert.equal(goRegisteredUnrouted.length, 0, 'go_registered_unrouted must be 0');
    assert.equal(goUnclassified.length, 0, 'go_registered_unclassified must be 0');
  });

  await check('P83-G03 negative sentinel: an unknown registration is genuinely unclassified', () => {
    assert.equal(classifyGoRegistration(GO_SENTINEL_KEY, cutoverKeys), GO_REG_CLASS.UNCLASSIFIED,
      `synthetic ${GO_SENTINEL_KEY} must classify as ${GO_REG_CLASS.UNCLASSIFIED}`);
    assert.equal(goKeys.has(GO_SENTINEL_KEY), false, 'the synthetic sentinel must never be a real Go registration');
  });

  // ---------------------------------------------------------------------------
  console.log('\n[7] Mongo Session-Store Boundary (P83-M)');

  const mongoAccess = scanNextBusinessMongo();
  const allowedMongoFiles = new Set([
    rel(path.join(srcRoot, 'lib', 'mongo.ts')),
    rel(path.join(srcRoot, 'lib', 'sessionAccountStore.ts')),
  ]);
  const unexpectedMongoFiles = mongoAccess.accessFiles.filter((f) => !allowedMongoFiles.has(f));

  await check('P83-M01 every surviving Next.js Mongo access is the mongo lib or the session store', () => {
    assert.equal(unexpectedMongoFiles.length, 0,
      `unexpected Mongo access files: ${unexpectedMongoFiles.join(', ')}`);
  });

  await check('P83-M02 surviving Next.js production source performs zero business Mongo reads/writes', () => {
    assert.equal(mongoAccess.readers.length, 0, `business readers: ${mongoAccess.readers.map((r) => r.file).join(', ')}`);
    assert.equal(mongoAccess.writers.length, 0, `business writers: ${mongoAccess.writers.map((w) => w.file).join(', ')}`);
  });

  await check('P83-M03 the proxy session store is the only Mongo reader and never writes', () => {
    assert.equal(sessionStore.readOnly, true, 'session store must be read-only');
    assert.equal(sessionStore.ops.every((op) => MONGO_READ_OPS.has(op)), true, 'session store ops must all be reads');
  });

  const nextBusinessMongoReaders = mongoAccess.readers.length;
  const nextBusinessMongoWriters = mongoAccess.writers.length;
  const proxySessionMongoReaders = sessionStore.present && sessionStore.readOnly ? 1 : 0;
  const proxySessionMongoWriters = sessionStore.ops.some((op) => MONGO_WRITE_OPS.has(op)) ? 1 : 0;

  await check('P83-M04 proxy session store is the only sanctioned reader and never writes', () => {
    assert.ok(proxySessionMongoReaders > 0, 'proxy_session_mongo_readers must be non-zero');
    assert.equal(proxySessionMongoWriters, 0, 'proxy_session_mongo_writers must be 0');
  });
  console.log(`  proxy_session_mongo_readers=${proxySessionMongoReaders} proxy_session_mongo_writers=${proxySessionMongoWriters}`);

  // ---------------------------------------------------------------------------
  console.log('\n[8] Real Production Stack (Go binary + capture proxy + Next.js)');

  const backendDir = path.join(root, 'backend');
  const isWin = process.platform === 'win32';
  binPath = path.join(backendDir, isWin ? `test-p83-removal-${suffix}.exe` : `test-p83-removal-${suffix}`);
  execSync(`go build -o "${binPath}" ./cmd/server`, { cwd: backendDir, stdio: 'ignore' });

  goPort = await getAvailablePort();
  goProc = spawn(binPath, [], {
    cwd: backendDir,
    env: {
      ...process.env,
      HTTP_ADDR: `127.0.0.1:${goPort}`,
      MONGODB_URI: uri,
      MONGODB_XCLOUD_DB: xcloudDbName,
      MONGODB_APP_DB: appDbName,
      JWT_SECRET: JWT_SECRET_STRING,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let goReady = false;
  for (let i = 0; i < 150; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${goPort}/healthz`);
      if (r.ok) { goReady = true; break; }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(goReady, 'Go backend failed to become ready');
  console.log(`  Go production binary on 127.0.0.1:${goPort}`);

  capture = createCaptureProxy(goPort);
  capturePort = await getAvailablePort();
  await new Promise((resolve) => capture.server.listen(capturePort, '127.0.0.1', resolve));
  console.log(`  capture proxy on 127.0.0.1:${capturePort}`);

  ensureFrontendBuild();

  const token = await makeToken('p83_admin', 'admin', 1);

  // -- P83-P07: Mongo-unavailable behaviour (real runtime, real proxy branch) -----
  nextPort = await getAvailablePort();
  nextProc = await startNextServer(nextPort, {
    GO_BACKEND_URL: `http://127.0.0.1:${capturePort}`,
    MONGODB_URI: UNREACHABLE_MONGO_URI,
  });
  console.log(`  Next.js (Mongo unavailable) on 127.0.0.1:${nextPort}`);

  capture.reset();
  const mongoDownProbe = await httpProbe('GET', nextPort, '/api/users', { token });
  const mongoDownForward = capture.countOf('GET', '/api/users');

  await check('P83-P07 authenticated /api/* returns 503 AUTH_UNAVAILABLE when Mongo is unreachable', () => {
    assert.equal(mongoDownProbe.status, 503, `expected 503, got ${mongoDownProbe.status}`);
    assert.equal(mongoDownForward, 0, `must never forward while auth is unavailable, forwards=${mongoDownForward}`);
    let json = null;
    try { json = JSON.parse(mongoDownProbe.text); } catch {}
    assert.ok(json, `response must be JSON, got: ${mongoDownProbe.text.slice(0, 120)}`);
    assert.equal(json.code, 'AUTH_UNAVAILABLE', 'code must be AUTH_UNAVAILABLE');
  });

  stopProcess(nextProc);
  nextProc = null;

  // -- Next.js with a reachable Go backend --------------------------------------
  const cutoverRoutes = CUTOVER_TABLE.map((r) => ({ method: r.method, path: r.path }));
  nextPort = await getAvailablePort();
  nextProc = await startNextServer(nextPort, { GO_BACKEND_URL: `http://127.0.0.1:${capturePort}` });
  console.log(`  Next.js (Go reachable) on 127.0.0.1:${nextPort}`);

  // ===========================================================================
  console.log('\n[9] 84-Route Go Routing Integrity (P83-R, real HTTP)');

  const rSamples = [];
  for (let i = 0; i < cutoverRoutes.length; i++) {
    const route = cutoverRoutes[i];
    const id = `P83-R${String(i + 1).padStart(2, '0')}`;
    await check(`${id} ${route.method} ${route.path} forwards to Go exactly once`, async () => {
      capture.reset();
      const probePath = concretePath(route.path);
      const probe = await httpProbe(route.method, nextPort, probePath, { token, body: REQUEST_BODY_FOR_METHOD[route.method] });
      const forward = capture.countOf(route.method, probePath);
      const bodyHasUnreachable = probe.text.includes('GO_BACKEND_UNREACHABLE');
      rSamples.push({ key: key(route.method, route.path), method: route.method, path: route.path, forward, status: probe.status, ok: probe.ok, bodyHasUnreachable });

      assert.equal(forward, 1, `Go forward count must be exactly 1, found ${forward}`);
      assert.equal(capture.totalRequests(), 1, `exactly one request may reach Go, found ${capture.totalRequests()}`);
      assert.equal(bodyHasUnreachable, false, 'must not return GO_BACKEND_UNREACHABLE while Go is reachable');
      assert.notEqual(probe.status, 502, 'must not return the fail-closed 502 while Go is reachable');
    });
  }

  const phase83CutoverExpected = CUTOVER_TABLE.length;
  const phase83CutoverExecuted = rSamples.length;
  const phase83CutoverMissing = phase83CutoverExpected - phase83CutoverExecuted;
  const phase83CutoverDuplicate = rSamples.filter((s) => s.forward > 1).length;
  const phase83ExactlyOnceForwarded = rSamples.filter((s) => s.forward === 1).length;
  const phase83NodeHandlerExecutions = rSamples.filter((s) => s.forward === 0).length;

  await check('P83-R85 aggregate: 84/84 executed, exactly-once, zero Node handler executions', () => {
    assert.equal(phase83CutoverExpected, PHASE83_CUTOVER_TABLE_SIZE, 'expected route count must be 84');
    assert.equal(phase83CutoverExecuted, phase83CutoverExpected, 'every cutover route must be executed');
    assert.equal(phase83CutoverMissing, 0, 'phase83_cutover_missing must be 0');
    assert.equal(phase83CutoverDuplicate, 0, 'phase83_cutover_duplicate must be 0');
    assert.equal(phase83ExactlyOnceForwarded, phase83CutoverExpected, 'every route must forward exactly once');
    assert.equal(phase83NodeHandlerExecutions, 0, 'phase83_node_handler_executions must be 0');
  });

  // ===========================================================================
  console.log('\n[10] Unknown API Behaviour (P83-U, real HTTP)');

  // Runs against the Go-reachable Next.js instance above.
  capture.reset();
  const unknownProbe = await httpProbe('GET', nextPort, '/api/__phase83_unknown_api_sentinel__', { token });
  const unknownForward = capture.countOf('GET', '/api/__phase83_unknown_api_sentinel__');
  console.log(`  unknown API sentinel actual framework status: ${unknownProbe.status}`);

  await check('P83-U01 unmatched /api/* is not Go-forwarded and returns a framework 404/405', () => {
    assert.equal(unknownForward, 0, `unknown API must never reach Go, forwards=${unknownForward}`);
    assert.ok(unknownProbe.status === 404 || unknownProbe.status === 405,
      `unknown API must return 404 or 405, got ${unknownProbe.status}`);
    assert.equal(unknownProbe.status >= 200 && unknownProbe.status < 300, false, 'unknown API must never return 2xx');
    assert.equal(unknownProbe.text.includes('GO_BACKEND_UNREACHABLE'), false, 'unknown API must not return GO_BACKEND_UNREACHABLE');
  });

  const unknownApiRuntimeEvidence = unknownProbe.status === 404 || unknownProbe.status === 405;

  // ===========================================================================
  console.log('\n[11] Retired API Behaviour (P83-D, real HTTP)');

  // Runs against the Go-reachable Next.js instance above.
  const RETIRED_PROBES = [
    { method: 'POST', path: '/api/auth/users' },
    { method: 'PUT', path: '/api/auth/users/{username}' },
    { method: 'PATCH', path: '/api/auth/users/{username}' },
    { method: 'DELETE', path: '/api/auth/users/{username}' },
    { method: 'PUT', path: '/api/users/{username}' },
    { method: 'DELETE', path: '/api/users/{username}' },
  ];

  const retiredBefore = await userManagementFingerprint();
  const retiredSamples = [];
  for (let i = 0; i < RETIRED_PROBES.length; i++) {
    const route = RETIRED_PROBES[i];
    const id = `P83-D${String(i + 1).padStart(2, '0')}`;
    await check(`${id} ${route.method} ${route.path} retired: no Go forward, framework 404/405`, async () => {
      capture.reset();
      const probePath = concretePath(route.path);
      const probe = await httpProbe(route.method, nextPort, probePath, { token, body: REQUEST_BODY_FOR_METHOD[route.method] });
      const forward = capture.countOf(route.method, probePath);
      retiredSamples.push({ key: key(route.method, route.path), forward, status: probe.status });

      assert.equal(forward, 0, `retired surface must never be forwarded to Go, forwards=${forward}`);
      assert.ok(probe.status === 404 || probe.status === 405, `retired surface must return 404/405, got ${probe.status}`);
      assert.equal(probe.status >= 200 && probe.status < 300, false, 'retired surface must never return 2xx');
      assert.equal(probe.text.includes('GO_BACKEND_UNREACHABLE'), false, 'retired surface must not return GO_BACKEND_UNREACHABLE');
    });
  }

  const retiredAfter = await userManagementFingerprint();
  const phase83RetiredExpected = RETIRED_PROBES.length;
  const phase83RetiredExecuted = retiredSamples.length;
  const phase83RetiredGoForwardCount = retiredSamples.reduce((sum, s) => sum + s.forward, 0);
  const phase83RetiredBusinessMutations = retiredBefore.digest === retiredAfter.digest ? 0 : 1;

  await check('P83-D07 aggregate: 6/6 retired probes, zero Go forwards, zero business mutations', async () => {
    assert.equal(phase83RetiredExpected, 6, 'retired probe count must be 6');
    assert.equal(phase83RetiredExecuted, phase83RetiredExpected, 'every retired probe must be executed');
    assert.equal(phase83RetiredGoForwardCount, 0, 'phase83_retired_go_forward_count must be 0');
    assert.equal(phase83RetiredBusinessMutations, 0, 'retired probes must not mutate the app_users business collection');
  });

  stopProcess(nextProc);
  nextProc = null;

  // ===========================================================================
  console.log('\n[12] Fail-Closed / No Fallback (P83-F, real HTTP)');

  nextPort = await getAvailablePort();
  nextProc = await startNextServer(nextPort, { GO_BACKEND_URL: UNREACHABLE_GO_URL });
  console.log(`  Next.js (Go unreachable) on 127.0.0.1:${nextPort}`);

  const failClosedBefore = await businessStateFingerprint();
  const fSamples = [];
  for (let i = 0; i < cutoverRoutes.length; i++) {
    const route = cutoverRoutes[i];
    const id = `P83-F${String(i + 1).padStart(2, '0')}`;
    await check(`${id} ${route.method} ${route.path} => 502 GO_BACKEND_UNREACHABLE`, async () => {
      const probePath = concretePath(route.path);
      const probe = await httpProbe(route.method, nextPort, probePath, { token, body: REQUEST_BODY_FOR_METHOD[route.method] });
      let json = null;
      try { json = JSON.parse(probe.text); } catch {}
      const contract = probe.status === 502
        && Boolean(json)
        && json.code === 'GO_BACKEND_UNREACHABLE'
        && json.error === 'Backend temporarily unavailable';
      fSamples.push({ key: key(route.method, route.path), status: probe.status, contract });

      assert.equal(probe.status, 502, `expected 502, got ${probe.status}`);
      assert.ok(json, `response body must be JSON, got: ${probe.text.slice(0, 120)}`);
      assert.equal(json.code, 'GO_BACKEND_UNREACHABLE', 'code must be GO_BACKEND_UNREACHABLE');
      assert.equal(json.error, 'Backend temporarily unavailable', 'error must match the frozen contract');
    });
  }

  const failClosedAfter = await businessStateFingerprint();
  const phase83FailClosedExpected = CUTOVER_TABLE.length;
  const phase83FailClosedExecuted = fSamples.length;
  const phase83FailClosedFailures = fSamples.filter((s) => !s.contract).length;
  const phase83FallbackCount = phase83FailClosedFailures;

  await check('P83-F85 aggregate: 84/84 fail-closed, zero fallback, zero business mutation', () => {
    assert.equal(phase83FailClosedExpected, PHASE83_CUTOVER_TABLE_SIZE, 'expected fail-closed count must be 84');
    assert.equal(phase83FailClosedExecuted, phase83FailClosedExpected, 'every route must be probed while Go is unreachable');
    assert.equal(phase83FailClosedFailures, 0, 'phase83_fail_closed_failures must be 0');
    assert.equal(phase83FallbackCount, 0, 'phase83_fallback_count must be 0');
    assert.deepEqual(failClosedAfter, failClosedBefore, 'no business state may change while Go is unreachable');
  });

  // ---------------------------------------------------------------------------
  // Derived readiness
  // ---------------------------------------------------------------------------
  const callers = scanCallers();
  const knowable = [...goRegs.map((r) => r.canonicalPath), ...CUTOVER_TABLE.map((r) => r.path)];
  const knownRegexes = knowable.map((p) => patternRegex(p));
  const retiredRegexes = RETIRED_CALLER_TARGETS.map((p) => patternRegex(p));
  const unmappedCallers = callers.filter((c) => {
    if (knownRegexes.some((re) => re.test(c.normalised))) return false;
    if (retiredRegexes.some((re) => re.test(c.normalised))) return false;
    return true;
  });
  const frontendApiCallersUnmapped = unmappedCallers.length;

  const nextBusinessBackendRemoved =
    nextApiRouteFiles === 0
    && nextApiOperations === 0
    && nodeServerTreeFiles === 0
    && nextBusinessMongoReaders === 0
    && nextBusinessMongoWriters === 0;

  const blockers = [];
  if (nextApiRouteFiles > 0) blockers.push('NEXT_API_ROUTE_FILES');
  if (nextApiOperations > 0) blockers.push('NEXT_API_OPERATIONS');
  if (nodeServerTreeFiles > 0) blockers.push('NEXT_SERVER_TREE_FILES');
  if (activeServerImports > 0) blockers.push('ACTIVE_SERVER_IMPORTS');
  if (nextBusinessMongoReaders > 0) blockers.push('NEXT_BUSINESS_MONGO_READERS');
  if (nextBusinessMongoWriters > 0) blockers.push('NEXT_BUSINESS_MONGO_WRITERS');
  if (goRegisteredUnrouted.length > 0) blockers.push('GO_REGISTERED_UNROUTED');
  if (goUnclassified.length > 0) blockers.push('GO_REGISTERED_UNCLASSIFIED');
  if (cutoverWithoutGoRegistration.length > 0) blockers.push('CUTOVER_WITHOUT_GO_REGISTRATION');
  if (frontendApiCallersUnmapped > 0) blockers.push('FRONTEND_API_CALLERS_UNMAPPED');
  if (phase83CutoverMissing > 0) blockers.push('CUTOVER_ROUTES_NOT_EXECUTED');
  if (phase83FailClosedFailures > 0) blockers.push('FAIL_CLOSED_CONTRACT_FAILURES');
  const backendRemovalReady = blockers.length === 0;

  // ---------------------------------------------------------------------------
  // Report
  // ---------------------------------------------------------------------------
  console.log('\n-- INFO: bare literals naming the removed tree (not dependency edges) --');
  console.log(`  removal_reference_literals=${removalReferenceLiterals}`);
  for (const hit of serverImportLiterals) console.log(`  ${hit.file}:${hit.line}`);

  console.log('\n-- Forwarding summary (first 5 / last 5) --');
  for (const s of [...rSamples.slice(0, 5), ...rSamples.slice(-5)]) {
    console.log(`  ${s.method.padEnd(6)} | ${s.path.padEnd(45)} | forward=${s.forward} | status=${s.status}`);
  }

  console.log('\n-- Retired surface summary --');
  for (const s of retiredSamples) {
    console.log(`  ${s.key.padEnd(45)} | forward=${s.forward} | status=${s.status}`);
  }

  console.log('\n-- Unmapped frontend API callers --');
  console.log(`  count=${frontendApiCallersUnmapped}`);
  for (const c of unmappedCallers) console.log(`  ${c.file}:${c.line} -> ${c.normalised}`);

  console.log('\n-- Check totals --');
  console.log(`TOTAL=${total} PASS=${passed} FAIL=${failed}`);

  console.log('\n==================================================');
  console.log('Phase 8.3 Next.js Business Backend Removal Acceptance');
  console.log('--------------------------------------------------');
  console.log(`phase83_start_api_route_files=${PHASE83_START_API_ROUTE_FILES}`);
  console.log(`phase83_start_api_operations=${PHASE83_START_API_OPERATIONS}`);
  console.log(`next_api_route_files=${nextApiRouteFiles}`);
  console.log(`next_api_operations=${nextApiOperations}`);
  console.log(`node_server_tree_files=${nodeServerTreeFiles}`);
  console.log(`active_server_imports=${activeServerImports}`);
  console.log(`go_registered_operations=${goKeys.size}`);
  console.log(`go_cutover_operations=${cutoverKeys.size}`);
  console.log(`go_registered_unclassified=${goUnclassified.length}`);
  console.log(`go_registered_unrouted=${goRegisteredUnrouted.length}`);
  console.log(`cutover_without_go_registration=${cutoverWithoutGoRegistration.length}`);
  console.log(`phase83_cutover_expected=${phase83CutoverExpected}`);
  console.log(`phase83_cutover_executed=${phase83CutoverExecuted}`);
  console.log(`phase83_cutover_missing=${phase83CutoverMissing}`);
  console.log(`phase83_cutover_duplicate=${phase83CutoverDuplicate}`);
  console.log(`phase83_exactly_once_forwarded=${phase83ExactlyOnceForwarded}`);
  console.log(`phase83_fail_closed_expected=${phase83FailClosedExpected}`);
  console.log(`phase83_fail_closed_executed=${phase83FailClosedExecuted}`);
  console.log(`phase83_fail_closed_failures=${phase83FailClosedFailures}`);
  console.log(`phase83_fallback_count=${phase83FallbackCount}`);
  console.log(`phase83_node_handler_executions=${phase83NodeHandlerExecutions}`);
  console.log(`unknown_api_runtime_evidence=${unknownApiRuntimeEvidence}`);
  console.log(`phase83_retired_expected=${phase83RetiredExpected}`);
  console.log(`phase83_retired_executed=${phase83RetiredExecuted}`);
  console.log(`phase83_retired_go_forward_count=${phase83RetiredGoForwardCount}`);
  console.log(`phase83_retired_business_mutations=${phase83RetiredBusinessMutations}`);
  console.log(`next_business_mongo_readers=${nextBusinessMongoReaders}`);
  console.log(`next_business_mongo_writers=${nextBusinessMongoWriters}`);
  console.log(`proxy_session_store_read_only=${sessionStore.present && sessionStore.readOnly}`);
  console.log(`proxy_session_validation_present=${proxySource.includes('validateCurrentAccount') && accountSessionSource.includes('validateCurrentAccount')}`);
  console.log(`frontend_api_callers_unmapped=${frontendApiCallersUnmapped}`);
  console.log(`backend_removal_ready=${backendRemovalReady}`);
  console.log(`next_business_backend_removed=${nextBusinessBackendRemoved}`);
  console.log(`backend_production_changes=${backendProductionChanges.length}`);
  console.log(`test_supersession_actual=${testSupersession.actual.size}`);
  console.log(`test_supersession_manifested=${testSupersession.manifested.size}`);
  console.log(`test_supersession_unmapped=${testSupersession.unmapped.length}`);
  console.log(`test_supersession_missing=${testSupersession.missing.length}`);
  console.log(`test_replacement_evidence_missing=${testSupersession.replacementEvidenceMissing.length}`);
  console.log(`test_historical_evidence_missing=${testSupersession.historicalEvidenceMissing.length}`);
  console.log(`test_supersession_reintroduced=${testSupersession.reintroduced.length}`);
  console.log(`test_supersession_negative_sentinel=${testSupersessionNegativeSentinel}`);
  console.log(`ci_supersession_expected=${ciSupersession.expected.length}`);
  console.log(`ci_supersession_reconciled=${ciSupersession.reconciled.length}`);
  console.log(`ci_supersession_missing=${ciSupersession.missing.length}`);
  console.log(`ci_supersession_unexpected=${ciSupersession.unexpected.length}`);
  console.log(`ci_replacement_evidence_missing=${ciSupersession.replacementEvidenceMissing.length}`);
  console.log(`ci_historical_evidence_missing=${ciSupersession.historicalEvidenceMissing.length}`);
  console.log(`ci_supersession_reintroduced=${ciSupersession.reintroduced.length}`);
  console.log(`ci_supersession_negative_sentinel=${ciSupersessionNegativeSentinel}`);
  console.log(`unexplained_test_coverage_loss=${unexplainedTestCoverageLoss}`);
  console.log(`ci_coverage_gaps=${ciCoverageGaps}`);
  console.log(`phase83_result=${failed === 0 ? 'PASS' : 'FAIL'}`);
  console.log(`phase83_invariants_failed=${failed}`);
  console.log('==================================================\n');

  if (failed > 0) {
    console.error(`Phase 8.3 Next.js business backend removal acceptance FAILED (${failed} check(s)).`);
    process.exitCode = 1;
    return;
  }
  console.log('Phase 8.3 Next.js business backend removal acceptance result: PASS');
}

main()
  .catch((err) => {
    console.error('Phase 8.3 Next.js business backend removal acceptance suite failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      if (capture && capture.server) await new Promise((resolve) => capture.server.close(() => resolve()));
    } catch {}
    for (const proc of nextProcs) stopProcess(proc);
    if (goProc && goProc.pid) {
      if (process.platform === 'win32') {
        try { execSync(`taskkill /pid ${goProc.pid} /T /F`, { stdio: 'ignore' }); } catch {}
      } else {
        try { goProc.kill('SIGTERM'); } catch {}
      }
    }
    if (binPath && existsSync(binPath)) {
      try { unlinkSync(binPath); } catch {}
    }
    try {
      await client.db(xcloudDbName).dropDatabase();
      await client.db(appDbName).dropDatabase();
      await client.close();
    } catch {}
    if (failed > 0) {
      console.log(`Phase 8.3 Next.js business backend removal acceptance result: FAIL=${failed}`);
    }
    process.exit(process.exitCode || 0);
  });
