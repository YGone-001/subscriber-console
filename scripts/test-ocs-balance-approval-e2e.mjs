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

const originalConsoleError = console.error;
console.error = (...args) => {
  if (typeof args[0] === 'string' && args[0].includes('Audit scheduling failed')) {
    return;
  }
  originalConsoleError(...args);
};

const startedAt = Date.now();
const suffix = `${Date.now()}_${process.pid}_${Math.floor(Math.random() * 100000)}`;
const xcloudDbName = `xcloud_ocs_balance_e2e_${suffix}`;
const appDbName = `xcloud_ops_ocs_balance_e2e_${suffix}`;
const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/xcloud';

// Setup environment for isolated execution
process.env.MONGODB_XCLOUD_DB = xcloudDbName;
process.env.MONGODB_APP_DB = appDbName;
const JWT_SECRET_STRING = process.env.JWT_SECRET || 'phase5-4-a2-test-secret-at-least-32-bytes-long';
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
const { POST: executePost } = jiti('../frontend/src/app/api/approvals/[id]/execute/route.ts');
const { POST: approvePost } = jiti('../frontend/src/app/api/approvals/[id]/approve/route.ts');
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

function dataBalanceDoc(imsi, version = 10) {
  return {
    imsi,
    data_total: Long.fromNumber(1000),
    data_used: Long.fromNumber(300),
    data_reserved: Long.fromNumber(500),
    data_available: Long.fromNumber(200),
    voice_total: Long.ZERO,
    voice_used: Long.ZERO,
    voice_reserved: Long.ZERO,
    voice_available: Long.ZERO,
    sms_total: Long.ZERO,
    sms_used: Long.ZERO,
    sms_reserved: Long.ZERO,
    sms_available: Long.ZERO,
    status: 'active',
    version: Long.fromNumber(version),
    updated_at: new Date(),
  };
}

function smsBalanceDoc(imsi, version = 1) {
  return {
    imsi,
    data_total: Long.ZERO,
    data_used: Long.ZERO,
    data_reserved: Long.ZERO,
    data_available: Long.ZERO,
    voice_total: Long.ZERO,
    voice_used: Long.ZERO,
    voice_reserved: Long.ZERO,
    voice_available: Long.ZERO,
    sms_total: Long.fromNumber(100),
    sms_used: Long.fromNumber(20),
    sms_reserved: Long.ZERO,
    sms_available: Long.fromNumber(80),
    status: 'active',
    version: Long.fromNumber(version),
    updated_at: new Date(),
  };
}

let goProc = null;
let nodeServer = null;
let binPath = null;

const report = {
  command: 'test-ocs-balance-approval-e2e',
  databases: { xcloud: xcloudDbName, app: appDbName },
  checks: [],
};

function recordCheck(name) {
  report.checks.push(name);
  console.log(name);
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

  // 2. Seed test actors
  await app.collection('app_users').insertMany([
    {
      username: 'e2e_operator',
      role: 'operator',
      status: 'active',
      security: { sessionVersion: 1 },
      createdAt: new Date().toISOString(),
    },
    {
      username: 'e2e_admin',
      role: 'super_admin',
      status: 'active',
      security: { sessionVersion: 1 },
      createdAt: new Date().toISOString(),
    },
  ]);

  // 3. Issue signed JWTs
  const secretKey = getJwtSecretKey();
  const now = Math.floor(Date.now() / 1000);

  const operatorToken = await new SignJWT({ username: 'e2e_operator', role: 'operator', sv: 1 })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(secretKey);

  const adminToken = await new SignJWT({ username: 'e2e_admin', role: 'super_admin', sv: 1 })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(secretKey);

  // 4. Start Go Backend
  const goPort = await getAvailablePort();
  const isWin = process.platform === 'win32';
  const binName = isWin ? `test-go-server-${suffix}.exe` : `test-go-server-${suffix}`;
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

  // Wait for Go backend to be ready
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

  // 5. Start in-process Node HTTP Server for Next.js Approval HTTP Routes
  const nodePort = await getAvailablePort();
  nodeServer = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const rawBody = Buffer.concat(chunks);
      const fullUrl = `http://127.0.0.1:${nodePort}${req.url}`;

      const matchExecute = req.url.match(/^\/api\/approvals\/([^/?#]+)\/execute$/);
      const matchApprove = req.url.match(/^\/api\/approvals\/([^/?#]+)\/approve$/);

      if (req.method === 'POST' && (matchExecute || matchApprove)) {
        const id = decodeURIComponent((matchExecute || matchApprove)[1]);
        const nextReq = new NextRequest(fullUrl, {
          method: req.method,
          headers: req.headers,
          body: rawBody.length > 0 ? rawBody : undefined,
        });

        // 1. Run through Next.js proxy middleware (JWT verification + session validation)
        const proxyRes = await proxy(nextReq);
        if (proxyRes.status !== 200) {
          const body = await proxyRes.text();
          res.writeHead(proxyRes.status, Object.fromEntries(proxyRes.headers.entries()));
          res.end(body);
          return;
        }

        // 2. Extract request headers passed by proxy
        const routeHeaders = new Headers(req.headers);
        for (const [k, v] of proxyRes.headers.entries()) {
          if (k.startsWith('x-middleware-request-')) {
            routeHeaders.set(k.slice('x-middleware-request-'.length), v);
          }
        }

        const routeReq = new Request(fullUrl, {
          method: req.method,
          headers: routeHeaders,
          body: rawBody.length > 0 ? rawBody : undefined,
        });

        const routeRes = matchExecute
          ? await executePost(routeReq, { params: Promise.resolve({ id }) })
          : await approvePost(routeReq, { params: Promise.resolve({ id }) });

        const routeBody = await routeRes.text();
        res.writeHead(routeRes.status, Object.fromEntries(routeRes.headers.entries()));
        res.end(routeBody);
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found' }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err) }));
    }
  });

  await new Promise((resolve) => nodeServer.listen(nodePort, '127.0.0.1', resolve));

  // ── Verification: Production Auth Boundary ──────────────────────────
  {
    // A: Missing token -> 401 Unauthorized
    const unauthRes = await fetch(`http://127.0.0.1:${nodePort}/api/approvals/non-existent/execute`, {
      method: 'POST',
    });
    assert.equal(unauthRes.status, 401, 'Request without token must be rejected with 401');

    // B: Operator token (lacks approvals.execute) -> 403 Forbidden
    const forbiddenRes = await fetch(`http://127.0.0.1:${nodePort}/api/approvals/non-existent/execute`, {
      method: 'POST',
      headers: { cookie: `auth_token=${operatorToken}` },
    });
    assert.equal(forbiddenRes.status, 403, 'Operator request to execute must be rejected with 403');
  }

  // ══════════════════════════════════════════════════════════════════
  // Scenario A: Data Credit Success
  // ══════════════════════════════════════════════════════════════════
  const imsiA = '460020000000801';
  await xcloud.collection('ocs_balances').insertOne(dataBalanceDoc(imsiA, 10));

  // 1. Operator requests adjustment via Go Backend
  const adjustARes = await fetch(`http://127.0.0.1:${goPort}/api/ocs/balances/${imsiA}/adjust`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      cookie: `auth_token=${operatorToken}`,
    },
    body: JSON.stringify({
      bucket: 'data',
      operation: 'credit',
      amount: 100,
      reason: 'Phase 5.4-A2 data credit E2E',
    }),
  });
  assert.equal(adjustARes.status, 202, `Expected HTTP 202, got ${adjustARes.status}`);
  const adjustABody = await adjustARes.json();
  assert.equal(adjustABody.outcome, 'approval_required');
  assert.ok(adjustABody.approvalId, 'approvalId must be returned');
  const approvalIdA = adjustABody.approvalId;
  const approvalDocPreA = await app.collection('app_approvals').findOne({ id: approvalIdA });
  const adjustmentIdA = adjustABody.adjustmentId || approvalDocPreA?.payload?.adjustmentId;
  assert.ok(adjustmentIdA, 'adjustmentId must be captured');
  recordCheck('approval.data.create');

  // 2. Check no premature mutation
  const docBeforeExecuteA = await xcloud.collection('ocs_balances').findOne({ imsi: imsiA });
  assert.equal(numberValue(docBeforeExecuteA.data_total), 1000);
  assert.equal(numberValue(docBeforeExecuteA.data_available), 200);
  assert.equal(numberValue(docBeforeExecuteA.version), 10);
  recordCheck('approval.data.no_premature_mutation');

  // 3. Approval decision by independent reviewer (e2e_admin)
  // Verify approval document content before decision
  const approvalDocA = await app.collection('app_approvals').findOne({ id: approvalIdA });
  assert.equal(approvalDocA.action, 'TRAFFIC_ADJUSTMENT');
  assert.equal(approvalDocA.payload.schema, 'ocs-balance-adjustment-v1');
  assert.equal(approvalDocA.payload.adjustmentId, adjustmentIdA);
  assert.equal(approvalDocA.payload.imsi, imsiA);
  assert.equal(approvalDocA.payload.intent.bucket, 'data');
  assert.equal(approvalDocA.payload.intent.operation, 'credit');
  assert.equal(approvalDocA.payload.intent.amount, 100);
  assert.equal(approvalDocA.payload.before.version, 10);
  assert.equal(approvalDocA.payload.before.total, 1000);
  assert.equal(approvalDocA.payload.before.used, 300);
  assert.equal(approvalDocA.payload.before.reserved, 500);
  assert.equal(approvalDocA.payload.before.available, 200);
  assert.equal(approvalDocA.payload.expectedAfter.total, 1100);
  assert.equal(approvalDocA.payload.expectedAfter.available, 300);

  // Maker-checker validation: operator cannot approve own request
  const selfApproveRes = await fetch(`http://127.0.0.1:${nodePort}/api/approvals/${approvalIdA}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: `auth_token=${operatorToken}` },
    body: JSON.stringify({ comment: 'self-approve attempt' }),
  });
  assert.ok(selfApproveRes.status === 403 || selfApproveRes.status === 401, 'Operator must not be able to self-approve');

  // Admin approves request
  const approveARes = await fetch(`http://127.0.0.1:${nodePort}/api/approvals/${approvalIdA}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: `auth_token=${adminToken}` },
    body: JSON.stringify({ comment: 'Approved for E2E testing' }),
  });
  assert.equal(approveARes.status, 200, `Expected approve status 200, got ${approveARes.status}`);
  const approvedDocA = await app.collection('app_approvals').findOne({ id: approvalIdA });
  assert.equal(approvedDocA.status, 'approved');
  recordCheck('approval.data.approve');

  // 4. Production Execute HTTP Request
  const executeARes = await fetch(`http://127.0.0.1:${nodePort}/api/approvals/${approvalIdA}/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: `auth_token=${adminToken}` },
  });
  assert.equal(executeARes.status, 200, `Expected execute status 200, got ${executeARes.status}`);
  recordCheck('approval.data.execute_http');

  const executeABody = await executeARes.json();
  assert.equal(executeABody.approval.status, 'completed');
  assert.ok(executeABody.approval.execution?.id, 'execution.id must exist');
  assert.equal(executeABody.approval.execution?.success, true);
  assert.ok(executeABody.approval.executedAt, 'executedAt must exist');
  recordCheck('approval.data.completed');

  // 5. Mongo Mutation Verification
  const docAfterExecuteA = await xcloud.collection('ocs_balances').findOne({ imsi: imsiA });
  assert.equal(numberValue(docAfterExecuteA.data_total), 1100);
  assert.equal(numberValue(docAfterExecuteA.data_used), 300);
  assert.equal(numberValue(docAfterExecuteA.data_reserved), 500);
  assert.equal(numberValue(docAfterExecuteA.data_available), 300);
  assert.equal(numberValue(docAfterExecuteA.version), 11);
  recordCheck('approval.data.mongo_exact_delta');

  // 6. Ledger & Audit Verification
  const ledgerRowsA = await app.collection('ocs_balance_adjustments').find({ adjustmentId: adjustmentIdA }).toArray();
  assert.equal(ledgerRowsA.length, 1, 'Exactly one ledger record must exist');
  assert.equal(ledgerRowsA[0].status, 'completed');
  assert.equal(ledgerRowsA[0].imsi, imsiA);
  assert.equal(ledgerRowsA[0].bucket, 'data');
  assert.ok(ledgerRowsA[0].before, 'before snapshot must exist');
  assert.ok(ledgerRowsA[0].after, 'after snapshot must exist');

  const ocsAuditA = await app.collection('app_audit_logs').findOne({
    action: 'ocs.balance.adjust',
    approvalId: approvalIdA,
  });
  assert.ok(ocsAuditA, 'OCS balance adjust audit must exist');
  assert.equal(ocsAuditA.result, 'success');
  assert.equal(ocsAuditA.metadata?.adjustmentId, adjustmentIdA);

  const startAuditA = await app.collection('app_audit_logs').findOne({
    action: 'approval.execute.start',
    approvalId: approvalIdA,
  });
  assert.ok(startAuditA, 'approval.execute.start audit must exist');

  const completedAuditA = await app.collection('app_audit_logs').findOne({
    action: 'approval.execute.completed',
    approvalId: approvalIdA,
  });
  assert.ok(completedAuditA, 'approval.execute.completed audit must exist');
  recordCheck('approval.data.audit');

  // 7. Replay Safety Through the HTTP Boundary
  const replayARes = await fetch(`http://127.0.0.1:${nodePort}/api/approvals/${approvalIdA}/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: `auth_token=${adminToken}` },
  });
  assert.equal(replayARes.status, 409, `Replay must return 409, got ${replayARes.status}`);
  const docAfterReplayA = await xcloud.collection('ocs_balances').findOne({ imsi: imsiA });
  assert.equal(numberValue(docAfterReplayA.data_total), 1100, 'Replay must not mutate data_total');
  assert.equal(numberValue(docAfterReplayA.data_available), 300, 'Replay must not mutate data_available');
  assert.equal(numberValue(docAfterReplayA.version), 11, 'Replay must not increment version');
  recordCheck('approval.data.replay_safe');

  // ══════════════════════════════════════════════════════════════════
  // Scenario B: SMS Approval Success
  // ══════════════════════════════════════════════════════════════════
  const imsiB = '460020000000802';
  await xcloud.collection('ocs_balances').insertOne(smsBalanceDoc(imsiB, 1));

  // 1. Create SMS credit adjustment
  const adjustBRes = await fetch(`http://127.0.0.1:${goPort}/api/ocs/balances/${imsiB}/adjust`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      cookie: `auth_token=${operatorToken}`,
    },
    body: JSON.stringify({
      bucket: 'sms',
      operation: 'credit',
      amount: 50,
      reason: 'Phase 5.4-A2 SMS credit E2E',
    }),
  });
  assert.equal(adjustBRes.status, 202);
  const adjustBBody = await adjustBRes.json();
  const approvalIdB = adjustBBody.approvalId;
  const adjustmentIdB = adjustBBody.adjustmentId;

  // Verify frozen reserved is 0
  const approvalDocB = await app.collection('app_approvals').findOne({ id: approvalIdB });
  assert.equal(approvalDocB.payload.before.reserved, 0, 'Frozen SMS reserved must be 0');
  assert.equal(approvalDocB.payload.expectedAfter.reserved, 0, 'Expected SMS reserved must be 0');
  recordCheck('approval.sms.create');

  // 2. Approve SMS request
  const approveBRes = await fetch(`http://127.0.0.1:${nodePort}/api/approvals/${approvalIdB}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: `auth_token=${adminToken}` },
    body: JSON.stringify({ comment: 'Approved SMS' }),
  });
  assert.equal(approveBRes.status, 200);

  // 3. Execute SMS approval
  const executeBRes = await fetch(`http://127.0.0.1:${nodePort}/api/approvals/${approvalIdB}/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: `auth_token=${adminToken}` },
  });
  assert.equal(executeBRes.status, 200);
  recordCheck('approval.sms.execute_http');

  const executeBBody = await executeBRes.json();
  assert.equal(executeBBody.approval.status, 'completed');
  recordCheck('approval.sms.completed');

  // 4. Verify SMS Mongo mutation
  const docAfterExecuteB = await xcloud.collection('ocs_balances').findOne({ imsi: imsiB });
  assert.equal(numberValue(docAfterExecuteB.sms_total), 150);
  assert.equal(numberValue(docAfterExecuteB.sms_available), 130);
  assert.equal(numberValue(docAfterExecuteB.sms_used), 20);
  assert.equal(numberValue(docAfterExecuteB.version), 2);
  recordCheck('approval.sms.mongo_exact_delta');

  // ══════════════════════════════════════════════════════════════════
  // Scenario C: Execution-Time Drift
  // ══════════════════════════════════════════════════════════════════
  const imsiC = '460020000000803';
  await xcloud.collection('ocs_balances').insertOne(dataBalanceDoc(imsiC, 5));

  // 1. Create adjustment at version 5
  const adjustCRes = await fetch(`http://127.0.0.1:${goPort}/api/ocs/balances/${imsiC}/adjust`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      cookie: `auth_token=${operatorToken}`,
    },
    body: JSON.stringify({
      bucket: 'data',
      operation: 'credit',
      amount: 100,
      reason: 'Phase 5.4-A2 drift test',
    }),
  });
  assert.equal(adjustCRes.status, 202);
  const adjustCBody = await adjustCRes.json();
  const approvalIdC = adjustCBody.approvalId;
  recordCheck('approval.drift.create');

  // 2. Approve the change
  const approveCRes = await fetch(`http://127.0.0.1:${nodePort}/api/approvals/${approvalIdC}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: `auth_token=${adminToken}` },
    body: JSON.stringify({ comment: 'Approved for drift test' }),
  });
  assert.equal(approveCRes.status, 200);

  // 3. Mutate live document in MongoDB to introduce concurrent drift
  await xcloud.collection('ocs_balances').updateOne(
    { imsi: imsiC },
    { $inc: { version: Long.ONE } }
  );

  // 4. Execute through HTTP endpoint — must detect drift and fail safely
  const executeCRes = await fetch(`http://127.0.0.1:${nodePort}/api/approvals/${approvalIdC}/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: `auth_token=${adminToken}` },
  });
  assert.equal(executeCRes.status, 409, `Drift execution must return 409, got ${executeCRes.status}`);
  const executeCBody = await executeCRes.json();
  assert.equal(executeCBody.approval?.error, 'OCS_BALANCE_PRECONDITION_CHANGED');
  assert.equal(executeCBody.approval?.status, 'failed');
  recordCheck('approval.drift.detected');

  // 5. Verify no stale mutation occurred in Mongo
  const docAfterDriftC = await xcloud.collection('ocs_balances').findOne({ imsi: imsiC });
  assert.equal(numberValue(docAfterDriftC.data_total), 1000, 'Drifted balance total must not mutate');
  assert.equal(numberValue(docAfterDriftC.data_available), 200, 'Drifted balance available must not mutate');
  assert.equal(numberValue(docAfterDriftC.version), 6, 'Version must remain at drifted version 6');
  recordCheck('approval.drift.no_mutation');

  console.log('\nPASS');
} catch (err) {
  console.error('\nE2E TEST FAILURE:', err);
  process.exitCode = 1;
} finally {
  // Cleanup processes
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
  // Drop isolated test databases
  try {
    await client.db(xcloudDbName).dropDatabase();
    await client.db(appDbName).dropDatabase();
    await client.close();
    const moduleClient = await getMongoClient().catch(() => null);
    await moduleClient?.close().catch(() => {});
  } catch {}
}
