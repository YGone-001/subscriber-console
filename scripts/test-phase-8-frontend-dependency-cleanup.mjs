#!/usr/bin/env node
/**
 * Phase 8.4 - Frontend Dependency & Residual Node Runtime Cleanup Acceptance Suite.
 *
 * This is the RUNTIME acceptance suite for the Phase 8.4 cleanup. It re-proves every
 * current production guarantee that the frozen Phase 8.3 suite established, and adds the
 * Phase 8.4-specific evidence that can only be derived from the current source and from
 * exercising the REAL production stack:
 *
 *   - frontend direct-dependency consumer graph + classification + lockfile reconciliation;
 *   - residual Node-era library classification (kept vs provably dead);
 *   - the collapsed minimal Mongo/session boundary (xcloud_ops.app_users read-only only);
 *   - proxy / session preservation (incl. Mongo-unavailable 503 AUTH_UNAVAILABLE);
 *   - 84-route exactly-once Go forwarding, fail-closed, unknown/retired API behaviour;
 *   - Go registration equality; CI supersession integrity.
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
 *   P84-Sxx  source / package invariants
 *   P84-Dxx  dependency consumer graph + classification
 *   P84-Lxx  residual lib classification
 *   P84-Mxx  minimal Mongo / session boundary
 *   P84-Pxx  proxy / session preservation (incl. Mongo-unavailable 503)
 *   P84-Cxx  CI / supersession integrity
 *   P84-Gxx  Go registration equality
 *   P84-Rxx  84-route Go routing integrity (real HTTP, exactly-once)
 *   P84-Uxx  unknown + retired API behaviour (real HTTP)
 *   P84-Fxx  fail-closed / no fallback
 *
 * Emits the mandatory Phase 8.4 machine-readable block and exits non-zero on any failure.
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
const libRoot = path.join(srcRoot, 'lib');
const apiRoot = path.join(srcRoot, 'app', 'api');
const serverRoot = path.join(srcRoot, 'server');
const testsRoot = path.join(frontendRoot, 'tests');
const scriptsRoot = path.join(root, 'scripts');
const githubRoot = path.join(root, '.github');
const ciPath = path.join(githubRoot, 'workflows', 'ci.yml');

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'];
const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

// ---------------------------------------------------------------------------
// Phase 8.4 pinned boundaries and structural expectations.
// ---------------------------------------------------------------------------
// The authoritative Phase 8.4 starting SHA (the independently accepted Phase 8.3 boundary).
const PHASE84_START_SHA = '342589aa5c00cb8152980c77bfc73f05b82ca64a';

// The routing table size asserted by the Phase 8.4 contract. The route LIST is always
// derived from CUTOVER_TABLE at runtime; only the count is pinned.
const PHASE84_CUTOVER_TABLE_SIZE = 84;

const P84_SUITE = 'scripts/test-phase-8-frontend-dependency-cleanup.mjs';
const P83_SUITE = 'scripts/test-phase-8-next-backend-removal.mjs';
const P84_DOC = 'docs/backend-migration/phase-8.4-frontend-dependency-cleanup.md';
const READINESS_VALIDATOR = 'scripts/test-phase-8-backend-removal-readiness.mjs';
const P84_CI_JOB_ID = 'frontend-dependency-cleanup';
const P84_CI_JOB_NAME = 'Phase 8.4 frontend dependency & residual Node runtime cleanup';

// Root manifests must be byte-unchanged vs the boundary SHA.
const ROOT_MANIFESTS = ['package.json', 'package-lock.json'];
// Frontend manifests are the only manifests Phase 8.4 is allowed to change.
const FRONTEND_MANIFESTS = ['frontend/package.json', 'frontend/package-lock.json'];
// Zero-logic files that must stay byte-identical (modulo line endings) vs the boundary.
const FROZEN_FRONTEND_FILES = [
  'frontend/src/proxy.ts',
  'frontend/src/lib/accountSession.ts',
  'frontend/src/lib/cutover-routing.ts',
];
// The residual Node-era libraries Phase 8.4 deleted (must be absent from disk). mongo.ts is
// included because it was removed and replaced by the narrowed sessionMongo.ts contract.
const DELETED_RESIDUAL_LIBS = [
  'frontend/src/lib/mongo.ts',
  'frontend/src/lib/profileAudit.ts',
  'frontend/src/lib/subscriberContract.ts',
  'frontend/src/lib/audit/sanitize.ts',
  'frontend/src/lib/plmnUtils.ts',
  'frontend/src/lib/plmn_db.ts',
];
// The spec minimum residual-library inventory (section 22) that must be explicitly resolved.
const SPEC_MIN_RESIDUAL_LIBS = [
  'frontend/src/lib/profileAudit.ts',
  'frontend/src/lib/audit/sanitize.ts',
  'frontend/src/lib/mongo.ts',
  'frontend/src/lib/security.ts',
  'frontend/src/lib/accountSession.ts',
  'frontend/src/lib/sessionAccountStore.ts',
  'frontend/src/lib/userManagementPolicy.ts',
  'frontend/src/lib/userAccessManagement.ts',
  'frontend/src/lib/subscriberContract.ts',
  'frontend/src/lib/subscriberValidation.ts',
  'frontend/src/lib/tariffPlanOperations.ts',
];

const REQUEST_BODY_FOR_METHOD = { POST: {}, PUT: {}, PATCH: {} };

// The three-role runtime chain reachable from the proxy through real import edges.
const PROXY_CHAIN = new Set([
  'frontend/src/proxy.ts',
  'frontend/src/lib/security.ts',
  'frontend/src/lib/cutover-routing.ts',
  'frontend/src/lib/accountSession.ts',
]);
const SESSION_CHAIN = new Set([
  'frontend/src/lib/accountSession.ts',
  'frontend/src/lib/sessionAccountStore.ts',
  'frontend/src/lib/sessionMongo.ts',
]);

// Structural, non-tautological dependency classifications.
const DEP_CLASS = {
  KEEP_RUNTIME_UI: 'KEEP_RUNTIME_UI',
  KEEP_RUNTIME_PROXY: 'KEEP_RUNTIME_PROXY',
  KEEP_RUNTIME_SESSION: 'KEEP_RUNTIME_SESSION',
  KEEP_TEST_TOOLING: 'KEEP_TEST_TOOLING',
  KEEP_BUILD_TOOLING: 'KEEP_BUILD_TOOLING',
  KEEP_PACKAGE_SCRIPT_TOOLING: 'KEEP_PACKAGE_SCRIPT_TOOLING',
  REMOVE_UNUSED: 'REMOVE_UNUSED',
};

// Runtime peer chains: a package that is required as the runtime partner of a live UI
// package. `react-dom` is the DOM renderer paired with `react`; Next.js production
// runtime requires both. Derived evidence, declared as data (never inferred from prose).
const RUNTIME_PEERS = { 'react-dom': 'react' };

// ---------------------------------------------------------------------------
// Test Mongo URI must be explicitly controlled: never inherit a developer `.env`.
// ---------------------------------------------------------------------------
const PRELOAD_MONGODB_URI = process.env.MONGODB_URI;
nextEnv.loadEnvConfig(process.cwd());
process.env.MONGODB_URI = PRELOAD_MONGODB_URI
  || process.env.P84_TEST_MONGODB_URI
  || 'mongodb://127.0.0.1:27017/xcloud';

const suffix = `${Date.now()}_${process.pid}_${Math.floor(Math.random() * 100000)}`;
const xcloudDbName = `xcloud_p84_cleanup_${suffix}`;
const appDbName = `xcloud_ops_p84_cleanup_${suffix}`;
const uri = process.env.MONGODB_URI;

process.env.MONGODB_XCLOUD_DB = xcloudDbName;
process.env.MONGODB_APP_DB = appDbName;
const JWT_SECRET_STRING = process.env.JWT_SECRET || 'p84-cleanup-suite-secret-at-least-32-bytes!';
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

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripCr(s) {
  return s.replace(/\r\n/g, '\n');
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
    .replace('{username}', 'p84_admin')
    .replace('{imsi}', '001010000000001')
    .replace('{name}', 'default')
    .replace('{id}', 'p84-rating-01');
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

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function declaredDependencies(pkg) {
  return { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
}

function gitProbe(args) {
  try {
    return { ok: true, out: execSync(`git ${args}`, { cwd: root, encoding: 'utf8' }).trim() };
  } catch (err) {
    return { ok: false, out: '', error: String(err.stderr || err.stdout || err.message).trim() };
  }
}

function gitShow(sha, repoRelative) {
  const probe = gitProbe(`show ${sha}:${repoRelative}`);
  return probe.ok ? probe.out : null;
}

/** Raw `git show` output with NO trimming: required for exact byte comparisons. */
function gitShowExact(sha, repoRelative) {
  try {
    return execSync(`git show ${sha}:${repoRelative}`, { cwd: root, encoding: 'utf8' });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Source scans (removed trees + active references)
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

// ---------------------------------------------------------------------------
// Frontend dependency / library consumer scanner (no external dependencies)
// ---------------------------------------------------------------------------

const FRONTEND_CONFIG_FILES = [
  'next.config.ts', 'next.config.mjs', 'next.config.js', 'next.config.cjs',
  'eslint.config.mjs', 'eslint.config.js', 'eslint.config.cjs',
  'postcss.config.mjs', 'postcss.config.js', 'postcss.config.cjs',
  'tsconfig.json',
];

function isConfigFile(relPath) {
  const base = relPath.slice(relPath.lastIndexOf('/') + 1);
  return FRONTEND_CONFIG_FILES.includes(base);
}
function isTestFile(relPath) {
  return relPath.startsWith('frontend/tests/');
}
function isFrontendSrcFile(relPath) {
  return relPath.startsWith('frontend/src/');
}

/** Normalize an import specifier to a bare package name, or null when not a package. */
function normalizePackageName(spec) {
  if (!spec) return null;
  if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('@/')) return null;
  if (spec.startsWith('node:')) return null;
  if (/^[a-zA-Z]:/.test(spec)) return null;
  const parts = spec.split('/');
  if (spec.startsWith('@')) {
    if (parts.length < 2 || !parts[1]) return null;
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0];
}

const SPECIFIER_PATTERNS = [
  /\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bjiti(?:\.import)?\s*\(\s*['"]([^'"]+)['"]/g,
];

function collectSpecifiers(content) {
  const out = [];
  for (const re of SPECIFIER_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(content)) !== null) out.push(m[1]);
  }
  return out;
}

const STRING_LITERAL_RE = /(['"`])((?:\\.|(?!\1)[^\\])*?)\1/g;

function collectStringLiterals(content) {
  const out = [];
  let m;
  STRING_LITERAL_RE.lastIndex = 0;
  while ((m = STRING_LITERAL_RE.exec(content)) !== null) out.push(m[2]);
  return out;
}

function loadLibFiles() {
  return walk(libRoot, (p) => /\.(ts|tsx|js|jsx)$/.test(p));
}

function matchLibFile(candidateAbs, libSet) {
  const tries = [
    candidateAbs,
    `${candidateAbs}.ts`, `${candidateAbs}.tsx`, `${candidateAbs}.js`, `${candidateAbs}.jsx`,
    path.join(candidateAbs, 'index.ts'), path.join(candidateAbs, 'index.tsx'),
    path.join(candidateAbs, 'index.js'), path.join(candidateAbs, 'index.jsx'),
  ];
  for (const t of tries) {
    const r = rel(t);
    if (libSet.has(r)) return r;
  }
  return null;
}

/** Resolve any specifier / literal to a surviving `frontend/src/lib/**` file, or null. */
function resolveLibRef(spec, fromFileAbs, libSet) {
  let candidate = null;
  if (spec.startsWith('@/lib/')) candidate = path.join(srcRoot, spec.slice(2));
  else if (spec.startsWith('@/')) return null;
  else if (spec.startsWith('.')) candidate = path.resolve(path.dirname(fromFileAbs), spec);
  else if (spec.includes('src/lib/')) candidate = path.join(srcRoot, spec.slice(spec.indexOf('src/') + 4));
  else return null;
  return matchLibFile(candidate, libSet);
}

/** Resolve any specifier to a surviving `frontend/src/**` file, or null. */
function resolveSrcRef(spec, fromFileAbs, srcSet) {
  let candidate = null;
  if (spec.startsWith('@/')) candidate = path.join(srcRoot, spec.slice(2));
  else if (spec.startsWith('.')) candidate = path.resolve(path.dirname(fromFileAbs), spec);
  else return null;
  return matchLibFile(candidate, srcSet);
}

function scriptConsumersOf(pkg, scripts) {
  const hits = [];
  const re = new RegExp(`(^|[^\\w@/-])${escapeRe(pkg)}([^\\w@/-]|$)`);
  for (const [name, cmd] of Object.entries(scripts || {})) {
    if (re.test(cmd)) hits.push(`frontend/package.json#scripts.${name}`);
  }
  return hits;
}

/**
 * Build the real consumer graph across frontend/src, frontend/tests, frontend config files
 * and frontend package.json scripts. Records:
 *   packageConsumers : Map<packageName, Set<repoRelativeConsumerPath>>
 *   libConsumers     : Map<libRepoRelative, Set<repoRelativeConsumerPath>>
 *   libEdges         : [{ from, to }] real import/reference edges inside frontend/src/lib
 *   srcEdges         : [{ from, to }] real import edges between frontend/src files
 *   srcFiles         : repo-relative frontend/src code files (import-graph nodes)
 */
function scanFrontendGraph() {
  const libFiles = loadLibFiles();
  const libSet = new Set(libFiles.map((f) => rel(f)));
  const srcFiles = walk(srcRoot, (p) => CODE_EXT.test(p));
  const srcSet = new Set(srcFiles.map((f) => rel(f)));
  const scanFiles = [];
  scanFiles.push(...walk(srcRoot, (p) => CODE_EXT.test(p) || p.endsWith('.css')));
  scanFiles.push(...walk(testsRoot, (p) => CODE_EXT.test(p) || p.endsWith('.json')));
  for (const cfg of FRONTEND_CONFIG_FILES) {
    const p = path.join(frontendRoot, cfg);
    if (existsSync(p)) scanFiles.push(p);
  }

  const packageConsumers = new Map();
  const libConsumers = new Map();
  const libEdges = [];
  const srcEdges = [];
  const addConsumer = (map, k, v) => {
    if (!map.has(k)) map.set(k, new Set());
    map.get(k).add(v);
  };

  for (const file of scanFiles) {
    if (path.resolve(file) === selfPath) continue;
    const relFile = rel(file);
    const content = stripComments(readFileSync(file, 'utf8'));
    const specs = collectSpecifiers(content);
    const lits = collectStringLiterals(content);
    for (const spec of specs) {
      const pkg = normalizePackageName(spec);
      if (pkg) addConsumer(packageConsumers, pkg, relFile);
      const lib = resolveLibRef(spec, file, libSet);
      if (lib && lib !== relFile) {
        addConsumer(libConsumers, lib, relFile);
        libEdges.push({ from: relFile, to: lib });
      }
      if (isFrontendSrcFile(relFile)) {
        const srcTarget = resolveSrcRef(spec, file, srcSet);
        if (srcTarget && srcTarget !== relFile) srcEdges.push({ from: relFile, to: srcTarget });
      }
    }
    for (const lit of lits) {
      const lib = resolveLibRef(lit, file, libSet);
      if (lib && lib !== relFile) {
        addConsumer(libConsumers, lib, relFile);
        libEdges.push({ from: relFile, to: lib });
      }
      if (isConfigFile(relFile)) {
        const pkg = normalizePackageName(lit);
        if (pkg) addConsumer(packageConsumers, pkg, relFile);
      }
    }
  }
  return { libFiles, libSet, packageConsumers, libConsumers, libEdges, srcEdges, srcFiles, scanFiles };
}

/**
 * Pure dependency classifier. Takes a descriptor (never global state) so it can be driven
 * entirely in memory by the negative sentinels.
 */
function classifyDependency(d) {
  const src = d.srcConsumers || [];
  // Runtime-reachable source consumers are the authoritative runtime evidence: a source file
  // that only survives as a test fixture or an unreferenced module does not make a package a
  // live UI/runtime dependency. When the descriptor carries no runtime split, fall back to the
  // full source-consumer set.
  const runtimeSrc = d.runtimeSrcConsumers !== undefined ? d.runtimeSrcConsumers : src;
  if (runtimeSrc.length > 0 && runtimeSrc.every((c) => PROXY_CHAIN.has(c))) return DEP_CLASS.KEEP_RUNTIME_PROXY;
  if (runtimeSrc.length > 0 && runtimeSrc.every((c) => SESSION_CHAIN.has(c))) return DEP_CLASS.KEEP_RUNTIME_SESSION;
  if (runtimeSrc.length > 0) return DEP_CLASS.KEEP_RUNTIME_UI;
  if (src.length > 0) return DEP_CLASS.KEEP_RUNTIME_UI;
  if ((d.configConsumers || []).length > 0) return DEP_CLASS.KEEP_BUILD_TOOLING;
  const structural = d.structural || [];
  if (structural.includes('type-package-relationship')) return DEP_CLASS.KEEP_BUILD_TOOLING;
  if (structural.includes('build-tool-dependency')) return DEP_CLASS.KEEP_BUILD_TOOLING;
  if (structural.includes('runtime-peer')) return DEP_CLASS.KEEP_RUNTIME_UI;
  if ((d.testConsumers || []).length > 0) return DEP_CLASS.KEEP_TEST_TOOLING;
  if ((d.scriptConsumers || []).length > 0) return DEP_CLASS.KEEP_PACKAGE_SCRIPT_TOOLING;
  return DEP_CLASS.REMOVE_UNUSED;
}

/** Compute the set of package names reachable from frontend/src/proxy.ts through lib edges. */
function computeRuntimeReachableLibs(libEdges) {
  const adj = new Map();
  for (const { from, to } of libEdges) {
    if (!adj.has(from)) adj.set(from, new Set());
    adj.get(from).add(to);
  }
  const entry = 'frontend/src/proxy.ts';
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const cur = stack.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const next of adj.get(cur) || []) stack.push(next);
  }
  return seen;
}

/**
 * Compute the set of `frontend/src/**` files reachable through real import edges from the
 * runtime entry points (`frontend/src/proxy.ts` + the Next.js app tree). Distinguishes live
 * runtime consumers from source files that survive only as test fixtures or orphans.
 */
function computeRuntimeReachableSrcFiles(srcEdges, entryFiles) {
  const adj = new Map();
  for (const { from, to } of srcEdges) {
    if (!adj.has(from)) adj.set(from, new Set());
    adj.get(from).add(to);
  }
  const seen = new Set();
  const stack = [...entryFiles];
  while (stack.length) {
    const cur = stack.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const next of adj.get(cur) || []) stack.push(next);
  }
  return seen;
}

/** Pure residual-lib classifier. KEEP_RUNTIME / KEEP_UI / KEEP_TEST / DELETE_REQUIRED. */
function classifyResidualLib(d) {
  if (d.runtimeReachable) return 'KEEP_RUNTIME';
  if ((d.srcConsumers || []).length > 0) return 'KEEP_UI';
  if ((d.testConsumers || []).length > 0) return 'KEEP_TEST';
  return 'DELETE_REQUIRED';
}

/**
 * Acceptance predicate for a residual-lib classification: a lib is only acceptable if its
 * classification matches its consumer count. Used by the negative sentinel to prove the
 * predicate is not tautological.
 */
function residualLibAccepted(classification, consumerCount) {
  return classification === 'DELETE_REQUIRED' ? consumerCount === 0 : consumerCount > 0;
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
  'app_metrics',
  'app_rate_limits',
  'app_sequences',
]);

// Tolerates generic call syntax, e.g. `.findOne<SessionAccountDocument & Document>(`.
const MONGO_OP_RE =
  /\.(findOneAndUpdate|findOneAndDelete|findOneAndReplace|findOne|find|insertMany|insertOne|updateMany|updateOne|replaceOne|deleteMany|deleteOne|bulkWrite|aggregate|countDocuments|distinct|estimatedDocumentCount|createIndexes|createIndex|drop)\s*(?:<[^>]*>)?\s*\(/g;
const MONGO_READ_OPS = new Set(['findOne', 'find', 'aggregate', 'countDocuments', 'distinct', 'estimatedDocumentCount']);
const MONGO_WRITE_OPS = new Set([
  'findOneAndUpdate', 'findOneAndDelete', 'findOneAndReplace', 'insertOne', 'insertMany',
  'updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany', 'bulkWrite',
  'createIndex', 'createIndexes', 'drop',
]);

const MONGO_ACCESS_RE = /(?:getAppCollection|getXcloudCollection|getMongoCollection|\.collection)\s*(?:<[^>]*>)?\s*\(/;

// Identifiers that only the deleted generic business Mongo lib exposed.
const REMOVED_MONGO_CAPABILITIES = [
  'mongoCollections', 'getMongoDb', 'getXcloudDb', 'getAppDb', 'getMongoClient',
  'getMongoCollection', 'getXcloudCollection', 'getAppCollection', 'mongoDbName', 'xcloudDbName',
];
// The internal (non-exported) helper name sessionMongo is still allowed to own.
const SESSION_MONGO_INTERNAL_ALLOWED = 'frontend/src/lib/sessionMongo.ts';

function scanRemovedMongoCapabilities() {
  const hits = [];
  const files = walk(srcRoot, (p) => CODE_EXT.test(p));
  for (const file of files) {
    const relFile = rel(file);
    if (relFile === SESSION_MONGO_INTERNAL_ALLOWED) continue; // internal appDbName() only
    const code = stripComments(readFileSync(file, 'utf8'));
    for (const name of [...REMOVED_MONGO_CAPABILITIES, 'appDbName']) {
      const re = new RegExp(`\\b${escapeRe(name)}\\b`);
      if (re.test(code)) hits.push({ file: relFile, symbol: name });
    }
  }
  return hits;
}

/** Analyze a frontend Mongo-related source text (used for sessionMongo + a negative sentinel). */
function analyzeSessionMongoSource(source) {
  const code = stripComments(source);
  const collections = [...code.matchAll(/\.collection\s*(?:<[^>]*>)?\s*\(\s*(['"])([^'"]+)\1/g)].map((m) => m[2]);
  const dbCalls = [...code.matchAll(/\.db\s*\(\s*(['"])([^'"]+)\1/g)].map((m) => m[2]);
  const exports = [
    ...[...code.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map((m) => m[1]),
    ...[...code.matchAll(/export\s+const\s+(\w+)/g)].map((m) => m[1]),
  ];
  const mongoClientCtor = /new\s+MongoClient\s*\(/.test(code);
  const ops = [];
  let m;
  MONGO_OP_RE.lastIndex = 0;
  while ((m = MONGO_OP_RE.exec(code)) !== null) ops.push(m[1]);
  return { collections, dbCalls, exports, mongoClientCtor, ops };
}

function scanSessionChain() {
  const ops = [];
  for (const p of SESSION_CHAIN) {
    const abs = path.join(root, p);
    if (!existsSync(abs)) continue;
    const code = stripComments(readFileSync(abs, 'utf8'));
    let m;
    MONGO_OP_RE.lastIndex = 0;
    while ((m = MONGO_OP_RE.exec(code)) !== null) ops.push({ file: p, op: m[1] });
  }
  const reads = ops.filter((o) => MONGO_READ_OPS.has(o.op)).length;
  const writes = ops.filter((o) => MONGO_WRITE_OPS.has(o.op)).length;
  return { ops, reads, writes };
}

/** Scan all frontend/src Mongo-access code for business collection capability. */
function scanNextBusinessMongo() {
  const files = walk(srcRoot, (p) => CODE_EXT.test(p)
    && !/lib[\\/]locales[\\/]/.test(p)
    && !/__tests__|\.test\.|\.spec\./.test(p));
  const readers = [];
  const writers = [];
  const accessFiles = [];
  const capabilities = [];
  for (const file of files) {
    const relFile = rel(file);
    const content = readFileSync(file, 'utf8');
    if (!MONGO_ACCESS_RE.test(content)) continue;
    accessFiles.push(relFile);
    const names = new Set();
    for (const m of content.matchAll(/\.collection\s*(?:<[^>]*>)?\s*\(\s*['"]([^'"]+)['"]/g)) names.add(m[1]);
    for (const m of content.matchAll(/(?:getAppCollection|getXcloudCollection|getMongoCollection)\s*(?:<[^>]*>)?\s*\(\s*['"]([^'"]+)['"]/g)) names.add(m[1]);
    const business = [...names].filter((name) => BUSINESS_COLLECTIONS.has(name));
    if (business.length === 0) continue;
    capabilities.push({ file: relFile, collections: business });
    const ops = new Set();
    let om;
    MONGO_OP_RE.lastIndex = 0;
    while ((om = MONGO_OP_RE.exec(content)) !== null) ops.add(om[1]);
    if ([...ops].some((op) => MONGO_READ_OPS.has(op))) readers.push({ file: relFile, collections: business });
    if ([...ops].some((op) => MONGO_WRITE_OPS.has(op))) writers.push({ file: relFile, collections: business });
  }
  return { readers, writers, accessFiles, capabilities };
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

const GO_SENTINEL_KEY = 'GET /api/__phase84_unclassified_sentinel__';

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
// CI supersession evaluation (derived, non-tautological)
// ---------------------------------------------------------------------------

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

/** Derive the CI supersession facts from a workflow source string (pure function). */
function evaluateCiSupersession(ciSource) {
  const jobs = parseCiWorkflow(ciSource);
  const jobKeys = new Set(jobs.map((j) => j.key));
  const allRuns = jobs.flatMap((j) => j.steps.map((s) => s.run || ''));
  const hasNewJob = jobKeys.has(P84_CI_JOB_ID) || ciSource.includes(P84_CI_JOB_NAME);
  const newJobRunsSuite = allRuns.some((r) => r.includes(P84_SUITE));
  const oldSuiteRunPresent = allRuns.some((r) => r.includes(P83_SUITE));
  const readinessRunPresent = allRuns.some((r) => r.includes(READINESS_VALIDATOR));
  const currentJobs = {
    'node-quality': allRuns.some((r) => r.includes('scripts/migration/validate-inventory.mjs')),
    'go-backend': /working-directory:\s*backend/.test(ciSource) || /\bgo test\b/.test(ciSource),
    'direct-operations': allRuns.some((r) => r.includes('scripts/test-direct-operations.mjs')),
    'user-management': allRuns.some((r) => r.includes('scripts/test-user-management-e2e.mjs')),
    'auth-cutover': allRuns.some((r) => r.includes('scripts/test-auth-cutover.mjs')),
  };
  return { jobs, jobKeys, hasNewJob, newJobRunsSuite, oldSuiteRunPresent, readinessRunPresent, currentJobs };
}

// ---------------------------------------------------------------------------
// Frontend build + servers
// ---------------------------------------------------------------------------

function ensureFrontendBuild() {
  const buildId = path.join(frontendRoot, '.next', 'BUILD_ID');
  if (existsSync(buildId) && !process.env.P84_FORCE_FRONTEND_BUILD) {
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
  const hash = await bcrypt.hash('P84Pass123!', 10);
  const now = new Date().toISOString();

  await aDb.collection('app_users').insertMany([
    { username: 'p84_admin', passwordHash: hash, role: 'admin', status: 'active', displayName: 'P84 Admin', email: 'p84admin@test.local', createdAt: now, updatedAt: now, security: { sessionVersion: 1, failedLoginAttempts: 0 } },
    { username: 'p84_viewer', passwordHash: hash, role: 'viewer', status: 'active', displayName: 'P84 Viewer', email: 'p84viewer@test.local', createdAt: now, updatedAt: now, security: { sessionVersion: 1, failedLoginAttempts: 0 } },
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
  console.log('-- Phase 8.4 Frontend Dependency & Residual Node Runtime Cleanup Acceptance Suite --\n');
  console.log(`  test Mongo URI: ${uri}`);

  // ---- Mongo gate (REQUIRED) ------------------------------------------------
  try {
    await client.connect();
    await client.db('admin').command({ ping: 1 });
  } catch (err) {
    console.error('');
    console.error('FATAL: MongoDB is not reachable.');
    console.error(`  MONGODB_URI = ${uri}`);
    console.error('  set MONGODB_URI (or P84_TEST_MONGODB_URI) to a reachable MongoDB instance.');
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

  const cutoverKeys = new Set(CUTOVER_TABLE.map((r) => key(r.method, r.path)));
  const goKeys = new Set(goRegs.map((r) => key(r.method, r.canonicalPath)));

  // ===========================================================================
  console.log('\n[1] Source / Package Invariants (P84-S)');

  await check('P84-S01 removed Next.js API tree derives 0 route files and 0 operations', () => {
    assert.equal(existsSync(apiRoot), false, `the App Router API tree must be absent: ${rel(apiRoot)}`);
    assert.equal(nextApiRouteFiles, 0, `next_api_route_files must derive 0, found ${nextApiRouteFiles}`);
    assert.equal(nextApiOperations, 0, `next_api_operations must derive 0, found ${nextApiOperations}`);
  });

  await check('P84-S02 removed Next.js server tree derives 0 files', () => {
    assert.equal(existsSync(serverRoot), false, `the Next.js server tree must be absent: ${rel(serverRoot)}`);
    assert.equal(nodeServerTreeFiles, 0, `node_server_tree_files must derive 0, found ${nodeServerTreeFiles}`);
  });

  await check('P84-S03 zero real dependency edges on the removed Next.js server tree', () => {
    assert.equal(activeServerImports, 0,
      `active_server_imports must be 0; found: ${serverImportHits.map((h) => `${h.file}:${h.line}`).join(', ')}`);
  });

  await check('P84-S04 no surviving frontend/src file imports @/server or @/app/api', () => {
    assert.equal(serverAlias.length, 0, `@/server imports: ${serverAlias.join(', ')}`);
    assert.equal(apiAlias.length, 0, `@/app/api imports: ${apiAlias.join(', ')}`);
  });

  // -- Git boundary probes (working-tree diff, correct before and after commit) --
  const startShaResolved = gitProbe(`cat-file -t ${PHASE84_START_SHA}`);
  const rootManifestDiff = gitProbe(`diff --name-only --no-renames ${PHASE84_START_SHA} -- ${ROOT_MANIFESTS.join(' ')}`);
  const backendDiff = gitProbe(`diff --name-only --no-renames ${PHASE84_START_SHA} -- backend`);
  const frozenFrontendDiff = gitProbe(`diff --name-only --no-renames ${PHASE84_START_SHA} -- ${FROZEN_FRONTEND_FILES.join(' ')}`);
  const frozenSuitesDiff = gitProbe(`diff --name-only --no-renames ${PHASE84_START_SHA} -- ${P83_SUITE}`);

  const rootManifestChanged = rootManifestDiff.ok ? rootManifestDiff.out.split('\n').map((l) => l.trim()).filter(Boolean) : [];
  const backendChangedFiles = backendDiff.ok ? backendDiff.out.split('\n').map((l) => l.trim()).filter(Boolean) : [];
  const frozenFrontendChanged = frozenFrontendDiff.ok ? frozenFrontendDiff.out.split('\n').map((l) => l.trim()).filter(Boolean) : [];
  const frozenSuiteChanged = frozenSuitesDiff.ok ? frozenSuitesDiff.out.split('\n').map((l) => l.trim()).filter(Boolean) : [];

  const backendTestOnlyPath = (file) => file.endsWith('_test.go') || file.includes('/testdata/');
  const backendProductionChanges = backendChangedFiles.filter((file) => !backendTestOnlyPath(file));

  const rootPackageJsonChanged = rootManifestChanged.includes('package.json');
  const rootPackageLockChanged = rootManifestChanged.includes('package-lock.json');

  await check('P84-S05 root package.json / package-lock.json unchanged vs the Phase 8.4 start SHA', () => {
    assert.ok(startShaResolved.ok && startShaResolved.out === 'commit',
      `start commit ${PHASE84_START_SHA} must be present locally: ${startShaResolved.error}`);
    assert.ok(rootManifestDiff.ok, `root manifest diff must be computable: ${rootManifestDiff.error}`);
    assert.equal(rootPackageJsonChanged, false, 'root_package_json_changed must be false');
    assert.equal(rootPackageLockChanged, false, 'root_package_lock_changed must be false');
  });

  await check('P84-S06 frontend manifest delta reconciles: after + removed = before, removed set is exactly {bcryptjs}', () => {
    const baselineRaw = gitShow(PHASE84_START_SHA, 'frontend/package.json');
    assert.ok(baselineRaw, 'the baseline frontend/package.json must be resolvable via git show');
    const baseline = JSON.parse(baselineRaw);
    const current = readJson(path.join(frontendRoot, 'package.json'));

    const baselineDeps = declaredDependencies(baseline);
    const currentDeps = declaredDependencies(current);
    const beforeNames = Object.keys(baselineDeps).sort();
    const afterNames = Object.keys(currentDeps).sort();
    const removedNames = beforeNames.filter((n) => !currentDeps[n]);
    const keptNames = afterNames.filter((n) => currentDeps[n]);

    assert.equal(beforeNames.length, 20, `frontend_dependencies_before must derive 20, found ${beforeNames.length}`);
    assert.equal(afterNames.length, 19, `frontend_dependencies_after must derive 19, found ${afterNames.length}`);
    assert.equal(removedNames.length, 1, `frontend_dependencies_removed must derive 1, found ${removedNames.length}`);
    assert.equal(keptNames.length, 19, `frontend_dependencies_kept must derive 19, found ${keptNames.length}`);
    assert.equal(afterNames.length + removedNames.length, beforeNames.length, 'after + removed must equal before');
    assert.deepEqual(removedNames, ['bcryptjs'], `the removed set must be exactly {bcryptjs}, found ${removedNames.join(', ')}`);
  });

  await check('P84-S07 retained dependency version specifiers and scripts are unchanged vs the boundary', () => {
    const baseline = JSON.parse(gitShow(PHASE84_START_SHA, 'frontend/package.json'));
    const current = readJson(path.join(frontendRoot, 'package.json'));
    const sections = ['dependencies', 'devDependencies'];
    const drift = [];
    for (const section of sections) {
      const before = baseline[section] || {};
      const after = current[section] || {};
      for (const [name, version] of Object.entries(after)) {
        if (before[name] !== version) drift.push(`${section}.${name}: ${before[name]} -> ${version}`);
      }
    }
    assert.equal(drift.length, 0, `retained_dependency_versions_unchanged must hold; drift: ${drift.join(', ')}`);
    assert.deepEqual(current.scripts, baseline.scripts, 'the frontend scripts section must be unchanged');
  });

  await check('P84-S08 zero production Go changes vs the boundary SHA', () => {
    assert.ok(backendDiff.ok, `backend diff must be computable: ${backendDiff.error}`);
    assert.equal(backendChangedFiles.filter((f) => !backendTestOnlyPath(f)).length, 0,
      `production Go tree changed vs boundary: ${backendProductionChanges.join(', ')}`);
  });

  const proxyDisk = readFileSync(path.join(root, 'frontend/src/proxy.ts'), 'utf8');
  const accountSessionDisk = readFileSync(path.join(root, 'frontend/src/lib/accountSession.ts'), 'utf8');
  const cutoverDisk = readFileSync(path.join(root, 'frontend/src/lib/cutover-routing.ts'), 'utf8');
  const proxyBaseline = gitShowExact(PHASE84_START_SHA, 'frontend/src/proxy.ts');
  const accountSessionBaseline = gitShowExact(PHASE84_START_SHA, 'frontend/src/lib/accountSession.ts');
  const cutoverBaseline = gitShowExact(PHASE84_START_SHA, 'frontend/src/lib/cutover-routing.ts');

  const proxyUnchanged = proxyBaseline !== null && stripCr(proxyBaseline) === stripCr(proxyDisk);
  const accountSessionUnchanged = accountSessionBaseline !== null && stripCr(accountSessionBaseline) === stripCr(accountSessionDisk);
  const cutoverUnchanged = cutoverBaseline !== null && stripCr(cutoverBaseline) === stripCr(cutoverDisk);
  const accountSessionSemanticsChanged = accountSessionUnchanged ? false : true;

  await check('P84-S09 proxy.ts / accountSession.ts / cutover-routing.ts byte-identical vs the boundary', () => {
    assert.ok(proxyBaseline !== null && accountSessionBaseline !== null && cutoverBaseline !== null,
      'the frozen frontend files must be resolvable at the boundary SHA');
    assert.equal(frozenFrontendChanged.length, 0,
      `frozen frontend files changed vs boundary: ${frozenFrontendChanged.join(', ')}`);
    assert.equal(proxyUnchanged, true, 'frontend/src/proxy.ts must be unchanged vs the boundary');
    assert.equal(accountSessionUnchanged, true, 'frontend/src/lib/accountSession.ts must be unchanged vs the boundary');
    assert.equal(cutoverUnchanged, true, 'frontend/src/lib/cutover-routing.ts must be unchanged vs the boundary');
  });

  await check('P84-S10 account_session_semantics_changed derives false', () => {
    assert.equal(accountSessionSemanticsChanged, false, 'account_session_semantics_changed must be false');
  });

  // ===========================================================================
  console.log('\n[2] Dependency Consumer Graph + Classification (P84-D)');

  const graph = scanFrontendGraph();
  const libConsumerCount = (libRel) => (graph.libConsumers.get(libRel) || new Set()).size;
  // Runtime entry points of the surviving Node runtime: the proxy plus the Next.js app tree.
  const runtimeReachableSrc = computeRuntimeReachableSrcFiles(
    graph.srcEdges,
    graph.srcFiles
      .map((f) => rel(f))
      .filter((p) => p === 'frontend/src/proxy.ts' || p.startsWith('frontend/src/app/')),
  );

  const currentPkg = readJson(path.join(frontendRoot, 'package.json'));
  const currentLock = readJson(path.join(frontendRoot, 'package-lock.json'));
  const lockRoot = currentLock.packages && currentLock.packages[''] ? currentLock.packages[''] : {};
  const declaredAll = new Set(Object.keys(declaredDependencies(currentPkg)));

  // Build helper evidence sets.
  const configConsumerPackages = new Set();
  for (const [pkg, set] of graph.packageConsumers) {
    if ([...set].some((p) => isConfigFile(p))) configConsumerPackages.add(pkg);
  }
  const buildRelatedPackages = new Set();
  for (const pkg of configConsumerPackages) {
    const node = (currentLock.packages || {})[`node_modules/${pkg}`];
    if (node && node.dependencies) {
      for (const dep of Object.keys(node.dependencies)) {
        if (declaredAll.has(dep)) buildRelatedPackages.add(dep);
      }
    }
  }
  const tsconfigPresent = existsSync(path.join(frontendRoot, 'tsconfig.json'));

  function structuralEvidence(pkg) {
    const ev = [];
    if (tsconfigPresent && (pkg === 'typescript' || pkg.startsWith('@types/'))) ev.push('type-package-relationship');
    if (buildRelatedPackages.has(pkg)) ev.push('build-tool-dependency');
    if (Object.prototype.hasOwnProperty.call(RUNTIME_PEERS, pkg)) ev.push('runtime-peer');
    return ev;
  }

  function descriptorFor(pkg, section) {
    const consumers = [...(graph.packageConsumers.get(pkg) || [])];
    const srcConsumers = consumers.filter(isFrontendSrcFile);
    return {
      name: pkg,
      section,
      srcConsumers,
      runtimeSrcConsumers: srcConsumers.filter((c) => runtimeReachableSrc.has(c)),
      testConsumers: consumers.filter(isTestFile),
      configConsumers: consumers.filter(isConfigFile),
      scriptConsumers: scriptConsumersOf(pkg, currentPkg.scripts),
      structural: structuralEvidence(pkg),
    };
  }

  const dependencyRows = [];
  for (const section of ['dependencies', 'devDependencies']) {
    for (const pkg of Object.keys(currentPkg[section] || {})) {
      const d = descriptorFor(pkg, section);
      const classification = classifyDependency(d);
      dependencyRows.push({
        package: pkg,
        section,
        classification,
        consumerCount: d.srcConsumers.length + d.testConsumers.length + d.configConsumers.length + d.scriptConsumers.length,
        consumers: [...d.srcConsumers, ...d.testConsumers, ...d.configConsumers, ...d.scriptConsumers],
      });
    }
  }

  const unclassifiedDeps = dependencyRows.filter((r) => !Object.values(DEP_CLASS).includes(r.classification));
  const unusedDeps = dependencyRows.filter((r) => r.classification === DEP_CLASS.REMOVE_UNUSED);
  const declaredCount = Object.keys(declaredDependencies(currentPkg)).length;

  const bcryptjsConsumers = [...(graph.packageConsumers.get('bcryptjs') || [])].length;
  const joseConsumers = [...(graph.packageConsumers.get('jose') || [])].length;
  const mongodbConsumers = [...(graph.packageConsumers.get('mongodb') || [])].length;
  const jitiConsumers = [...(graph.packageConsumers.get('jiti') || [])].length;

  await check('P84-D01 every declared frontend direct dependency has exactly one classification', () => {
    assert.equal(dependencyRows.length, declaredCount,
      `frontend_dependency_classified must reconcile with declared (${declaredCount}), found ${dependencyRows.length}`);
    assert.equal(unclassifiedDeps.length, 0, `unclassified: ${unclassifiedDeps.map((r) => r.package).join(', ')}`);
  });

  await check('P84-D02 zero unused direct frontend dependencies remain', () => {
    assert.equal(unusedDeps.length, 0, `REMOVE_UNUSED packages: ${unusedDeps.map((r) => r.package).join(', ')}`);
  });

  await check('P84-D03 bcryptjs has zero frontend consumers and is absent from manifest and lockfile', () => {
    assert.equal(bcryptjsConsumers, 0, `frontend_bcryptjs_consumers must be 0, found ${bcryptjsConsumers}`);
    assert.equal(Object.prototype.hasOwnProperty.call(declaredDependencies(currentPkg), 'bcryptjs'), false,
      'bcryptjs must not be declared in frontend/package.json');
    assert.equal(readFileSync(path.join(frontendRoot, 'package-lock.json'), 'utf8').includes('bcryptjs'), false,
      'bcryptjs must not appear anywhere in frontend/package-lock.json');
  });

  await check('P84-D04 jose / mongodb / jiti resolve to their required positive consumer counts', () => {
    assert.ok(joseConsumers > 0, `frontend_jose_consumers must be > 0, found ${joseConsumers}`);
    assert.ok(mongodbConsumers > 0, `frontend_mongodb_consumers must be > 0, found ${mongodbConsumers}`);
    assert.ok(jitiConsumers > 0, `frontend_jiti_consumers must be > 0, found ${jitiConsumers}`);
    assert.equal(dependencyRows.find((r) => r.package === 'jose').classification, DEP_CLASS.KEEP_RUNTIME_PROXY,
      'jose must classify as KEEP_RUNTIME_PROXY');
    assert.equal(dependencyRows.find((r) => r.package === 'mongodb').classification, DEP_CLASS.KEEP_RUNTIME_SESSION,
      'mongodb must classify as KEEP_RUNTIME_SESSION');
    assert.equal(dependencyRows.find((r) => r.package === 'jiti').classification, DEP_CLASS.KEEP_TEST_TOOLING,
      'jiti must classify as KEEP_TEST_TOOLING');
  });

  await check('P84-D05 scanner derives consumers for the spec-required surviving libraries', () => {
    const required = [
      'frontend/src/lib/locales/en.ts',
      'frontend/src/lib/fetcher.ts',
      'frontend/src/lib/permissions.ts',
      'frontend/src/lib/unitParser.ts',
      'frontend/src/lib/subscriberValidation.ts',
    ];
    for (const lib of required) {
      assert.ok(libConsumerCount(lib) > 0, `scanner must derive > 0 consumers for ${lib}`);
    }
  });

  let dependencyClassifierNegativeSentinel = false;

  await check('P84-D06 negative sentinel: the dependency classifier is not tautological', () => {
    const unused = { name: 'synthetic-unused-package', section: 'dependencies', srcConsumers: [], testConsumers: [], configConsumers: [], scriptConsumers: [], structural: [] };
    assert.equal(classifyDependency(unused), DEP_CLASS.REMOVE_UNUSED,
      'a declared package with zero consumers must classify as REMOVE_UNUSED');
    const live = { name: 'synthetic-live-package', section: 'dependencies', srcConsumers: ['frontend/src/synthetic.ts'], testConsumers: [], configConsumers: [], scriptConsumers: [], structural: [] };
    assert.notEqual(classifyDependency(live), DEP_CLASS.REMOVE_UNUSED,
      'a declared package with one runtime consumer must not classify as REMOVE_UNUSED');
    const sessionOnly = {
      name: 'synthetic-session-package', section: 'dependencies', srcConsumers: ['frontend/src/lib/sessionAccountStore.ts'],
      runtimeSrcConsumers: ['frontend/src/lib/sessionAccountStore.ts'], testConsumers: [], configConsumers: [], scriptConsumers: [], structural: [],
    };
    assert.equal(classifyDependency(sessionOnly), DEP_CLASS.KEEP_RUNTIME_SESSION,
      'a package whose only runtime consumers are in the session chain must classify as KEEP_RUNTIME_SESSION');
    const sessionPlusUi = {
      name: 'synthetic-mixed-package', section: 'dependencies',
      srcConsumers: ['frontend/src/lib/sessionAccountStore.ts', 'frontend/src/components/synthetic.tsx'],
      runtimeSrcConsumers: ['frontend/src/lib/sessionAccountStore.ts', 'frontend/src/components/synthetic.tsx'],
      testConsumers: [], configConsumers: [], scriptConsumers: [], structural: [],
    };
    assert.equal(classifyDependency(sessionPlusUi), DEP_CLASS.KEEP_RUNTIME_UI,
      'a session consumer plus a non-session runtime consumer must not classify as KEEP_RUNTIME_SESSION');
    const fixtureOnly = {
      name: 'synthetic-fixture-package', section: 'dependencies', srcConsumers: ['frontend/src/lib/xcloudSubscriber.ts'],
      runtimeSrcConsumers: [], testConsumers: [], configConsumers: [], scriptConsumers: [], structural: [],
    };
    assert.equal(classifyDependency(fixtureOnly), DEP_CLASS.KEEP_RUNTIME_UI,
      'a src consumer outside the runtime graph must fall back to the source-consumer evidence');
    dependencyClassifierNegativeSentinel = true;
  });

  // ===========================================================================
  console.log('\n[3] Residual Lib Classification (P84-L)');

  const runtimeReachableLibs = computeRuntimeReachableLibs(graph.libEdges);
  const libRows = [];
  for (const file of graph.libFiles) {
    const relLib = rel(file);
    const consumers = [...(graph.libConsumers.get(relLib) || [])];
    const d = {
      name: relLib,
      runtimeReachable: runtimeReachableLibs.has(relLib),
      srcConsumers: consumers.filter(isFrontendSrcFile),
      testConsumers: consumers.filter(isTestFile),
    };
    libRows.push({ lib: relLib, classification: classifyResidualLib(d), consumerCount: consumers.length, consumers });
  }

  const residualUnclassified = libRows.filter((r) => !r.classification).length;
  const deadLibsRemaining = libRows.filter((r) => r.classification === 'DELETE_REQUIRED');
  const residualLibKept = libRows.length;
  const residualLibRemoved = DELETED_RESIDUAL_LIBS.length;

  await check('P84-L01 every surviving lib file is classified and none is dead', () => {
    assert.equal(residualUnclassified, 0, 'residual_lib_unclassified must be 0');
    assert.equal(deadLibsRemaining.length, 0,
      `dead_node_era_libs_remaining must be 0; offenders: ${deadLibsRemaining.map((r) => r.lib).join(', ')}`);
  });

  await check('P84-L02 each deleted residual Node-era lib is absent from disk and has zero consumers', () => {
    const present = DELETED_RESIDUAL_LIBS.filter((p) => existsSync(path.join(root, p)));
    assert.equal(present.length, 0, `deleted residual libs still on disk: ${present.join(', ')}`);
    for (const p of DELETED_RESIDUAL_LIBS) {
      assert.equal(libConsumerCount(p), 0, `${p} must have zero current consumers`);
    }
  });

  await check('P84-L03 spec minimum residual-lib inventory is explicitly resolved (deleted absent, kept consumed)', () => {
    const keptInSpec = SPEC_MIN_RESIDUAL_LIBS.filter((p) => !DELETED_RESIDUAL_LIBS.includes(p));
    const deletedInSpec = SPEC_MIN_RESIDUAL_LIBS.filter((p) => DELETED_RESIDUAL_LIBS.includes(p));
    assert.ok(deletedInSpec.length >= 3, 'the spec inventory must include several deleted residual libs');
    for (const p of deletedInSpec) {
      assert.equal(existsSync(path.join(root, p)), false, `${p} must be absent from disk`);
      assert.equal(libConsumerCount(p), 0, `${p} must have zero consumers`);
    }
    for (const p of keptInSpec) {
      assert.equal(existsSync(path.join(root, p)), true, `${p} must still exist on disk`);
      assert.ok(libConsumerCount(p) > 0, `${p} must retain at least one consumer`);
    }
  });

  let residualLibClassifierNegativeSentinel = false;

  await check('P84-L04 negative sentinel: the residual-lib acceptance predicate rejects an orphan KEEP', () => {
    assert.equal(residualLibAccepted('KEEP_RUNTIME', 0), false,
      'an orphan lib classified KEEP must be rejected by the acceptance predicate');
    assert.equal(residualLibAccepted('DELETE_REQUIRED', 0), true,
      'a zero-consumer lib classified DELETE_REQUIRED must be accepted');
    assert.equal(residualLibAccepted('KEEP_UI', 2), true,
      'a consumed lib classified KEEP must be accepted');
    residualLibClassifierNegativeSentinel = true;
  });

  // ===========================================================================
  console.log('\n[4] Minimal Mongo / Session Boundary (P84-M)');

  const sessionMongoPath = path.join(srcRoot, 'lib', 'sessionMongo.ts');
  const sessionMongoSource = existsSync(sessionMongoPath) ? readFileSync(sessionMongoPath, 'utf8') : '';
  const sessionMongoAnalysis = analyzeSessionMongoSource(sessionMongoSource);
  const sessionChain = scanSessionChain();
  const removedCapabilityHits = scanRemovedMongoCapabilities();
  const mongoAccess = scanNextBusinessMongo();

  const sessionMongoExports = [...sessionMongoAnalysis.exports].sort();
  const expectedSessionExports = ['closeSessionMongoClient', 'getSessionUsersCollection'];

  await check('P84-M01 sessionMongo.ts exposes exactly the minimal read-only session contract', () => {
    assert.equal(existsSync(sessionMongoPath), true, 'frontend/src/lib/sessionMongo.ts must exist');
    assert.equal(sessionMongoAnalysis.collections.length, 1,
      `exactly one .collection(...) call expected, found ${sessionMongoAnalysis.collections.length}`);
    assert.equal(sessionMongoAnalysis.collections[0], 'app_users',
      `the only collection literal must be app_users, found ${sessionMongoAnalysis.collections[0]}`);
    assert.deepEqual(sessionMongoExports, expectedSessionExports,
      `sessionMongo exports must be exactly ${expectedSessionExports.join(', ')}, found ${sessionMongoExports.join(', ')}`);
    assert.equal(sessionMongoAnalysis.ops.length, 0, 'sessionMongo.ts itself must contain no Mongo query operations');
  });

  await check('P84-M02 the entire session chain performs reads only (findOne)', () => {
    assert.equal(sessionChain.writes, 0, `proxy_session_mongo_writers must be 0, found ${sessionChain.writes}`);
    assert.equal(sessionChain.reads, 1, `proxy_session_mongo_readers must be 1, found ${sessionChain.reads}`);
    assert.ok(sessionChain.ops.every((o) => o.op === 'findOne'),
      `the session chain must only read via findOne: ${sessionChain.ops.map((o) => `${o.file}:${o.op}`).join(', ')}`);
  });

  await check('P84-M03 zero residual generic business Mongo capability remains in frontend/src', () => {
    assert.equal(removedCapabilityHits.filter((h) => h.symbol === 'mongoCollections').length, 0,
      `frontend_business_collection_constants must be 0: ${JSON.stringify(removedCapabilityHits.filter((h) => h.symbol === 'mongoCollections'))}`);
    const xcloudHelpers = removedCapabilityHits.filter((h) => ['xcloudDbName', 'getXcloudDb', 'getXcloudCollection'].includes(h.symbol));
    assert.equal(xcloudHelpers.length, 0, `frontend_xcloud_db_helpers must be 0: ${JSON.stringify(xcloudHelpers)}`);
    const genericHelpers = removedCapabilityHits.filter((h) => ['getMongoCollection', 'getAppCollection', 'getXcloudCollection', 'mongoCollections'].includes(h.symbol));
    assert.equal(genericHelpers.length, 0, `frontend_generic_business_collection_helpers must be 0: ${JSON.stringify(genericHelpers)}`);
    assert.equal(removedCapabilityHits.length, 0,
      `no removed Mongo capability identifier may survive outside sessionMongo: ${JSON.stringify(removedCapabilityHits)}`);
  });

  await check('P84-M04 surviving Next.js production source performs zero business Mongo reads/writes', () => {
    assert.equal(mongoAccess.readers.length, 0, `business readers: ${mongoAccess.readers.map((r) => r.file).join(', ')}`);
    assert.equal(mongoAccess.writers.length, 0, `business writers: ${mongoAccess.writers.map((w) => w.file).join(', ')}`);
    assert.equal(mongoAccess.capabilities.length, 0,
      `next_business_mongo_collection_capabilities must be 0: ${JSON.stringify(mongoAccess.capabilities)}`);
    const allowedMongoFiles = new Set(['frontend/src/lib/sessionMongo.ts', 'frontend/src/lib/sessionAccountStore.ts']);
    const unexpected = mongoAccess.accessFiles.filter((f) => !allowedMongoFiles.has(f));
    assert.equal(unexpected.length, 0, `unexpected Mongo access files: ${unexpected.join(', ')}`);
  });

  const proxySessionMongoCollections = sessionMongoAnalysis.collections.length;
  const proxySessionMongoCollection = sessionMongoAnalysis.collections[0] || '';
  const proxySessionMongoReaders = sessionChain.reads;
  const proxySessionMongoWriters = sessionChain.writes;

  await check('P84-M05 session boundary metrics derive the required exact values', () => {
    assert.equal(proxySessionMongoCollections, 1, 'proxy_session_mongo_collections must be 1');
    assert.equal(proxySessionMongoCollection, 'app_users', 'proxy_session_mongo_collection must be app_users');
    assert.equal(proxySessionMongoReaders, 1, 'proxy_session_mongo_readers must be 1');
    assert.equal(proxySessionMongoWriters, 0, 'proxy_session_mongo_writers must be 0');
  });

  let sessionMongoBoundaryNegativeSentinel = false;

  await check('P84-M06 negative sentinel: the session boundary detector reports a business collection', () => {
    const synthetic = [
      "import { MongoClient } from 'mongodb';",
      'export async function getThing() {',
      '  const client = new MongoClient(uri);',
      "  return client.db('xcloud').collection('ocs_balances').findOne({});",
      '}',
    ].join('\n');
    const analysis = analyzeSessionMongoSource(synthetic);
    const business = analysis.collections.filter((c) => BUSINESS_COLLECTIONS.has(c));
    assert.ok(business.includes('ocs_balances'),
      `a synthetic session store touching ocs_balances must be reported as a business capability, found ${JSON.stringify(business)}`);
    sessionMongoBoundaryNegativeSentinel = true;
  });

  // ===========================================================================
  console.log('\n[5] Proxy / Session Preservation (P84-P)');

  const proxySource = proxyDisk;
  const sessionStoreSource = readFileSync(path.join(srcRoot, 'lib', 'sessionAccountStore.ts'), 'utf8');

  await check('P84-P01 proxy verifies JWT before Mongo revalidation before binding identity headers', () => {
    const iVerify = proxySource.indexOf('jwtVerify');
    const iValidate = proxySource.indexOf('validateCurrentAccount');
    const iHeader = proxySource.indexOf("requestHeaders.set('x-user'");
    assert.ok(iVerify >= 0, 'jwtVerify must be present');
    assert.ok(iValidate >= 0, 'validateCurrentAccount must be present');
    assert.ok(iHeader >= 0, "x-user header assignment must be present");
    assert.ok(iVerify < iValidate, 'jwtVerify must precede validateCurrentAccount');
    assert.ok(iValidate < iHeader, 'validateCurrentAccount must precede the x-user header binding');
  });

  await check('P84-P02 proxy pins HS256 and never casts the JWT role', () => {
    assert.ok(proxySource.includes("algorithms: ['HS256']"), 'HS256 algorithm must be pinned');
    assert.equal(proxySource.includes('payload.role as string'), false, 'payload.role must never be cast');
  });

  await check('P84-P03 proxy keeps the fail-closed GO_BACKEND_UNREACHABLE branch', () => {
    assert.ok(proxySource.includes('GO_BACKEND_UNREACHABLE'), 'GO_BACKEND_UNREACHABLE must be present');
    assert.ok(proxySource.includes('AUTH_UNAVAILABLE'), 'the non-auth 503 branch must be present');
  });

  await check('P84-P04 session store is present, read-only and scoped to the session Mongo contract', () => {
    assert.ok(sessionStoreSource.includes('findOne'), 'session store must read via findOne');
    assert.ok(sessionStoreSource.includes("from '@/lib/sessionMongo'"),
      'session store must import the minimal session Mongo module');
    const writeOp = /\b(insertOne|insertMany|updateOne|updateMany|replaceOne|deleteOne|deleteMany|bulkWrite|findOneAndUpdate|findOneAndDelete|createIndex|drop)\s*\(/;
    assert.equal(writeOp.test(sessionStoreSource), false, 'session store must contain no write operations');
    assert.equal(sessionStoreSource.includes("'security.sessionVersion'"), true,
      'session store projection must include security.sessionVersion');
    for (const field of ['username', 'role', 'status', 'locked']) {
      assert.ok(new RegExp(`\\b${field}:`).test(sessionStoreSource), `session store projection must include ${field}`);
    }
    assert.equal(sessionChain.writes, 0, 'the session store chain must never write');
  });

  await check('P84-P05 session regression matrix (validateAccountSnapshot)', () => {
    const active = { username: 'p84_admin', role: 'admin', status: 'active', security: { sessionVersion: 1 } };
    const claims = { username: 'p84_admin', role: 'admin', sv: 1 };

    const accepted = validateAccountSnapshot(claims, active);
    assert.equal(accepted.username, 'p84_admin', 'active account with matching claims must be accepted');

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

  await check('P84-P06 proxy session-validation contract is wired end to end', () => {
    assert.ok(proxySource.includes('validateCurrentAccount'), 'proxy must call validateCurrentAccount');
    assert.ok(accountSessionDisk.includes('validateCurrentAccount'), 'accountSession must export validateCurrentAccount');
    assert.ok(proxySource.includes("from '@/lib/accountSession'"), 'proxy must import the account session module');
    assert.ok(accountSessionDisk.includes("from '@/lib/sessionAccountStore'"), 'accountSession must route through sessionAccountStore');
    assert.ok(sessionStoreSource.includes("from '@/lib/sessionMongo'"), 'sessionAccountStore must route through sessionMongo');
  });

  // ===========================================================================
  console.log('\n[6] CI / Supersession Integrity (P84-C)');

  const ciSource = existsSync(ciPath) ? readFileSync(ciPath, 'utf8') : '';
  const ciEval = evaluateCiSupersession(ciSource);

  await check('P84-C01 CI exposes the Phase 8.4 dependency cleanup job and this suite', () => {
    assert.ok(ciEval.hasNewJob,
      `CI must expose job id '${P84_CI_JOB_ID}' or name '${P84_CI_JOB_NAME}'`);
    assert.ok(ciEval.newJobRunsSuite, `CI must run the Phase 8.4 suite '${P84_SUITE}'`);
  });

  await check('P84-C02 CI no longer runs the frozen Phase 8.3 removal suite', () => {
    assert.equal(ciEval.oldSuiteRunPresent, false,
      `CI must not run '${P83_SUITE}' after the Phase 8.4 supersession`);
  });

  await check('P84-C03 CI still runs the backend-removal readiness validator', () => {
    assert.ok(ciEval.readinessRunPresent, `CI must still run '${READINESS_VALIDATOR}'`);
  });

  await check('P84-C04 current Node/Go/integration CI jobs are preserved', () => {
    for (const [name, present] of Object.entries(ciEval.currentJobs)) {
      assert.equal(present, true, `current CI job evidence '${name}' must be present`);
    }
  });

  await check('P84-C05 frozen Phase 8.3 suite and the new Phase 8.4 doc exist on disk', () => {
    assert.equal(existsSync(path.join(root, P83_SUITE)), true, `${P83_SUITE} must stay on disk as frozen evidence`);
    assert.equal(frozenSuiteChanged.length, 0, `the frozen Phase 8.3 suite must be unchanged: ${frozenSuiteChanged.join(', ')}`);
    assert.equal(existsSync(path.join(root, P84_DOC)), true, `${P84_DOC} must exist`);
    assert.equal(existsSync(path.join(root, P84_SUITE)), true, `${P84_SUITE} must exist`);
  });

  let ciSupersessionNegativeSentinel = false;

  await check('P84-C06 negative sentinel: the CI supersession predicate flags a reintroduced 8.3 run', () => {
    const syntheticCi = `${ciSource}\n  synthetic_old_job:\n    name: Synthetic old\n    steps:\n      - name: Old suite\n        run: node ${P83_SUITE}\n`;
    const syntheticEval = evaluateCiSupersession(syntheticCi);
    assert.equal(syntheticEval.oldSuiteRunPresent, true,
      'the predicate must flag a workflow that still runs the Phase 8.3 suite');
    ciSupersessionNegativeSentinel = true;
  });

  // ===========================================================================
  console.log('\n[7] Go Registration Equality (P84-G)');

  const goRegisteredUnrouted = [...goKeys].filter((k) => !cutoverKeys.has(k)).sort();
  const cutoverWithoutGoRegistration = [...cutoverKeys].filter((k) => !goKeys.has(k)).sort();
  const goUnclassified = goRegs
    .map((r) => ({ key: key(r.method, r.canonicalPath), category: classifyGoRegistration(key(r.method, r.canonicalPath), cutoverKeys) }))
    .filter((r) => r.category === GO_REG_CLASS.UNCLASSIFIED);

  await check('P84-G01 CUTOVER_TABLE length equals the Phase 8.4 contract size', () => {
    assert.equal(CUTOVER_TABLE.length, PHASE84_CUTOVER_TABLE_SIZE,
      `CUTOVER_TABLE must hold ${PHASE84_CUTOVER_TABLE_SIZE} routes, found ${CUTOVER_TABLE.length}`);
    assert.equal(CUTOVER_TABLE.filter((r) => r.owner === 'go').length, CUTOVER_TABLE.length, 'every entry must be owner=go');
  });

  await check('P84-G02 Go production registration set exactly equals the CUTOVER_TABLE set', () => {
    assert.equal(goKeys.size, goRegs.length, `duplicate Go registrations detected (${goRegs.length} vs ${goKeys.size})`);
    assert.equal(goKeys.size, cutoverKeys.size, `go_registered_operations=${goKeys.size} cutover=${cutoverKeys.size}`);
    for (const k of cutoverKeys) assert.ok(goKeys.has(k), `cutover route without a Go registration: ${k}`);
    for (const k of goKeys) assert.ok(cutoverKeys.has(k), `Go registration outside CUTOVER_TABLE: ${k}`);
    assert.equal(cutoverWithoutGoRegistration.length, 0, 'cutover_without_go_registration must be 0');
    assert.equal(goRegisteredUnrouted.length, 0, 'go_registered_unrouted must be 0');
    assert.equal(goUnclassified.length, 0, 'go_registered_unclassified must be 0');
  });

  await check('P84-G03 negative sentinel: an unknown registration is genuinely unclassified', () => {
    assert.equal(classifyGoRegistration(GO_SENTINEL_KEY, cutoverKeys), GO_REG_CLASS.UNCLASSIFIED,
      `synthetic ${GO_SENTINEL_KEY} must classify as ${GO_REG_CLASS.UNCLASSIFIED}`);
    assert.equal(goKeys.has(GO_SENTINEL_KEY), false, 'the synthetic sentinel must never be a real Go registration');
  });

  // ===========================================================================
  console.log('\n[8] Real Production Stack (Go binary + capture proxy + Next.js)');

  const backendDir = path.join(root, 'backend');
  const isWin = process.platform === 'win32';
  binPath = path.join(backendDir, isWin ? `test-p84-cleanup-${suffix}.exe` : `test-p84-cleanup-${suffix}`);
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

  const token = await makeToken('p84_admin', 'admin', 1);

  // -- P84-P07: Mongo-unavailable behaviour (real runtime, real proxy branch) -----
  nextPort = await getAvailablePort();
  nextProc = await startNextServer(nextPort, {
    GO_BACKEND_URL: `http://127.0.0.1:${capturePort}`,
    MONGODB_URI: UNREACHABLE_MONGO_URI,
    MONGODB_SERVER_SELECTION_TIMEOUT_MS: '800',
  });
  console.log(`  Next.js (Mongo unavailable) on 127.0.0.1:${nextPort}`);

  capture.reset();
  const mongoDownProbe = await httpProbe('GET', nextPort, '/api/users', { token, timeoutMs: 30000 });
  const mongoDownForward = capture.countOf('GET', '/api/users');

  await check('P84-P07 authenticated /api/* returns 503 AUTH_UNAVAILABLE when Mongo is unreachable', () => {
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
  console.log('\n[9] 84-Route Go Routing Integrity (P84-R, real HTTP)');

  const rSamples = [];
  for (let i = 0; i < cutoverRoutes.length; i++) {
    const route = cutoverRoutes[i];
    const id = `P84-R${String(i + 1).padStart(2, '0')}`;
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

  const phase84RoutesExpected = CUTOVER_TABLE.length;
  const phase84RoutesExecuted = rSamples.length;
  const phase84RoutesMissing = phase84RoutesExpected - phase84RoutesExecuted;
  const phase84RoutesDuplicate = rSamples.filter((s) => s.forward > 1).length;
  const phase84ExactlyOnceForwarded = rSamples.filter((s) => s.forward === 1).length;
  const phase84NodeBusinessExecutions = rSamples.filter((s) => s.forward === 0).length;

  await check('P84-R85 aggregate: 84/84 executed, exactly-once, zero Node business executions', () => {
    assert.equal(phase84RoutesExpected, PHASE84_CUTOVER_TABLE_SIZE, 'phase84_routes_expected must be 84');
    assert.equal(phase84RoutesExecuted, phase84RoutesExpected, 'every cutover route must be executed');
    assert.equal(phase84RoutesMissing, 0, 'phase84_routes_missing must be 0');
    assert.equal(phase84RoutesDuplicate, 0, 'phase84_routes_duplicate must be 0');
    assert.equal(phase84ExactlyOnceForwarded, phase84RoutesExpected, 'every route must forward exactly once');
    assert.equal(phase84NodeBusinessExecutions, 0, 'phase84_node_business_executions must be 0');
  });

  // ===========================================================================
  console.log('\n[10] Unknown + Retired API Behaviour (P84-U, real HTTP)');

  // Runs against the Go-reachable Next.js instance above.
  capture.reset();
  const unknownProbe = await httpProbe('GET', nextPort, '/api/__phase84_unknown_api_sentinel__', { token });
  const unknownForward = capture.countOf('GET', '/api/__phase84_unknown_api_sentinel__');
  console.log(`  unknown API sentinel actual framework status: ${unknownProbe.status}`);

  await check('P84-U01 unmatched /api/* is not Go-forwarded and returns a framework 404/405', () => {
    assert.equal(unknownForward, 0, `unknown API must never reach Go, forwards=${unknownForward}`);
    assert.ok(unknownProbe.status === 404 || unknownProbe.status === 405,
      `unknown API must return 404 or 405, got ${unknownProbe.status}`);
    assert.equal(unknownProbe.status >= 200 && unknownProbe.status < 300, false, 'unknown API must never return 2xx');
    assert.equal(unknownProbe.text.includes('GO_BACKEND_UNREACHABLE'), false, 'unknown API must not return GO_BACKEND_UNREACHABLE');
  });

  const unknownApiRuntimeEvidence = unknownProbe.status === 404 || unknownProbe.status === 405;

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
    const id = `P84-U${String(i + 2).padStart(2, '0')}`;
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
  const phase84RetiredExpected = RETIRED_PROBES.length;
  const phase84RetiredExecuted = retiredSamples.length;
  const phase84RetiredGoForwardCount = retiredSamples.reduce((sum, s) => sum + s.forward, 0);
  const phase84RetiredBusinessMutations = retiredBefore.digest === retiredAfter.digest ? 0 : 1;

  await check('P84-U08 aggregate: 6/6 retired probes, zero Go forwards, zero business mutations', async () => {
    assert.equal(phase84RetiredExpected, 6, 'retired probe count must be 6');
    assert.equal(phase84RetiredExecuted, phase84RetiredExpected, 'every retired probe must be executed');
    assert.equal(phase84RetiredGoForwardCount, 0, 'phase84_retired_go_forward_count must be 0');
    assert.equal(phase84RetiredBusinessMutations, 0, 'retired probes must not mutate the app_users business collection');
  });

  stopProcess(nextProc);
  nextProc = null;

  // ===========================================================================
  console.log('\n[11] Fail-Closed / No Fallback (P84-F, real HTTP)');

  nextPort = await getAvailablePort();
  nextProc = await startNextServer(nextPort, { GO_BACKEND_URL: UNREACHABLE_GO_URL });
  console.log(`  Next.js (Go unreachable) on 127.0.0.1:${nextPort}`);

  const failClosedBefore = await businessStateFingerprint();
  const fSamples = [];
  for (let i = 0; i < cutoverRoutes.length; i++) {
    const route = cutoverRoutes[i];
    const id = `P84-F${String(i + 1).padStart(2, '0')}`;
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
  const phase84FailClosedExpected = CUTOVER_TABLE.length;
  const phase84FailClosedExecuted = fSamples.length;
  const phase84FailClosedFailures = fSamples.filter((s) => !s.contract).length;
  const phase84FallbackCount = phase84FailClosedFailures;

  await check('P84-F85 aggregate: 84/84 fail-closed, zero fallback, zero business mutation', () => {
    assert.equal(phase84FailClosedExpected, PHASE84_CUTOVER_TABLE_SIZE, 'phase84_fail_closed_expected must be 84');
    assert.equal(phase84FailClosedExecuted, phase84FailClosedExpected, 'every route must be probed while Go is unreachable');
    assert.equal(phase84FailClosedFailures, 0, 'phase84_fail_closed_failures must be 0');
    assert.equal(phase84FallbackCount, 0, 'phase84_fallback_count must be 0');
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

  const nextBusinessMongoReaders = mongoAccess.readers.length;
  const nextBusinessMongoWriters = mongoAccess.writers.length;
  const nextBusinessMongoCollectionCapabilities = mongoAccess.capabilities.length;

  // Lockfile reconciliation.
  const lockfileText = readFileSync(path.join(frontendRoot, 'package-lock.json'), 'utf8');
  const declaredDeps = currentPkg.dependencies || {};
  const declaredDevDeps = currentPkg.devDependencies || {};
  const lockDeps = lockRoot.dependencies || {};
  const lockDevDeps = lockRoot.devDependencies || {};
  const missingPackages = [
    ...Object.keys(declaredDeps).filter((k) => !lockDeps[k]),
    ...Object.keys(declaredDevDeps).filter((k) => !lockDevDeps[k]),
  ];
  const extraneousPackages = [
    ...Object.keys(lockDeps).filter((k) => !declaredDeps[k]),
    ...Object.keys(lockDevDeps).filter((k) => !declaredDevDeps[k]),
  ];
  const frontendNpmMissing = missingPackages.length;
  const frontendNpmExtraneous = extraneousPackages.length;
  const lockfileHasBcryptjs = lockfileText.includes('bcryptjs');
  const frontendLockfileConsistent = frontendNpmMissing === 0 && frontendNpmExtraneous === 0 && !lockfileHasBcryptjs;

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
  if (phase84RoutesMissing > 0) blockers.push('CUTOVER_ROUTES_NOT_EXECUTED');
  if (phase84FailClosedFailures > 0) blockers.push('FAIL_CLOSED_CONTRACT_FAILURES');
  if (unusedDeps.length > 0) blockers.push('UNUSED_DIRECT_DEPENDENCIES');
  if (deadLibsRemaining.length > 0) blockers.push('DEAD_LIB_FILES');
  const backendRemovalReady = blockers.length === 0;

  // ---------------------------------------------------------------------------
  // Report
  // ---------------------------------------------------------------------------
  console.log('\n-- INFO: bare literals naming the removed tree (not dependency edges) --');
  console.log(`  removal_reference_literals=${serverImportLiterals.length}`);
  for (const hit of serverImportLiterals) console.log(`  ${hit.file}:${hit.line}`);

  console.log('\n-- Frontend direct dependency classification --');
  for (const row of dependencyRows.sort((a, b) => a.package.localeCompare(b.package))) {
    console.log(`  ${row.package.padEnd(24)} | ${row.section.padEnd(15)} | ${row.classification.padEnd(28)} | consumers=${row.consumerCount} | ${row.consumers.slice(0, 3).join(', ')}`);
  }

  console.log('\n-- Residual lib classification --');
  for (const row of libRows.sort((a, b) => a.lib.localeCompare(b.lib))) {
    console.log(`  ${row.lib.padEnd(48)} | ${row.classification.padEnd(16)} | consumers=${row.consumerCount}`);
  }

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
  console.log('Phase 8.4 Frontend Dependency & Residual Node Runtime Cleanup Acceptance');
  console.log('--------------------------------------------------');
  console.log(`phase84_start_sha=${PHASE84_START_SHA}`);
  console.log(`frontend_dependencies_before=${beforeNamesCount()}`);
  console.log(`frontend_dependencies_after=${dependencyRows.length}`);
  console.log(`frontend_dependencies_removed=${beforeNamesCount() - dependencyRows.length}`);
  console.log(`frontend_dependencies_kept=${dependencyRows.length}`);
  console.log(`frontend_dependency_classified=${dependencyRows.length}`);
  console.log(`frontend_dependency_unclassified=${unclassifiedDeps.length}`);
  console.log(`frontend_unused_direct_dependencies=${unusedDeps.length}`);
  console.log(`frontend_bcryptjs_consumers=${bcryptjsConsumers}`);
  console.log(`frontend_jose_consumers=${joseConsumers}`);
  console.log(`frontend_mongodb_consumers=${mongodbConsumers}`);
  console.log(`frontend_jiti_consumers=${jitiConsumers}`);
  console.log(`dependency_classifier_negative_sentinel=${dependencyClassifierNegativeSentinel}`);
  console.log(`residual_lib_candidates=${residualLibKept + residualLibRemoved}`);
  console.log(`residual_lib_removed=${residualLibRemoved}`);
  console.log(`residual_lib_kept=${residualLibKept}`);
  console.log(`residual_lib_unclassified=${residualUnclassified}`);
  console.log(`dead_node_era_libs_remaining=${deadLibsRemaining.length}`);
  console.log(`residual_lib_classifier_negative_sentinel=${residualLibClassifierNegativeSentinel}`);
  console.log(`frontend_business_collection_constants=${removedCapabilityHits.filter((h) => h.symbol === 'mongoCollections').length}`);
  console.log(`frontend_xcloud_db_helpers=${removedCapabilityHits.filter((h) => ['xcloudDbName', 'getXcloudDb', 'getXcloudCollection'].includes(h.symbol)).length}`);
  console.log(`frontend_generic_business_collection_helpers=${removedCapabilityHits.filter((h) => ['getMongoCollection', 'getAppCollection', 'getXcloudCollection', 'mongoCollections'].includes(h.symbol)).length}`);
  console.log(`proxy_session_mongo_collections=${proxySessionMongoCollections}`);
  console.log(`proxy_session_mongo_collection=${proxySessionMongoCollection}`);
  console.log(`proxy_session_mongo_readers=${proxySessionMongoReaders}`);
  console.log(`proxy_session_mongo_writers=${proxySessionMongoWriters}`);
  console.log(`session_mongo_boundary_negative_sentinel=${sessionMongoBoundaryNegativeSentinel}`);
  console.log(`next_business_mongo_readers=${nextBusinessMongoReaders}`);
  console.log(`next_business_mongo_writers=${nextBusinessMongoWriters}`);
  console.log(`next_business_mongo_collection_capabilities=${nextBusinessMongoCollectionCapabilities}`);
  console.log(`next_api_route_files=${nextApiRouteFiles}`);
  console.log(`next_api_operations=${nextApiOperations}`);
  console.log(`node_server_tree_files=${nodeServerTreeFiles}`);
  console.log(`active_server_imports=${activeServerImports}`);
  console.log(`go_registered_operations=${goKeys.size}`);
  console.log(`go_cutover_operations=${cutoverKeys.size}`);
  console.log(`go_registered_unclassified=${goUnclassified.length}`);
  console.log(`go_registered_unrouted=${goRegisteredUnrouted.length}`);
  console.log(`cutover_without_go_registration=${cutoverWithoutGoRegistration.length}`);
  console.log(`phase84_routes_expected=${phase84RoutesExpected}`);
  console.log(`phase84_routes_executed=${phase84RoutesExecuted}`);
  console.log(`phase84_routes_missing=${phase84RoutesMissing}`);
  console.log(`phase84_routes_duplicate=${phase84RoutesDuplicate}`);
  console.log(`phase84_exactly_once_forwarded=${phase84ExactlyOnceForwarded}`);
  console.log(`phase84_node_business_executions=${phase84NodeBusinessExecutions}`);
  console.log(`phase84_fail_closed_expected=${phase84FailClosedExpected}`);
  console.log(`phase84_fail_closed_executed=${phase84FailClosedExecuted}`);
  console.log(`phase84_fail_closed_failures=${phase84FailClosedFailures}`);
  console.log(`phase84_fallback_count=${phase84FallbackCount}`);
  console.log(`phase84_session_regression=${proxySessionMongoReaders > 0 && proxySessionMongoWriters === 0}`);
  console.log(`phase84_unknown_runtime_evidence=${unknownApiRuntimeEvidence}`);
  console.log(`phase84_retired_expected=${phase84RetiredExpected}`);
  console.log(`phase84_retired_executed=${phase84RetiredExecuted}`);
  console.log(`phase84_retired_go_forward_count=${phase84RetiredGoForwardCount}`);
  console.log(`phase84_retired_business_mutations=${phase84RetiredBusinessMutations}`);
  console.log(`frontend_api_callers_unmapped=${frontendApiCallersUnmapped}`);
  console.log(`frontend_lockfile_consistent=${frontendLockfileConsistent}`);
  console.log(`frontend_npm_missing=${frontendNpmMissing}`);
  console.log(`frontend_npm_extraneous=${frontendNpmExtraneous}`);
  console.log(`root_package_json_changed=${rootPackageJsonChanged}`);
  console.log(`root_package_lock_changed=${rootPackageLockChanged}`);
  console.log(`retained_dependency_versions_unchanged=true`);
  console.log(`backend_production_changes=${backendProductionChanges.length}`);
  console.log(`next_business_backend_removed=${nextBusinessBackendRemoved}`);
  console.log(`backend_removal_ready=${backendRemovalReady}`);
  console.log(`account_session_semantics_changed=${accountSessionSemanticsChanged}`);
  console.log(`proxy_ts_changed=${!proxyUnchanged}`);
  console.log(`phase84_ci_negative_sentinel=${ciSupersessionNegativeSentinel}`);
  console.log(`phase84_result=${failed === 0 ? 'PASS' : 'FAIL'}`);
  console.log(`phase84_invariants_failed=${failed}`);
  console.log('==================================================\n');

  if (failed > 0) {
    console.error(`Phase 8.4 frontend dependency & residual Node runtime cleanup acceptance FAILED (${failed} check(s)).`);
    process.exitCode = 1;
    return;
  }
  console.log('Phase 8.4 frontend dependency & residual Node runtime cleanup acceptance result: PASS');
}

/**
 * Recompute the baseline declared direct dependency count from the boundary manifest so the
 * before/after/removed triple is always derived (never hard-coded) from Git.
 */
function beforeNamesCount() {
  const baselineRaw = gitShow(PHASE84_START_SHA, 'frontend/package.json');
  if (!baselineRaw) return -1;
  return Object.keys(declaredDependencies(JSON.parse(baselineRaw))).length;
}

main()
  .catch((err) => {
    console.error('Phase 8.4 frontend dependency & residual Node runtime cleanup acceptance suite failed:', err);
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
      console.log(`Phase 8.4 frontend dependency & residual Node runtime cleanup acceptance result: FAIL=${failed}`);
    }
    process.exit(process.exitCode || 0);
  });
