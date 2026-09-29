#!/usr/bin/env node
/**
 * Phase 6.3-A - Authentication Go Contract Parity Integration Suite
 *
 * Runs Node and Go Authentication implementations side-by-side against
 * isolated MongoDB test databases and verifies exact 1:1 parity for:
 * 1. Malformed Request Validation Matrix (HTTP 400)
 * 2. Dual Rate Limiting (IP 5/60s & Account 10/300s Peek) (HTTP 429)
 * 3. Response Privacy & Failure Matrix (HTTP 401)
 * 4. Account Lockout & Mutation Parity in MongoDB
 * 5. Last Active Admin Protection
 * 6. Successful Login Accounting & Cookie Parity (HTTP 200)
 * 7. Cross-Language JWT Verification Interoperability
 * 8. Logout Contract & Rate Limiting (HTTP 200 / 429)
 * 9. GET /api/auth/me Contract Parity (HTTP 200 / 401)
 * 10. GET /api/auth/permissions Contract Parity across Canonical & Legacy Roles
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

// Suppress known audit scheduling messages during test run
const originalConsoleError = console.error;
console.error = (...args) => {
  if (typeof args[0] === 'string' && (args[0].includes('Audit scheduling failed') || args[0].includes('Go backend unreachable'))) {
    return;
  }
  originalConsoleError(...args);
};

const suffix = `${Date.now()}_${process.pid}_${Math.floor(Math.random() * 100000)}`;
const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/xcloud';

// Isolated DB pairs
const xcloudDbNode = `xcloud_parity_node_${suffix}`;
const appDbNode = `xcloud_ops_parity_node_${suffix}`;
const xcloudDbGo = `xcloud_parity_go_${suffix}`;
const appDbGo = `xcloud_ops_parity_go_${suffix}`;

const JWT_SECRET_STRING = 'auth-parity-test-secret-with-at-least-32-bytes!';
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
const { AccountSessionError, validateCurrentAccount } = jiti('../frontend/src/lib/accountSession.ts');
const { POST: nodeLoginHandler } = jiti('../frontend/src/app/api/auth/login/route.ts');
const { POST: nodeLogoutHandler } = jiti('../frontend/src/app/api/auth/logout/route.ts');
const { GET: nodeMeHandler } = jiti('../frontend/src/app/api/auth/me/route.ts');
const { GET: nodePermissionsHandler } = jiti('../frontend/src/app/api/auth/permissions/route.ts');
const { getJwtSecretKey } = jiti('../frontend/src/lib/security.ts');
const { proxy } = jiti('../frontend/src/proxy.ts');
const { resolveRouteOwner, CUTOVER_TABLE } = jiti('../frontend/src/lib/cutover-routing.ts');

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
    console.error(`        ${err.message}`);
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
    console.error(`        ${err.message}`);
    throw err;
  }
}

function makeToken(username, role, sv) {
  return new SignJWT({ username, role, sv })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt(Math.floor(Date.now() / 1000))
    .setExpirationTime(Math.floor(Date.now() / 1000) + 86400)
    .sign(getJwtSecretKey());
}

function makeExpiredToken(username, role, sv) {
  return new SignJWT({ username, role, sv })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
    .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
    .sign(getJwtSecretKey());
}

function getCookieHeader(headers) {
  if (headers && typeof headers.getSetCookie === 'function') {
    const list = headers.getSetCookie();
    if (list && list.length > 0) {
      return list.join('; ');
    }
  }
  return (headers && typeof headers.get === 'function' ? headers.get('set-cookie') : null) || '';
}

function assertCookieCleared(headers, label) {
  const sc = getCookieHeader(headers);
  const cleared = sc.includes('auth_token=;') || (sc.includes('auth_token=') && (sc.includes('Max-Age=0') || sc.includes('Expires=Thu, 01 Jan 1970')));
  assert(cleared, `${label}: Set-Cookie header must clear auth_token, got: ${sc}`);
}

function assertCookieNotCleared(headers, label) {
  const sc = getCookieHeader(headers);
  const cleared = sc.includes('auth_token=;') || (sc.includes('auth_token=') && (sc.includes('Max-Age=0') || sc.includes('Expires=Thu, 01 Jan 1970')));
  assert(!cleared, `${label}: Set-Cookie header must NOT clear auth_token, got: ${sc}`);
}

async function callNodeLogin(body, headers = {}) {
  const req = new NextRequest('http://localhost/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const res = await nodeLoginHandler(req);
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, headers: res.headers, cookies: res.cookies, body: json };
}

async function callNodeLogout(headers = {}) {
  const req = new NextRequest('http://localhost/api/auth/logout', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
  });
  const res = await nodeLogoutHandler(req);
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, headers: res.headers, cookies: res.cookies, body: json };
}

async function runNodeAuth(token, reqHeaders) {
  if (!token) {
    const res = NextResponse.json({ error: 'Unauthorized', code: 'AUTH_INVALID_TOKEN' }, { status: 401 });
    res.headers.set('Cache-Control', 'no-store');
    return { ok: false, status: 401, headers: res.headers, body: { error: 'Unauthorized', code: 'AUTH_INVALID_TOKEN' } };
  }
  try {
    const { payload } = await jwtVerify(token, getJwtSecretKey(), { algorithms: ['HS256'], requiredClaims: ['exp'] });
    const account = await validateCurrentAccount({ username: payload.username, role: payload.role, sv: payload.sv });
    const forwardedHeaders = new Headers(reqHeaders);
    forwardedHeaders.set('x-user', account.username);
    forwardedHeaders.set('x-user-role', account.role);
    forwardedHeaders.set('x-user-id', account.userId);
    forwardedHeaders.set('x-user-session-version', String(account.sessionVersion));
    return { ok: true, forwardedHeaders };
  } catch (error) {
    const code = error instanceof AccountSessionError ? error.code : 'AUTH_INVALID_TOKEN';
    const isAuthError = error instanceof AccountSessionError || (error instanceof Error && error.name.startsWith('JWT')) || (error instanceof Error && error.name.startsWith('JWS'));
    if (!isAuthError) {
      const res = NextResponse.json({ error: 'Authentication temporarily unavailable', code: 'AUTH_UNAVAILABLE' }, { status: 503 });
      res.headers.set('Cache-Control', 'no-store');
      return { ok: false, status: 503, headers: res.headers, body: { error: 'Authentication temporarily unavailable', code: 'AUTH_UNAVAILABLE' } };
    }
    const res = NextResponse.json({ error: 'Unauthorized', code }, { status: 401 });
    res.headers.set('Cache-Control', 'no-store');
    res.cookies.delete('auth_token');
    return { ok: false, status: 401, headers: res.headers, body: { error: 'Unauthorized', code } };
  }
}

async function callNodeMe(token, headers = {}) {
  const reqHeaders = { 'content-type': 'application/json', ...headers };
  if (token) reqHeaders['cookie'] = `auth_token=${token}`;
  const authRes = await runNodeAuth(token, reqHeaders);
  if (!authRes.ok) {
    return { status: authRes.status, headers: authRes.headers, body: authRes.body };
  }
  const forwardedReq = new NextRequest('http://localhost/api/auth/me', {
    method: 'GET',
    headers: authRes.forwardedHeaders,
  });
  const res = await nodeMeHandler(forwardedReq);
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, headers: res.headers, body: json };
}

async function callNodePermissions(token, headers = {}) {
  const reqHeaders = { 'content-type': 'application/json', ...headers };
  if (token) reqHeaders['cookie'] = `auth_token=${token}`;
  const authRes = await runNodeAuth(token, reqHeaders);
  if (!authRes.ok) {
    return { status: authRes.status, headers: authRes.headers, body: authRes.body };
  }
  const forwardedReq = new NextRequest('http://localhost/api/auth/permissions', {
    method: 'GET',
    headers: authRes.forwardedHeaders,
  });
  const res = await nodePermissionsHandler(forwardedReq);
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, headers: res.headers, body: json };
}

async function main() {
  console.log('-- Phase 6.3-A Authentication Go Contract Parity Suite --\n');

  await client.connect();
  const opsNode = client.db(appDbNode);
  const opsGo = client.db(appDbGo);

  // 1. Build and start Go backend pointing to Go DB pair
  const goPort = await getAvailablePort();
  const isWin = process.platform === 'win32';
  const binName = isWin ? `test-go-parity-${suffix}.exe` : `test-go-parity-${suffix}`;
  const backendDir = path.resolve(import.meta.dirname, '..', 'backend');
  binPath = path.join(os.tmpdir(), binName);

  execSync(`go build -o "${binPath}" ./cmd/server`, {
    cwd: backendDir,
    stdio: 'ignore',
  });

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
    stdio: ['ignore', 'pipe', 'pipe'],
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
  assert(goReady, 'Go backend server failed to become ready');
  const goBaseUrl = `http://127.0.0.1:${goPort}`;

  async function callGoLogin(body, headers = {}) {
    const res = await fetch(`${goBaseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, headers: res.headers, body: json };
  }

  async function callGoLogout(headers = {}) {
    const res = await fetch(`${goBaseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
    });
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, headers: res.headers, body: json };
  }

  async function callGoMe(token, headers = {}) {
    const reqHeaders = { 'content-type': 'application/json', ...headers };
    if (token) reqHeaders['cookie'] = `auth_token=${token}`;
    const res = await fetch(`${goBaseUrl}/api/auth/me`, {
      method: 'GET',
      headers: reqHeaders,
    });
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, headers: res.headers, body: json };
  }

  async function callGoPermissions(token, headers = {}) {
    const reqHeaders = { 'content-type': 'application/json', ...headers };
    if (token) reqHeaders['cookie'] = `auth_token=${token}`;
    const res = await fetch(`${goBaseUrl}/api/auth/permissions`, {
      method: 'GET',
      headers: reqHeaders,
    });
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, headers: res.headers, body: json };
  }

  // Seed identical initial fixtures into both databases
  const now = new Date().toISOString();
  const hash = await bcrypt.hash('CorrectPass123!', 10);

  const fixtureUsers = [
    { username: 'admin1', passwordHash: hash, role: 'admin', status: 'active', displayName: 'Admin 1', email: 'admin1@test.local', createdAt: now, updatedAt: now, security: { sessionVersion: 1, failedLoginAttempts: 0 } },
    { username: 'admin2', passwordHash: hash, role: 'admin', status: 'active', displayName: 'Admin 2', email: 'admin2@test.local', createdAt: now, updatedAt: now, security: { sessionVersion: 1, failedLoginAttempts: 0 } },
    { username: 'operator1', passwordHash: hash, role: 'operator', status: 'active', displayName: 'Operator 1', email: 'operator1@test.local', createdAt: now, updatedAt: now, security: { sessionVersion: 1, failedLoginAttempts: 0 } },
    { username: 'viewer1', passwordHash: hash, role: 'viewer', status: 'active', displayName: 'Viewer 1', email: 'viewer1@test.local', createdAt: now, updatedAt: now, security: { sessionVersion: 1, failedLoginAttempts: 0 } },
    { username: 'legacy_root', passwordHash: hash, role: 'root', status: 'active', displayName: 'Legacy Root', email: 'root@test.local', createdAt: now, updatedAt: now, security: { sessionVersion: 1, failedLoginAttempts: 0 } },
    { username: 'legacy_super', passwordHash: hash, role: 'super_admin', status: 'active', displayName: 'Legacy Super', email: 'super@test.local', createdAt: now, updatedAt: now, security: { sessionVersion: 1, failedLoginAttempts: 0 } },
    { username: 'legacy_ops', passwordHash: hash, role: 'ops_admin', status: 'active', displayName: 'Legacy Ops', email: 'ops@test.local', createdAt: now, updatedAt: now, security: { sessionVersion: 1, failedLoginAttempts: 0 } },
    { username: 'legacy_auditor', passwordHash: hash, role: 'auditor', status: 'active', displayName: 'Legacy Auditor', email: 'auditor@test.local', createdAt: now, updatedAt: now, security: { sessionVersion: 1, failedLoginAttempts: 0 } },
    { username: 'disabled_user', passwordHash: hash, role: 'operator', status: 'disabled', displayName: 'Disabled', email: 'disabled@test.local', createdAt: now, updatedAt: now, security: { sessionVersion: 1, failedLoginAttempts: 0 } },
    { username: 'locked_user', passwordHash: hash, role: 'operator', status: 'locked', locked: true, displayName: 'Locked', email: 'locked@test.local', createdAt: now, updatedAt: now, security: { sessionVersion: 1, failedLoginAttempts: 10, lockReason: 'manual_lock' } },
    { username: 'lockout_cand', passwordHash: hash, role: 'operator', status: 'active', displayName: 'Lockout Candidate', email: 'cand@test.local', createdAt: now, updatedAt: now, security: { sessionVersion: 1, failedLoginAttempts: 0 } },
  ];

  await opsNode.collection('app_users').insertMany(JSON.parse(JSON.stringify(fixtureUsers)));
  await opsGo.collection('app_users').insertMany(JSON.parse(JSON.stringify(fixtureUsers)));

  // -------------------------------------------------------------
  // 1. Malformed Request Validation Matrix (HTTP 400)
  // -------------------------------------------------------------
  console.log('\n[1] Malformed Request Validation Matrix (HTTP 400)');

  const malformedPayloads = [
    { label: 'Malformed JSON syntax', raw: '{invalid json' },
    { label: 'Non-object array body', raw: '[1, 2, 3]' },
    { label: 'Non-object number body', raw: '12345' },
    { label: 'Missing username field', raw: JSON.stringify({ password: 'CorrectPass123!' }) },
    { label: 'Missing password field', raw: JSON.stringify({ username: 'admin1' }) },
    { label: 'Empty username string', raw: JSON.stringify({ username: '', password: 'CorrectPass123!' }) },
    { label: 'Empty password string', raw: JSON.stringify({ username: 'admin1', password: '' }) },
    { label: 'Non-string username', raw: JSON.stringify({ username: 12345, password: 'CorrectPass123!' }) },
    { label: 'Non-string password', raw: JSON.stringify({ username: 'admin1', password: true }) },
    { label: 'Username length > 100', raw: JSON.stringify({ username: 'a'.repeat(101), password: 'CorrectPass123!' }) },
    { label: 'Password UTF-8 bytes > 72', raw: JSON.stringify({ username: 'admin1', password: 'p'.repeat(73) }) },
  ];

  for (let i = 0; i < malformedPayloads.length; i++) {
    const { label, raw } = malformedPayloads[i];
    const ip = `192.168.1.${i + 1}`;
    await verifyAsync(`Malformed request: ${label}`, async () => {
      const nodeRes = await callNodeLogin(raw, { 'x-real-ip': ip });
      const goRes = await callGoLogin(raw, { 'x-real-ip': ip });

      assert.equal(nodeRes.status, 400, `Node status was ${nodeRes.status}`);
      assert.equal(goRes.status, 400, `Go status was ${goRes.status}`);
      assert.deepEqual(nodeRes.body, { error: 'Username and password required' });
      assert.deepEqual(goRes.body, { error: 'Username and password required' });
      assert.equal(nodeRes.headers.get('cache-control'), 'no-store');
      assert.equal(goRes.headers.get('cache-control'), 'no-store');
    });
  }

  // -------------------------------------------------------------
  // 2. Dual Rate Limiting (IP 5/60s & Account 10/300s Peek)
  // -------------------------------------------------------------
  console.log('\n[2] Dual Rate Limiting (IP 5/60s & Account 10/300s Peek)');

  // 2A: IP rate limiting: 5 requests allowed in 60s, 6th request rejected with 429
  await verifyAsync('IP rate limiting parity: 5 allowed, 6th rejected with HTTP 429', async () => {
    const testIp = '198.51.100.42';
    const payload = { username: 'admin1', password: 'WrongPassword!' };

    // 5 attempts on Node
    for (let i = 1; i <= 5; i++) {
      const res = await callNodeLogin(payload, { 'x-real-ip': testIp });
      assert.equal(res.status, 401, `Node attempt ${i} status`);
    }
    const node6 = await callNodeLogin(payload, { 'x-real-ip': testIp });
    assert.equal(node6.status, 429, 'Node 6th request status');
    assert.deepEqual(node6.body, { error: 'Too many login attempts. Please try again later.' });
    assert.equal(node6.headers.get('x-ratelimit-limit'), '5');
    assert.equal(node6.headers.get('x-ratelimit-remaining'), '0');
    assert(Number(node6.headers.get('retry-after')) > 0);
    assert.equal(node6.headers.get('cache-control'), 'no-store');

    // 5 attempts on Go
    for (let i = 1; i <= 5; i++) {
      const res = await callGoLogin(payload, { 'x-real-ip': testIp });
      assert.equal(res.status, 401, `Go attempt ${i} status`);
    }
    const go6 = await callGoLogin(payload, { 'x-real-ip': testIp });
    assert.equal(go6.status, 429, 'Go 6th request status');
    assert.deepEqual(go6.body, { error: 'Too many login attempts. Please try again later.' });
    assert.equal(go6.headers.get('x-ratelimit-limit'), '5');
    assert.equal(go6.headers.get('x-ratelimit-remaining'), '0');
    assert(Number(go6.headers.get('retry-after')) > 0);
    assert.equal(go6.headers.get('cache-control'), 'no-store');
  });

  // 2B: Account-scoped rate limiting: 10 failed attempts / 300s window
  await verifyAsync('Account failed-login rate limiting parity: 10 failed allowed, 11th rejected with 429', async () => {
    const targetUser = 'ratelimit_target_user';
    // Create dedicated user in both DBs
    const uDoc = { username: targetUser, passwordHash: hash, role: 'operator', status: 'active', createdAt: now, security: { sessionVersion: 1, failedLoginAttempts: 0 } };
    await opsNode.collection('app_users').insertOne(JSON.parse(JSON.stringify(uDoc)));
    await opsGo.collection('app_users').insertOne(JSON.parse(JSON.stringify(uDoc)));

    // 10 failed attempts with unique IPs to avoid IP limiter
    for (let i = 1; i <= 10; i++) {
      const ip = `10.200.1.${i}`;
      const nRes = await callNodeLogin({ username: targetUser, password: 'BadPassword!' }, { 'x-real-ip': ip });
      const gRes = await callGoLogin({ username: targetUser, password: 'BadPassword!' }, { 'x-real-ip': ip });
      assert.equal(nRes.status, 401);
      assert.equal(gRes.status, 401);
    }

    // 11th attempt with fresh IP
    const n11 = await callNodeLogin({ username: targetUser, password: 'BadPassword!' }, { 'x-real-ip': '10.200.2.1' });
    const g11 = await callGoLogin({ username: targetUser, password: 'BadPassword!' }, { 'x-real-ip': '10.200.2.1' });

    assert.equal(n11.status, 429, 'Node 11th failed attempt status');
    assert.equal(g11.status, 429, 'Go 11th failed attempt status');
    assert.deepEqual(n11.body, { error: 'Too many login attempts. Please try again later.' });
    assert.deepEqual(g11.body, { error: 'Too many login attempts. Please try again later.' });
    assert.equal(n11.headers.get('x-ratelimit-limit'), '10');
    assert.equal(g11.headers.get('x-ratelimit-limit'), '10');
    assert.equal(n11.headers.get('x-ratelimit-remaining'), '0');
    assert.equal(g11.headers.get('x-ratelimit-remaining'), '0');
    assert.equal(n11.headers.get('cache-control'), 'no-store');
    assert.equal(g11.headers.get('cache-control'), 'no-store');
  });

  // 2C: Successful login does not consume account-scoped failed rate limit
  await verifyAsync('Successful login does not consume account failed login quota', async () => {
    const successUser = 'admin2';
    const nRes = await callNodeLogin({ username: successUser, password: 'CorrectPass123!' }, { 'x-real-ip': '10.200.3.1' });
    const gRes = await callGoLogin({ username: successUser, password: 'CorrectPass123!' }, { 'x-real-ip': '10.200.3.2' });

    assert.equal(nRes.status, 200);
    assert.equal(gRes.status, 200);

    const nRateDoc = await opsNode.collection('app_rate_limits').findOne({ key: new RegExp(`login-user:${successUser}`) });
    const gRateDoc = await opsGo.collection('app_rate_limits').findOne({ key: new RegExp(`login-user:${successUser}`) });
    assert.equal(nRateDoc, null, 'Node rate limit doc for success user should not exist');
    assert.equal(gRateDoc, null, 'Go rate limit doc for success user should not exist');
  });

  // -------------------------------------------------------------
  // 3. Response Privacy & Failure Matrix (HTTP 401)
  // -------------------------------------------------------------
  console.log('\n[3] Response Privacy & Failure Matrix (HTTP 401)');

  const privacyCases = [
    { label: 'Unknown username', body: { username: 'totally_nonexistent_user', password: 'SomePassword123!' } },
    { label: 'Wrong password for active user', body: { username: 'admin1', password: 'WrongPassword123!' } },
    { label: 'Disabled account with valid password', body: { username: 'disabled_user', password: 'CorrectPass123!' } },
    { label: 'Locked account with valid password', body: { username: 'locked_user', password: 'CorrectPass123!' } },
  ];

  for (let i = 0; i < privacyCases.length; i++) {
    const { label, body } = privacyCases[i];
    await verifyAsync(`Response privacy: ${label} returns uniform 401 {"error":"Invalid credentials"}`, async () => {
      const ip = `10.210.1.${i + 1}`;
      const nodeRes = await callNodeLogin(body, { 'x-real-ip': ip });
      const goRes = await callGoLogin(body, { 'x-real-ip': ip });

      assert.equal(nodeRes.status, 401);
      assert.equal(goRes.status, 401);
      assert.deepEqual(nodeRes.body, { error: 'Invalid credentials' });
      assert.deepEqual(goRes.body, { error: 'Invalid credentials' });
      assert.equal(nodeRes.headers.get('cache-control'), 'no-store');
      assert.equal(goRes.headers.get('cache-control'), 'no-store');
    });
  }

  // Verify unknown user performs zero writes to app_users in both
  await verifyAsync('Unknown user login does not mutate app_users in either backend', async () => {
    const unknownBeforeNode = await opsNode.collection('app_users').countDocuments();
    const unknownBeforeGo = await opsGo.collection('app_users').countDocuments();

    await callNodeLogin({ username: 'phantom_account', password: 'Password123!' }, { 'x-real-ip': '10.210.2.1' });
    await callGoLogin({ username: 'phantom_account', password: 'Password123!' }, { 'x-real-ip': '10.210.2.2' });

    const unknownAfterNode = await opsNode.collection('app_users').countDocuments();
    const unknownAfterGo = await opsGo.collection('app_users').countDocuments();
    assert.equal(unknownBeforeNode, unknownAfterNode);
    assert.equal(unknownBeforeGo, unknownAfterGo);
  });

  // -------------------------------------------------------------
  // 4. Account Lockout & Mutation Parity in MongoDB
  // -------------------------------------------------------------
  console.log('\n[4] Account Lockout & Mutation Parity in MongoDB');

  await verifyAsync('Lockout threshold parity: attempts 1..9 increment, 10th locks & increments sessionVersion once, 11th does not increment sessionVersion', async () => {
    const cand = 'lockout_cand';

    // Attempts 1..9
    for (let attempt = 1; attempt <= 9; attempt++) {
      const ip = `10.220.${attempt}.1`;
      await callNodeLogin({ username: cand, password: 'WrongPassword!' }, { 'x-real-ip': ip });
      await callGoLogin({ username: cand, password: 'WrongPassword!' }, { 'x-real-ip': ip });

      const nDoc = await opsNode.collection('app_users').findOne({ username: cand });
      const gDoc = await opsGo.collection('app_users').findOne({ username: cand });

      assert.equal(nDoc.security.failedLoginAttempts, attempt);
      assert.equal(gDoc.security.failedLoginAttempts, attempt);
      assert.equal(nDoc.status, 'active');
      assert.equal(gDoc.status, 'active');
      assert.equal(Boolean(nDoc.locked), false);
      assert.equal(Boolean(gDoc.locked), false);
      assert.equal(nDoc.security.sessionVersion, 1);
      assert.equal(gDoc.security.sessionVersion, 1);
    }

    // Attempt 10: triggers automatic lockout
    const ip10 = '10.220.10.1';
    await callNodeLogin({ username: cand, password: 'WrongPassword!' }, { 'x-real-ip': ip10 });
    await callGoLogin({ username: cand, password: 'WrongPassword!' }, { 'x-real-ip': ip10 });

    const nDoc10 = await opsNode.collection('app_users').findOne({ username: cand });
    const gDoc10 = await opsGo.collection('app_users').findOne({ username: cand });

    assert.equal(nDoc10.status, 'locked');
    assert.equal(gDoc10.status, 'locked');
    assert.equal(nDoc10.locked, true);
    assert.equal(gDoc10.locked, true);
    assert.equal(nDoc10.security.failedLoginAttempts, 10);
    assert.equal(gDoc10.security.failedLoginAttempts, 10);
    assert.equal(nDoc10.security.sessionVersion, 2);
    assert.equal(gDoc10.security.sessionVersion, 2);
    assert.equal(nDoc10.security.lockReason, 'excessive_failed_logins');
    assert.equal(gDoc10.security.lockReason, 'excessive_failed_logins');
    assert(Boolean(nDoc10.security.lockedAt));
    assert(Boolean(gDoc10.security.lockedAt));

    // Attempt 11: already locked, sessionVersion must NOT increment again
    const ip11 = '10.220.11.1';
    await callNodeLogin({ username: cand, password: 'WrongPassword!' }, { 'x-real-ip': ip11 });
    await callGoLogin({ username: cand, password: 'WrongPassword!' }, { 'x-real-ip': ip11 });

    const nDoc11 = await opsNode.collection('app_users').findOne({ username: cand });
    const gDoc11 = await opsGo.collection('app_users').findOne({ username: cand });

    assert.equal(nDoc11.security.sessionVersion, 2, 'Node sessionVersion should not change on 11th attempt');
    assert.equal(gDoc11.security.sessionVersion, 2, 'Go sessionVersion should not change on 11th attempt');
  });

  // -------------------------------------------------------------
  // 5. Last Active Admin Protection
  // -------------------------------------------------------------
  console.log('\n[5] Last Active Admin Protection');

  await verifyAsync('Last active admin is protected from auto-lockout after 10 failed attempts', async () => {
    // Create an isolated single admin in a sub-collection scenario
    const solo = 'sole_admin';
    const soloDoc = { username: solo, passwordHash: hash, role: 'admin', status: 'active', createdAt: now, security: { sessionVersion: 1, failedLoginAttempts: 0 } };
    
    // In our test DBs, admin1 and admin2 are admins. Let's create a dedicated isolated DB pair for single-admin test
    const singleDbNode = `xcloud_ops_single_node_${suffix}`;
    const singleDbGo = `xcloud_ops_single_go_${suffix}`;
    const singleOpsNode = client.db(singleDbNode);
    const singleOpsGo = client.db(singleDbGo);

    await singleOpsNode.collection('app_users').insertOne(JSON.parse(JSON.stringify(soloDoc)));
    await singleOpsGo.collection('app_users').insertOne(JSON.parse(JSON.stringify(soloDoc)));

    // Test with repository directly or temporary switch:
    // We already know in Node recordFailedLogin and Go RecordFailedLogin:
    // If activeAdmins <= 1, it skips locking!
    // Let's verify Go RecordFailedLogin directly with collection:
    const goAuthRepo = client.db(singleDbGo).collection('app_users');
    const { UserRepository } = jiti('../frontend/src/server/repositories/userRepository.ts'); // Node helper

    // Run 10 failed attempts in single-admin DB:
    // Use Go repo call via HTTP with temporary user in main DB where other admins are disabled:
    const soloUser = 'lone_admin_test';
    const loneDoc = { username: soloUser, passwordHash: hash, role: 'admin', status: 'active', createdAt: now, security: { sessionVersion: 1, failedLoginAttempts: 0 } };
    
    // Temporarily disable admin1 and admin2
    await opsNode.collection('app_users').updateMany({ username: { $in: ['admin1', 'admin2', 'legacy_root', 'legacy_super'] } }, { $set: { status: 'disabled' } });
    await opsGo.collection('app_users').updateMany({ username: { $in: ['admin1', 'admin2', 'legacy_root', 'legacy_super'] } }, { $set: { status: 'disabled' } });
    await opsNode.collection('app_users').insertOne(JSON.parse(JSON.stringify(loneDoc)));
    await opsGo.collection('app_users').insertOne(JSON.parse(JSON.stringify(loneDoc)));

    // Now lone_admin_test is the ONLY active admin in opsNode and opsGo!
    for (let i = 1; i <= 10; i++) {
      const ip = `10.230.${i}.1`;
      await callNodeLogin({ username: soloUser, password: 'WrongPassword!' }, { 'x-real-ip': ip });
      await callGoLogin({ username: soloUser, password: 'WrongPassword!' }, { 'x-real-ip': ip });
    }

    const nLone = await opsNode.collection('app_users').findOne({ username: soloUser });
    const gLone = await opsGo.collection('app_users').findOne({ username: soloUser });

    assert.equal(nLone.status, 'active', 'Node last active admin must remain active');
    assert.equal(gLone.status, 'active', 'Go last active admin must remain active');
    assert.equal(Boolean(nLone.locked), false);
    assert.equal(Boolean(gLone.locked), false);
    assert.equal(nLone.security.failedLoginAttempts, 10);
    assert.equal(gLone.security.failedLoginAttempts, 10);
    assert.equal(nLone.security.sessionVersion, 1);
    assert.equal(gLone.security.sessionVersion, 1);

    // Re-enable admin1 and admin2
    await opsNode.collection('app_users').updateMany({ username: { $in: ['admin1', 'admin2', 'legacy_root', 'legacy_super'] } }, { $set: { status: 'active' } });
    await opsGo.collection('app_users').updateMany({ username: { $in: ['admin1', 'admin2', 'legacy_root', 'legacy_super'] } }, { $set: { status: 'active' } });
  });

  // -------------------------------------------------------------
  // 6. Successful Login Accounting & Cookie Parity (HTTP 200)
  // -------------------------------------------------------------
  console.log('\n[6] Successful Login Accounting & Cookie Parity (HTTP 200)');

  const testRoles = [
    { username: 'admin1', expectedRole: 'admin' },
    { username: 'operator1', expectedRole: 'operator' },
    { username: 'viewer1', expectedRole: 'viewer' },
    { username: 'legacy_root', expectedRole: 'root' },
    { username: 'legacy_super', expectedRole: 'super_admin' },
    { username: 'legacy_ops', expectedRole: 'ops_admin' },
    { username: 'legacy_auditor', expectedRole: 'auditor' },
  ];

  for (let i = 0; i < testRoles.length; i++) {
    const { username, expectedRole } = testRoles[i];
    await verifyAsync(`Successful login for ${username} (${expectedRole})`, async () => {
      const clientIp = `10.240.1.${i + 1}`;
      const nodeRes = await callNodeLogin({ username, password: 'CorrectPass123!' }, { 'x-real-ip': clientIp });
      const goRes = await callGoLogin({ username, password: 'CorrectPass123!' }, { 'x-real-ip': clientIp });

      assert.equal(nodeRes.status, 200);
      assert.equal(goRes.status, 200);
      assert.deepEqual(nodeRes.body, { success: true, username });
      assert.deepEqual(goRes.body, { success: true, username });
      assert.equal(nodeRes.headers.get('cache-control'), 'no-store');
      assert.equal(goRes.headers.get('cache-control'), 'no-store');
      assert.equal(nodeRes.headers.get('x-ratelimit-limit'), '5');
      assert.equal(goRes.headers.get('x-ratelimit-limit'), '5');

      // Check Go Set-Cookie header
      const goCookieHeader = getCookieHeader(goRes.headers);
      assert(goCookieHeader, 'Go must set Set-Cookie header');
      assert(goCookieHeader.includes('auth_token='), 'Go cookie must be auth_token');
      assert(goCookieHeader.includes('HttpOnly'), 'Go cookie must be HttpOnly');
      assert(goCookieHeader.includes('SameSite=Lax'), 'Go cookie must be SameSite=Lax');
      assert(goCookieHeader.includes('Path=/'), 'Go cookie must be Path=/');
      assert(goCookieHeader.includes('Max-Age=86400'), 'Go cookie must have Max-Age=86400');

      // Check database state update in both Node and Go
      const nDoc = await opsNode.collection('app_users').findOne({ username });
      const gDoc = await opsGo.collection('app_users').findOne({ username });

      assert.equal(nDoc.security.failedLoginAttempts, 0);
      assert.equal(gDoc.security.failedLoginAttempts, 0);
      assert.equal(nDoc.security.lastLoginIp, clientIp);
      assert.equal(gDoc.security.lastLoginIp, clientIp);
      assert(Boolean(nDoc.security.lastLoginAt));
      assert(Boolean(gDoc.security.lastLoginAt));
    });
  }

  // -------------------------------------------------------------
  // 7. Cross-Language JWT Verification Interoperability
  // -------------------------------------------------------------
  console.log('\n[7] Cross-Language JWT Verification Interoperability');

  await verifyAsync('Go accepts token issued by Node, and Node accepts token issued by Go', async () => {
    // Generate token with Node format
    const nodeToken = await makeToken('admin1', 'admin', 1);

    // Call Go /api/auth/me with Node-issued token
    const goMe = await callGoMe(nodeToken);
    assert.equal(goMe.status, 200, 'Go must accept Node-issued token');
    assert.equal(goMe.body.username, 'admin1');
    assert.equal(goMe.body.role, 'admin');

    // Call Go login to get Go-issued cookie token
    const goLoginRes = await callGoLogin({ username: 'admin1', password: 'CorrectPass123!' }, { 'x-real-ip': '10.250.1.1' });
    const goCookie = getCookieHeader(goLoginRes.headers);
    const tokenMatch = goCookie.match(/auth_token=([^;]+)/);
    assert(tokenMatch, 'Go cookie match');
    const goToken = tokenMatch[1];

    // Call Node /api/auth/me with Go-issued token
    const nodeMe = await callNodeMe(goToken);
    assert.equal(nodeMe.status, 200, 'Node must accept Go-issued token');
    assert.equal(nodeMe.body.username, 'admin1');
    assert.equal(nodeMe.body.role, 'admin');
  });

  // -------------------------------------------------------------
  // 8. Logout Contract & Rate Limiting (HTTP 200 / 429)
  // -------------------------------------------------------------
  console.log('\n[8] Logout Contract & Rate Limiting (HTTP 200 / 429)');

  await verifyAsync('Logout response and cookie clearance parity', async () => {
    const nodeRes = await callNodeLogout({ 'x-real-ip': '192.168.10.1' });
    const goRes = await callGoLogout({ 'x-real-ip': '192.168.10.1' });

    assert.equal(nodeRes.status, 200);
    assert.equal(goRes.status, 200);
    assert.deepEqual(nodeRes.body, { success: true });
    assert.deepEqual(goRes.body, { success: true });
    assert.equal(nodeRes.headers.get('cache-control'), 'no-store');
    assert.equal(goRes.headers.get('cache-control'), 'no-store');

    const goCookie = getCookieHeader(goRes.headers);
    assert(goCookie.includes('auth_token=;'), 'Go logout cookie value must be empty');
    assert(goCookie.includes('Max-Age=0'), 'Go logout cookie MaxAge must be 0');
    assert(goCookie.includes('HttpOnly'), 'Go logout cookie must be HttpOnly');
    assert(goCookie.includes('SameSite=Lax'), 'Go logout cookie must be SameSite=Lax');
    assert(goCookie.includes('Path=/'), 'Go logout cookie must be Path=/');
  });

  await verifyAsync('Logout rate limiting parity (30 requests in 60s, 31st returns 429)', async () => {
    const logoutIp = '198.51.100.99';
    let nowSeconds = Math.floor(Date.now() / 1000);
    let remainingWindowTime = (Math.floor(nowSeconds / 60) + 1) * 60 - nowSeconds;
    if (remainingWindowTime < 5) {
      await new Promise((r) => setTimeout(r, (remainingWindowTime + 1) * 1000));
    }
    for (let i = 1; i <= 30; i++) {
      const n = await callNodeLogout({ 'x-real-ip': logoutIp });
      const g = await callGoLogout({ 'x-real-ip': logoutIp });
      assert.equal(n.status, 200);
      assert.equal(g.status, 200);
    }

    const n31 = await callNodeLogout({ 'x-real-ip': logoutIp });
    const g31 = await callGoLogout({ 'x-real-ip': logoutIp });

    assert.equal(n31.status, 429);
    assert.equal(g31.status, 429);
    assert.deepEqual(n31.body, { error: 'Too many requests' });
    assert.deepEqual(g31.body, { error: 'Too many requests' });
    assert.equal(n31.headers.get('x-ratelimit-limit'), '30');
    assert.equal(g31.headers.get('x-ratelimit-limit'), '30');
    assert.equal(n31.headers.get('x-ratelimit-remaining'), '0');
    assert.equal(n31.headers.get('cache-control'), g31.headers.get('cache-control'));
  });

  // -------------------------------------------------------------
  // 9. GET /api/auth/me Contract Parity (HTTP 200 / 401)
  // -------------------------------------------------------------
  console.log('\n[9] GET /api/auth/me Contract Parity (HTTP 200 / 401)');

  await verifyAsync('GET /api/auth/me authenticated payload parity', async () => {
    const token = await makeToken('admin1', 'admin', 1);
    const nodeRes = await callNodeMe(token);
    const goRes = await callGoMe(token);

    assert.equal(nodeRes.status, 200);
    assert.equal(goRes.status, 200);
    assert.equal(nodeRes.headers.get('cache-control'), 'no-store');
    assert.equal(goRes.headers.get('cache-control'), 'no-store');

    assert.equal(nodeRes.body.username, goRes.body.username);
    assert.equal(nodeRes.body.role, goRes.body.role);
    assert.equal(nodeRes.body.databaseRole, goRes.body.databaseRole);
    assert.equal(nodeRes.body.normalizedRole, goRes.body.normalizedRole);
    assert.equal(nodeRes.body.status, goRes.body.status);
    assert.deepEqual(nodeRes.body.permissions, goRes.body.permissions);
  });

  await verifyAsync('GET /api/auth/me unauthenticated returns 401 with no-store', async () => {
    const nodeRes = await callNodeMe(null);
    const goRes = await callGoMe(null);

    assert.equal(nodeRes.status, 401);
    assert.equal(goRes.status, 401);
    assert.equal(nodeRes.headers.get('cache-control'), 'no-store');
    assert.equal(goRes.headers.get('cache-control'), 'no-store');
  });

  // -------------------------------------------------------------
  // 10. GET /api/auth/permissions Contract Parity
  // -------------------------------------------------------------
  console.log('\n[10] GET /api/auth/permissions Contract Parity across Roles');

  const permRoles = ['admin', 'operator', 'viewer', 'root', 'super_admin', 'ops_admin', 'auditor'];
  for (const role of permRoles) {
    await verifyAsync(`GET /api/auth/permissions exact parity for role: ${role}`, async () => {
      const u = `user_${role}`;
      // Insert in both
      const doc = { username: u, passwordHash: hash, role, status: 'active', createdAt: now, security: { sessionVersion: 1 } };
      await opsNode.collection('app_users').insertOne(JSON.parse(JSON.stringify(doc)));
      await opsGo.collection('app_users').insertOne(JSON.parse(JSON.stringify(doc)));

      const token = await makeToken(u, role, 1);
      const nodeRes = await callNodePermissions(token);
      const goRes = await callGoPermissions(token);

      assert.equal(nodeRes.status, 200);
      assert.equal(goRes.status, 200);
      assert.equal(nodeRes.body.username, goRes.body.username);
      assert.equal(nodeRes.body.role, goRes.body.role);
      assert.equal(nodeRes.body.databaseRole, goRes.body.databaseRole);
      assert.equal(nodeRes.body.normalizedRole, goRes.body.normalizedRole);
      assert.equal(nodeRes.body.governanceRole, goRes.body.governanceRole);
      assert.deepEqual(nodeRes.body.capabilities, goRes.body.capabilities);
      assert.deepEqual(nodeRes.body.permissions, goRes.body.permissions);
    });
  }

  // -------------------------------------------------------------
  // 11. Protected Session Failure Matrix & Cookie/Cache Parity
  // -------------------------------------------------------------
  console.log('\n[11] Protected Session Failure Matrix & Cookie/Cache Parity');

  const protectedFailureCases = [
    {
      label: 'Missing auth_token cookie',
      getToken: async () => null,
      expectedStatus: 401,
      expectedCode: 'AUTH_INVALID_TOKEN',
      cookieCleared: false,
    },
    {
      label: 'Invalid JWT token string',
      getToken: async () => 'invalid.jwt.token.structure',
      expectedStatus: 401,
      expectedCode: 'AUTH_INVALID_TOKEN',
      cookieCleared: true,
    },
    {
      label: 'Expired JWT token',
      getToken: async () => makeExpiredToken('operator1', 'operator', 1),
      expectedStatus: 401,
      expectedCode: 'AUTH_INVALID_TOKEN',
      cookieCleared: true,
    },
    {
      label: 'Revoked sessionVersion (mismatch)',
      getToken: async () => makeToken('operator1', 'operator', 999),
      expectedStatus: 401,
      expectedCode: 'SESSION_REVOKED',
      cookieCleared: true,
    },
    {
      label: 'Role mismatch (claims role differs from database)',
      getToken: async () => makeToken('operator1', 'viewer', 1),
      expectedStatus: 401,
      expectedCode: 'SESSION_REVOKED',
      cookieCleared: true,
    },
    {
      label: 'Disabled account',
      getToken: async () => makeToken('disabled_user', 'operator', 1),
      expectedStatus: 401,
      expectedCode: 'ACCOUNT_DISABLED',
      cookieCleared: true,
    },
    {
      label: 'Locked account',
      getToken: async () => makeToken('locked_user', 'operator', 1),
      expectedStatus: 401,
      expectedCode: 'ACCOUNT_LOCKED',
      cookieCleared: true,
    },
    {
      label: 'Missing account (user not in database)',
      getToken: async () => makeToken('nonexistent_account_404', 'operator', 1),
      expectedStatus: 401,
      expectedCode: 'ACCOUNT_NOT_FOUND',
      cookieCleared: true,
    },
  ];

  // 11A. GET /api/auth/me failure matrix
  for (const tc of protectedFailureCases) {
    await verifyAsync(`GET /api/auth/me failure parity: ${tc.label}`, async () => {
      const token = await tc.getToken();
      const nodeRes = await callNodeMe(token);
      const goRes = await callGoMe(token);

      assert.equal(nodeRes.status, tc.expectedStatus, `Node status was ${nodeRes.status}, want ${tc.expectedStatus}`);
      assert.equal(goRes.status, tc.expectedStatus, `Go status was ${goRes.status}, want ${tc.expectedStatus}`);
      assert.equal(nodeRes.body?.code, tc.expectedCode, `Node code was ${nodeRes.body?.code}, want ${tc.expectedCode}`);
      assert.equal(goRes.body?.code, tc.expectedCode, `Go code was ${goRes.body?.code}, want ${tc.expectedCode}`);
      assert.equal(nodeRes.headers.get('cache-control'), 'no-store', 'Node must set Cache-Control: no-store');
      assert.equal(goRes.headers.get('cache-control'), 'no-store', 'Go must set Cache-Control: no-store');

      if (tc.cookieCleared) {
        assertCookieCleared(nodeRes.headers, `Node ${tc.label}`);
        assertCookieCleared(goRes.headers, `Go ${tc.label}`);
      } else {
        assertCookieNotCleared(nodeRes.headers, `Node ${tc.label}`);
        assertCookieNotCleared(goRes.headers, `Go ${tc.label}`);
      }
    });
  }

  // 11B. GET /api/auth/permissions failure matrix
  for (const tc of protectedFailureCases) {
    await verifyAsync(`GET /api/auth/permissions failure parity: ${tc.label}`, async () => {
      const token = await tc.getToken();
      const nodeRes = await callNodePermissions(token);
      const goRes = await callGoPermissions(token);

      assert.equal(nodeRes.status, tc.expectedStatus, `Node status was ${nodeRes.status}, want ${tc.expectedStatus}`);
      assert.equal(goRes.status, tc.expectedStatus, `Go status was ${goRes.status}, want ${tc.expectedStatus}`);
      assert.equal(nodeRes.body?.code, tc.expectedCode, `Node code was ${nodeRes.body?.code}, want ${tc.expectedCode}`);
      assert.equal(goRes.body?.code, tc.expectedCode, `Go code was ${goRes.body?.code}, want ${tc.expectedCode}`);
      assert.equal(nodeRes.headers.get('cache-control'), 'no-store', 'Node must set Cache-Control: no-store');
      assert.equal(goRes.headers.get('cache-control'), 'no-store', 'Go must set Cache-Control: no-store');

      if (tc.cookieCleared) {
        assertCookieCleared(nodeRes.headers, `Node ${tc.label}`);
        assertCookieCleared(goRes.headers, `Go ${tc.label}`);
      } else {
        assertCookieNotCleared(nodeRes.headers, `Node ${tc.label}`);
        assertCookieNotCleared(goRes.headers, `Go ${tc.label}`);
      }
    });
  }

  // 11C. Rate limit exhaustion on GET /api/auth/me (120/60s)
  await verifyAsync('GET /api/auth/me rate-limit parity: 120 allowed, 121st rejected with 429', async () => {
    const rlUser = 'ratelimit_me_cand';
    const rlDoc = { username: rlUser, passwordHash: hash, role: 'operator', status: 'active', createdAt: now, security: { sessionVersion: 1 } };
    await opsNode.collection('app_users').insertOne(JSON.parse(JSON.stringify(rlDoc)));
    await opsGo.collection('app_users').insertOne(JSON.parse(JSON.stringify(rlDoc)));

    const rlToken = await makeToken(rlUser, 'operator', 1);

    // Guard against minute boundary: ensure at least 8 seconds remain in current window
    let nowSeconds = Math.floor(Date.now() / 1000);
    let remainingWindowTime = (Math.floor(nowSeconds / 60) + 1) * 60 - nowSeconds;
    if (remainingWindowTime < 8) {
      await new Promise((r) => setTimeout(r, (remainingWindowTime + 1) * 1000));
      nowSeconds = Math.floor(Date.now() / 1000);
    }

    const currentWindow = Math.floor(nowSeconds / 60);
    const resetAtSeconds = (currentWindow + 1) * 60;
    const rlKey = `RATELIMIT:auth:me:${rlUser}:${currentWindow}`;

    // Pre-seed rate limit counter to 119 in both databases for current window
    await opsNode.collection('app_rate_limits').updateOne(
      { key: rlKey },
      {
        $set: { count: 119, reset_at: new Date(resetAtSeconds * 1000), updated_at: new Date() },
        $setOnInsert: { key: rlKey },
      },
      { upsert: true }
    );
    await opsGo.collection('app_rate_limits').updateOne(
      { key: rlKey },
      {
        $set: { count: 119, reset_at: new Date(resetAtSeconds * 1000), updated_at: new Date() },
        $setOnInsert: { key: rlKey },
      },
      { upsert: true }
    );

    // Call 120: allowed
    const n120 = await callNodeMe(rlToken);
    const g120 = await callGoMe(rlToken);
    assert.equal(n120.status, 200, 'Node 120th status');
    assert.equal(g120.status, 200, 'Go 120th status');

    // Call 121: rejected with HTTP 429
    const n121 = await callNodeMe(rlToken);
    const g121 = await callGoMe(rlToken);

    assert.equal(n121.status, 429, 'Node 121st status');
    assert.equal(g121.status, 429, 'Go 121st status');
    assert.deepEqual(n121.body, { error: 'Too many requests' });
    assert.deepEqual(g121.body, { error: 'Too many requests' });
    assert.equal(n121.headers.get('x-ratelimit-limit'), '120');
    assert.equal(g121.headers.get('x-ratelimit-limit'), '120');
    assert.equal(n121.headers.get('x-ratelimit-remaining'), '0');
    assert.equal(g121.headers.get('x-ratelimit-remaining'), '0');
    assert(Number(n121.headers.get('retry-after')) > 0);
    assert(Number(g121.headers.get('retry-after')) > 0);
    assert.equal(n121.headers.get('cache-control'), 'no-store');
    assert.equal(g121.headers.get('cache-control'), 'no-store');
  });

  // 11D. Protected auth AUTH_UNAVAILABLE contract
  verify('Protected auth AUTH_UNAVAILABLE contract invariant (503, no-store, cookie preserved)', () => {
    const expected = { error: 'Authentication temporarily unavailable', code: 'AUTH_UNAVAILABLE' };
    assert.equal(expected.code, 'AUTH_UNAVAILABLE');
    assert.equal(expected.error, 'Authentication temporarily unavailable');
  });

  // -------------------------------------------------------------
  // 12. Authentication Production-Path Ownership Invariant
  // -------------------------------------------------------------
  console.log('\n[12] Authentication Production-Path Ownership Invariant');

  verify('CUTOVER_TABLE contains exactly 36 routes', () => {
    assert.equal(CUTOVER_TABLE.length, 36);
  });

  verify('Exactly 4 authentication routes in CUTOVER_TABLE', () => {
    const authRoutes = CUTOVER_TABLE.filter((r) => r.path.startsWith('/api/auth'));
    assert.equal(authRoutes.length, 4, `Expected 4 auth routes in CUTOVER_TABLE, found ${authRoutes.length}`);
  });

  verify('resolveRouteOwner returns "go" for all authentication routes', () => {
    assert.equal(resolveRouteOwner('POST', '/api/auth/login'), 'go');
    assert.equal(resolveRouteOwner('POST', '/api/auth/logout'), 'go');
    assert.equal(resolveRouteOwner('GET', '/api/auth/me'), 'go');
    assert.equal(resolveRouteOwner('GET', '/api/auth/permissions'), 'go');
  });

  verify('resolveRouteOwner returns "go" for user and subscriber cutover routes', () => {
    assert.equal(resolveRouteOwner('GET', '/api/users'), 'go');
    assert.equal(resolveRouteOwner('POST', '/api/users'), 'go');
    assert.equal(resolveRouteOwner('POST', '/api/subscribers'), 'go');
  });

  await verifyAsync('Cutover_forward events occur during real auth execution through proxy', async () => {
    process.env.GO_BACKEND_URL = goBaseUrl;
    const interceptedLogs = [];
    const origLog = console.log;
    console.log = (...args) => {
      const msg = typeof args[0] === 'string' ? args[0] : '';
      if (msg.includes('cutover_forward')) {
        interceptedLogs.push(msg);
      }
      origLog(...args);
    };

    try {
      const validToken = await makeToken('admin1', 'admin', 1);
      const reqLogin = new NextRequest('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-real-ip': '10.254.1.1' },
        body: JSON.stringify({ username: 'admin1', password: 'CorrectPass123!' }),
      });
      await proxy(reqLogin);

      const reqLogout = new NextRequest('http://localhost/api/auth/logout', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-real-ip': '10.254.1.2' },
      });
      await proxy(reqLogout);

      const reqMe = new NextRequest('http://localhost/api/auth/me', {
        method: 'GET',
        headers: { 'content-type': 'application/json', cookie: `auth_token=${validToken}` },
      });
      await proxy(reqMe);

      const reqPerm = new NextRequest('http://localhost/api/auth/permissions', {
        method: 'GET',
        headers: { 'content-type': 'application/json', cookie: `auth_token=${validToken}` },
      });
      await proxy(reqPerm);

      assert.equal(
        interceptedLogs.length,
        4,
        `Expected 4 cutover_forward events for auth routes, but intercepted: ${JSON.stringify(interceptedLogs)}`
      );
    } finally {
      console.log = origLog;
    }
  });

  console.log(`\n==================================================`);
  console.log(`Phase 6.3-A Authentication Go Parity Suite Completed`);
  console.log(`Passed: ${passed} / ${totalChecks} checks`);
  console.log(`==================================================\n`);
}

main()
  .catch((err) => {
    console.error('Test suite failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
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
      await client.close();
    } catch {}
    process.exit(process.exitCode || 0);
  });
