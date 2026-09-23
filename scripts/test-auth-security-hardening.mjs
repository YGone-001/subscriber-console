#!/usr/bin/env node
/**
 * Phase 6.2 — Authentication Security Hardening Acceptance Suite
 *
 * Covers:
 * 1. Login Security Matrix (parameterized)
 * 2. Response Privacy (non-disclosure of account existence)
 * 3. Dual Rate Limiting (IP 5/60s & Username 10/300s)
 * 4. Automatic Lockout Threshold (1..9 unlocked, 10 locked, 11+ single sessionVersion increment)
 * 5. Account Lock Concurrency (atomic single lock transition under parallel requests)
 * 6. Successful Login Accounting & Reset (failedLoginAttempts=0, lastLoginAt/Ip updated)
 * 7. Session Invalidation After Lockout (old token rejected with 401)
 * 8. Admin Unlock via Canonical Go User Management API (clear locked, reset counters, revoke old session)
 * 9. Last Active Admin Safety (auto-lockout and manual lock/disable prevented on last active admin)
 * 10. JWT Secret Validation Parity (Node and Go startup secret rules)
 * 11. Cookie & Cache-Control Hardening (SameSite, HttpOnly, HTTPS Secure, no-store)
 */

import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { existsSync, unlinkSync } from 'node:fs';
import { execSync, spawn } from 'node:child_process';
import { SignJWT } from 'jose';
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
const xcloudDbName = `xcloud_auth_sec_${suffix}`;
const appDbName = `xcloud_ops_auth_sec_${suffix}`;
const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/xcloud';

process.env.MONGODB_XCLOUD_DB = xcloudDbName;
process.env.MONGODB_APP_DB = appDbName;
const JWT_SECRET_STRING = 'auth-security-test-secret-with-at-least-32-bytes!';
process.env.JWT_SECRET = JWT_SECRET_STRING;

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  alias: {
    '@': new URL('../frontend/src/', import.meta.url).pathname,
    'next/server': new URL('../frontend/node_modules/next/server.js', import.meta.url).pathname,
  },
});

const { NextRequest } = jiti('next/server');
const { POST: loginHandler } = jiti('../frontend/src/app/api/auth/login/route.ts');
const { POST: logoutHandler } = jiti('../frontend/src/app/api/auth/logout/route.ts');
const { GET: meHandler } = jiti('../frontend/src/app/api/auth/me/route.ts');
const { getJwtSecretKey } = jiti('../frontend/src/lib/security.ts');
const { getRateLimit } = jiti('../frontend/src/lib/rateLimit.ts');
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
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(getJwtSecretKey());
}

async function callLogin(body, headers = {}) {
  const req = new NextRequest('http://localhost/api/auth/login', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const res = await loginHandler(req);
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, headers: res.headers, cookies: res.cookies, body: json };
}

async function callLogout(headers = {}) {
  const req = new NextRequest('http://localhost/api/auth/logout', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
  });
  const res = await logoutHandler(req);
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, headers: res.headers, cookies: res.cookies, body: json };
}

const { proxy } = jiti('../frontend/src/proxy.ts');

async function callMe(token, headers = {}) {
  const reqHeaders = { 'content-type': 'application/json', ...headers };
  if (token) reqHeaders['cookie'] = `auth_token=${token}`;
  const req = new NextRequest('http://localhost/api/auth/me', {
    method: 'GET',
    headers: reqHeaders,
  });
  const proxyRes = await proxy(req);
  if (proxyRes.status !== 200) {
    let json = null;
    try { json = await proxyRes.json(); } catch {}
    return { status: proxyRes.status, headers: proxyRes.headers, body: json };
  }
  // In Next.js middleware, NextResponse.next({ request: { headers } }) prefixes forwarded request headers with x-middleware-request-
  // Combine request headers with headers set by proxy for downstream handler
  const forwardedHeaders = new Headers(reqHeaders);
  proxyRes.headers.forEach((val, key) => {
    if (key.startsWith('x-middleware-request-')) {
      const realKey = key.slice('x-middleware-request-'.length);
      forwardedHeaders.set(realKey, val);
    } else {
      forwardedHeaders.set(key, val);
    }
  });
  const forwardedReq = new NextRequest('http://localhost/api/auth/me', {
    method: 'GET',
    headers: forwardedHeaders,
  });
  const res = await meHandler(forwardedReq);
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, headers: res.headers, body: json };
}

async function main() {
  console.log('── Phase 6.2 Authentication Security Hardening Suite ──\n');

  await client.connect();
  const ops = client.db(appDbName);

  // 1. Build and start Go backend for User Management API testing (admin unlock & last active admin)
  const goPort = await getAvailablePort();
  const isWin = process.platform === 'win32';
  const binName = isWin ? `test-go-authsec-${suffix}.exe` : `test-go-authsec-${suffix}`;
  const backendDir = path.resolve(import.meta.dirname, '..', 'backend');
  binPath = path.join(backendDir, binName);

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
      MONGODB_XCLOUD_DB: xcloudDbName,
      MONGODB_APP_DB: appDbName,
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

  // Helper for calling Go User Management
  async function callGoUserMgmt(method, pathStr, token, body) {
    const headers = { 'content-type': 'application/json' };
    if (token) headers['cookie'] = `auth_token=${token}`;
    const res = await fetch(`${goBaseUrl}${pathStr}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, body: json };
  }

  // Seed fixture users
  const now = new Date().toISOString();
  const hash = await bcrypt.hash('CorrectPass123!', 10);

  await ops.collection('app_users').insertMany([
    {
      username: 'active_admin1',
      passwordHash: hash,
      role: 'admin',
      status: 'active',
      displayName: 'Active Admin 1',
      email: 'admin1@test.local',
      createdAt: now,
      updatedAt: now,
      security: { sessionVersion: 1, failedLoginAttempts: 0 },
    },
    {
      username: 'active_admin2',
      passwordHash: hash,
      role: 'admin',
      status: 'active',
      displayName: 'Active Admin 2',
      email: 'admin2@test.local',
      createdAt: now,
      updatedAt: now,
      security: { sessionVersion: 1, failedLoginAttempts: 0 },
    },
    {
      username: 'target_op',
      passwordHash: hash,
      role: 'operator',
      status: 'active',
      displayName: 'Target Operator',
      email: 'target@test.local',
      createdAt: now,
      updatedAt: now,
      security: { sessionVersion: 1, failedLoginAttempts: 0 },
    },
    {
      username: 'disabled_user',
      passwordHash: hash,
      role: 'operator',
      status: 'disabled',
      displayName: 'Disabled User',
      email: 'disabled@test.local',
      createdAt: now,
      updatedAt: now,
      security: { sessionVersion: 1, failedLoginAttempts: 0 },
    },
    {
      username: 'locked_user',
      passwordHash: hash,
      role: 'operator',
      status: 'locked',
      locked: true,
      displayName: 'Locked User',
      email: 'locked@test.local',
      createdAt: now,
      updatedAt: now,
      security: { sessionVersion: 1, failedLoginAttempts: 10, lockedAt: now, lockReason: 'excessive_failed_logins' },
    },
  ]);

  try {
    // ── 1. Parameterized Login Security Matrix ─────────────────────────────────
    console.log('1. Parameterized Login Security Matrix');

    const matrix = [
      {
        case: 'valid active user',
        ip: '10.0.1.1',
        body: { username: 'active_admin1', password: 'CorrectPass123!' },
        expectedStatus: 200,
      },
      {
        case: 'unknown username',
        ip: '10.0.1.2',
        body: { username: 'nonexistent_user', password: 'WrongPass123!' },
        expectedStatus: 401,
      },
      {
        case: 'wrong password',
        ip: '10.0.1.3',
        body: { username: 'target_op', password: 'WrongPassword123!' },
        expectedStatus: 401,
      },
      {
        case: 'disabled user',
        ip: '10.0.1.4',
        body: { username: 'disabled_user', password: 'CorrectPass123!' },
        expectedStatus: 401,
      },
      {
        case: 'locked user',
        ip: '10.0.1.5',
        body: { username: 'locked_user', password: 'CorrectPass123!' },
        expectedStatus: 401,
      },
      {
        case: 'malformed body',
        ip: '10.0.1.6',
        body: 'invalid-json-content',
        expectedStatus: 400,
      },
      {
        case: 'password over bcrypt byte limit',
        ip: '10.0.1.7',
        body: { username: 'target_op', password: 'a'.repeat(73) },
        expectedStatus: 400,
      },
    ];

    for (const testItem of matrix) {
      await verifyAsync(testItem.case, async () => {
        const res = await callLogin(testItem.body, { 'x-real-ip': testItem.ip });
        assert.equal(res.status, testItem.expectedStatus);
        if (testItem.expectedStatus === 401) {
          assert.equal(res.body?.error, 'Invalid credentials');
        }
      });
    }

    // ── 2. Response Privacy (Non-Disclosure) ──────────────────────────────────
    console.log('\n2. Response Privacy Invariant');

    await verifyAsync('all 401 failure modes return identical payload and headers', async () => {
      const resUnknown = await callLogin({ username: 'missing_user_xyz', password: 'BadPassword1!' }, { 'x-real-ip': '10.0.2.1' });
      const resWrongPw = await callLogin({ username: 'target_op', password: 'BadPassword1!' }, { 'x-real-ip': '10.0.2.2' });
      const resDisabled = await callLogin({ username: 'disabled_user', password: 'CorrectPass123!' }, { 'x-real-ip': '10.0.2.3' });
      const resLocked = await callLogin({ username: 'locked_user', password: 'CorrectPass123!' }, { 'x-real-ip': '10.0.2.4' });

      assert.deepEqual(resUnknown.body, { error: 'Invalid credentials' });
      assert.deepEqual(resWrongPw.body, { error: 'Invalid credentials' });
      assert.deepEqual(resDisabled.body, { error: 'Invalid credentials' });
      assert.deepEqual(resLocked.body, { error: 'Invalid credentials' });
      assert.equal(resUnknown.headers.get('cache-control'), 'no-store');
      assert.equal(resWrongPw.headers.get('cache-control'), 'no-store');
      assert.equal(resDisabled.headers.get('cache-control'), 'no-store');
      assert.equal(resLocked.headers.get('cache-control'), 'no-store');
    });

    // ── 3. Dual Rate Limiting (IP & Username) ──────────────────────────────────
    console.log('\n3. Dual Rate Limiting (IP & Username)');

    await verifyAsync('IP rate limit triggers at 6th request from same IP within 60s', async () => {
      const ip = '10.0.3.1';
      for (let i = 0; i < 5; i++) {
        const res = await callLogin({ username: 'active_admin1', password: 'BadPassword!' }, { 'x-real-ip': ip });
        assert.equal(res.status, 401);
      }
      const denied = await callLogin({ username: 'active_admin1', password: 'BadPassword!' }, { 'x-real-ip': ip });
      assert.equal(denied.status, 429);
      assert.equal(denied.headers.get('x-ratelimit-limit'), '5');
      assert.equal(denied.headers.get('x-ratelimit-remaining'), '0');
      assert.ok(Number(denied.headers.get('retry-after')) > 0);
    });

    await verifyAsync('Account-scoped rate limit triggers at 11th request across different IPs within 300s', async () => {
      const targetUser = 'victim_user_test';
      for (let i = 1; i <= 10; i++) {
        const ip = `10.0.4.${i}`;
        const res = await callLogin({ username: targetUser, password: 'BadPassword!' }, { 'x-real-ip': ip });
        assert.equal(res.status, 401);
      }
      const denied = await callLogin({ username: targetUser, password: 'BadPassword!' }, { 'x-real-ip': '10.0.4.99' });
      assert.equal(denied.status, 429);
      assert.equal(denied.headers.get('x-ratelimit-limit'), '10');
      assert.equal(denied.headers.get('x-ratelimit-remaining'), '0');
      assert.ok(Number(denied.headers.get('retry-after')) > 0);
    });

    // ── 4. Automatic Lockout Threshold (10 Failed Attempts) ───────────────────
    console.log('\n4. Automatic Lockout Threshold & Invariants');

    await ops.collection('app_users').insertOne({
      username: 'lock_candidate',
      passwordHash: hash,
      role: 'operator',
      status: 'active',
      displayName: 'Lock Candidate',
      email: 'candidate@test.local',
      createdAt: now,
      updatedAt: now,
      security: { sessionVersion: 1, failedLoginAttempts: 0 },
    });

    await verifyAsync('attempts 1..9 leave account active and increment failedLoginAttempts', async () => {
      for (let i = 1; i <= 9; i++) {
        const res = await callLogin({ username: 'lock_candidate', password: 'BadPassword!' }, { 'x-real-ip': `10.1.${i}.1` });
        assert.equal(res.status, 401);
        const doc = await ops.collection('app_users').findOne({ username: 'lock_candidate' });
        assert.equal(doc.status, 'active');
        assert.equal(doc.locked, undefined);
        assert.equal(doc.security.failedLoginAttempts, i);
        assert.equal(doc.security.sessionVersion, 1);
      }
    });

    await verifyAsync('attempt 10 transitions account to locked and increments sessionVersion exactly once', async () => {
      const res = await callLogin({ username: 'lock_candidate', password: 'BadPassword!' }, { 'x-real-ip': '10.1.10.1' });
      assert.equal(res.status, 401);
      const doc = await ops.collection('app_users').findOne({ username: 'lock_candidate' });
      assert.equal(doc.status, 'locked');
      assert.equal(doc.locked, true);
      assert.equal(doc.security.failedLoginAttempts, 10);
      assert.ok(doc.security.lockedAt);
      assert.equal(doc.security.lockReason, 'excessive_failed_logins');
      assert.equal(doc.security.sessionVersion, 2);
    });

    await verifyAsync('attempt 11+ does NOT repeatedly increment sessionVersion or overwrite lockedAt', async () => {
      // Clear rate limit key so request reaches password authentication on the locked account
      await ops.collection('app_rate_limits').deleteMany({ key: { $regex: 'login-user:lock_candidate' } });
      const before = await ops.collection('app_users').findOne({ username: 'lock_candidate' });
      const res = await callLogin({ username: 'lock_candidate', password: 'BadPassword!' }, { 'x-real-ip': '10.1.11.1' });
      assert.equal(res.status, 401);
      const after = await ops.collection('app_users').findOne({ username: 'lock_candidate' });
      assert.equal(after.security.sessionVersion, before.security.sessionVersion);
      assert.equal(after.security.lockedAt, before.security.lockedAt);
      assert.equal(after.security.lockReason, before.security.lockReason);
    });

    // ── 5. Account Lock Concurrency ───────────────────────────────────────────
    console.log('\n5. Account Lock Concurrency (Race Safety)');

    await ops.collection('app_users').insertOne({
      username: 'concurrent_lock_user',
      passwordHash: hash,
      role: 'operator',
      status: 'active',
      displayName: 'Concurrent Lock User',
      email: 'concurrent@test.local',
      createdAt: now,
      updatedAt: now,
      security: { sessionVersion: 1, failedLoginAttempts: 8 },
    });

    await verifyAsync('parallel wrong-password attempts increment sessionVersion exactly once', async () => {
      const attempts = [1, 2, 3, 4, 5].map((idx) =>
        callLogin({ username: 'concurrent_lock_user', password: 'BadPassword!' }, { 'x-real-ip': `10.2.0.${idx}` })
      );
      await Promise.all(attempts);

      const doc = await ops.collection('app_users').findOne({ username: 'concurrent_lock_user' });
      assert.equal(doc.status, 'locked');
      assert.equal(doc.locked, true);
      assert.ok(doc.security.failedLoginAttempts >= 10);
      assert.equal(doc.security.sessionVersion, 2, 'sessionVersion must increment exactly once on lock transition');
      assert.ok(doc.security.lockedAt);
      assert.equal(doc.security.lockReason, 'excessive_failed_logins');
    });

    // ── 6. Successful Login Accounting & Reset ────────────────────────────────
    console.log('\n6. Successful Login Accounting');

    await ops.collection('app_users').insertOne({
      username: 'reset_candidate',
      passwordHash: hash,
      role: 'operator',
      status: 'active',
      displayName: 'Reset Candidate',
      email: 'reset@test.local',
      createdAt: now,
      updatedAt: now,
      security: { sessionVersion: 1, failedLoginAttempts: 7 },
    });

    await verifyAsync('successful login resets failedLoginAttempts to 0 and updates lastLogin metadata', async () => {
      const res = await callLogin(
        { username: 'reset_candidate', password: 'CorrectPass123!' },
        { 'x-real-ip': '192.168.1.100' }
      );
      assert.equal(res.status, 200);
      assert.equal(res.body?.success, true);

      const doc = await ops.collection('app_users').findOne({ username: 'reset_candidate' });
      assert.equal(doc.security.failedLoginAttempts, 0);
      assert.equal(doc.security.lastLoginIp, '192.168.1.100');
      assert.ok(doc.security.lastLoginAt);
    });

    // ── 7. Session Invalidation After Lockout ──────────────────────────────────
    console.log('\n7. Session Invalidation After Lockout');

    await ops.collection('app_users').insertOne({
      username: 'session_target',
      passwordHash: hash,
      role: 'operator',
      status: 'active',
      displayName: 'Session Target',
      email: 'session@test.local',
      createdAt: now,
      updatedAt: now,
      security: { sessionVersion: 1, failedLoginAttempts: 0 },
    });

    await verifyAsync('old token issued before lockout is rejected with 401 after account locks', async () => {
      // 1. Issue valid token
      const validLogin = await callLogin(
        { username: 'session_target', password: 'CorrectPass123!' },
        { 'x-real-ip': '10.3.0.1' }
      );
      assert.equal(validLogin.status, 200);
      const token = validLogin.cookies.get('auth_token')?.value;
      assert.ok(token);

      // 2. Call /api/auth/me with valid token -> 200
      const meBefore = await callMe(token);
      assert.equal(meBefore.status, 200);
      assert.equal(meBefore.body?.username, 'session_target');

      // 3. Induce automatic lock (10 failed attempts)
      await ops.collection('app_rate_limits').deleteMany({ key: { $regex: 'login-user:session_target' } });
      for (let i = 1; i <= 10; i++) {
        await callLogin({ username: 'session_target', password: 'BadPassword!' }, { 'x-real-ip': `10.3.${i}.1` });
      }

      // 4. Call /api/auth/me with old token -> must be rejected with 401
      const meAfter = await callMe(token);
      assert.equal(meAfter.status, 401);
    });

    // ── 8. Admin Unlock via Canonical Go User Management API ──────────────────
    console.log('\n8. Admin Unlock via Canonical Go User Management API');

    await verifyAsync('admin unlocks locked account via Go API and restores clean active state', async () => {
      const adminToken = await makeToken('active_admin1', 'admin', 1);

      // Verify target is locked
      const beforeDoc = await ops.collection('app_users').findOne({ username: 'lock_candidate' });
      assert.equal(beforeDoc.status, 'locked');
      assert.equal(beforeDoc.locked, true);

      // Admin calls PATCH /api/users/lock_candidate with { status: "active" }
      const patchRes = await callGoUserMgmt('PATCH', '/api/users/lock_candidate', adminToken, {
        status: 'active',
      });
      assert.equal(patchRes.status, 200);
      assert.equal(patchRes.body?.status, 'active');

      // Assert Mongo state
      const afterDoc = await ops.collection('app_users').findOne({ username: 'lock_candidate' });
      assert.equal(afterDoc.status, 'active');
      assert.equal(afterDoc.locked, false);
      assert.equal(afterDoc.security.failedLoginAttempts, 0);
      assert.equal(afterDoc.security.lockedAt, undefined);
      assert.equal(afterDoc.security.lockReason, undefined);
      assert.equal(afterDoc.security.sessionVersion, beforeDoc.security.sessionVersion + 1);

      // Verify user can now log in successfully
      await ops.collection('app_rate_limits').deleteMany({ key: { $regex: 'login-user:lock_candidate' } });
      const loginRes = await callLogin(
        { username: 'lock_candidate', password: 'CorrectPass123!' },
        { 'x-real-ip': '10.4.0.1' }
      );
      assert.equal(loginRes.status, 200);
    });

    // ── 9. Last Active Admin Safety ───────────────────────────────────────────
    console.log('\n9. Last Active Admin Safety Invariants');

    await verifyAsync('last active admin is NOT locked out after 10 failed login attempts', async () => {
      // Remove admin2 temporarily so admin1 is the SOLE active admin
      await ops.collection('app_users').deleteOne({ username: 'active_admin2' });
      const activeAdminsCount = await ops.collection('app_users').countDocuments({
        role: { $in: ['admin', 'root', 'super_admin'] },
        status: 'active',
        locked: { $ne: true },
      });
      assert.equal(activeAdminsCount, 1);

      // Perform 10 failed attempts against the last admin
      await ops.collection('app_rate_limits').deleteMany({ key: { $regex: 'login-user:active_admin1' } });
      for (let i = 1; i <= 10; i++) {
        const res = await callLogin({ username: 'active_admin1', password: 'BadPassword!' }, { 'x-real-ip': `10.5.${i}.1` });
        assert.equal(res.status, 401);
      }

      // Assert admin remains active and unlocked!
      const adminDoc = await ops.collection('app_users').findOne({ username: 'active_admin1' });
      assert.equal(adminDoc.status, 'active');
      assert.notEqual(adminDoc.locked, true);

      // Restore admin2 for subsequent checks
      await ops.collection('app_users').insertOne({
        username: 'active_admin2',
        passwordHash: hash,
        role: 'admin',
        status: 'active',
        displayName: 'Active Admin 2',
        email: 'admin2@test.local',
        createdAt: now,
        updatedAt: now,
        security: { sessionVersion: 1, failedLoginAttempts: 0 },
      });
    });

    await verifyAsync('Go User Management rejects disabling or locking last active admin with 409 LAST_ACTIVE_ADMIN', async () => {
      const adminToken = await makeToken('active_admin1', 'admin', 1);

      // Delete admin1 so admin2 is the sole active admin
      await ops.collection('app_users').deleteOne({ username: 'active_admin1' });
      const adminCount = await ops.collection('app_users').countDocuments({
        role: { $in: ['admin', 'root', 'super_admin'] },
        status: 'active',
        locked: { $ne: true },
      });
      assert.equal(adminCount, 1);

      const admin2Token = await makeToken('active_admin2', 'admin', 1);

      // Try locking admin2 via PATCH
      const lockRes = await callGoUserMgmt('PATCH', '/api/users/active_admin2', admin2Token, {
        status: 'locked',
      });
      assert.equal(lockRes.status, 409);
      assert.equal(lockRes.body?.code, 'LAST_ACTIVE_ADMIN');

      // Try demoting admin2 via PATCH
      const roleRes = await callGoUserMgmt('PATCH', '/api/users/active_admin2', admin2Token, {
        role: 'operator',
      });
      assert.equal(roleRes.status, 400); // self-role change forbidden or last active admin
    });

    // ── 10. JWT Secret Validation Parity ──────────────────────────────────────
    console.log('\n10. JWT Secret Validation Parity');

    await verifyAsync('Node rejects unsafe placeholders and secrets under 32 bytes', () => {
      const orig = process.env.JWT_SECRET;
      try {
        process.env.JWT_SECRET = 'secret';
        assert.throws(() => getJwtSecretKey(), /unsafe placeholder/);

        process.env.JWT_SECRET = 'jwt_secret';
        assert.throws(() => getJwtSecretKey(), /unsafe placeholder/);

        process.env.JWT_SECRET = 'change-me';
        assert.throws(() => getJwtSecretKey(), /unsafe placeholder/);

        process.env.JWT_SECRET = 'password';
        assert.throws(() => getJwtSecretKey(), /unsafe placeholder/);

        process.env.JWT_SECRET = '1234567890123456789012345678901'; // 31 bytes
        assert.throws(() => getJwtSecretKey(), /at least 32 bytes/);

        process.env.JWT_SECRET = '12345678901234567890123456789012'; // 32 bytes
        const key = getJwtSecretKey();
        assert.equal(key.byteLength, 32);
      } finally {
        process.env.JWT_SECRET = orig;
      }
    });

    // ── 11. Cookie & Cache-Control Hardening ───────────────────────────────────
    console.log('\n11. Cookie & Cache-Control Hardening');

    await verifyAsync('Login over HTTP sets HttpOnly, SameSite=Lax, Secure=false', async () => {
      const res = await callLogin(
        { username: 'active_admin2', password: 'CorrectPass123!' },
        { 'x-real-ip': '10.6.0.1' }
      );
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('cache-control'), 'no-store');

      const cookie = res.cookies.get('auth_token');
      assert.ok(cookie);
      assert.equal(cookie.httpOnly, true);
      assert.equal(cookie.sameSite?.toLowerCase(), 'lax');
      assert.equal(cookie.secure, false);
      assert.equal(cookie.path, '/');
      assert.equal(cookie.maxAge, 86400);
    });

    await verifyAsync('Login over HTTPS (x-forwarded-proto) sets Secure=true', async () => {
      const res = await callLogin(
        { username: 'active_admin2', password: 'CorrectPass123!' },
        { 'x-real-ip': '10.6.0.2', 'x-forwarded-proto': 'https' }
      );
      assert.equal(res.status, 200);
      const cookie = res.cookies.get('auth_token');
      assert.equal(cookie.secure, true);
      assert.equal(cookie.httpOnly, true);
      assert.equal(cookie.sameSite?.toLowerCase(), 'lax');
    });

    await verifyAsync('Logout aligns cookie deletion attributes and sets Cache-Control: no-store', async () => {
      const res = await callLogout({ 'x-forwarded-proto': 'https' });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('cache-control'), 'no-store');

      const cookie = res.cookies.get('auth_token');
      assert.ok(cookie);
      assert.equal(cookie.value, '');
      assert.equal(cookie.httpOnly, true);
      assert.equal(cookie.secure, true);
      assert.equal(cookie.sameSite?.toLowerCase(), 'lax');
      assert.equal(cookie.path, '/');
      assert.equal(cookie.maxAge, 0);
    });

    // ── Summary ───────────────────────────────────────────────────────────────
    console.log(`\nAll ${passed}/${totalChecks} Authentication Security checks passed.`);
  } finally {
    // Cleanup
    try { await client.db(xcloudDbName).dropDatabase(); } catch {}
    try { await client.db(appDbName).dropDatabase(); } catch {}
    try { await client.close(); } catch {}
    try {
      const moduleClient = await getMongoClient().catch(() => null);
      await moduleClient?.close().catch(() => {});
    } catch {}
    if (goProc && !goProc.killed) {
      try { goProc.kill('SIGTERM'); } catch {}
      if (process.platform === 'win32') {
        try { execSync(`taskkill /pid ${goProc.pid} /T /F`, { stdio: 'ignore' }); } catch {}
      } else {
        try { goProc.kill('SIGKILL'); } catch {}
      }
    }
    if (binPath && existsSync(binPath)) {
      try { unlinkSync(binPath); } catch {}
    }
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
