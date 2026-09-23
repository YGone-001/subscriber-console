#!/usr/bin/env node
/**
 * User Management HTTP E2E Suite
 *
 * Mongo-backed integration suite covering actual HTTP behavior.
 * Tests the proxy -> Go routing path for all six canonical User Management routes.
 *
 * Required sequence:
 *   admin list users
 *   admin create operator
 *   operator reads directory
 *   operator create -> 403
 *   viewer reads directory
 *   viewer update -> 403
 *   admin updates role
 *   old target session rejected
 *   admin resets password
 *   old target session rejected
 *   admin disables target
 *   target authentication rejected
 */

import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { unlinkSync } from 'node:fs';
import { execSync, spawn } from 'node:child_process';
import { SignJWT } from 'jose';
import { MongoClient } from 'mongodb';
import { createJiti } from 'jiti';
import nextEnv from '@next/env';

nextEnv.loadEnvConfig(process.cwd());

const suffix = `${Date.now()}_${process.pid}_${Math.floor(Math.random() * 100000)}`;
const xcloudDbName = `xcloud_um_e2e_${suffix}`;
const appDbName = `xcloud_ops_um_e2e_${suffix}`;
const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/xcloud';

process.env.MONGODB_XCLOUD_DB = xcloudDbName;
process.env.MONGODB_APP_DB = appDbName;
const JWT_SECRET_STRING = process.env.JWT_SECRET || 'user-mgmt-e2e-suite-secret-at-least-32-bytes';
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

async function callProxy(method, path, token, body) {
  const url = new URL(path, 'http://localhost');
  const headers = { 'content-type': 'application/json' };
  if (token) headers['cookie'] = `auth_token=${token}`;
  const req = new NextRequest(url.toString(), {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await proxy(req);
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON response */ }
  return { status: res.status, body: json };
}

async function main() {
  await client.connect();
  const xcloud = client.db(xcloudDbName);
  const ops = client.db(appDbName);

  // Build & start Go backend against test databases
  const goPort = await getAvailablePort();
  const isWin = process.platform === 'win32';
  const binName = isWin ? `test-go-ume2e-${suffix}.exe` : `test-go-ume2e-${suffix}`;
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

  // Seed test users
  const bcrypt = await import('bcryptjs');
  const now = new Date().toISOString();
  const hash = await bcrypt.default.hash('TestPass123!', 10);

  await ops.collection('app_users').insertMany([
    { username: 'admin1', passwordHash: hash, role: 'admin', status: 'active', displayName: 'Admin One', email: 'admin1@test.local', createdAt: now, updatedAt: now, security: { sessionVersion: 1, failedLoginAttempts: 0 } },
    { username: 'operator1', passwordHash: hash, role: 'operator', status: 'active', displayName: 'Operator One', email: 'op1@test.local', createdAt: now, updatedAt: now, security: { sessionVersion: 1, failedLoginAttempts: 0 } },
    { username: 'viewer1', passwordHash: hash, role: 'viewer', status: 'active', displayName: 'Viewer One', email: 'viewer1@test.local', createdAt: now, updatedAt: now, security: { sessionVersion: 1, failedLoginAttempts: 0 } },
  ]);

  const adminToken = await makeToken('admin1', 'admin', 1);
  const operatorToken = await makeToken('operator1', 'operator', 1);
  const viewerToken = await makeToken('viewer1', 'viewer', 1);

  console.log('── User Management HTTP E2E Suite ──\n');

  try {

  // ── 1. Admin list users ───────────────────────────────────────────────────
  console.log('1. Admin List Users');
  await verifyAsync('admin GET /api/users returns 200 with items', async () => {
    const res = await callProxy('GET', '/api/users', adminToken);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.items), 'items must be array');
    assert.ok(res.body.items.length >= 3, `expected >= 3 users, got ${res.body.items.length}`);
    assert.ok(res.body.pagination, 'pagination must be present');
    assert.ok(res.body.stats, 'stats must be present');
    assert.ok(Array.isArray(res.body.assignableRoles), 'assignableRoles must be array');
  });

  await verifyAsync('list response has no passwordHash', async () => {
    const res = await callProxy('GET', '/api/users', adminToken);
    const json = JSON.stringify(res.body);
    assert.doesNotMatch(json, /passwordHash/);
    assert.doesNotMatch(json, /password_hash/);
  });

  // ── 2. Admin create operator ──────────────────────────────────────────────
  console.log('\n2. Admin Create User');
  await verifyAsync('admin POST /api/users creates new user (201)', async () => {
    const res = await callProxy('POST', '/api/users', adminToken, {
      username: 'operator2',
      password: 'NewPass123!',
      displayName: 'Operator Two',
      email: 'op2@test.local',
      role: 'operator',
    });
    assert.equal(res.status, 201);
  });

  await verifyAsync('create response has no passwordHash', async () => {
    const res = await callProxy('POST', '/api/users', adminToken, {
      username: 'tmp_nohash', password: 'TempPass123!', role: 'viewer',
    });
    assert.equal(res.status, 201);
    assert.doesNotMatch(JSON.stringify(res.body), /passwordHash/);
  });

  await verifyAsync('duplicate username returns 409', async () => {
    const res = await callProxy('POST', '/api/users', adminToken, {
      username: 'operator2', password: 'AnotherPass1!', role: 'viewer',
    });
    assert.equal(res.status, 409);
  });

  await verifyAsync('legacy role root rejected with 400', async () => {
    const res = await callProxy('POST', '/api/users', adminToken, {
      username: 'badrole1', password: 'ValidPass123!', role: 'root',
    });
    assert.equal(res.status, 400);
  });

  await verifyAsync('weak password rejected with 400', async () => {
    const res = await callProxy('POST', '/api/users', adminToken, {
      username: 'weakpw1', password: 'short', role: 'viewer',
    });
    assert.equal(res.status, 400);
  });

  // ── 3. Role matrix ────────────────────────────────────────────────────────
  console.log('\n3. Role Authorization Matrix');

  const roleMatrix = [
    { role: 'operator', token: () => operatorToken, read: 403, create: 403, update: 403, disable: 403, resetPassword: 403 },
    { role: 'viewer', token: () => viewerToken, read: 403, create: 403, update: 403, disable: 403, resetPassword: 403 },
  ];

  for (const tc of roleMatrix) {
    await verifyAsync(`${tc.role} GET /api/users -> ${tc.read}`, async () => {
      const res = await callProxy('GET', '/api/users', tc.token());
      assert.equal(res.status, tc.read);
    });

    await verifyAsync(`${tc.role} POST /api/users -> ${tc.create}`, async () => {
      const res = await callProxy('POST', '/api/users', tc.token(), {
        username: `${tc.role}_create_test`, password: 'ValidPass123!', role: 'viewer',
      });
      assert.equal(res.status, tc.create);
    });

    await verifyAsync(`${tc.role} PATCH /api/users/{username} -> ${tc.update}`, async () => {
      const res = await callProxy('PATCH', '/api/users/operator1', tc.token(), {
        displayName: 'Hacked',
      });
      assert.equal(res.status, tc.update);
    });

    await verifyAsync(`${tc.role} POST /api/users/{username}/disable -> ${tc.disable}`, async () => {
      const res = await callProxy('POST', '/api/users/operator1/disable', tc.token(), {});
      assert.equal(res.status, tc.disable);
    });

    await verifyAsync(`${tc.role} POST /api/users/{username}/password-reset -> ${tc.resetPassword}`, async () => {
      const res = await callProxy('POST', '/api/users/operator1/password-reset', tc.token(), {
        password: 'HackedPass1!',
      });
      assert.equal(res.status, tc.resetPassword);
    });
  }

  // ── 4. Admin update role + session invalidation ───────────────────────────
  console.log('\n4. Role Change Session Invalidation');

  const operator2TokenBefore = await makeToken('operator2', 'operator', 1);
  await verifyAsync('operator2 valid before role change', async () => {
    const res = await callProxy('GET', '/api/auth/me', operator2TokenBefore);
    assert.equal(res.status, 200);
  });

  await verifyAsync('admin updates operator2 role to viewer (200)', async () => {
    const res = await callProxy('PATCH', '/api/users/operator2', adminToken, { role: 'viewer' });
    assert.equal(res.status, 200);
  });

  await verifyAsync('old operator2 session rejected after role change', async () => {
    const res = await callProxy('GET', '/api/auth/me', operator2TokenBefore);
    assert.equal(res.status, 401);
  });

  // ── 5. Password reset + session invalidation ──────────────────────────────
  console.log('\n5. Password Reset Session Invalidation');

  const viewer1TokenBefore = await makeToken('viewer1', 'viewer', 1);
  await verifyAsync('viewer1 valid before password reset', async () => {
    const res = await callProxy('GET', '/api/auth/me', viewer1TokenBefore);
    assert.equal(res.status, 200);
  });

  await verifyAsync('admin resets viewer1 password (200)', async () => {
    const res = await callProxy('POST', '/api/users/viewer1/password-reset', adminToken, {
      password: 'ResetPass456!',
    });
    assert.equal(res.status, 200);
  });

  await verifyAsync('old viewer1 session rejected after password reset', async () => {
    const res = await callProxy('GET', '/api/auth/me', viewer1TokenBefore);
    assert.equal(res.status, 401);
  });

  // ── 6. Disable + session invalidation ─────────────────────────────────────
  console.log('\n6. Disable Session Invalidation');

  const operator1TokenBefore = await makeToken('operator1', 'operator', 1);
  await verifyAsync('operator1 valid before disable', async () => {
    const res = await callProxy('GET', '/api/auth/me', operator1TokenBefore);
    assert.equal(res.status, 200);
  });

  await verifyAsync('admin disables operator1 (200)', async () => {
    const res = await callProxy('POST', '/api/users/operator1/disable', adminToken, {
      reason: 'E2E test disable',
    });
    assert.equal(res.status, 200);
  });

  await verifyAsync('old operator1 session rejected after disable', async () => {
    const res = await callProxy('GET', '/api/auth/me', operator1TokenBefore);
    assert.equal(res.status, 401);
  });

  // ── 7. Self-protection ────────────────────────────────────────────────────
  console.log('\n7. Self-Protection');

  await verifyAsync('admin cannot disable self', async () => {
    const res = await callProxy('POST', '/api/users/admin1/disable', adminToken, {});
    assert.equal(res.status, 400);
  });

  await verifyAsync('admin cannot change own role', async () => {
    const res = await callProxy('PATCH', '/api/users/admin1', adminToken, { role: 'operator' });
    assert.equal(res.status, 400);
  });

  // ── 8. Detail parity ──────────────────────────────────────────────────────
  console.log('\n8. Detail Contract');

  await verifyAsync('GET /api/users/{username} returns 200 with safe user', async () => {
    const res = await callProxy('GET', '/api/users/admin1', adminToken);
    assert.equal(res.status, 200);
    assert.ok(res.body.user, 'user must be present');
    assert.equal(res.body.user.username, 'admin1');
    assert.equal(res.body.user.role, 'admin');
    assert.ok(res.body.user.security, 'security must be present');
    assert.doesNotMatch(JSON.stringify(res.body), /passwordHash/);
  });

  await verifyAsync('GET /api/users/unknown returns 404 USER_NOT_FOUND', async () => {
    const res = await callProxy('GET', '/api/users/nonexistent_user', adminToken);
    assert.equal(res.status, 404);
  });

  // ── 9. Security: unknown field rejection ──────────────────────────────────
  console.log('\n9. Security Edge Cases');

  await verifyAsync('unknown JSON field in create rejected', async () => {
    const res = await callProxy('POST', '/api/users', adminToken, {
      username: 'unknownfield1', password: 'ValidPass123!', role: 'viewer', evilField: 'x',
    });
    assert.ok(res.status === 400, `expected 400, got ${res.status}`);
  });

  await verifyAsync('invalid username rejected', async () => {
    const res = await callProxy('POST', '/api/users', adminToken, {
      username: 'bad user!', password: 'ValidPass123!', role: 'viewer',
    });
    assert.equal(res.status, 400);
  });

  // ── 10. Mongo assertions ─────────────────────────────────────────────────
  console.log('\n10. Mongo State Assertions');

  await verifyAsync('app_users contains expected users', async () => {
    const count = await ops.collection('app_users').countDocuments({});
    assert.ok(count >= 4, `expected >= 4 users, got ${count}`);
  });

  await verifyAsync('operator2 role updated to viewer', async () => {
    const doc = await ops.collection('app_users').findOne({ username: 'operator2' });
    assert.equal(doc.role, 'viewer');
  });

  await verifyAsync('operator1 status is disabled', async () => {
    const doc = await ops.collection('app_users').findOne({ username: 'operator1' });
    assert.equal(doc.status, 'disabled');
  });

  await verifyAsync('sessionVersion incremented on role change', async () => {
    const doc = await ops.collection('app_users').findOne({ username: 'operator2' });
    assert.ok(doc.security.sessionVersion >= 2, `sessionVersion ${doc.security.sessionVersion} >= 2`);
  });

  await verifyAsync('sessionVersion incremented on password reset', async () => {
    const doc = await ops.collection('app_users').findOne({ username: 'viewer1' });
    assert.ok(doc.security.sessionVersion >= 2, `sessionVersion ${doc.security.sessionVersion} >= 2`);
  });

  await verifyAsync('sessionVersion incremented on disable', async () => {
    const doc = await ops.collection('app_users').findOne({ username: 'operator1' });
    assert.ok(doc.security.sessionVersion >= 2, `sessionVersion ${doc.security.sessionVersion} >= 2`);
  });

  await verifyAsync('no unrelated collections modified', async () => {
    const collections = await xcloud.listCollections().toArray();
    for (const forbidden of ['ocs_tariff_plans', 'ocs_subscribers', 'ocs_balances', 'subscribers', 'app_profiles']) {
      const exists = collections.some((c) => c.name === forbidden);
      assert.equal(exists, false, `unexpected collection: ${forbidden}`);
    }
  });

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\nAll ${passed}/${totalChecks} E2E checks passed.`);
  } finally {
    // Cleanup
    try { await client.db(xcloudDbName).dropDatabase(); } catch {}
    try { await client.db(appDbName).dropDatabase(); } catch {}
    try { await client.close(); } catch {}
    if (goProc) { try { goProc.kill('SIGTERM'); } catch {} }
    if (binPath) { try { unlinkSync(binPath); } catch {} }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
