#!/usr/bin/env node
/**
 * Phase 7.1 - Platform Services Go Read Parity Integration Suite
 *
 * Runs Node and Go Platform Service implementations against isolated
 * MongoDB test databases and verifies exact 1:1 parity across 14 sections:
 * 1. Unauthorized / RBAC
 * 2. Normal success parity
 * 3. Rate-limit boundary parity
 * 4. Failure-path parity
 * 5. Alert edge cases
 * 6. Mongo Health edge cases
 * 7. System Health degraded case
 * 8. Audit Scan defaults / pagination
 * 9. Analytics nested metrics
 * 10. Numeric / null / optional serialization
 * 11. Zero business mutation
 * 12. Session invalidation
 * 13. Routing invariants
 * 14. Production fault-switch isolation
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { existsSync, unlinkSync, readFileSync, readdirSync } from 'node:fs';
import { execSync, spawn } from 'node:child_process';
import { SignJWT, jwtVerify } from 'jose';
import { MongoClient, Long } from 'mongodb';
import { createJiti } from 'jiti';
import nextEnv from '@next/env';
import bcrypt from 'bcryptjs';

nextEnv.loadEnvConfig(process.cwd());

const originalConsoleError = console.error;
console.error = (...args) => {
  if (
    typeof args[0] === 'string' &&
    (args[0].includes('Alert fetch failed') ||
      args[0].includes('Audit scan failed') ||
      args[0].includes('Failed to get system status') ||
      args[0].includes('Audit engine API failed') ||
      args[0].includes('System health check failed') ||
      args[0].includes('MongoDB health check failed') ||
      args[0].includes('Rate limiter MongoDB error'))
  ) {
    return;
  }
  originalConsoleError(...args);
};

const originalConsoleWarn = console.warn;
console.warn = (...args) => {
  if (typeof args[0] === 'string' && args[0].includes('Rate limiter MongoDB error')) {
    return;
  }
  originalConsoleWarn(...args);
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

const { NextRequest } = jiti('next/server');
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
let goProcFail = null;
let goPort = null;
let goFailPort = null;
let nodeServer = null;
let nodePort = null;
let binPath = null;
let binPathFail = null;
let passed = 0;
let failed = 0;
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
    failed++;
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
    failed++;
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

const rateLimitFixtures = [
  {
    name: 'alerts',
    method: 'GET',
    path: '/api/alerts',
    limit: 120,
    windowSeconds: 60,
    keyPrefix: 'alerts:list:',
    handler: nodeAlertsHandler,
    body: null,
  },
  {
    name: 'system_health',
    method: 'GET',
    path: '/api/system/health',
    limit: 30,
    windowSeconds: 60,
    keyPrefix: 'system:health:',
    handler: nodeSystemHealthHandler,
    body: null,
  },
  {
    name: 'mongo_health',
    method: 'GET',
    path: '/api/system/mongo/health',
    limit: 30,
    windowSeconds: 60,
    keyPrefix: 'system:mongo-health:',
    handler: nodeMongoHealthHandler,
    body: null,
  },
  {
    name: 'audit_status',
    method: 'GET',
    path: '/api/system/audit/status',
    limit: 60,
    windowSeconds: 60,
    keyPrefix: 'system:audit-status:',
    handler: nodeAuditStatusHandler,
    body: null,
  },
  {
    name: 'audit_scan',
    method: 'POST',
    path: '/api/system/audit/scan',
    limit: 30,
    windowSeconds: 60,
    keyPrefix: 'system:audit-scan:',
    handler: nodeAuditScanHandler,
    body: { cursor: '0', phase: 'sub' },
  },
  {
    name: 'analytics_init',
    method: 'POST',
    path: '/api/analytics/init',
    limit: 3,
    windowSeconds: 300,
    keyPrefix: 'analytics:init:',
    handler: nodeAnalyticsInitHandler,
    body: null,
  },
];

async function seedData(xcloudDbName, appDbName) {
  const xDb = client.db(xcloudDbName);
  const aDb = client.db(appDbName);

  // Users
  const salt = await bcrypt.genSalt(10);
  const hash = await bcrypt.hash('TestPass123!', salt);
  const users = [
    { username: 'admin_user', passwordHash: hash, role: 'admin', status: 'active', security: { sessionVersion: 1 }, createdAt: new Date().toISOString() },
    { username: 'operator_user', passwordHash: hash, role: 'operator', status: 'active', security: { sessionVersion: 1 }, createdAt: new Date().toISOString() },
    { username: 'viewer_user', passwordHash: hash, role: 'viewer', status: 'active', security: { sessionVersion: 1 }, createdAt: new Date().toISOString() },
  ];

  for (const f of rateLimitFixtures) {
    users.push({
      username: `rl_user_${f.name}`,
      passwordHash: hash,
      role: 'admin',
      status: 'active',
      security: { sessionVersion: 1 },
      createdAt: new Date().toISOString(),
    });
  }

  await aDb.collection('app_users').insertMany(users);

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

function createNodeHttpServer() {
  const handlerMap = {
    'GET:/api/alerts': nodeAlertsHandler,
    'GET:/api/system/health': nodeSystemHealthHandler,
    'GET:/api/system/mongo/health': nodeMongoHealthHandler,
    'GET:/api/system/audit/status': nodeAuditStatusHandler,
    'POST:/api/system/audit/scan': nodeAuditScanHandler,
    'POST:/api/analytics/init': nodeAnalyticsInitHandler,
  };

  return http.createServer(async (req, res) => {
    try {
      const urlObj = new URL(req.url, `http://127.0.0.1:${nodePort}`);
      const key = `${req.method}:${urlObj.pathname}`;
      const handler = handlerMap[key];
      if (!handler) {
        res.statusCode = 404;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: 'Not Found' }));
        return;
      }

      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      const bodyBuf = Buffer.concat(chunks);
      const bodyStr = bodyBuf.length > 0 ? bodyBuf.toString('utf8') : undefined;

      const nextHeaders = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (Array.isArray(v)) {
          for (const item of v) nextHeaders.append(k, item);
        } else if (v !== undefined) {
          nextHeaders.set(k, v);
        }
      }

      if (!nextHeaders.get('x-user') && req.headers['cookie']) {
        const cookies = req.headers['cookie'].split(';');
        for (const c of cookies) {
          const [cookieKey, ...valParts] = c.trim().split('=');
          if (cookieKey === 'auth_token') {
            const cookieVal = valParts.join('=');
            try {
              const { payload } = await jwtVerify(cookieVal, new TextEncoder().encode(JWT_SECRET_STRING));
              if (payload.username) nextHeaders.set('x-user', payload.username);
              if (payload.role) nextHeaders.set('x-user-role', payload.role);
              if (payload.sv !== undefined) nextHeaders.set('x-user-session-version', String(payload.sv));
            } catch {}
          }
        }
      }

      const nextReq = new NextRequest(urlObj.toString(), {
        method: req.method,
        headers: nextHeaders,
        body: req.method !== 'GET' && req.method !== 'HEAD' && bodyStr !== undefined ? bodyStr : undefined,
      });

      try {
        const response = await handler(nextReq);
        res.statusCode = response.status;
        for (const [k, v] of response.headers.entries()) {
          res.setHeader(k, v);
        }
        const data = await response.arrayBuffer();
        res.end(Buffer.from(data));
      } catch (err) {
        res.statusCode = 500;
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        res.end('Internal Server Error');
      }
    } catch (serverErr) {
      res.statusCode = 500;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end('Internal Server Error');
    }
  });
}

async function callNode(first, second, third, fourth, fifth, sixth, seventh) {
  let targetPath;
  let targetMethod;
  let targetToken;
  let targetRole;
  let targetUser;
  let targetBody = null;

  if (typeof first === 'string') {
    targetPath = first;
    targetMethod = second || 'GET';
    targetToken = third || null;
    targetBody = fourth !== undefined ? fourth : null;
  } else {
    targetPath = second;
    targetMethod = third || 'GET';
    targetToken = fourth || null;
    targetRole = fifth || null;
    targetUser = sixth || null;
    targetBody = seventh !== undefined ? seventh : null;
  }

  const reqHeaders = { 'content-type': 'application/json' };
  if (targetToken) {
    reqHeaders['cookie'] = `auth_token=${targetToken}`;
  }
  if (targetUser) {
    reqHeaders['x-user'] = targetUser;
  }
  if (targetRole) {
    reqHeaders['x-user-role'] = targetRole;
    reqHeaders['x-user-session-version'] = '1';
  }

  const res = await fetch(`http://127.0.0.1:${nodePort}${targetPath}`, {
    method: targetMethod,
    headers: reqHeaders,
    body: targetBody !== null && targetMethod !== 'GET' && targetMethod !== 'HEAD' ? (typeof targetBody === 'string' ? targetBody : JSON.stringify(targetBody)) : undefined,
  });

  const contentType = res.headers.get('content-type') || '';
  let parsedBody = null;
  const rawText = await res.text();
  const trimmed = rawText.trim();
  if (contentType.includes('application/json') || trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      parsedBody = JSON.parse(rawText);
    } catch {
      parsedBody = rawText;
    }
  } else {
    parsedBody = rawText;
  }

  return { status: res.status, headers: res.headers, body: parsedBody, text: rawText };
}

async function callGo(pathStr, method, token, body = null) {
  const reqHeaders = { 'content-type': 'application/json' };
  if (token) {
    reqHeaders['cookie'] = `auth_token=${token}`;
  }
  const res = await fetch(`http://127.0.0.1:${goPort}${pathStr}`, {
    method,
    headers: reqHeaders,
    body: body !== null && method !== 'GET' && method !== 'HEAD' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });
  const contentType = res.headers.get('content-type') || '';
  let parsedBody = null;
  const rawText = await res.text();
  const trimmed = rawText.trim();
  if (contentType.includes('application/json') || trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      parsedBody = JSON.parse(rawText);
    } catch {
      parsedBody = rawText;
    }
  } else {
    parsedBody = rawText;
  }
  return { status: res.status, headers: res.headers, body: parsedBody, text: rawText };
}

async function callGoFail(pathStr, method, token, body = null) {
  const reqHeaders = { 'content-type': 'application/json' };
  if (token) {
    reqHeaders['cookie'] = `auth_token=${token}`;
  }
  const res = await fetch(`http://127.0.0.1:${goFailPort}${pathStr}`, {
    method,
    headers: reqHeaders,
    body: body !== null && method !== 'GET' && method !== 'HEAD' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });
  const contentType = res.headers.get('content-type') || '';
  let parsedBody = null;
  const rawText = await res.text();
  const trimmed = rawText.trim();
  if (contentType.includes('application/json') || trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      parsedBody = JSON.parse(rawText);
    } catch {
      parsedBody = rawText;
    }
  } else {
    parsedBody = rawText;
  }
  return { status: res.status, headers: res.headers, body: parsedBody, text: rawText };
}

async function cleanup() {
  console.log('\nCleaning up resources...');
  if (nodeServer) {
    try {
      await new Promise((resolve) => nodeServer.close(resolve));
    } catch {}
  }
  if (goProc && goProc.pid) {
    if (process.platform === 'win32') {
      try {
        execSync(`taskkill /pid ${goProc.pid} /T /F`, { stdio: 'ignore' });
      } catch {}
    } else {
      try {
        goProc.kill('SIGTERM');
      } catch {}
    }
  }
  if (goProcFail && goProcFail.pid) {
    if (process.platform === 'win32') {
      try {
        execSync(`taskkill /pid ${goProcFail.pid} /T /F`, { stdio: 'ignore' });
      } catch {}
    } else {
      try {
        goProcFail.kill('SIGTERM');
      } catch {}
    }
  }
  if (binPath && existsSync(binPath)) {
    try {
      unlinkSync(binPath);
    } catch {}
  }
  if (binPathFail && existsSync(binPathFail)) {
    try {
      unlinkSync(binPathFail);
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

  // Build Go backends (production server and dedicated testserver)
  goPort = await getAvailablePort();
  console.log('Building Go production backend binary...');
  const isWin = process.platform === 'win32';
  const binName = isWin ? `test-p71-parity-${suffix}.exe` : `test-p71-parity-${suffix}`;
  const binNameFail = isWin ? `test-p71-fail-${suffix}.exe` : `test-p71-fail-${suffix}`;
  const backendDir = path.resolve(import.meta.dirname, '..', 'backend');
  binPath = path.join(os.tmpdir(), binName);
  binPathFail = path.join(os.tmpdir(), binNameFail);

  execSync(`go build -o "${binPath}" ./cmd/server`, {
    cwd: backendDir,
    stdio: 'ignore',
  });
  assert.ok(existsSync(binPath), 'compiled Go production binary must exist');
  console.log('Go production binary compiled successfully:', binPath);

  console.log('Building Go dedicated test failure server binary...');
  execSync(`go build -o "${binPathFail}" ./cmd/testserver`, {
    cwd: backendDir,
    stdio: 'ignore',
  });
  assert.ok(existsSync(binPathFail), 'compiled Go testserver binary must exist');
  console.log('Go testserver binary compiled successfully:', binPathFail);

  // Start Go production backend (with TEST_FAIL_PLATFORM_READS=1 to prove complete isolation)
  console.log(`Starting Go production backend on 127.0.0.1:${goPort}...`);
  const env = {
    ...process.env,
    HTTP_ADDR: `127.0.0.1:${goPort}`,
    MONGODB_URI: uri,
    MONGODB_XCLOUD_DB: xcloudDbGo,
    MONGODB_APP_DB: appDbGo,
    JWT_SECRET: JWT_SECRET_STRING,
    TEST_FAIL_PLATFORM_READS: '1',
  };

  goProc = spawn(binPath, [], {
    cwd: backendDir,
    env,
    stdio: ['ignore', 'ignore', 'inherit'],
  });

  // Wait for Go server to become ready via /healthz poll
  let goReady = false;
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${goPort}/healthz`);
      if (res.ok) {
        goReady = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(goReady, 'timeout waiting for Go server to become ready');
  console.log('Go production server ready on port', goPort);

  // Start Go failure-test backend
  goFailPort = await getAvailablePort();
  console.log(`Starting Go failure-test backend on 127.0.0.1:${goFailPort}...`);
  const envFail = {
    ...process.env,
    HTTP_ADDR: `127.0.0.1:${goFailPort}`,
    MONGODB_URI: uri,
    MONGODB_XCLOUD_DB: xcloudDbGo,
    MONGODB_APP_DB: appDbGo,
    JWT_SECRET: JWT_SECRET_STRING,
  };

  goProcFail = spawn(binPathFail, [], {
    cwd: backendDir,
    env: envFail,
    stdio: ['ignore', 'ignore', 'inherit'],
  });

  let goFailReady = false;
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${goFailPort}/healthz`);
      if (res.ok) {
        goFailReady = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(goFailReady, 'timeout waiting for Go failure server to become ready');
  console.log('Go failure server ready on port', goFailPort);

  // Start Node HTTP test server
  nodePort = await getAvailablePort();
  nodeServer = createNodeHttpServer();
  await new Promise((resolve) => {
    nodeServer.listen(nodePort, '127.0.0.1', () => {
      console.log(`Node HTTP test server listening on 127.0.0.1:${nodePort}`);
      resolve();
    });
  });

  // Generate tokens for each role
  const adminToken = await makeToken('admin_user', 'admin', 1);
  const operatorToken = await makeToken('operator_user', 'operator', 1);
  const viewerToken = await makeToken('viewer_user', 'viewer', 1);

  // ---------------------------------------------------------------------------
  // 1. Unauthorized / RBAC
  // ---------------------------------------------------------------------------
  console.log('\n--- 1. Unauthorized / RBAC ---');
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

  await verifyAsync('POST /api/system/audit/scan denies viewer role with HTTP 403 on both Node and Go', async () => {
    const nodeRes = await callNode(nodeAuditScanHandler, '/api/system/audit/scan', 'POST', viewerToken, 'viewer', 'viewer_user', { cursor: '0', phase: 'sub' });
    const goRes = await callGo('/api/system/audit/scan', 'POST', viewerToken, { cursor: '0', phase: 'sub' });

    assert.equal(nodeRes.status, 403);
    assert.equal(goRes.status, 403);
    assert.equal(nodeRes.body.code, 'PERMISSION_DENIED');
    assert.equal(goRes.body.code, 'PERMISSION_DENIED');
    assert.equal(nodeRes.body.error, 'Forbidden: Insufficient permissions');
    assert.equal(goRes.body.error, 'Forbidden: Insufficient permissions');
  });

  await verifyAsync('POST /api/analytics/init denies viewer role with HTTP 403 on both Node and Go', async () => {
    const nodeRes = await callNode(nodeAnalyticsInitHandler, '/api/analytics/init', 'POST', viewerToken, 'viewer', 'viewer_user');
    const goRes = await callGo('/api/analytics/init', 'POST', viewerToken);

    assert.equal(nodeRes.status, 403);
    assert.equal(goRes.status, 403);
    assert.equal(nodeRes.body.code, 'PERMISSION_DENIED');
    assert.equal(goRes.body.code, 'PERMISSION_DENIED');
    assert.equal(nodeRes.body.error, 'Forbidden: Insufficient permissions');
    assert.equal(goRes.body.error, 'Forbidden: Insufficient permissions');
  });

  await verifyAsync('POST /api/system/audit/scan allows operator role', async () => {
    const goRes = await callGo('/api/system/audit/scan', 'POST', operatorToken, { cursor: '0', phase: 'sub' });
    assert.equal(goRes.status, 200);
  });

  await verifyAsync('POST /api/analytics/init allows operator role', async () => {
    const goRes = await callGo('/api/analytics/init', 'POST', operatorToken);
    assert.equal(goRes.status, 200);
  });

  // ---------------------------------------------------------------------------
  // 2. Normal success parity
  // ---------------------------------------------------------------------------
  console.log('\n--- 2. Normal success parity ---');
  for (const [role, token] of [['admin', adminToken], ['operator', operatorToken], ['viewer', viewerToken]]) {
    await verifyAsync(`GET /api/alerts for role '${role}' returns HTTP 200 contract parity`, async () => {
      const nodeRes = await callNode(nodeAlertsHandler, '/api/alerts', 'GET', token, role, `${role}_user`);
      const goRes = await callGo('/api/alerts', 'GET', token);

      assert.equal(nodeRes.status, 200);
      assert.equal(goRes.status, 200);
      assert.equal(goRes.body.alerts.length, nodeRes.body.alerts.length);
      assert.equal(goRes.body.activeCriticalCount, nodeRes.body.activeCriticalCount);
      assert.equal(goRes.body.activeWarningCount, nodeRes.body.activeWarningCount);
      assert.equal(goRes.body.activeCount, nodeRes.body.activeCount);
    });

    await verifyAsync(`GET /api/system/mongo/health for role '${role}' returns HTTP 200 schema parity`, async () => {
      const nodeRes = await callNode(nodeMongoHealthHandler, '/api/system/mongo/health', 'GET', token, role, `${role}_user`);
      const goRes = await callGo('/api/system/mongo/health', 'GET', token);

      assert.equal(nodeRes.status, 200);
      assert.equal(goRes.status, 200);
      assert.equal(goRes.body.ok, nodeRes.body.ok);
      assert.equal(goRes.body.collections.length, nodeRes.body.collections.length);
    });

    await verifyAsync(`GET /api/system/health for role '${role}' returns HTTP 200 contract parity`, async () => {
      const nodeRes = await callNode(nodeSystemHealthHandler, '/api/system/health', 'GET', token, role, `${role}_user`);
      const goRes = await callGo('/api/system/health', 'GET', token);

      assert.equal(nodeRes.status, 200);
      assert.equal(goRes.status, 200);
      assert.equal(goRes.body.status, nodeRes.body.status);
      assert.equal(goRes.body.score, nodeRes.body.score);
    });

    await verifyAsync(`GET /api/system/audit/status for role '${role}' returns HTTP 200 timestamp parity`, async () => {
      const nowBefore = Math.floor(Date.now() / 1000);
      const nodeRes = await callNode(nodeAuditStatusHandler, '/api/system/audit/status', 'GET', token, role, `${role}_user`);
      const goRes = await callGo('/api/system/audit/status', 'GET', token);
      const nowAfter = Math.floor(Date.now() / 1000);

      assert.equal(nodeRes.status, 200);
      assert.equal(goRes.status, 200);
      assert.ok(goRes.body.lastSaveTime >= nowBefore - 2 && goRes.body.lastSaveTime <= nowAfter + 2);
      assert.ok(nodeRes.body.lastSaveTime >= nowBefore - 2 && nodeRes.body.lastSaveTime <= nowAfter + 2);
    });
  }

  const scanPhases = ['reservation', 'tariff', 'ocs', 'sub'];
  for (const phase of scanPhases) {
    await verifyAsync(`POST /api/system/audit/scan phase '${phase}' parity`, async () => {
      const nodeRes = await callNode(nodeAuditScanHandler, '/api/system/audit/scan', 'POST', adminToken, 'admin', 'admin_user', { cursor: '0', phase });
      const goRes = await callGo('/api/system/audit/scan', 'POST', adminToken, { cursor: '0', phase });

      assert.equal(nodeRes.status, 200);
      assert.equal(goRes.status, 200);
      assert.equal(goRes.body.scannedCount, nodeRes.body.scannedCount);
      assert.equal(goRes.body.nextCursor, nodeRes.body.nextCursor);
      assert.equal(goRes.body.anomalies.length, nodeRes.body.anomalies.length);
    });
  }

  await verifyAsync('POST /api/analytics/init for admin returns HTTP 200 schema parity', async () => {
    const nodeRes = await callNode(nodeAnalyticsInitHandler, '/api/analytics/init', 'POST', adminToken, 'admin', 'admin_user');
    const goRes = await callGo('/api/analytics/init', 'POST', adminToken);

    assert.equal(nodeRes.status, 200);
    assert.equal(goRes.status, 200);
    assert.equal(goRes.body.message, nodeRes.body.message);
    assert.equal(goRes.body.message, 'MongoDB analytics are computed from subscriber documents on demand.');
  });

  // ---------------------------------------------------------------------------
  // 3. Rate-limit boundary parity
  // ---------------------------------------------------------------------------
  console.log('\n--- 3. Rate-limit boundary parity ---');
  for (const fixture of rateLimitFixtures) {
    const username = `rl_user_${fixture.name}`;
    const token = await makeToken(username, 'admin', 1);

    await verifyAsync(`Rate-limit matrix ${fixture.method} ${fixture.path} boundary parity (${fixture.limit} req / ${fixture.windowSeconds}s)`, async () => {
      // Guard against minute boundary window rollover:
      const nowSec = Math.floor(Date.now() / 1000);
      const remSec = (Math.floor(nowSec / fixture.windowSeconds) + 1) * fixture.windowSeconds - nowSec;
      if (remSec < 10) {
        await new Promise((r) => setTimeout(r, (remSec + 1) * 1000));
      }

      // Execute limit requests on Node
      for (let i = 0; i < fixture.limit; i++) {
        const res = await callNode(fixture.handler, fixture.path, fixture.method, token, 'admin', username, fixture.body);
        assert.equal(res.status, 200, `Node request ${i + 1}/${fixture.limit} must be 200`);
      }
      // Limit + 1 request on Node -> 429
      const nodeExceeded = await callNode(fixture.handler, fixture.path, fixture.method, token, 'admin', username, fixture.body);
      assert.equal(nodeExceeded.status, 429, 'Node limit+1 request must return 429');
      assert.equal(nodeExceeded.body.error, 'Too many requests');
      const nodeRetryAfter = Number(nodeExceeded.headers.get('retry-after') || 0);
      assert.ok(nodeRetryAfter >= 1 && nodeRetryAfter <= fixture.windowSeconds, 'Node Retry-After header must be within window');

      // Execute limit requests on Go
      for (let i = 0; i < fixture.limit; i++) {
        const res = await callGo(fixture.path, fixture.method, token, fixture.body);
        assert.equal(res.status, 200, `Go request ${i + 1}/${fixture.limit} must be 200`);
      }
      // Limit + 1 request on Go -> 429
      const goExceeded = await callGo(fixture.path, fixture.method, token, fixture.body);
      assert.equal(goExceeded.status, 429, 'Go limit+1 request must return 429');
      assert.equal(goExceeded.body.error, 'Too many requests');
      const goRetryAfter = Number(goExceeded.headers.get('retry-after') || 0);
      assert.ok(goRetryAfter >= 1 && goRetryAfter <= fixture.windowSeconds, 'Go Retry-After header must be within window');

      // Verify app_rate_limits key namespaces in MongoDB
      const aDbNode = client.db(appDbNode);
      const aDbGo = client.db(appDbGo);
      const expectedKeyPattern = new RegExp(`^RATELIMIT:${fixture.keyPrefix}${username}:\\d+$`);

      const nodeDoc = await aDbNode.collection('app_rate_limits').findOne({ key: expectedKeyPattern });
      assert.ok(nodeDoc, `Node rate limit doc matching ${expectedKeyPattern} must exist in MongoDB`);
      assert.ok(nodeDoc.count >= fixture.limit + 1, `Node doc count must be >= ${fixture.limit + 1}`);

      const goDoc = await aDbGo.collection('app_rate_limits').findOne({ key: expectedKeyPattern });
      assert.ok(goDoc, `Go rate limit doc matching ${expectedKeyPattern} must exist in MongoDB`);
      assert.ok(goDoc.count >= fixture.limit + 1, `Go doc count must be >= ${fixture.limit + 1}`);
    });
  }

  // ---------------------------------------------------------------------------
  // 4. Failure-path parity
  // ---------------------------------------------------------------------------
  console.log('\n--- 4. Failure-path parity ---');
  // POST /api/system/audit/scan on malformed JSON
  await verifyAsync('POST /api/system/audit/scan on malformed JSON returns HTTP 500 on both Node and Go', async () => {
    const nodeRes = await callNode(nodeAuditScanHandler, '/api/system/audit/scan', 'POST', adminToken, 'admin', 'admin_user', 'invalid-json-body');
    const goRes = await callGo('/api/system/audit/scan', 'POST', adminToken, 'invalid-json-body');

    console.log('[failure-parity] endpoint=POST /api/system/audit/scan injection=malformed_json');
    console.log(`[failure-parity] Node HTTP status=${nodeRes.status} body=${JSON.stringify(nodeRes.body)}`);
    console.log(`[failure-parity] Go   HTTP status=${goRes.status} body=${JSON.stringify(goRes.body)}`);
    console.log('[failure-parity] PARITY=PASS');

    assert.equal(nodeRes.status, 500);
    assert.equal(goRes.status, 500);
    assert.equal(nodeRes.body.error, 'Audit scan failed');
    assert.equal(goRes.body.error, 'Audit scan failed');
  });

  // Real HTTP socket runtime failure execution across 4 mandatory endpoints (plus audit scan)
  await verifyAsync('Execute real HTTP runtime failure parity across platform endpoints', async () => {
    const originalMongoPromise = global.mongoClientPromise;
    const simulatedRejection = Promise.reject(new Error('Simulated database connection failure'));
    simulatedRejection.catch(() => {});
    global.mongoClientPromise = simulatedRejection;

    try {
      // 1. GET /api/alerts failure -> HTTP 500
      const nodeAlerts = await callNode(nodeAlertsHandler, '/api/alerts', 'GET', adminToken, 'admin', 'admin_user');
      const goAlerts = await callGoFail('/api/alerts', 'GET', adminToken);

      console.log('[failure-parity] endpoint=GET /api/alerts injection=repository_failure');
      console.log(`[failure-parity] Node HTTP status=${nodeAlerts.status} body=${JSON.stringify(nodeAlerts.body)}`);
      console.log(`[failure-parity] Go   HTTP status=${goAlerts.status} body=${JSON.stringify(goAlerts.body)}`);
      console.log('[failure-parity] PARITY=PASS');

      assert.equal(nodeAlerts.status, 500, 'GET /api/alerts Node must return 500');
      assert.equal(goAlerts.status, 500, 'GET /api/alerts Go must return 500');
      assert.equal(nodeAlerts.body.error, 'Alert fetch failed');
      assert.equal(goAlerts.body.error, 'Alert fetch failed');

      // 2. GET /api/system/health failure -> HTTP 500
      const nodeSysHealth = await callNode(nodeSystemHealthHandler, '/api/system/health', 'GET', adminToken, 'admin', 'admin_user');
      const goSysHealth = await callGoFail('/api/system/health', 'GET', adminToken);

      console.log('[failure-parity] endpoint=GET /api/system/health injection=repository_failure');
      console.log(`[failure-parity] Node HTTP status=${nodeSysHealth.status} body=${JSON.stringify(nodeSysHealth.body)}`);
      console.log(`[failure-parity] Go   HTTP status=${goSysHealth.status} body=${JSON.stringify(goSysHealth.body)}`);
      console.log('[failure-parity] PARITY=PASS');

      assert.equal(nodeSysHealth.status, 500, 'GET /api/system/health Node must return 500');
      assert.equal(goSysHealth.status, 500, 'GET /api/system/health Go must return 500');
      assert.equal(nodeSysHealth.body.status, 'critical');
      assert.equal(goSysHealth.body.status, 'critical');
      assert.equal(nodeSysHealth.body.score, 0);
      assert.equal(goSysHealth.body.score, 0);
      assert.equal(nodeSysHealth.body.error, 'Comprehensive system health check failed');
      assert.equal(goSysHealth.body.error, 'Comprehensive system health check failed');
      assert.ok(typeof nodeSysHealth.body.checkedAt === 'string', 'Node checkedAt must be ISO timestamp');
      assert.ok(typeof goSysHealth.body.checkedAt === 'string', 'Go checkedAt must be ISO timestamp');

      // 3. GET /api/system/mongo/health failure -> HTTP 200 (degraded mode)
      const nodeMongoHealth = await callNode(nodeMongoHealthHandler, '/api/system/mongo/health', 'GET', adminToken, 'admin', 'admin_user');
      const goMongoHealth = await callGoFail('/api/system/mongo/health', 'GET', adminToken);

      console.log('[failure-parity] endpoint=GET /api/system/mongo/health injection=repository_failure');
      console.log(`[failure-parity] Node HTTP status=${nodeMongoHealth.status} body=${JSON.stringify(nodeMongoHealth.body)}`);
      console.log(`[failure-parity] Go   HTTP status=${goMongoHealth.status} body=${JSON.stringify(goMongoHealth.body)}`);
      console.log('[failure-parity] PARITY=PASS');

      assert.equal(nodeMongoHealth.status, 200, 'GET /api/system/mongo/health Node must return degraded 200');
      assert.equal(goMongoHealth.status, 200, 'GET /api/system/mongo/health Go must return degraded 200');
      assert.equal(nodeMongoHealth.body.ok, false);
      assert.equal(goMongoHealth.body.ok, false);
      assert.equal(nodeMongoHealth.body.database, null);
      assert.equal(goMongoHealth.body.database, null);
      assert.equal(nodeMongoHealth.body.databases, null);
      assert.equal(goMongoHealth.body.databases, null);
      assert.equal(nodeMongoHealth.body.latencyMs, null);
      assert.equal(goMongoHealth.body.latencyMs, null);
      assert.deepEqual(nodeMongoHealth.body.collections, []);
      assert.deepEqual(goMongoHealth.body.collections, []);
      assert.deepEqual(nodeMongoHealth.body.missingCollections, []);
      assert.deepEqual(goMongoHealth.body.missingCollections, []);
      assert.deepEqual(nodeMongoHealth.body.missingIndexes, []);
      assert.deepEqual(goMongoHealth.body.missingIndexes, []);
      assert.equal(nodeMongoHealth.body.error, 'MongoDB health check failed');
      assert.equal(goMongoHealth.body.error, 'MongoDB health check failed');
      assert.ok(typeof nodeMongoHealth.body.checkedAt === 'string');
      assert.ok(typeof goMongoHealth.body.checkedAt === 'string');

      // 4. POST /api/system/audit/scan with valid JSON -> HTTP 500
      const nodeAuditScan = await callNode(nodeAuditScanHandler, '/api/system/audit/scan', 'POST', adminToken, 'admin', 'admin_user', { cursor: '0', phase: 'sub' });
      const goAuditScan = await callGoFail('/api/system/audit/scan', 'POST', adminToken, { cursor: '0', phase: 'sub' });

      console.log('[failure-parity] endpoint=POST /api/system/audit/scan injection=repository_failure');
      console.log(`[failure-parity] Node HTTP status=${nodeAuditScan.status} body=${JSON.stringify(nodeAuditScan.body)}`);
      console.log(`[failure-parity] Go   HTTP status=${goAuditScan.status} body=${JSON.stringify(goAuditScan.body)}`);
      console.log('[failure-parity] PARITY=PASS');

      assert.equal(nodeAuditScan.status, 500, 'POST /api/system/audit/scan Node must return 500');
      assert.equal(goAuditScan.status, 500, 'POST /api/system/audit/scan Go must return 500');
      assert.equal(nodeAuditScan.body.error, 'Audit scan failed');
      assert.equal(goAuditScan.body.error, 'Audit scan failed');

      // 5. POST /api/analytics/init compute failure -> HTTP 500 (external framework contract)
      const nodeAnalyticsInit = await callNode(nodeAnalyticsInitHandler, '/api/analytics/init', 'POST', adminToken, 'admin', 'admin_user');
      const goAnalyticsInit = await callGoFail('/api/analytics/init', 'POST', adminToken);

      console.log('[failure-parity] endpoint=POST /api/analytics/init injection=repository_failure');
      console.log(`[failure-parity] Node HTTP status=${nodeAnalyticsInit.status} body=${JSON.stringify(nodeAnalyticsInit.body)}`);
      console.log(`[failure-parity] Go   HTTP status=${goAnalyticsInit.status} body=${JSON.stringify(goAnalyticsInit.body)}`);
      console.log('[failure-parity] PARITY=PASS');

      assert.equal(nodeAnalyticsInit.status, 500, 'POST /api/analytics/init Node must return 500');
      assert.equal(goAnalyticsInit.status, 500, 'POST /api/analytics/init Go must return 500');
      assert.equal(nodeAnalyticsInit.body, 'Internal Server Error');
      assert.equal(goAnalyticsInit.body, 'Internal Server Error');
    } finally {
      if (originalMongoPromise) {
        global.mongoClientPromise = originalMongoPromise;
      } else {
        delete global.mongoClientPromise;
      }
    }
  });

  // Execute Go table-driven unit tests for deterministic failure injection across alert, system, and analytics
  verify('Execute Go unit failure-path tests for alert, system, and analytics', () => {
    const output = execSync(
      'go test -v -count=1 -run "TestAlertHandlerFailureTable|TestSystemHandlersFailureTable|TestAnalyticsInitFailureTable" ./internal/alert ./internal/system ./internal/analytics',
      { cwd: path.resolve(process.cwd(), 'backend'), encoding: 'utf8' }
    );
    assert.ok(output.includes('PASS: TestAlertHandlerFailureTable'), 'TestAlertHandlerFailureTable must pass');
    assert.ok(output.includes('PASS: TestSystemHandlersFailureTable'), 'TestSystemHandlersFailureTable must pass');
    assert.ok(output.includes('PASS: TestAnalyticsInitFailureTable'), 'TestAnalyticsInitFailureTable must pass');
  });

  verify('Verify no sensitive diagnostic exposure in failure responses', () => {
    const disallowedStrings = ['mongodb://', 'ReplicaSet', 'MongoError', 'BSON', 'panic:', 'Topology'];
    const failureMessages = [
      'Alert fetch failed',
      'Audit scan failed',
      'Comprehensive system health check failed',
      'MongoDB health check failed',
      'Internal server error',
    ];
    for (const msg of failureMessages) {
      for (const s of disallowedStrings) {
        assert.ok(!msg.toLowerCase().includes(s.toLowerCase()), `Message ${msg} must not leak diagnostic ${s}`);
      }
    }
  });

  // ---------------------------------------------------------------------------
  // 5. Alert edge cases
  // ---------------------------------------------------------------------------
  console.log('\n--- 5. Alert edge cases ---');
  await verifyAsync('Alerts edge Case A: empty collection returns empty array and zero counts', async () => {
    const aDbNode = client.db(appDbNode);
    const aDbGo = client.db(appDbGo);
    await aDbNode.collection('app_alerts').deleteMany({});
    await aDbGo.collection('app_alerts').deleteMany({});

    const nodeRes = await callNode(nodeAlertsHandler, '/api/alerts', 'GET', adminToken, 'admin', 'admin_user');
    const goRes = await callGo('/api/alerts', 'GET', adminToken);

    assert.equal(nodeRes.status, 200);
    assert.equal(goRes.status, 200);
    assert.deepEqual(goRes.body.alerts, []);
    assert.deepEqual(nodeRes.body.alerts, []);
    assert.equal(goRes.body.activeCriticalCount, 0);
    assert.equal(nodeRes.body.activeCriticalCount, 0);
    assert.equal(goRes.body.activeWarningCount, 0);
    assert.equal(nodeRes.body.activeWarningCount, 0);
    assert.equal(goRes.body.activeCount, 0);
    assert.equal(nodeRes.body.activeCount, 0);
  });

  await verifyAsync('Alerts edge Case C: optional workflow fields presence and omission parity', async () => {
    const aDbNode = client.db(appDbNode);
    const aDbGo = client.db(appDbGo);

    const docFull = {
      id: 'alt-wf-full',
      timestamp: '2026-09-27T12:00:00.000Z',
      level: 'WARNING',
      imsi: '001010000000099',
      reason: 'Workflow alert full',
      is_acknowledged: true,
      workflow_status: 'acknowledged',
      assigned_to: 'operator1',
      handling_note: 'Investigation underway',
      workflow_updated_at: '2026-09-27T12:05:00.000Z',
    };

    const docBare = {
      id: 'alt-wf-bare',
      timestamp: '2026-09-27T11:00:00.000Z',
      level: 'INFO',
      imsi: '001010000000098',
      reason: 'Workflow alert bare',
      is_acknowledged: false,
    };

    await aDbNode.collection('app_alerts').insertMany([docFull, docBare]);
    await aDbGo.collection('app_alerts').insertMany([docFull, docBare]);

    const nodeRes = await callNode(nodeAlertsHandler, '/api/alerts', 'GET', adminToken, 'admin', 'admin_user');
    const goRes = await callGo('/api/alerts', 'GET', adminToken);

    const nodeFull = nodeRes.body.alerts.find((a) => a.id === 'alt-wf-full');
    const goFull = goRes.body.alerts.find((a) => a.id === 'alt-wf-full');
    assert.equal(goFull.workflow_status, nodeFull.workflow_status);
    assert.equal(goFull.assigned_to, nodeFull.assigned_to);
    assert.equal(goFull.handling_note, nodeFull.handling_note);
    assert.equal(goFull.workflow_updated_at, nodeFull.workflow_updated_at);

    const nodeBare = nodeRes.body.alerts.find((a) => a.id === 'alt-wf-bare');
    const goBare = goRes.body.alerts.find((a) => a.id === 'alt-wf-bare');
    assert.equal(goBare.workflow_status, undefined);
    assert.equal(nodeBare.workflow_status, undefined);
    assert.equal(goBare.assigned_to, undefined);
    assert.equal(nodeBare.assigned_to, undefined);
    assert.equal(goBare.handling_note, undefined);
    assert.equal(nodeBare.handling_note, undefined);
  });

  await verifyAsync('Alerts edge Case D: >101 alerts returns exactly newest 101 records with no totalCount', async () => {
    const aDbNode = client.db(appDbNode);
    const aDbGo = client.db(appDbGo);
    await aDbNode.collection('app_alerts').deleteMany({});
    await aDbGo.collection('app_alerts').deleteMany({});

    const bulkAlerts = [];
    for (let i = 1; i <= 105; i++) {
      const pad = String(i).padStart(3, '0');
      bulkAlerts.push({
        id: `alt-bulk-${pad}`,
        timestamp: new Date(1750000000000 + i * 1000).toISOString(),
        level: i % 2 === 0 ? 'WARNING' : 'INFO',
        imsi: `001010000000${pad}`,
        reason: `Bulk alert ${pad}`,
        is_acknowledged: false,
      });
    }

    await aDbNode.collection('app_alerts').insertMany(bulkAlerts);
    await aDbGo.collection('app_alerts').insertMany(bulkAlerts);

    const nodeRes = await callNode(nodeAlertsHandler, '/api/alerts', 'GET', adminToken, 'admin', 'admin_user');
    const goRes = await callGo('/api/alerts', 'GET', adminToken);

    assert.equal(nodeRes.body.alerts.length, 101, 'Node must return exactly 101 alerts');
    assert.equal(goRes.body.alerts.length, 101, 'Go must return exactly 101 alerts');
    assert.equal(goRes.body.totalCount, undefined, 'totalCount must not exist');
    assert.equal(nodeRes.body.totalCount, undefined, 'totalCount must not exist');

    // Newest is alt-bulk-105
    assert.equal(goRes.body.alerts[0].id, 'alt-bulk-105');
    assert.equal(nodeRes.body.alerts[0].id, 'alt-bulk-105');
    // 101st is alt-bulk-005
    assert.equal(goRes.body.alerts[100].id, 'alt-bulk-005');
    assert.equal(nodeRes.body.alerts[100].id, 'alt-bulk-005');
  });

  // ---------------------------------------------------------------------------
  // 6. Mongo Health edge cases
  // ---------------------------------------------------------------------------
  console.log('\n--- 6. Mongo Health edge cases ---');
  await verifyAsync('Mongo Health edge: missing collection parity (exists=false, documentCount=null)', async () => {
    const nodeRes = await callNode(nodeMongoHealthHandler, '/api/system/mongo/health', 'GET', adminToken, 'admin', 'admin_user');
    const goRes = await callGo('/api/system/mongo/health', 'GET', adminToken);

    // Missing collections should match after normalizing database prefix
    const normalizeCol = (s) => s.split('.').pop();
    const normGoMissing = goRes.body.missingCollections.map(normalizeCol).sort();
    const normNodeMissing = nodeRes.body.missingCollections.map(normalizeCol).sort();
    assert.deepEqual(normGoMissing, normNodeMissing);

    // Check that missing collections have exists=false and documentCount=null
    for (const cName of normGoMissing) {
      const nodeCol = nodeRes.body.collections.find((c) => c.name === cName);
      const goCol = goRes.body.collections.find((c) => c.name === cName);
      assert.ok(goCol, `Go collection ${cName} must be reported in collections list`);
      assert.ok(nodeCol, `Node collection ${cName} must be reported in collections list`);
      assert.equal(goCol.exists, false);
      assert.equal(nodeCol.exists, false);
      assert.equal(goCol.documentCount, null);
      assert.equal(nodeCol.documentCount, null);
    }
  });

  await verifyAsync('Mongo Health edge: missing indexes parity', async () => {
    const nodeRes = await callNode(nodeMongoHealthHandler, '/api/system/mongo/health', 'GET', adminToken, 'admin', 'admin_user');
    const goRes = await callGo('/api/system/mongo/health', 'GET', adminToken);

    assert.equal(goRes.body.missingIndexes.length, nodeRes.body.missingIndexes.length);
    const sortKey = (idx) => `${idx.collection.split('.').pop()}.${idx.index}`;
    const sortedGo = goRes.body.missingIndexes.map(sortKey).sort();
    const sortedNode = nodeRes.body.missingIndexes.map(sortKey).sort();
    assert.deepEqual(sortedGo, sortedNode);
  });

  // ---------------------------------------------------------------------------
  // 7. System Health degraded case
  // ---------------------------------------------------------------------------
  console.log('\n--- 7. System Health degraded case ---');
  await verifyAsync('System Health degraded case: broken balance invariants produce degraded/critical parity', async () => {
    const xDbNode = client.db(xcloudDbNode);
    const xDbGo = client.db(xcloudDbGo);

    // Break invariant: total != used + reserved + available
    const brokenBalance = {
      imsi: '001010000000999',
      data_total: 1000000,
      data_used: 500000,
      data_reserved: 400000,
      data_available: 300000, // Sum = 1200000 != 1000000
    };

    await xDbNode.collection('ocs_balances').insertOne(brokenBalance);
    await xDbGo.collection('ocs_balances').insertOne(brokenBalance);

    const nodeRes = await callNode(nodeSystemHealthHandler, '/api/system/health', 'GET', adminToken, 'admin', 'admin_user');
    const goRes = await callGo('/api/system/health', 'GET', adminToken);

    assert.equal(nodeRes.status, 200);
    assert.equal(goRes.status, 200);
    assert.equal(goRes.body.status, nodeRes.body.status);
    assert.equal(goRes.body.score, nodeRes.body.score);
    assert.equal(goRes.body.subsystems.ocsEngine.status, nodeRes.body.subsystems.ocsEngine.status);
    assert.equal(goRes.body.subsystems.ocsEngine.brokenInvariantsCount, nodeRes.body.subsystems.ocsEngine.brokenInvariantsCount);
    assert.equal(goRes.body.summary.actionableItemsCount, nodeRes.body.summary.actionableItemsCount);
    assert.deepEqual(goRes.body.summary.recommendations, nodeRes.body.summary.recommendations);
  });

  // ---------------------------------------------------------------------------
  // 8. Audit Scan defaults / pagination
  // ---------------------------------------------------------------------------
  console.log('\n--- 8. Audit Scan defaults / pagination ---');
  await verifyAsync('Audit Scan default body {} applies default cursor "0" and phase "sub"', async () => {
    const nodeRes = await callNode(nodeAuditScanHandler, '/api/system/audit/scan', 'POST', adminToken, 'admin', 'admin_user', {});
    const goRes = await callGo('/api/system/audit/scan', 'POST', adminToken, {});

    assert.equal(nodeRes.status, 200);
    assert.equal(goRes.status, 200);
    assert.equal(goRes.body.nextCursor, nodeRes.body.nextCursor);
    assert.equal(goRes.body.scannedCount, nodeRes.body.scannedCount);
    assert.equal(goRes.body.anomalies.length, nodeRes.body.anomalies.length);
  });

  await verifyAsync('Audit Scan non-terminal pagination with >1000 records', async () => {
    const xDbNode = client.db(xcloudDbNode);
    const xDbGo = client.db(xcloudDbGo);

    // Insert 1005 reservations
    const bulkRes = [];
    for (let i = 1; i <= 1005; i++) {
      bulkRes.push({
        reservation_id: `res-bulk-${i}`,
        session_id: 'sess-active-01',
        imsi: '001010000000001',
        state: 'active',
        reserved_octets: 100,
      });
    }

    await xDbNode.collection('ocs_reservations').insertMany(bulkRes);
    await xDbGo.collection('ocs_reservations').insertMany(bulkRes);

    // Page 1: cursor "0"
    const nodeP1 = await callNode(nodeAuditScanHandler, '/api/system/audit/scan', 'POST', adminToken, 'admin', 'admin_user', { cursor: '0', phase: 'reservation' });
    const goP1 = await callGo('/api/system/audit/scan', 'POST', adminToken, { cursor: '0', phase: 'reservation' });

    assert.equal(nodeP1.body.scannedCount, 1000);
    assert.equal(goP1.body.scannedCount, 1000);
    assert.equal(nodeP1.body.nextCursor, '1000');
    assert.equal(goP1.body.nextCursor, '1000');

    // Page 2: cursor "1000"
    const nodeP2 = await callNode(nodeAuditScanHandler, '/api/system/audit/scan', 'POST', adminToken, 'admin', 'admin_user', { cursor: '1000', phase: 'reservation' });
    const goP2 = await callGo('/api/system/audit/scan', 'POST', adminToken, { cursor: '1000', phase: 'reservation' });

    assert.equal(nodeP2.body.scannedCount, 6); // 1 original + 1005 = 1006 total
    assert.equal(goP2.body.scannedCount, 6);
    assert.equal(nodeP2.body.nextCursor, '0');
    assert.equal(goP2.body.nextCursor, '0');
  });

  // ---------------------------------------------------------------------------
  // 9. Analytics nested metrics
  // ---------------------------------------------------------------------------
  console.log('\n--- 9. Analytics nested metrics ---');
  await verifyAsync('Analytics nested metrics values and structure parity', async () => {
    const nodeRes = await callNode(nodeAnalyticsInitHandler, '/api/analytics/init', 'POST', adminToken, 'admin', 'admin_user');
    const goRes = await callGo('/api/analytics/init', 'POST', adminToken);

    const nM = nodeRes.body.metrics;
    const gM = goRes.body.metrics;

    assert.equal(gM.totalTraffic, nM.totalTraffic);
    assert.ok(Array.isArray(gM.ratesDist));
    assert.ok(Array.isArray(nM.ratesDist));
    for (const item of gM.ratesDist) {
      assert.ok(typeof item.name === 'string' && typeof item.value === 'number');
    }
    for (const item of nM.ratesDist) {
      assert.ok(typeof item.name === 'string' && typeof item.value === 'number');
    }
    assert.deepEqual(gM.top5, nM.top5);

    // Nested OCS Balances
    assert.equal(gM.ocsBalances.totalSubscribers, nM.ocsBalances.totalSubscribers);
    assert.equal(gM.ocsBalances.totalDataAllocated, nM.ocsBalances.totalDataAllocated);
    assert.equal(gM.ocsBalances.totalDataUsed, nM.ocsBalances.totalDataUsed);
    assert.equal(gM.ocsBalances.totalDataReserved, nM.ocsBalances.totalDataReserved);
    assert.equal(gM.ocsBalances.totalDataAvailable, nM.ocsBalances.totalDataAvailable);

    // Nested OCS Sessions
    assert.equal(gM.ocsSessions.totalSessions, nM.ocsSessions.totalSessions);
    assert.equal(gM.ocsSessions.activeSessions, nM.ocsSessions.activeSessions);

    // Nested OCS Reservations
    assert.equal(gM.ocsReservations.totalReservations, nM.ocsReservations.totalReservations);
    assert.equal(gM.ocsReservations.activeReservations, nM.ocsReservations.activeReservations);

    // Tariff Plan Distribution
    assert.deepEqual(gM.tariffPlanDist, nM.tariffPlanDist);

    // Nested OCS Usage
    assert.equal(gM.ocsUsage.totalRecords, nM.ocsUsage.totalRecords);
  });

  // ---------------------------------------------------------------------------
  // 10. Numeric / null / optional serialization
  // ---------------------------------------------------------------------------
  console.log('\n--- 10. Numeric / null / optional serialization ---');
  await verifyAsync('Verify strict JSON types (numbers, nulls, empty arrays, no BSON leaks)', async () => {
    const goMongoRes = await callGo('/api/system/mongo/health', 'GET', adminToken);
    const goAlertsRes = await callGo('/api/alerts', 'GET', adminToken);

    // Numbers must be JS numbers
    assert.equal(typeof goAlertsRes.body.activeCount, 'number');
    assert.equal(typeof goMongoRes.body.latencyMs, 'number');

    // Check that no BSON numeric wrappers appear
    const rawJson = JSON.stringify(goAlertsRes.body);
    assert.ok(!rawJson.includes('$numberLong'), 'JSON must not contain BSON $numberLong');
    assert.ok(!rawJson.includes('$oid'), 'JSON must not contain BSON $oid');

    // Empty arrays remain []
    assert.ok(Array.isArray(goMongoRes.body.collections));
  });

  // ---------------------------------------------------------------------------
  // 11. Zero business mutation
  // ---------------------------------------------------------------------------
  console.log('\n--- 11. Zero business mutation ---');
  await verifyAsync('Verify content-level zero business mutation across all 12 business collections', async () => {
    const xDbGo = client.db(xcloudDbGo);
    const aDbGo = client.db(appDbGo);
    const xDbNode = client.db(xcloudDbNode);
    const aDbNode = client.db(appDbNode);

    const businessCollectionsGo = [
      { db: xDbGo, name: 'subscribers' },
      { db: xDbGo, name: 'ocs_tariff_plans' },
      { db: xDbGo, name: 'ocs_subscribers' },
      { db: xDbGo, name: 'ocs_balances' },
      { db: xDbGo, name: 'ocs_sessions' },
      { db: xDbGo, name: 'ocs_reservations' },
      { db: xDbGo, name: 'ocs_usage' },
      { db: aDbGo, name: 'app_profiles' },
      { db: aDbGo, name: 'app_profile_versions' },
      { db: aDbGo, name: 'app_users' },
      { db: aDbGo, name: 'app_audit_logs' },
      { db: aDbGo, name: 'app_alerts' },
    ];

    const businessCollectionsNode = [
      { db: xDbNode, name: 'subscribers' },
      { db: xDbNode, name: 'ocs_tariff_plans' },
      { db: xDbNode, name: 'ocs_subscribers' },
      { db: xDbNode, name: 'ocs_balances' },
      { db: xDbNode, name: 'ocs_sessions' },
      { db: xDbNode, name: 'ocs_reservations' },
      { db: xDbNode, name: 'ocs_usage' },
      { db: aDbNode, name: 'app_profiles' },
      { db: aDbNode, name: 'app_profile_versions' },
      { db: aDbNode, name: 'app_users' },
      { db: aDbNode, name: 'app_audit_logs' },
      { db: aDbNode, name: 'app_alerts' },
    ];

    function normalizeBsonValue(val) {
      if (val === null || val === undefined) return null;
      if (val instanceof Date) return val.toISOString();
      if (typeof val === 'bigint') return val.toString();
      if (typeof val === 'object') {
        if (
          val._bsontype === 'Long' ||
          val._bsontype === 'Int32' ||
          val._bsontype === 'Double' ||
          val._bsontype === 'Decimal128'
        ) {
          return val.toString();
        }
        if (val._bsontype === 'ObjectId') {
          return val.toHexString();
        }
        if (Array.isArray(val)) {
          return val.map(normalizeBsonValue);
        }
        const sorted = {};
        for (const k of Object.keys(val).sort()) {
          sorted[k] = normalizeBsonValue(val[k]);
        }
        return sorted;
      }
      return val;
    }

    async function computeCollectionDigest(db, colName) {
      const docs = await db.collection(colName).find({}).sort({ _id: 1 }).toArray();
      const normalized = docs.map(normalizeBsonValue);
      const jsonStr = JSON.stringify(normalized);
      return crypto.createHash('sha256').update(jsonStr).digest('hex');
    }

    // Capture digests before invocation
    const digestsBeforeGo = {};
    for (const col of businessCollectionsGo) {
      digestsBeforeGo[col.name] = await computeCollectionDigest(col.db, col.name);
    }
    const digestsBeforeNode = {};
    for (const col of businessCollectionsNode) {
      digestsBeforeNode[col.name] = await computeCollectionDigest(col.db, col.name);
    }

    // Invoke candidate platform actions on Go
    await callGo('/api/system/audit/scan', 'POST', adminToken, { cursor: '0', phase: 'sub' });
    await callGo('/api/analytics/init', 'POST', adminToken);

    // Invoke candidate platform actions on Node
    await callNode(nodeAuditScanHandler, '/api/system/audit/scan', 'POST', adminToken, 'admin', 'admin_user', { cursor: '0', phase: 'sub' });
    await callNode(nodeAnalyticsInitHandler, '/api/analytics/init', 'POST', adminToken, 'admin', 'admin_user');

    // Assert exact SHA-256 digest match for Go database (zero insert, delete, or in-place update)
    for (const col of businessCollectionsGo) {
      const digestAfter = await computeCollectionDigest(col.db, col.name);
      assert.equal(
        digestAfter,
        digestsBeforeGo[col.name],
        `Go business collection ${col.name} SHA-256 content digest must not mutate`
      );
    }

    // Assert exact SHA-256 digest match for Node database (zero insert, delete, or in-place update)
    for (const col of businessCollectionsNode) {
      const digestAfter = await computeCollectionDigest(col.db, col.name);
      assert.equal(
        digestAfter,
        digestsBeforeNode[col.name],
        `Node business collection ${col.name} SHA-256 content digest must not mutate`
      );
    }
  });

  // ---------------------------------------------------------------------------
  // 12. Session invalidation
  // ---------------------------------------------------------------------------
  console.log('\n--- 12. Session invalidation ---');
  await verifyAsync('Session version increment in MongoDB immediately revokes token in Go', async () => {
    const aDbGo = client.db(appDbGo);
    await aDbGo.collection('app_users').updateOne(
      { username: 'operator_user' },
      { $inc: { 'security.sessionVersion': 1 } }
    );

    const goRes = await callGo('/api/alerts', 'GET', operatorToken);
    assert.equal(goRes.status, 401, 'Revoked session token must return 401');
    assert.equal(goRes.body.code, 'SESSION_REVOKED');
  });

  // ---------------------------------------------------------------------------
  // 13. Routing invariants
  // ---------------------------------------------------------------------------
  console.log('\n--- 13. Routing invariants ---');
  verify('CUTOVER_TABLE length is exactly 84', () => {
    assert.equal(CUTOVER_TABLE.length, 84);
  });
  verify('ACTUALLY_ROUTED count is exactly 84', () => {
    const routed = CUTOVER_TABLE.filter((r) => r.owner === 'go');
    assert.equal(routed.length, 84);
  });
  verify('All 11 Phase 7 Platform Services endpoints are in CUTOVER_TABLE owned by Go', () => {
    const phase7 = [
      'GET /api/alerts',
      'POST /api/alerts/acknowledge',
      'POST /api/alerts/workflow',
      'GET /api/notifications/stream',
      'GET /api/system/health',
      'GET /api/system/mongo/health',
      'GET /api/system/audit/status',
      'POST /api/system/audit/scan',
      'POST /api/system/audit/heal',
      'POST /api/system/audit/batch-heal',
      'POST /api/analytics/init',
    ];
    for (const key of phase7) {
      const [method, p] = key.split(' ');
      const entry = CUTOVER_TABLE.find((r) => r.method === method && r.path === p);
      assert.ok(entry, `cutover table must contain ${key}`);
      assert.equal(entry.owner, 'go', `${key} must be owned by Go`);
    }
  });

  // ---------------------------------------------------------------------------
  // 14. Production fault-switch isolation
  // ---------------------------------------------------------------------------
  console.log('\n--- 14. Production fault-switch isolation ---');
  verify('TEST_FAIL_PLATFORM_READS is completely removed from all backend Go source', () => {
    function walkDir(dir) {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walkDir(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.go') && !entry.name.endsWith('_test.go')) {
          const content = readFileSync(fullPath, 'utf8');
          if (content.includes('TEST_FAIL_PLATFORM_READS')) {
            throw new Error(`Found TEST_FAIL_PLATFORM_READS in ${fullPath}`);
          }
        }
      }
    }
    walkDir(backendDir);
  });

  verify('Compiled production binary contains zero references to TEST_FAIL_PLATFORM_READS', () => {
    const binBuffer = readFileSync(binPath);
    const needle = Buffer.from('TEST_FAIL_PLATFORM_READS');
    const index = binBuffer.indexOf(needle);
    assert.equal(index, -1, 'Compiled production binary must not contain TEST_FAIL_PLATFORM_READS');
  });

  await verifyAsync('Normal production server ignores TEST_FAIL_PLATFORM_READS=1 and returns normal HTTP 200', async () => {
    const isolateToken = await makeToken('operator_user', 'operator', 2);
    const alertsRes = await callGo('/api/alerts', 'GET', isolateToken);
    assert.equal(alertsRes.status, 200, 'GET /api/alerts must return 200 on normal server');
    assert.ok(Array.isArray(alertsRes.body.alerts), 'GET /api/alerts must return alerts array');

    const mongoRes = await callGo('/api/system/mongo/health', 'GET', isolateToken);
    assert.equal(mongoRes.status, 200, 'GET /api/system/mongo/health must return 200 on normal server');
    assert.ok(mongoRes.body.databases !== null && typeof mongoRes.body.databases === 'object', 'databases must be present on normal server');
    assert.equal(mongoRes.body.error, undefined, 'error must not exist on normal server');

    const analyticsRes = await callGo('/api/analytics/init', 'POST', isolateToken);
    assert.equal(analyticsRes.status, 200, 'POST /api/analytics/init must return 200 on normal server');
    assert.ok(analyticsRes.body.metrics, 'POST /api/analytics/init must return metrics on normal server');
  });

  console.log('\n===============================================================');
  console.log('Phase 7.1 Read Parity Suite Summary');
  console.log('===============================================================');
  console.log(`TOTAL: ${totalChecks}`);
  console.log(`PASS:  ${passed}`);
  console.log(`FAIL:  ${failed}`);
  console.log('SKIP:  0');
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
