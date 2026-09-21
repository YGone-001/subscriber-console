#!/usr/bin/env node
/**
 * Phase 5.4-B — Balance Governance Controlled Production Cutover Integration Harness
 *
 * Validates authoritative Go production ownership of:
 * - POST /api/ocs/balances/{imsi}/adjust (owner: go)
 * - POST /api/ocs/balances/{imsi}/reset (owner: go, permanently disabled)
 *
 * Verifies:
 * 1. Direct Governance Matrix (super_admin, root) -> 200 OK, executed, version CAS, strict audit
 * 2. Approval Governance Matrix (operator, ops_admin) -> 202 Accepted, approval_required, 0 balance mutations
 * 3. Role Denial Matrix (auditor, viewer) -> 403 Forbidden, 0 mutations
 * 4. Failure Matrix (CAS 409, invalid bucket 400, invalid op 400, zero/negative amount 400, missing reason 400, not found 404)
 * 5. Reset Role Matrix (root, super_admin, ops_admin, operator, auditor, viewer) -> 400 BALANCE_RESET_DISABLED, 0 writes, 0 approvals
 * 6. Production Ingress & Unreachable (401 unauth, 502 GO_BACKEND_UNREACHABLE on backend down, 0 mutations, no fallback)
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { execSync, spawn } from 'node:child_process';
import { MongoClient, Long } from 'mongodb';
import { createJiti } from 'jiti';
import nextEnv from '@next/env';
import { SignJWT } from 'jose';

nextEnv.loadEnvConfig(process.cwd());

// Suppress known audit scheduling messages during test run
const originalConsoleError = console.error;
console.error = (...args) => {
  if (typeof args[0] === 'string' && (args[0].includes('Audit scheduling failed') || args[0].includes('Go backend unreachable'))) {
    return;
  }
  originalConsoleError(...args);
};

const startedAt = Date.now();
const suffix = `${Date.now()}_${process.pid}_${Math.floor(Math.random() * 100000)}`;
const xcloudDbName = `xcloud_cutover_${suffix}`;
const appDbName = `xcloud_ops_cutover_${suffix}`;
const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/xcloud';

process.env.MONGODB_XCLOUD_DB = xcloudDbName;
process.env.MONGODB_APP_DB = appDbName;
const JWT_SECRET_STRING = process.env.JWT_SECRET || 'phase5-4-b-cutover-secret-at-least-32-bytes-long';
process.env.JWT_SECRET = JWT_SECRET_STRING;

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  alias: {
    '@': new URL('../frontend/src/', import.meta.url).pathname,
    'next/server': new URL('../frontend/node_modules/next/server.js', import.meta.url).pathname,
  },
});

const { NextRequest } = jiti('next/server');
const { proxy } = jiti('../frontend/src/proxy.ts');
const { getJwtSecretKey } = jiti('../frontend/src/lib/security.ts');
const { getMongoClient } = jiti('../frontend/src/lib/mongo.ts');

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

function numberValue(val) {
  if (val === undefined || val === null) return 0;
  return Long.isLong(val) ? val.toNumber() : Number(val);
}

function makeBalanceDoc(imsi, {
  dataTotal = 1000,
  dataUsed = 300,
  dataReserved = 500,
  dataAvailable = 200,
  voiceTotal = 500,
  voiceUsed = 100,
  voiceReserved = 100,
  voiceAvailable = 300,
  smsTotal = 100,
  smsUsed = 20,
  smsReserved = 0,
  smsAvailable = 80,
  version = 10,
  status = 'active',
} = {}) {
  return {
    imsi,
    data_total: Long.fromNumber(dataTotal),
    data_used: Long.fromNumber(dataUsed),
    data_reserved: Long.fromNumber(dataReserved),
    data_available: Long.fromNumber(dataAvailable),
    voice_total: Long.fromNumber(voiceTotal),
    voice_used: Long.fromNumber(voiceUsed),
    voice_reserved: Long.fromNumber(voiceReserved),
    voice_available: Long.fromNumber(voiceAvailable),
    sms_total: Long.fromNumber(smsTotal),
    sms_used: Long.fromNumber(smsUsed),
    sms_reserved: Long.fromNumber(smsReserved),
    sms_available: Long.fromNumber(smsAvailable),
    status,
    version: Long.fromNumber(version),
    updated_at: new Date(),
  };
}

let goProc = null;
let nodeServer = null;
let binPath = null;
const checks = [];

function recordCheck(name) {
  checks.push(name);
  console.log(`  ✓ ${name}`);
}

try {
  await client.connect();
  const xcloud = client.db(xcloudDbName);
  const app = client.db(appDbName);

  // 1. Initialize indexes
  await xcloud.collection('ocs_balances').createIndex({ imsi: 1 }, { unique: true });
  await app.collection('app_approvals').createIndex({ id: 1 }, { unique: true });
  await app.collection('app_users').createIndex({ username: 1 }, { unique: true });
  await app.collection('ocs_balance_adjustments').createIndexes([
    { key: { adjustmentId: 1 }, unique: true, name: 'uniq_ocs_balance_adjustment_id' },
    { key: { executionId: 1 }, unique: true, name: 'uniq_ocs_balance_execution_id' },
  ]);

  // 2. Seed test actors across all governance roles
  const testUsers = [
    { username: 'cutover_root', role: 'root' },
    { username: 'cutover_admin', role: 'super_admin' },
    { username: 'cutover_ops', role: 'ops_admin' },
    { username: 'cutover_operator', role: 'operator' },
    { username: 'cutover_auditor', role: 'auditor' },
    { username: 'cutover_viewer', role: 'viewer' },
  ];

  await app.collection('app_users').insertMany(
    testUsers.map((u) => ({
      username: u.username,
      role: u.role,
      status: 'active',
      security: { sessionVersion: 1 },
      createdAt: new Date().toISOString(),
    }))
  );

  // 3. Issue signed JWT tokens
  const secretKey = getJwtSecretKey();
  const now = Math.floor(Date.now() / 1000);
  const tokens = {};

  for (const u of testUsers) {
    tokens[u.role] = await new SignJWT({ username: u.username, role: u.role, sv: 1 })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(secretKey);
  }

  // 4. Build & start Go backend
  const goPort = await getAvailablePort();
  const isWin = process.platform === 'win32';
  const binName = isWin ? `test-go-cutover-${suffix}.exe` : `test-go-cutover-${suffix}`;
  binPath = path.resolve('backend', binName);

  execSync(`go build -o "${binPath}" ./cmd/server`, {
    cwd: path.resolve('backend'),
    stdio: 'ignore',
  });

  goProc = spawn(binPath, [], {
    cwd: path.resolve('backend'),
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

  // Wait for Go backend to report ready on /healthz
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
  assert(goReady, 'Go backend server failed to become ready');
  process.env.GO_BACKEND_URL = `http://127.0.0.1:${goPort}`;

  // 5. Start Next.js Proxy Ingress HTTP server
  const nodePort = await getAvailablePort();
  nodeServer = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const rawBody = Buffer.concat(chunks);
      const fullUrl = `http://127.0.0.1:${nodePort}${req.url}`;

      const nextReq = new NextRequest(fullUrl, {
        method: req.method,
        headers: req.headers,
        body: rawBody.length > 0 ? rawBody : undefined,
      });

      const proxyRes = await proxy(nextReq);
      const resBody = Buffer.from(await proxyRes.arrayBuffer());
      res.writeHead(proxyRes.status, Object.fromEntries(proxyRes.headers.entries()));
      res.end(resBody);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err) }));
    }
  });

  await new Promise((resolve) => nodeServer.listen(nodePort, '127.0.0.1', resolve));

  console.log(`\n── Phase 5.4-B Controlled Cutover Test Harness ──`);
  console.log(`Go Port: ${goPort} | Proxy Ingress Port: ${nodePort}\n`);

  // Helper to send requests through Next.js proxy ingress
  async function requestViaProxy(urlPath, { method = 'POST', token, body } = {}) {
    const headers = {};
    if (token) headers['cookie'] = `auth_token=${token}`;
    if (body) headers['content-type'] = 'application/json';

    const res = await fetch(`http://127.0.0.1:${nodePort}${urlPath}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    let data;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { status: res.status, headers: res.headers, data };
  }

  // ══════════════════════════════════════════════════════════════════
  // Section 1: Ingress Authentication Boundary
  // ══════════════════════════════════════════════════════════════════
  console.log('1. Ingress Authentication Boundary');
  {
    const unauth = await requestViaProxy('/api/ocs/balances/460020000000001/adjust', {
      body: { bucket: 'data', operation: 'credit', amount: 100, reason: 'unauthorized test' },
    });
    assert.equal(unauth.status, 401, 'Unauthenticated balance request must return 401');
    assert.equal(unauth.data?.code, 'AUTH_INVALID_TOKEN');
    recordCheck('ingress.unauthenticated_rejected_401');
  }

  // ══════════════════════════════════════════════════════════════════
  // Section 2: Direct Governance Matrix (super_admin, root)
  // ══════════════════════════════════════════════════════════════════
  console.log('\n2. Direct Governance Matrix (super_admin / root)');
  const DIRECT_CASES = [
    {
      name: 'super_admin.data_credit',
      role: 'super_admin',
      imsi: '460020000001001',
      initial: { dataTotal: 1000, dataUsed: 300, dataReserved: 500, dataAvailable: 200, version: 10 },
      body: { bucket: 'data', operation: 'credit', amount: 100, reason: 'Direct data credit compensation' },
      assertDb: (doc) => {
        assert.equal(numberValue(doc.data_total), 1100);
        assert.equal(numberValue(doc.data_available), 300);
        assert.equal(numberValue(doc.data_used), 300);
        assert.equal(numberValue(doc.data_reserved), 500);
        assert.equal(numberValue(doc.version), 11);
      },
    },
    {
      name: 'super_admin.voice_debit',
      role: 'super_admin',
      imsi: '460020000001002',
      initial: { voiceTotal: 500, voiceUsed: 100, voiceReserved: 100, voiceAvailable: 300, version: 5 },
      body: { bucket: 'voice', operation: 'debit', amount: 50, reason: 'Direct voice debit correction' },
      assertDb: (doc) => {
        assert.equal(numberValue(doc.voice_total), 450);
        assert.equal(numberValue(doc.voice_available), 250);
        assert.equal(numberValue(doc.voice_used), 100);
        assert.equal(numberValue(doc.voice_reserved), 100);
        assert.equal(numberValue(doc.version), 6);
      },
    },
    {
      name: 'super_admin.sms_credit',
      role: 'super_admin',
      imsi: '460020000001003',
      initial: { smsTotal: 100, smsUsed: 20, smsReserved: 0, smsAvailable: 80, version: 1 },
      body: { bucket: 'sms', operation: 'credit', amount: 25, reason: 'Direct SMS credit bonus' },
      assertDb: (doc) => {
        assert.equal(numberValue(doc.sms_total), 125);
        assert.equal(numberValue(doc.sms_available), 105);
        assert.equal(numberValue(doc.sms_used), 20);
        assert.equal(numberValue(doc.version), 2);
      },
    },
    {
      name: 'root.data_credit_legacy_super_admin',
      role: 'root',
      imsi: '460020000001004',
      initial: { dataTotal: 500, dataUsed: 100, dataReserved: 200, dataAvailable: 200, version: 20 },
      body: { bucket: 'data', operation: 'credit', amount: 50, reason: 'Root legacy data credit' },
      assertDb: (doc) => {
        assert.equal(numberValue(doc.data_total), 550);
        assert.equal(numberValue(doc.data_available), 250);
        assert.equal(numberValue(doc.version), 21);
      },
    },
  ];

  for (const c of DIRECT_CASES) {
    await xcloud.collection('ocs_balances').insertOne(makeBalanceDoc(c.imsi, c.initial));

    const res = await requestViaProxy(`/api/ocs/balances/${c.imsi}/adjust`, {
      token: tokens[c.role],
      body: c.body,
    });

    assert.equal(res.status, 200, `${c.name}: must return 200 OK, got ${res.status}`);
    assert.equal(res.data?.ok, true, `${c.name}: body.ok must be true`);
    assert.equal(res.data?.outcome, 'executed', `${c.name}: outcome must be 'executed'`);

    const updated = await xcloud.collection('ocs_balances').findOne({ imsi: c.imsi });
    assert.ok(updated, `${c.name}: balance document must exist`);
    c.assertDb(updated);

    // Verify strict audit was written
    const auditLog = await app.collection('app_audit_logs').findOne({
      action: 'BALANCE_ADJUST',
      targetId: `balance:${c.imsi}`,
      result: 'success',
    });
    assert.ok(auditLog, `${c.name}: strict audit log must be persisted`);
    recordCheck(`direct.${c.name}`);
  }

  // ══════════════════════════════════════════════════════════════════
  // Section 3: Approval Governance Matrix (operator, ops_admin)
  // ══════════════════════════════════════════════════════════════════
  console.log('\n3. Approval Governance Matrix (operator / ops_admin)');
  const APPROVAL_CASES = [
    {
      name: 'operator.data_credit',
      role: 'operator',
      imsi: '460020000002001',
      initial: { dataTotal: 1000, dataUsed: 300, dataReserved: 500, dataAvailable: 200, version: 10 },
      body: { bucket: 'data', operation: 'credit', amount: 200, reason: 'Operator requested data credit' },
    },
    {
      name: 'operator.voice_debit',
      role: 'operator',
      imsi: '460020000002002',
      initial: { voiceTotal: 500, voiceUsed: 100, voiceReserved: 100, voiceAvailable: 300, version: 10 },
      body: { bucket: 'voice', operation: 'debit', amount: 100, reason: 'Operator requested voice debit' },
    },
    {
      name: 'operator.sms_credit',
      role: 'operator',
      imsi: '460020000002003',
      initial: { smsTotal: 100, smsUsed: 20, smsReserved: 0, smsAvailable: 80, version: 10 },
      body: { bucket: 'sms', operation: 'credit', amount: 30, reason: 'Operator requested SMS credit' },
    },
    {
      name: 'ops_admin.data_debit',
      role: 'ops_admin',
      imsi: '460020000002004',
      initial: { dataTotal: 1000, dataUsed: 300, dataReserved: 500, dataAvailable: 200, version: 10 },
      body: { bucket: 'data', operation: 'debit', amount: 50, reason: 'Ops admin requested data debit' },
    },
  ];

  for (const c of APPROVAL_CASES) {
    await xcloud.collection('ocs_balances').insertOne(makeBalanceDoc(c.imsi, c.initial));

    const res = await requestViaProxy(`/api/ocs/balances/${c.imsi}/adjust`, {
      token: tokens[c.role],
      body: c.body,
    });

    assert.equal(res.status, 202, `${c.name}: must return 202 Accepted, got ${res.status}`);
    assert.equal(res.data?.outcome, 'approval_required', `${c.name}: outcome must be approval_required`);
    assert.ok(res.data?.approvalId, `${c.name}: approvalId must be present`);

    // Invariant: ZERO balance mutation occurs on approval creation
    const docAfter = await xcloud.collection('ocs_balances').findOne({ imsi: c.imsi });
    assert.equal(numberValue(docAfter.version), 10, `${c.name}: version must remain unchanged`);
    assert.equal(numberValue(docAfter.data_total), c.initial.dataTotal ?? 1000);
    assert.equal(numberValue(docAfter.data_available), c.initial.dataAvailable ?? 200);

    // Verify approval request created in app_approvals
    const approvalDoc = await app.collection('app_approvals').findOne({ id: res.data.approvalId });
    assert.ok(approvalDoc, `${c.name}: approval record must be created`);
    assert.equal(approvalDoc.status, 'pending', `${c.name}: approval status must be pending`);
    recordCheck(`approval.${c.name}`);
  }

  // ══════════════════════════════════════════════════════════════════
  // Section 4: Role Denial Matrix (auditor, viewer)
  // ══════════════════════════════════════════════════════════════════
  console.log('\n4. Role Denial Matrix (auditor / viewer)');
  const DENIAL_CASES = [
    { role: 'auditor', imsi: '460020000003001' },
    { role: 'viewer', imsi: '460020000003002' },
  ];

  for (const c of DENIAL_CASES) {
    await xcloud.collection('ocs_balances').insertOne(makeBalanceDoc(c.imsi, { version: 1 }));

    const res = await requestViaProxy(`/api/ocs/balances/${c.imsi}/adjust`, {
      token: tokens[c.role],
      body: { bucket: 'data', operation: 'credit', amount: 100, reason: 'Unauthorized role attempt' },
    });

    assert.equal(res.status, 403, `${c.role}: must be denied with 403 Forbidden, got ${res.status}`);

    const docAfter = await xcloud.collection('ocs_balances').findOne({ imsi: c.imsi });
    assert.equal(numberValue(docAfter.version), 1, `${c.role}: balance must not mutate`);
    recordCheck(`denial.${c.role}`);
  }

  // ══════════════════════════════════════════════════════════════════
  // Section 5: Failure & Validation Matrix
  // ══════════════════════════════════════════════════════════════════
  console.log('\n5. Failure & Validation Matrix');
  const FAILURE_CASES = [
    {
      name: 'cas_stale_precondition_409',
      imsi: '460020000004001',
      seed: { version: 10 },
      body: { bucket: 'data', operation: 'credit', amount: 100, reason: 'stale cas', version: 9 },
      expectedStatus: 409,
      expectedCode: 'BALANCE_PRECONDITION_CHANGED',
    },
    {
      name: 'invalid_bucket_400',
      imsi: '460020000004002',
      seed: { version: 1 },
      body: { bucket: 'bandwidth', operation: 'credit', amount: 100, reason: 'invalid bucket' },
      expectedStatus: 400,
      expectedCode: 'INVALID_BUCKET',
    },
    {
      name: 'invalid_operation_400',
      imsi: '460020000004003',
      seed: { version: 1 },
      body: { bucket: 'data', operation: 'transfer', amount: 100, reason: 'invalid op' },
      expectedStatus: 400,
      expectedCode: 'INVALID_OPERATION',
    },
    {
      name: 'zero_amount_400',
      imsi: '460020000004004',
      seed: { version: 1 },
      body: { bucket: 'data', operation: 'credit', amount: 0, reason: 'zero amount' },
      expectedStatus: 400,
      expectedCode: 'INVALID_AMOUNT',
    },
    {
      name: 'negative_amount_400',
      imsi: '460020000004005',
      seed: { version: 1 },
      body: { bucket: 'data', operation: 'credit', amount: -50, reason: 'negative amount' },
      expectedStatus: 400,
      expectedCode: 'INVALID_AMOUNT',
    },
    {
      name: 'missing_reason_400',
      imsi: '460020000004006',
      seed: { version: 1 },
      body: { bucket: 'data', operation: 'credit', amount: 100, reason: '   ' },
      expectedStatus: 400,
      expectedCode: 'REASON_REQUIRED',
    },
    {
      name: 'insufficient_balance_debit_400',
      imsi: '460020000004007',
      seed: { dataAvailable: 200, dataTotal: 1000, dataUsed: 300, dataReserved: 500, version: 1 },
      body: { bucket: 'data', operation: 'debit', amount: 300, reason: 'excessive debit' },
      expectedStatus: 400,
      expectedCode: 'INSUFFICIENT_BALANCE',
    },
    {
      name: 'balance_not_found_404',
      imsi: '460020999999999',
      seed: null, // do not seed
      body: { bucket: 'data', operation: 'credit', amount: 100, reason: 'nonexistent imsi' },
      expectedStatus: 404,
      expectedCode: 'BALANCE_NOT_FOUND',
    },
  ];

  for (const c of FAILURE_CASES) {
    if (c.seed) {
      await xcloud.collection('ocs_balances').insertOne(makeBalanceDoc(c.imsi, c.seed));
    }

    const res = await requestViaProxy(`/api/ocs/balances/${c.imsi}/adjust`, {
      token: tokens['super_admin'],
      body: c.body,
    });

    assert.equal(res.status, c.expectedStatus, `${c.name}: expected status ${c.expectedStatus}, got ${res.status}`);
    if (c.expectedCode) {
      assert.equal(res.data?.code, c.expectedCode, `${c.name}: expected code ${c.expectedCode}, got ${res.data?.code}`);
    }

    if (c.seed) {
      const docAfter = await xcloud.collection('ocs_balances').findOne({ imsi: c.imsi });
      assert.equal(numberValue(docAfter.version), c.seed.version ?? 1, `${c.name}: version must not mutate`);
    }
    recordCheck(`failure.${c.name}`);
  }

  // ══════════════════════════════════════════════════════════════════
  // Section 6: Reset Policy Matrix (Permanently Disabled Endpoint)
  // ══════════════════════════════════════════════════════════════════
  console.log('\n6. Reset Policy Matrix (Permanently Disabled)');
  const resetImsi = '460020000005001';
  await xcloud.collection('ocs_balances').insertOne(makeBalanceDoc(resetImsi, { version: 1 }));

  for (const u of testUsers) {
    const res = await requestViaProxy(`/api/ocs/balances/${resetImsi}/reset`, {
      token: tokens[u.role],
      body: {},
    });

    assert.equal(res.status, 400, `reset.${u.role}: must return 400 Bad Request`);
    assert.equal(res.data?.error, 'BALANCE_RESET_DISABLED', `reset.${u.role}: must return BALANCE_RESET_DISABLED`);

    // Invariant: 0 writes, 0 version increments
    const docAfter = await xcloud.collection('ocs_balances').findOne({ imsi: resetImsi });
    assert.equal(numberValue(docAfter.version), 1, `reset.${u.role}: version must not increment`);
    recordCheck(`reset.${u.role}.permanently_disabled_400`);
  }

  // ══════════════════════════════════════════════════════════════════
  // Section 7: Single-Writer Invariant & Backend Down Handling (502)
  // ══════════════════════════════════════════════════════════════════
  console.log('\n7. Single-Writer Invariant & Backend Down (502 GO_BACKEND_UNREACHABLE)');
  {
    // Point GO_BACKEND_URL to a dead/closed port
    const deadPort = await getAvailablePort();
    process.env.GO_BACKEND_URL = `http://127.0.0.1:${deadPort}`;

    const imsiDown = '460020000006001';
    await xcloud.collection('ocs_balances').insertOne(makeBalanceDoc(imsiDown, { version: 1 }));

    const res = await requestViaProxy(`/api/ocs/balances/${imsiDown}/adjust`, {
      token: tokens['super_admin'],
      body: { bucket: 'data', operation: 'credit', amount: 100, reason: 'when go is down' },
    });

    assert.equal(res.status, 502, 'When Go is down, proxy must return 502 Bad Gateway');
    assert.equal(res.data?.code, 'GO_BACKEND_UNREACHABLE', 'Error code must be GO_BACKEND_UNREACHABLE');

    // Zero mutations occurred
    const docAfter = await xcloud.collection('ocs_balances').findOne({ imsi: imsiDown });
    assert.equal(numberValue(docAfter.version), 1, 'No mutations may occur when Go is down (no Node fallback)');
    recordCheck('single_writer.go_down_returns_502_no_fallback');

    // Restore GO_BACKEND_URL
    process.env.GO_BACKEND_URL = `http://127.0.0.1:${goPort}`;
  }

  console.log(`\n========================================`);
  console.log(`ALL CHECKS PASSED: ${checks.length} assertions verified`);
  console.log(`Duration: ${Date.now() - startedAt}ms`);
  console.log(`========================================\n`);
} catch (err) {
  console.error('\nCUTOVER TEST FAILURE:', err);
  process.exitCode = 1;
} finally {
  if (goProc && !goProc.killed) {
    goProc.kill('SIGTERM');
    if (process.platform === 'win32') {
      try { execSync(`taskkill /pid ${goProc.pid} /T /F`, { stdio: 'ignore' }); } catch {}
    }
  }
  if (binPath && fs.existsSync(binPath)) {
    try { fs.unlinkSync(binPath); } catch {}
  }
  if (nodeServer) {
    nodeServer.close();
  }
  try {
    await client.db(xcloudDbName).dropDatabase();
    await client.db(appDbName).dropDatabase();
    await client.close();
    const moduleClient = await getMongoClient().catch(() => null);
    await moduleClient?.close().catch(() => {});
  } catch {}
}
