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
import { existsSync, unlinkSync, readFileSync, readdirSync } from 'node:fs';
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
let skipped = 0;
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

// ---------------------------------------------------------------------------
// Deterministic helpers: UTF-16 accounting, content fingerprints, polling
// ---------------------------------------------------------------------------

/** Counts UTF-16 code units the way JavaScript String.length does. */
function utf16Len(str) {
  let units = 0;
  for (const ch of String(str)) {
    units += ch.codePointAt(0) > 0xffff ? 2 : 1;
  }
  return units;
}

/** Builds a string of n UTF-16 code units from a given code point. */
function repeatCodePoint(cp, n) {
  const ch = String.fromCodePoint(cp);
  const perUnit = cp > 0xffff ? 2 : 1;
  return ch.repeat(Math.floor(n / perUnit));
}

const CP_CJK = 0x4e2d;
const CP_EMOJI = 0x1f600;

/**
 * Content-level fingerprint of a collection. Unlike countDocuments(), this
 * detects in-place document modification that preserves the document count.
 */
async function fingerprintCollection(db, name) {
  const docs = await db.collection(name).find({}).sort({ _id: 1 }).toArray();
  const normalized = docs.map((doc) => {
    const copy = { ...doc };
    delete copy._id;
    return copy;
  });
  return {
    count: docs.length,
    digest: crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex'),
  };
}

async function waitFor(description, fn, timeoutMs = 5000, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timeout waiting for: ${description}${lastErr ? ` (last error: ${lastErr.message})` : ''}`);
}

/**
 * Audit logging is best-effort and asynchronous on both sides, so assertions
 * against app_audit_logs poll rather than race the worker.
 */
async function waitForAuditCount(dbName, filter, expected, timeoutMs = 5000) {
  return waitFor(
    `audit count ${JSON.stringify(filter)} == ${expected} in ${dbName}`,
    async () => {
      const count = await client.db(dbName).collection('app_audit_logs').countDocuments(filter);
      return count === expected ? count : null;
    },
    timeoutMs
  );
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
    // External role contract is root/operator; root is the legacy documented role.
    { username: 'root_user', passwordHash: hash, role: 'root', status: 'active', security: { sessionVersion: 1 }, createdAt: new Date().toISOString() },
    { username: 'ops_admin_user', passwordHash: hash, role: 'ops_admin', status: 'active', security: { sessionVersion: 1 }, createdAt: new Date().toISOString() },
    // Dedicated identities so rate-limit windows never bleed across mandatory cases.
    { username: 'ack_matrix_user', passwordHash: hash, role: 'operator', status: 'active', security: { sessionVersion: 1 }, createdAt: new Date().toISOString() },
    { username: 'wf_matrix_user', passwordHash: hash, role: 'operator', status: 'active', security: { sessionVersion: 1 }, createdAt: new Date().toISOString() },
    { username: 'uni_matrix_user', passwordHash: hash, role: 'operator', status: 'active', security: { sessionVersion: 1 }, createdAt: new Date().toISOString() },
    { username: 'audit_fail_user', passwordHash: hash, role: 'operator', status: 'active', security: { sessionVersion: 1 }, createdAt: new Date().toISOString() },
    { username: 'repo_fail_user', passwordHash: hash, role: 'operator', status: 'active', security: { sessionVersion: 1 }, createdAt: new Date().toISOString() },
    { username: 'rl_matrix_user', passwordHash: hash, role: 'operator', status: 'active', security: { sessionVersion: 1 }, createdAt: new Date().toISOString() },
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
    // Acknowledge accounting fixtures
    {
      id: 'alt-multi-1',
      timestamp: '2026-09-28T04:00:00.000Z',
      level: 'WARNING',
      imsi: '001010000000007',
      reason: 'Multi acknowledge target one',
      is_acknowledged: false,
    },
    {
      id: 'alt-multi-2',
      timestamp: '2026-09-28T03:00:00.000Z',
      level: 'WARNING',
      imsi: '001010000000008',
      reason: 'Multi acknowledge target two',
      is_acknowledged: false,
    },
    {
      id: 'alt-mix-unack',
      timestamp: '2026-09-28T02:00:00.000Z',
      level: 'INFO',
      imsi: '001010000000009',
      reason: 'Mixture unacknowledged target',
      is_acknowledged: false,
    },
    {
      id: 'alt-mix-ack',
      timestamp: '2026-09-28T01:00:00.000Z',
      level: 'INFO',
      imsi: '001010000000010',
      reason: 'Mixture already acknowledged target',
      is_acknowledged: true,
    },
    // Workflow fixtures
    {
      id: 'alt-wf-transition',
      timestamp: '2026-09-28T00:30:00.000Z',
      level: 'WARNING',
      imsi: '001010000000011',
      reason: 'Workflow transition probe',
      is_acknowledged: false,
    },
    {
      id: 'alt-wf-preserve',
      timestamp: '2026-09-28T00:20:00.000Z',
      level: 'WARNING',
      imsi: '001010000000012',
      reason: 'Workflow omitted-field preservation probe',
      is_acknowledged: false,
      workflow_status: 'assigned',
      assigned_to: 'existing_assignee',
      handling_note: 'existing note body',
    },
    {
      id: 'alt-wf-resolved-ack',
      timestamp: '2026-09-28T00:10:00.000Z',
      level: 'INFO',
      imsi: '001010000000013',
      reason: 'Resolved acknowledgement probe',
      is_acknowledged: false,
    },
    // Repository-failure fixtures (persistent state must survive a rejected write)
    {
      id: 'alt-repo-fail-1',
      timestamp: '2026-09-28T00:05:00.000Z',
      level: 'CRITICAL',
      imsi: '001010000000014',
      reason: 'Repository failure target one',
      is_acknowledged: false,
    },
    {
      id: 'alt-repo-fail-2',
      timestamp: '2026-09-28T00:04:00.000Z',
      level: 'CRITICAL',
      imsi: '001010000000015',
      reason: 'Repository failure target two',
      is_acknowledged: false,
      workflow_status: 'assigned',
      assigned_to: 'fail_assignee',
      handling_note: 'fail note body',
    },
  ];

  await aDb.collection('app_alerts').insertMany(initialAlerts);

  // Unicode and structural fixtures. IDs and text are assembled from code points
  // so this source file remains pure ASCII.
  const uniCjkId = repeatCodePoint(CP_CJK, 80);
  await aDb.collection('app_alerts').insertMany([
    {
      // Exactly 80 UTF-16 code units, used to prove JS slice truncation of a longer id.
      id: uniCjkId,
      timestamp: '2026-09-28T00:01:00.000Z',
      level: 'INFO',
      imsi: '001010000000016',
      reason: 'Unicode id truncation probe',
      is_acknowledged: false,
    },
    {
      id: 'alt-uni-note',
      timestamp: '2026-09-28T00:00:50.000Z',
      level: 'INFO',
      imsi: '001010000000017',
      reason: 'Unicode note truncation probe',
      is_acknowledged: false,
    },
    {
      id: 'alt-uni-assignee',
      timestamp: '2026-09-28T00:00:40.000Z',
      level: 'INFO',
      imsi: '001010000000018',
      reason: 'Unicode assignee truncation probe',
      is_acknowledged: false,
    },
    {
      id: 'alt-uni-straddle',
      timestamp: '2026-09-28T00:00:30.000Z',
      level: 'INFO',
      imsi: '001010000000019',
      reason: 'Surrogate straddle truncation probe',
      is_acknowledged: false,
    },
    {
      id: 'alt-wf-unrelated',
      timestamp: '2026-09-28T00:00:20.000Z',
      level: 'CRITICAL',
      imsi: '001010000000020',
      reason: 'Unrelated field preservation probe',
      is_acknowledged: false,
      custom_metadata: { keep: 'this-must-survive', nested: [1, 2, 3] },
    },
  ]);

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
  await xDb.collection('ocs_usage_records').insertOne({
    usage_id: 'usage-001',
    session_id: 'sess-001',
    volume: 1024,
  });
  await aDb.collection('app_profiles').insertOne({
    name: 'default',
    created_at: new Date().toISOString(),
  });
  await aDb.collection('app_profile_versions').insertOne({
    profile: 'default',
    version: 1,
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
  const ackMatrixToken = await makeToken('ack_matrix_user', 'operator', 1);
  const wfMatrixToken = await makeToken('wf_matrix_user', 'operator', 1);
  const uniMatrixToken = await makeToken('uni_matrix_user', 'operator', 1);
  const auditFailToken = await makeToken('audit_fail_user', 'operator', 1);
  const repoFailToken = await makeToken('repo_fail_user', 'operator', 1);

  // Content-level mutation guard baseline. Captured before any Phase 7.2
  // mutation case runs so in-place document edits cannot hide behind a stable
  // countDocuments() total. Only app_alerts, app_audit_logs and
  // app_rate_limits are permitted to change.
  const PROTECTED_COLLECTIONS = [
    ['xcloud', 'subscribers'],
    ['xcloud', 'ocs_tariff_plans'],
    ['xcloud', 'ocs_subscribers'],
    ['xcloud', 'ocs_balances'],
    ['xcloud', 'ocs_sessions'],
    ['xcloud', 'ocs_reservations'],
    ['xcloud', 'ocs_usage_records'],
    ['app', 'app_profiles'],
    ['app', 'app_profile_versions'],
    ['app', 'app_users'],
  ];

  async function snapshotProtected(which) {
    const out = {};
    for (const [dbKind, name] of PROTECTED_COLLECTIONS) {
      const dbName = which === 'Node'
        ? (dbKind === 'xcloud' ? xcloudDbNode : appDbNode)
        : (dbKind === 'xcloud' ? xcloudDbGo : appDbGo);
      out[`${dbKind}.${name}`] = await fingerprintCollection(client.db(dbName), name);
    }
    return out;
  }

  const protectedBefore = {
    Node: await snapshotProtected('Node'),
    Go: await snapshotProtected('Go'),
  };

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

  // 2.3 Acknowledge rate limit: window budget 60, then the limit + 1 request
  // is throttled. Driven by real HTTP traffic after pre-seeding the window so the
  // assertion is deterministic across fixed-window boundaries.
  await verifyAsync('POST /api/alerts/acknowledge rate limit admits 60 then rejects limit+1', async () => {
    const rlToken = await makeToken('rl_matrix_user', 'operator', 1);

    async function exhaust(label, call, appDb) {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const currentWindow = Math.floor(nowSeconds / 60);
      const key = `RATELIMIT:alerts:acknowledge:rl_matrix_user:${currentWindow}`;
      const resetAtTime = new Date((currentWindow + 1) * 60 * 1000);

      await client.db(appDb).collection('app_rate_limits').updateOne(
        { key },
        { $set: { key, count: 58, reset_at: resetAtTime, updated_at: new Date() } },
        { upsert: true }
      );

      let last = null;
      let admitted = 0;
      for (let i = 0; i < 5; i++) {
        last = await call('/api/alerts/acknowledge', 'POST', rlToken, { id: `rl-absent-${label}-${i}` });
        if (last.status === 429) break;
        admitted++;
      }

      // 58 pre-existing + 2 real requests reaches the limit of 60; the next
      // request is limit + 1 and must be throttled.
      assert.equal(admitted, 2, `${label}: exactly 2 more requests must be admitted before the limit of 60`);
      assert.equal(last.status, 429, `${label}: the limit + 1 request must be throttled`);
      assert.equal(last.body.error, 'Too many requests', `${label}: throttled body`);
      assert.equal(last.headers.get('x-ratelimit-limit'), '60', `${label}: X-RateLimit-Limit`);
      assert.ok(last.headers.has('x-ratelimit-remaining'), `${label}: X-RateLimit-Remaining must be present`);
      assert.ok(Number(last.headers.get('retry-after')) >= 1, `${label}: Retry-After >= 1`);

      const doc = await client.db(appDb).collection('app_rate_limits').findOne({ key });
      assert.ok(doc.count >= 60, `${label}: window counter must reflect the exhausted limit`);
    }

    await exhaust('Node', callNode, appDbNode);
    await exhaust('Go', callGo, appDbGo);
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

  // 3.9 External role contract: root/operator are the documented allowed roles
  for (const [label, username, role] of [
    ['root', 'root_user', 'root'],
    ['admin (internal normalization of root)', 'admin_user', 'admin'],
    ['operator', 'operator_user', 'operator'],
    ['ops_admin (legacy alias of operator)', 'ops_admin_user', 'ops_admin'],
  ]) {
    await verifyAsync(`POST /api/alerts/acknowledge: role ${label} is authorized`, async () => {
      const token = await makeToken(username, role, 1);
      const nodeRes = await callNode('/api/alerts/acknowledge', 'POST', token, { id: 'alt-role-probe' });
      const goRes = await callGo('/api/alerts/acknowledge', 'POST', token, { id: 'alt-role-probe' });
      assert.equal(nodeRes.status, 200, `Node must accept role ${label}`);
      assert.equal(goRes.status, 200, `Go must accept role ${label}`);
      assert.equal(nodeRes.body.success, true);
      assert.equal(goRes.body.success, true);
    });
  }

  // 3.10 ids[] takes precedence over id when both are supplied
  await verifyAsync('POST /api/alerts/acknowledge: ids[] takes precedence over id', async () => {
    const payload = { id: 'alt-should-be-ignored', ids: ['alt-multi-1'] };
    const nodeRes = await callNode('/api/alerts/acknowledge', 'POST', ackMatrixToken, payload);
    const goRes = await callGo('/api/alerts/acknowledge', 'POST', ackMatrixToken, payload);
    assert.equal(nodeRes.status, 200);
    assert.equal(goRes.status, 200);
    // Only the ids[] member is requested; the sibling id field must be ignored.
    assert.deepEqual(nodeRes.body, { success: true, acknowledged: 1, requested: 1, skipped: 0 });
    assert.deepEqual(goRes.body, { success: true, acknowledged: 1, requested: 1, skipped: 0 });

    const ignoredNode = await client.db(appDbNode).collection('app_alerts').findOne({ id: 'alt-should-be-ignored' });
    assert.equal(ignoredNode, null, 'Node must not acknowledge the ignored id field');
  });

  // 3.11 Null and numeric scalar ids are rejected as non-strings
  for (const [label, value] of [['null', null], ['numeric', 42]]) {
    await verifyAsync(`POST /api/alerts/acknowledge: id=${label} returns 400`, async () => {
      const nodeRes = await callNode('/api/alerts/acknowledge', 'POST', ackMatrixToken, { id: value });
      const goRes = await callGo('/api/alerts/acknowledge', 'POST', ackMatrixToken, { id: value });
      assert.equal(nodeRes.status, 400);
      assert.equal(goRes.status, 400);
      assert.deepEqual(nodeRes.body, { error: 'Alert ID(s) required' });
      assert.deepEqual(goRes.body, { error: 'Alert ID(s) required' });
    });
  }

  // 3.12 Mixed-type ids array: only trimmed non-empty strings survive normalization
  await verifyAsync('POST /api/alerts/acknowledge: mixed-type ids array normalizes to strings only', async () => {
    const payload = {
      ids: ['alt-multi-2', 7, null, '', '   ', '  alt-multi-2  ', false, { id: 'x' }],
    };
    const nodeRes = await callNode('/api/alerts/acknowledge', 'POST', ackMatrixToken, payload);
    const goRes = await callGo('/api/alerts/acknowledge', 'POST', ackMatrixToken, payload);
    assert.equal(nodeRes.status, 200);
    assert.equal(goRes.status, 200);
    // 'alt-multi-2' appears twice (once padded) and deduplicates to one request.
    assert.deepEqual(nodeRes.body, { success: true, acknowledged: 1, requested: 1, skipped: 0 });
    assert.deepEqual(goRes.body, { success: true, acknowledged: 1, requested: 1, skipped: 0 });
  });

  // 3.13 Duplicate IDs and surrounding whitespace collapse to one requested ID
  await verifyAsync('POST /api/alerts/acknowledge: duplicate and whitespace-padded IDs deduplicate', async () => {
    const payload = { ids: ['  alt-dup-1 ', 'alt-dup-1', '\talt-dup-1\n', 'alt-dup-1'] };
    const nodeRes = await callNode('/api/alerts/acknowledge', 'POST', ackMatrixToken, payload);
    const goRes = await callGo('/api/alerts/acknowledge', 'POST', ackMatrixToken, payload);
    assert.equal(nodeRes.status, 200);
    assert.equal(goRes.status, 200);
    assert.deepEqual(nodeRes.body, { success: true, acknowledged: 0, requested: 1, skipped: 1 });
    assert.deepEqual(goRes.body, { success: true, acknowledged: 0, requested: 1, skipped: 1 });
  });

  // 3.14 Exactly 200 normalized unique valid IDs is accepted
  await verifyAsync('POST /api/alerts/acknowledge: exactly 200 normalized unique IDs accepted', async () => {
    const ids = Array.from({ length: 200 }, (_, i) => `alt-bulk200-${i}`);
    const docs = ids.map((id, i) => ({
      id,
      timestamp: `2026-09-27T10:${String(i % 60).padStart(2, '0')}:00.000Z`,
      level: 'INFO',
      imsi: `00101000001${String(i).padStart(4, '0')}`,
      reason: 'Bulk boundary probe',
      is_acknowledged: false,
    }));
    await client.db(appDbNode).collection('app_alerts').insertMany(docs);
    await client.db(appDbGo).collection('app_alerts').insertMany(docs);

    const nodeRes = await callNode('/api/alerts/acknowledge', 'POST', ackMatrixToken, { ids });
    const goRes = await callGo('/api/alerts/acknowledge', 'POST', ackMatrixToken, { ids });
    assert.equal(nodeRes.status, 200);
    assert.equal(goRes.status, 200);
    assert.deepEqual(nodeRes.body, { success: true, acknowledged: 200, requested: 200, skipped: 0 });
    assert.deepEqual(goRes.body, { success: true, acknowledged: 200, requested: 200, skipped: 0 });
  });

  // 3.15 201 normalized unique IDs is rejected
  await verifyAsync('POST /api/alerts/acknowledge: 201 normalized unique IDs rejected', async () => {
    const ids = Array.from({ length: 201 }, (_, i) => `alt-bulk201-${i}`);
    const nodeRes = await callNode('/api/alerts/acknowledge', 'POST', ackMatrixToken, { ids });
    const goRes = await callGo('/api/alerts/acknowledge', 'POST', ackMatrixToken, { ids });
    assert.equal(nodeRes.status, 400);
    assert.equal(goRes.status, 400);
    assert.deepEqual(nodeRes.body, { error: 'At most 200 alerts can be acknowledged at once' });
    assert.deepEqual(goRes.body, { error: 'At most 200 alerts can be acknowledged at once' });
  });

  // 3.16 >200 raw elements that normalize to <= 200 unique valid IDs is accepted
  await verifyAsync('POST /api/alerts/acknowledge: >200 raw elements collapsing to 200 unique accepted', async () => {
    const base = Array.from({ length: 200 }, (_, i) => `alt-norm200-${i}`);
    const noisy = [];
    for (const id of base) {
      noisy.push(`  ${id}  `);
      noisy.push(id);
      noisy.push(null);
      noisy.push('');
      noisy.push('    ');
      noisy.push(id.length);
    }
    assert.ok(noisy.length > 200, 'fixture must exceed 200 raw elements');

    const expectedUnique = new Set(
      noisy.filter((v) => typeof v === 'string').map((v) => v.trim()).filter(Boolean)
    );
    assert.equal(expectedUnique.size, 200, 'fixture must normalize to exactly 200 unique IDs');

    const nodeRes = await callNode('/api/alerts/acknowledge', 'POST', ackMatrixToken, { ids: noisy });
    const goRes = await callGo('/api/alerts/acknowledge', 'POST', ackMatrixToken, { ids: noisy });
    assert.equal(nodeRes.status, 200);
    assert.equal(goRes.status, 200);
    // All 200 are unknown IDs: requested 200, acknowledged 0, skipped 200.
    assert.deepEqual(nodeRes.body, { success: true, acknowledged: 0, requested: 200, skipped: 200 });
    assert.deepEqual(goRes.body, { success: true, acknowledged: 0, requested: 200, skipped: 200 });
  });

  // 3.17 Mixture of existing-unacknowledged, already-acknowledged and unknown IDs
  await verifyAsync('POST /api/alerts/acknowledge: mixture accounting is skipped = requested - acknowledged', async () => {
    const payload = { ids: ['alt-mix-unack', 'alt-mix-ack', 'alt-mix-unknown'] };
    const nodeRes = await callNode('/api/alerts/acknowledge', 'POST', ackMatrixToken, payload);
    const goRes = await callGo('/api/alerts/acknowledge', 'POST', ackMatrixToken, payload);
    assert.equal(nodeRes.status, 200);
    assert.equal(goRes.status, 200);
    assert.deepEqual(nodeRes.body, { success: true, acknowledged: 1, requested: 3, skipped: 2 });
    assert.deepEqual(goRes.body, { success: true, acknowledged: 1, requested: 3, skipped: 2 });

    // Persistent-state parity: id, is_acknowledged and unrelated fields must agree.
    const nodeDoc = await client.db(appDbNode).collection('app_alerts').findOne({ id: 'alt-mix-unack' });
    const goDoc = await client.db(appDbGo).collection('app_alerts').findOne({ id: 'alt-mix-unack' });
    delete nodeDoc._id;
    delete goDoc._id;
    assert.deepEqual(goDoc, nodeDoc, 'Go persistent state must match Node after mixture acknowledge');
    assert.equal(nodeDoc.is_acknowledged, true);
    assert.equal(nodeDoc.reason, 'Mixture unacknowledged target');
  });

  // 3.18 Multiple existing unacknowledged IDs acknowledged in one call
  await verifyAsync('POST /api/alerts/acknowledge: multiple existing unacknowledged IDs', async () => {
    const payload = { ids: ['alt-multi-3', 'alt-multi-4'] };
    const docs = ['alt-multi-3', 'alt-multi-4'].map((id, i) => ({
      id,
      timestamp: `2026-09-27T12:0${i}:00.000Z`,
      level: 'WARNING',
      imsi: `00101000002000${i}`,
      reason: `Multi target ${i}`,
      is_acknowledged: false,
    }));
    await client.db(appDbNode).collection('app_alerts').insertMany(docs);
    await client.db(appDbGo).collection('app_alerts').insertMany(docs);

    const nodeRes = await callNode('/api/alerts/acknowledge', 'POST', ackMatrixToken, payload);
    const goRes = await callGo('/api/alerts/acknowledge', 'POST', ackMatrixToken, payload);
    assert.equal(nodeRes.status, 200);
    assert.equal(goRes.status, 200);
    assert.deepEqual(nodeRes.body, { success: true, acknowledged: 2, requested: 2, skipped: 0 });
    assert.deepEqual(goRes.body, { success: true, acknowledged: 2, requested: 2, skipped: 0 });

    for (const id of ['alt-multi-3', 'alt-multi-4']) {
      const nodeDoc = await client.db(appDbNode).collection('app_alerts').findOne({ id });
      const goDoc = await client.db(appDbGo).collection('app_alerts').findOne({ id });
      delete nodeDoc._id;
      delete goDoc._id;
      assert.deepEqual(goDoc, nodeDoc);
      assert.equal(nodeDoc.is_acknowledged, true);
    }
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

  // 4.12 Every valid workflow status is accepted (no hidden allow-list narrowing)
  for (const status of ['acknowledged', 'assigned', 'recovering', 'resolved']) {
    await verifyAsync(`POST /api/alerts/workflow: status '${status}' is accepted`, async () => {
      const probeId = `alt-wf-status-${status}`;
      const payload = { id: probeId, status };
      const docs = [{
        id: probeId,
        timestamp: '2026-09-27T09:00:00.000Z',
        level: 'INFO',
        imsi: '001010000030001',
        reason: 'Status acceptance probe',
        is_acknowledged: false,
      }];
      await client.db(appDbNode).collection('app_alerts').deleteMany({ id: probeId });
      await client.db(appDbGo).collection('app_alerts').deleteMany({ id: probeId });
      await client.db(appDbNode).collection('app_alerts').insertMany(docs);
      await client.db(appDbGo).collection('app_alerts').insertMany(docs);

      const nodeRes = await callNode('/api/alerts/workflow', 'POST', wfMatrixToken, payload);
      const goRes = await callGo('/api/alerts/workflow', 'POST', wfMatrixToken, payload);
      assert.equal(nodeRes.status, 200, `Node must accept status ${status}`);
      assert.equal(goRes.status, 200, `Go must accept status ${status}`);
      assert.deepEqual(nodeRes.body, { success: true, matched: 1, modified: 1 });
      assert.deepEqual(goRes.body, { success: true, matched: 1, modified: 1 });

      const nodeDoc = await client.db(appDbNode).collection('app_alerts').findOne({ id: probeId });
      const goDoc = await client.db(appDbGo).collection('app_alerts').findOne({ id: probeId });
      assert.equal(nodeDoc.workflow_status, status);
      assert.equal(goDoc.workflow_status, status);
    });
  }

  // 4.13 No strict transition state machine: any status may follow any other.
  // The assertion is parity with Node, not product desirability.
  await verifyAsync('POST /api/alerts/workflow: no strict transition graph (resolved -> assigned)', async () => {
    const nodeRes = await callNode('/api/alerts/workflow', 'POST', wfMatrixToken, { id: 'alt-wf-transition', status: 'resolved' });
    const goRes = await callGo('/api/alerts/workflow', 'POST', wfMatrixToken, { id: 'alt-wf-transition', status: 'resolved' });
    assert.equal(nodeRes.status, 200);
    assert.equal(goRes.status, 200);

    const nodeNext = await callNode('/api/alerts/workflow', 'POST', wfMatrixToken, { id: 'alt-wf-transition', status: 'assigned' });
    const goNext = await callGo('/api/alerts/workflow', 'POST', wfMatrixToken, { id: 'alt-wf-transition', status: 'assigned' });
    assert.equal(nodeNext.status, 200, 'Node must allow resolved -> assigned');
    assert.equal(goNext.status, 200, 'Go must allow resolved -> assigned');
    assert.deepEqual(nodeNext.body, { success: true, matched: 1, modified: 1 });
    assert.deepEqual(goNext.body, { success: true, matched: 1, modified: 1 });

    // resolved sets is_acknowledged=true and 'assigned' must not undo it.
    const nodeDoc = await client.db(appDbNode).collection('app_alerts').findOne({ id: 'alt-wf-transition' });
    const goDoc = await client.db(appDbGo).collection('app_alerts').findOne({ id: 'alt-wf-transition' });
    assert.equal(nodeDoc.workflow_status, 'assigned');
    assert.equal(goDoc.workflow_status, 'assigned');
    assert.equal(nodeDoc.is_acknowledged, true);
    assert.equal(goDoc.is_acknowledged, true);
  });

  await verifyAsync('POST /api/alerts/workflow: no strict transition graph (recovering -> acknowledged)', async () => {
    await callNode('/api/alerts/workflow', 'POST', wfMatrixToken, { id: 'alt-wf-transition', status: 'recovering' });
    await callGo('/api/alerts/workflow', 'POST', wfMatrixToken, { id: 'alt-wf-transition', status: 'recovering' });

    const nodeRes = await callNode('/api/alerts/workflow', 'POST', wfMatrixToken, { id: 'alt-wf-transition', status: 'acknowledged' });
    const goRes = await callGo('/api/alerts/workflow', 'POST', wfMatrixToken, { id: 'alt-wf-transition', status: 'acknowledged' });
    assert.equal(nodeRes.status, 200, 'Node must allow recovering -> acknowledged');
    assert.equal(goRes.status, 200, 'Go must allow recovering -> acknowledged');
  });

  await verifyAsync('POST /api/alerts/workflow: no strict transition graph (acknowledged -> resolved)', async () => {
    const nodeRes = await callNode('/api/alerts/workflow', 'POST', wfMatrixToken, { id: 'alt-wf-transition', status: 'resolved' });
    const goRes = await callGo('/api/alerts/workflow', 'POST', wfMatrixToken, { id: 'alt-wf-transition', status: 'resolved' });
    assert.equal(nodeRes.status, 200, 'Node must allow acknowledged -> resolved');
    assert.equal(goRes.status, 200, 'Go must allow acknowledged -> resolved');

    const nodeDoc = await client.db(appDbNode).collection('app_alerts').findOne({ id: 'alt-wf-transition' });
    const goDoc = await client.db(appDbGo).collection('app_alerts').findOne({ id: 'alt-wf-transition' });
    assert.equal(nodeDoc.is_acknowledged, true);
    assert.equal(goDoc.is_acknowledged, true);
  });

  await verifyAsync('POST /api/alerts/workflow: no strict transition graph (assigned -> recovering)', async () => {
    await callNode('/api/alerts/workflow', 'POST', wfMatrixToken, { id: 'alt-wf-transition', status: 'assigned' });
    await callGo('/api/alerts/workflow', 'POST', wfMatrixToken, { id: 'alt-wf-transition', status: 'assigned' });

    const nodeRes = await callNode('/api/alerts/workflow', 'POST', wfMatrixToken, { id: 'alt-wf-transition', status: 'recovering' });
    const goRes = await callGo('/api/alerts/workflow', 'POST', wfMatrixToken, { id: 'alt-wf-transition', status: 'recovering' });
    assert.equal(nodeRes.status, 200, 'Node must allow assigned -> recovering');
    assert.equal(goRes.status, 200, 'Go must allow assigned -> recovering');
  });

  // 4.14 Workflow ID validation matrix
  const wfIdCases = [
    ['id null', { id: null, status: 'assigned' }, 400, 'Alert ID required'],
    ['id numeric', { id: 12345, status: 'assigned' }, 400, 'Alert ID required'],
    ['id empty string', { id: '', status: 'assigned' }, 400, 'Alert ID required'],
    ['id whitespace only', { id: ' \t ', status: 'assigned' }, 400, 'Alert ID required'],
    ['id exactly 80 ASCII units (unknown)', { id: 'a'.repeat(80), status: 'assigned' }, 404, 'Alert not found'],
    ['id more than 80 ASCII units', { id: 'a'.repeat(95), status: 'assigned' }, 404, 'Alert not found'],
  ];
  for (const [label, payload, wantStatus, wantError] of wfIdCases) {
    await verifyAsync(`POST /api/alerts/workflow: ${label}`, async () => {
      const nodeRes = await callNode('/api/alerts/workflow', 'POST', wfMatrixToken, payload);
      const goRes = await callGo('/api/alerts/workflow', 'POST', wfMatrixToken, payload);
      assert.equal(nodeRes.status, wantStatus, `Node status for ${label}`);
      assert.equal(goRes.status, wantStatus, `Go status for ${label}`);
      assert.deepEqual(nodeRes.body, { error: wantError });
      assert.deepEqual(goRes.body, { error: wantError });
    });
  }

  // 4.15 Workflow status validation matrix (status is never trimmed or case-folded)
  const wfStatusCases = [
    ['status missing', { id: 'alt-wf-transition' }, 400],
    ['status null', { id: 'alt-wf-transition', status: null }, 400],
    ['status numeric', { id: 'alt-wf-transition', status: 1 }, 400],
    ['status unknown', { id: 'alt-wf-transition', status: 'in_progress' }, 400],
    ['status uppercase', { id: 'alt-wf-transition', status: 'RESOLVED' }, 400],
    ['status mixed case', { id: 'alt-wf-transition', status: 'Resolved' }, 400],
    ['status leading whitespace', { id: 'alt-wf-transition', status: ' resolved' }, 400],
    ['status trailing whitespace', { id: 'alt-wf-transition', status: 'resolved ' }, 400],
  ];
  for (const [label, payload, wantStatus] of wfStatusCases) {
    await verifyAsync(`POST /api/alerts/workflow: ${label} returns 400`, async () => {
      const nodeRes = await callNode('/api/alerts/workflow', 'POST', wfMatrixToken, payload);
      const goRes = await callGo('/api/alerts/workflow', 'POST', wfMatrixToken, payload);
      assert.equal(nodeRes.status, wantStatus);
      assert.equal(goRes.status, wantStatus);
      assert.deepEqual(nodeRes.body, { error: 'Invalid alert workflow status' });
      assert.deepEqual(goRes.body, { error: 'Invalid alert workflow status' });
    });
  }

  // 4.16 assignedTo / note cleaning: omitted and undefined-after-cleaning preserve
  await verifyAsync('POST /api/alerts/workflow: cleaned-to-undefined assignedTo/note preserve existing values', async () => {
    for (const [label, assignedTo, note] of [
      ['empty strings', '', ''],
      ['whitespace only', '   ', '  \t '],
      ['non-string types', 42, { text: 'x' }],
    ]) {
      const payload = { id: 'alt-wf-preserve', status: 'assigned', assignedTo, note };
      const nodeRes = await callNode('/api/alerts/workflow', 'POST', wfMatrixToken, payload);
      const goRes = await callGo('/api/alerts/workflow', 'POST', wfMatrixToken, payload);
      assert.equal(nodeRes.status, 200, `Node ${label}`);
      assert.equal(goRes.status, 200, `Go ${label}`);
      assert.deepEqual(nodeRes.body, { success: true, matched: 1, modified: 1 });
      assert.deepEqual(goRes.body, { success: true, matched: 1, modified: 1 });

      const nodeDoc = await client.db(appDbNode).collection('app_alerts').findOne({ id: 'alt-wf-preserve' });
      const goDoc = await client.db(appDbGo).collection('app_alerts').findOne({ id: 'alt-wf-preserve' });
      assert.equal(nodeDoc.assigned_to, 'existing_assignee', `Node must preserve assigned_to for ${label}`);
      assert.equal(goDoc.assigned_to, 'existing_assignee', `Go must preserve assigned_to for ${label}`);
      assert.equal(nodeDoc.handling_note, 'existing note body', `Node must preserve handling_note for ${label}`);
      assert.equal(goDoc.handling_note, 'existing note body', `Go must preserve handling_note for ${label}`);
    }
  });

  await verifyAsync('POST /api/alerts/workflow: omitted assignedTo/note preserve existing values', async () => {
    const nodeRes = await callNode('/api/alerts/workflow', 'POST', wfMatrixToken, { id: 'alt-wf-preserve', status: 'recovering' });
    const goRes = await callGo('/api/alerts/workflow', 'POST', wfMatrixToken, { id: 'alt-wf-preserve', status: 'recovering' });
    assert.equal(nodeRes.status, 200);
    assert.equal(goRes.status, 200);

    const nodeDoc = await client.db(appDbNode).collection('app_alerts').findOne({ id: 'alt-wf-preserve' });
    const goDoc = await client.db(appDbGo).collection('app_alerts').findOne({ id: 'alt-wf-preserve' });
    assert.equal(nodeDoc.assigned_to, 'existing_assignee');
    assert.equal(goDoc.assigned_to, 'existing_assignee');
    assert.equal(nodeDoc.handling_note, 'existing note body');
    assert.equal(goDoc.handling_note, 'existing note body');
  });

  // 4.17 Non-resolved status must not invent acknowledgement fields
  await verifyAsync('POST /api/alerts/workflow: non-resolved status does not invent acknowledgement fields', async () => {
    const nodeRes = await callNode('/api/alerts/workflow', 'POST', wfMatrixToken, { id: 'alt-wf-resolved-ack', status: 'assigned' });
    const goRes = await callGo('/api/alerts/workflow', 'POST', wfMatrixToken, { id: 'alt-wf-resolved-ack', status: 'assigned' });
    assert.equal(nodeRes.status, 200);
    assert.equal(goRes.status, 200);

    for (const [label, db] of [['Node', appDbNode], ['Go', appDbGo]]) {
      const doc = await client.db(db).collection('app_alerts').findOne({ id: 'alt-wf-resolved-ack' });
      assert.equal(doc.is_acknowledged, false, `${label}: is_acknowledged must stay false`);
      assert.equal('acknowledged_at' in doc, false, `${label}: acknowledged_at must not be invented`);
      assert.equal('acknowledged_by' in doc, false, `${label}: acknowledged_by must not be invented`);
      assert.equal('workflow' in doc, false, `${label}: nested workflow model must not be invented`);
    }
  });

  await verifyAsync('POST /api/alerts/workflow: resolved sets is_acknowledged and flat fields only', async () => {
    const nodeRes = await callNode('/api/alerts/workflow', 'POST', wfMatrixToken, {
      id: 'alt-wf-resolved-ack',
      status: 'resolved',
      assignedTo: 'closer',
      note: 'fixed',
    });
    const goRes = await callGo('/api/alerts/workflow', 'POST', wfMatrixToken, {
      id: 'alt-wf-resolved-ack',
      status: 'resolved',
      assignedTo: 'closer',
      note: 'fixed',
    });
    assert.equal(nodeRes.status, 200);
    assert.equal(goRes.status, 200);

    for (const [label, db] of [['Node', appDbNode], ['Go', appDbGo]]) {
      const doc = await client.db(db).collection('app_alerts').findOne({ id: 'alt-wf-resolved-ack' });
      assert.equal(doc.is_acknowledged, true, `${label}: resolved must set is_acknowledged`);
      assert.equal(doc.workflow_status, 'resolved');
      assert.equal(doc.assigned_to, 'closer');
      assert.equal(doc.handling_note, 'fixed');
      assert.ok(doc.workflow_updated_at, `${label}: workflow_updated_at must be set`);
      assert.equal(typeof doc.workflow_updated_at, 'string');
      assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(doc.workflow_updated_at),
        `${label}: workflow_updated_at must be an ISO-8601 UTC timestamp`);
      assert.equal('workflow' in doc, false, `${label}: no nested workflow object`);
      assert.equal('workflow_updated_by' in doc, false);
    }
  });

  // 4.18 Unrelated alert fields must survive a workflow mutation
  await verifyAsync('POST /api/alerts/workflow: unrelated alert fields preserved', async () => {
    const nodeRes = await callNode('/api/alerts/workflow', 'POST', wfMatrixToken, {
      id: 'alt-wf-unrelated',
      status: 'assigned',
      assignedTo: 'keeper',
    });
    const goRes = await callGo('/api/alerts/workflow', 'POST', wfMatrixToken, {
      id: 'alt-wf-unrelated',
      status: 'assigned',
      assignedTo: 'keeper',
    });
    assert.equal(nodeRes.status, 200);
    assert.equal(goRes.status, 200);

    const nodeDoc = await client.db(appDbNode).collection('app_alerts').findOne({ id: 'alt-wf-unrelated' });
    const goDoc = await client.db(appDbGo).collection('app_alerts').findOne({ id: 'alt-wf-unrelated' });
    assert.deepEqual(nodeDoc.custom_metadata, { keep: 'this-must-survive', nested: [1, 2, 3] });
    assert.deepEqual(goDoc.custom_metadata, { keep: 'this-must-survive', nested: [1, 2, 3] });
    assert.equal(nodeDoc.reason, 'Unrelated field preservation probe');
    assert.equal(goDoc.reason, 'Unrelated field preservation probe');
    assert.equal(nodeDoc.level, 'CRITICAL');
    assert.equal(goDoc.level, 'CRITICAL');
    assert.equal(nodeDoc.imsi, '001010000000020');
    assert.equal(goDoc.imsi, '001010000000020');
  });

  // 4.19 Unicode / UTF-16 slicing parity for id, assignedTo and note
  const emojiChar = String.fromCodePoint(CP_EMOJI);
  const cjkChar = String.fromCodePoint(CP_CJK);
  const uniTextCases = [
    ['ascii-79', 'a'.repeat(79), 'a'.repeat(79)],
    ['ascii-80', 'a'.repeat(80), 'a'.repeat(80)],
    ['ascii-81', 'a'.repeat(81), 'a'.repeat(80)],
    ['cjk-79', cjkChar.repeat(79), cjkChar.repeat(79)],
    ['cjk-80', cjkChar.repeat(80), cjkChar.repeat(80)],
    ['cjk-81', cjkChar.repeat(81), cjkChar.repeat(80)],
    ['emoji-40', emojiChar.repeat(40), emojiChar.repeat(40)],
    ['emoji-41', emojiChar.repeat(41), emojiChar.repeat(40)],
    ['mixed-ascii-cjk-80', 'a'.repeat(40) + cjkChar.repeat(40), 'a'.repeat(40) + cjkChar.repeat(40)],
    ['mixed-ascii-cjk-81', 'a'.repeat(40) + cjkChar.repeat(41), 'a'.repeat(40) + cjkChar.repeat(40)],
    ['mixed-ascii-emoji-80', 'a'.repeat(78) + emojiChar, 'a'.repeat(78) + emojiChar],
    ['mixed-ascii-emoji-81', 'a'.repeat(78) + emojiChar + 'b', 'a'.repeat(78) + emojiChar],
    ['surrogate-straddle-79', 'a'.repeat(79) + emojiChar, 'a'.repeat(79) + String.fromCodePoint(0xfffd)],
    ['surrogate-straddle-79-tail', 'a'.repeat(79) + emojiChar + 'z'.repeat(12), 'a'.repeat(79) + String.fromCodePoint(0xfffd)],
    ['surrogate-straddle-cjk-79', cjkChar.repeat(79) + emojiChar + 'tail', cjkChar.repeat(79) + String.fromCodePoint(0xfffd)],
  ];

  await verifyAsync('POST /api/alerts/workflow: UTF-16 slicing parity for assignedTo and note', async () => {
    for (const [label, rawValue, expected] of uniTextCases) {
      for (const field of ['assignedTo', 'note']) {
        const payload = { id: 'alt-uni-note', status: 'assigned', [field]: `  ${rawValue}  ` };
        const nodeRes = await callNode('/api/alerts/workflow', 'POST', uniMatrixToken, payload);
        const goRes = await callGo('/api/alerts/workflow', 'POST', uniMatrixToken, payload);
        assert.equal(nodeRes.status, 200, `Node ${label}/${field} status`);
        assert.equal(goRes.status, 200, `Go ${label}/${field} status`);

        const dbField = field === 'assignedTo' ? 'assigned_to' : 'handling_note';
        const nodeDoc = await client.db(appDbNode).collection('app_alerts').findOne({ id: 'alt-uni-note' });
        const goDoc = await client.db(appDbGo).collection('app_alerts').findOne({ id: 'alt-uni-note' });
        const nodeVal = nodeDoc[dbField];
        const goVal = goDoc[dbField];

        // Node is the behavioral authority; Go must persist a byte-identical string.
        assert.equal(goVal, nodeVal, `Go ${dbField} must equal Node for ${label}`);
        assert.equal(Buffer.from(goVal, 'utf8').toString('hex'), Buffer.from(nodeVal, 'utf8').toString('hex'),
          `Go ${dbField} bytes must equal Node bytes for ${label}`);
        assert.equal(nodeVal, expected, `Node ${dbField} must match JS slice(0,80) for ${label}`);
        assert.ok(utf16Len(nodeVal) <= 80, `${label}: result must fit in 80 UTF-16 units`);
        assert.equal(utf16Len(nodeVal), Math.min(utf16Len(rawValue), 80), `${label}: unit count`);
        assert.ok(Buffer.from(nodeVal, 'utf8').toString('utf8') === nodeVal, `${label}: must stay valid UTF-8`);
      }
    }
  });

  await verifyAsync('POST /api/alerts/workflow: UTF-16 id truncation parity', async () => {
    // The seeded id is exactly 80 CJK code units, so a longer id must slice down
    // to it and resolve, while an over-long unknown id must miss.
    const longCjkId = cjkChar.repeat(95);
    const exactCjkId = cjkChar.repeat(80);

    const nodeRes = await callNode('/api/alerts/workflow', 'POST', uniMatrixToken, { id: longCjkId, status: 'recovering' });
    const goRes = await callGo('/api/alerts/workflow', 'POST', uniMatrixToken, { id: longCjkId, status: 'recovering' });
    assert.equal(nodeRes.status, 200, 'Node must resolve the truncated 80-unit id');
    assert.equal(goRes.status, 200, 'Go must resolve the truncated 80-unit id');
    assert.deepEqual(nodeRes.body, { success: true, matched: 1, modified: 1 });
    assert.deepEqual(goRes.body, { success: true, matched: 1, modified: 1 });

    const nodeDoc = await client.db(appDbNode).collection('app_alerts').findOne({ id: exactCjkId });
    const goDoc = await client.db(appDbGo).collection('app_alerts').findOne({ id: exactCjkId });
    assert.ok(nodeDoc, 'Node must have updated the 80-unit id document');
    assert.ok(goDoc, 'Go must have updated the 80-unit id document');
    assert.equal(nodeDoc.workflow_status, 'recovering');
    assert.equal(goDoc.workflow_status, 'recovering');

    // A surrogate-straddling id must also slice consistently on both sides.
    const straddleId = 'a'.repeat(79) + emojiChar + 'more-id-text';
    const nodeStraddle = await callNode('/api/alerts/workflow', 'POST', uniMatrixToken, { id: straddleId, status: 'assigned' });
    const goStraddle = await callGo('/api/alerts/workflow', 'POST', uniMatrixToken, { id: straddleId, status: 'assigned' });
    assert.equal(nodeStraddle.status, 404);
    assert.equal(goStraddle.status, 404);
    assert.deepEqual(nodeStraddle.body, { error: 'Alert not found' });
    assert.deepEqual(goStraddle.body, { error: 'Alert not found' });
  });

  console.log('\n--- Section 5: Best-Effort Audit Logging Evidence & Resilience ---');

  // 5.1 Verify Audit Log Evidence created in app_audit_logs (polled: best-effort writes are async)
  await verifyAsync('Verify operation logs recorded in app_audit_logs', async () => {
    async function hasLog(dbName, action) {
      return waitFor(
        `${action} operation log present in ${dbName}`,
        async () => {
          const log = await client.db(dbName).collection('app_audit_logs').findOne({ action });
          return log || null;
        },
        5000
      );
    }

    for (const [label, db] of [['Node', appDbNode], ['Go', appDbGo]]) {
      for (const action of ['alert.acknowledge', 'alert.workflow']) {
        const log = await hasLog(db, action);
        assert.equal(log.module, 'alerts', `${label} ${action} module`);
        assert.equal(log.result, 'success', `${label} ${action} result`);
        assert.equal(log.action, action);
        assert.ok(log.targetId, `${label} ${action} must carry a targetId`);
        assert.ok(log.actor, `${label} ${action} must carry actor metadata`);
      }
    }
  });

  // 5.1b Exactly one operation-log event per mutation: no duplicate audit events
  await verifyAsync('Exactly one operation-log event is written per alert mutation', async () => {
    const marker = 'alt-audit-dedupe';
    const docs = [{
      id: marker,
      timestamp: '2026-09-28T11:00:00.000Z',
      level: 'INFO',
      imsi: '001010000040001',
      reason: 'Audit dedupe probe',
      is_acknowledged: false,
    }];
    await client.db(appDbNode).collection('app_alerts').insertMany(docs);
    await client.db(appDbGo).collection('app_alerts').insertMany(docs);

    const nodeRes = await callNode('/api/alerts/acknowledge', 'POST', auditFailToken, { id: marker });
    const goRes = await callGo('/api/alerts/acknowledge', 'POST', auditFailToken, { id: marker });
    assert.equal(nodeRes.status, 200);
    assert.equal(goRes.status, 200);

    await waitForAuditCount(appDbNode, { action: 'alert.acknowledge', 'metadata.ids': marker }, 1);
    await waitForAuditCount(appDbGo, { action: 'alert.acknowledge', 'metadata.ids': marker }, 1);

    const nodeCount = await client.db(appDbNode).collection('app_audit_logs')
      .countDocuments({ action: 'alert.acknowledge', 'metadata.ids': marker });
    const goCount = await client.db(appDbGo).collection('app_audit_logs')
      .countDocuments({ action: 'alert.acknowledge', 'metadata.ids': marker });
    assert.equal(nodeCount, 1, 'Node must write exactly one operation-log event');
    assert.equal(goCount, 1, 'Go must write exactly one operation-log event');
  });

  // 5.1c Go alert mutation audit path uses the established BestEffort governance API
  verify('Go alert mutation audit path uses audit.Writer.WriteBestEffort', () => {
    const handlerSource = readFileSync(
      path.resolve(import.meta.dirname, '..', 'backend', 'internal', 'alert', 'handler.go'),
      'utf8'
    );
    assert.ok(handlerSource.includes('h.auditWriter.WriteBestEffort(input)'),
      'alert handler must submit operation logs through the established best-effort API');
    assert.ok(!/WriteStrict\(/.test(handlerSource),
      'alert handler must not block the business response on audit persistence');
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
      validationLevel: 'strict',
    });
    await client.db(appDbGo).command({
      collMod: 'app_audit_logs',
      validator: { $jsonSchema: { required: ['impossible_field_for_audit_failure_testing'] } },
      validationAction: 'error',
      validationLevel: 'strict',
    });

    try {
      // Execute acknowledge on alt-audit-fail-test
      const nodeRes = await callNode('/api/alerts/acknowledge', 'POST', auditFailToken, { id: 'alt-audit-fail-test' });
      const goRes = await callGo('/api/alerts/acknowledge', 'POST', auditFailToken, { id: 'alt-audit-fail-test' });

      // Both must succeed with 200 because audit logging is best-effort!
      assert.equal(nodeRes.status, 200, 'Node HTTP must stay success when operation logging fails');
      assert.equal(goRes.status, 200, 'Go HTTP must stay success when operation logging fails');
      assert.deepEqual(nodeRes.body, { success: true, acknowledged: 1, requested: 1, skipped: 0 });
      assert.deepEqual(goRes.body, { success: true, acknowledged: 1, requested: 1, skipped: 0 });

      // Verify business mutation was committed despite audit log failure
      const nodeDoc = await client.db(appDbNode).collection('app_alerts').findOne({ id: 'alt-audit-fail-test' });
      const goDoc = await client.db(appDbGo).collection('app_alerts').findOne({ id: 'alt-audit-fail-test' });
      assert.equal(nodeDoc.is_acknowledged, true, 'Node business mutation must be committed');
      assert.equal(goDoc.is_acknowledged, true, 'Go business mutation must be committed');

      // Business states must remain equivalent across Node and Go fixtures.
      const nodeState = { ...nodeDoc };
      const goState = { ...goDoc };
      delete nodeState._id;
      delete goState._id;
      assert.deepEqual(goState, nodeState, 'Node and Go business states must remain equivalent');

      // Operation log must be dropped, not duplicated, and must not alter the response.
      await new Promise((r) => setTimeout(r, 250));
      const nodeLogCount = await client.db(appDbNode).collection('app_audit_logs')
        .countDocuments({ action: 'alert.acknowledge', targetId: 'alt-audit-fail-test' });
      const goLogCount = await client.db(appDbGo).collection('app_audit_logs')
        .countDocuments({ action: 'alert.acknowledge', targetId: 'alt-audit-fail-test' });
      assert.equal(nodeLogCount, 0, 'Node must drop the operation-log event rather than duplicate it');
      assert.equal(goLogCount, 0, 'Go must drop the operation-log event rather than duplicate it');

      // Workflow mutation must show the same best-effort resilience.
      const nodeWf = await callNode('/api/alerts/workflow', 'POST', auditFailToken, {
        id: 'alt-audit-fail-test', status: 'assigned', note: 'audit down but mutation ok',
      });
      const goWf = await callGo('/api/alerts/workflow', 'POST', auditFailToken, {
        id: 'alt-audit-fail-test', status: 'assigned', note: 'audit down but mutation ok',
      });
      assert.equal(nodeWf.status, 200, 'Node workflow HTTP must stay success when operation logging fails');
      assert.equal(goWf.status, 200, 'Go workflow HTTP must stay success when operation logging fails');
      assert.deepEqual(nodeWf.body, { success: true, matched: 1, modified: 1 });
      assert.deepEqual(goWf.body, { success: true, matched: 1, modified: 1 });

      const nodeWfDoc = await client.db(appDbNode).collection('app_alerts').findOne({ id: 'alt-audit-fail-test' });
      const goWfDoc = await client.db(appDbGo).collection('app_alerts').findOne({ id: 'alt-audit-fail-test' });
      assert.equal(nodeWfDoc.workflow_status, 'assigned');
      assert.equal(goWfDoc.workflow_status, 'assigned');
      assert.equal(nodeWfDoc.handling_note, 'audit down but mutation ok');
      assert.equal(goWfDoc.handling_note, 'audit down but mutation ok');

      const nodeWfLogCount = await client.db(appDbNode).collection('app_audit_logs')
        .countDocuments({ action: 'alert.workflow', targetId: 'alt-audit-fail-test' });
      const goWfLogCount = await client.db(appDbGo).collection('app_audit_logs')
        .countDocuments({ action: 'alert.workflow', targetId: 'alt-audit-fail-test' });
      assert.equal(nodeWfLogCount, 0, 'Node must drop the workflow operation-log event');
      assert.equal(goWfLogCount, 0, 'Go must drop the workflow operation-log event');
    } finally {
      // Restore schema validator
      await client.db(appDbNode).command({ collMod: 'app_audit_logs', validator: {} });
      await client.db(appDbGo).command({ collMod: 'app_audit_logs', validator: {} });
    }
  });

  console.log('\n--- Section 6: Paired Real Node/Go Repository-Failure Parity ---');
  console.log('  (both sides run real TCP HTTP -> production route -> repository -> isolated failing DB dependency)');

  /**
   * Runs the paired Node/Go repository-failure comparison for one endpoint.
   *
   * Failure mechanism: an always-false schema validator is installed on the
   * app_alerts collection in each fixture database. The production Node route
   * and the Go handler both execute their real repository write against that
   * collection, and MongoDB rejects the write (error 121). This is an isolated
   * infrastructure failure - no environment switch, header, query parameter,
   * CLI flag or production config field can enable it in a normal deployment.
   */
  async function runRepositoryFailureParity({ endpoint, label, payload, expectedBody, targetIds }) {
    const snapshot = async (dbName) => {
      const docs = await client.db(dbName).collection('app_alerts').find({ id: { $in: targetIds } }).sort({ id: 1 }).toArray();
      return docs.map((d) => {
        const copy = { ...d };
        delete copy._id;
        return copy;
      });
    };

    const nodeBefore = await snapshot(appDbNode);
    const goBefore = await snapshot(appDbGo);

    await client.db(appDbNode).command({
      collMod: 'app_alerts',
      validator: { $expr: { $eq: [1, 2] } },
      validationAction: 'error',
      validationLevel: 'strict',
    });
    await client.db(appDbGo).command({
      collMod: 'app_alerts',
      validator: { $expr: { $eq: [1, 2] } },
      validationAction: 'error',
      validationLevel: 'strict',
    });

    let nodeRes;
    let goRes;
    try {
      nodeRes = await callNode(endpoint, 'POST', repoFailToken, payload);
      goRes = await callGo(endpoint, 'POST', repoFailToken, payload);
    } finally {
      await client.db(appDbNode).command({ collMod: 'app_alerts', validator: {} });
      await client.db(appDbGo).command({ collMod: 'app_alerts', validator: {} });
    }

    const nodeAfter = await snapshot(appDbNode);
    const goAfter = await snapshot(appDbGo);

    const nodeUnchanged = JSON.stringify(nodeBefore) === JSON.stringify(nodeAfter);
    const goUnchanged = JSON.stringify(goBefore) === JSON.stringify(goAfter);

    console.log(`[mutation-parity] endpoint=${endpoint}`);
    console.log(`[mutation-parity] case=repository_failure`);
    console.log(`[mutation-parity] scenario=${label}`);
    console.log(`[mutation-parity] Node HTTP status=${nodeRes.status}`);
    console.log(`[mutation-parity] Node HTTP body=${JSON.stringify(nodeRes.body)}`);
    console.log(`[mutation-parity] Go HTTP status=${goRes.status}`);
    console.log(`[mutation-parity] Go HTTP body=${JSON.stringify(goRes.body)}`);
    console.log(`[mutation-parity] Node persistent state=${nodeUnchanged ? 'UNCHANGED' : 'CHANGED'}`);
    console.log(`[mutation-parity] Go persistent state=${goUnchanged ? 'UNCHANGED' : 'CHANGED'}`);

    // Status parity
    assert.equal(nodeRes.status, 500, `Node ${endpoint} must return 500 on repository failure`);
    assert.equal(goRes.status, 500, `Go ${endpoint} must return 500 on repository failure`);
    assert.equal(goRes.status, nodeRes.status, `${endpoint} status parity`);

    // Body parity
    assert.deepEqual(nodeRes.body, expectedBody, `Node ${endpoint} error body`);
    assert.deepEqual(goRes.body, expectedBody, `Go ${endpoint} error body`);
    assert.equal(JSON.stringify(goRes.body), JSON.stringify(nodeRes.body), `${endpoint} body parity`);

    // Persistent-state parity
    assert.ok(nodeUnchanged, `Node fixture persistent state must be UNCHANGED for ${endpoint}`);
    assert.ok(goUnchanged, `Go fixture persistent state must be UNCHANGED for ${endpoint}`);
    assert.deepEqual(goAfter, nodeAfter, `${endpoint} persistent state parity`);

    console.log('[mutation-parity] PARITY=PASS');
  }

  await verifyAsync('POST /api/alerts/acknowledge: paired real Node/Go repository-failure parity', async () => {
    await runRepositoryFailureParity({
      endpoint: '/api/alerts/acknowledge',
      label: 'acknowledge',
      payload: { ids: ['alt-repo-fail-1', 'alt-repo-fail-2'] },
      expectedBody: { error: 'Failed to acknowledge alert' },
      targetIds: ['alt-repo-fail-1', 'alt-repo-fail-2'],
    });
  });

  await verifyAsync('POST /api/alerts/workflow: paired real Node/Go repository-failure parity', async () => {
    await runRepositoryFailureParity({
      endpoint: '/api/alerts/workflow',
      label: 'workflow',
      payload: { id: 'alt-repo-fail-2', status: 'resolved', assignedTo: 'do-not-persist', note: 'do-not-persist' },
      expectedBody: { error: 'Failed to update alert workflow' },
      targetIds: ['alt-repo-fail-1', 'alt-repo-fail-2'],
    });
  });

  // 6.3 The Go test-only failure server remains available as an independent
  // repository-failure witness (disconnected dependency, no production switch).
  await verifyAsync('Go test-only failure server still rejects alert mutations with 500', async () => {
    const goFailAck = await callGoFail('/api/alerts/acknowledge', 'POST', operatorToken, { id: 'alt-001' });
    assert.equal(goFailAck.status, 500);
    assert.deepEqual(goFailAck.body, { error: 'Failed to acknowledge alert' });

    const goFailWf = await callGoFail('/api/alerts/workflow', 'POST', operatorToken, { id: 'alt-001', status: 'assigned' });
    assert.equal(goFailWf.status, 500);
    assert.deepEqual(goFailWf.body, { error: 'Failed to update alert workflow' });
  });

  console.log('\n--- Section 7: Zero Unrelated Business Domain Mutation (content-level guard) ---');

  await verifyAsync('Content-level fingerprints unchanged across 10 protected business collections', async () => {
    for (const [dbKind, name] of PROTECTED_COLLECTIONS) {
      for (const which of ['Node', 'Go']) {
        const dbName = which === 'Node'
          ? (dbKind === 'xcloud' ? xcloudDbNode : appDbNode)
          : (dbKind === 'xcloud' ? xcloudDbGo : appDbGo);
        const key = `${dbKind}.${name}`;
        const after = await fingerprintCollection(client.db(dbName), name);
        const before = protectedBefore[which][key];

        assert.equal(after.count, before.count,
          `${which} ${key}: document count must be unchanged (before=${before.count}, after=${after.count})`);
        assert.equal(after.digest, before.digest,
          `${which} ${key}: content fingerprint must be unchanged (count-only comparison is insufficient)`);
        console.log(`  [mutation-guard] ${which} ${key}: count=${after.count} digest=${after.digest.slice(0, 16)} UNCHANGED`);
      }
    }
  });

  await verifyAsync('Only app_alerts, app_audit_logs and app_rate_limits carry Phase 7.2 mutations', async () => {
    // Direct Execution: no approval workflow records may appear.
    for (const [dbName, label] of [[appDbNode, 'Node'], [appDbGo, 'Go']]) {
      const approvals = await client.db(dbName).collection('app_approvals').countDocuments();
      assert.equal(approvals, 0, `${label}: app_approvals must remain 0 (Direct Execution, no Approval workflow)`);

      // The intentional business target is app_alerts.
      const alerts = await client.db(dbName).collection('app_alerts').countDocuments();
      assert.ok(alerts > 0, `${label}: app_alerts must hold the intentional business mutations`);

      // Operation logging and rate-limit infrastructure are the only other writers.
      const auditLogs = await client.db(dbName).collection('app_audit_logs').countDocuments();
      assert.ok(auditLogs > 0, `${label}: app_audit_logs must hold operation-log evidence`);
    }
    console.log('  [mutation-guard] allowed mutation domains = app_alerts (business), app_audit_logs (operation log), app_rate_limits (rate-limit infrastructure)');
    console.log('  [mutation-guard] unexpected mutation of any other collection = NONE');
  });

  await verifyAsync('Production source exposes no Alert mutation fault switch', async () => {
    const forbiddenTriggers = [
      'TEST_FAIL_ALERT_MUTATIONS',
      'FAIL_ALERT_REPOSITORY',
      'TEST_FAIL_AUDIT',
      'FAIL_ALERT_AUDIT',
      'ALERT_FAULT',
    ];
    const roots = [
      path.resolve(import.meta.dirname, '..', 'backend', 'internal'),
      path.resolve(import.meta.dirname, '..', 'backend', 'cmd', 'server'),
      path.resolve(import.meta.dirname, '..', 'frontend', 'src'),
    ];

    function walk(dir, acc = []) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, acc);
        else if (/\.(go|ts|tsx|js|mjs)$/.test(entry.name)) acc.push(full);
      }
      return acc;
    }

    const scanned = roots.flatMap((root) => (existsSync(root) ? walk(root) : []));
    assert.ok(scanned.length > 0, 'must scan production sources');
    for (const file of scanned) {
      const source = readFileSync(file, 'utf8');
      for (const trigger of forbiddenTriggers) {
        assert.ok(!source.includes(trigger), `${file} must not reference fault-switch trigger ${trigger}`);
      }
    }

    // The production server binary must not carry a legacy failure trigger either.
    assert.ok(existsSync(binPath), 'production Go binary must exist');
    const binary = readFileSync(binPath);
    for (const trigger of ['TEST_FAIL_ALERT_MUTATIONS', 'FAIL_ALERT_REPOSITORY']) {
      assert.ok(!binary.includes(Buffer.from(trigger)), `production binary must not contain ${trigger}`);
    }
    console.log(`  [fault-switch] scanned ${scanned.length} production source files: no Alert mutation fault switch`);
    console.log('  [fault-switch] production binary contains no Alert mutation fault trigger');
    console.log('  [fault-switch] test failure architecture = isolated MongoDB schema validation + dedicated test-only Go testserver');
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

  verify('Alert mutations remain Node production-owned (not cut over)', () => {
    for (const ep of ['/api/alerts/acknowledge', '/api/alerts/workflow']) {
      const match = CUTOVER_TABLE.find((r) => r.path === ep);
      assert.ok(!match, `${ep} must not be routed to Go in Phase 7.2`);
      assert.ok(!CUTOVER_TABLE.some((r) => r.path === ep && r.owner === 'go'),
        `${ep} production owner must remain Node`);
    }
    // The production Node routes must still be the authoritative implementations.
    for (const route of ['acknowledge', 'workflow']) {
      const routeFile = path.resolve(
        import.meta.dirname, '..', 'frontend', 'src', 'app', 'api', 'alerts', route, 'route.ts'
      );
      assert.ok(existsSync(routeFile), `Node production route for /api/alerts/${route} must exist`);
    }
  });

  verify('No Phase 7.3 / 7.4 / 7.5 implementation expansion', () => {
    // No production cutover for the deferred Phase 7.3 / 7.4 endpoints.
    for (const ep of ['/api/notifications/stream', '/api/system/audit/heal', '/api/system/audit/batch-heal']) {
      const match = CUTOVER_TABLE.find((r) => r.path === ep);
      assert.ok(!match, `${ep} must not be cut over in Phase 7.2`);
    }

    // No Go implementation expansion for those endpoints in the production router.
    const serverMain = readFileSync(
      path.resolve(import.meta.dirname, '..', 'backend', 'cmd', 'server', 'main.go'),
      'utf8'
    );
    for (const ep of ['/api/notifications/stream', '/api/system/audit/heal', '/api/system/audit/batch-heal']) {
      assert.ok(!serverMain.includes(ep), `Go production router must not implement ${ep} in Phase 7.2`);
    }
    assert.ok(!serverMain.includes('POST /api/system/audit/batch-heal'));
  });

  console.log('\n========================================================================');
  console.log('Phase 7.2 Alert Mutation Parity Suite Summary');
  console.log('');
  console.log(`TOTAL: ${totalChecks}`);
  console.log(`PASS:  ${passed}`);
  console.log(`FAIL:  ${failed}`);
  console.log(`SKIP:  ${skipped}`);
  console.log('========================================================================\n');

  console.log('Phase 7.2 evidence summary');
  console.log('  paired Node/Go repository-failure cases: 2 (acknowledge, workflow)');
  console.log('  mandatory acknowledge matrix: covered');
  console.log('  mandatory workflow matrix: covered');
  console.log('  Unicode matrix: ASCII / CJK / emoji / surrogate / 79-80-81 units');
  console.log('  operation-log resilience: best-effort, no rollback, no duplicate');
  console.log('  content-level mutation guard: 10 protected collections');
  console.log('');

  if (failed > 0 || skipped > 0) {
    process.exitCode = 1;
  }
  await cleanup();
}

main().catch(async (err) => {
  console.error('Fatal test error:', err);
  process.exitCode = 1;
  await cleanup();
});
