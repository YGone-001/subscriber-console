#!/usr/bin/env node
/**
 * Phase 8.2 - Residual Production Cutover, Compatibility Closure & Retired Surface Removal.
 *
 * This suite proves PRODUCTION OWNERSHIP for the Phase 8.2 transition, not behavioural
 * parity (Phase 8.1 already froze Node <-> Go behaviour for the 33 canonical residual
 * operations; that evidence must remain valid and is executed separately).
 *
 * Real topology (no handler mocks for the ownership proof):
 *
 *   HTTP client (NextRequest)
 *        |
 *        v
 *   frontend/src/proxy.ts  proxy()          <-- real controlled routing layer
 *        |  resolveRouteOwner(method, path)
 *        v
 *   GO_BACKEND_URL  (test-side forwarding observer)
 *        |
 *        v
 *   real production Go server   backend/cmd/server
 *        |
 *        v
 *   isolated MongoDB
 *
 * The observer only measures requests; it never alters production semantics. There is
 * no production fault-injection switch: the "Go unavailable" evidence reuses the real
 * fail-closed branch by pointing GO_BACKEND_URL at a closed port.
 *
 * Machine-identifiable case groups:
 *   P82-Sxx  source / inventory reconciliation (derived, never hard-coded)
 *   P82-Rxx  routing ownership of every newly cut-over METHOD+PATH
 *   P82-Gxx  Go-native residue resolution + real production binary registration
 *   P82-Fxx  fail-closed / no-fallback for every newly cut-over route
 *   P82-Xxx  exactly-once production forwarding (real Go server + observer)
 *   P82-Nxx  no Node business execution / no middleware fallthrough
 *   P82-Lxx  legacy alias public compatibility (read-only, Go-owned)
 *   P82-Dxx  retired surface removal (no longer executable)
 *   P82-Cxx  stale caller cleanup (/api/audit -> 0)
 *
 * Emits the mandatory Phase 8.2 machine-readable block.
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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiRoot = path.join(root, 'frontend/src/app/api');
const srcRoot = path.join(root, 'frontend/src');

// ---------------------------------------------------------------------------
// Test Mongo URI must be explicitly controlled: never inherit a developer `.env`.
// ---------------------------------------------------------------------------
const PRELOAD_MONGODB_URI = process.env.MONGODB_URI;
nextEnv.loadEnvConfig(process.cwd());
process.env.MONGODB_URI = PRELOAD_MONGODB_URI
  || process.env.P82_TEST_MONGODB_URI
  || 'mongodb://127.0.0.1:27017/xcloud';

const suffix = `${Date.now()}_${process.pid}_${Math.floor(Math.random() * 100000)}`;
const xcloudDbName = `xcloud_p82_cutover_${suffix}`;
const appDbName = `xcloud_ops_p82_cutover_${suffix}`;
const uri = process.env.MONGODB_URI;

process.env.MONGODB_XCLOUD_DB = xcloudDbName;
process.env.MONGODB_APP_DB = appDbName;
const JWT_SECRET_STRING = process.env.JWT_SECRET || 'p82-cutover-suite-secret-at-least-32-bytes!';
process.env.JWT_SECRET = JWT_SECRET_STRING;

// Suppress known intentional unreachable / audit scheduling noise during the run.
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
    'next/server': new URL('../frontend/node_modules/next/server.js', import.meta.url).pathname,
  },
});

const { NextRequest } = jiti('next/server');
const { proxy } = jiti('../frontend/src/proxy.ts');
const { CUTOVER_TABLE, resolveRouteOwner } = jiti('../frontend/src/lib/cutover-routing.ts');
const { getJwtSecretKey } = jiti('../frontend/src/lib/security.ts');

const client = new MongoClient(uri, {
  serverSelectionTimeoutMS: Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS || 5000),
});

// ---------------------------------------------------------------------------
// Frozen Phase 8.2 fixtures
// ---------------------------------------------------------------------------

// 33 canonical residual operations (Phase 8.1 frozen remainder) -> now Go-owned.
const CANONICAL_ROUTES = [
  { id: 'R01', method: 'GET', path: '/api/analytics/metrics' },
  { id: 'R02', method: 'GET', path: '/api/analytics/sparkline' },
  { id: 'R03', method: 'GET', path: '/api/ocs/balances' },
  { id: 'R04', method: 'GET', path: '/api/ocs/reservations' },
  { id: 'R05', method: 'GET', path: '/api/ocs/sessions' },
  { id: 'R06', method: 'GET', path: '/api/ocs/usage' },
  { id: 'R07', method: 'GET', path: '/api/profiles' },
  { id: 'R08', method: 'GET', path: '/api/profiles/{name}' },
  { id: 'R09', method: 'GET', path: '/api/profiles/{name}/stats' },
  { id: 'R10', method: 'GET', path: '/api/profiles/{name}/versions' },
  { id: 'R11', method: 'GET', path: '/api/ratings' },
  { id: 'R12', method: 'POST', path: '/api/ratings' },
  { id: 'R13', method: 'GET', path: '/api/ratings/{id}' },
  { id: 'R14', method: 'PUT', path: '/api/ratings/{id}' },
  { id: 'R15', method: 'DELETE', path: '/api/ratings/{id}' },
  { id: 'R16', method: 'GET', path: '/api/search' },
  { id: 'R17', method: 'GET', path: '/api/subscribers' },
  { id: 'R18', method: 'GET', path: '/api/subscribers/{imsi}' },
  { id: 'R19', method: 'POST', path: '/api/subscribers/batch/precheck' },
  { id: 'R20', method: 'POST', path: '/api/subscribers/policy' },
  { id: 'R21', method: 'POST', path: '/api/subscribers/{imsi}/traffic-adjustments' },
  { id: 'R22', method: 'GET', path: '/api/tariff-plans' },
  { id: 'R23', method: 'GET', path: '/api/tariff-plans/{planId}' },
  { id: 'R24', method: 'GET', path: '/api/tariff-plans/{planId}/export' },
  { id: 'R25', method: 'GET', path: '/api/tariff-plans/{planId}/migrate' },
  { id: 'R26', method: 'POST', path: '/api/tariff-plans/{planId}/migrate' },
  { id: 'R27', method: 'GET', path: '/api/tariff-plans/{planId}/rules' },
  { id: 'R28', method: 'POST', path: '/api/tariff-plans/{planId}/rules' },
  { id: 'R29', method: 'PUT', path: '/api/tariff-plans/{planId}/rules/{ruleId}' },
  { id: 'R30', method: 'PATCH', path: '/api/tariff-plans/{planId}/rules/{ruleId}' },
  { id: 'R31', method: 'DELETE', path: '/api/tariff-plans/{planId}/rules/{ruleId}' },
  { id: 'R32', method: 'GET', path: '/api/tariff-plans/{planId}/subscribers' },
  { id: 'R33', method: 'POST', path: '/api/tariff-plans/import' },
];

// Two read-only legacy compatibility aliases -> Go-owned, lifecycle unchanged.
const LEGACY_ROUTES = [
  { id: 'L01', method: 'GET', path: '/api/auth/users' },
  { id: 'L02', method: 'GET', path: '/api/auth/users/{username}' },
];

// Six non-canonical mutation surfaces retired in Phase 8.2.
const RETIRED_ROUTES = [
  { id: 'D01', method: 'POST', path: '/api/auth/users', file: 'frontend/src/app/api/auth/users/route.ts', module: '../frontend/src/app/api/auth/users/route.ts', siblings: ['GET'] },
  { id: 'D02', method: 'PUT', path: '/api/auth/users/{username}', file: 'frontend/src/app/api/auth/users/[username]/route.ts', module: '../frontend/src/app/api/auth/users/[username]/route.ts', siblings: ['GET'] },
  { id: 'D03', method: 'PATCH', path: '/api/auth/users/{username}', file: 'frontend/src/app/api/auth/users/[username]/route.ts', module: '../frontend/src/app/api/auth/users/[username]/route.ts', siblings: ['GET'] },
  { id: 'D04', method: 'DELETE', path: '/api/auth/users/{username}', file: 'frontend/src/app/api/auth/users/[username]/route.ts', module: '../frontend/src/app/api/auth/users/[username]/route.ts', siblings: ['GET'] },
  { id: 'D05', method: 'PUT', path: '/api/users/{username}', file: 'frontend/src/app/api/users/[username]/route.ts', module: '../frontend/src/app/api/users/[username]/route.ts', siblings: ['GET', 'PATCH'] },
  { id: 'D06', method: 'DELETE', path: '/api/users/{username}', file: 'frontend/src/app/api/users/[username]/route.ts', module: '../frontend/src/app/api/users/[username]/route.ts', siblings: ['GET', 'PATCH'] },
];

// Two Phase 8.0 Go-native unrouted reads -> resolved to production Go routing.
const RESIDUE_ROUTES = [
  { id: 'G01', method: 'GET', path: '/api/tariff-plans/{planId}/operations', decision: 'KEEP_AS_PUBLIC_GO_API' },
  { id: 'G02', method: 'GET', path: '/api/ocs/balances/{imsi}', decision: 'KEEP_AS_PUBLIC_GO_API' },
];

const NEW_CUTOVER_ROUTES = [...CANONICAL_ROUTES, ...LEGACY_ROUTES, ...RESIDUE_ROUTES];

const REQUEST_BODY_FOR_METHOD = { POST: {}, PUT: {}, PATCH: {} };

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'];
const PHASE_7_5_CUTOVER_BASELINE = 47;

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
const nextStdout = [];

let total = 0;
let passed = 0;
let failed = 0;

let fallbackCount = 0;
let middlewareFallthroughCount = 0;

const caseResults = [];
const noFallbackEvidence = [];
const forwardSamples = [];
const retiredEvidence = [];

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

/**
 * Ensure a real frontend production build exists so the retired-surface evidence
 * can be produced by the actual Next.js App Router runtime.
 */
function ensureFrontendBuild() {
  const frontendDir = path.join(root, 'frontend');
  const buildId = path.join(frontendDir, '.next', 'BUILD_ID');
  if (existsSync(buildId) && !process.env.P82_FORCE_FRONTEND_BUILD) {
    console.log('  reusing existing frontend production build (.next/BUILD_ID present)');
    return;
  }
  console.log('  building frontend production bundle (next build)...');
  execSync('npm run build', { cwd: frontendDir, stdio: 'inherit' });
}

/**
 * Launch the real production Next.js application on loopback. This is the genuine
 * App Router runtime: proxy.ts executes, and unmatched methods are dispatched by the
 * framework itself (never by this test harness).
 */
async function startNextServer(port) {
  const frontendDir = path.join(root, 'frontend');
  const nextBin = path.join(frontendDir, 'node_modules', 'next', 'dist', 'bin', 'next');
  const proc = spawn(process.execPath, [nextBin, 'start', '-p', String(port), '-H', '127.0.0.1'], {
    cwd: frontendDir,
    env: { ...process.env, NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (chunk) => nextStdout.push(chunk.toString()));
  proc.stderr.on('data', (chunk) => nextStdout.push(chunk.toString()));

  let ready = false;
  for (let i = 0; i < 300; i++) {
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

/** Replace canonical `{param}` placeholders with concrete probe values. */
function concretePath(canonical) {
  return canonical
    .replace('{planId}', 'default-standard')
    .replace('{ruleId}', 'rule-01')
    .replace('{id}', 'p82-rating-01')
    .replace('{username}', 'p82_admin')
    .replace('{imsi}', '001010000000001')
    .replace('{name}', 'default');
}

function key(method, p) {
  return `${method} ${p}`;
}

function canonicalize(nodePath) {
  return nodePath.replace(/:(\w+)\*?/g, '{$1}');
}

const cutoverKeys = new Set(CUTOVER_TABLE.map((r) => key(r.method, r.path)));
const cutoverByKey = new Map(CUTOVER_TABLE.map((r) => [key(r.method, r.path), r]));

// ---------------------------------------------------------------------------
// Independent source scan of the Next.js API tree
// ---------------------------------------------------------------------------
function walk(dir, filter, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, filter, out);
    else if (filter(full)) out.push(full);
  }
  return out;
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

function scanApiTree() {
  const files = walk(apiRoot, (p) => p.endsWith('route.ts') || p.endsWith('route.js'));
  const ops = [];
  for (const file of files) {
    const { methods } = methodExportsOf(file);
    const dirParts = path.relative(apiRoot, file).split(/[\\/]/).slice(0, -1);
    const apiPath = '/api/' + dirParts
      .map((part) => {
        if (part.startsWith('[...') && part.endsWith(']')) return ':' + part.slice(4, -1) + '*';
        if (part.startsWith('[') && part.endsWith(']')) return ':' + part.slice(1, -1);
        return part;
      })
      .join('/');
    for (const method of methods) ops.push({ method, nodePath: apiPath, canonicalPath: canonicalize(apiPath), file });
  }
  return { files, ops };
}

/** Production Go route registrations (authoritative source). */
function loadGoRegistrations() {
  const sources = [
    path.join(root, 'backend/cmd/server/main.go'),
    path.join(root, 'backend/internal/remediation/handler.go'),
  ].filter(existsSync);
  const ops = [];
  for (const file of sources) {
    const content = readFileSync(file, 'utf8');
    const re = /mux\.Handle\("(GET|POST|PUT|PATCH|DELETE)\s+([^"]+)"\s*,/g;
    let m;
    while ((m = re.exec(content)) !== null) ops.push({ method: m[1], canonicalPath: m[2] });
  }
  return ops;
}

/** Derive runtime owner via the real production routing function. */
function runtimeOwnerOf(method, canonicalPath, file) {
  let owner;
  try {
    owner = resolveRouteOwner(method, concretePath(canonicalPath));
  } catch {
    return 'unknown';
  }
  if (owner === 'go') return 'go';
  if (owner !== 'node') return 'unknown';
  return file && existsSync(path.resolve(root, file)) ? 'node' : 'unreachable';
}

// ---------------------------------------------------------------------------
// Test-side forwarding observer (faithful pipe; measures only)
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

async function callProxy(method, pathname, { token, body } = {}) {
  const logs = [];
  const origLog = console.log;
  console.log = (...args) => {
    const msg = typeof args[0] === 'string' ? args[0] : '';
    if (msg.includes('cutover_forward')) {
      try { logs.push(JSON.parse(msg)); } catch {}
    }
    origLog(...args);
  };
  try {
    const headers = { 'content-type': 'application/json' };
    if (token) headers.cookie = `auth_token=${token}`;
    const req = new NextRequest(`http://localhost${pathname}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const res = await proxy(req);
    return { res, logs };
  } finally {
    console.log = origLog;
  }
}

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

/**
 * Fingerprint of the user-management business collections that the retired
 * mutation surfaces would have written to. Used to prove zero business mutation.
 */
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
  const hash = await bcrypt.hash('P82Pass123!', 10);
  const now = new Date().toISOString();

  await aDb.collection('app_users').insertMany([
    { username: 'p82_admin', passwordHash: hash, role: 'admin', status: 'active', displayName: 'P82 Admin', email: 'p82admin@test.local', createdAt: now, updatedAt: now, security: { sessionVersion: 1, failedLoginAttempts: 0 } },
    { username: 'p82_viewer', passwordHash: hash, role: 'viewer', status: 'active', displayName: 'P82 Viewer', email: 'p82viewer@test.local', createdAt: now, updatedAt: now, security: { sessionVersion: 1, failedLoginAttempts: 0 } },
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
  console.log('-- Phase 8.2 Residual Production Cutover Suite --\n');
  console.log(`  test Mongo URI: ${uri}`);

  await client.connect();
  await seed();

  const { files: apiFiles, ops: sourceOps } = scanApiTree();
  const inventoryKeys = new Set(sourceOps.map((o) => key(o.method, o.canonicalPath)));
  const goRegs = loadGoRegistrations();
  const goKeys = new Set(goRegs.map((r) => key(r.method, r.canonicalPath)));

  const canonicalKeys = CANONICAL_ROUTES.map((r) => key(r.method, r.path));
  const legacyKeys = LEGACY_ROUTES.map((r) => key(r.method, r.path));
  const retiredKeys = RETIRED_ROUTES.map((r) => key(r.method, r.path));
  const residueKeys = RESIDUE_ROUTES.map((r) => key(r.method, r.path));

  // ===========================================================
  // 1. Source / inventory reconciliation (P82-Sxx)
  // ===========================================================
  console.log('\n[1] Source / Inventory Reconciliation');

  const methodCounts = { GET: 0, POST: 0, PUT: 0, PATCH: 0, DELETE: 0 };
  for (const op of sourceOps) if (methodCounts[op.method] !== undefined) methodCounts[op.method] += 1;

  await check('P82-S01 api route files = 54 and current operations = 72 (six retired methods removed)', () => {
    assert.equal(apiFiles.length, 54, `expected 54 route files, found ${apiFiles.length}`);
    assert.equal(sourceOps.length, 72, `expected 72 operations, found ${sourceOps.length}`);
    assert.deepEqual(methodCounts, { GET: 32, POST: 28, PUT: 5, PATCH: 2, DELETE: 5 });
  });

  const canonicalInCutover = canonicalKeys.filter((k) => cutoverKeys.has(k));
  const canonicalDuplicate = canonicalKeys.filter((k) => {
    const [m, p] = [k.split(' ')[0], k.slice(k.indexOf(' ') + 1)];
    return CUTOVER_TABLE.filter((r) => key(r.method, r.path) === k).length > 1;
  });
  const legacyInCutover = legacyKeys.filter((k) => cutoverKeys.has(k));
  const residueInCutover = residueKeys.filter((k) => cutoverKeys.has(k));
  const expectedCutover = PHASE_7_5_CUTOVER_BASELINE + CANONICAL_ROUTES.length + LEGACY_ROUTES.length + residueInCutover.length;

  await check('P82-S02 CUTOVER_TABLE derived = ACTUALLY_ROUTED, all owner=go, no duplicates', () => {
    assert.equal(CUTOVER_TABLE.length, expectedCutover,
      `expected ${expectedCutover} (47 + 33 + 2 + ${residueInCutover.length}), found ${CUTOVER_TABLE.length}`);
    assert.equal(CUTOVER_TABLE.filter((r) => r.owner === 'go').length, CUTOVER_TABLE.length, 'every routed entry must be owner=go');
    const seen = new Set();
    for (const r of CUTOVER_TABLE) {
      const k = key(r.method, r.path);
      assert.equal(seen.has(k), false, `duplicate cutover route: ${k}`);
      seen.add(k);
    }
    assert.equal(canonicalInCutover.length, 33, `canonical cut over=${canonicalInCutover.length}`);
    assert.equal(canonicalDuplicate.length, 0, `canonical duplicates=${canonicalDuplicate.length}`);
    assert.equal(legacyInCutover.length, 2, `legacy aliases cut over=${legacyInCutover.length}`);
    assert.equal(residueInCutover.length, 2, `go-native residue cut over=${residueInCutover.length}`);
  });

  await check('P82-S03 the six retired mutations are absent from inventory, routing table and Go router', () => {
    for (const k of retiredKeys) {
      assert.equal(inventoryKeys.has(k), false, `retired operation still exported: ${k}`);
      assert.equal(cutoverKeys.has(k), false, `retired operation must not be routed: ${k}`);
      assert.equal(goKeys.has(k), false, `retired operation must not have a Go registration: ${k}`);
    }
  });

  const staleCallerHits = [];
  for (const file of walk(srcRoot, (p) => /\.(ts|tsx|js|jsx|mjs)$/.test(p))) {
    const content = readFileSync(file, 'utf8');
    content.split('\n').forEach((line, idx) => {
      if (/\/api\/audit(?!-)/.test(line)) {
        staleCallerHits.push(`${path.relative(root, file).replaceAll('\\', '/')}:${idx + 1}`);
      }
    });
  }

  await check('P82-S04 stale callers to the retired /api/audit surface = 0', () => {
    assert.equal(staleCallerHits.length, 0, `stale /api/audit callers: ${staleCallerHits.join(', ')}`);
  });

  await check('P82-S05 every current inventory operation has an exact Go registration', () => {
    const missing = sourceOps.filter((o) => !goKeys.has(key(o.method, o.canonicalPath))).map((o) => key(o.method, o.canonicalPath));
    assert.equal(missing.length, 0, `inventory operations without a Go registration: ${missing.join(', ')}`);
  });

  await check('P82-S06 deployment boundary preserved (exact METHOD+PATH scope, no global /api/* ownership)', () => {
    assert.equal(CUTOVER_TABLE.some((r) => r.path === '/api/*' || r.path === '/api/'), false, 'global /api/* ownership must not exist yet');
    assert.equal(CUTOVER_TABLE.some((r) => r.path.includes('*')), false, 'no wildcard ownership is allowed');
    const proxySource = readFileSync(path.join(root, 'frontend/src/proxy.ts'), 'utf8');
    assert.ok(proxySource.includes('resolveRouteOwner'), 'proxy.ts must keep resolveRouteOwner routing');
    assert.ok(proxySource.includes('GO_BACKEND_UNREACHABLE'), 'proxy.ts must keep the fail-closed branch');
  });

  // ===========================================================
  // 2. Routing ownership of every newly cut-over route (P82-Rxx)
  // ===========================================================
  console.log('\n[2] Routing Ownership (37 newly cut-over METHOD+PATH)');

  for (const route of NEW_CUTOVER_ROUTES) {
    await check(`P82-${route.id} ${route.method} ${route.path} resolves to owner=go via resolveRouteOwner`, () => {
      assert.equal(resolveRouteOwner(route.method, concretePath(route.path)), 'go', 'resolveRouteOwner must return go');
      const entry = cutoverByKey.get(key(route.method, route.path));
      assert.ok(entry, 'route must be present in CUTOVER_TABLE');
      assert.equal(entry.owner, 'go', 'CUTOVER_TABLE entry must be owner=go');
      assert.equal(goKeys.has(key(route.method, route.path)), true, 'route must be registered in the Go production router source');
    });
  }

  // ===========================================================
  // 3. Real production Go server + registration probes
  // ===========================================================
  console.log('\n[3] Production Go Binary Registration');

  const backendDir = path.join(root, 'backend');
  const isWin = process.platform === 'win32';
  const binName = isWin ? `test-p82-cutover-${suffix}.exe` : `test-p82-cutover-${suffix}`;
  binPath = path.join(backendDir, binName);

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
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${goPort}/healthz`);
      if (r.ok) { goReady = true; break; }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(goReady, 'Go backend failed to become ready');
  console.log(`  Go production binary on 127.0.0.1:${goPort}`);

  await check('P82-G01..G02 both Go-native residue reads are registered by the real production binary', async () => {
    for (const route of RESIDUE_ROUTES) {
      const res = await fetch(`http://127.0.0.1:${goPort}${concretePath(route.path)}`, { method: route.method });
      try { await res.body?.cancel(); } catch {}
      assert.notEqual(res.status, 404, `${route.id} must not be 404 (registered)`);
      assert.notEqual(res.status, 405, `${route.id} must not be 405 (method registered)`);
    }
  });

  await check('P82-G03 residue decisions are explicit and source-backed (no allowlist deletion)', () => {
    for (const route of RESIDUE_ROUTES) {
      assert.equal(route.decision, 'KEEP_AS_PUBLIC_GO_API', `${route.id} must record an explicit KEEP_AS_PUBLIC_GO_API decision`);
      assert.equal(cutoverByKey.get(key(route.method, route.path))?.owner, 'go', `${route.id} must be production-routed to Go`);
    }
  });

  // ===========================================================
  // 4. Fail-closed / no-fallback (P82-Fxx)
  // ===========================================================
  console.log('\n[4] Fail-Closed Contract (Go unavailable => HTTP 502, zero Node fallback)');

  const savedBackendUrl = process.env.GO_BACKEND_URL;
  process.env.GO_BACKEND_URL = 'http://127.0.0.1:1'; // intentionally unreachable

  const token = await makeToken('p82_admin', 'admin', 1);
  const beforeFallback = await businessStateFingerprint();

  for (const route of NEW_CUTOVER_ROUTES) {
    await check(`P82-F${route.id} ${route.method} ${route.path} => 502 GO_BACKEND_UNREACHABLE, no fallthrough, no Node side effect`, async () => {
      const body = REQUEST_BODY_FOR_METHOD[route.method];
      const { res, logs } = await callProxy(route.method, route.path, { token, body });
      const fellThrough = res.headers.get('x-middleware-next') !== null;
      if (fellThrough) middlewareFallthroughCount++;
      if (res.status !== 502) fallbackCount++;

      assert.equal(res.status, 502, `expected 502, got ${res.status}`);
      const json = await res.json();
      assert.equal(json.code, 'GO_BACKEND_UNREACHABLE');
      assert.equal(json.error, 'Backend temporarily unavailable');
      assert.equal(fellThrough, false, 'must not fall through to the Node handler');
      assert.equal(logs.length, 1, 'cutover_forward telemetry must be emitted exactly once');
      assert.equal(logs[0].owner, 'go', 'telemetry owner must resolve to go');

      noFallbackEvidence.push({
        id: `P82-F${route.id}`,
        method: route.method,
        path: route.path,
        status: res.status,
        code: json.code,
        middlewareFallthrough: 'NO',
        nodeBusinessSideEffect: 'NO',
        result: 'PASS',
      });
    });
  }

  await check('P82-F37 no Node-side business state change while Go is unreachable', async () => {
    const afterFallback = await businessStateFingerprint();
    assert.deepEqual(afterFallback, beforeFallback, 'no Node audit / rate-limit / business mutation may occur under owner=go fail-closed');
    assert.equal(fallbackCount, 0, `fallback_count must be 0, found ${fallbackCount}`);
    assert.equal(middlewareFallthroughCount, 0, `middleware fallthrough must be 0, found ${middlewareFallthroughCount}`);
  });

  process.env.GO_BACKEND_URL = savedBackendUrl;

  // ===========================================================
  // 5. Exactly-once production forwarding (P82-Xxx)
  // ===========================================================
  console.log('\n[5] Exactly-Once Production Forwarding');

  capture = createCaptureProxy(goPort);
  capturePort = await getAvailablePort();
  await new Promise((resolve) => capture.server.listen(capturePort, '127.0.0.1', resolve));
  process.env.GO_BACKEND_URL = `http://127.0.0.1:${capturePort}`;
  console.log(`  forwarding observer on 127.0.0.1:${capturePort}`);

  const observedStatuses = new Map();

  for (const route of NEW_CUTOVER_ROUTES) {
    await check(`P82-X${route.id} ${route.method} ${route.path} forwards to Go exactly once (no Node execution)`, async () => {
      capture.reset();
      const body = REQUEST_BODY_FOR_METHOD[route.method];
      // Probe with the concrete path: the controlled proxy URL-encodes `{param}`
      // placeholders before forwarding, so the observer must be asked for the same
      // concrete METHOD+PATH that a real client would send.
      const probePath = concretePath(route.path);
      const { res, logs } = await callProxy(route.method, probePath, { token, body });
      const status = res.status;
      try { await res.body?.cancel(); } catch {}
      observedStatuses.set(key(route.method, route.path), status);

      const forward = capture.countOf(route.method, probePath);
      forwardSamples.push({ id: `P82-X${route.id}`, method: route.method, path: route.path, forward, status });

      assert.equal(forward, 1, `Go forward count must be exactly 1, found ${forward}`);
      assert.equal(capture.totalRequests(), 1, `exactly one request may reach Go, found ${capture.totalRequests()}`);
      assert.equal(res.headers.get('x-middleware-next'), null, 'Node handler path must not be taken');
      assert.equal(logs.length, 1, 'cutover_forward must be emitted exactly once');
      assert.equal(logs[0].msg, 'cutover_forward');
      assert.equal(logs[0].owner, 'go');
      assert.notEqual(status, 502, 'Go must be reachable during the forwarding group');

      caseResults.push({
        id: `P82-X${route.id}`,
        method: route.method,
        path: route.path,
        forward,
        status,
        middlewareFallthrough: 'NO',
        nodeBusinessSideEffect: 'NO',
        result: 'PASS',
      });
    });
  }

  // ===========================================================
  // 6. No Node business execution (P82-Nxx)
  // ===========================================================
  console.log('\n[6] No Node Business Execution / No Fallthrough');

  await check('P82-N01 no newly cut-over route resolved to the Node runtime owner', () => {
    for (const route of NEW_CUTOVER_ROUTES) {
      const owner = runtimeOwnerOf(route.method, route.path, null);
      assert.equal(owner, 'go', `${route.method} ${route.path} runtime owner must be go, found ${owner}`);
    }
  });

  await check('P82-N02 zero middleware fallthrough and zero Node fallback across the whole run', () => {
    assert.equal(middlewareFallthroughCount, 0, `middleware_fallthrough_count=${middlewareFallthroughCount}`);
    assert.equal(fallbackCount, 0, `fallback_count=${fallbackCount}`);
  });

  const duplicateForwardCount = forwardSamples.filter((s) => s.forward !== 1).length;

  await check('P82-N03 no duplicate forwarding for any cut-over route', () => {
    assert.equal(duplicateForwardCount, 0, `go_forward_duplicate_count=${duplicateForwardCount}`);
    assert.equal(forwardSamples.length, NEW_CUTOVER_ROUTES.length, `expected ${NEW_CUTOVER_ROUTES.length} forward samples, found ${forwardSamples.length}`);
  });

  // ===========================================================
  // 7. Legacy alias compatibility (P82-Lxx)
  // ===========================================================
  console.log('\n[7] Legacy Alias Public Compatibility');

  await check('P82-L01 GET /api/auth/users stays publicly compatible and Go-owned', async () => {
    capture.reset();
    const { res } = await callProxy('GET', '/api/auth/users', { token });
    const json = await res.json();
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    assert.equal(capture.countOf('GET', '/api/auth/users'), 1, 'must be served by Go exactly once');
    assert.ok(Array.isArray(json.users), 'legacy no-query contract must still return a users array');
    assert.ok(json.assignableRoles, 'legacy metadata (assignableRoles) must be preserved');
  });

  await check('P82-L02 GET /api/auth/users/{username} stays publicly compatible and Go-owned', async () => {
    capture.reset();
    const { res } = await callProxy('GET', concretePath('/api/auth/users/{username}'), { token });
    const json = await res.json();
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    assert.equal(capture.countOf('GET', '/api/auth/users/p82_admin'), 1, 'must be served by Go exactly once');
    assert.ok(JSON.stringify(json).includes('p82_admin'), 'legacy detail contract must still describe the requested user');
  });

  await check('P82-L03 no mutation method was reintroduced under /api/auth/users', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal(resolveRouteOwner(method, '/api/auth/users'), 'node', `${method} /api/auth/users must not be Go-routed`);
      assert.equal(resolveRouteOwner(method, '/api/auth/users/p82_admin'), 'node', `${method} /api/auth/users/{username} must not be Go-routed`);
      assert.equal(goKeys.has(`${method} /api/auth/users`), false, `${method} /api/auth/users must not be Go-registered`);
      assert.equal(goKeys.has(`${method} /api/auth/users/{username}`), false, `${method} /api/auth/users/{username} must not be Go-registered`);
    }
    const aliasSource = readFileSync(path.join(root, 'frontend/src/app/api/auth/users/route.ts'), 'utf8');
    const aliasDetailSource = readFileSync(path.join(root, 'frontend/src/app/api/auth/users/[username]/route.ts'), 'utf8');
    assert.equal(/export\s+(async\s+)?function\s+(POST|PUT|PATCH|DELETE)\b/.test(aliasSource), false, 'legacy alias root must not export a mutation');
    assert.equal(/export\s+(async\s+)?function\s+(POST|PUT|PATCH|DELETE)\b/.test(aliasDetailSource), false, 'legacy alias detail must not export a mutation');
  });

  // ===========================================================
  // 8. Retired surface removal (P82-Dxx) - REAL Next.js HTTP evidence
  // ===========================================================
  console.log('\n[8] Retired Surface Removal (real Next.js App Router HTTP responses)');

  ensureFrontendBuild();
  nextPort = await getAvailablePort();
  nextProc = await startNextServer(nextPort);
  console.log(`  real Next.js production server on 127.0.0.1:${nextPort}`);

  // Control probe: prove the real server + proxy.ts + controlled cutover stack is
  // genuinely live, so the retired-surface responses below are framework responses
  // and not the output of a broken or stub server.
  capture.reset();
  const controlProbe = await fetch(`http://127.0.0.1:${nextPort}${concretePath('/api/users/{username}')}`, {
    method: 'GET',
    headers: { cookie: `auth_token=${token}` },
    redirect: 'manual',
  });
  const controlStatus = controlProbe.status;
  try { await controlProbe.body?.cancel(); } catch {}
  const controlForward = capture.countOf('GET', concretePath('/api/users/{username}'));

  await check('P82-D00 real Next.js server control probe: an owner=go route forwards to Go exactly once', () => {
    assert.equal(controlStatus, 200, `control probe must return 200 from the real cutover stack, got ${controlStatus}`);
    assert.equal(controlForward, 1, `control probe must reach the Go backend exactly once, found ${controlForward}`);
  });

  const retiredHttpBefore = await userManagementFingerprint();
  capture.reset();
  const nextStdoutMark = nextStdout.length;

  for (const route of RETIRED_ROUTES) {
    await check(`P82-${route.id} ${route.method} ${route.path} retired: no export, no Go route, real HTTP 404/405`, async () => {
      const abs = path.join(root, route.file);
      const { methods } = methodExportsOf(abs);
      assert.equal(methods.has(route.method), false, `${route.method} export must be removed from ${route.file}`);
      assert.equal(methods.size > 0, true, `${route.file} must keep its valid sibling methods`);
      for (const sibling of route.siblings) {
        assert.equal(methods.has(sibling), true, `${route.file} must preserve sibling method ${sibling}`);
      }
      assert.equal(resolveRouteOwner(route.method, concretePath(route.path)), 'node', 'retired METHOD+PATH must not be Go-owned');

      // REAL HTTP request against the real production Next.js server. The proxy is
      // owner=node for this METHOD+PATH, so it calls NextResponse.next() and the
      // request is dispatched by the actual App Router method dispatcher.
      const probePath = concretePath(route.path);
      const response = await fetch(`http://127.0.0.1:${nextPort}${probePath}`, {
        method: route.method,
        headers: { cookie: `auth_token=${token}`, 'content-type': 'application/json' },
        body: REQUEST_BODY_FOR_METHOD[route.method] !== undefined ? JSON.stringify(REQUEST_BODY_FOR_METHOD[route.method]) : undefined,
        redirect: 'manual',
      });
      const observedStatus = response.status;
      let payload = '';
      try { payload = await response.text(); } catch {}

      const goForward = capture.countOf(route.method, probePath);
      const businessSuccess = observedStatus >= 200 && observedStatus < 300;

      assert.ok(observedStatus === 404 || observedStatus === 405,
        `${route.method} ${probePath} actual HTTP status must be 404 or 405, got ${observedStatus}`);
      assert.equal(businessSuccess, false, 'a retired method must not return business success');
      assert.equal(payload.includes('GO_BACKEND_UNREACHABLE'), false, 'a retired method must not return GO_BACKEND_UNREACHABLE');
      assert.equal(goForward, 0, `a retired method must never be forwarded to Go, forwards=${goForward}`);

      retiredEvidence.push({
        id: `P82-${route.id}`,
        method: route.method,
        path: route.path,
        nodeHandlerExport: 'ABSENT',
        goRegistration: 'ABSENT',
        actualHttp: observedStatus,
        goForward,
        businessMutation: '0',
        businessSuccess: 'NO',
        nodeBusinessExecution: 'NO',
        goBusinessExecution: 'NO',
        result: 'PASS',
      });
    });
  }

  await check('P82-D07 retired operations are no longer part of the current operation inventory', () => {
    for (const route of RETIRED_ROUTES) {
      assert.equal(inventoryKeys.has(key(route.method, route.path)), false, `retired operation still inventoried: ${key(route.method, route.path)}`);
    }
  });

  await check('P82-D08 no Go replacement was created for any retired mutation', () => {
    for (const route of RETIRED_ROUTES) {
      assert.equal(goKeys.has(key(route.method, route.path)), false, `Go replacement must not exist for ${key(route.method, route.path)}`);
    }
  });

  await check('P82-D09 retired real HTTP evidence: zero Go forwards, zero telemetry, zero business mutation', async () => {
    assert.equal(capture.totalRequests(), 0, `go_forward_count for the six retired requests must be 0, found ${capture.totalRequests()}`);
    const telemetry = nextStdout.slice(nextStdoutMark).join('').split('\n').filter((line) => line.includes('cutover_forward')).length;
    assert.equal(telemetry, 0, `retired requests must not emit cutover_forward telemetry, found ${telemetry}`);
    const after = await userManagementFingerprint();
    assert.deepEqual(after, retiredHttpBefore, 'retired user-management requests must not mutate the app_users business collection');
  });

  // ===========================================================
  // 9. Stale caller cleanup (P82-Cxx)
  // ===========================================================
  console.log('\n[9] Stale Caller Cleanup');

  await check('P82-C01 repository scan finds zero callers of the retired /api/audit surface', () => {
    assert.equal(staleCallerHits.length, 0, `stale callers: ${staleCallerHits.join(', ')}`);
  });

  await check('P82-C02 the two former stale caller components no longer request /api/audit', () => {
    const trace = readFileSync(path.join(root, 'frontend/src/components/SubscriberTraceModal.tsx'), 'utf8');
    const balance = readFileSync(path.join(root, 'frontend/src/components/ocs/balances/OcsBalanceDetail.tsx'), 'utf8');
    assert.equal(/\/api\/audit(?!-)/.test(trace), false, 'SubscriberTraceModal.tsx must not call /api/audit');
    assert.equal(/\/api\/audit(?!-)/.test(balance), false, 'OcsBalanceDetail.tsx must not call /api/audit');
    assert.equal(existsSync(path.join(root, 'frontend/src/app/api/audit')), false, 'no /api/audit route may be recreated');
  });

  // ===========================================================
  // 10. Machine-readable output
  // ===========================================================
  const inventoryRuntime = { go: 0, node: 0, unreachable: 0, unknown: 0 };
  for (const op of sourceOps) inventoryRuntime[runtimeOwnerOf(op.method, op.canonicalPath, op.file)] += 1;

  const retiredActive = RETIRED_ROUTES.filter((r) => inventoryKeys.has(key(r.method, r.path)) || cutoverKeys.has(key(r.method, r.path)) || goKeys.has(key(r.method, r.path))).length;
  const goNativeResidueCutover = residueInCutover.length;
  const goNativeResidueRemoved = 0;

  console.log('\n-- Retired surface matrix (real Next.js App Router HTTP responses) --');
  for (const e of retiredEvidence) {
    console.log(`${e.id} | ${e.method.padEnd(6)} | ${e.path.padEnd(32)} | export=${e.nodeHandlerExport} | go=${e.goRegistration} | actual_http=${e.actualHttp} | mutation=${e.businessMutation} | ${e.result}`);
  }

  const retiredHttpExecuted = retiredEvidence.length;
  const retiredHttpMissing = RETIRED_ROUTES.length - retiredHttpExecuted;
  const retiredHttpSuccessResponses = retiredEvidence.filter((e) => e.businessSuccess === 'YES').length;
  const retiredHttpGoForwards = retiredEvidence.reduce((sum, e) => sum + e.goForward, 0);
  const retiredHttpMutations = retiredEvidence.reduce((sum, e) => sum + Number(e.businessMutation), 0);
  const retiredHttpRuntimeEvidence = retiredHttpExecuted === RETIRED_ROUTES.length
    && retiredEvidence.every((e) => e.actualHttp === 404 || e.actualHttp === 405);

  console.log('\n-- Forwarding summary (first 5 / last 5) --');
  for (const s of [...forwardSamples.slice(0, 5), ...forwardSamples.slice(-5)]) {
    console.log(`${s.id} | ${s.method.padEnd(6)} | ${s.path.padEnd(45)} | forward=${s.forward} | status=${s.status}`);
  }

  console.log('\n==================================================');
  console.log('Phase 8.2 Residual Production Cutover Suite');
  console.log(`TOTAL=${total} PASS=${passed} FAIL=${failed}`);
  console.log('');
  console.log('phase82_canonical_expected=33');
  console.log(`phase82_canonical_cutover=${canonicalInCutover.length}`);
  console.log(`phase82_canonical_missing=${CANONICAL_ROUTES.length - canonicalInCutover.length}`);
  console.log(`phase82_canonical_duplicate=${canonicalDuplicate.length}`);
  console.log('');
  console.log('phase82_legacy_expected=2');
  console.log(`phase82_legacy_go_owned=${LEGACY_ROUTES.filter((r) => cutoverByKey.get(key(r.method, r.path))?.owner === 'go').length}`);
  console.log('');
  console.log('phase82_retired_expected=6');
  console.log(`phase82_retired_active=${retiredActive}`);
  console.log('');
  console.log('phase82_retired_http_expected=6');
  console.log(`phase82_retired_http_executed=${retiredHttpExecuted}`);
  console.log(`phase82_retired_http_missing=${retiredHttpMissing}`);
  console.log(`phase82_retired_http_successful_business_responses=${retiredHttpSuccessResponses}`);
  console.log(`phase82_retired_http_go_forward_count=${retiredHttpGoForwards}`);
  console.log(`phase82_retired_http_business_mutations=${retiredHttpMutations}`);
  console.log(`phase82_retired_http_runtime_evidence=${retiredHttpRuntimeEvidence}`);
  console.log('');
  console.log(`stale_callers_to_retired_surfaces=${staleCallerHits.length}`);
  console.log('');
  console.log('go_native_unrouted_start=2');
  console.log(`go_native_residue_resolved=${goNativeResidueCutover + goNativeResidueRemoved}`);
  console.log(`go_native_unrouted_remaining=${RESIDUE_ROUTES.length - goNativeResidueCutover}`);
  console.log(`go_native_residue_cutover=${goNativeResidueCutover}`);
  console.log(`go_native_residue_removed=${goNativeResidueRemoved}`);
  console.log('');
  console.log(`cutover_table=${CUTOVER_TABLE.length}`);
  console.log(`actually_routed=${CUTOVER_TABLE.filter((r) => r.owner === 'go').length}`);
  console.log('');
  console.log(`api_operations=${sourceOps.length}`);
  console.log('');
  console.log(`inventory_runtime_go=${inventoryRuntime.go}`);
  console.log(`inventory_runtime_node=${inventoryRuntime.node}`);
  console.log(`inventory_runtime_unreachable=${inventoryRuntime.unreachable}`);
  console.log(`runtime_owner_unknown=${inventoryRuntime.unknown}`);
  console.log('');
  console.log(`canonical_node_migration_remainder=${inventoryRuntime.node}`);
  console.log('');
  console.log(`node_production_operations=${inventoryRuntime.node}`);
  console.log(`fallback_count=${fallbackCount}`);
  console.log('');
  console.log(`phase82_result=${failed === 0 ? 'PASS' : 'FAIL'}`);
  console.log('==================================================\n');

  if (failed > 0) throw new Error(`${failed} checks failed`);
}

main()
  .catch((err) => {
    console.error('Phase 8.2 residual cutover suite failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      if (capture && capture.server) await new Promise((resolve) => capture.server.close(() => resolve()));
    } catch {}
    stopProcess(nextProc);
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
    console.log(`Phase 8.2 residual cutover suite result: FAIL=${failed}`);
    process.exit(process.exitCode || 0);
  });
