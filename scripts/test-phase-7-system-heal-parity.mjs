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
import { existsSync, readFileSync, unlinkSync, readdirSync } from 'fs';
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

const pendingAfter = new Set();
function runAfter(fn) {
  if (typeof fn !== 'function') return;
  const promise = Promise.resolve().then(fn).finally(() => pendingAfter.delete(promise));
  pendingAfter.add(promise);
  promise.catch(() => {});
}
async function drainAfter() { await Promise.allSettled([...pendingAfter]); }

import { createRequire } from 'module';
const req = createRequire(import.meta.url);
try {
  const resolvedAfter = req.resolve('next/dist/server/after/after', { paths: [resolve(rootDir, 'frontend')] });
  req.cache[resolvedAfter] = {
    id: resolvedAfter,
    filename: resolvedAfter,
    loaded: true,
    exports: {
      after: runAfter,
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
  nextServerPkg.after = runAfter;
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

const fixtureWrites = [];
const client = new MongoClient(uri, { monitorCommands: true });
client.on('commandStarted', (event) => {
  if (['insert', 'update', 'delete', 'findAndModify', 'bulkWrite', 'drop', 'dropDatabase', 'create', 'collMod'].includes(event.commandName)) {
    fixtureWrites.push({ command: event.commandName, database: event.databaseName });
  }
});

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

// The acceptance inventory is independent from the registered/executed cases.
const REQUIRED_IDS = Object.entries({
  'SH-A': 13, 'SH-V': 12, 'SH-P': 6, 'SH-T': 15, 'SH-F': 3, 'SH-R': 3,
  'BH-A': 13, 'BH-V': 5, 'BH-I': 7, 'BH-M': 7, 'BH-P': 5, 'BH-F': 3, 'BH-R': 4,
}).flatMap(([prefix, count]) => Array.from({ length: count }, (_, i) => `${prefix}${String(i + 1).padStart(2, '0')}`));
const cases = [];
const executedIds = [];
function test(id, description, run) { cases.push({ id, description, run }); }
function inventory(ids) {
  return {
    missing: REQUIRED_IDS.filter((id) => !ids.includes(id)),
    duplicate: ids.filter((id, i) => ids.indexOf(id) !== i),
  };
}

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
  function stable(value) {
    if (value instanceof Date) return { date: value.toISOString() };
    if (value?._bsontype === 'ObjectId') return { objectId: value.toHexString() };
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
    return value;
  }
  const normalized = docs.map(stable);
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
  const xDbs = [xcloudDbNode, xcloudDbGo].map((name) => client.db(name));
  const aDbs = [appDbNode, appDbGo].map((name) => client.db(name));
  const businessCollections = ['subscribers', 'ocs_subscribers', 'ocs_balances', 'ocs_reservations'];
  const endpoints = { SH: '/api/system/audit/heal', BH: '/api/system/audit/batch-heal' };
  let serial = 100;
  const nextImsi = () => `001010${String(++serial).padStart(9, '0')}`;
  const validSub = (imsi) => ({ imsi, security: { k: 'key', opc: 'opc' }, slice: [{ sst: 1 }], ambr: { downlink: 1 }, untouched: { value: 0, list: [], nullable: null } });

  // Normalize only generated identities and clock values, retaining their presence
  // and BSON type. Every business field and unknown field remains in comparison.
  function normalize(value, key = '') {
    if (value instanceof Date) { assert.ok(Number.isFinite(value.getTime())); return '<BSON date>'; }
    if (value?._bsontype === 'ObjectId') return '<ObjectId>';
    if (key === 'mme_timestamp') { assert.ok(Number.isSafeInteger(value)); return '<microsecond timestamp>'; }
    if (Array.isArray(value)) return value.map((v) => normalize(v));
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, normalize(value[k], k)]));
    return value;
  }
  async function businessState(db, imsis) {
    const out = {};
    for (const name of businessCollections) {
      const docs = await db.collection(name).find(imsis ? { imsi: { $in: imsis } } : {}).toArray();
      out[name] = docs.map((doc) => normalize(doc)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    }
    return out;
  }
  async function stateParity(imsis) {
    const n = await businessState(xDbs[0], imsis);
    const g = await businessState(xDbs[1], imsis);
    assert.deepStrictEqual(g, n, 'Complete persisted business documents must match');
    return n;
  }
  async function insertBoth(collection, doc) {
    for (const db of xDbs) await db.collection(collection).insertOne(structuredClone(doc));
  }
  async function clearBudgets() {
    for (const db of aDbs) await db.collection('app_rate_limits').deleteMany({});
  }
  async function pair(kind, payload, status = 200, token = operatorToken) {
    const n = await callNode(endpoints[kind], 'POST', token, payload);
    const g = await callGo(endpoints[kind], 'POST', token, payload);
    assert.equal(n.status, status, `Node ${kind}: ${JSON.stringify(n.body)}`);
    assert.equal(g.status, n.status, `Go ${kind}: ${JSON.stringify(g.body)}`);
    assert.deepStrictEqual(g.body, n.body, 'Exact HTTP response body parity');
    return n;
  }
  const wrap = (kind, item, extra = {}) => kind === 'SH' ? { ...item, ...extra } : { anomalies: [item], ...extra };

  // Enable server-side evidence of rejected writes for the isolated fixture DBs.
  // This captures actual production-driver commands, including async audit writes.
  for (const db of [...xDbs, ...aDbs]) await db.command({ profile: 2, slowms: 0 });
  for (const db of aDbs) {
    for (const name of ['app_audit_logs', 'app_rate_limits', 'app_approvals']) {
      if (!(await db.listCollections({ name }).hasNext())) await db.createCollection(name);
    }
  }
  for (const role of ['super_admin', 'auditor']) {
    for (const db of aDbs) await db.collection('app_users').insertOne({ username: `${role}_user`, role, status: 'active', security: { sessionVersion: 1 } });
  }
  const protectedNames = [
    ['xcloud', 'ocs_tariff_plans'], ['xcloud', 'ocs_sessions'], ['xcloud', 'ocs_usage_records'],
    ['xcloud', 'ocs_events'], ['xcloud', 'ocs_config'], ['xcloud', 'ocs_balance_adjustments'],
    ['app', 'app_users'], ['app', 'app_profiles'], ['app', 'app_profile_versions'],
    ['app', 'app_alerts'], ['app', 'app_ratings'], ['app', 'app_approvals'],
  ];
  // Seed otherwise-empty protected domains to detect content edits as well as inserts.
  for (const [kind, name] of protectedNames) {
    for (const db of kind === 'xcloud' ? xDbs : aDbs) {
      if (await db.collection(name).countDocuments({}) === 0 && name !== 'app_approvals') {
        await db.collection(name).insertOne({ fixture: 'protected', nested: { count: 0, value: 'preserve' } });
      }
    }
  }
  async function protectedSnapshot() {
    const out = [];
    for (const [kind, name] of protectedNames) {
      for (const db of kind === 'xcloud' ? xDbs : aDbs) out.push(await fingerprintCollection(db, name));
    }
    return out;
  }
  const protectedBefore = await protectedSnapshot();

  const authCases = [
    ['no token', null, 401], ['invalid token', 'not.a.valid.jwt', 401],
    ['expired token', await makeToken('operator_user', 'operator', 1, -3600), 401],
    ['revoked session', await makeToken('operator_user', 'operator', 99), 401],
    ['disabled account', await makeToken('disabled_user', 'operator', 1), 401],
    ['locked account', await makeToken('locked_user', 'operator', 1), 401],
    ['admin', adminToken, 200], ['operator', operatorToken, 200],
    ['viewer', await makeToken('viewer_user', 'viewer', 1), 403],
    ['root', await makeToken('root_user', 'root', 1), 200],
    ['super_admin', await makeToken('super_admin_user', 'super_admin', 1), 200],
    ['ops_admin', await makeToken('ops_admin_user', 'ops_admin', 1), 200],
    ['auditor', await makeToken('auditor_user', 'auditor', 1), 403],
  ];
  for (const kind of ['SH', 'BH']) {
    authCases.forEach(([label, token, status], i) => test(`${kind}-A${String(i + 1).padStart(2, '0')}`, label, async () => {
      const imsi = nextImsi();
      const before = await stateParity([imsi]);
      // Authentication error payloads differ at the pre-route middleware boundary;
      // compare status and rejection state, as in the auth parity acceptance suites.
      const payload = wrap(kind, { imsi, type: 'orphan_ocs' });
      const n = await callNode(endpoints[kind], 'POST', token, payload);
      const g = await callGo(endpoints[kind], 'POST', token, payload);
      assert.equal(n.status, status); assert.equal(g.status, status);
      if (status === 200) assert.deepStrictEqual(g.body, n.body);
      if (status === 403) { assert.equal(n.body.code, 'PERMISSION_DENIED'); assert.equal(g.body.code, n.body.code); }
      const after = await stateParity([imsi]);
      if (status !== 200) assert.deepStrictEqual(after, before);
      else assert.equal(after.subscribers.length, 1);
    }));
  }

  const validation = [
    ['malformed JSON', '{bad json', 500], ['empty object', {}, 400],
    ['missing imsi', { type: 'unknown_type' }, 400], ['missing type', { imsi: '001010000000001' }, 400],
    ['imsi empty', { imsi: '', type: 'unknown_type' }, 400], ['type empty', { imsi: '001010000000001', type: '' }, 400],
    ['14-digit IMSI', { imsi: '00101000000001', type: 'unknown_type' }, 400],
    ['16-digit IMSI', { imsi: '0010100000000001', type: 'unknown_type' }, 400],
    ['whitespace IMSI', { imsi: ' 001010000000001 ', type: 'unknown_type' }, 400],
    ['lowercase unknown', { imsi: 'unknown', type: 'unknown_type' }, 400],
    ['uppercase UNKNOWN', { imsi: 'UNKNOWN', type: 'orphan_ocs' }, 200],
    ['numeric 15-digit IMSI', { imsi: 123456789012345, type: 'orphan_ocs' }, 200],
  ];
  validation.forEach(([label, payload, status], i) => test(`SH-V${String(i + 1).padStart(2, '0')}`, label, async () => {
    const before = await stateParity();
    await pair('SH', payload, status);
    const after = await stateParity();
    if (status !== 200) assert.deepStrictEqual(after, before);
    else assert.ok(after.subscribers.some((s) => s.imsi === String(payload.imsi)));
  }));
  [
    ['malformed JSON', '{bad json', 500], ['anomalies missing', {}, 400],
    ['anomalies null', { anomalies: null }, 400], ['anomalies object', { anomalies: {} }, 400],
    ['anomalies empty array', { anomalies: [] }, 400],
  ].forEach(([label, payload, status], i) => test(`BH-V${String(i + 1).padStart(2, '0')}`, label, async () => {
    const before = await stateParity();
    await pair('BH', payload, status);
    assert.deepStrictEqual(await stateParity(), before);
  }));

  for (const kind of ['SH', 'BH']) {
    const profiles = kind === 'SH'
      ? [['omitted', undefined], ['empty', ''], ['whitespace', '   '], ['valid profile', 'custom_profile'], ['non-existent profile', 'absent_profile'], ['numeric profileName', 123]]
      : [['omitted', undefined], ['empty', ''], ['valid profile', 'custom_profile'], ['non-existent profile', 'absent_profile'], ['numeric profileName', 123]];
    profiles.forEach(([label, profileName], i) => test(`${kind}-P${String(i + 1).padStart(2, '0')}`, label, async () => {
      const imsis = Array.from({ length: kind === 'BH' ? 2 : 1 }, nextImsi);
      for (const imsi of imsis) await insertBoth('subscribers', validSub(imsi));
      const items = imsis.map((imsi) => ({ imsi, type: 'dangling_profile' }));
      const extra = profileName === undefined ? {} : { profileName };
      await pair(kind, kind === 'SH' ? { ...items[0], ...extra } : { anomalies: items, ...extra });
      const state = await stateParity(imsis);
      for (const sub of state.subscribers) {
        assert.equal(sub.profile_name, profileName ? String(profileName) : 'default');
        assert.equal(sub.profile, sub.profile_name);
        assert.equal(sub.webui_meta.profile_name, sub.profile_name);
        assert.deepStrictEqual(sub.untouched, validSub(sub.imsi).untouched);
      }
    }));
  }

  const typeCases = [
    ['orphan_ocs existing', 'orphan_ocs', true], ['orphan_ocs missing', 'orphan_ocs', false],
    ['missing_config existing', 'missing_config', true], ['missing_config missing', 'missing_config', false],
    ['balance_mismatch existing', 'balance_mismatch', true], ['balance_mismatch missing', 'balance_mismatch', false],
    ['invalid_tariff matching', 'invalid_tariff', true, 1], ['invalid_tariff no OCS match', 'invalid_tariff', false],
    ['dangling_profile explicit', 'dangling_profile', true, 0, 'custom_profile'], ['dangling_profile fallback', 'dangling_profile', false],
    ['orphan_reservation one row', 'orphan_reservation', true, 1], ['orphan_reservation multiple rows', 'orphan_reservation', true, 3],
    ['orphan_reservation no row', 'orphan_reservation', false],
    ['unknown type existing', 'unknown_type', true], ['unknown type missing', 'unknown_type', false],
  ];
  typeCases.forEach(([label, type, existing, matches = 0, profileName], i) => test(`SH-T${String(i + 1).padStart(2, '0')}`, label, async () => {
    const imsi = nextImsi();
    if (existing) await insertBoth('subscribers', validSub(imsi));
    if (type === 'invalid_tariff' && matches) await insertBoth('ocs_subscribers', { imsi, plan_id: 'absent', marker: 'preserve' });
    if (type === 'orphan_reservation') {
      for (let j = 0; j < matches; j++) await insertBoth('ocs_reservations', { imsi, reservation_id: `${imsi}-${j}`, state: 'active' });
    }
    const before = await stateParity([imsi]);
    await pair('SH', { imsi, type, ...(profileName ? { profileName } : {}) });
    const after = await stateParity([imsi]);
    assert.equal(after.subscribers.length, 1, 'Missing subscriber side effect must persist for every type');
    if (!existing) { assert.equal(after.subscribers[0].schema_version, 1); assert.ok(after.subscribers[0].security.k); }
    if (existing && type !== 'dangling_profile') assert.deepStrictEqual(after.subscribers, before.subscribers);
    if (type === 'missing_config' || type === 'balance_mismatch') {
      assert.equal(after.ocs_subscribers[0].plan_id, 'plan_default_10gb');
      assert.equal(after.ocs_balances[0].data_total, 10737418240);
      assert.equal(after.ocs_balances[0].version, 1);
    }
    if (type === 'invalid_tariff') {
      assert.equal(after.ocs_subscribers.length, matches);
      if (matches) assert.equal(after.ocs_subscribers[0].plan_id, 'plan_default_10gb');
    }
    if (type === 'dangling_profile') assert.equal(after.subscribers[0].profile_name, profileName || 'default');
    if (type === 'orphan_reservation') {
      assert.equal(after.ocs_reservations.length, matches);
      for (const row of after.ocs_reservations) { assert.equal(row.state, 'released'); assert.equal(row.released_at, '<BSON date>'); }
    }
    if (type === 'unknown_type' && existing) assert.deepStrictEqual(after, before);
  }));

  [
    ['one valid anomaly', ['dangling_profile'], 1, 0],
    ['multiple valid anomalies', ['dangling_profile', 'dangling_profile'], 2, 0],
    ['mixed remediation types', ['missing_config', 'invalid_tariff', 'orphan_reservation'], 3, 0],
    ['duplicate anomalies', ['missing_config', 'missing_config'], 2, 0],
    ['unknown type', ['unknown_type'], 1, 0],
    ['partial item failure', ['dangling_profile', 'malformed'], 1, 1],
    ['first success / second fail / third success', ['dangling_profile', 'malformed', 'missing_config'], 2, 1],
  ].forEach(([label, types, successCount, failedCount], i) => test(`BH-I${String(i + 1).padStart(2, '0')}`, label, async () => {
    const imsis = types.map(nextImsi);
    const anomalies = types.map((type, j) => type === 'malformed' ? {} : { imsi: i === 3 ? imsis[0] : imsis[j], type });
    if (i === 2) {
      await insertBoth('ocs_subscribers', { imsi: imsis[1], plan_id: 'absent' });
      await insertBoth('ocs_reservations', { imsi: imsis[2], state: 'active' });
    }
    const n = await pair('BH', { anomalies });
    assert.equal(n.body.successCount, successCount); assert.equal(n.body.failedCount, failedCount);
    assert.equal(n.body.errors.length, failedCount);
    const state = await stateParity(imsis);
    assert.equal(state.subscribers.length, i === 3 ? 1 : successCount);
    if (i === 3) assert.equal(state.ocs_balances[0].version, 2, 'Duplicate input executes twice');
    if (i === 2) { assert.equal(state.ocs_subscribers.find((s) => s.imsi === imsis[1]).plan_id, 'plan_default_10gb'); assert.equal(state.ocs_reservations[0].state, 'released'); }
    if (i === 6) assert.ok(state.ocs_balances.some((s) => s.imsi === imsis[2]), 'Third item must commit after captured failure');
  }));

  ['empty object', 'missing imsi', 'missing type', 'null', 'string', 'numeric', 'boolean'].forEach((label, i) => test(`BH-M${String(i + 1).padStart(2, '0')}`, `${label} item`, async () => {
    const [first, middle, last] = [nextImsi(), nextImsi(), nextImsi()];
    const item = [{}, { type: 'unknown_type' }, { imsi: middle }, null, 'text', 123, true][i];
    const n = await pair('BH', { anomalies: [{ imsi: first, type: 'orphan_ocs' }, item, { imsi: last, type: 'orphan_ocs' }] }, i === 3 ? 500 : 200);
    const state = await stateParity([first, middle, last]);
    assert.ok(state.subscribers.some((s) => s.imsi === first));
    if (i === 3) { assert.equal(state.subscribers.length, 1, 'Escaping null error stops before third item'); }
    else {
      assert.equal(n.body.successCount, i === 2 ? 3 : 2); assert.equal(n.body.failedCount, i === 2 ? 0 : 1);
      assert.equal(n.body.errors.length, n.body.failedCount);
      assert.equal(state.subscribers.length, n.body.successCount);
      assert.ok(state.subscribers.some((s) => s.imsi === last));
    }
    console.log(`[heal-parity] BH-M${String(i + 1).padStart(2, '0')} status=${n.status} body=${JSON.stringify(n.body)} committed_imsis=${JSON.stringify(state.subscribers.map((s) => s.imsi))}`);
  }));

  async function rejectWrites(dbs, name, fn) {
    await drainAfter();
    const start = new Date();
    for (const db of dbs) await db.command({ collMod: name, validator: { $expr: { $eq: [1, 2] } }, validationLevel: 'strict', validationAction: 'error' });
    try { await fn(start); await drainAfter(); }
    finally { for (const db of dbs) await db.command({ collMod: name, validator: {} }); }
  }
  async function rejectedWriteEvidence(dbs, name, start) {
    for (const db of dbs) {
      await waitFor(`${db.databaseName}.${name} real storage rejection`, async () => {
        return db.collection('system.profile').findOne({ ts: { $gte: start }, ns: `${db.databaseName}.${name}`, $or: [{ errCode: 121 }, { 'command.insert': name, ninserted: 0 }] });
      });
    }
    console.log(`[heal-parity] storage_failure_observed=true collection=${name} Node=true Go=true`);
  }
  test('SH-F01', 'real business repository failure', async () => {
    const imsi = nextImsi();
    await insertBoth('subscribers', validSub(imsi));
    const before = await stateParity([imsi]);
    await rejectWrites(xDbs, 'subscribers', async (start) => {
      await pair('SH', { imsi, type: 'dangling_profile' }, 500);
      await rejectedWriteEvidence(xDbs, 'subscribers', start);
    });
    assert.deepStrictEqual(await stateParity([imsi]), before);
  });
  test('BH-F01', 'batch repository helper escaping failure after committed first item', async () => {
    // Node catches ordinary Mongo failures per item. A null item throws again in
    // the repository catch formatter and escapes the entire helper (HTTP 500).
    const first = nextImsi(), last = nextImsi();
    await pair('BH', { anomalies: [{ imsi: first, type: 'missing_config' }, null, { imsi: last, type: 'orphan_ocs' }] }, 500);
    const state = await stateParity([first, last]);
    assert.equal(state.subscribers.length, 1); assert.equal(state.subscribers[0].imsi, first);
    assert.equal(state.ocs_balances[0].version, 1);
  });
  for (const kind of ['SH', 'BH']) {
    test(`${kind}-F02`, 'audit persistence failure remains best-effort', async () => {
      const imsi = nextImsi();
      await insertBoth('subscribers', validSub(imsi));
      await rejectWrites(aDbs, 'app_audit_logs', async (start) => {
        await pair(kind, wrap(kind, { imsi, type: 'missing_config' }));
        await rejectedWriteEvidence(aDbs, 'app_audit_logs', start);
        await drainAfter();
        const state = await stateParity([imsi]);
        assert.equal(state.ocs_balances[0].version, 1, 'One execution, no rollback or duplicate provisioning');
        for (const db of aDbs) assert.equal(await db.collection('app_audit_logs').countDocuments({ action: 'HEAL', 'newData': { $exists: true }, $or: [{ targetId: imsi }, { 'newData.count': 1, timestamp: { $gte: start.toISOString() } }] }), 0);
      });
    });
    test(`${kind}-F03`, 'rate-limit storage failure preserves fail-open business execution', async () => {
      const imsi = nextImsi();
      await rejectWrites(aDbs, 'app_rate_limits', async (start) => {
        await pair(kind, wrap(kind, { imsi, type: 'missing_config' }));
        await rejectedWriteEvidence(aDbs, 'app_rate_limits', start);
        const state = await stateParity([imsi]);
        assert.equal(state.subscribers.length, 1); assert.equal(state.ocs_balances[0].version, 1);
      });
    });
  }

  // Each boundary row establishes its own budget, so rows run independently.
  for (const [kind, limit] of [['SH', 20], ['BH', 10]]) {
    async function exhaust() {
      // Avoid a real fixed-window rollover during this bounded HTTP sequence.
      const left = 60000 - Date.now() % 60000;
      if (left < 10000) await new Promise((r) => setTimeout(r, left + 20));
      const imsi = nextImsi();
      await insertBoth('subscribers', validSub(imsi));
      const payload = wrap(kind, { imsi, type: 'unknown_type' });
      const startWindow = Math.floor(Date.now() / 60000);
      for (let i = 0; i < limit; i++) await pair(kind, payload);
      assert.equal(Math.floor(Date.now() / 60000), startWindow, 'Boundary requests must share a fixed window');
      for (const db of aDbs) {
        const row = await db.collection('app_rate_limits').findOne({ key: `RATELIMIT:system:audit-${kind === 'SH' ? 'heal' : 'batch-heal'}:operator_user:${startWindow}` });
        assert.equal(row?.count, limit);
      }
      return payload;
    }
    test(`${kind}-R01`, `${limit}/60 allowed boundary`, async () => { await exhaust(); });
    test(`${kind}-R02`, `${limit + 1} request denied`, async () => {
      const payload = await exhaust();
      const n = await callNode(endpoints[kind], 'POST', operatorToken, payload);
      const g = await callGo(endpoints[kind], 'POST', operatorToken, payload);
      assert.equal(n.status, 429); assert.equal(g.status, 429); assert.deepStrictEqual(g.body, n.body);
      for (const r of [n, g]) { assert.equal(r.headers.get('x-ratelimit-limit'), String(limit)); assert.equal(r.headers.get('x-ratelimit-remaining'), '0'); assert.ok(Number(r.headers.get('retry-after')) > 0); }
      assert.equal(g.headers.get('x-ratelimit-reset'), n.headers.get('x-ratelimit-reset'));
    });
    test(`${kind}-R03`, 'per-user isolation', async () => {
      const payload = await exhaust();
      await pair(kind, payload, 429);
      await pair(kind, payload, 200, adminToken);
    });
  }
  test('BH-R04', 'single/batch limiter independence', async () => {
    const imsi = nextImsi();
    await insertBoth('subscribers', validSub(imsi));
    const item = { imsi, type: 'unknown_type' };
    const left = 60000 - Date.now() % 60000;
    if (left < 10000) await new Promise((r) => setTimeout(r, left + 20));
    for (let i = 0; i < 20; i++) await pair('SH', item);
    await pair('SH', item, 429);
    await pair('BH', { anomalies: [item] });
    for (const db of aDbs) {
      const rows = await db.collection('app_rate_limits').find({}).toArray();
      assert.equal(rows.find((r) => r.key.includes('system:audit-heal:operator_user:'))?.count, 21);
      assert.equal(rows.find((r) => r.key.includes('system:audit-batch-heal:operator_user:'))?.count, 1);
    }
  });

  // --- RS01-RS05: one continuous persistent-state remediation sequence -----------
  // All five remediation targets are established in exactly ONE initial fixture
  // batch. From PROTECTED SEQUENCE START to the final cumulative verification the
  // harness performs zero Mongo writes; the Mongo command monitor enforces this
  // with executable assertions. Each step inherits the persisted outcomes of all
  // previous steps, so the suite proves one evolving state machine rather than
  // five isolated fixture -> scan -> heal -> re-scan units.
  const rsTargets = [
    { id: 'RS01', type: 'missing_config', phase: 'sub' },
    { id: 'RS02', type: 'balance_mismatch', phase: 'ocs' },
    { id: 'RS03', type: 'invalid_tariff', phase: 'tariff' },
    { id: 'RS04', type: 'dangling_profile', phase: 'sub' },
    { id: 'RS05', type: 'orphan_reservation', phase: 'reservation' },
  ].map((step) => ({ ...step, imsi: nextImsi() }));
  let rsFixtureBatches = 0;
  let rsProtectedStart = null;
  const rsCompleted = [];

  function rsAssertHealed(type, imsi, state) {
    const sub = state.subscribers.find((doc) => doc.imsi === imsi);
    const balance = state.ocs_balances.find((doc) => doc.imsi === imsi);
    const ocsSub = state.ocs_subscribers.find((doc) => doc.imsi === imsi);
    const reservations = state.ocs_reservations.filter((doc) => doc.imsi === imsi);
    if (type === 'missing_config') { assert.ok(sub, 'missing_config target subscriber must persist'); assert.ok(!sub.security); assert.equal(balance.version, 1); }
    if (type === 'balance_mismatch') assert.equal(balance.data_total, balance.data_used + balance.data_reserved + balance.data_available);
    if (type === 'invalid_tariff') assert.equal(ocsSub.plan_id, 'plan_default_10gb');
    if (type === 'dangling_profile') assert.equal(sub.webui_meta.profile_name, 'default');
    if (type === 'orphan_reservation') assert.equal(reservations[0].state, 'released');
  }

  async function rsCumulativeState() {
    return stateParity(rsTargets.map((target) => target.imsi));
  }

  async function rsScan(imsi, phase) {
    const n = await callNode('/api/system/audit/scan', 'POST', adminToken, { cursor: '0', phase });
    const g = await callGo('/api/system/audit/scan', 'POST', adminToken, { cursor: '0', phase });
    assert.equal(n.status, 200); assert.equal(g.status, 200);
    const target = (r) => r.body.anomalies.filter((a) => a.imsi === imsi).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    assert.deepStrictEqual(target(g), target(n), 'Post/pre-scan exact anomaly parity');
    return target(n);
  }

  // One-time fixture establishment for the whole protected sequence.
  async function rsEstablishFixtures() {
    for (const target of rsTargets) {
      const sub = target.type === 'missing_config' ? { imsi: target.imsi } : validSub(target.imsi);
      if (target.type === 'dangling_profile') { sub.profile_name = 'deleted'; sub.profile = 'deleted'; sub.webui_meta = { profile_name: 'deleted' }; }
      await insertBoth('subscribers', sub);
      if (target.type === 'balance_mismatch' || target.type === 'invalid_tariff') await insertBoth('ocs_subscribers', { imsi: target.imsi, plan_id: target.type === 'invalid_tariff' ? 'deleted' : 'plan_default_10gb' });
      if (target.type === 'balance_mismatch') await insertBoth('ocs_balances', { imsi: target.imsi, data_total: 1000, data_used: 100, data_reserved: 20, data_available: 1, voice_total: 100, voice_used: 10, voice_reserved: 0, voice_available: 90, sms_total: 100, sms_used: 0, sms_available: 100 });
      if (target.type === 'orphan_reservation') await insertBoth('ocs_reservations', { imsi: target.imsi, reservation_id: target.imsi, session_id: 'absent-session', state: 'active' });
    }
    rsFixtureBatches += 1;
  }

  rsTargets.forEach((target, index) => test(target.id, `${target.type} continuous remediation step`, async () => {
    if (index === 0) {
      await rsEstablishFixtures();
      assert.equal(rsFixtureBatches, 1, 'Exactly one initial RS fixture establishment batch');
      // PROTECTED SEQUENCE START: no harness writes are permitted from here on.
      rsProtectedStart = fixtureWrites.length;
    }
    assert.notEqual(rsProtectedStart, null, 'RS protected-sequence baseline must be captured');
    assert.equal(fixtureWrites.length, rsProtectedStart, 'No harness fixture writes between RS steps');

    // Inherited-state proof: every prior remediation outcome must still be persisted.
    if (index > 0) {
      const inherited = await rsCumulativeState();
      for (const done of rsCompleted) rsAssertHealed(done.type, done.imsi, inherited);
      console.log(`[heal-parity] ${target.id} inherited_state_verified=${rsCompleted.map((done) => done.id).join('+')}`);
    }

    // Real Node and Go pre-scan with exact parity and intended anomaly visibility.
    const before = await rsScan(target.imsi, target.phase);
    assert.ok(before.some((a) => a.type === target.type), 'Explicit pre-scan must observe target');

    // Real Node and Go remediation.
    await pair('SH', { imsi: target.imsi, type: target.type });
    const fixtureWriteCount = fixtureWrites.length;

    // Persisted state from both databases plus expected remediation mutation.
    const healed = await stateParity([target.imsi]);
    rsAssertHealed(target.type, target.imsi, healed);

    // Real Node and Go post-scan parity. Only read operations occur in between.
    const after = await rsScan(target.imsi, target.phase);
    assert.equal(fixtureWrites.length, fixtureWriteCount, 'No fixture database mutation between heal and re-scan');
    assert.deepStrictEqual(await stateParity([target.imsi]), healed, 'Scanner must not repair persisted state');
    const remains = after.some((a) => a.type === target.type);
    assert.equal(remains, target.type === 'missing_config' || target.type === 'orphan_reservation');
    rsCompleted.push(target);
    console.log(`[heal-parity] ${target.id} ${target.type} manual_db_repair_between_heal_and_rescan=false post_scan_outcome=${remains ? 'target_remains' : after.length ? 'other_anomaly' : 'cleared'} Node=${JSON.stringify(after)} Go=${JSON.stringify(after)}`);

    // Cumulative verification plus executable zero-harness-write assertion.
    const cumulative = await rsCumulativeState();
    for (const done of rsCompleted) rsAssertHealed(done.type, done.imsi, cumulative);
    const interstepWrites = fixtureWrites.length - rsProtectedStart;
    assert.equal(interstepWrites, 0, 'Protected RS sequence must perform zero harness fixture writes');

    if (index === rsTargets.length - 1) {
      assert.equal(rsCompleted.length, rsTargets.length, 'All five RS remediation outcomes must persist together');
      assert.ok(rsTargets.every((step) => executedIds.includes(step.id)), 'RS01-RS05 must all execute in strict order');
      console.log('[heal-parity] rs_sequence=RS01,RS02,RS03,RS04,RS05');
      console.log('[heal-parity] rs_sequence_continuous=true');
      console.log(`[heal-parity] rs_initial_fixture_batches=${rsFixtureBatches}`);
      console.log(`[heal-parity] rs_interstep_fixture_writes=${interstepWrites}`);
      console.log('[heal-parity] rs_cumulative_state_verified=true');
    }
  }));

  test('INV01', 'protected content fingerprints and zero approval writes', async () => {
    assert.deepStrictEqual(await protectedSnapshot(), protectedBefore);
    for (const db of aDbs) assert.equal(await db.collection('app_approvals').countDocuments({}), 0);
  });
  test('INV02', 'operation and authorization denial audit evidence', async () => {
    for (const db of aDbs) {
      await waitFor('HEAL audit evidence', () => db.collection('app_audit_logs').findOne({ action: 'HEAL' }));
      await waitFor('authorization.denied audit evidence', () => db.collection('app_audit_logs').findOne({ action: 'authorization.denied' }));
    }
  });
  test('INV03', 'static explicit-execution and production fault-switch guard', async () => {
    function sources(dir) {
      return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? sources(resolve(dir, entry.name)) : /\.(go|ts)$/.test(entry.name) && !/(_test\.go|\.test\.ts)$/.test(entry.name) ? [resolve(dir, entry.name)] : []);
    }
    const repoFile = resolve(rootDir, 'frontend/src/server/repositories/systemAuditRepository.ts');
    for (const path of sources(resolve(rootDir, 'frontend/src'))) {
      const source = readFileSync(path, 'utf8');
      if (/\b(?:healSubscriberDocument|batchHealSubscriberDocuments)\s*\(/.test(source)) {
        assert.ok(path === repoFile || /[\\/]api[\\/]system[\\/]audit[\\/](heal|batch-heal)[\\/]route\.ts$/.test(path), `Unexpected Node heal caller: ${path}`);
      }
    }
    for (const path of sources(resolve(backendDir, 'internal'))) {
      const source = readFileSync(path, 'utf8');
      if (/\.(?:HealSubscriberDocument|BatchHealSubscriberDocuments)\s*\(/.test(source)) assert.ok(/[\\/]remediation[\\/](handler|repository)\.go$/.test(path), `Unexpected Go heal caller: ${path}`);
    }
    for (const path of [repoFile, ...sources(resolve(backendDir, 'internal/remediation'))]) {
      const source = readFileSync(path, 'utf8');
      assert.ok(!/cron\.|time\.(?:NewTicker|Ticker|AfterFunc)|setInterval|TEST_FAIL_|FAIL_HEAL|go\s+func\s*\(/.test(source));
    }
  });
  test('INV04', 'read-only scan and idle period do not autonomously heal', async () => {
    const imsi = nextImsi();
    await insertBoth('subscribers', { imsi });
    const before = await stateParity([imsi]);
    for (const call of [callNode, callGo]) assert.equal((await call('/api/system/audit/scan', 'POST', adminToken, { phase: 'sub', cursor: '0' })).status, 200);
    await new Promise((r) => setTimeout(r, 1100));
    assert.deepStrictEqual(await stateParity([imsi]), before);
  });
  test('INV05', 'routing freeze: 36 routes, Node remediation owners, zero Phase 7 cutover', async () => {
    assert.equal(CUTOVER_TABLE.length, 36);
    assert.equal(CUTOVER_TABLE.filter((r) => r.owner === 'go').length, 36);
    for (const path of ['/api/alerts', '/api/alerts/acknowledge', '/api/alerts/workflow', '/api/notifications/stream', '/api/system/health', '/api/system/mongo/health', '/api/system/audit/status', '/api/system/audit/scan', ...Object.values(endpoints), '/api/analytics/init']) {
      assert.ok(!CUTOVER_TABLE.some((r) => r.path === path));
    }
  });

  const registered = inventory(cases.map((c) => c.id));
  assert.deepStrictEqual(registered.missing, [], 'Mandatory IDs absent before execution');
  assert.deepStrictEqual(registered.duplicate, [], 'Duplicate registered IDs');
  assert.equal(REQUIRED_IDS.length, 96);
  console.log('[heal-parity] mandatory_ids_expected=96');
  // Budgets are reset once before the protected sequence (before RS01) and never
  // again inside it: a harness write between RS steps would invalidate the
  // continuous-state evidence. The heal budget used inside the sequence is 5/20
  // and the scan budget 10/30, both far below the fixed-window limits.
  const rsInteriorIds = new Set(rsTargets.slice(1).map((target) => target.id));
  for (const c of cases) {
    if (!rsInteriorIds.has(c.id)) await clearBudgets();
    executedIds.push(c.id);
    await verifyAsync(`${c.id} ${c.description}`, c.run);
  }
  const completed = inventory(executedIds);
  const executedMandatory = REQUIRED_IDS.filter((id) => executedIds.includes(id)).length;
  console.log(`[heal-parity] mandatory_ids_executed=${executedMandatory}`);
  console.log(`[heal-parity] mandatory_ids_missing=${completed.missing.length}`);
  console.log(`[heal-parity] mandatory_ids_duplicate=${completed.duplicate.length}`);
  assert.equal(executedMandatory, 96, 'All 96 mandatory callbacks must actually execute');
  assert.deepStrictEqual(completed, { missing: [], duplicate: [] });
  assert.ok(['RS01', 'RS02', 'RS03', 'RS04', 'RS05'].every((id) => executedIds.includes(id)));

  console.log('\n========================================================================');
  console.log('Phase 7.4 Controlled Remediation Parity Suite Summary');
  console.log(`TOTAL: ${totalChecks}`);
  console.log(`PASS:  ${passed}`);
  console.log(`FAIL:  ${failed}`);
  console.log('SKIP:  0');
  console.log('========================================================================\n');

  await cleanup();
}

main().catch(async (err) => {
  console.error('Test suite failed:', err);
  process.exitCode = 1;
  await cleanup();
});
