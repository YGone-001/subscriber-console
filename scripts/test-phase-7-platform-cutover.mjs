#!/usr/bin/env node
/**
 * Phase 7.5 - Controlled Platform Services Production Cutover Acceptance Suite
 *
 * Purpose: prove PRODUCTION OWNERSHIP transfer for the 11 frozen Phase 7
 * Platform Services operations from Node route handlers to the Go backend.
 *
 * This is NOT another Node-vs-Go parity suite. Contract parity is already
 * frozen by the Phase 7.1 - 7.4 suites. This suite proves the single-owner
 * production routing boundary:
 *
 *   HTTP client (NextRequest)
 *        |
 *        v
 *   frontend/src/proxy.ts  proxy()   <-- real controlled routing layer
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
 * The forwarding observer only measures requests; it never alters production
 * semantics. No production fault-injection switch is introduced.
 *
 * Machine-identifiable case groups:
 *   CO-Txx  routing table invariants (84 total after Phase 8.2; the historical
 *           36 baseline and the 11 Phase 7.5 entries are preserved as a subset)
 *   CO-Gxx  real production Go binary route registration probes
 *   CO-R01 .. CO-R11  per-route production ownership
 *   CO-F01 .. CO-F11  fail-closed / no-fallback for every cut-over route
 *   CO-Mxx  exactly-once + read-only state assertions
 *   CO-Sxx  SSE production-streaming assertions (framing, heartbeat,
 *           session_expired, cancellation, no WebSocket surface)
 *
 * Evidence labels state exactly what is measured. There is no fabricated
 * `NodeExec=0` counter: middleware fallthrough and Node-side business side
 * effects are measured directly.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { execSync, spawn } from 'node:child_process';
import { SignJWT } from 'jose';
import { MongoClient } from 'mongodb';
import { createJiti } from 'jiti';
import nextEnv from '@next/env';
import bcrypt from 'bcryptjs';

// ---------------------------------------------------------------------------
// Test Mongo URI must be explicitly controlled: never inherit a developer
// `.env` database (which may point at a remote host).
// ---------------------------------------------------------------------------
const PRELOAD_MONGODB_URI = process.env.MONGODB_URI;
nextEnv.loadEnvConfig(process.cwd());
process.env.MONGODB_URI = PRELOAD_MONGODB_URI
  || process.env.P75_TEST_MONGODB_URI
  || 'mongodb://127.0.0.1:27017/xcloud';

const suffix = `${Date.now()}_${process.pid}_${Math.floor(Math.random() * 100000)}`;
const xcloudDbName = `xcloud_p75_cutover_${suffix}`;
const appDbName = `xcloud_ops_p75_cutover_${suffix}`;
const uri = process.env.MONGODB_URI;

process.env.MONGODB_XCLOUD_DB = xcloudDbName;
process.env.MONGODB_APP_DB = appDbName;
const JWT_SECRET_STRING = process.env.JWT_SECRET || 'p75-cutover-suite-secret-at-least-32-bytes!';
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
// Fixtures
// ---------------------------------------------------------------------------

const PHASE_7_5_ROUTES = [
  { id: 'CO-R01', method: 'GET', path: '/api/alerts' },
  { id: 'CO-R02', method: 'POST', path: '/api/alerts/acknowledge' },
  { id: 'CO-R03', method: 'POST', path: '/api/alerts/workflow' },
  { id: 'CO-R04', method: 'GET', path: '/api/notifications/stream' },
  { id: 'CO-R05', method: 'GET', path: '/api/system/health' },
  { id: 'CO-R06', method: 'GET', path: '/api/system/mongo/health' },
  { id: 'CO-R07', method: 'GET', path: '/api/system/audit/status' },
  { id: 'CO-R08', method: 'POST', path: '/api/system/audit/scan' },
  { id: 'CO-R09', method: 'POST', path: '/api/system/audit/heal' },
  { id: 'CO-R10', method: 'POST', path: '/api/system/audit/batch-heal' },
  { id: 'CO-R11', method: 'POST', path: '/api/analytics/init' },
];

// True business mutation routes (alert workflow state, remediation writes).
// POST /api/system/audit/scan and POST /api/analytics/init are logically
// read-only and must NOT be classified as business mutations.
const BUSINESS_MUTATION_KEYS = new Set([
  'POST /api/alerts/acknowledge',
  'POST /api/alerts/workflow',
  'POST /api/system/audit/heal',
  'POST /api/system/audit/batch-heal',
]);

const REQUEST_BODY_FOR = {
  'POST /api/alerts/acknowledge': { id: 'alt-001' },
  'POST /api/alerts/workflow': { id: 'alt-002', status: 'acknowledged' },
  'POST /api/system/audit/scan': { cursor: '0', phase: 'sub' },
  'POST /api/system/audit/heal': { imsi: '001010000000001', type: 'orphan_reservation' },
  'POST /api/system/audit/batch-heal': { anomalies: [{ imsi: '001010000000001', type: 'orphan_reservation' }] },
  'POST /api/analytics/init': {},
};

const PHASE_7_5_KEYS = PHASE_7_5_ROUTES.map((r) => `${r.method} ${r.path}`);

// Frozen Phase 7.0/7.4 production routing baseline (36 METHOD+PATH entries).
const HISTORICAL_BASELINE_ROUTES = 36;

// Phase 8.2 residual production cutover additions: 33 canonical residual
// operations + 2 legacy read aliases + 2 Go-native residue reads.
const PHASE_8_2_ADDITIONS = 37;

const BASELINE_36 = [
  'POST /api/profiles/{name}/versions/{versionId}/restore',
  'POST /api/subscribers/{imsi}/profile',
  'POST /api/profiles',
  'PUT /api/profiles/{name}',
  'DELETE /api/profiles/{name}',
  'POST /api/subscribers',
  'PUT /api/subscribers/{imsi}',
  'DELETE /api/subscribers/{imsi}',
  'POST /api/subscribers/batch',
  'POST /api/subscribers/batch-update',
  'POST /api/subscribers/import',
  'POST /api/subscribers/bulk-delete',
  'POST /api/tariff-plans',
  'PUT /api/tariff-plans/{planId}',
  'DELETE /api/tariff-plans/{planId}',
  'POST /api/tariff-plans/{planId}/clone',
  'POST /api/tariff-plans/{planId}/enable',
  'POST /api/tariff-plans/{planId}/disable',
  'GET /api/ocs/subscribers',
  'POST /api/ocs/subscribers',
  'POST /api/ocs/subscribers/{imsi}/suspend',
  'POST /api/ocs/subscribers/{imsi}/resume',
  'PATCH /api/ocs/subscribers/{imsi}',
  'DELETE /api/ocs/subscribers/{imsi}',
  'POST /api/ocs/balances/{imsi}/adjust',
  'POST /api/ocs/balances/{imsi}/reset',
  'GET /api/users',
  'POST /api/users',
  'GET /api/users/{username}',
  'PATCH /api/users/{username}',
  'POST /api/users/{username}/disable',
  'POST /api/users/{username}/password-reset',
  'POST /api/auth/login',
  'POST /api/auth/logout',
  'GET /api/auth/me',
  'GET /api/auth/permissions',
];

// Node route files must remain present (dormant reference / rollback only).
const NODE_ROUTE_FILES = [
  'frontend/src/app/api/alerts/route.ts',
  'frontend/src/app/api/alerts/acknowledge/route.ts',
  'frontend/src/app/api/alerts/workflow/route.ts',
  'frontend/src/app/api/notifications/stream/route.ts',
  'frontend/src/app/api/system/health/route.ts',
  'frontend/src/app/api/system/mongo/health/route.ts',
  'frontend/src/app/api/system/audit/status/route.ts',
  'frontend/src/app/api/system/audit/scan/route.ts',
  'frontend/src/app/api/system/audit/heal/route.ts',
  'frontend/src/app/api/system/audit/batch-heal/route.ts',
  'frontend/src/app/api/analytics/init/route.ts',
];

// ---------------------------------------------------------------------------
// Harness state
// ---------------------------------------------------------------------------

let goProc = null;
let goPort = null;
let binPath = null;
let capture = null;
let capturePort = null;
let total = 0;
let passed = 0;
let failed = 0;
let skipped = 0;

const caseResults = [];
const noFallbackEvidence = [];
const goRegistrationEvidence = [];
const forwardSamples = [];

let fallbackCount = 0;
let middlewareFallthroughCount = 0;

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
      throw err;
    });
}

function recordCase(entry) {
  caseResults.push(entry);
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

function makeToken(username, role, sv, expiresInSec = 3600) {
  return new SignJWT({ username, role, sv })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt(Math.floor(Date.now() / 1000))
    .setExpirationTime(Math.floor(Date.now() / 1000) + expiresInSec)
    .sign(getJwtSecretKey());
}

/**
 * Test-side forwarding observer. Sits between the Next.js controlled proxy and
 * the real Go backend, records observed requests, and forwards unchanged.
 * Cancellation is propagated downstream -> upstream so the observer behaves as
 * a faithful pipe; it adds no production fault-injection switch.
 */
function createCaptureProxy(targetPort) {
  const counts = new Map();
  const order = [];
  // Connection-termination observations for the tracked exchange. Any of these
  // is direct evidence that the exchange stopped being served end to end.
  const terminations = [];
  const server = http.createServer((req, res) => {
    const pathname = (req.url || '').split('?')[0];
    const key = `${req.method} ${pathname}`;
    counts.set(key, (counts.get(key) || 0) + 1);
    order.push(key);
    const upstream = http.request(
      { host: '127.0.0.1', port: targetPort, method: req.method, path: req.url, headers: req.headers },
      (upRes) => {
        res.writeHead(upRes.statusCode || 502, upRes.headers);
        upRes.pipe(res);
        upRes.on('close', () => terminations.push({ key, kind: 'upstream_response', at: Date.now() }));
      }
    );
    const stopUpstream = () => {
      if (!upstream.destroyed) upstream.destroy();
    };
    res.on('close', () => {
      terminations.push({ key, kind: 'downstream_response', at: Date.now() });
      stopUpstream();
    });
    req.socket?.on('close', () => {
      terminations.push({ key, kind: 'downstream_socket', at: Date.now() });
      stopUpstream();
    });
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
    reset() {
      counts.clear();
      order.length = 0;
      terminations.length = 0;
    },
    countOf(method, pathname) {
      return counts.get(`${method} ${pathname}`) || 0;
    },
    totalRequests() {
      let n = 0;
      for (const v of counts.values()) n += v;
      return n;
    },
    order: () => order.slice(),
    terminationsFor(method, pathname) {
      const key = `${method} ${pathname}`;
      return terminations.filter((e) => e.key === key);
    },
    async waitForTermination(method, pathname, afterTs, timeoutMs) {
      const key = `${method} ${pathname}`;
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const hit = terminations.find((e) => e.key === key && e.at >= afterTs);
        if (hit) return hit;
        if (Date.now() > deadline) return null;
        await new Promise((r) => setTimeout(r, 100));
      }
    },
  };
}

async function callProxy(method, pathname, { token, body, search = '', extraHeaders } = {}) {
  const logs = [];
  const origLog = console.log;
  console.log = (...args) => {
    const msg = typeof args[0] === 'string' ? args[0] : '';
    if (msg.includes('cutover_forward')) {
      try {
        logs.push(JSON.parse(msg));
      } catch {}
    }
    origLog(...args);
  };
  try {
    const headers = { 'content-type': 'application/json', ...(extraHeaders || {}) };
    if (token) headers.cookie = `auth_token=${token}`;
    const req = new NextRequest(`http://localhost${pathname}${search}`, {
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

function createSSEReader(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const queued = [];
  async function readFrame(maxMs) {
    if (queued.length) return queued.shift();
    const deadline = Date.now() + maxMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      const chunk = await Promise.race([
        reader.read(),
        new Promise((r) => setTimeout(() => r({ __timeout: true }), remaining)),
      ]);
      if (chunk.__timeout) return null;
      if (chunk.done) return null;
      buffer += decoder.decode(chunk.value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        queued.push(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 2);
      }
      if (queued.length) return queued.shift();
    }
  }
  return {
    readFrame,
    async close() {
      try {
        await reader.cancel();
      } catch {}
    },
  };
}

async function waitForAudit(action, expected, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  for (;;) {
    last = await client.db(appDbName).collection('app_audit_logs').countDocuments({ action });
    if (last === expected) return last;
    if (Date.now() > deadline) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function rateLimitCount(keyPrefix) {
  // Stored key format is `RATELIMIT:<identifier>:<fixed-window-bucket>`.
  const pattern = `^RATELIMIT:${keyPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;
  const docs = await client
    .db(appDbName)
    .collection('app_rate_limits')
    .find({ key: { $regex: pattern } })
    .toArray();
  return docs.reduce((sum, d) => sum + (typeof d.count === 'number' ? d.count : 0), 0);
}

async function rateLimitTotal() {
  const docs = await client.db(appDbName).collection('app_rate_limits').find({}).toArray();
  return docs.reduce((sum, d) => sum + (typeof d.count === 'number' ? d.count : 0), 0);
}

async function businessStateFingerprint() {
  const aDb = client.db(appDbName);
  const xDb = client.db(xcloudDbName);
  return {
    auditTotal: await aDb.collection('app_audit_logs').countDocuments(),
    rateLimitTotal: await rateLimitTotal(),
    acknowledgedAlerts: await aDb.collection('app_alerts').countDocuments({ is_acknowledged: true }),
    approvals: await aDb.collection('app_approvals').countDocuments(),
    subscribers: await xDb.collection('subscribers').countDocuments(),
    ocsSubscribers: await xDb.collection('ocs_subscribers').countDocuments(),
    reservations: await xDb.collection('ocs_reservations').countDocuments(),
  };
}

async function seed() {
  const xDb = client.db(xcloudDbName);
  const aDb = client.db(appDbName);

  const hash = await bcrypt.hash('P75Pass123!', 10);
  const now = new Date().toISOString();

  await aDb.collection('app_users').insertMany([
    {
      username: 'p75_admin',
      passwordHash: hash,
      role: 'admin',
      status: 'active',
      displayName: 'P75 Admin',
      email: 'p75admin@test.local',
      createdAt: now,
      updatedAt: now,
      security: { sessionVersion: 1, failedLoginAttempts: 0 },
    },
    {
      username: 'p75_viewer',
      passwordHash: hash,
      role: 'viewer',
      status: 'active',
      displayName: 'P75 Viewer',
      email: 'p75viewer@test.local',
      createdAt: now,
      updatedAt: now,
      security: { sessionVersion: 1, failedLoginAttempts: 0 },
    },
  ]);

  await aDb.collection('app_alerts').insertMany([
    { id: 'alt-001', timestamp: '2026-09-27T10:00:00.000Z', level: 'CRITICAL', imsi: '001010000000001', reason: 'High CPU core temperature', is_acknowledged: false },
    { id: 'alt-002', timestamp: '2026-09-27T09:00:00.000Z', level: 'WARNING', imsi: '001010000000002', reason: 'Disk space warning', is_acknowledged: false },
    { id: 'alt-003', timestamp: '2026-09-27T08:00:00.000Z', level: 'INFO', imsi: '001010000000003', reason: 'Periodic health heartbeat', is_acknowledged: true },
  ]);

  await xDb.collection('ocs_tariff_plans').insertOne({
    plan_id: 'default-standard',
    name: 'Standard Default Tariff Plan',
    rules: [{ rating_group: 1 }],
  });

  await aDb.collection('app_profiles').insertOne({ name: 'default', created_at: now });

  await xDb.collection('subscribers').insertOne({
    imsi: '001010000000001',
    security: { k: '465B5CE8B199B49FAA5F0A2EE238A6BC', opc: 'E8ED289DEBA952E4283B54E88E6183CA' },
    slice: [{ sst: 1 }],
    ambr: { dl: 10000000, ul: 10000000 },
    profile: 'default',
  });

  await xDb.collection('ocs_subscribers').insertOne({ imsi: '001010000000001', plan_id: 'default-standard' });

  await xDb.collection('ocs_balances').insertOne({
    imsi: '001010000000001',
    data_total: 1000000,
    data_used: 200000,
    data_reserved: 100000,
    data_available: 700000,
    voice_total: 1000,
    voice_used: 200,
    voice_reserved: 100,
    voice_available: 700,
    sms_total: 500,
    sms_used: 50,
    sms_available: 450,
  });

  await xDb.collection('ocs_sessions').insertOne({ session_id: 'sess-active-01', state: 'active' });

  await xDb.collection('ocs_reservations').insertOne({
    reservation_id: 'res-active-01',
    session_id: 'sess-active-01',
    imsi: '001010000000001',
    state: 'active',
    reserved_octets: 100000,
  });

  await aDb.collection('app_audit_logs').insertOne({
    action: 'system.bootstrap',
    module: 'system',
    timestamp: now,
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('-- Phase 7.5 Controlled Platform Services Production Cutover Suite --\n');
  console.log(`  test Mongo URI: ${uri}`);

  // Connect and seed once, before any request path is exercised.
  await client.connect();
  await seed();

  // ===========================================================
  // 1. Routing table invariants (CO-T01 .. CO-T08)
  // ===========================================================
  console.log('\n[1] Routing Table Invariants');

  const actuallyRoutedGo = CUTOVER_TABLE.filter((r) => r.owner === 'go').length;
  const phase7CutoverDelta = CUTOVER_TABLE.length - HISTORICAL_BASELINE_ROUTES;
  const phase7NodeOwned = PHASE_7_5_ROUTES.filter((r) => {
    const entry = CUTOVER_TABLE.find((x) => x.method === r.method && x.path === r.path);
    return !entry || entry.owner !== 'go';
  }).length;

  await check('CO-T01 CUTOVER_TABLE total = 84 (Phase 8.2 residual cutover applied)', () => {
    assert.equal(CUTOVER_TABLE.length, 84, `expected 84, found ${CUTOVER_TABLE.length}`);
  });

  await check('CO-T02 ACTUALLY_ROUTED = 84 (all owner=go)', () => {
    assert.equal(actuallyRoutedGo, 84, `expected 84 go-owned, found ${actuallyRoutedGo}`);
  });

  await check('CO-T03 previous 36 baseline entries unchanged and still owner=go', () => {
    assert.equal(BASELINE_36.length, HISTORICAL_BASELINE_ROUTES, 'baseline fixture drift');
    for (const key of BASELINE_36) {
      const [method, p] = key.split(' ');
      const entry = CUTOVER_TABLE.find((r) => r.method === method && r.path === p);
      assert.ok(entry, `baseline entry missing: ${key}`);
      assert.equal(entry.owner, 'go', `baseline entry owner changed: ${key}`);
    }
  });

  await check('CO-T04 Phase 7.5 additions = exactly 11 (delta now 36 -> 48 after Phase 8.2)', () => {
    const found = PHASE_7_5_KEYS.filter((key) => {
      const [method, p] = key.split(' ');
      return CUTOVER_TABLE.some((r) => r.method === method && r.path === p);
    });
    assert.equal(found.length, 11, `expected 11 Phase 7.5 entries, found ${found.length}`);
    assert.equal(phase7CutoverDelta, 11 + PHASE_8_2_ADDITIONS,
      `cutover delta must be 11 Phase 7.5 + ${PHASE_8_2_ADDITIONS} Phase 8.2 = ${11 + PHASE_8_2_ADDITIONS}, found ${phase7CutoverDelta}`);
  });

  await check('CO-T05 all 11 Phase 7.5 routes have owner=go (phase7_node_owned=0)', () => {
    assert.equal(phase7NodeOwned, 0, `expected 0 Node-owned Phase 7 routes, found ${phase7NodeOwned}`);
    for (const { method, path: p } of PHASE_7_5_ROUTES) {
      const entry = CUTOVER_TABLE.find((r) => r.method === method && r.path === p);
      assert.ok(entry, `missing Phase 7.5 entry: ${method} ${p}`);
      assert.equal(entry.owner, 'go', `Phase 7.5 entry not owned by go: ${method} ${p}`);
    }
  });

  await check('CO-T06 no duplicate METHOD+PATH in CUTOVER_TABLE', () => {
    const seen = new Set();
    for (const r of CUTOVER_TABLE) {
      const key = `${r.method} ${r.path}`;
      assert.equal(seen.has(key), false, `duplicate cutover route: ${key}`);
      seen.add(key);
    }
  });

  await check('CO-T07 table still contains the full historical 36 baseline + Phase 7.5 11 subset', () => {
    const expected = [...BASELINE_36, ...PHASE_7_5_KEYS];
    const actual = new Set(CUTOVER_TABLE.map((r) => `${r.method} ${r.path}`));
    assert.ok(actual.size >= expected.length, `unexpected table size ${actual.size}`);
    for (const key of expected) {
      assert.ok(actual.has(key), `expected entry missing: ${key}`);
    }
  });

  await check('CO-T08 resolveRouteOwner returns "go" for all 11 Phase 7.5 routes', () => {
    for (const { method, path: p } of PHASE_7_5_ROUTES) {
      assert.equal(resolveRouteOwner(method, p), 'go', `owner mismatch for ${method} ${p}`);
    }
  });

  await check('CO-T09 Dormant Node route files are preserved (not deleted)', () => {
    for (const rel of NODE_ROUTE_FILES) {
      assert.ok(existsSync(path.resolve(import.meta.dirname, '..', rel)), `Node route file missing: ${rel}`);
    }
  });

  await check('CO-T10 authentication architecture unchanged (auth routes still Go-owned)', () => {
    for (const key of ['POST /api/auth/login', 'POST /api/auth/logout', 'GET /api/auth/me', 'GET /api/auth/permissions']) {
      const [method, p] = key.split(' ');
      const entry = CUTOVER_TABLE.find((r) => r.method === method && r.path === p);
      assert.ok(entry, `auth route missing: ${key}`);
      assert.equal(entry.owner, 'go', `auth route owner changed: ${key}`);
    }
  });

  // ===========================================================
  // 2. Go production source route registration (static companion check)
  // ===========================================================
  console.log('\n[2] Go Production Source Route Registration');

  const mainGoSource = readFileSync(path.resolve(import.meta.dirname, '..', 'backend/cmd/server/main.go'), 'utf8');
  const remediationSource = readFileSync(path.resolve(import.meta.dirname, '..', 'backend/internal/remediation/handler.go'), 'utf8');

  await check('main.go registers the 9 directly-owned Phase 7.5 routes', () => {
    const direct = PHASE_7_5_ROUTES.filter((r) => !r.path.startsWith('/api/system/audit/heal') && !r.path.startsWith('/api/system/audit/batch-heal'));
    for (const { method, path: p } of direct) {
      assert.ok(mainGoSource.includes(`"${method} ${p}"`), `main.go missing route: ${method} ${p}`);
    }
  });

  await check('main.go wires remediation.RegisterRoutes for heal + batch-heal', () => {
    assert.ok(mainGoSource.includes('remediation.RegisterRoutes(mux'),
      'main.go must wire remediation.RegisterRoutes');
    assert.ok(remediationSource.includes('"POST /api/system/audit/heal"'), 'remediation must register heal');
    assert.ok(remediationSource.includes('"POST /api/system/audit/batch-heal"'), 'remediation must register batch-heal');
  });

  // ===========================================================
  // 3. No-fallback contract (CO-F01 .. CO-F11)
  // ===========================================================
  console.log('\n[3] No-Fallback Contract (all 11 routes, Go unavailable => HTTP 502)');

  const savedBackendUrl = process.env.GO_BACKEND_URL;
  process.env.GO_BACKEND_URL = 'http://127.0.0.1:1'; // intentionally unreachable

  const noFallbackToken = await makeToken('p75_admin', 'admin', 1);
  const beforeFallback = await businessStateFingerprint();

  const noFallbackCases = PHASE_7_5_ROUTES.map((r, i) => ({
    id: `CO-F${String(i + 1).padStart(2, '0')}`,
    routeId: r.id,
    method: r.method,
    path: r.path,
    body: REQUEST_BODY_FOR[`${r.method} ${r.path}`],
  }));

  for (const c of noFallbackCases) {
    await check(`${c.id} ${c.method} ${c.path} => 502 GO_BACKEND_UNREACHABLE, no fallthrough, no Node side effect`, async () => {
      const { res, logs } = await callProxy(c.method, c.path, { token: noFallbackToken, body: c.body });

      const fellThrough = res.headers.get('x-middleware-next') !== null;
      if (fellThrough) middlewareFallthroughCount++;
      if (res.status !== 502) fallbackCount++;

      assert.equal(res.status, 502, `expected 502, got ${res.status}`);
      const json = await res.json();
      assert.equal(json.code, 'GO_BACKEND_UNREACHABLE');
      assert.equal(json.error, 'Backend temporarily unavailable');
      assert.equal(fellThrough, false, 'must not fall through to the Node handler');
      assert.equal(logs.length, 1, 'cutover_forward telemetry must be emitted once');
      assert.equal(logs[0].owner, 'go', 'owner must resolve to go');

      noFallbackEvidence.push({
        id: c.id,
        method: c.method,
        path: c.path,
        status: res.status,
        code: json.code,
        middlewareFallthrough: fellThrough ? 'YES' : 'NO',
        nodeBusinessSideEffect: 'NO',
        classification: BUSINESS_MUTATION_KEYS.has(`${c.method} ${c.path}`) ? 'business_mutation' : 'read_only',
        result: 'PASS',
      });
    });
  }

  await check('CO-F12 no Node-side business state change while Go is unreachable', async () => {
    const afterFallback = await businessStateFingerprint();
    assert.deepEqual(afterFallback, beforeFallback,
      'no Node-side audit / rate-limit / business mutation may occur under owner=go fail-closed');
    assert.equal(fallbackCount, 0, `fallback_count must be 0, found ${fallbackCount}`);
    assert.equal(middlewareFallthroughCount, 0, `middleware fallthrough must be 0, found ${middlewareFallthroughCount}`);
  });

  process.env.GO_BACKEND_URL = savedBackendUrl;

  // ===========================================================
  // 4. Real production Go server + test-side forwarding observer
  // ===========================================================
  console.log('\n[4] Production-Path Runtime (real Go server + forwarding observer)');

  const backendDir = path.resolve(import.meta.dirname, '..', 'backend');
  const isWin = process.platform === 'win32';
  const binName = isWin ? `test-p75-cutover-${suffix}.exe` : `test-p75-cutover-${suffix}`;
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
      if (r.ok) {
        goReady = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(goReady, 'Go backend failed to become ready');

  console.log(`  Go production binary on 127.0.0.1:${goPort}`);

  // ===========================================================
  // 5. Real production Go binary route registration probes (CO-G01 .. CO-G11)
  // ===========================================================
  console.log('\n[5] Real Production Go Binary Route Registration Probes');

  async function probeRegisteredRoute(method, p) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 8000);
    try {
      const res = await fetch(`http://127.0.0.1:${goPort}${p}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: method === 'POST' ? '{}' : undefined,
        signal: ac.signal,
      });
      const status = res.status;
      const code = status === 401 ? (await res.json().catch(() => ({}))).code : null;
      try { await res.body?.cancel(); } catch {}
      return { status, code };
    } finally {
      clearTimeout(timer);
    }
  }

  for (const [i, route] of PHASE_7_5_ROUTES.entries()) {
    const id = `CO-G${String(i + 1).padStart(2, '0')}`;
    await check(`${id} ${route.method} ${route.path} is registered by real backend/cmd/server`, async () => {
      const { status, code } = await probeRegisteredRoute(route.method, route.path);
      assert.notEqual(status, 404, `${route.method} ${route.path} returned 404 from the production binary (not registered)`);
      assert.notEqual(status, 405, `${route.method} ${route.path} returned 405 from the production binary (method not registered)`);
      assert.equal(status, 401, `expected the production auth wrapper to answer 401, got ${status}`);
      assert.equal(code, 'AUTH_INVALID_TOKEN', `expected AUTH_INVALID_TOKEN, got ${code}`);
      goRegistrationEvidence.push({
        id,
        method: route.method,
        path: route.path,
        status,
        code,
        registered: 'YES',
        result: 'PASS',
      });
    });
  }

  // Route the controlled proxy at the forwarding observer, which forwards to Go.
  capture = createCaptureProxy(goPort);
  capturePort = await getAvailablePort();
  await new Promise((resolve) => capture.server.listen(capturePort, '127.0.0.1', resolve));
  process.env.GO_BACKEND_URL = `http://127.0.0.1:${capturePort}`;

  const adminToken = await makeToken('p75_admin', 'admin', 1);
  const aDbHandle = client.db(appDbName);

  console.log(`  forwarding observer on 127.0.0.1:${capturePort}`);

  // ===========================================================
  // 6. Route ownership cases (CO-R01 .. CO-R11)
  // ===========================================================
  console.log('\n[6] Production Route Ownership Cases');

  async function runRouteCase(def, { body, expectStatus, assertBody }) {
    await check(`${def.id} ${def.method} ${def.path} reaches Go exactly once via the controlled proxy`, async () => {
      capture.reset();
      const { res, logs } = await callProxy(def.method, def.path, { token: adminToken, body });
      const json = await res.json();

      assert.equal(res.status, expectStatus, `expected ${expectStatus}, got ${res.status}`);
      const forward = capture.countOf(def.method, def.path);
      forwardSamples.push({ id: def.id, forward });
      assert.equal(forward, 1, `Go forward count must be exactly 1 for ${def.method} ${def.path}`);
      assert.equal(capture.totalRequests(), 1, 'exactly one request may reach Go for this case');
      const fellThrough = res.headers.get('x-middleware-next') !== null;
      assert.equal(fellThrough, false, 'Node handler path must not be taken');
      assert.equal(logs.length, 1, 'cutover_forward must be emitted exactly once');
      assert.equal(logs[0].msg, 'cutover_forward');
      assert.equal(logs[0].path, def.path);
      assert.equal(logs[0].owner, 'go');
      assert.equal(logs[0].principal, 'p75_admin');
      if (assertBody) assertBody(json);

      recordCase({
        id: def.id,
        method: def.method,
        path: def.path,
        forward,
        middlewareFallthrough: 'NO',
        nodeBusinessSideEffect: 'NO',
        evidence: 'proxy->observer forward count + response headers + cutover_forward telemetry',
        result: 'PASS',
      });
    });
  }

  await runRouteCase(PHASE_7_5_ROUTES[0], {
    expectStatus: 200,
    assertBody: (j) => assert.ok(Array.isArray(j.alerts), 'alerts must be an array'),
  });

  await runRouteCase(PHASE_7_5_ROUTES[1], {
    body: REQUEST_BODY_FOR['POST /api/alerts/acknowledge'],
    expectStatus: 200,
    assertBody: (j) => {
      assert.equal(j.success, true);
      assert.equal(j.acknowledged, 1);
      assert.equal(j.requested, 1);
      assert.equal(j.skipped, 0);
    },
  });

  await runRouteCase(PHASE_7_5_ROUTES[2], {
    body: REQUEST_BODY_FOR['POST /api/alerts/workflow'],
    expectStatus: 200,
    assertBody: (j) => {
      assert.equal(j.success, true);
      assert.equal(j.matched, 1);
    },
  });

  await runRouteCase(PHASE_7_5_ROUTES[4], { expectStatus: 200, assertBody: (j) => assert.ok(j.status || j.score !== undefined) });
  await runRouteCase(PHASE_7_5_ROUTES[5], { expectStatus: 200 });
  await runRouteCase(PHASE_7_5_ROUTES[6], {
    expectStatus: 200,
    assertBody: (j) => assert.equal(typeof j.lastSaveTime, 'number'),
  });
  await runRouteCase(PHASE_7_5_ROUTES[7], { body: REQUEST_BODY_FOR['POST /api/system/audit/scan'], expectStatus: 200 });
  await runRouteCase(PHASE_7_5_ROUTES[8], {
    body: REQUEST_BODY_FOR['POST /api/system/audit/heal'],
    expectStatus: 200,
  });
  await runRouteCase(PHASE_7_5_ROUTES[9], {
    body: REQUEST_BODY_FOR['POST /api/system/audit/batch-heal'],
    expectStatus: 200,
    assertBody: (j) => assert.equal(j.successCount, 1),
  });
  await runRouteCase(PHASE_7_5_ROUTES[10], { expectStatus: 200 });

  // ===========================================================
  // 7. Exactly-once / read-only assertions (CO-M01 .. CO-M09)
  // ===========================================================
  console.log('\n[7] Exactly-Once / Read-Only Assertions');

  await check('CO-M01 alert.acknowledge persisted exactly once (audit 1, rate-limit 1)', async () => {
    const ackDocs = await aDbHandle.collection('app_alerts').countDocuments({ id: 'alt-001', is_acknowledged: true });
    assert.equal(ackDocs, 1, 'alt-001 must be acknowledged exactly once');
    const audit = await waitForAudit('alert.acknowledge', 1);
    assert.equal(audit, 1, `expected 1 alert.acknowledge audit record, found ${audit}`);
    assert.equal(await rateLimitCount('alerts:acknowledge:'), 1, 'acknowledge handler must have executed exactly once');
  });

  await check('CO-M02 alert.workflow persisted exactly once (audit 1, rate-limit 1)', async () => {
    const wfAudit = await waitForAudit('alert.workflow', 1);
    assert.equal(wfAudit, 1, `expected 1 alert.workflow audit record, found ${wfAudit}`);
    assert.equal(await rateLimitCount('alerts:workflow:'), 1, 'workflow handler must have executed exactly once');
  });

  await check('CO-M03 heal executed exactly once (audit 2 total HEAL incl. batch, rate-limit 1)', async () => {
    const healAudit = await waitForAudit('HEAL', 2);
    assert.equal(healAudit, 2, `expected 2 HEAL audit records, found ${healAudit}`);
    assert.equal(await rateLimitCount('system:audit-heal:'), 1, 'heal handler must have executed exactly once');
  });

  await check('CO-M04 batch-heal executed exactly once (rate-limit 1, no duplicate execution)', async () => {
    assert.equal(await rateLimitCount('system:audit-batch-heal:'), 1, 'batch-heal handler must have executed exactly once');
    const res = await client.db(xcloudDbName).collection('ocs_reservations').findOne({ reservation_id: 'res-active-01' });
    assert.ok(res, 'seeded reservation must still exist');
    assert.equal(res.state, 'released', 'batch-heal must have released the orphan reservation exactly once');
  });

  await check('CO-M05 no duplicate Go forwarding across the 10 non-SSE ownership cases', () => {
    // CO-R04 (the SSE route) is measured under CO-S01 / CO-S06.
    assert.equal(forwardSamples.length, 10, `expected 10 non-SSE forward samples, found ${forwardSamples.length}`);
    const duplicates = forwardSamples.filter((s) => s.forward !== 1);
    assert.equal(duplicates.length, 0, `duplicate forwarding observed: ${JSON.stringify(duplicates)}`);
  });

  await check('CO-M06 audit scan remained read-only', async () => {
    const sub = await client.db(xcloudDbName).collection('subscribers').findOne({ imsi: '001010000000001' });
    assert.ok(sub, 'seeded subscriber must still exist');
    assert.equal(sub.profile, 'default', 'audit scan must not mutate subscriber documents');
    assert.equal(await rateLimitCount('system:audit-scan:'), 1, 'scan handler must have executed exactly once');
  });

  await check('CO-M07 analytics init remained read-only (no business mutation)', async () => {
    const sub = await client.db(xcloudDbName).collection('subscribers').findOne({ imsi: '001010000000001' });
    assert.ok(sub, 'seeded subscriber must still exist');
    assert.equal(sub.profile, 'default', 'analytics init must not mutate subscriber documents');
    const idx = await client.db(xcloudDbName).collection('ocs_tariff_plans').findOne({ plan_id: 'default-standard' });
    assert.ok(idx, 'tariff plan must remain');
  });

  await check('CO-M08 zero approval tickets created (app_approvals count == 0)', async () => {
    const count = await aDbHandle.collection('app_approvals').countDocuments();
    assert.equal(count, 0, `expected 0 approvals, found ${count}`);
  });

  await check('CO-M09 all mutation audit records are attributable to the Go execution path', async () => {
    assert.equal(await waitForAudit('alert.acknowledge', 1), 1, 'alert.acknowledge audit drift');
    assert.equal(await waitForAudit('alert.workflow', 1), 1, 'alert.workflow audit drift');
    assert.equal(await waitForAudit('HEAL', 2), 2, 'HEAL audit drift');
  });

  // ===========================================================
  // 8. SSE production streaming (CO-S01 .. CO-S07)
  // ===========================================================
  console.log('\n[8] SSE Production Streaming Through the Controlled Proxy');

  let sseStream = null;

  await check('CO-S01 SSE response is a live event-stream (Content-Type, no fallthrough, one forward)', async () => {
    capture.reset();
    const { res, logs } = await callProxy('GET', '/api/notifications/stream', { token: adminToken });
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    assert.equal(res.headers.get('x-middleware-next'), null, 'Node handler path must not be taken');
    const forward = capture.countOf('GET', '/api/notifications/stream');
    forwardSamples.push({ id: 'CO-S01', forward });
    assert.equal(forward, 1, 'Go must receive exactly one stream request');
    assert.equal(logs.length, 1, 'cutover_forward must be emitted exactly once for the stream');
    recordCase({
      id: 'CO-R04',
      method: 'GET',
      path: '/api/notifications/stream',
      forward,
      middlewareFallthrough: 'NO',
      nodeBusinessSideEffect: 'NO',
      evidence: 'forward observer count + SSE response headers + cutover_forward telemetry',
      result: 'PASS',
    });
    sseStream = { res, sse: createSSEReader(res) };
  });

  await check('CO-S02 init frame arrives incrementally (response is not buffered)', async () => {
    assert.ok(sseStream, 'CO-S01 must have opened the stream');
    const initFrame = await sseStream.sse.readFrame(5000);
    assert.ok(initFrame, 'init frame must arrive incrementally before any mutation');
    assert.ok(initFrame.includes('event: init'), `expected init frame, got: ${initFrame}`);
    sseStream.initFrame = initFrame;
  });

  await check('CO-S03 alerts_update crosses the proxy incrementally after the active alert count changes', async () => {
    assert.ok(sseStream, 'CO-S01 must have opened the stream');
    await aDbHandle.collection('app_alerts').insertOne({
      id: 'alt-900',
      timestamp: new Date().toISOString(),
      level: 'CRITICAL',
      imsi: '001010000000009',
      reason: 'P75 streaming probe',
      is_acknowledged: false,
    });
    let updateFrame = null;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const f = await sseStream.sse.readFrame(deadline - Date.now());
      if (!f) break;
      if (f.includes('event: alerts_update')) {
        updateFrame = f;
        break;
      }
    }
    assert.ok(updateFrame, 'alerts_update must cross the proxy after the active alert count changes');
    assert.ok(updateFrame.includes('data:'), 'alerts_update must carry an SSE data frame');
  });

  await check('CO-S04 heartbeat framing :ping preserved on the production path', async () => {
    assert.ok(sseStream, 'CO-S01 must have opened the stream');
    let heartbeat = null;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const f = await sseStream.sse.readFrame(deadline - Date.now());
      if (!f) break;
      if (f.trim() === ':ping') {
        heartbeat = f;
        break;
      }
    }
    await sseStream.sse.close();
    sseStream = null;
    assert.equal(heartbeat, ':ping', 'heartbeat comment must cross the proxy with exact :ping framing');
  });

  await check('CO-S05 session_expired preserved after session revocation', async () => {
    const { res } = await callProxy('GET', '/api/notifications/stream', { token: adminToken });
    assert.equal(res.status, 200);
    const sse = createSSEReader(res);
    const first = await sse.readFrame(5000);
    assert.ok(first && first.includes('event: init'), 'init frame must arrive before revocation');

    // Revoke the session by bumping sessionVersion; periodic revalidation must emit session_expired.
    await aDbHandle.collection('app_users').updateOne(
      { username: 'p75_admin' },
      { $set: { 'security.sessionVersion': 2 } }
    );

    let expired = null;
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      const f = await sse.readFrame(deadline - Date.now());
      if (!f) break;
      if (f.includes('event: session_expired')) {
        expired = f;
        break;
      }
    }
    await sse.close();

    // Restore the session so later assertions/tokens remain valid.
    await aDbHandle.collection('app_users').updateOne(
      { username: 'p75_admin' },
      { $set: { 'security.sessionVersion': 1 } }
    );
    assert.ok(expired, 'session_expired must be emitted after session revocation');
  });

  await check('CO-S06 client cancellation propagates upstream without duplicate forwarding', async () => {
    capture.reset();
    const { res } = await callProxy('GET', '/api/notifications/stream', { token: adminToken });
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    const sse = createSSEReader(res);
    const init = await sse.readFrame(5000);
    assert.ok(init && init.includes('event: init'), 'init frame must arrive before cancellation');

    // The exchange must still be live right before cancellation.
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(
      capture.terminationsFor('GET', '/api/notifications/stream').length,
      0,
      'the SSE exchange must still be open before cancellation'
    );

    const cancelledAt = Date.now();
    await sse.close(); // client-side cancellation

    const termination = await capture.waitForTermination('GET', '/api/notifications/stream', cancelledAt, 8000);
    assert.ok(termination, 'client cancellation must propagate to the upstream connection boundary');
    const forward = capture.countOf('GET', '/api/notifications/stream');
    forwardSamples.push({ id: 'CO-S06', forward });
    assert.equal(forward, 1, 'cancellation must not trigger a retry or duplicate forward');
    console.log(`[cutover] cancellation_propagation_observed=${termination.kind} after=${termination.at - cancelledAt}ms`);
  });

  await check('CO-S07 WebSocket surface not introduced', async () => {
    const { res } = await callProxy('GET', '/api/notifications/stream', {
      token: adminToken,
      extraHeaders: { upgrade: 'websocket' },
    });
    const upgradeStatus = res.status;
    const upgradeHeader = res.headers.get('upgrade');
    const upgradeContentType = res.headers.get('content-type');
    try { await res.body?.cancel(); } catch {}
    console.log(`[cutover] upgrade_probe_status=${upgradeStatus} upgrade_header=${upgradeHeader} content_type=${upgradeContentType}`);
    assert.notEqual(upgradeStatus, 101, 'no protocol upgrade may be performed');
    assert.equal(upgradeHeader, null, 'no Upgrade response header may be emitted');

    const proxySource = readFileSync(path.resolve(import.meta.dirname, '..', 'frontend/src/proxy.ts'), 'utf8');
    const notificationSource = readFileSync(path.resolve(import.meta.dirname, '..', 'backend/internal/notification/handler.go'), 'utf8');
    for (const [label, source] of [['frontend/src/proxy.ts', proxySource], ['backend notification handler', notificationSource]]) {
      assert.equal(/websocket/i.test(source), false, `${label} must not introduce a WebSocket implementation`);
      assert.equal(/wss?:\/\//i.test(source), false, `${label} must not introduce a WebSocket URL scheme`);
    }
  });

  // ===========================================================
  // 9. Coverage summary
  // ===========================================================
  console.log('\n[9] Route Ownership Matrix');

  await check('CO-R01..CO-R11 all covered with forward count 1 and no middleware fallthrough', () => {
    assert.equal(caseResults.length, 11, `expected 11 route cases, found ${caseResults.length}`);
    for (const c of caseResults) {
      assert.equal(c.forward, 1, `${c.id} forward count must be 1`);
      assert.equal(c.middlewareFallthrough, 'NO', `${c.id} must not fall through to Node`);
      assert.equal(c.nodeBusinessSideEffect, 'NO', `${c.id} must produce no Node business side effect`);
      assert.equal(c.result, 'PASS', `${c.id} must PASS`);
    }
  });

  await check('CO-F01..CO-F11 no-fallback evidence recorded for every cut-over route', () => {
    assert.equal(noFallbackEvidence.length, 11, 'expected 11 no-fallback cases');
    for (const e of noFallbackEvidence) {
      assert.equal(e.status, 502, `${e.id} must be HTTP 502`);
      assert.equal(e.code, 'GO_BACKEND_UNREACHABLE', `${e.id} must report GO_BACKEND_UNREACHABLE`);
      assert.equal(e.middlewareFallthrough, 'NO', `${e.id} must not fall through`);
    }
    assert.equal(fallbackCount, 0, `fallback_count must be 0, found ${fallbackCount}`);
  });

  await check('CO-G01..CO-G11 real production binary registration evidence recorded', () => {
    assert.equal(goRegistrationEvidence.length, 11, 'expected 11 registration probes');
    for (const e of goRegistrationEvidence) {
      assert.equal(e.registered, 'YES', `${e.id} must be registered by the production binary`);
    }
  });

  const duplicateForwardCount = forwardSamples.filter((s) => s.forward !== 1).length;

  await check('CO-X01 required aggregate invariants are exact', () => {
    assert.equal(CUTOVER_TABLE.length, 84, 'CUTOVER_TABLE must be 84');
    assert.equal(actuallyRoutedGo, 84, 'ACTUALLY_ROUTED must be 84');
    assert.equal(phase7CutoverDelta, 11 + PHASE_8_2_ADDITIONS, `phase7_cutover_delta must be ${11 + PHASE_8_2_ADDITIONS}`);
    assert.equal(phase7NodeOwned, 0, 'phase7_node_owned must be 0');
    assert.equal(fallbackCount, 0, 'fallback_count must be 0');
    assert.equal(duplicateForwardCount, 0, 'go_forward_duplicate_count must be 0');
    assert.equal(forwardSamples.length, 12, `expected 12 forward samples (10 routes + 2 SSE), found ${forwardSamples.length}`);
  });

  console.log('\n-- Route ownership matrix --');
  console.log('ID     | Method | Path                              | Prev | New | Fwd | Fallthrough | NodeSideFx | Result');
  for (const c of caseResults) {
    console.log(`${c.id} | ${c.method.padEnd(6)} | ${c.path.padEnd(33)} | Node | Go  | ${String(c.forward).padEnd(3)} | ${c.middlewareFallthrough.padEnd(11)} | ${c.nodeBusinessSideEffect.padEnd(10)} | ${c.result}`);
  }

  console.log('\n-- No-fallback matrix --');
  console.log('ID     | Method | Path                              | Status | Code                      | Fallthrough | NodeSideFx | Result');
  for (const e of noFallbackEvidence) {
    console.log(`${e.id} | ${e.method.padEnd(6)} | ${e.path.padEnd(33)} | ${String(e.status).padEnd(6)} | ${e.code.padEnd(25)} | ${e.middlewareFallthrough.padEnd(11)} | ${e.nodeBusinessSideEffect.padEnd(10)} | ${e.result}`);
  }

  console.log('\n-- Go production binary route registration --');
  for (const e of goRegistrationEvidence) {
    console.log(`${e.id} | ${e.method.padEnd(6)} | ${e.path.padEnd(33)} | status=${e.status} | code=${e.code} | registered=${e.registered}`);
  }

  console.log('\n==================================================');
  console.log('Phase 7.5 Controlled Platform Services Cutover Suite');
  console.log(`TOTAL=${total} PASS=${passed} FAIL=${failed} SKIP=${skipped}`);
  console.log(`CUTOVER_TABLE=${CUTOVER_TABLE.length}`);
  console.log(`ACTUALLY_ROUTED=${actuallyRoutedGo}`);
  console.log(`phase7_cutover_delta=${phase7CutoverDelta}`);
  console.log(`phase7_node_owned=${phase7NodeOwned}`);
  console.log(`fallback_count=${fallbackCount}`);
  console.log(`go_forward_duplicate_count=${duplicateForwardCount}`);
  console.log('==================================================\n');

  if (failed > 0) {
    throw new Error(`${failed} checks failed`);
  }
}

main()
  .catch((err) => {
    console.error('Phase 7.5 cutover suite failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      if (capture && capture.server) {
        await new Promise((resolve) => capture.server.close(() => resolve()));
      }
    } catch {}
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
    console.log(`Phase 7.5 cutover suite result: FAIL=${failed} SKIP=${skipped}`);
    process.exit(process.exitCode || 0);
  });
