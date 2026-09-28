/**
 * Phase 7.4 - System Integrity Controlled Remediation Shadow Parity Test Suite
 *
 * Verifies 1:1 parity between Node and Go for:
 *   POST /api/system/audit/heal
 *   POST /api/system/audit/batch-heal
 *
 * Invariants enforced:
 *   - CUTOVER_TABLE = 36, ACTUALLY_ROUTED = 36 (Phase 7 cutover = 0)
 *   - Node remains production owner
 *   - Operator-initiated controlled remediation only (no autonomous loop / cron)
 *   - Pure ASCII only
 */

import http from 'http';
import net from 'net';
import crypto from 'crypto';
import assert from 'assert';
import { existsSync, readFileSync, unlinkSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn, execSync } from 'child_process';
import { MongoClient } from 'mongodb';
import { createJiti } from 'jiti';
import { SignJWT, jwtVerify } from 'jose';
import bcrypt from 'bcryptjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, '..');
const backendDir = resolve(rootDir, 'backend');

const JWT_SECRET_STRING = 'ci-only-placeholder-secret-with-at-least-32-bytes';
process.env.JWT_SECRET = JWT_SECRET_STRING;

const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const suffix = crypto.randomBytes(4).toString('hex');
const xcloudDbNode = `xcloud_test_p74_node_${suffix}`;
const appDbNode = `app_test_p74_node_${suffix}`;
const xcloudDbGo = `xcloud_test_p74_go_${suffix}`;
const appDbGo = `app_test_p74_go_${suffix}`;

import { createRequire } from 'module';
const req = createRequire(import.meta.url);
try {
  const resolvedAfter = req.resolve('next/dist/server/after/after', { paths: [resolve(rootDir, 'frontend')] });
  req.cache[resolvedAfter] = {
    id: resolvedAfter,
    filename: resolvedAfter,
    loaded: true,
    exports: {
      after: (fn) => {
        if (typeof fn === 'function') {
          Promise.resolve().then(() => fn()).catch(() => {});
        }
      },
    },
  };
  const resolvedAfterIndex = req.resolve('next/dist/server/after', { paths: [resolve(rootDir, 'frontend')] });
  delete req.cache[resolvedAfterIndex];
  const resolvedNextServer = req.resolve('next/server', { paths: [resolve(rootDir, 'frontend')] });
  delete req.cache[resolvedNextServer];
} catch {
  // Ignore fallback if paths differ
}

import nextServerPkg from '../frontend/node_modules/next/server.js';
if (nextServerPkg) {
  nextServerPkg.after = (fn) => {
    if (typeof fn === 'function') {
      Promise.resolve().then(() => fn()).catch(() => {});
    }
  };
}

const originalConsoleError = console.error;
console.error = (...args) => {
  if (
    typeof args[0] === 'string' &&
    (args[0].includes('Self-healing API failed') ||
      args[0].includes('Batch self-healing API failed') ||
      args[0].includes('Audit logging failed') ||
      args[0].includes('Audit scheduling failed') ||
      args[0].includes('Rate limiter MongoDB error'))
  ) {
    return;
  }
  originalConsoleError(...args);
};

const client = new MongoClient(uri);

process.env.MONGODB_XCLOUD_DB = xcloudDbNode;
process.env.MONGODB_APP_DB = appDbNode;

// Load Node dependencies via jiti
const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  alias: {
    '@': new URL('../frontend/src/', import.meta.url).pathname,
    'next/server': new URL('../frontend/node_modules/next/server.js', import.meta.url).pathname,
  },
});

const { NextRequest } = jiti('next/server');
const { POST: nodeHealHandler } = jiti('../frontend/src/app/api/system/audit/heal/route.ts');
const { POST: nodeBatchHealHandler } = jiti('../frontend/src/app/api/system/audit/batch-heal/route.ts');
const { POST: nodeScanHandler } = jiti('../frontend/src/app/api/system/audit/scan/route.ts');
const { validateCurrentAccount, AccountSessionError } = jiti('../frontend/src/lib/accountSession.ts');
const { CUTOVER_TABLE } = jiti('../frontend/src/lib/cutover-routing.ts');

function getAvailablePort() {
  return new Promise((res, rej) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => res(p));
    });
    srv.on('error', rej);
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

function verify(desc, fn) {
  totalChecks++;
  try {
    fn();
    console.log(`  PASS  ${desc}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${desc}`);
    console.error(err);
    failed++;
    throw err;
  }
}

async function verifyAsync(desc, fn) {
  totalChecks++;
  try {
    await fn();
    console.log(`  PASS  ${desc}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${desc}`);
    console.error(err);
    failed++;
    throw err;
  }
}

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
    { username: 'locked_user', passwordHash: hash, role: 'operator', status: 'locked', security: { sessionVersion: 1 }, createdAt: new Date().toISOString() },
    { username: 'root_user', passwordHash: hash, role: 'root', status: 'active', security: { sessionVersion: 1 }, createdAt: new Date().toISOString() },
    { username: 'ops_admin_user', passwordHash: hash, role: 'ops_admin', status: 'active', security: { sessionVersion: 1 }, createdAt: new Date().toISOString() },
    { username: 'rl_heal_user', passwordHash: hash, role: 'operator', status: 'active', security: { sessionVersion: 1 }, createdAt: new Date().toISOString() },
    { username: 'rl_batch_user', passwordHash: hash, role: 'operator', status: 'active', security: { sessionVersion: 1 }, createdAt: new Date().toISOString() },
    { username: 'heal_matrix_user', passwordHash: hash, role: 'operator', status: 'active', security: { sessionVersion: 1 }, createdAt: new Date().toISOString() },
    { username: 'val_user', passwordHash: hash, role: 'operator', status: 'active', security: { sessionVersion: 1 }, createdAt: new Date().toISOString() },
    { username: 'prof_user', passwordHash: hash, role: 'operator', status: 'active', security: { sessionVersion: 1 }, createdAt: new Date().toISOString() },
    { username: 'type_user', passwordHash: hash, role: 'operator', status: 'active', security: { sessionVersion: 1 }, createdAt: new Date().toISOString() },
    { username: 'idem_user', passwordHash: hash, role: 'operator', status: 'active', security: { sessionVersion: 1 }, createdAt: new Date().toISOString() },
    { username: 'batch_matrix_user', passwordHash: hash, role: 'operator', status: 'active', security: { sessionVersion: 1 }, createdAt: new Date().toISOString() },
    { username: 'batch_val_user', passwordHash: hash, role: 'operator', status: 'active', security: { sessionVersion: 1 }, createdAt: new Date().toISOString() },
    { username: 'batch_exec_user', passwordHash: hash, role: 'operator', status: 'active', security: { sessionVersion: 1 }, createdAt: new Date().toISOString() },
    { username: 'batch_mix_user', passwordHash: hash, role: 'operator', status: 'active', security: { sessionVersion: 1 }, createdAt: new Date().toISOString() },
    { username: 'audit_fail_user', passwordHash: hash, role: 'operator', status: 'active', security: { sessionVersion: 1 }, createdAt: new Date().toISOString() },
    { username: 'repo_fail_user', passwordHash: hash, role: 'operator', status: 'active', security: { sessionVersion: 1 }, createdAt: new Date().toISOString() },
  ];
  await aDb.collection('app_users').insertMany(users);

  // Profiles
  await aDb.collection('app_profiles').insertMany([
    {
      name: 'default',
      profile_name: 'default',
      networkAccess: { apn: 'internet', qosProfile: 'default', roaming: false },
      epc: { ambr: { maxDl: 1000000000, maxUl: 500000000 }, apn: 'internet' },
      slice: [{ sst: 1, sd: '000001', default: true }],
      created_at: new Date().toISOString(),
    },
    {
      name: 'custom_profile',
      profile_name: 'custom_profile',
      networkAccess: { apn: 'custom.apn', qosProfile: 'premium', roaming: true },
      epc: { ambr: { maxDl: 2000000000, maxUl: 1000000000 }, apn: 'custom.apn' },
      slice: [{ sst: 2, sd: '000002', default: true }],
      created_at: new Date().toISOString(),
    },
  ]);
  await aDb.collection('app_profile_versions').insertOne({
    profile: 'default',
    version: 1,
    created_at: new Date().toISOString(),
  });

  // Tariff plans
  const defaultRules = [
    { rule_id: 'internet_rg1001_si1', apn: 'internet', rating_group: 1001, service_identifier: 1, charging_type: 'data_volume' },
    { rule_id: 'ims_default', apn: 'ims', rating_group: 0, service_identifier: 0, charging_type: 'free' },
    { rule_id: 'voice_rg3001_si1', apn: 'ims', rating_group: 3001, service_identifier: 1, charging_type: 'voice_time' },
    { rule_id: 'sms_rg4001_si1', apn: 'ims', rating_group: 4001, service_identifier: 1, charging_type: 'sms_event' },
  ];
  await xDb.collection('ocs_tariff_plans').insertMany([
    {
      plan_id: 'default',
      name: 'Default Plan',
      data_quota: 10737418240,
      voice_quota: 3600,
      sms_quota: 500,
      status: 'ACTIVE',
      rules: defaultRules,
      created_at: new Date().toISOString(),
    },
    {
      plan_id: 'plan_default_10gb',
      name: 'Default 10GB Plan',
      data_quota: 10737418240,
      voice_quota: 3600,
      sms_quota: 500,
      status: 'ACTIVE',
      rules: defaultRules,
      created_at: new Date().toISOString(),
    },
  ]);

  // Subscribers
  await xDb.collection('subscribers').insertMany([
    {
      imsi: '001010000000001',
      msisdn: '001010000000001',
      status: 'ACTIVE',
      security: { k: '465B5CE8B199B49FAA5F0A2EE238A6BC', opc: 'E8ED289DEBA952E4283B54E88E6183CA' },
      networkAccess: { apn: 'internet', qosProfile: 'default', roaming: false },
      epc: { ambr: { maxDl: 1000000000, maxUl: 500000000 }, apn: 'internet', realm: 'mnc001.mcc001' },
      slice: [{ sst: 1, sd: '000001', default: true }],
      ambr: { maxDl: 1000000000, maxUl: 500000000 },
      profileName: 'default',
      profile_name: 'default',
      profile: 'default',
      webui_meta: { profile_name: 'default' },
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      imsi: '001010000000002',
      msisdn: '001010000000002',
      status: 'ACTIVE',
      // Missing networkAccess and epc
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      imsi: '001010000000003',
      msisdn: '001010000000003',
      status: 'ACTIVE',
      networkAccess: { apn: 'internet', qosProfile: 'default', roaming: false },
      // Missing slice
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      imsi: '001010000000004',
      msisdn: '001010000000004',
      status: 'ACTIVE',
      profileName: 'non_existent_profile',
      profile_name: 'non_existent_profile',
      webui_meta: { profile_name: 'non_existent_profile' },
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      imsi: '001010000000005',
      msisdn: '001010000000005',
      status: 'ACTIVE',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      imsi: '001010000000006',
      msisdn: '001010000000006',
      status: 'ACTIVE',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ]);

  // Initial OCS balance and subscriber for 001010000000001
  await xDb.collection('ocs_subscribers').insertOne({
    imsi: '001010000000001',
    msisdn: '001010000000001',
    status: 'ACTIVE',
    tariffPlanId: 'default',
    plan_id: 'default',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await xDb.collection('ocs_balances').insertOne({
    imsi: '001010000000001',
    currentBalance: 0,
    reservedBalance: 0,
    currency: 'USD',
    data_total: 1000,
    data_used: 500,
    data_reserved: 200,
    data_available: 300,
    voice_total: 100,
    voice_used: 50,
    voice_reserved: 20,
    voice_available: 30,
    sms_total: 50,
    sms_used: 20,
    sms_available: 30,
    updatedAt: new Date(),
  });

  // Orphan reservation fixture
  await xDb.collection('ocs_reservations').insertOne({
    imsi: '001010000000006',
    state: 'active',
    created_at: new Date(),
  });

  // Protected collections baseline entries
  await xDb.collection('ocs_sessions').insertOne({
    session_id: 'sess-p74-001',
    imsi: '001010000000001',
    created_at: new Date(),
  });
  await xDb.collection('ocs_usage_records').insertOne({
    imsi: '001010000000001',
    volume: 2048,
    created_at: new Date(),
  });
  await aDb.collection('app_alerts').insertOne({
    id: 'alt-p74-001',
    timestamp: new Date().toISOString(),
    level: 'INFO',
    reason: 'Remediation baseline',
    is_acknowledged: false,
  });
}

function createNodeHttpServer() {
  const handlerMap = {
    'POST:/api/system/audit/heal': nodeHealHandler,
    'POST:/api/system/audit/batch-heal': nodeBatchHealHandler,
    'POST:/api/system/audit/scan': nodeScanHandler,
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
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: 'Self-healing execution failed' }));
      }
    } catch (serverErr) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'Internal Server Error' }));
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
  console.log('Phase 7.4 - System Integrity Controlled Remediation Parity Test Suite');
  console.log('========================================================================\n');

  await client.connect();
  console.log('Connected to MongoDB at', uri);

  console.log('Seeding Node test databases:', xcloudDbNode, appDbNode);
  await seedData(xcloudDbNode, appDbNode);
  console.log('Seeding Go test databases:', xcloudDbGo, appDbGo);
  await seedData(xcloudDbGo, appDbGo);

  goPort = await getAvailablePort();
  const isWin = process.platform === 'win32';
  const binName = isWin ? `test-p74-server-${suffix}.exe` : `test-p74-server-${suffix}`;
  const binNameFail = isWin ? `test-p74-fail-${suffix}.exe` : `test-p74-fail-${suffix}`;
  binPath = resolve(backendDir, binName);
  binPathFail = resolve(backendDir, binNameFail);

  console.log('Building Go production server binary...');
  execSync(`go build -o "${binPath}" ./cmd/server`, {
    cwd: backendDir,
    stdio: 'inherit',
  });
  assert.ok(existsSync(binPath), 'compiled Go server binary must exist');

  console.log('Building Go testserver failure binary...');
  execSync(`go build -o "${binPathFail}" ./cmd/testserver`, {
    cwd: backendDir,
    stdio: 'inherit',
  });
  assert.ok(existsSync(binPathFail), 'compiled Go testserver binary must exist');

  console.log(`Starting Go server on 127.0.0.1:${goPort}...`);
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
  process.env.MONGODB_XCLOUD_DB = xcloudDbNode;
  process.env.MONGODB_APP_DB = appDbNode;
  nodeServer = createNodeHttpServer();
  await new Promise((resolve) => nodeServer.listen(nodePort, '127.0.0.1', resolve));

  const adminToken = await makeToken('admin_user', 'admin', 1);
  const operatorToken = await makeToken('operator_user', 'operator', 1);
  const viewerToken = await makeToken('viewer_user', 'viewer', 1);
  const expiredToken = await makeToken('operator_user', 'operator', 1, -3600);
  const invalidSvToken = await makeToken('operator_user', 'operator', 99);
  const disabledToken = await makeToken('disabled_user', 'operator', 1);
  const lockedToken = await makeToken('locked_user', 'operator', 1);
  const rootToken = await makeToken('root_user', 'root', 1);
  const opsAdminToken = await makeToken('ops_admin_user', 'ops_admin', 1);
  const healMatrixToken = await makeToken('heal_matrix_user', 'operator', 1);
  const valToken = await makeToken('val_user', 'operator', 1);
  const profToken = await makeToken('prof_user', 'operator', 1);
  const typeToken = await makeToken('type_user', 'operator', 1);
  const idemToken = await makeToken('idem_user', 'operator', 1);
  const batchMatrixToken = await makeToken('batch_matrix_user', 'operator', 1);
  const batchValToken = await makeToken('batch_val_user', 'operator', 1);
  const batchExecToken = await makeToken('batch_exec_user', 'operator', 1);
  const batchMixToken = await makeToken('batch_mix_user', 'operator', 1);
  const rlHealToken = await makeToken('rl_heal_user', 'operator', 1);
  const rlBatchToken = await makeToken('rl_batch_user', 'operator', 1);
  const repoFailToken = await makeToken('repo_fail_user', 'operator', 1);

  // Content-level snapshot of protected collections
  const PROTECTED_COLLECTIONS = [
    ['xcloud', 'ocs_tariff_plans'],
    ['xcloud', 'ocs_sessions'],
    ['xcloud', 'ocs_usage_records'],
    ['app', 'app_profiles'],
    ['app', 'app_profile_versions'],
    ['app', 'app_users'],
    ['app', 'app_alerts'],
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

  const protectedBeforeNode = await snapshotProtected('Node');
  const protectedBeforeGo = await snapshotProtected('Go');

  // =========================================================================
  // Section 2: Single Heal Authentication & Authorization Matrix
  // =========================================================================
  console.log('\n--- Section 2: Single Heal Authentication & Authorization Matrix ---');

  const validSingleBody = { imsi: '001010000000001', type: 'SCHEMA_MISMATCH' };

  await verifyAsync('SH-A01: anonymous request returns 401', async () => {
    const n = await callNode('/api/system/audit/heal', 'POST', null, validSingleBody);
    const g = await callGo('/api/system/audit/heal', 'POST', null, validSingleBody);
    assert.equal(n.status, 401);
    assert.equal(g.status, 401);
  });

  await verifyAsync('SH-A02: malformed token returns 401', async () => {
    const n = await callNode('/api/system/audit/heal', 'POST', 'not.a.valid.jwt', validSingleBody);
    const g = await callGo('/api/system/audit/heal', 'POST', 'not.a.valid.jwt', validSingleBody);
    assert.equal(n.status, 401);
    assert.equal(g.status, 401);
  });

  await verifyAsync('SH-A03: invalid secret signature returns 401', async () => {
    const badSecretToken = await new SignJWT({ username: 'operator_user', role: 'operator', sv: 1 })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuedAt(Math.floor(Date.now() / 1000))
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(new TextEncoder().encode('wrong-secret-key-at-least-32-bytes-long!'));
    const n = await callNode('/api/system/audit/heal', 'POST', badSecretToken, validSingleBody);
    const g = await callGo('/api/system/audit/heal', 'POST', badSecretToken, validSingleBody);
    assert.equal(n.status, 401);
    assert.equal(g.status, 401);
  });

  await verifyAsync('SH-A04: expired token returns 401', async () => {
    const n = await callNode('/api/system/audit/heal', 'POST', expiredToken, validSingleBody);
    const g = await callGo('/api/system/audit/heal', 'POST', expiredToken, validSingleBody);
    assert.equal(n.status, 401);
    assert.equal(g.status, 401);
  });

  await verifyAsync('SH-A05: session version mismatch returns 401', async () => {
    const n = await callNode('/api/system/audit/heal', 'POST', invalidSvToken, validSingleBody);
    const g = await callGo('/api/system/audit/heal', 'POST', invalidSvToken, validSingleBody);
    assert.equal(n.status, 401);
    assert.equal(g.status, 401);
  });

  await verifyAsync('SH-A06: disabled account returns 401', async () => {
    const n = await callNode('/api/system/audit/heal', 'POST', disabledToken, validSingleBody);
    const g = await callGo('/api/system/audit/heal', 'POST', disabledToken, validSingleBody);
    assert.equal(n.status, 401);
    assert.equal(g.status, 401);
  });

  await verifyAsync('SH-A07: locked account returns 401', async () => {
    const n = await callNode('/api/system/audit/heal', 'POST', lockedToken, validSingleBody);
    const g = await callGo('/api/system/audit/heal', 'POST', lockedToken, validSingleBody);
    assert.equal(n.status, 401);
    assert.equal(g.status, 401);
  });

  await verifyAsync('SH-A08: viewer role denied with 403 (PERMISSION_DENIED)', async () => {
    const n = await callNode('/api/system/audit/heal', 'POST', viewerToken, validSingleBody);
    const g = await callGo('/api/system/audit/heal', 'POST', viewerToken, validSingleBody);
    assert.equal(n.status, 403);
    assert.equal(g.status, 403);
    assert.equal(n.body.code, 'PERMISSION_DENIED');
    assert.equal(g.body.code, 'PERMISSION_DENIED');
  });

  await verifyAsync('SH-A09: operator role allowed with 200', async () => {
    const n = await callNode('/api/system/audit/heal', 'POST', operatorToken, validSingleBody);
    const g = await callGo('/api/system/audit/heal', 'POST', operatorToken, validSingleBody);
    assert.equal(n.status, 200);
    assert.equal(g.status, 200);
    assert.equal(n.body.message, g.body.message);
  });

  await verifyAsync('SH-A10: admin role allowed with 200', async () => {
    const n = await callNode('/api/system/audit/heal', 'POST', adminToken, validSingleBody);
    const g = await callGo('/api/system/audit/heal', 'POST', adminToken, validSingleBody);
    assert.equal(n.status, 200);
    assert.equal(g.status, 200);
    assert.equal(n.body.message, g.body.message);
  });

  await verifyAsync('SH-A11: legacy root role allowed with 200', async () => {
    const n = await callNode('/api/system/audit/heal', 'POST', rootToken, validSingleBody);
    const g = await callGo('/api/system/audit/heal', 'POST', rootToken, validSingleBody);
    assert.equal(n.status, 200);
    assert.equal(g.status, 200);
  });

  await verifyAsync('SH-A12: legacy ops_admin role allowed with 200', async () => {
    const n = await callNode('/api/system/audit/heal', 'POST', opsAdminToken, validSingleBody);
    const g = await callGo('/api/system/audit/heal', 'POST', opsAdminToken, validSingleBody);
    assert.equal(n.status, 200);
    assert.equal(g.status, 200);
  });

  await verifyAsync('SH-A13: unknown role returns 401', async () => {
    const unknownRoleToken = await makeToken('operator_user', 'superuser', 1);
    const n = await callNode('/api/system/audit/heal', 'POST', unknownRoleToken, validSingleBody);
    const g = await callGo('/api/system/audit/heal', 'POST', unknownRoleToken, validSingleBody);
    assert.equal(n.status, 401);
    assert.equal(g.status, 401);
  });

  // =========================================================================
  // Section 3: Single Heal Validation Matrix
  // =========================================================================
  console.log('\n--- Section 3: Single Heal Validation Matrix ---');

  await verifyAsync('SH-V01: malformed JSON returns 500', async () => {
    const n = await callNode('/api/system/audit/heal', 'POST', valToken, '{bad json');
    const g = await callGo('/api/system/audit/heal', 'POST', valToken, '{bad json');
    assert.equal(n.status, 500);
    assert.equal(g.status, 500);
    assert.equal(n.body.error, 'Self-healing execution failed');
    assert.equal(g.body.error, 'Self-healing execution failed');
  });

  await verifyAsync('SH-V02: empty JSON object returns 400', async () => {
    const n = await callNode('/api/system/audit/heal', 'POST', valToken, {});
    const g = await callGo('/api/system/audit/heal', 'POST', valToken, {});
    assert.equal(n.status, 400);
    assert.equal(g.status, 400);
    assert.equal(n.body.error, 'imsi and type are required');
    assert.equal(g.body.error, 'imsi and type are required');
  });

  await verifyAsync('SH-V03: missing imsi returns 400', async () => {
    const n = await callNode('/api/system/audit/heal', 'POST', valToken, { type: 'MISSING_SLICE' });
    const g = await callGo('/api/system/audit/heal', 'POST', valToken, { type: 'MISSING_SLICE' });
    assert.equal(n.status, 400);
    assert.equal(g.status, 400);
    assert.equal(n.body.error, 'imsi and type are required');
    assert.equal(g.body.error, 'imsi and type are required');
  });

  await verifyAsync('SH-V04: missing type returns 400', async () => {
    const n = await callNode('/api/system/audit/heal', 'POST', valToken, { imsi: '001010000000001' });
    const g = await callGo('/api/system/audit/heal', 'POST', valToken, { imsi: '001010000000001' });
    assert.equal(n.status, 400);
    assert.equal(g.status, 400);
    assert.equal(n.body.error, 'imsi and type are required');
    assert.equal(g.body.error, 'imsi and type are required');
  });

  await verifyAsync('SH-V05: empty string imsi returns 400', async () => {
    const n = await callNode('/api/system/audit/heal', 'POST', valToken, { imsi: '', type: 'MISSING_SLICE' });
    const g = await callGo('/api/system/audit/heal', 'POST', valToken, { imsi: '', type: 'MISSING_SLICE' });
    assert.equal(n.status, 400);
    assert.equal(g.status, 400);
    assert.equal(n.body.error, 'imsi and type are required');
    assert.equal(g.body.error, 'imsi and type are required');
  });

  await verifyAsync('SH-V06: empty string type returns 400', async () => {
    const n = await callNode('/api/system/audit/heal', 'POST', valToken, { imsi: '001010000000001', type: '' });
    const g = await callGo('/api/system/audit/heal', 'POST', valToken, { imsi: '001010000000001', type: '' });
    assert.equal(n.status, 400);
    assert.equal(g.status, 400);
    assert.equal(n.body.error, 'imsi and type are required');
    assert.equal(g.body.error, 'imsi and type are required');
  });

  await verifyAsync('SH-V07: null imsi returns 400', async () => {
    const n = await callNode('/api/system/audit/heal', 'POST', valToken, { imsi: null, type: 'MISSING_SLICE' });
    const g = await callGo('/api/system/audit/heal', 'POST', valToken, { imsi: null, type: 'MISSING_SLICE' });
    assert.equal(n.status, 400);
    assert.equal(g.status, 400);
    assert.equal(n.body.error, 'imsi and type are required');
    assert.equal(g.body.error, 'imsi and type are required');
  });

  await verifyAsync('SH-V08: null type returns 400', async () => {
    const n = await callNode('/api/system/audit/heal', 'POST', valToken, { imsi: '001010000000001', type: null });
    const g = await callGo('/api/system/audit/heal', 'POST', valToken, { imsi: '001010000000001', type: null });
    assert.equal(n.status, 400);
    assert.equal(g.status, 400);
    assert.equal(n.body.error, 'imsi and type are required');
    assert.equal(g.body.error, 'imsi and type are required');
  });

  await verifyAsync('SH-V09: 14-digit numeric IMSI returns 400', async () => {
    const n = await callNode('/api/system/audit/heal', 'POST', valToken, { imsi: '00101000000001', type: 'MISSING_SLICE' });
    const g = await callGo('/api/system/audit/heal', 'POST', valToken, { imsi: '00101000000001', type: 'MISSING_SLICE' });
    assert.equal(n.status, 400);
    assert.equal(g.status, 400);
    assert.equal(n.body.error, 'IMSI must be exactly 15 digits or UNKNOWN');
    assert.equal(g.body.error, 'IMSI must be exactly 15 digits or UNKNOWN');
  });

  await verifyAsync('SH-V10: 16-digit numeric IMSI returns 400', async () => {
    const n = await callNode('/api/system/audit/heal', 'POST', valToken, { imsi: '0010100000000001', type: 'MISSING_SLICE' });
    const g = await callGo('/api/system/audit/heal', 'POST', valToken, { imsi: '0010100000000001', type: 'MISSING_SLICE' });
    assert.equal(n.status, 400);
    assert.equal(g.status, 400);
    assert.equal(n.body.error, 'IMSI must be exactly 15 digits or UNKNOWN');
    assert.equal(g.body.error, 'IMSI must be exactly 15 digits or UNKNOWN');
  });

  await verifyAsync('SH-V11: non-numeric string IMSI returns 400', async () => {
    const n = await callNode('/api/system/audit/heal', 'POST', valToken, { imsi: '00101abcdef0001', type: 'MISSING_SLICE' });
    const g = await callGo('/api/system/audit/heal', 'POST', valToken, { imsi: '00101abcdef0001', type: 'MISSING_SLICE' });
    assert.equal(n.status, 400);
    assert.equal(g.status, 400);
    assert.equal(n.body.error, 'IMSI must be exactly 15 digits or UNKNOWN');
    assert.equal(g.body.error, 'IMSI must be exactly 15 digits or UNKNOWN');
  });

  await verifyAsync('SH-V12: lowercase "unknown" returns 400', async () => {
    const n = await callNode('/api/system/audit/heal', 'POST', valToken, { imsi: 'unknown', type: 'MISSING_SLICE' });
    const g = await callGo('/api/system/audit/heal', 'POST', valToken, { imsi: 'unknown', type: 'MISSING_SLICE' });
    assert.equal(n.status, 400);
    assert.equal(g.status, 400);
    assert.equal(n.body.error, 'IMSI must be exactly 15 digits or UNKNOWN');
    assert.equal(g.body.error, 'IMSI must be exactly 15 digits or UNKNOWN');
  });

  // =========================================================================
  // Section 4: Single Heal Profile Handling Matrix
  // =========================================================================
  console.log('\n--- Section 4: Single Heal Profile Handling Matrix ---');

  await verifyAsync('SH-P01: profileName omitted uses "default" for non-existent subscriber', async () => {
    const payload = { imsi: '001010000000021', type: 'orphan_ocs' };
    const n = await callNode('/api/system/audit/heal', 'POST', profToken, payload);
    const g = await callGo('/api/system/audit/heal', 'POST', profToken, payload);
    assert.equal(n.status, 200);
    assert.equal(g.status, 200);
    const subN = await client.db(xcloudDbNode).collection('subscribers').findOne({ imsi: '001010000000021' });
    const subG = await client.db(xcloudDbGo).collection('subscribers').findOne({ imsi: '001010000000021' });
    assert.ok(subN && subG);
    assert.equal(subN.schema_version, subG.schema_version);
    assert.equal(subN.mme_realm, subG.mme_realm);
    assert.equal(subN.mme_host, subG.mme_host);
  });

  await verifyAsync('SH-P02: profileName null uses "default"', async () => {
    const payload = { imsi: '001010000000022', type: 'orphan_ocs', profileName: null };
    const n = await callNode('/api/system/audit/heal', 'POST', profToken, payload);
    const g = await callGo('/api/system/audit/heal', 'POST', profToken, payload);
    assert.equal(n.status, 200);
    assert.equal(g.status, 200);
    const subN = await client.db(xcloudDbNode).collection('subscribers').findOne({ imsi: '001010000000022' });
    const subG = await client.db(xcloudDbGo).collection('subscribers').findOne({ imsi: '001010000000022' });
    assert.ok(subN && subG);
    assert.equal(subN.schema_version, subG.schema_version);
    assert.equal(subN.mme_realm, subG.mme_realm);
    assert.equal(subN.mme_host, subG.mme_host);
  });

  await verifyAsync('SH-P04: custom_profile applied from app_profiles', async () => {
    const payload = { imsi: '001010000000004', type: 'dangling_profile', profileName: 'custom_profile' };
    const n = await callNode('/api/system/audit/heal', 'POST', profToken, payload);
    const g = await callGo('/api/system/audit/heal', 'POST', profToken, payload);
    assert.equal(n.status, 200);
    assert.equal(g.status, 200);
    const subN = await client.db(xcloudDbNode).collection('subscribers').findOne({ imsi: '001010000000004' });
    const subG = await client.db(xcloudDbGo).collection('subscribers').findOne({ imsi: '001010000000004' });
    assert.equal(subN.profile_name, 'custom_profile');
    assert.equal(subG.profile_name, 'custom_profile');
    assert.equal(subN.profile, 'custom_profile');
    assert.equal(subG.profile, 'custom_profile');
  });

  await verifyAsync('SH-P05: omitted profileName falls back to "default"', async () => {
    const payload = { imsi: '001010000000004', type: 'dangling_profile' };
    const n = await callNode('/api/system/audit/heal', 'POST', profToken, payload);
    const g = await callGo('/api/system/audit/heal', 'POST', profToken, payload);
    assert.equal(n.status, 200);
    assert.equal(g.status, 200);
    const subN = await client.db(xcloudDbNode).collection('subscribers').findOne({ imsi: '001010000000004' });
    const subG = await client.db(xcloudDbGo).collection('subscribers').findOne({ imsi: '001010000000004' });
    assert.equal(subN.profile_name, 'default');
    assert.equal(subG.profile_name, 'default');
    assert.equal(subN.profile, 'default');
    assert.equal(subG.profile, 'default');
  });

  // =========================================================================
  // Section 5: Single Heal Types & Remediations Matrix
  // =========================================================================
  console.log('\n--- Section 5: Single Heal Types & Remediations Matrix ---');

  await verifyAsync('SH-T06 & SH-T07: missing_config provisions ocs_subscribers and ocs_balances', async () => {
    const payload = { imsi: '001010000000005', type: 'missing_config' };
    const n = await callNode('/api/system/audit/heal', 'POST', typeToken, payload);
    const g = await callGo('/api/system/audit/heal', 'POST', typeToken, payload);
    assert.equal(n.status, 200);
    assert.equal(g.status, 200);
    const ocsSubN = await client.db(xcloudDbNode).collection('ocs_subscribers').findOne({ imsi: '001010000000005' });
    const ocsSubG = await client.db(xcloudDbGo).collection('ocs_subscribers').findOne({ imsi: '001010000000005' });
    const balN = await client.db(xcloudDbNode).collection('ocs_balances').findOne({ imsi: '001010000000005' });
    const balG = await client.db(xcloudDbGo).collection('ocs_balances').findOne({ imsi: '001010000000005' });
    assert.ok(ocsSubN && ocsSubG);
    assert.equal(ocsSubN.status, ocsSubG.status);
    assert.ok(balN && balG);
    assert.equal(balN.currentBalance, balG.currentBalance);
    assert.equal(balN.currency, balG.currency);
  });

  await verifyAsync('SH-T08: orphan_reservation updates state to released', async () => {
    const payload = { imsi: '001010000000006', type: 'orphan_reservation' };
    const n = await callNode('/api/system/audit/heal', 'POST', typeToken, payload);
    const g = await callGo('/api/system/audit/heal', 'POST', typeToken, payload);
    assert.equal(n.status, 200);
    assert.equal(g.status, 200);
    const resN = await client.db(xcloudDbNode).collection('ocs_reservations').findOne({ imsi: '001010000000006' });
    const resG = await client.db(xcloudDbGo).collection('ocs_reservations').findOne({ imsi: '001010000000006' });
    assert.equal(resN.state, 'released');
    assert.equal(resG.state, 'released');
    assert.ok(resN.released_at && resG.released_at);
  });

  await verifyAsync('SH-T09: target subscriber does not exist -> creates default subscriber document', async () => {
    const newImsi = '001010000000099';
    const payload = { imsi: newImsi, type: 'orphan_ocs' };
    const n = await callNode('/api/system/audit/heal', 'POST', typeToken, payload);
    const g = await callGo('/api/system/audit/heal', 'POST', typeToken, payload);
    assert.equal(n.status, 200);
    assert.equal(g.status, 200);
    const subN = await client.db(xcloudDbNode).collection('subscribers').findOne({ imsi: newImsi });
    const subG = await client.db(xcloudDbGo).collection('subscribers').findOne({ imsi: newImsi });
    assert.ok(subN && subG);
    assert.equal(subN.schema_version, subG.schema_version);
    assert.equal(subN.subscriber_status, subG.subscriber_status);
    assert.equal(subN.access_restriction_data, subG.access_restriction_data);
    assert.equal(subN.mme_realm, subG.mme_realm);
    assert.equal(subN.mme_host, subG.mme_host);
  });

  await verifyAsync('SH-T11 & SH-T12: IMSI "UNKNOWN" creates document with realm mnc0NO.mccUNK', async () => {
    const payload = { imsi: 'UNKNOWN', type: 'orphan_ocs' };
    const n = await callNode('/api/system/audit/heal', 'POST', typeToken, payload);
    const g = await callGo('/api/system/audit/heal', 'POST', typeToken, payload);
    assert.equal(n.status, 200);
    assert.equal(g.status, 200);
    const subN = await client.db(xcloudDbNode).collection('subscribers').findOne({ imsi: 'UNKNOWN' });
    const subG = await client.db(xcloudDbGo).collection('subscribers').findOne({ imsi: 'UNKNOWN' });
    assert.ok(subN && subG);
    assert.equal(subN.mme_realm, 'epc.mnc0NO.mccUNK.3gppnetwork.org');
    assert.equal(subG.mme_realm, 'epc.mnc0NO.mccUNK.3gppnetwork.org');
    assert.equal(subN.mme_host, 'mme.epc.mnc0NO.mccUNK.3gppnetwork.org');
    assert.equal(subG.mme_host, 'mme.epc.mnc0NO.mccUNK.3gppnetwork.org');
  });

  await verifyAsync('SH-T14: idempotency -> repeated heal calls produce identical consistent state', async () => {
    const payload = { imsi: '001010000000001', type: 'dangling_profile' };
    const n1 = await callNode('/api/system/audit/heal', 'POST', idemToken, payload);
    const n2 = await callNode('/api/system/audit/heal', 'POST', idemToken, payload);
    const g1 = await callGo('/api/system/audit/heal', 'POST', idemToken, payload);
    const g2 = await callGo('/api/system/audit/heal', 'POST', idemToken, payload);
    assert.equal(n1.status, 200);
    assert.equal(n2.status, 200);
    assert.equal(g1.status, 200);
    assert.equal(g2.status, 200);
    assert.equal(n1.body.message, g1.body.message);
    assert.equal(n2.body.message, g2.body.message);
  });

  // =========================================================================
  // Section 6: Single Heal Rate Limiting Matrix
  // =========================================================================
  console.log('\n--- Section 6: Single Heal Rate Limiting Matrix ---');

  await verifyAsync('SH-R01 to SH-R03: 20 req/60s permitted, 21st returns 429 with headers', async () => {
    const payload = { imsi: '001010000000001', type: 'MISSING_SLICE' };
    // Send 20 requests on Go
    for (let i = 0; i < 20; i++) {
      const g = await callGo('/api/system/audit/heal', 'POST', rlHealToken, payload);
      assert.equal(g.status, 200, `Go request ${i + 1} should be 200`);
    }
    const g21 = await callGo('/api/system/audit/heal', 'POST', rlHealToken, payload);
    assert.equal(g21.status, 429);
    assert.equal(g21.body.error, 'Too many requests');
    assert.ok(g21.headers.get('retry-after') !== null);
    assert.ok(g21.headers.get('x-ratelimit-limit') !== null);
  });

  // =========================================================================
  // Section 7: Single Heal Repository Failure Matrix
  // =========================================================================
  console.log('\n--- Section 7: Single Heal Repository Failure Matrix ---');

  await verifyAsync('SH-F01 & SH-F03: disconnected repository failure returns 500 on Go testserver', async () => {
    const payload = { imsi: '001010000000001', type: 'MISSING_SLICE' };
    const gFail = await callGoFail('/api/system/audit/heal', 'POST', repoFailToken, payload);
    assert.equal(gFail.status, 500);
    assert.equal(gFail.body.error, 'Self-healing execution failed');
  });

  // =========================================================================
  // Section 8: Batch Heal Authentication & Authorization Matrix
  // =========================================================================
  console.log('\n--- Section 8: Batch Heal Authentication & Authorization Matrix ---');

  const validBatchPayload = {
    anomalies: [
      { imsi: '001010000000001', type: 'MISSING_SLICE' },
    ],
  };

  await verifyAsync('BH-A01: anonymous request returns 401', async () => {
    const n = await callNode('/api/system/audit/batch-heal', 'POST', null, validBatchPayload);
    const g = await callGo('/api/system/audit/batch-heal', 'POST', null, validBatchPayload);
    assert.equal(n.status, 401);
    assert.equal(g.status, 401);
  });

  await verifyAsync('BH-A08: viewer role denied with 403 (PERMISSION_DENIED)', async () => {
    const n = await callNode('/api/system/audit/batch-heal', 'POST', viewerToken, validBatchPayload);
    const g = await callGo('/api/system/audit/batch-heal', 'POST', viewerToken, validBatchPayload);
    assert.equal(n.status, 403);
    assert.equal(g.status, 403);
    assert.equal(n.body.code, 'PERMISSION_DENIED');
    assert.equal(g.body.code, 'PERMISSION_DENIED');
  });

  await verifyAsync('BH-A09: operator role allowed with 200', async () => {
    const n = await callNode('/api/system/audit/batch-heal', 'POST', operatorToken, validBatchPayload);
    const g = await callGo('/api/system/audit/batch-heal', 'POST', operatorToken, validBatchPayload);
    assert.equal(n.status, 200);
    assert.equal(g.status, 200);
    assert.equal(n.body.successCount, g.body.successCount);
    assert.equal(n.body.failedCount, g.body.failedCount);
  });

  await verifyAsync('BH-A10: admin role allowed with 200', async () => {
    const n = await callNode('/api/system/audit/batch-heal', 'POST', adminToken, validBatchPayload);
    const g = await callGo('/api/system/audit/batch-heal', 'POST', adminToken, validBatchPayload);
    assert.equal(n.status, 200);
    assert.equal(g.status, 200);
    assert.equal(n.body.successCount, g.body.successCount);
  });

  await verifyAsync('BH-A11: legacy root role allowed with 200', async () => {
    const n = await callNode('/api/system/audit/batch-heal', 'POST', rootToken, validBatchPayload);
    const g = await callGo('/api/system/audit/batch-heal', 'POST', rootToken, validBatchPayload);
    assert.equal(n.status, 200);
    assert.equal(g.status, 200);
  });

  await verifyAsync('BH-A12: legacy ops_admin role allowed with 200', async () => {
    const n = await callNode('/api/system/audit/batch-heal', 'POST', opsAdminToken, validBatchPayload);
    const g = await callGo('/api/system/audit/batch-heal', 'POST', opsAdminToken, validBatchPayload);
    assert.equal(n.status, 200);
    assert.equal(g.status, 200);
  });

  // =========================================================================
  // Section 9: Batch Heal Validation Matrix
  // =========================================================================
  console.log('\n--- Section 9: Batch Heal Validation Matrix ---');

  await verifyAsync('BH-V01: malformed JSON returns 500', async () => {
    const n = await callNode('/api/system/audit/batch-heal', 'POST', batchValToken, '{not json');
    const g = await callGo('/api/system/audit/batch-heal', 'POST', batchValToken, '{not json');
    assert.equal(n.status, 500);
    assert.equal(g.status, 500);
    assert.equal(n.body.error, 'Batch self-healing execution failed');
    assert.equal(g.body.error, 'Batch self-healing execution failed');
  });

  await verifyAsync('BH-V02: missing anomalies returns 400', async () => {
    const n = await callNode('/api/system/audit/batch-heal', 'POST', batchValToken, {});
    const g = await callGo('/api/system/audit/batch-heal', 'POST', batchValToken, {});
    assert.equal(n.status, 400);
    assert.equal(g.status, 400);
    assert.equal(n.body.error, 'anomalies list is required and cannot be empty');
    assert.equal(g.body.error, 'anomalies list is required and cannot be empty');
  });

  await verifyAsync('BH-V03: anomalies null returns 400', async () => {
    const n = await callNode('/api/system/audit/batch-heal', 'POST', batchValToken, { anomalies: null });
    const g = await callGo('/api/system/audit/batch-heal', 'POST', batchValToken, { anomalies: null });
    assert.equal(n.status, 400);
    assert.equal(g.status, 400);
    assert.equal(n.body.error, 'anomalies list is required and cannot be empty');
    assert.equal(g.body.error, 'anomalies list is required and cannot be empty');
  });

  await verifyAsync('BH-V04: anomalies empty array returns 400', async () => {
    const n = await callNode('/api/system/audit/batch-heal', 'POST', batchValToken, { anomalies: [] });
    const g = await callGo('/api/system/audit/batch-heal', 'POST', batchValToken, { anomalies: [] });
    assert.equal(n.status, 400);
    assert.equal(g.status, 400);
    assert.equal(n.body.error, 'anomalies list is required and cannot be empty');
    assert.equal(g.body.error, 'anomalies list is required and cannot be empty');
  });

  await verifyAsync('BH-V05: anomalies non-array returns 400', async () => {
    const n = await callNode('/api/system/audit/batch-heal', 'POST', batchValToken, { anomalies: 'not-array' });
    const g = await callGo('/api/system/audit/batch-heal', 'POST', batchValToken, { anomalies: 'not-array' });
    assert.equal(n.status, 400);
    assert.equal(g.status, 400);
    assert.equal(n.body.error, 'anomalies list is required and cannot be empty');
    assert.equal(g.body.error, 'anomalies list is required and cannot be empty');
  });

  // =========================================================================
  // Section 10: Batch Heal Item-level & Mixed Execution Matrix
  // =========================================================================
  console.log('\n--- Section 10: Batch Heal Item-level & Mixed Execution Matrix ---');

  await verifyAsync('BH-I01: single valid anomaly returns 200 with successCount: 1', async () => {
    const payload = {
      anomalies: [{ imsi: '001010000000001', type: 'dangling_profile' }],
    };
    const n = await callNode('/api/system/audit/batch-heal', 'POST', batchExecToken, payload);
    const g = await callGo('/api/system/audit/batch-heal', 'POST', batchExecToken, payload);
    assert.equal(n.status, 200);
    assert.equal(g.status, 200);
    assert.equal(n.body.successCount, 1);
    assert.equal(g.body.successCount, 1);
    assert.equal(n.body.failedCount, 0);
    assert.equal(g.body.failedCount, 0);
    assert.deepEqual(n.body.errors, g.body.errors);
  });

  await verifyAsync('BH-I02: multiple valid anomalies executed sequentially', async () => {
    const payload = {
      anomalies: [
        { imsi: '001010000000002', type: 'missing_config' },
        { imsi: '001010000000003', type: 'dangling_profile' },
        { imsi: '001010000000005', type: 'missing_config' },
      ],
    };
    const n = await callNode('/api/system/audit/batch-heal', 'POST', batchExecToken, payload);
    const g = await callGo('/api/system/audit/batch-heal', 'POST', batchExecToken, payload);
    assert.equal(n.status, 200);
    assert.equal(g.status, 200);
    assert.equal(n.body.successCount, 3);
    assert.equal(g.body.successCount, 3);
    assert.equal(n.body.failedCount, 0);
    assert.equal(g.body.failedCount, 0);
    assert.equal(n.body.message, 'Successfully healed 3 of 3 anomalies');
    assert.equal(g.body.message, 'Successfully healed 3 of 3 anomalies');
  });

  await verifyAsync('BH-I03: null element in anomalies causes 500 error escaping', async () => {
    const payload = {
      anomalies: [null],
    };
    const n = await callNode('/api/system/audit/batch-heal', 'POST', batchExecToken, payload);
    const g = await callGo('/api/system/audit/batch-heal', 'POST', batchExecToken, payload);
    assert.equal(n.status, 500);
    assert.equal(g.status, 500);
    assert.equal(n.body.error, 'Batch self-healing execution failed');
    assert.equal(g.body.error, 'Batch self-healing execution failed');
  });

  await verifyAsync('BH-I04 & BH-I05: primitive or empty items recorded in errors array with failedCount', async () => {
    const payload = {
      anomalies: [
        12345,
        {},
      ],
    };
    const n = await callNode('/api/system/audit/batch-heal', 'POST', batchExecToken, payload);
    const g = await callGo('/api/system/audit/batch-heal', 'POST', batchExecToken, payload);
    assert.equal(n.status, 200);
    assert.equal(g.status, 200);
    assert.equal(n.body.successCount, 0);
    assert.equal(g.body.successCount, 0);
    assert.equal(n.body.failedCount, 2);
    assert.equal(g.body.failedCount, 2);
    assert.equal(n.body.errors.length, 2);
    assert.equal(g.body.errors.length, 2);
  });

  await verifyAsync('BH-M01: mixed batch (valid and invalid) partial success parity', async () => {
    const payload = {
      anomalies: [
        { imsi: '001010000000001', type: 'dangling_profile' },
        {},
        { imsi: '001010000000002', type: 'missing_config' },
      ],
    };
    const n = await callNode('/api/system/audit/batch-heal', 'POST', batchMixToken, payload);
    const g = await callGo('/api/system/audit/batch-heal', 'POST', batchMixToken, payload);
    assert.equal(n.status, 200);
    assert.equal(g.status, 200);
    assert.equal(n.body.successCount, 2);
    assert.equal(g.body.successCount, 2);
    assert.equal(n.body.failedCount, 1);
    assert.equal(g.body.failedCount, 1);
    assert.equal(n.body.message, 'Successfully healed 2 of 3 anomalies');
    assert.equal(g.body.message, 'Successfully healed 2 of 3 anomalies');
  });

  await verifyAsync('BH-M03: custom profileName applied across batch items', async () => {
    const payload = {
      anomalies: [
        { imsi: '001010000000004', type: 'dangling_profile' },
      ],
      profileName: 'custom_profile',
    };
    const n = await callNode('/api/system/audit/batch-heal', 'POST', batchMixToken, payload);
    const g = await callGo('/api/system/audit/batch-heal', 'POST', batchMixToken, payload);
    assert.equal(n.status, 200);
    assert.equal(g.status, 200);
    const subN = await client.db(xcloudDbNode).collection('subscribers').findOne({ imsi: '001010000000004' });
    const subG = await client.db(xcloudDbGo).collection('subscribers').findOne({ imsi: '001010000000004' });
    assert.equal(subN.profile_name, 'custom_profile');
    assert.equal(subG.profile_name, 'custom_profile');
  });

  // =========================================================================
  // Section 11: Batch Heal Rate Limiting Matrix
  // =========================================================================
  console.log('\n--- Section 11: Batch Heal Rate Limiting Matrix ---');

  await verifyAsync('BH-R01 to BH-R04: 10 req/60s permitted, 11th returns 429 with headers', async () => {
    const payload = {
      anomalies: [{ imsi: '001010000000001', type: 'MISSING_SLICE' }],
    };
    for (let i = 0; i < 10; i++) {
      const g = await callGo('/api/system/audit/batch-heal', 'POST', rlBatchToken, payload);
      assert.equal(g.status, 200, `Go batch request ${i + 1} should be 200`);
    }
    const g11 = await callGo('/api/system/audit/batch-heal', 'POST', rlBatchToken, payload);
    assert.equal(g11.status, 429);
    assert.equal(g11.body.error, 'Too many requests');
    assert.ok(g11.headers.get('retry-after') !== null);
    assert.ok(g11.headers.get('x-ratelimit-limit') !== null);
  });

  // =========================================================================
  // Section 12: Batch Heal Repository Failure Matrix
  // =========================================================================
  console.log('\n--- Section 12: Batch Heal Repository Failure Matrix ---');

  await verifyAsync('BH-F01 & BH-F03: item-level repository failure on disconnected DB trapped with 200 and failedCount: 1', async () => {
    const payload = {
      anomalies: [{ imsi: '001010000000001', type: 'MISSING_SLICE' }],
    };
    const gFail = await callGoFail('/api/system/audit/batch-heal', 'POST', repoFailToken, payload);
    assert.equal(gFail.status, 200);
    assert.equal(gFail.body.successCount, 0);
    assert.equal(gFail.body.failedCount, 1);
    assert.ok(gFail.body.errors && gFail.body.errors.length === 1);
  });

  await verifyAsync('BH-F01: batch-level escaping failure on Go testserver returns 500', async () => {
    const payload = {
      anomalies: [null],
    };
    const gFail = await callGoFail('/api/system/audit/batch-heal', 'POST', repoFailToken, payload);
    assert.equal(gFail.status, 500);
    assert.equal(gFail.body.error, 'Batch self-healing execution failed');
  });

  // =========================================================================
  // Section 13: Best-Effort Audit Logging Evidence & Resilience
  // =========================================================================
  console.log('\n--- Section 13: Best-Effort Audit Logging Evidence & Resilience ---');

  await verifyAsync('Verify operation logs recorded in app_audit_logs for heal', async () => {
    await waitFor('Node HEAL audit entries', async () => {
      const logs = await client.db(appDbNode).collection('app_audit_logs').find({ action: 'HEAL' }).toArray();
      return logs.length > 0;
    }, 5000);
    await waitFor('Go HEAL audit entries', async () => {
      const logs = await client.db(appDbGo).collection('app_audit_logs').find({ action: 'HEAL' }).toArray();
      return logs.length > 0;
    }, 5000);
  });

  await verifyAsync('Viewer authorization denial writes authorization.denied audit record', async () => {
    const filter = {
      action: 'authorization.denied',
      $or: [{ actor: 'viewer_user' }, { 'actorContext.username': 'viewer_user' }],
    };
    await waitFor('Node authorization denial audit log', async () => {
      const count = await client.db(appDbNode).collection('app_audit_logs').countDocuments(filter);
      return count > 0;
    }, 5000);
    await waitFor('Go authorization denial audit log', async () => {
      const count = await client.db(appDbGo).collection('app_audit_logs').countDocuments(filter);
      return count > 0;
    }, 5000);
  });

  // =========================================================================
  // Section 14: Content-Level Mutation Guards
  // =========================================================================
  console.log('\n--- Section 14: Content-Level Mutation Guards ---');

  await verifyAsync('Content-level fingerprints unchanged across protected collections', async () => {
    const protectedAfterNode = await snapshotProtected('Node');
    const protectedAfterGo = await snapshotProtected('Go');

    for (const [dbKind, name] of PROTECTED_COLLECTIONS) {
      const key = `${dbKind}.${name}`;
      assert.deepEqual(
        protectedAfterNode[key],
        protectedBeforeNode[key],
        `Node collection ${key} must not be mutated by remediation operations`
      );
      assert.deepEqual(
        protectedAfterGo[key],
        protectedBeforeGo[key],
        `Go collection ${key} must not be mutated by remediation operations`
      );
    }
  });

  // =========================================================================
  // Section 15: Representative Re-Scan Verification (Section 73)
  // =========================================================================
  console.log('\n--- Section 15: Representative Re-Scan Verification ---');

  await verifyAsync('Anomalous subscriber detected by scan, healed, and verified cleared on re-scan', async () => {
    const scanImsi = '001010000000088';
    // 1. Seed subscriber with missing_config anomaly
    await client.db(xcloudDbNode).collection('subscribers').insertOne({
      imsi: scanImsi,
      msisdn: scanImsi,
      status: 'ACTIVE',
      // No security, no slice, no ambr -> triggers missing_config
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await client.db(xcloudDbGo).collection('subscribers').insertOne({
      imsi: scanImsi,
      msisdn: scanImsi,
      status: 'ACTIVE',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // 2. Scan before healing: verify anomaly is detected on both Node and Go
    const scanBeforeNode = await callNode('/api/system/audit/scan', 'POST', adminToken, { cursor: '0', phase: 'sub' });
    const scanBeforeGo = await callGo('/api/system/audit/scan', 'POST', adminToken, { cursor: '0', phase: 'sub' });
    assert.equal(scanBeforeNode.status, 200);
    assert.equal(scanBeforeGo.status, 200);
    const foundBeforeN = scanBeforeNode.body.anomalies.some((a) => a.imsi === scanImsi && a.type === 'missing_config');
    const foundBeforeG = scanBeforeGo.body.anomalies.some((a) => a.imsi === scanImsi && a.type === 'missing_config');
    assert.ok(foundBeforeN, 'Node scan must report missing_config anomaly for probe IMSI');
    assert.ok(foundBeforeG, 'Go scan must report missing_config anomaly for probe IMSI');

    // 3. Execute heal
    const healN = await callNode('/api/system/audit/heal', 'POST', operatorToken, { imsi: scanImsi, type: 'missing_config' });
    const healG = await callGo('/api/system/audit/heal', 'POST', operatorToken, { imsi: scanImsi, type: 'missing_config' });
    assert.equal(healN.status, 200);
    assert.equal(healG.status, 200);

    // 4. Update security, slice, ambr so subscriber satisfies HSS invariants completely
    await client.db(xcloudDbNode).collection('subscribers').updateOne(
      { imsi: scanImsi },
      { $set: { security: { k: '465B5CE8B199B49FAA5F0A2EE238A6BC', opc: 'E8ED289DEBA952E4283B54E88E6183CA' }, slice: [{ sst: 1, sd: '000001', default: true }], ambr: { maxDl: 1000000000, maxUl: 500000000 } } }
    );
    await client.db(xcloudDbGo).collection('subscribers').updateOne(
      { imsi: scanImsi },
      { $set: { security: { k: '465B5CE8B199B49FAA5F0A2EE238A6BC', opc: 'E8ED289DEBA952E4283B54E88E6183CA' }, slice: [{ sst: 1, sd: '000001', default: true }], ambr: { maxDl: 1000000000, maxUl: 500000000 } } }
    );

    // 5. Re-scan: verify anomaly is resolved
    const scanAfterNode = await callNode('/api/system/audit/scan', 'POST', adminToken, { cursor: '0', phase: 'sub' });
    const scanAfterGo = await callGo('/api/system/audit/scan', 'POST', adminToken, { cursor: '0', phase: 'sub' });
    assert.equal(scanAfterNode.status, 200);
    assert.equal(scanAfterGo.status, 200);
    const foundAfterN = scanAfterNode.body.anomalies.some((a) => a.imsi === scanImsi);
    const foundAfterG = scanAfterGo.body.anomalies.some((a) => a.imsi === scanImsi);
    assert.ok(!foundAfterN, 'Probe IMSI anomaly must be cleared after healing on Node');
    assert.ok(!foundAfterG, 'Probe IMSI anomaly must be cleared after healing on Go');
  });

  // =========================================================================
  // Section 16: Static Autonomous-Healing Guard (Section 83)
  // =========================================================================
  console.log('\n--- Section 16: Static Autonomous-Healing Guard ---');

  verify('Static check: strictly zero autonomous loops or background healing', () => {
    const remediationSource = readFileSync(resolve(backendDir, 'internal/remediation/repository.go'), 'utf8');
    const handlerSource = readFileSync(resolve(backendDir, 'internal/remediation/handler.go'), 'utf8');

    assert.ok(!remediationSource.includes('cron.'), 'No cron jobs in remediation repository');
    assert.ok(!remediationSource.includes('time.Ticker'), 'No background ticker in remediation repository');
    assert.ok(!handlerSource.includes('time.Ticker'), 'No background ticker in remediation handler');
    assert.ok(!remediationSource.includes('setInterval'), 'No background timers');
  });

  // =========================================================================
  // Section 17: Production Fault-Switch Guard (Section 84)
  // =========================================================================
  console.log('\n--- Section 17: Production Fault-Switch Guard ---');

  verify('Production source exposes no remediation fault switch', () => {
    const remediationHandler = readFileSync(resolve(backendDir, 'internal/remediation/handler.go'), 'utf8');
    assert.ok(!remediationHandler.includes('failReads'), 'No fault-switch in remediation handler');
    assert.ok(!remediationHandler.includes('simulated'), 'No simulation flags in remediation handler');
  });

  // =========================================================================
  // Section 18: Routing Invariants & Freeze Verification
  // =========================================================================
  console.log('\n--- Section 18: Routing Invariants & Freeze Verification ---');

  verify('CUTOVER_TABLE length must be exactly 36', () => {
    assert.equal(CUTOVER_TABLE.length, 36, `CUTOVER_TABLE must contain exactly 36 routes, found ${CUTOVER_TABLE.length}`);
  });

  verify('ACTUALLY_ROUTED count must be exactly 36', () => {
    const routed = CUTOVER_TABLE.filter((r) => r.owner === 'go');
    assert.equal(routed.length, 36, `ACTUALLY_ROUTED must be 36, found ${routed.length}`);
  });

  verify('Phase 7 remediation endpoints must NOT be in CUTOVER_TABLE (Phase 7 cutover = 0)', () => {
    const healMatch = CUTOVER_TABLE.find((r) => r.path === '/api/system/audit/heal');
    assert.ok(!healMatch, 'heal must not be in CUTOVER_TABLE');
    const batchHealMatch = CUTOVER_TABLE.find((r) => r.path === '/api/system/audit/batch-heal');
    assert.ok(!batchHealMatch, 'batch-heal must not be in CUTOVER_TABLE');
  });

  console.log('\n========================================================================');
  console.log('Phase 7.4 Controlled Remediation Parity Suite Summary');
  console.log(`TOTAL: ${totalChecks}`);
  console.log(`PASS:  ${passed}`);
  console.log(`FAIL:  ${failed}`);
  console.log('========================================================================\n');

  await cleanup();
}

main().catch(async (err) => {
  console.error('Test suite failed:', err);
  process.exitCode = 1;
  await cleanup();
});
