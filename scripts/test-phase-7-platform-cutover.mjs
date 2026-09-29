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
 *   GO_BACKEND_URL  (test capture proxy)
 *        |
 *        v
 *   Go backend :<port>
 *
 * Proof obligations:
 *   CO-R01 .. CO-R11  one ownership case per route:
 *       - CUTOVER_TABLE entry exists, owner = go
 *       - request reaches Go through the controlled proxy exactly once
 *       - Node route handler path not taken (no x-middleware-next fallthrough)
 *       - response originates from the Go execution path
 *   CO-T01 .. CO-T07  routing-table invariants (47 / previous 36 preserved)
 *   CO-F01 .. CO-F03  no-fallback: Go unavailable => HTTP 502
 *                     GO_BACKEND_UNREACHABLE, zero Node execution / mutation
 *   Mutation exactly-once, SSE incremental streaming through the proxy, and
 *   Node handler non-execution side-effect fingerprints.
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

nextEnv.loadEnvConfig(process.cwd());

const suffix = `${Date.now()}_${process.pid}_${Math.floor(Math.random() * 100000)}`;
const xcloudDbName = `xcloud_p75_cutover_${suffix}`;
const appDbName = `xcloud_ops_p75_cutover_${suffix}`;
const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/xcloud';

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

// Frozen baseline accepted before Phase 7.5 (36 METHOD+PATH entries).
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

const PHASE_7_5_KEYS = PHASE_7_5_ROUTES.map((r) => `${r.method} ${r.path}`);

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
 * This keeps production code free of any test instrumentation switch.
 */
function createCaptureProxy(targetPort) {
  const counts = new Map();
  const order = [];
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
      }
    );
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
  };
}

async function callProxy(method, pathname, { token, body, search = '' } = {}) {
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
    const headers = { 'content-type': 'application/json' };
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

  // Connect and seed once, before any request path is exercised, so that the
  // no-fallback section and the runtime section share a single authoritative
  // fixture set (no duplicate actor documents).
  await client.connect();
  await seed();

  // ===========================================================
  // 1. Routing table invariants (CO-T01 .. CO-T07)
  // ===========================================================
  console.log('[1] Routing Table Invariants');

  await check('CO-T01 CUTOVER_TABLE total = 47', () => {
    assert.equal(CUTOVER_TABLE.length, 47, `expected 47, found ${CUTOVER_TABLE.length}`);
  });

  await check('CO-T02 ACTUALLY_ROUTED = 47 (all owner=go)', () => {
    const goOwned = CUTOVER_TABLE.filter((r) => r.owner === 'go');
    assert.equal(goOwned.length, 47, `expected 47 go-owned, found ${goOwned.length}`);
  });

  await check('CO-T03 previous 36 baseline entries unchanged and still owner=go', () => {
    for (const key of BASELINE_36) {
      const [method, p] = key.split(' ');
      const entry = CUTOVER_TABLE.find((r) => r.method === method && r.path === p);
      assert.ok(entry, `baseline entry missing: ${key}`);
      assert.equal(entry.owner, 'go', `baseline entry owner changed: ${key}`);
    }
  });

  await check('CO-T04 Phase 7.5 additions = exactly 11', () => {
    const found = PHASE_7_5_KEYS.filter((key) => {
      const [method, p] = key.split(' ');
      return CUTOVER_TABLE.some((r) => r.method === method && r.path === p);
    });
    assert.equal(found.length, 11, `expected 11 Phase 7.5 entries, found ${found.length}`);
  });

  await check('CO-T05 all 11 Phase 7.5 routes have owner=go', () => {
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

  await check('CO-T07 table is exactly baseline 36 + Phase 7.5 11 (no other route added)', () => {
    const expected = new Set([...BASELINE_36, ...PHASE_7_5_KEYS]);
    const actual = new Set(CUTOVER_TABLE.map((r) => `${r.method} ${r.path}`));
    assert.equal(actual.size, expected.size, `unexpected table size ${actual.size}`);
    for (const key of expected) {
      assert.ok(actual.has(key), `expected entry missing: ${key}`);
    }
  });

  await check('resolveRouteOwner returns "go" for all 11 Phase 7.5 routes', () => {
    for (const { method, path: p } of PHASE_7_5_ROUTES) {
      assert.equal(resolveRouteOwner(method, p), 'go', `owner mismatch for ${method} ${p}`);
    }
  });

  await check('Dormant Node route files are preserved (not deleted)', () => {
    for (const rel of NODE_ROUTE_FILES) {
      assert.ok(existsSync(path.resolve(import.meta.dirname, '..', rel)), `Node route file missing: ${rel}`);
    }
  });

  // ===========================================================
  // 2. Go backend route registration
  // ===========================================================
  console.log('\n[2] Go Backend Route Registration');

  const mainGoSource = readFileSync(path.resolve(import.meta.dirname, '..', 'backend/cmd/server/main.go'), 'utf8');
  const remediationSource = readFileSync(path.resolve(import.meta.dirname, '..', 'backend/internal/remediation/handler.go'), 'utf8');

  await check('Go registers the 9 directly-owned Phase 7.5 routes in main.go', () => {
    const direct = PHASE_7_5_ROUTES.filter((r) => !r.path.startsWith('/api/system/audit/heal') && !r.path.startsWith('/api/system/audit/batch-heal'));
    for (const { method, path: p } of direct) {
      assert.ok(mainGoSource.includes(`"${method} ${p}"`), `main.go missing route: ${method} ${p}`);
    }
  });

  await check('Go registers heal + batch-heal via remediation.RegisterRoutes', () => {
    assert.ok(mainGoSource.includes('remediation.RegisterRoutes(mux'),
      'main.go must wire remediation.RegisterRoutes');
    assert.ok(remediationSource.includes('"POST /api/system/audit/heal"'), 'remediation must register heal');
    assert.ok(remediationSource.includes('"POST /api/system/audit/batch-heal"'), 'remediation must register batch-heal');
  });

  // ===========================================================
  // 3. No-fallback contract (CO-F01 .. CO-F03)
  // ===========================================================
  console.log('\n[3] No-Fallback Contract (Go unavailable => HTTP 502)');

  const savedBackendUrl = process.env.GO_BACKEND_URL;
  process.env.GO_BACKEND_URL = 'http://127.0.0.1:1'; // intentionally unreachable

  const noFallbackToken = await makeToken('p75_admin', 'admin', 1);

  const noFallbackCases = [
    { id: 'CO-F01', method: 'GET', path: '/api/alerts', label: 'representative read route' },
    { id: 'CO-F02', method: 'POST', path: '/api/alerts/acknowledge', body: { id: 'alt-001' }, label: 'representative mutation route' },
    { id: 'CO-F03', method: 'GET', path: '/api/notifications/stream', label: 'SSE route' },
  ];

  const noFallbackEvidence = [];

  for (const c of noFallbackCases) {
    await check(`${c.id} ${c.method} ${c.path} (${c.label}) => 502 GO_BACKEND_UNREACHABLE, no Node execution`, async () => {
      const beforeAck = await client.db(appDbName).collection('app_alerts').countDocuments({ id: 'alt-001', is_acknowledged: true });
      const { res, logs } = await callProxy(c.method, c.path, { token: noFallbackToken, body: c.body });
      assert.equal(res.status, 502, `expected 502, got ${res.status}`);
      const json = await res.json();
      assert.equal(json.code, 'GO_BACKEND_UNREACHABLE');
      assert.equal(json.error, 'Backend temporarily unavailable');
      assert.equal(res.headers.get('x-middleware-next'), null, 'must not fall through to the Node handler');
      assert.equal(logs.length, 1, 'cutover_forward telemetry must be emitted once');
      const afterAck = await client.db(appDbName).collection('app_alerts').countDocuments({ id: 'alt-001', is_acknowledged: true });
      assert.equal(afterAck, beforeAck, 'no Node business mutation may occur under owner=go fail-closed');
      noFallbackEvidence.push({ id: c.id, method: c.method, path: c.path, status: res.status, code: json.code, nodeExecuted: 'NO', nodeMutation: 'NO' });
    });
  }

  process.env.GO_BACKEND_URL = savedBackendUrl;

  // ===========================================================
  // 4. Build Go backend, start capture proxy, seed data
  // ===========================================================
  console.log('\n[4] Production-Path Runtime (Go backend + test capture proxy)');

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

  capture = createCaptureProxy(goPort);
  capturePort = await getAvailablePort();
  await new Promise((resolve) => capture.server.listen(capturePort, '127.0.0.1', resolve));
  process.env.GO_BACKEND_URL = `http://127.0.0.1:${capturePort}`;

  const adminToken = await makeToken('p75_admin', 'admin', 1);
  const aDbHandle = client.db(appDbName);

  console.log(`  Go backend on 127.0.0.1:${goPort}, capture proxy on 127.0.0.1:${capturePort}`);

  // ===========================================================
  // 5. Route ownership cases (CO-R01 .. CO-R11, SSE = CO-R04)
  // ===========================================================
  console.log('\n[5] Production Route Ownership Cases');

  async function runRouteCase(def, { body, expectStatus, assertBody }) {
    await check(`${def.id} ${def.method} ${def.path} reaches Go exactly once via the controlled proxy`, async () => {
      capture.reset();
      const { res, logs } = await callProxy(def.method, def.path, { token: adminToken, body });
      const json = await res.json();

      assert.equal(res.status, expectStatus, `expected ${expectStatus}, got ${res.status}`);
      assert.equal(capture.countOf(def.method, def.path), 1, `Go forward count must be exactly 1 for ${def.method} ${def.path}`);
      assert.equal(capture.totalRequests(), 1, 'exactly one request may reach Go for this case');
      assert.equal(res.headers.get('x-middleware-next'), null, 'Node handler path must not be taken');
      assert.equal(logs.length, 1, 'cutover_forward must be emitted exactly once');
      assert.equal(logs[0].msg, 'cutover_forward');
      assert.equal(logs[0].path, def.path);
      assert.equal(logs[0].owner, 'go');
      assert.equal(logs[0].principal, 'p75_admin');
      if (assertBody) assertBody(json);

      recordCase({ id: def.id, method: def.method, path: def.path, forward: capture.countOf(def.method, def.path), nodeExec: 0, result: 'PASS' });
    });
  }

  await runRouteCase(PHASE_7_5_ROUTES[0], {
    expectStatus: 200,
    assertBody: (j) => assert.ok(Array.isArray(j.alerts), 'alerts must be an array'),
  });

  await runRouteCase(PHASE_7_5_ROUTES[1], {
    body: { id: 'alt-001' },
    expectStatus: 200,
    assertBody: (j) => {
      assert.equal(j.success, true);
      assert.equal(j.acknowledged, 1);
      assert.equal(j.requested, 1);
      assert.equal(j.skipped, 0);
    },
  });

  await runRouteCase(PHASE_7_5_ROUTES[2], {
    body: { id: 'alt-002', status: 'acknowledged' },
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
  await runRouteCase(PHASE_7_5_ROUTES[7], { body: { cursor: '0', phase: 'sub' }, expectStatus: 200 });
  await runRouteCase(PHASE_7_5_ROUTES[8], {
    body: { imsi: '001010000000001', type: 'orphan_reservation' },
    expectStatus: 200,
  });
  await runRouteCase(PHASE_7_5_ROUTES[9], {
    body: { anomalies: [{ imsi: '001010000000001', type: 'orphan_reservation' }] },
    expectStatus: 200,
    assertBody: (j) => assert.equal(j.successCount, 1),
  });
  await runRouteCase(PHASE_7_5_ROUTES[10], { expectStatus: 200 });

  // ===========================================================
  // 6. Mutation exactly-once evidence
  // ===========================================================
  console.log('\n[6] Mutation Exactly-Once Evidence');

  await check('CO-M01 alert.acknowledge persisted once (single audit record, rate-limit count 1)', async () => {
    const ackDocs = await aDbHandle.collection('app_alerts').countDocuments({ id: 'alt-001', is_acknowledged: true });
    assert.equal(ackDocs, 1, 'alt-001 must be acknowledged exactly once');
    const audit = await waitForAudit('alert.acknowledge', 1);
    assert.equal(audit, 1, `expected 1 alert.acknowledge audit record, found ${audit}`);
    assert.equal(await rateLimitCount('alerts:acknowledge:'), 1, 'acknowledge handler must have executed exactly once');
  });

  await check('CO-M02 alert.workflow persisted once (single audit record, rate-limit count 1)', async () => {
    const wfAudit = await waitForAudit('alert.workflow', 1);
    assert.equal(wfAudit, 1, `expected 1 alert.workflow audit record, found ${wfAudit}`);
    assert.equal(await rateLimitCount('alerts:workflow:'), 1, 'workflow handler must have executed exactly once');
  });

  await check('CO-M03 heal + batch-heal executed exactly once each (2 HEAL audit records, count 1 each)', async () => {
    const healAudit = await waitForAudit('HEAL', 2);
    assert.equal(healAudit, 2, `expected 2 HEAL audit records, found ${healAudit}`);
    assert.equal(await rateLimitCount('system:audit-heal:'), 1, 'heal handler must have executed exactly once');
    assert.equal(await rateLimitCount('system:audit-batch-heal:'), 1, 'batch-heal handler must have executed exactly once');
  });

  await check('CO-M04 read routes did not produce business mutations (scan stays read-only)', async () => {
    // scan is HTTP POST but logically read-only; the subscriber document must be untouched by the scan case.
    const sub = await client.db(xcloudDbName).collection('subscribers').findOne({ imsi: '001010000000001' });
    assert.ok(sub, 'seeded subscriber must still exist');
    assert.equal(sub.profile, 'default', 'scan must not mutate subscriber documents');
  });

  await check('CO-M05 zero approval tickets created (app_approvals count == 0)', async () => {
    const count = await aDbHandle.collection('app_approvals').countDocuments();
    assert.equal(count, 0, `expected 0 approvals, found ${count}`);
  });

  // ===========================================================
  // 7. SSE incremental streaming through the production proxy (CO-R04)
  // ===========================================================
  console.log('\n[7] SSE Production Cutover Evidence (CO-R04)');

  await check('CO-R04 GET /api/notifications/stream streams incrementally through the controlled proxy', async () => {
    capture.reset();
    const { res, logs } = await callProxy('GET', '/api/notifications/stream', { token: adminToken });
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    assert.equal(res.headers.get('x-middleware-next'), null, 'Node handler path must not be taken');
    assert.equal(capture.countOf('GET', '/api/notifications/stream'), 1, 'Go must receive exactly one stream request');
    assert.equal(logs.length, 1, 'cutover_forward must be emitted exactly once for the stream');

    const sse = createSSEReader(res);

    const initFrame = await sse.readFrame(5000);
    assert.ok(initFrame, 'init frame must arrive incrementally');
    assert.ok(initFrame.includes('event: init'), `expected init frame, got: ${initFrame}`);

    // Insert a new unacknowledged alert; the next 4s poll must surface an alerts_update.
    await aDbHandle.collection('app_alerts').insertOne({
      id: 'alt-900',
      timestamp: new Date().toISOString(),
      level: 'CRITICAL',
      imsi: '001010000000009',
      reason: 'P75 streaming probe',
      is_acknowledged: false,
    });

    let updateFrame = null;
    const updateDeadline = Date.now() + 10000;
    while (Date.now() < updateDeadline) {
      const f = await sse.readFrame(updateDeadline - Date.now());
      if (!f) break;
      if (f.includes('event: alerts_update')) {
        updateFrame = f;
        break;
      }
    }
    assert.ok(updateFrame, 'alerts_update must cross the proxy after the active alert count changes');

    // A heartbeat comment must also cross the proxy (stream is not terminated after the first frames).
    let heartbeat = null;
    const hbDeadline = Date.now() + 20000;
    while (Date.now() < hbDeadline) {
      const f = await sse.readFrame(hbDeadline - Date.now());
      if (!f) break;
      if (f.trim() === ':ping') {
        heartbeat = f;
        break;
      }
    }
    await sse.close();
    assert.equal(heartbeat, ':ping', 'heartbeat comment must cross the proxy');

    recordCase({ id: 'CO-R04', method: 'GET', path: '/api/notifications/stream', forward: 1, nodeExec: 0, result: 'PASS' });
  });

  await check('CO-R04b session-expired behavior preserved through the proxy', async () => {
    capture.reset();
    const { res } = await callProxy('GET', '/api/notifications/stream', { token: adminToken });
    assert.equal(res.status, 200);
    const sse = createSSEReader(res);
    const first = await sse.readFrame(5000);
    assert.ok(first && first.includes('event: init'), 'init frame must arrive before revocation');

    // Revoke the session by bumping sessionVersion; the periodic revalidation must emit session_expired.
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

    // Restore the session so later assertions/token remain valid.
    await aDbHandle.collection('app_users').updateOne(
      { username: 'p75_admin' },
      { $set: { 'security.sessionVersion': 1 } }
    );
    assert.ok(expired, 'session_expired must be emitted after session revocation');
  });

  // ===========================================================
  // 8. Coverage summary
  // ===========================================================
  console.log('\n[8] Route Ownership Matrix');

  await check('CO-R01..CO-R11 all covered with forward count 1 and Node execution 0', () => {
    assert.equal(caseResults.length, 11, `expected 11 route cases, found ${caseResults.length}`);
    for (const c of caseResults) {
      assert.equal(c.forward, 1, `${c.id} forward count must be 1`);
      assert.equal(c.nodeExec, 0, `${c.id} Node handler execution must be 0`);
      assert.equal(c.result, 'PASS', `${c.id} must PASS`);
    }
  });

  await check('No-fallback evidence recorded for CO-F01..CO-F03', () => {
    assert.equal(noFallbackEvidence.length, 3, 'expected 3 no-fallback cases');
    for (const e of noFallbackEvidence) {
      assert.equal(e.status, 502, `${e.id} must be HTTP 502`);
      assert.equal(e.code, 'GO_BACKEND_UNREACHABLE', `${e.id} must report GO_BACKEND_UNREACHABLE`);
    }
  });

  console.log('\n-- Route ownership matrix --');
  console.log('ID     | Method | Path                              | Prev  | New | Fwd | NodeExec | Result');
  for (const c of caseResults) {
    console.log(`${c.id} | ${c.method.padEnd(6)} | ${c.path.padEnd(33)} | Node  | Go  | ${String(c.forward).padEnd(3)} | ${String(c.nodeExec).padEnd(8)} | ${c.result}`);
  }

  console.log('\n==================================================');
  console.log('Phase 7.5 Controlled Platform Services Cutover Suite');
  console.log(`TOTAL=${total} PASS=${passed} FAIL=${failed} SKIP=${skipped}`);
  console.log('CUTOVER_TABLE=47 ACTUALLY_ROUTED=47 Phase 7.5 Go-owned=11');
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
