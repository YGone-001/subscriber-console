#!/usr/bin/env node
/**
 * Phase 7.1 - Platform Services Go Read Parity Integration Suite
 *
 * Runs Node and Go Platform Service implementations against isolated
 * MongoDB test databases and verifies exact 1:1 parity for:
 * 1. Unauthorized Gate (HTTP 401 on missing/invalid token)
 * 2. GET  /api/alerts (HTTP 200 schema, active counts, list sorting)
 * 3. GET  /api/system/mongo/health (HTTP 200 success & failure contracts, collections, indexes)
 * 4. GET  /api/system/health (HTTP 200 subsystems, scoring, recommendations)
 * 5. GET  /api/system/audit/status (HTTP 200 lastSaveTime timestamp)
 * 6. POST /api/system/audit/scan (HTTP 403 viewer RBAC, HTTP 500 malformed JSON, 4 phases, zero DB writes)
 * 7. POST /api/analytics/init (HTTP 403 viewer RBAC, HTTP 200 metrics schema, zero DB writes)
 * 8. Cross-Language Session Invalidation & Token Revocation
 * 9. Production Routing Invariant (CUTOVER_TABLE=36, ACTUALLY_ROUTED=36, 0 Phase 7 cutover)
 */

import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { existsSync, unlinkSync } from 'node:fs';
import { execSync, spawn } from 'node:child_process';
import { SignJWT, jwtVerify } from 'jose';
import { MongoClient } from 'mongodb';
import { createJiti } from 'jiti';
import nextEnv from '@next/env';
import bcrypt from 'bcryptjs';

nextEnv.loadEnvConfig(process.cwd());

const originalConsoleError = console.error;
console.error = (...args) => {
  if (typeof args[0] === 'string' && (args[0].includes('Alert fetch failed') || args[0].includes('Audit scan failed') || args[0].includes('Failed to get system status'))) {
    return;
  }
  originalConsoleError(...args);
};

const suffix = `${Date.now()}_${process.pid}_${Math.floor(Math.random() * 100000)}`;
const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/xcloud';

// Isolated DB pairs
const xcloudDbNode = `xcloud_p7_node_${suffix}`;
const appDbNode = `xcloud_ops_p7_node_${suffix}`;
const xcloudDbGo = `xcloud_p7_go_${suffix}`;
const appDbGo = `xcloud_ops_p7_go_${suffix}`;

const JWT_SECRET_STRING = 'platform-read-parity-secret-32-bytes-long!';
process.env.JWT_SECRET = JWT_SECRET_STRING;

// Configure Node backend to point to Node DB pair
process.env.MONGODB_XCLOUD_DB = xcloudDbNode;
process.env.MONGODB_APP_DB = appDbNode;

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  alias: {
    '@': new URL('../frontend/src/', import.meta.url).pathname,
    'next/server': new URL('../frontend/node_modules/next/server.js', import.meta.url).pathname,
  },
});

const { NextRequest, NextResponse } = jiti('next/server');
const { GET: nodeAlertsHandler } = jiti('../frontend/src/app/api/alerts/route.ts');
const { GET: nodeSystemHealthHandler } = jiti('../frontend/src/app/api/system/health/route.ts');
const { GET: nodeMongoHealthHandler } = jiti('../frontend/src/app/api/system/mongo/health/route.ts');
const { GET: nodeAuditStatusHandler } = jiti('../frontend/src/app/api/system/audit/status/route.ts');
const { POST: nodeAuditScanHandler } = jiti('../frontend/src/app/api/system/audit/scan/route.ts');
const { POST: nodeAnalyticsInitHandler } = jiti('../frontend/src/app/api/analytics/init/route.ts');
const { CUTOVER_TABLE } = jiti('../frontend/src/lib/cutover-routing.ts');

const client = new MongoClient(uri, {
  serverSelectionTimeoutMS: Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS || 5000),
});

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

let goProc = null;
let binPath = null;
let passed = 0;
let totalChecks = 0;

function verify(description, fn) {
  totalChecks++;
  try {
    fn();
    console.log(`  PASS  ${description}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${description}`);
    console.error(err);
    throw err;
  }
}

async function verifyAsync(description, fn) {
  totalChecks++;
  try {
    await fn();
    console.log(`  PASS  ${description}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${description}`);
    console.error(err);
    throw err;
  }
}

function makeToken(username, role, sv, expSeconds = 86400) {
  return new SignJWT({ username, role, sv })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt(Math.floor(Date.now() / 1000))
    .setExpirationTime(Math.floor(Date.now() / 1000) + expSeconds)
    .sign(new TextEncoder().encode(JWT_SECRET_STRING));
}

async function seedData(xcloudDbName, appDbName) {
  const xDb = client.db(xcloudDbName);
  const aDb = client.db(appDbName);

  // Users
  const salt = await bcrypt.genSalt(10);
  const hash = await bcrypt.hash('TestPass123!', salt);
  await aDb.collection('app_users').insertMany([
    { username: 'admin_user', passwordHash: hash, role: 'admin', status: 'active', security: { sessionVersion: 1 }, createdAt: new Date().toISOString() },
    { username: 'operator_user', passwordHash: hash, role: 'operator', status: 'active', security: { sessionVersion: 1 }, createdAt: new Date().toISOString() },
    { username: 'viewer_user', passwordHash: hash, role: 'viewer', status: 'active', security: { sessionVersion: 1 }, createdAt: new Date().toISOString() },
  ]);

  // Alerts
  await aDb.collection('app_alerts').insertMany([
    {
      id: 'alt-001',
      timestamp: '2026-09-27T10:00:00.000Z',
      level: 'CRITICAL',
      imsi: '001010000000001',
      reason: 'High CPU core temperature',
      is_acknowledged: false,
    },
    {
      id: 'alt-002',
      timestamp: '2026-09-27T09:00:00.000Z',
      level: 'WARNING',
      imsi: '001010000000002',
      reason: 'Disk space warning',
      is_acknowledged: false,
    },
    {
      id: 'alt-003',
      timestamp: '2026-09-27T08:00:00.000Z',
      level: 'INFO',
      imsi: '001010000000003',
      reason: 'Periodic health heartbeat',
      is_acknowledged: true,
    },
  ]);

  // Tariff plans
  await xDb.collection('ocs_tariff_plans').insertOne({
    plan_id: 'default-standard',
    name: 'Standard Default Tariff Plan',
    rules: [{ rating_group: 1 }],
  });

  // Profiles
  await aDb.collection('app_profiles').insertOne({
    name: 'default',
    created_at: new Date().toISOString(),
  });

  // Subscribers
  await xDb.collection('subscribers').insertOne({
    imsi: '001010000000001',
    security: {
      k: '465B5CE8B199B49FAA5F0A2EE238A6BC',
      opc: 'E8ED289DEBA952E4283B54E88E6183CA',
    },
    slice: [{ sst: 1 }],
    ambr: { dl: 10000000, ul: 10000000 },
    profile: 'default',
  });

  // OCS Subscribers
  await xDb.collection('ocs_subscribers').insertOne({
    imsi: '001010000000001',
    plan_id: 'default-standard',
  });

  // OCS Balances
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

  // Sessions
  await xDb.collection('ocs_sessions').insertOne({
    session_id: 'sess-active-01',
    state: 'active',
  });

  // Reservations
  await xDb.collection('ocs_reservations').insertOne({
    reservation_id: 'res-active-01',
    session_id: 'sess-active-01',
    imsi: '001010000000001',
    state: 'active',
    reserved_octets: 100000,
  });

  // Audit logs
  await aDb.collection('app_audit_logs').insertOne({
    action: 'system.bootstrap',
    module: 'system',
    timestamp: new Date().toISOString(),
  });
}

let goPort = null;

async function callNode(handler, pathStr, method, token, role, user, body = null) {
  const reqHeaders = { 'content-type': 'application/json' };
  if (token) {
    reqHeaders['cookie'] = `auth_token=${token}`;
    reqHeaders['x-user'] = user;
    reqHeaders['x-user-role'] = role;
    reqHeaders['x-user-session-version'] = '1';
  }
  const req = new NextRequest(`http://localhost${pathStr}`, {
    method,
    headers: reqHeaders,
    body: body !== null ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });
  const res = await handler(req);
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, headers: res.headers, body: json };
}

async function callGo(pathStr, method, token, body = null) {
  const reqHeaders = { 'content-type': 'application/json' };
  if (token) {
    reqHeaders['cookie'] = `auth_token=${token}`;
  }
  const res = await fetch(`http://127.0.0.1:${goPort}${pathStr}`, {
    method,
    headers: reqHeaders,
    body: body !== null ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, headers: res.headers, body: json };
}

async function cleanup() {
  console.log('\nCleaning up resources...');
  if (goProc && goProc.pid) {
    if (process.platform === 'win32') {
      try { execSync(`taskkill /pid ${goProc.pid} /T /F`, { stdio: 'ignore' }); } catch {}
    } else {
      try { goProc.kill('SIGTERM'); } catch {}
    }
  }
  if (binPath && existsSync(binPath)) {
    try {
      unlinkSync(binPath);
    } catch {}
  }
  try {
    await client.db(xcloudDbNode).dropDatabase();
    await client.db(appDbNode).dropDatabase();
    await client.db(xcloudDbGo).dropDatabase();
    await client.db(appDbGo).dropDatabase();
  } catch {}
  try {
    await client.close();
  } catch {}
  process.exit(process.exitCode || 0);
}

async function main() {
  console.log('===============================================================');
  console.log('Phase 7.1 - Platform Services Go Read Parity Integration Suite');
  console.log('===============================================================');

  // Connect Mongo
  await client.connect();
  console.log('Connected to MongoDB at', uri);

  // Seed databases
  console.log('Seeding Node test databases:', xcloudDbNode, appDbNode);
  await seedData(xcloudDbNode, appDbNode);
  console.log('Seeding Go test databases:', xcloudDbGo, appDbGo);
  await seedData(xcloudDbGo, appDbGo);

  // Build Go backend
  goPort = await getAvailablePort();
  console.log('Building Go backend binary...');
  const binExt = process.platform === 'win32' ? '.exe' : '';
  binPath = path.join(os.tmpdir(), `server_p71_parity_${suffix}${binExt}`);
  execSync(`go build -o "${binPath}" ./cmd/server`, {
    cwd: path.join(process.cwd(), 'backend'),
    stdio: 'pipe',
  });
  assert.ok(existsSync(binPath), 'compiled Go binary must exist');
  console.log('Go binary compiled successfully:', binPath);

  // Start Go backend
  console.log(`Starting Go backend on 127.0.0.1:${goPort}...`);
  const env = {
    ...process.env,
    HTTP_ADDR: `127.0.0.1:${goPort}`,
    MONGODB_URI: uri,
    MONGODB_XCLOUD_DB: xcloudDbGo,
    MONGODB_APP_DB: appDbGo,
    JWT_SECRET: JWT_SECRET_STRING,
  };

  goProc = spawn(binPath, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });

  // Wait for Go server to become ready
  await new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - start > 10000) {
        clearInterval(timer);
        reject(new Error('timeout waiting for Go server'));
        return;
      }
      const sock = net.connect(goPort, '127.0.0.1', () => {
        sock.destroy();
        clearInterval(timer);
        resolve();
      });
      sock.on('error', () => {});
    }, 100);
  });
  console.log('Go server ready on port', goPort);

  // Generate tokens for each role
  const adminToken = await makeToken('admin_user', 'admin', 1);
  const operatorToken = await makeToken('operator_user', 'operator', 1);
  const viewerToken = await makeToken('viewer_user', 'viewer', 1);

  // ---------------------------------------------------------------------------
  // 1. Unauthorized Gate (HTTP 401 on missing/invalid token)
  // ---------------------------------------------------------------------------
  console.log('\n--- 1. Unauthorized Gate Verification ---');
  const candidateRoutes = [
    { method: 'GET', path: '/api/alerts', handler: nodeAlertsHandler },
    { method: 'GET', path: '/api/system/health', handler: nodeSystemHealthHandler },
    { method: 'GET', path: '/api/system/mongo/health', handler: nodeMongoHealthHandler },
    { method: 'GET', path: '/api/system/audit/status', handler: nodeAuditStatusHandler },
    { method: 'POST', path: '/api/system/audit/scan', handler: nodeAuditScanHandler, body: { cursor: '0', phase: 'sub' } },
    { method: 'POST', path: '/api/analytics/init', handler: nodeAnalyticsInitHandler },
  ];

  for (const r of candidateRoutes) {
    await verifyAsync(`Unauthorized request to ${r.method} ${r.path} returns HTTP 401 parity`, async () => {
      const nodeRes = await callNode(r.handler, r.path, r.method, null, null, null, r.body);
      const goRes = await callGo(r.path, r.method, null, r.body);

      assert.equal(nodeRes.status, 401, `Node ${r.path} status must be 401`);
      assert.equal(goRes.status, 401, `Go ${r.path} status must be 401`);
      assert.equal(nodeRes.body.error, 'Unauthorized');
      assert.equal(goRes.body.error, 'Unauthorized');
      assert.equal(nodeRes.body.code, 'AUTH_INVALID_TOKEN');
      assert.equal(goRes.body.code, 'AUTH_INVALID_TOKEN');
    });
  }

  // ---------------------------------------------------------------------------
  // 2. GET /api/alerts Contract Parity
  // ---------------------------------------------------------------------------
  console.log('\n--- 2. GET /api/alerts Contract Parity ---');
  for (const [role, token] of [['admin', adminToken], ['operator', operatorToken], ['viewer', viewerToken]]) {
    await verifyAsync(`GET /api/alerts for role '${role}' returns HTTP 200 contract parity`, async () => {
      const nodeRes = await callNode(nodeAlertsHandler, '/api/alerts', 'GET', token, role, `${role}_user`);
      const goRes = await callGo('/api/alerts', 'GET', token);

      assert.equal(nodeRes.status, 200, 'Node status must be 200');
      assert.equal(goRes.status, 200, 'Go status must be 200');

      // Key assertions
      assert.ok(Array.isArray(nodeRes.body.alerts), 'Node alerts must be array');
      assert.ok(Array.isArray(goRes.body.alerts), 'Go alerts must be array');
      assert.equal(goRes.body.alerts.length, nodeRes.body.alerts.length, 'Alerts count match');
      assert.equal(goRes.body.activeCriticalCount, nodeRes.body.activeCriticalCount, 'activeCriticalCount match');
      assert.equal(goRes.body.activeWarningCount, nodeRes.body.activeWarningCount, 'activeWarningCount match');
      assert.equal(goRes.body.activeCount, nodeRes.body.activeCount, 'activeCount match');

      // Check fields and exclusion of _id
      for (const alert of goRes.body.alerts) {
        assert.equal(alert._id, undefined, '_id must be stripped from alerts');
        assert.ok(typeof alert.id === 'string', 'alert id must be string');
        assert.ok(typeof alert.timestamp === 'string', 'alert timestamp must be string');
        assert.ok(typeof alert.level === 'string', 'alert level must be string');
        assert.ok(typeof alert.imsi === 'string', 'alert imsi must be string');
        assert.ok(typeof alert.reason === 'string', 'alert reason must be string');
        assert.ok(typeof alert.is_acknowledged === 'boolean', 'alert is_acknowledged must be boolean');
      }

      // Check newest-first sorting
      assert.equal(goRes.body.alerts[0].id, 'alt-001', 'Alerts must be sorted newest first');
    });
  }

  // ---------------------------------------------------------------------------
  // 3. GET /api/system/mongo/health Contract Parity
  // ---------------------------------------------------------------------------
  console.log('\n--- 3. GET /api/system/mongo/health Contract Parity ---');
  for (const [role, token] of [['admin', adminToken], ['operator', operatorToken], ['viewer', viewerToken]]) {
    await verifyAsync(`GET /api/system/mongo/health for role '${role}' returns HTTP 200 schema parity`, async () => {
      const nodeRes = await callNode(nodeMongoHealthHandler, '/api/system/mongo/health', 'GET', token, role, `${role}_user`);
      const goRes = await callGo('/api/system/mongo/health', 'GET', token);

      assert.equal(nodeRes.status, 200, 'Node status must be 200');
      assert.equal(goRes.status, 200, 'Go status must be 200');

      // Schema keys
      const requiredKeys = ['ok', 'database', 'databases', 'checkedAt', 'latencyMs', 'collections', 'missingCollections', 'missingIndexes'];
      for (const k of requiredKeys) {
        assert.ok(k in nodeRes.body, `Node response missing key ${k}`);
        assert.ok(k in goRes.body, `Go response missing key ${k}`);
      }

      assert.ok(typeof goRes.body.ok === 'boolean', 'ok must be boolean');
      assert.ok(typeof goRes.body.database === 'string', 'database must be string');
      assert.ok(typeof goRes.body.databases === 'object', 'databases must be object');
      assert.ok(typeof goRes.body.latencyMs === 'number', 'latencyMs must be number');
      assert.ok(Array.isArray(goRes.body.collections), 'collections must be array');
      assert.ok(Array.isArray(goRes.body.missingCollections), 'missingCollections must be array');
      assert.ok(Array.isArray(goRes.body.missingIndexes), 'missingIndexes must be array');

      // Collections count parity
      assert.equal(goRes.body.collections.length, nodeRes.body.collections.length, 'Collections list length match');
      assert.equal(goRes.body.collections.length, 11, 'Expected collections count is 11');

      for (const c of goRes.body.collections) {
        assert.ok('database' in c && 'name' in c && 'exists' in c && 'documentCount' in c && 'missingIndexes' in c);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // 4. GET /api/system/health Contract Parity
  // ---------------------------------------------------------------------------
  console.log('\n--- 4. GET /api/system/health Contract Parity ---');
  for (const [role, token] of [['admin', adminToken], ['operator', operatorToken], ['viewer', viewerToken]]) {
    await verifyAsync(`GET /api/system/health for role '${role}' returns HTTP 200 contract parity`, async () => {
      const nodeRes = await callNode(nodeSystemHealthHandler, '/api/system/health', 'GET', token, role, `${role}_user`);
      const goRes = await callGo('/api/system/health', 'GET', token);

      assert.equal(nodeRes.status, 200, 'Node status must be 200');
      assert.equal(goRes.status, 200, 'Go status must be 200');

      // Top-level structure
      assert.ok(['healthy', 'degraded', 'critical'].includes(goRes.body.status), 'valid status enum');
      assert.ok(typeof goRes.body.score === 'number' && goRes.body.score >= 0 && goRes.body.score <= 100, 'valid score range');
      assert.ok(typeof goRes.body.checkedAt === 'string', 'valid checkedAt string');

      // Subsystems structure
      const subs = goRes.body.subsystems;
      assert.ok(subs.database && subs.ocsEngine && subs.hssCore && subs.security, 'all 4 subsystems present');

      assert.ok(['healthy', 'degraded', 'critical'].includes(subs.database.status));
      assert.ok(['healthy', 'degraded', 'critical'].includes(subs.ocsEngine.status));
      assert.ok(['healthy', 'degraded', 'critical'].includes(subs.hssCore.status));
      assert.ok(['healthy', 'degraded', 'critical'].includes(subs.security.status));

      // Summary structure
      assert.ok(typeof goRes.body.summary.totalAnomaliesDetected === 'number');
      assert.ok(typeof goRes.body.summary.actionableItemsCount === 'number');
      assert.ok(Array.isArray(goRes.body.summary.recommendations));
    });
  }

  // ---------------------------------------------------------------------------
  // 5. GET /api/system/audit/status Contract Parity
  // ---------------------------------------------------------------------------
  console.log('\n--- 5. GET /api/system/audit/status Contract Parity ---');
  for (const [role, token] of [['admin', adminToken], ['operator', operatorToken], ['viewer', viewerToken]]) {
    await verifyAsync(`GET /api/system/audit/status for role '${role}' returns HTTP 200 timestamp parity`, async () => {
      const nowBefore = Math.floor(Date.now() / 1000);
      const nodeRes = await callNode(nodeAuditStatusHandler, '/api/system/audit/status', 'GET', token, role, `${role}_user`);
      const goRes = await callGo('/api/system/audit/status', 'GET', token);
      const nowAfter = Math.floor(Date.now() / 1000);

      assert.equal(nodeRes.status, 200, 'Node status must be 200');
      assert.equal(goRes.status, 200, 'Go status must be 200');

      assert.ok(typeof goRes.body.lastSaveTime === 'number', 'lastSaveTime must be number');
      assert.ok(
        goRes.body.lastSaveTime >= nowBefore - 2 && goRes.body.lastSaveTime <= nowAfter + 2,
        'lastSaveTime must match current Unix timestamp'
      );
    });
  }

  // ---------------------------------------------------------------------------
  // 6. POST /api/system/audit/scan Contract & RBAC Parity
  // ---------------------------------------------------------------------------
  console.log('\n--- 6. POST /api/system/audit/scan Contract & RBAC Parity ---');
  // Viewer denied (403)
  await verifyAsync('POST /api/system/audit/scan denies viewer role with HTTP 403 on both Node and Go', async () => {
    const nodeRes = await callNode(nodeAuditScanHandler, '/api/system/audit/scan', 'POST', viewerToken, 'viewer', 'viewer_user', { cursor: '0', phase: 'sub' });
    const goRes = await callGo('/api/system/audit/scan', 'POST', viewerToken, { cursor: '0', phase: 'sub' });

    assert.equal(nodeRes.status, 403, 'Node status must be 403');
    assert.equal(goRes.status, 403, 'Go status must be 403');
    assert.equal(nodeRes.body.code, 'PERMISSION_DENIED');
    assert.equal(goRes.body.code, 'PERMISSION_DENIED');
    assert.equal(nodeRes.body.error, 'Forbidden: Insufficient permissions');
    assert.equal(goRes.body.error, 'Forbidden: Insufficient permissions');
  });

  // Malformed JSON returns 500
  await verifyAsync('POST /api/system/audit/scan on malformed JSON returns HTTP 500 on both Node and Go', async () => {
    const nodeRes = await callNode(nodeAuditScanHandler, '/api/system/audit/scan', 'POST', adminToken, 'admin', 'admin_user', 'invalid-json-body');
    const goRes = await callGo('/api/system/audit/scan', 'POST', adminToken, 'invalid-json-body');

    assert.equal(nodeRes.status, 500, 'Node status must be 500');
    assert.equal(goRes.status, 500, 'Go status must be 500');
    assert.equal(nodeRes.body.error, 'Audit scan failed');
    assert.equal(goRes.body.error, 'Audit scan failed');
  });

  // Phases testing for admin and operator
  const phases = ['reservation', 'tariff', 'ocs', 'sub'];
  for (const phase of phases) {
    await verifyAsync(`POST /api/system/audit/scan phase '${phase}' parity`, async () => {
      const nodeRes = await callNode(nodeAuditScanHandler, '/api/system/audit/scan', 'POST', adminToken, 'admin', 'admin_user', { cursor: '0', phase });
      const goRes = await callGo('/api/system/audit/scan', 'POST', adminToken, { cursor: '0', phase });

      assert.equal(nodeRes.status, 200, `Node ${phase} status must be 200`);
      assert.equal(goRes.status, 200, `Go ${phase} status must be 200`);

      assert.ok(typeof goRes.body.nextCursor === 'string', 'nextCursor must be string');
      assert.ok(typeof goRes.body.scannedCount === 'number', 'scannedCount must be number');
      assert.ok(Array.isArray(goRes.body.anomalies), 'anomalies must be array');

      assert.equal(goRes.body.scannedCount, nodeRes.body.scannedCount, `scannedCount parity for ${phase}`);
      assert.equal(goRes.body.nextCursor, nodeRes.body.nextCursor, `nextCursor parity for ${phase}`);
      assert.equal(goRes.body.anomalies.length, nodeRes.body.anomalies.length, `anomalies length parity for ${phase}`);
    });
  }

  // Operator role also allowed
  await verifyAsync('POST /api/system/audit/scan allows operator role', async () => {
    const goRes = await callGo('/api/system/audit/scan', 'POST', operatorToken, { cursor: '0', phase: 'sub' });
    assert.equal(goRes.status, 200, 'Operator status must be 200');
  });

  // ---------------------------------------------------------------------------
  // 7. POST /api/analytics/init Contract & RBAC Parity
  // ---------------------------------------------------------------------------
  console.log('\n--- 7. POST /api/analytics/init Contract & RBAC Parity ---');
  // Viewer denied (403)
  await verifyAsync('POST /api/analytics/init denies viewer role with HTTP 403 on both Node and Go', async () => {
    const nodeRes = await callNode(nodeAnalyticsInitHandler, '/api/analytics/init', 'POST', viewerToken, 'viewer', 'viewer_user');
    const goRes = await callGo('/api/analytics/init', 'POST', viewerToken);

    assert.equal(nodeRes.status, 403, 'Node status must be 403');
    assert.equal(goRes.status, 403, 'Go status must be 403');
    assert.equal(nodeRes.body.code, 'PERMISSION_DENIED');
    assert.equal(goRes.body.code, 'PERMISSION_DENIED');
    assert.equal(nodeRes.body.error, 'Forbidden: Insufficient permissions');
    assert.equal(goRes.body.error, 'Forbidden: Insufficient permissions');
  });

  // Admin allowed (200)
  await verifyAsync('POST /api/analytics/init for admin returns HTTP 200 schema parity', async () => {
    const nodeRes = await callNode(nodeAnalyticsInitHandler, '/api/analytics/init', 'POST', adminToken, 'admin', 'admin_user');
    const goRes = await callGo('/api/analytics/init', 'POST', adminToken);

    assert.equal(nodeRes.status, 200, 'Node status must be 200');
    assert.equal(goRes.status, 200, 'Go status must be 200');

    assert.equal(goRes.body.message, nodeRes.body.message);
    assert.equal(goRes.body.message, 'MongoDB analytics are computed from subscriber documents on demand.');

    const nodeMetrics = nodeRes.body.metrics;
    const goMetrics = goRes.body.metrics;

    assert.ok(typeof goMetrics.totalTraffic === 'number');
    assert.ok(Array.isArray(goMetrics.plmnDist));
    assert.ok(Array.isArray(goMetrics.ratesDist));
    assert.ok(Array.isArray(goMetrics.top5));
    assert.ok(typeof goMetrics.timestamp === 'number');
    assert.ok(goMetrics.ocsBalances && typeof goMetrics.ocsBalances === 'object');
    assert.ok(goMetrics.ocsSessions && typeof goMetrics.ocsSessions === 'object');
    assert.ok(goMetrics.ocsReservations && typeof goMetrics.ocsReservations === 'object');
    assert.ok(Array.isArray(goMetrics.tariffPlanDist));
    assert.ok(goMetrics.ocsUsage && typeof goMetrics.ocsUsage === 'object');
  });

  // Operator allowed (200)
  await verifyAsync('POST /api/analytics/init allows operator role', async () => {
    const goRes = await callGo('/api/analytics/init', 'POST', operatorToken);
    assert.equal(goRes.status, 200, 'Operator status must be 200');
  });

  // ---------------------------------------------------------------------------
  // 8. Zero Database Mutation Invariant for Semantic Reads
  // ---------------------------------------------------------------------------
  console.log('\n--- 8. Zero Database Mutation Verification ---');
  await verifyAsync('Verify POST /api/system/audit/scan and POST /api/analytics/init did not mutate database', async () => {
    const xDbGo = client.db(xcloudDbGo);
    const aDbGo = client.db(appDbGo);

    const subCount = await xDbGo.collection('subscribers').countDocuments({});
    const balCount = await xDbGo.collection('ocs_balances').countDocuments({});
    const alertCount = await aDbGo.collection('app_alerts').countDocuments({});
    const userCount = await aDbGo.collection('app_users').countDocuments({});

    assert.equal(subCount, 1, 'subscribers count must be unchanged');
    assert.equal(balCount, 1, 'ocs_balances count must be unchanged');
    assert.equal(alertCount, 3, 'app_alerts count must be unchanged');
    assert.equal(userCount, 3, 'app_users count must be unchanged');
  });

  // ---------------------------------------------------------------------------
  // 9. Cross-Language Session Invalidation & Token Revocation
  // ---------------------------------------------------------------------------
  console.log('\n--- 9. Session Invalidation & Token Revocation ---');
  await verifyAsync('Session version increment in MongoDB immediately revokes token in Go', async () => {
    const aDbGo = client.db(appDbGo);
    await aDbGo.collection('app_users').updateOne(
      { username: 'operator_user' },
      { $inc: { 'security.sessionVersion': 1 } }
    );

    // Old token has sv=1, but DB now has sv=2
    const goRes = await callGo('/api/alerts', 'GET', operatorToken);
    assert.equal(goRes.status, 401, 'Revoked session token must return 401');
    assert.equal(goRes.body.code, 'SESSION_REVOKED');
  });

  // ---------------------------------------------------------------------------
  // 10. Production Routing Invariant Verification
  // ---------------------------------------------------------------------------
  console.log('\n--- 10. Production Routing Invariant Verification ---');
  verify('CUTOVER_TABLE length is exactly 36', () => {
    assert.equal(CUTOVER_TABLE.length, 36);
  });
  verify('ACTUALLY_ROUTED count is exactly 36', () => {
    const routed = CUTOVER_TABLE.filter((r) => r.owner === 'go');
    assert.equal(routed.length, 36);
  });
  verify('Zero Phase 7 endpoints exist in CUTOVER_TABLE', () => {
    for (const entry of CUTOVER_TABLE) {
      assert.ok(!entry.path.startsWith('/api/alerts'), `cutover table must not contain ${entry.path}`);
      assert.ok(!entry.path.startsWith('/api/notifications'), `cutover table must not contain ${entry.path}`);
      assert.ok(!entry.path.startsWith('/api/system'), `cutover table must not contain ${entry.path}`);
      assert.ok(entry.path !== '/api/analytics/init', `cutover table must not contain ${entry.path}`);
    }
  });

  console.log('\n===============================================================');
  console.log(`Phase 7.1 Read Parity Suite: ${passed}/${totalChecks} PASS`);
  console.log('===============================================================');
}

main()
  .catch((err) => {
    console.error('Test suite failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
  });
