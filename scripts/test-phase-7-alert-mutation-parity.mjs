#!/usr/bin/env node
/**
 * Phase 7.2 - Alert Domain Governance & Mutation Shadow Parity Integration Suite
 *
 * Runs Node and Go Alert Mutation implementations against isolated
 * MongoDB test databases and verifies exact 1:1 parity across:
 * 1. Authentication & RBAC Parity (unauthorized, viewer 403, operator/admin 200, sessionVersion invalidation)
 * 2. Rate-Limiting Boundary Parity (acknowledge 60/60s, workflow 120/60s)
 * 3. Alert Acknowledge Mutation Parity (single, batch, dedup, trim, 200 boundary, idempotent, not-found)
 * 4. Alert Workflow Mutation Parity (status validation, case/whitespace, ID validation, field cleaning, 404)
 * 5. Best-Effort Audit Log Evidence & Schema Failure Resilience
 * 6. Database Error Failure-Path Parity (HTTP 500 error messages)
 * 7. Zero Unrelated Business Domain Mutation
 * 8. Routing Invariants & Freeze Verification (CUTOVER_TABLE=36, ACTUALLY_ROUTED=36)
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { existsSync, unlinkSync, readFileSync } from 'node:fs';
import { execSync, spawn } from 'node:child_process';
import { SignJWT, jwtVerify } from 'jose';
import { MongoClient } from 'mongodb';
import { createJiti } from 'jiti';
import nextEnv from '@next/env';
import bcrypt from 'bcryptjs';

nextEnv.loadEnvConfig(process.cwd());

const originalConsoleError = console.error;
console.error = (...args) => {
  if (
    typeof args[0] === 'string' &&
    (args[0].includes('Alert acknowledge error') ||
      args[0].includes('Alert workflow update error') ||
      args[0].includes('Audit logging failed') ||
      args[0].includes('Rate limiter MongoDB error'))
  ) {
    return;
  }
  originalConsoleError(...args);
};

const suffix = `${Date.now()}_${process.pid}_${Math.floor(Math.random() * 100000)}`;
const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/xcloud';

// Isolated DB pairs
const xcloudDbNode = `xcloud_p72_node_${suffix}`;
const appDbNode = `xcloud_ops_p72_node_${suffix}`;
const xcloudDbGo = `xcloud_p72_go_${suffix}`;
const appDbGo = `xcloud_ops_p72_go_${suffix}`;

const JWT_SECRET_STRING = 'alert-mutation-parity-secret-32b!';
process.env.JWT_SECRET = JWT_SECRET_STRING;

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
const { POST: nodeAlertAcknowledgeHandler } = jiti('../frontend/src/app/api/alerts/acknowledge/route.ts');
const { POST: nodeAlertWorkflowHandler } = jiti('../frontend/src/app/api/alerts/workflow/route.ts');
const { validateCurrentAccount, AccountSessionError } = jiti('../frontend/src/lib/accountSession.ts');
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

async function seedData(xcloudDbName, appDbName) {
  const xDb = client.db(xcloudDbName);
  const aDb = client.db(appDbName);

  const salt = await bcrypt.genSalt(10);
  const hash = await bcrypt.hash('TestPass123!', salt);
  const users = [
    { username: 'admin_user', passwordHash: hash, role: 'admin', status: 'active', security: { sessionVersion: 1 }, createdAt: new Date().toISOString() },
    { username: 'operator_user', passwordHash: hash, role: 'operator', status: 'active', security: { sessionVersion: 1 }, createdAt: new Date().toISOString() },
    { username: 'viewer_user', passwordHash: hash, role: 'viewer', status: 'active', security: { sessionVersion: 1 }, createdAt: new Date().toISOString() },
    { username: 'disabled_user', passwordHash: hash, role: 'operator', status: 'disabled', security: { sessionVersion: 1 }, createdAt: new Date().toISOString() },
    { username: 'rl_ack_user', passwordHash: hash, role: 'operator', status: 'active', security: { sessionVersion: 1 }, createdAt: new Date().toISOString() },
    { username: 'rl_wf_user', passwordHash: hash, role: 'operator', status: 'active', security: { sessionVersion: 1 }, createdAt: new Date().toISOString() },
  ];

  await aDb.collection('app_users').insertMany(users);

  // Initial alerts fixture
  const initialAlerts = [
    {
      id: 'alt-001',
      timestamp: '2026-09-28T10:00:00.000Z',
      level: 'CRITICAL',
      imsi: '001010000000001',
      reason: 'High CPU core temperature',
      is_acknowledged: false,
    },
    {
      id: 'alt-002',
      timestamp: '2026-09-28T09:00:00.000Z',
      level: 'WARNING',
      imsi: '001010000000002',
      reason: 'Disk space warning',
      is_acknowledged: false,
    },
    {
      id: 'alt-003',
      timestamp: '2026-09-28T08:00:00.000Z',
      level: 'INFO',
      imsi: '001010000000003',
      reason: 'Periodic health heartbeat',
      is_acknowledged: true,
    },
    {
      id: 'alt-004',
      timestamp: '2026-09-28T07:00:00.000Z',
      level: 'WARNING',
      imsi: '001010000000004',
      reason: 'BGP flap',
      is_acknowledged: false,
    },
    {
      id: 'alt-005',
      timestamp: '2026-09-28T06:00:00.000Z',
      level: 'CRITICAL',
      imsi: '001010000000005',
      reason: 'Packet drop rate anomaly',
      is_acknowledged: false,
    },
    {
      id: 'alt-wf-1',
      timestamp: '2026-09-28T05:00:00.000Z',
      level: 'CRITICAL',
      imsi: '001010000000006',
      reason: 'Signaling storm',
      is_acknowledged: false,
      workflow_status: 'acknowledged',
      assigned_to: 'engineer_a',
      handling_note: 'initial investigation',
    },
  ];

  await aDb.collection('app_alerts').insertMany(initialAlerts);

  // Unrelated collections to prove zero side-effects
  await xDb.collection('subscribers').insertOne({
    imsi: '001010000000001',
    profile: 'default',
  });
  await xDb.collection('ocs_tariff_plans').insertOne({
    plan_id: 'default-standard',
    name: 'Standard Tariff Plan',
  });
  await xDb.collection('ocs_balances').insertOne({
    imsi: '001010000000001',
    data_total: 1000000,
  });
  await xDb.collection('ocs_subscribers').insertOne({
    imsi: '001010000000001',
    plan_id: 'default-standard',
  });
  await xDb.collection('ocs_sessions').insertOne({
    session_id: 'sess-001',
    state: 'active',
  });
  await xDb.collection('ocs_reservations').insertOne({
    reservation_id: 'res-001',
    session_id: 'sess-001',
  });
  await aDb.collection('app_profiles').insertOne({
    name: 'default',
    created_at: new Date().toISOString(),
  });
}

function createNodeHttpServer() {
  const handlerMap = {
    'POST:/api/alerts/acknowledge': nodeAlertAcknowledgeHandler,
    'POST:/api/alerts/workflow': nodeAlertWorkflowHandler,
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

      if (req.headers['cookie']) {
        const cookies = req.headers['cookie'].split(';');
        for (const c of cookies) {
          const [cookieKey, ...valParts] = c.trim().split('=');
          if (cookieKey === 'auth_token') {
            const cookieVal = valParts.join('=');
            try {
              const { payload } = await jwtVerify(cookieVal, new TextEncoder().encode(JWT_SECRET_STRING));
              const account = await validateCurrentAccount({ username: payload.username, role: payload.role, sv: payload.sv });
              nextHeaders.set('x-user', account.username);
              nextHeaders.set('x-user-role', account.role);
              nextHeaders.set('x-user-id', account.userId);
              nextHeaders.set('x-user-session-version', String(account.sessionVersion));
            } catch (authErr) {
              const code = authErr instanceof AccountSessionError ? authErr.code : 'AUTH_INVALID_TOKEN';
              res.statusCode = 401;
              res.setHeader('content-type', 'application/json');
              res.end(JSON.stringify({ error: 'Unauthorized', code }));
              return;
            }
          }
        }
      }

      const nextReq = new NextRequest(urlObj.toString(), {
        method: req.method,
        headers: nextHeaders,
        body: bodyStr !== undefined ? bodyStr : undefined,
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

async function callNode(pathStr, method, token, body = null, extraHeaders = {}) {
  const reqHeaders = { 'content-type': 'application/json', ...extraHeaders };
  if (token) {
    reqHeaders['cookie'] = `auth_token=${token}`;
  }

  const res = await fetch(`http://127.0.0.1:${nodePort}${pathStr}`, {
    method,
    headers: reqHeaders,
    body: body !== null ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
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

async function callGo(pathStr, method, token, body = null, extraHeaders = {}) {
  const reqHeaders = { 'content-type': 'application/json', ...extraHeaders };
  if (token) {
    reqHeaders['cookie'] = `auth_token=${token}`;
  }
  const res = await fetch(`http://127.0.0.1:${goPort}${pathStr}`, {
    method,
    headers: reqHeaders,
    body: body !== null ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
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
    body: body !== null ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
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

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

async function main() {
  console.log('========================================================================');
  console.log('Phase 7.2 - Alert Domain Governance & Mutation Shadow Parity Test Suite');
  console.log('========================================================================\n');

  await client.connect();
  console.log('Connected to MongoDB at', uri);

  console.log('Seeding Node test databases:', xcloudDbNode, appDbNode);
  await seedData(xcloudDbNode, appDbNode);
  console.log('Seeding Go test databases:', xcloudDbGo, appDbGo);
  await seedData(xcloudDbGo, appDbGo);

  goPort = await getAvailablePort();
  const isWin = process.platform === 'win32';
  const binName = isWin ? `test-p72-parity-${suffix}.exe` : `test-p72-parity-${suffix}`;
  const binNameFail = isWin ? `test-p72-fail-${suffix}.exe` : `test-p72-fail-${suffix}`;
  const backendDir = path.resolve(import.meta.dirname, '..', 'backend');
  binPath = path.join(os.tmpdir(), binName);
  binPathFail = path.join(os.tmpdir(), binNameFail);

  console.log('Building Go production backend binary...');
  execSync(`go build -o "${binPath}" ./cmd/server`, {
    cwd: backendDir,
    stdio: 'ignore',
  });
  assert.ok(existsSync(binPath), 'compiled Go production binary must exist');

  console.log('Building Go testserver failure binary...');
  execSync(`go build -o "${binPathFail}" ./cmd/testserver`, {
    cwd: backendDir,
    stdio: 'ignore',
  });
  assert.ok(existsSync(binPathFail), 'compiled Go testserver binary must exist');

  console.log(`Starting Go backend on 127.0.0.1:${goPort}...`);
  goProc = spawn(binPath, [], {
    cwd: backendDir,
    env: {
      ...process.env,
      HTTP_ADDR: `127.0.0.1:${goPort}`,
      MONGODB_URI: uri,
      MONGODB_XCLOUD_DB: xcloudDbGo,
      MONGODB_APP_DB: appDbGo,
      JWT_SECRET: JWT_SECRET_STRING,
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });

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
  assert.ok(goReady, 'Go backend must be ready on /healthz');

  goFailPort = await getAvailablePort();
  console.log(`Starting Go testserver on 127.0.0.1:${goFailPort}...`);
  goProcFail = spawn(binPathFail, [], {
    cwd: backendDir,
    env: {
      ...process.env,
      HTTP_ADDR: `127.0.0.1:${goFailPort}`,
      MONGODB_URI: uri,
      MONGODB_XCLOUD_DB: xcloudDbGo,
      MONGODB_APP_DB: appDbGo,
      JWT_SECRET: JWT_SECRET_STRING,
    },
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
  assert.ok(goFailReady, 'Go testserver must be ready on /healthz');

  nodePort = await getAvailablePort();
  console.log(`Starting Node test server on 127.0.0.1:${nodePort}...`);
  nodeServer = createNodeHttpServer();
  await new Promise((resolve) => nodeServer.listen(nodePort, '127.0.0.1', resolve));

  const adminToken = await makeToken('admin_user', 'admin', 1);
  const operatorToken = await makeToken('operator_user', 'operator', 1);
  const viewerToken = await makeToken('viewer_user', 'viewer', 1);
  const expiredToken = await makeToken('operator_user', 'operator', 1, -3600);
  const invalidSvToken = await makeToken('operator_user', 'operator', 99);
  const disabledToken = await makeToken('disabled_user', 'operator', 1);

  console.log('\n--- Section 1: Authentication & Authorization Parity ---');

  for (const endpoint of ['/api/alerts/acknowledge', '/api/alerts/workflow']) {
    const dummyBody = endpoint.includes('acknowledge') ? { id: 'alt-001' } : { id: 'alt-wf-1', status: 'assigned' };

    // 1.1 No token -> 401
    await verifyAsync(`${endpoint}: no token returns 401`, async () => {
      const nodeRes = await callNode(endpoint, 'POST', null, dummyBody);
      const goRes = await callGo(endpoint, 'POST', null, dummyBody);
      assert.equal(nodeRes.status, 401);
      assert.equal(goRes.status, 401);
      assert.equal(nodeRes.body.error, 'Unauthorized');
      assert.equal(goRes.body.error, 'Unauthorized');
      assert.equal(nodeRes.body.code, 'AUTH_INVALID_TOKEN');
      assert.equal(goRes.body.code, 'AUTH_INVALID_TOKEN');
    });

    // 1.2 Expired token -> 401
    await verifyAsync(`${endpoint}: expired token returns 401`, async () => {
      const nodeRes = await callNode(endpoint, 'POST', expiredToken, dummyBody);
      const goRes = await callGo(endpoint, 'POST', expiredToken, dummyBody);
      assert.equal(nodeRes.status, 401);
      assert.equal(goRes.status, 401);
      assert.equal(nodeRes.body.code, 'AUTH_INVALID_TOKEN');
      assert.equal(goRes.body.code, 'AUTH_INVALID_TOKEN');
    });

    // 1.3 Session version mismatch -> 401
    await verifyAsync(`${endpoint}: sessionVersion mismatch returns 401`, async () => {
      const nodeRes = await callNode(endpoint, 'POST', invalidSvToken, dummyBody);
      const goRes = await callGo(endpoint, 'POST', invalidSvToken, dummyBody);
      assert.equal(nodeRes.status, 401);
      assert.equal(goRes.status, 401);
      assert.equal(nodeRes.body.code, 'SESSION_REVOKED');
      assert.equal(goRes.body.code, 'SESSION_REVOKED');
    });

    // 1.4 Disabled user -> 401
    await verifyAsync(`${endpoint}: disabled user returns 401`, async () => {
      const nodeRes = await callNode(endpoint, 'POST', disabledToken, dummyBody);
      const goRes = await callGo(endpoint, 'POST', disabledToken, dummyBody);
      assert.equal(nodeRes.status, 401);
      assert.equal(goRes.status, 401);
      assert.equal(nodeRes.body.code, 'ACCOUNT_DISABLED');
      assert.equal(goRes.body.code, 'ACCOUNT_DISABLED');
    });

    // 1.5 Viewer role -> 403 Forbidden
    await verifyAsync(`${endpoint}: viewer role returns 403`, async () => {
      const nodeRes = await callNode(endpoint, 'POST', viewerToken, dummyBody);
      const goRes = await callGo(endpoint, 'POST', viewerToken, dummyBody);
      assert.equal(nodeRes.status, 403);
      assert.equal(goRes.status, 403);
      assert.equal(nodeRes.body.error, 'Forbidden: Insufficient permissions');
      assert.equal(goRes.body.error, 'Forbidden: Insufficient permissions');
      assert.equal(nodeRes.body.code, 'PERMISSION_DENIED');
      assert.equal(goRes.body.code, 'PERMISSION_DENIED');
    });
  }

  console.log('\n--- Section 2: Rate Limiting Boundary Parity ---');

  // 2.1 Acknowledge rate limit: 60/60s
  await verifyAsync('POST /api/alerts/acknowledge rate limit boundary (60 req/60s)', async () => {
    const rlAckToken = await makeToken('rl_ack_user', 'operator', 1);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const currentWindow = Math.floor(nowSeconds / 60);
    const keyAck = `RATELIMIT:alerts:acknowledge:rl_ack_user:${currentWindow}`;
    const resetAtTime = new Date((currentWindow + 1) * 60 * 1000);

    await client.db(appDbNode).collection('app_rate_limits').insertOne({
      key: keyAck,
      count: 60,
      reset_at: resetAtTime,
      updated_at: new Date(),
    });
    await client.db(appDbGo).collection('app_rate_limits').insertOne({
      key: keyAck,
      count: 60,
      reset_at: resetAtTime,
      updated_at: new Date(),
    });

    const nodeRes = await callNode('/api/alerts/acknowledge', 'POST', rlAckToken, { id: 'alt-001' });
    const goRes = await callGo('/api/alerts/acknowledge', 'POST', rlAckToken, { id: 'alt-001' });
    assert.equal(nodeRes.status, 429);
    assert.equal(goRes.status, 429);
    assert.equal(nodeRes.body.error, 'Too many requests');
    assert.equal(goRes.body.error, 'Too many requests');
    assert.equal(nodeRes.headers.get('x-ratelimit-limit'), '60');
    assert.equal(goRes.headers.get('x-ratelimit-limit'), '60');
    assert.ok(Number(nodeRes.headers.get('retry-after')) >= 1);
    assert.ok(Number(goRes.headers.get('retry-after')) >= 1);
  });

  // 2.2 Workflow rate limit: 120/60s
  await verifyAsync('POST /api/alerts/workflow rate limit boundary (120 req/60s)', async () => {
    const rlWfToken = await makeToken('rl_wf_user', 'operator', 1);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const currentWindow = Math.floor(nowSeconds / 60);
    const keyWf = `RATELIMIT:alerts:workflow:rl_wf_user:${currentWindow}`;
    const resetAtTime = new Date((currentWindow + 1) * 60 * 1000);

    await client.db(appDbNode).collection('app_rate_limits').insertOne({
      key: keyWf,
      count: 120,
      reset_at: resetAtTime,
      updated_at: new Date(),
    });
    await client.db(appDbGo).collection('app_rate_limits').insertOne({
      key: keyWf,
      count: 120,
      reset_at: resetAtTime,
      updated_at: new Date(),
    });

    const nodeRes = await callNode('/api/alerts/workflow', 'POST', rlWfToken, { id: 'alt-wf-1', status: 'assigned' });
    const goRes = await callGo('/api/alerts/workflow', 'POST', rlWfToken, { id: 'alt-wf-1', status: 'assigned' });
    assert.equal(nodeRes.status, 429);
    assert.equal(goRes.status, 429);
    assert.equal(nodeRes.body.error, 'Too many requests');
    assert.equal(goRes.body.error, 'Too many requests');
    assert.equal(nodeRes.headers.get('x-ratelimit-limit'), '120');
    assert.equal(goRes.headers.get('x-ratelimit-limit'), '120');
    assert.ok(Number(nodeRes.headers.get('retry-after')) >= 1);
    assert.ok(Number(goRes.headers.get('retry-after')) >= 1);
  });

  console.log('\n--- Section 3: Alert Acknowledge Mutation Parity ---');

  // 3.1 Validation: Empty ID
  await verifyAsync('POST /api/alerts/acknowledge: empty body returns 400', async () => {
    const nodeRes = await callNode('/api/alerts/acknowledge', 'POST', operatorToken, {});
    const goRes = await callGo('/api/alerts/acknowledge', 'POST', operatorToken, {});
    assert.equal(nodeRes.status, 400);
    assert.equal(goRes.status, 400);
    assert.deepEqual(nodeRes.body, { error: 'Alert ID(s) required' });
    assert.deepEqual(goRes.body, { error: 'Alert ID(s) required' });
  });

  await verifyAsync('POST /api/alerts/acknowledge: whitespace-only id returns 400', async () => {
    const nodeRes = await callNode('/api/alerts/acknowledge', 'POST', operatorToken, { id: '   ' });
    const goRes = await callGo('/api/alerts/acknowledge', 'POST', operatorToken, { id: '   ' });
    assert.equal(nodeRes.status, 400);
    assert.equal(goRes.status, 400);
    assert.deepEqual(nodeRes.body, { error: 'Alert ID(s) required' });
    assert.deepEqual(goRes.body, { error: 'Alert ID(s) required' });
  });

  await verifyAsync('POST /api/alerts/acknowledge: empty ids array returns 400', async () => {
    const nodeRes = await callNode('/api/alerts/acknowledge', 'POST', operatorToken, { ids: [] });
    const goRes = await callGo('/api/alerts/acknowledge', 'POST', operatorToken, { ids: [] });
    assert.equal(nodeRes.status, 400);
    assert.equal(goRes.status, 400);
    assert.deepEqual(nodeRes.body, { error: 'Alert ID(s) required' });
    assert.deepEqual(goRes.body, { error: 'Alert ID(s) required' });
  });

  // 3.2 Validation: >200 IDs
  await verifyAsync('POST /api/alerts/acknowledge: >200 IDs returns 400', async () => {
    const largeIds = Array.from({ length: 201 }, (_, i) => `alert-bulk-${i}`);
    const nodeRes = await callNode('/api/alerts/acknowledge', 'POST', operatorToken, { ids: largeIds });
    const goRes = await callGo('/api/alerts/acknowledge', 'POST', operatorToken, { ids: largeIds });
    assert.equal(nodeRes.status, 400);
    assert.equal(goRes.status, 400);
    assert.deepEqual(nodeRes.body, { error: 'At most 200 alerts can be acknowledged at once' });
    assert.deepEqual(goRes.body, { error: 'At most 200 alerts can be acknowledged at once' });
  });

  // 3.3 Single Alert Acknowledge (alt-001)
  await verifyAsync('POST /api/alerts/acknowledge: single alert acknowledge (alt-001)', async () => {
    const nodeRes = await callNode('/api/alerts/acknowledge', 'POST', operatorToken, { id: 'alt-001' });
    const goRes = await callGo('/api/alerts/acknowledge', 'POST', operatorToken, { id: 'alt-001' });
    assert.equal(nodeRes.status, 200);
    assert.equal(goRes.status, 200);
    assert.deepEqual(nodeRes.body, { success: true, acknowledged: 1, requested: 1, skipped: 0 });
    assert.deepEqual(goRes.body, { success: true, acknowledged: 1, requested: 1, skipped: 0 });

    // Verify DB state
    const nodeDoc = await client.db(appDbNode).collection('app_alerts').findOne({ id: 'alt-001' });
    const goDoc = await client.db(appDbGo).collection('app_alerts').findOne({ id: 'alt-001' });
    assert.equal(nodeDoc.is_acknowledged, true);
    assert.equal(goDoc.is_acknowledged, true);
  });

  // 3.4 Idempotency: Re-acknowledging alt-001 yields skipped: 1
  await verifyAsync('POST /api/alerts/acknowledge: already acknowledged alert yields skipped: 1', async () => {
    const nodeRes = await callNode('/api/alerts/acknowledge', 'POST', operatorToken, { id: 'alt-001' });
    const goRes = await callGo('/api/alerts/acknowledge', 'POST', operatorToken, { id: 'alt-001' });
    assert.equal(nodeRes.status, 200);
    assert.equal(goRes.status, 200);
    assert.deepEqual(nodeRes.body, { success: true, acknowledged: 0, requested: 1, skipped: 1 });
    assert.deepEqual(goRes.body, { success: true, acknowledged: 0, requested: 1, skipped: 1 });
  });

  // 3.5 Batch with trimming and deduplication: [" alt-002 ", "alt-002", "alt-003", "alt-missing"]
  await verifyAsync('POST /api/alerts/acknowledge: batch with trim, dedup, and missing IDs', async () => {
    const payload = { ids: [' alt-002 ', 'alt-002', 'alt-003', 'alt-missing'] };
    // alt-002 is unacknowledged -> acked: 1
    // alt-003 is already acked -> skipped
    // alt-missing does not exist -> skipped
    // total requested after trim & dedup = 3 (alt-002, alt-003, alt-missing)
    const nodeRes = await callNode('/api/alerts/acknowledge', 'POST', operatorToken, payload);
    const goRes = await callGo('/api/alerts/acknowledge', 'POST', operatorToken, payload);
    assert.equal(nodeRes.status, 200);
    assert.equal(goRes.status, 200);
    assert.deepEqual(nodeRes.body, { success: true, acknowledged: 1, requested: 3, skipped: 2 });
    assert.deepEqual(goRes.body, { success: true, acknowledged: 1, requested: 3, skipped: 2 });
  });

  // 3.6 Non-existent ID only
  await verifyAsync('POST /api/alerts/acknowledge: non-existent ID yields acknowledged: 0', async () => {
    const nodeRes = await callNode('/api/alerts/acknowledge', 'POST', operatorToken, { id: 'ghost-alert' });
    const goRes = await callGo('/api/alerts/acknowledge', 'POST', operatorToken, { id: 'ghost-alert' });
    assert.equal(nodeRes.status, 200);
    assert.equal(goRes.status, 200);
    assert.deepEqual(nodeRes.body, { success: true, acknowledged: 0, requested: 1, skipped: 1 });
    assert.deepEqual(goRes.body, { success: true, acknowledged: 0, requested: 1, skipped: 1 });
  });

  // 3.7 Malformed JSON
  await verifyAsync('POST /api/alerts/acknowledge: malformed JSON returns 500', async () => {
    const nodeRes = await callNode('/api/alerts/acknowledge', 'POST', operatorToken, '{invalid-json');
    const goRes = await callGo('/api/alerts/acknowledge', 'POST', operatorToken, '{invalid-json');
    assert.equal(nodeRes.status, 500);
    assert.equal(goRes.status, 500);
    assert.deepEqual(nodeRes.body, { error: 'Failed to acknowledge alert' });
    assert.deepEqual(goRes.body, { error: 'Failed to acknowledge alert' });
  });

  // 3.8 Null JSON
  await verifyAsync('POST /api/alerts/acknowledge: null JSON returns 500', async () => {
    const nodeRes = await callNode('/api/alerts/acknowledge', 'POST', operatorToken, 'null');
    const goRes = await callGo('/api/alerts/acknowledge', 'POST', operatorToken, 'null');
    assert.equal(nodeRes.status, 500);
    assert.equal(goRes.status, 500);
    assert.deepEqual(nodeRes.body, { error: 'Failed to acknowledge alert' });
    assert.deepEqual(goRes.body, { error: 'Failed to acknowledge alert' });
  });

  console.log('\n--- Section 4: Alert Workflow Mutation Parity ---');

  // 4.1 Validation: Missing ID
  await verifyAsync('POST /api/alerts/workflow: missing id returns 400', async () => {
    const nodeRes = await callNode('/api/alerts/workflow', 'POST', operatorToken, { status: 'assigned' });
    const goRes = await callGo('/api/alerts/workflow', 'POST', operatorToken, { status: 'assigned' });
    assert.equal(nodeRes.status, 400);
    assert.equal(goRes.status, 400);
    assert.deepEqual(nodeRes.body, { error: 'Alert ID required' });
    assert.deepEqual(goRes.body, { error: 'Alert ID required' });
  });

  await verifyAsync('POST /api/alerts/workflow: whitespace-only id returns 400', async () => {
    const nodeRes = await callNode('/api/alerts/workflow', 'POST', operatorToken, { id: '   ', status: 'assigned' });
    const goRes = await callGo('/api/alerts/workflow', 'POST', operatorToken, { id: '   ', status: 'assigned' });
    assert.equal(nodeRes.status, 400);
    assert.equal(goRes.status, 400);
    assert.deepEqual(nodeRes.body, { error: 'Alert ID required' });
    assert.deepEqual(goRes.body, { error: 'Alert ID required' });
  });

  // 4.2 Validation: ID checked before status
  await verifyAsync('POST /api/alerts/workflow: id checked before status when both invalid', async () => {
    const nodeRes = await callNode('/api/alerts/workflow', 'POST', operatorToken, { id: '   ', status: 'invalid_status' });
    const goRes = await callGo('/api/alerts/workflow', 'POST', operatorToken, { id: '   ', status: 'invalid_status' });
    assert.equal(nodeRes.status, 400);
    assert.equal(goRes.status, 400);
    assert.deepEqual(nodeRes.body, { error: 'Alert ID required' });
    assert.deepEqual(goRes.body, { error: 'Alert ID required' });
  });

  // 4.3 Validation: Status invalid
  await verifyAsync('POST /api/alerts/workflow: invalid status returns 400', async () => {
    const nodeRes = await callNode('/api/alerts/workflow', 'POST', operatorToken, { id: 'alt-004', status: 'in_progress' });
    const goRes = await callGo('/api/alerts/workflow', 'POST', operatorToken, { id: 'alt-004', status: 'in_progress' });
    assert.equal(nodeRes.status, 400);
    assert.equal(goRes.status, 400);
    assert.deepEqual(nodeRes.body, { error: 'Invalid alert workflow status' });
    assert.deepEqual(goRes.body, { error: 'Invalid alert workflow status' });
  });

  // 4.4 Status case-sensitivity
  await verifyAsync('POST /api/alerts/workflow: uppercase status returns 400 (case-sensitive)', async () => {
    const nodeRes = await callNode('/api/alerts/workflow', 'POST', operatorToken, { id: 'alt-004', status: 'RESOLVED' });
    const goRes = await callGo('/api/alerts/workflow', 'POST', operatorToken, { id: 'alt-004', status: 'RESOLVED' });
    assert.equal(nodeRes.status, 400);
    assert.equal(goRes.status, 400);
    assert.deepEqual(nodeRes.body, { error: 'Invalid alert workflow status' });
    assert.deepEqual(goRes.body, { error: 'Invalid alert workflow status' });
  });

  // 4.5 Status whitespace-sensitivity
  await verifyAsync('POST /api/alerts/workflow: surrounding whitespace status returns 400', async () => {
    const nodeRes = await callNode('/api/alerts/workflow', 'POST', operatorToken, { id: 'alt-004', status: ' resolved ' });
    const goRes = await callGo('/api/alerts/workflow', 'POST', operatorToken, { id: 'alt-004', status: ' resolved ' });
    assert.equal(nodeRes.status, 400);
    assert.equal(goRes.status, 400);
    assert.deepEqual(nodeRes.body, { error: 'Invalid alert workflow status' });
    assert.deepEqual(goRes.body, { error: 'Invalid alert workflow status' });
  });

  // 4.6 404 on non-existent alert
  await verifyAsync('POST /api/alerts/workflow: non-existent alert returns 404', async () => {
    const nodeRes = await callNode('/api/alerts/workflow', 'POST', operatorToken, { id: 'alt-unknown-999', status: 'assigned' });
    const goRes = await callGo('/api/alerts/workflow', 'POST', operatorToken, { id: 'alt-unknown-999', status: 'assigned' });
    assert.equal(nodeRes.status, 404);
    assert.equal(goRes.status, 404);
    assert.deepEqual(nodeRes.body, { error: 'Alert not found' });
    assert.deepEqual(goRes.body, { error: 'Alert not found' });
  });

  // 4.7 Update to 'assigned' with assignedTo and note (alt-004)
  await verifyAsync('POST /api/alerts/workflow: update status to assigned with assignedTo and note', async () => {
    const payload = {
      id: 'alt-004',
      status: 'assigned',
      assignedTo: '  alice_operator  ',
      note: '  checking core network  ',
    };
    const nodeRes = await callNode('/api/alerts/workflow', 'POST', operatorToken, payload);
    const goRes = await callGo('/api/alerts/workflow', 'POST', operatorToken, payload);
    assert.equal(nodeRes.status, 200);
    assert.equal(goRes.status, 200);
    assert.deepEqual(nodeRes.body, { success: true, matched: 1, modified: 1 });
    assert.deepEqual(goRes.body, { success: true, matched: 1, modified: 1 });

    const nodeDoc = await client.db(appDbNode).collection('app_alerts').findOne({ id: 'alt-004' });
    const goDoc = await client.db(appDbGo).collection('app_alerts').findOne({ id: 'alt-004' });
    assert.equal(nodeDoc.workflow_status, 'assigned');
    assert.equal(goDoc.workflow_status, 'assigned');
    assert.equal(nodeDoc.assigned_to, 'alice_operator');
    assert.equal(goDoc.assigned_to, 'alice_operator');
    assert.equal(nodeDoc.handling_note, 'checking core network');
    assert.equal(goDoc.handling_note, 'checking core network');
    assert.equal(nodeDoc.is_acknowledged, false);
    assert.equal(goDoc.is_acknowledged, false);
    assert.ok(nodeDoc.workflow_updated_at);
    assert.ok(goDoc.workflow_updated_at);
  });

  // 4.8 Update to 'recovering' preserving existing assignedTo and note
  await verifyAsync('POST /api/alerts/workflow: update status preserving omitted assignedTo/note', async () => {
    const payload = {
      id: 'alt-004',
      status: 'recovering',
    };
    const nodeRes = await callNode('/api/alerts/workflow', 'POST', operatorToken, payload);
    const goRes = await callGo('/api/alerts/workflow', 'POST', operatorToken, payload);
    assert.equal(nodeRes.status, 200);
    assert.equal(goRes.status, 200);
    assert.deepEqual(nodeRes.body, { success: true, matched: 1, modified: 1 });
    assert.deepEqual(goRes.body, { success: true, matched: 1, modified: 1 });

    const nodeDoc = await client.db(appDbNode).collection('app_alerts').findOne({ id: 'alt-004' });
    const goDoc = await client.db(appDbGo).collection('app_alerts').findOne({ id: 'alt-004' });
    assert.equal(nodeDoc.workflow_status, 'recovering');
    assert.equal(goDoc.workflow_status, 'recovering');
    // Pre-existing fields preserved
    assert.equal(nodeDoc.assigned_to, 'alice_operator');
    assert.equal(goDoc.assigned_to, 'alice_operator');
    assert.equal(nodeDoc.handling_note, 'checking core network');
    assert.equal(goDoc.handling_note, 'checking core network');
    assert.equal(nodeDoc.is_acknowledged, false);
    assert.equal(goDoc.is_acknowledged, false);
  });

  // 4.9 Update to 'resolved' sets is_acknowledged = true
  await verifyAsync('POST /api/alerts/workflow: update status to resolved sets is_acknowledged: true', async () => {
    const payload = {
      id: 'alt-004',
      status: 'resolved',
      note: 'issue resolved by restart',
    };
    const nodeRes = await callNode('/api/alerts/workflow', 'POST', operatorToken, payload);
    const goRes = await callGo('/api/alerts/workflow', 'POST', operatorToken, payload);
    assert.equal(nodeRes.status, 200);
    assert.equal(goRes.status, 200);
    assert.deepEqual(nodeRes.body, { success: true, matched: 1, modified: 1 });
    assert.deepEqual(goRes.body, { success: true, matched: 1, modified: 1 });

    const nodeDoc = await client.db(appDbNode).collection('app_alerts').findOne({ id: 'alt-004' });
    const goDoc = await client.db(appDbGo).collection('app_alerts').findOne({ id: 'alt-004' });
    assert.equal(nodeDoc.workflow_status, 'resolved');
    assert.equal(goDoc.workflow_status, 'resolved');
    assert.equal(nodeDoc.is_acknowledged, true);
    assert.equal(goDoc.is_acknowledged, true);
    assert.equal(nodeDoc.handling_note, 'issue resolved by restart');
    assert.equal(goDoc.handling_note, 'issue resolved by restart');
  });

  // 4.10 Max 80 chars truncation for text fields
  await verifyAsync('POST /api/alerts/workflow: fields exceeding 80 chars truncated to 80 chars', async () => {
    const longText = 'x'.repeat(100);
    const payload = {
      id: 'alt-005',
      status: 'assigned',
      assignedTo: longText,
      note: longText,
    };
    const nodeRes = await callNode('/api/alerts/workflow', 'POST', operatorToken, payload);
    const goRes = await callGo('/api/alerts/workflow', 'POST', operatorToken, payload);
    assert.equal(nodeRes.status, 200);
    assert.equal(goRes.status, 200);

    const nodeDoc = await client.db(appDbNode).collection('app_alerts').findOne({ id: 'alt-005' });
    const goDoc = await client.db(appDbGo).collection('app_alerts').findOne({ id: 'alt-005' });
    assert.equal(nodeDoc.assigned_to.length, 80);
    assert.equal(goDoc.assigned_to.length, 80);
    assert.equal(nodeDoc.handling_note.length, 80);
    assert.equal(goDoc.handling_note.length, 80);
    assert.equal(nodeDoc.assigned_to, 'x'.repeat(80));
    assert.equal(goDoc.assigned_to, 'x'.repeat(80));
  });

  // 4.11 Malformed JSON in workflow
  await verifyAsync('POST /api/alerts/workflow: malformed JSON returns 500', async () => {
    const nodeRes = await callNode('/api/alerts/workflow', 'POST', operatorToken, '{invalid-json');
    const goRes = await callGo('/api/alerts/workflow', 'POST', operatorToken, '{invalid-json');
    assert.equal(nodeRes.status, 500);
    assert.equal(goRes.status, 500);
    assert.deepEqual(nodeRes.body, { error: 'Failed to update alert workflow' });
    assert.deepEqual(goRes.body, { error: 'Failed to update alert workflow' });
  });

  console.log('\n--- Section 5: Best-Effort Audit Logging Evidence & Resilience ---');

  // 5.1 Verify Audit Log Evidence created in app_audit_logs
  await verifyAsync('Verify operation logs recorded in app_audit_logs', async () => {
    const nodeAckLog = await client.db(appDbNode).collection('app_audit_logs').findOne({ action: 'alert.acknowledge' });
    const goAckLog = await client.db(appDbGo).collection('app_audit_logs').findOne({ action: 'alert.acknowledge' });
    assert.ok(nodeAckLog, 'Node must record alert.acknowledge audit log');
    assert.ok(goAckLog, 'Go must record alert.acknowledge audit log');
    assert.equal(nodeAckLog.module, 'alerts');
    assert.equal(goAckLog.module, 'alerts');
    assert.equal(nodeAckLog.result, 'success');
    assert.equal(goAckLog.result, 'success');

    const nodeWfLog = await client.db(appDbNode).collection('app_audit_logs').findOne({ action: 'alert.workflow' });
    const goWfLog = await client.db(appDbGo).collection('app_audit_logs').findOne({ action: 'alert.workflow' });
    assert.ok(nodeWfLog, 'Node must record alert.workflow audit log');
    assert.ok(goWfLog, 'Go must record alert.workflow audit log');
    assert.equal(nodeWfLog.module, 'alerts');
    assert.equal(goWfLog.module, 'alerts');
    assert.equal(nodeWfLog.result, 'success');
    assert.equal(goWfLog.result, 'success');
  });

  // 5.2 Best-Effort Audit Failure Resilience (collMod schema validator)
  await verifyAsync('Audit persistence failure does not roll back committed alert mutation (Node & Go)', async () => {
    // Insert new alert in both DBs for this test
    const testAlert = {
      id: 'alt-audit-fail-test',
      timestamp: '2026-09-28T12:00:00.000Z',
      level: 'CRITICAL',
      imsi: '001010000000009',
      reason: 'Audit resilience test',
      is_acknowledged: false,
    };
    await client.db(appDbNode).collection('app_alerts').insertOne({ ...testAlert });
    await client.db(appDbGo).collection('app_alerts').insertOne({ ...testAlert });

    // Put impossible schema validator on app_audit_logs in both DBs
    await client.db(appDbNode).command({
      collMod: 'app_audit_logs',
      validator: { $jsonSchema: { required: ['impossible_field_for_audit_failure_testing'] } },
      validationAction: 'error',
    });
    await client.db(appDbGo).command({
      collMod: 'app_audit_logs',
      validator: { $jsonSchema: { required: ['impossible_field_for_audit_failure_testing'] } },
      validationAction: 'error',
    });

    try {
      // Execute acknowledge on alt-audit-fail-test
      const nodeRes = await callNode('/api/alerts/acknowledge', 'POST', operatorToken, { id: 'alt-audit-fail-test' });
      const goRes = await callGo('/api/alerts/acknowledge', 'POST', operatorToken, { id: 'alt-audit-fail-test' });

      // Both must succeed with 200 because audit logging is best-effort!
      assert.equal(nodeRes.status, 200);
      assert.equal(goRes.status, 200);
      assert.equal(nodeRes.body.acknowledged, 1);
      assert.equal(goRes.body.acknowledged, 1);

      // Verify business mutation was committed despite audit log failure
      const nodeDoc = await client.db(appDbNode).collection('app_alerts').findOne({ id: 'alt-audit-fail-test' });
      const goDoc = await client.db(appDbGo).collection('app_alerts').findOne({ id: 'alt-audit-fail-test' });
      assert.equal(nodeDoc.is_acknowledged, true);
      assert.equal(goDoc.is_acknowledged, true);
    } finally {
      // Restore schema validator
      await client.db(appDbNode).command({ collMod: 'app_audit_logs', validator: {} });
      await client.db(appDbGo).command({ collMod: 'app_audit_logs', validator: {} });
    }
  });

  console.log('\n--- Section 6: Database Failure Parity (HTTP 500) ---');

  await verifyAsync('POST /api/alerts/acknowledge: database failure returns 500', async () => {
    const goFailRes = await callGoFail('/api/alerts/acknowledge', 'POST', operatorToken, { id: 'alt-001' });
    assert.equal(goFailRes.status, 500);
    assert.deepEqual(goFailRes.body, { error: 'Failed to acknowledge alert' });
  });

  await verifyAsync('POST /api/alerts/workflow: database failure returns 500', async () => {
    const goFailRes = await callGoFail('/api/alerts/workflow', 'POST', operatorToken, { id: 'alt-001', status: 'assigned' });
    assert.equal(goFailRes.status, 500);
    assert.deepEqual(goFailRes.body, { error: 'Failed to update alert workflow' });
  });

  console.log('\n--- Section 7: Zero Unrelated Business Domain Mutation ---');

  await verifyAsync('Verify zero mutations across all 7 unrelated collections in both databases', async () => {
    for (const [xDbName, aDbName, label] of [
      [xcloudDbNode, appDbNode, 'Node'],
      [xcloudDbGo, appDbGo, 'Go'],
    ]) {
      const xDb = client.db(xDbName);
      const aDb = client.db(aDbName);

      const subCount = await xDb.collection('subscribers').countDocuments();
      assert.equal(subCount, 1, `${label}: subscribers collection must remain unchanged`);

      const tariffCount = await xDb.collection('ocs_tariff_plans').countDocuments();
      assert.equal(tariffCount, 1, `${label}: ocs_tariff_plans must remain unchanged`);

      const balanceCount = await xDb.collection('ocs_balances').countDocuments();
      assert.equal(balanceCount, 1, `${label}: ocs_balances must remain unchanged`);

      const ocsSubCount = await xDb.collection('ocs_subscribers').countDocuments();
      assert.equal(ocsSubCount, 1, `${label}: ocs_subscribers must remain unchanged`);

      const sessCount = await xDb.collection('ocs_sessions').countDocuments();
      assert.equal(sessCount, 1, `${label}: ocs_sessions must remain unchanged`);

      const resCount = await xDb.collection('ocs_reservations').countDocuments();
      assert.equal(resCount, 1, `${label}: ocs_reservations must remain unchanged`);

      const profCount = await aDb.collection('app_profiles').countDocuments();
      assert.equal(profCount, 1, `${label}: app_profiles must remain unchanged`);

      const appApprovalsCount = await aDb.collection('app_approvals').countDocuments();
      assert.equal(appApprovalsCount, 0, `${label}: app_approvals count must remain 0 (Direct Execution)`);
    }
  });

  console.log('\n--- Section 8: Routing Invariants & Freeze Verification ---');

  verify('CUTOVER_TABLE length must be exactly 36', () => {
    assert.equal(CUTOVER_TABLE.length, 36);
  });

  verify('ACTUALLY_ROUTED count must be exactly 36', () => {
    const routed = CUTOVER_TABLE.filter((r) => r.owner === 'go');
    assert.equal(routed.length, 36);
  });

  verify('Phase 7 endpoints must NOT be in CUTOVER_TABLE (Phase 7 cutover = 0)', () => {
    const p7Candidates = [
      '/api/alerts',
      '/api/alerts/acknowledge',
      '/api/alerts/workflow',
      '/api/notifications/stream',
      '/api/system/health',
      '/api/system/mongo/health',
      '/api/system/audit/status',
      '/api/system/audit/scan',
      '/api/system/audit/heal',
      '/api/system/audit/batch-heal',
      '/api/analytics/init',
    ];
    for (const ep of p7Candidates) {
      const match = CUTOVER_TABLE.find((r) => r.path === ep);
      assert.ok(!match, `Phase 7 candidate ${ep} must not be in CUTOVER_TABLE in Phase 7.2`);
    }
  });

  console.log('\n========================================================================');
  console.log(`Phase 7.2 Alert Domain Mutation Parity Suite: ${passed} PASSED, ${failed} FAILED`);
  console.log('========================================================================\n');

  if (failed > 0) {
    process.exitCode = 1;
  }
  await cleanup();
}

main().catch(async (err) => {
  console.error('Fatal test error:', err);
  process.exitCode = 1;
  await cleanup();
});
