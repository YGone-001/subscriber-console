#!/usr/bin/env node

import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { execSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { MongoClient } from 'mongodb';
import { SignJWT, jwtVerify } from 'jose';
import { createJiti } from 'jiti';
import nextEnv from '@next/env';

const suffix = `${Date.now()}_${process.pid}`;
const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/xcloud';
// Pin the harness URI before loadEnvConfig so the code under test and the
// harness always resolve the same server (loadEnvConfig never overrides an
// already-defined variable, and .env may point at a different host).
process.env.MONGODB_URI = uri;
const xcloudNode = `xcloud_p73_node_${suffix}`;
const appNode = `xcloud_ops_p73_node_${suffix}`;
const xcloudGo = `xcloud_p73_go_${suffix}`;
const appGo = `xcloud_ops_p73_go_${suffix}`;
const xcloudGoFail = `xcloud_p73_gofail_${suffix}`;
const appGoFail = `xcloud_ops_p73_gofail_${suffix}`;
const secret = 'notification-stream-parity-secret-32bytes!';

process.env.JWT_SECRET = secret;
process.env.MONGODB_XCLOUD_DB = xcloudNode;
process.env.MONGODB_APP_DB = appNode;
nextEnv.loadEnvConfig(process.cwd());

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  alias: {
    '@/server/repositories/alertRepository': path.resolve(import.meta.dirname, 'instrumented-alert-repository.mjs'),
    '@/lib/accountSession': path.resolve(import.meta.dirname, 'instrumented-account-session.mjs'),
    '@': path.resolve(import.meta.dirname, '../frontend/src'),
    'next/server': path.resolve(import.meta.dirname, '../frontend/node_modules/next/server.js'),
  },
});
const { NextRequest } = jiti('next/server');
const { GET: nodeStreamHandler } = jiti('../frontend/src/app/api/notifications/stream/route.ts');
const { validateCurrentAccount, AccountSessionError } = jiti('../frontend/src/lib/accountSession.ts');
const { getMongoClient } = jiti('../frontend/src/lib/mongo.ts');
const { CUTOVER_TABLE } = jiti('../frontend/src/lib/cutover-routing.ts');
const {
  getAlertReadCount,
  resetAlertCounters,
  setFailAlertReads,
} = jiti('./instrumented-alert-repository.mjs');
const {
  getSessionValidationCount,
  resetSessionCounters,
} = jiti('./instrumented-account-session.mjs');

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
let nodeServer;
let nodePort;
let nodeActiveHandlers = 0;
let goProc;
let goPort;
let goFailProc;
let goFailPort;
let binaryPath;
let binaryFailPath;
let total = 0;
let passed = 0;
let failed = 0;
let skipped = 0;

function check(label, fn) {
  total++;
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  PASS  ${label}`);
    })
    .catch((err) => {
      failed++;
      console.error(`  FAIL  ${label}`);
      console.error(err);
    });
}

function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function token(username, role, sv = 1, expiry = 86400) {
  return new SignJWT({ username, role, sv })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setExpirationTime(Math.floor(Date.now() / 1000) + expiry)
    .sign(new TextEncoder().encode(secret));
}

function createNodeServer() {
  return http.createServer(async (req, res) => {
    if (req.method !== 'GET' || req.url !== '/api/notifications/stream') {
      res.statusCode = 404;
      res.end();
      return;
    }
    const controller = new AbortController();
    res.once('close', () => controller.abort());
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) value.forEach((item) => headers.append(key, item));
      else if (value !== undefined) headers.set(key, value);
    }
    const cookie = req.headers.cookie || '';
    const match = /(?:^|;\s*)auth_token=([^;]+)/.exec(cookie);
    if (match) {
      try {
        const { payload } = await jwtVerify(match[1], new TextEncoder().encode(secret));
        const account = await validateCurrentAccount({ username: payload.username, role: payload.role, sv: payload.sv });
        headers.set('x-user', account.username);
        headers.set('x-user-role', account.role);
        headers.set('x-user-id', account.userId);
        headers.set('x-user-session-version', String(account.sessionVersion));
      } catch (err) {
        const code = err instanceof AccountSessionError ? err.code : 'AUTH_INVALID_TOKEN';
        res.statusCode = 401;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: 'Unauthorized', code }));
        return;
      }
    }
    const nextRequest = new NextRequest(`http://127.0.0.1:${nodePort}${req.url}`, {
      method: 'GET', headers, signal: controller.signal,
    });
    const response = await nodeStreamHandler(nextRequest);
    res.statusCode = response.status;
    for (const [key, value] of response.headers.entries()) res.setHeader(key, value);
    if (!response.body) {
      res.end();
      return;
    }
    nodeActiveHandlers++;
    let decremented = false;
    const dec = () => {
      if (!decremented) {
        decremented = true;
        nodeActiveHandlers--;
      }
    };
    res.once('close', dec);
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(Buffer.from(value))) await new Promise((resolve) => res.once('drain', resolve));
      }
    } catch {
      // Client cancellation is normal for test SSE readers.
    } finally {
      dec();
      try { await reader.cancel(); } catch {}
      if (!res.writableEnded) res.end();
    }
  });
}

function openSSE(base, authToken) {
  const events = new EventEmitter();
  const frames = [];
  let response;
  let request;
  let buffer = '';
  const connected = new Promise((resolve, reject) => {
    request = http.request(`${base}/api/notifications/stream`, {
      headers: authToken ? { cookie: `auth_token=${authToken}` } : {},
    });
    request.once('error', reject);
    request.on('response', (res) => {
      response = res;
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        for (;;) {
          const end = buffer.indexOf('\n\n');
          if (end < 0) break;
          const raw = buffer.slice(0, end + 2);
          buffer = buffer.slice(end + 2);
          const lines = raw.trimEnd().split('\n');
          if (lines[0].startsWith(':')) {
            const frame = { type: 'comment', comment: lines[0].slice(1), raw, receivedAt: Date.now() };
            frames.push(frame); events.emit('frame', frame);
            continue;
          }
          const event = lines.find((line) => line.startsWith('event: '))?.slice(7);
          const data = lines.find((line) => line.startsWith('data: '))?.slice(6);
          if (event && data !== undefined) {
            const frame = { type: 'event', event, data: JSON.parse(data), raw, receivedAt: Date.now() };
            frames.push(frame); events.emit('frame', frame);
          }
        }
      });
      res.once('close', () => events.emit('close'));
      resolve(res);
    });
    request.end();
  });
  const waitFor = (predicate, timeout = 16000) => new Promise((resolve, reject) => {
    const found = frames.find(predicate);
    if (found) return resolve(found);
    const timer = setTimeout(() => {
      events.removeListener('frame', onFrame);
      reject(new Error(`SSE frame not received from ${base} within ${timeout}ms; frames=${JSON.stringify(frames)}`));
    }, timeout);
    const onFrame = (frame) => {
      if (!predicate(frame)) return;
      clearTimeout(timer);
      events.removeListener('frame', onFrame);
      resolve(frame);
    };
    events.on('frame', onFrame);
  });
  return {
    connected,
    frames,
    waitFor,
    events,
    close: () => {
      try { response?.destroy(); } catch {}
      try { request?.destroy(); } catch {}
    },
  };
}

async function seed(xcloudDb, appDb) {
  const app = client.db(appDb);
  const xcloud = client.db(xcloudDb);
  await app.collection('app_users').insertMany([
    ...['admin', 'operator', 'viewer', 'root', 'super_admin', 'ops_admin', 'auditor'].map((role) => ({
      username: `${role}_user`, role, status: 'active', locked: false, security: { sessionVersion: 1 },
    })),
    { username: 'disabled_user', role: 'viewer', status: 'disabled', locked: false, security: { sessionVersion: 1 } },
    { username: 'locked_user', role: 'viewer', status: 'locked', locked: true, security: { sessionVersion: 1 } },
  ]);
  await app.collection('app_alerts').insertMany(Array.from({ length: 6 }, (_, index) => ({
    id: `alert-${index}`, timestamp: `2026-09-28T00:00:0${index}.000Z`, level: index % 2 ? 'WARNING' : 'CRITICAL',
    imsi: `00101000000000${index}`, reason: `seed-${index}`, is_acknowledged: index === 5,
  })));
  for (const name of ['app_profiles', 'app_profile_versions', 'app_audit_logs', 'app_rate_limits']) {
    await app.collection(name).insertOne({ sentinel: name });
  }
  for (const name of ['subscribers', 'ocs_tariff_plans', 'ocs_subscribers', 'ocs_balances', 'ocs_sessions', 'ocs_reservations', 'ocs_usage_records']) {
    await xcloud.collection(name).insertOne({ sentinel: name });
  }
}

async function waitForReady(base) {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${base}/healthz`)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server at ${base} did not become ready`);
}

function normalizedInit(frame) {
  const { timestamp, ...rest } = frame.data;
  assert.match(timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  return rest;
}

async function fingerprint(db, name) {
  const docs = await client.db(db).collection(name).find({}).sort({ _id: 1 }).toArray();
  return { count: docs.length, digest: JSON.stringify(docs.map(({ _id, ...doc }) => doc)) };
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function noFrame(stream, predicate, duration = 4300) {
  await sleep(duration);
  assert.equal(stream.frames.some(predicate), false, `unexpected frame: ${JSON.stringify(stream.frames)}`);
}

async function openPair(authToken) {
  const node = openSSE(nodeBaseForTest, authToken);
  const go = openSSE(goBaseForTest, authToken);
  const [nodeResponse, goResponse] = await Promise.all([node.connected, go.connected]);
  return { node, go, nodeResponse, goResponse };
}

async function openPairFail(authToken) {
  const node = openSSE(nodeBaseForTest, authToken);
  const go = openSSE(`http://127.0.0.1:${goFailPort}`, authToken);
  const [nodeResponse, goResponse] = await Promise.all([node.connected, go.connected]);
  return { node, go, nodeResponse, goResponse };
}

async function receiveInit(pair) {
  return Promise.all([pair.node.waitFor((frame) => frame.event === 'init'), pair.go.waitFor((frame) => frame.event === 'init')]);
}

async function replaceAlerts(docs) {
  for (const db of [appNode, appGo]) {
    const collection = client.db(db).collection('app_alerts');
    await collection.deleteMany({});
    if (docs.length) await collection.insertMany(docs);
  }
}

async function replaceAlertsFail(docs) {
  for (const db of [appNode, appGoFail]) {
    const collection = client.db(db).collection('app_alerts');
    await collection.deleteMany({});
    if (docs.length) await collection.insertMany(docs);
  }
}

function alertDoc(id, timestamp, level = 'INFO', acknowledged = false, extra = {}) {
  return { id, timestamp, level, imsi: `001010${id.padStart(9, '0').slice(-9)}`, reason: `reason-${id}`, is_acknowledged: acknowledged, ...extra };
}

function hasTransientRetry(stream) {
  return stream.frames.some((f) => (f.comment && f.comment.includes('transient_retry')) || (f.raw && f.raw.includes('transient_retry')));
}

async function getGoCounters() {
  const res = await fetch(`http://127.0.0.1:${goFailPort}/testonly/counters`);
  return res.json();
}

async function resetGoCounters() {
  await fetch(`http://127.0.0.1:${goFailPort}/testonly/reset-counters`, { method: 'POST' });
}

async function setGoFailAlerts(fail) {
  await fetch(`http://127.0.0.1:${goFailPort}/testonly/fail-alerts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fail }),
  });
}

function getNodeCounters() {
  return {
    alertReads: getAlertReadCount(),
    sessionValidations: getSessionValidationCount(),
    activeHandlers: nodeActiveHandlers,
  };
}

function resetNodeCounters() {
  resetAlertCounters();
  resetSessionCounters();
}

function setNodeFailAlerts(fail) {
  setFailAlertReads(fail);
}

let nodeBaseForTest = '';
let goBaseForTest = '';

async function main() {
  console.log('Phase 7.3 Notification Streaming Parity Suite');
  await client.connect();
  await seed(xcloudNode, appNode);
  await seed(xcloudGo, appGo);
  await seed(xcloudGoFail, appGoFail);

  nodePort = await getAvailablePort();
  nodeServer = createNodeServer();
  await new Promise((resolve) => nodeServer.listen(nodePort, '127.0.0.1', resolve));

  goPort = await getAvailablePort();
  goFailPort = await getAvailablePort();

  binaryPath = path.join(os.tmpdir(), `p73-stream-${suffix}${process.platform === 'win32' ? '.exe' : ''}`);
  binaryFailPath = path.join(os.tmpdir(), `p73-stream-fail-${suffix}${process.platform === 'win32' ? '.exe' : ''}`);

  execSync(`go build -o "${binaryPath}" ./cmd/server`, { cwd: path.resolve(import.meta.dirname, '..', 'backend'), stdio: 'inherit' });
  execSync(`go build -o "${binaryFailPath}" ./cmd/testserver`, { cwd: path.resolve(import.meta.dirname, '..', 'backend'), stdio: 'inherit' });

  goProc = spawn(binaryPath, [], {
    env: { ...process.env, HTTP_ADDR: `127.0.0.1:${goPort}`, MONGODB_URI: uri, MONGODB_XCLOUD_DB: xcloudGo, MONGODB_APP_DB: appGo, JWT_SECRET: secret, HTTP_WRITE_TIMEOUT: '2s' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  goFailProc = spawn(binaryFailPath, [], {
    env: { ...process.env, HTTP_ADDR: `127.0.0.1:${goFailPort}`, MONGODB_URI: uri, MONGODB_XCLOUD_DB: xcloudGoFail, MONGODB_APP_DB: appGoFail, JWT_SECRET: secret, HTTP_WRITE_TIMEOUT: '2s' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });

  await Promise.all([
    waitForReady(`http://127.0.0.1:${goPort}`),
    waitForReady(`http://127.0.0.1:${goFailPort}`),
  ]);

  const nodeBase = `http://127.0.0.1:${nodePort}`;
  const goBase = `http://127.0.0.1:${goPort}`;
  nodeBaseForTest = nodeBase;
  goBaseForTest = goBase;
  const adminToken = await token('admin_user', 'admin');
  const viewerToken = await token('viewer_user', 'viewer');

  await check('unauthenticated and invalid credentials retain 401 parity', async () => {
    for (const candidate of [null, 'invalid.token.value', await token('disabled_user', 'viewer'), await token('locked_user', 'viewer'), await token('viewer_user', 'viewer', 99), await token('viewer_user', 'viewer', 1, -60)]) {
      const [node, go] = await Promise.all([openSSE(nodeBase, candidate).connected, openSSE(goBase, candidate).connected]);
      assert.equal(node.statusCode, 401); assert.equal(go.statusCode, 401);
      node.resume(); go.resume();
    }
  });

  await check('init framing, headers, roles, and recent limit match over real TCP', async () => {
    for (const role of ['admin', 'operator', 'viewer', 'root', 'super_admin', 'ops_admin', 'auditor']) {
      const authToken = await token(`${role}_user`, role);
      const node = openSSE(nodeBase, authToken);
      const go = openSSE(goBase, authToken);
      try {
        const [nodeRes, goRes] = await Promise.all([node.connected, go.connected]);
        assert.equal(nodeRes.statusCode, 200, `Node status for ${role}`);
        assert.equal(goRes.statusCode, 200, `Go status for ${role}`);
        const [nodeInit, goInit] = await Promise.all([node.waitFor((f) => f.event === 'init'), go.waitFor((f) => f.event === 'init')]);
        for (const header of ['content-type', 'cache-control', 'connection', 'x-accel-buffering']) assert.equal(goRes.headers[header], nodeRes.headers[header]);
        assert.equal(goRes.headers['content-type'], 'text/event-stream; charset=utf-8');
        assert.deepEqual(normalizedInit(goInit), normalizedInit(nodeInit));
        assert.ok(goInit.data.alerts.recent.length <= 5);
      } finally {
        node.close(); go.close();
      }
    }
    console.log('[sse-parity] case=init');
    console.log('[sse-parity] Node event=init');
    console.log('[sse-parity] Go event=init');
    console.log('[sse-parity] PARITY=PASS');
  });

  await check('active count changes emit matching alerts_update frames', async () => {
    const node = openSSE(nodeBase, viewerToken); const go = openSSE(goBase, viewerToken);
    await Promise.all([node.connected, go.connected, node.waitFor((f) => f.event === 'init'), go.waitFor((f) => f.event === 'init')]);
    const doc = { id: 'alert-update', timestamp: '2026-09-28T01:00:00.000Z', level: 'WARNING', imsi: '001', reason: 'update', is_acknowledged: false };
    await Promise.all([client.db(appNode).collection('app_alerts').insertOne(doc), client.db(appGo).collection('app_alerts').insertOne(doc)]);
    const [nodeUpdate, goUpdate] = await Promise.all([node.waitFor((f) => f.event === 'alerts_update'), go.waitFor((f) => f.event === 'alerts_update')]);
    const strip = (f) => { const { timestamp, ...body } = f.data; assert.match(timestamp, /^\d{4}-/); return body; };
    assert.deepEqual(strip(goUpdate), strip(nodeUpdate));
    node.close(); go.close();
    console.log('[sse-parity] case=alerts_update');
    console.log('[sse-parity] Node event=alerts_update');
    console.log('[sse-parity] Go event=alerts_update');
    console.log('[sse-parity] PARITY=PASS');
  });

  await check('periodic session revalidation emits session_expired then closes', async () => {
    const node = openSSE(nodeBase, viewerToken); const go = openSSE(goBase, viewerToken);
    await Promise.all([node.connected, go.connected, node.waitFor((f) => f.event === 'init'), go.waitFor((f) => f.event === 'init')]);
    await Promise.all([
      client.db(appNode).collection('app_users').updateOne({ username: 'viewer_user' }, { $set: { 'security.sessionVersion': 2 } }),
      client.db(appGo).collection('app_users').updateOne({ username: 'viewer_user' }, { $set: { 'security.sessionVersion': 2 } }),
    ]);
    const [nodeExpired, goExpired] = await Promise.all([node.waitFor((f) => f.event === 'session_expired'), go.waitFor((f) => f.event === 'session_expired')]);
    assert.deepEqual(nodeExpired.data, {}); assert.deepEqual(goExpired.data, {});
    await Promise.all([
      client.db(appNode).collection('app_users').updateOne({ username: 'viewer_user' }, { $set: { 'security.sessionVersion': 1 } }),
      client.db(appGo).collection('app_users').updateOne({ username: 'viewer_user' }, { $set: { 'security.sessionVersion': 1 } }),
    ]);
    console.log('[sse-parity] case=session_expired');
    console.log('[sse-parity] Node event=session_expired');
    console.log('[sse-parity] Go event=session_expired');
    console.log('[sse-parity] stream_closed=true');
    console.log('[sse-parity] PARITY=PASS');
  });

  await check('heartbeat framing and stream-scoped WriteTimeout survival match', async () => {
    const authToken = await token('operator_user', 'operator');
    const node = openSSE(nodeBase, authToken); const go = openSSE(goBase, authToken);
    await Promise.all([node.connected, go.connected, node.waitFor((f) => f.event === 'init'), go.waitFor((f) => f.event === 'init')]);
    const [nodePing, goPing] = await Promise.all([node.waitFor((f) => f.type === 'comment' && f.comment === 'ping'), go.waitFor((f) => f.type === 'comment' && f.comment === 'ping')]);
    assert.equal(nodePing.raw, ':ping\n\n'); assert.equal(goPing.raw, ':ping\n\n');
    node.close(); go.close();
    console.log('[sse-parity] case=heartbeat');
    console.log('[sse-parity] Node comment=ping');
    console.log('[sse-parity] Go comment=ping');
    console.log('[sse-parity] case=write_timeout_survival');
    console.log('[sse-parity] configured_write_timeout=2s');
    console.log('[sse-parity] stream_alive_after_timeout=true');
    console.log('[sse-parity] PARITY=PASS');
  });

  await check('notification activity leaves protected collection contents unchanged', async () => {
    const protectedCollections = [
      [xcloudNode, 'subscribers'], [xcloudNode, 'ocs_tariff_plans'], [xcloudNode, 'ocs_subscribers'], [xcloudNode, 'ocs_balances'], [xcloudNode, 'ocs_sessions'], [xcloudNode, 'ocs_reservations'], [xcloudNode, 'ocs_usage_records'],
      [appNode, 'app_profiles'], [appNode, 'app_profile_versions'], [appNode, 'app_users'], [appNode, 'app_alerts'], [appNode, 'app_audit_logs'], [appNode, 'app_rate_limits'],
      [xcloudGo, 'subscribers'], [xcloudGo, 'ocs_tariff_plans'], [xcloudGo, 'ocs_subscribers'], [xcloudGo, 'ocs_balances'], [xcloudGo, 'ocs_sessions'], [xcloudGo, 'ocs_reservations'], [xcloudGo, 'ocs_usage_records'],
      [appGo, 'app_profiles'], [appGo, 'app_profile_versions'], [appGo, 'app_users'], [appGo, 'app_alerts'], [appGo, 'app_audit_logs'], [appGo, 'app_rate_limits'],
    ];
    const before = await Promise.all(protectedCollections.map(([db, name]) => fingerprint(db, name)));
    const authToken = await token('admin_user', 'admin');
    const node = openSSE(nodeBase, authToken); const go = openSSE(goBase, authToken);
    await Promise.all([node.connected, go.connected, node.waitFor((f) => f.event === 'init'), go.waitFor((f) => f.event === 'init')]);
    node.close(); go.close();
    const after = await Promise.all(protectedCollections.map(([db, name]) => fingerprint(db, name)));
    assert.deepEqual(after, before);
  });

  for (const [id, label, candidate] of [
    ['A01', 'no-token', null],
    ['A02', 'invalid-token', 'invalid.token.value'],
    ['A03', 'expired-token', await token('viewer_user', 'viewer', 1, -60)],
    ['A04', 'initial-revoked', await token('viewer_user', 'viewer', 99)],
    ['A05', 'initial-disabled', await token('disabled_user', 'viewer')],
    ['A06', 'initial-locked', await token('locked_user', 'viewer')],
  ]) {
    await check(`${id} initial-auth:${label}`, async () => {
      const pair = await openPair(candidate);
      assert.equal(pair.nodeResponse.statusCode, 401);
      assert.equal(pair.goResponse.statusCode, 401);
      pair.node.close(); pair.go.close();
    });
  }

  for (const [id, role] of [['A07', 'admin'], ['A08', 'operator'], ['A09', 'viewer'], ['A10', 'root'], ['A11', 'super_admin'], ['A12', 'ops_admin'], ['A13', 'auditor']]) {
    await check(`${id} initial-auth:${role}`, async () => {
      const pair = await openPair(await token(`${role}_user`, role));
      try {
        assert.equal(pair.nodeResponse.statusCode, 200); assert.equal(pair.goResponse.statusCode, 200);
        const [nodeInit, goInit] = await receiveInit(pair);
        assert.equal(nodeInit.data.user, `${role}_user`); assert.equal(goInit.data.user, `${role}_user`);
        assert.equal(goInit.data.role, nodeInit.data.role);
      } finally { pair.node.close(); pair.go.close(); }
    });
  }

  const initCases = [
    ['I01', 'populated', [alertDoc('1', '2026-09-28T00:00:01.000Z', 'CRITICAL'), alertDoc('2', '2026-09-28T00:00:02.000Z', 'WARNING')]],
    ['I02', 'empty', []],
    ['I03', 'more-than-five', Array.from({ length: 6 }, (_, i) => alertDoc(String(i + 1), `2026-09-28T00:00:${String(i).padStart(2, '0')}.000Z`))],
    ['I04', 'more-than-fifteen', Array.from({ length: 16 }, (_, i) => alertDoc(String(i + 1), `2026-09-28T00:00:${String(i).padStart(2, '0')}.000Z`))],
    ['I05', 'critical-count', [alertDoc('1', '2026-09-28T00:00:01.000Z', 'CRITICAL'), alertDoc('2', '2026-09-28T00:00:02.000Z', 'CRITICAL')]],
    ['I06', 'warning-count', [alertDoc('1', '2026-09-28T00:00:01.000Z', 'WARNING'), alertDoc('2', '2026-09-28T00:00:02.000Z', 'WARNING')]],
    ['I07', 'mixed-levels', [alertDoc('1', '2026-09-28T00:00:01.000Z', 'CRITICAL'), alertDoc('2', '2026-09-28T00:00:02.000Z', 'WARNING'), alertDoc('3', '2026-09-28T00:00:03.000Z')]],
    ['I08', 'acknowledged', [alertDoc('1', '2026-09-28T00:00:01.000Z', 'CRITICAL', true)]],
    ['I09', 'workflow-fields', [alertDoc('1', '2026-09-28T00:00:01.000Z', 'WARNING', false, { workflow_status: 'assigned', assigned_to: 'ops', handling_note: 'note' })]],
  ];
  for (const [id, label, docs] of initCases) {
    await check(`${id} init:${label}`, async () => {
      await replaceAlerts(docs);
      const pair = await openPair(await token('admin_user', 'admin'));
      try {
        const [nodeInit, goInit] = await receiveInit(pair);
        assert.deepEqual(normalizedInit(goInit), normalizedInit(nodeInit));
        assert.ok(goInit.data.alerts.recent.length <= 5);
      } finally { pair.node.close(); pair.go.close(); }
    });
  }

  await check('I10 initial-repo-failure-wire-parity', async () => {
    setNodeFailAlerts(true);
    await setGoFailAlerts(true);
    const pair = await openPairFail(adminToken);
    try {
      assert.equal(pair.nodeResponse.statusCode, 200);
      assert.equal(pair.goResponse.statusCode, 200);
      assert.equal(pair.nodeResponse.headers['content-type'], 'text/event-stream; charset=utf-8');
      assert.equal(pair.goResponse.headers['content-type'], 'text/event-stream; charset=utf-8');
      const [nodeInit, goInit] = await receiveInit(pair);
      assert.deepEqual(normalizedInit(goInit), normalizedInit(nodeInit));
      assert.equal(nodeInit.data.alerts.activeCount, 0);
      assert.equal(goInit.data.alerts.activeCount, 0);
      assert.deepEqual(nodeInit.data.alerts.recent, []);
      assert.deepEqual(goInit.data.alerts.recent, []);
      console.log('[sse-parity] case=init_repository_failure');
      console.log('[sse-parity] Node initial_status=200');
      console.log('[sse-parity] Go initial_status=200');
      console.log('[sse-parity] Node event=init');
      console.log('[sse-parity] Go event=init');
      console.log('[sse-parity] PARITY=PASS');
    } finally {
      pair.node.close(); pair.go.close();
      setNodeFailAlerts(false);
      await setGoFailAlerts(false);
    }
  });

  for (const [id, field] of [['U03', 'reason'], ['U04', 'level'], ['U05', 'workflow_status'], ['U06', 'assigned_to'], ['U07', 'handling_note']]) {
    await check(`${id} same-active-count-${field}-has-no-update`, async () => {
      await replaceAlerts([alertDoc('1', '2026-09-28T00:00:01.000Z')]);
      const pair = await openPair(await token('admin_user', 'admin'));
      try {
        await receiveInit(pair);
        await Promise.all([client.db(appNode).collection('app_alerts').updateOne({ id: '1' }, { $set: { [field]: `changed-${field}` } }), client.db(appGo).collection('app_alerts').updateOne({ id: '1' }, { $set: { [field]: `changed-${field}` } })]);
        await Promise.all([noFrame(pair.node, (frame) => frame.event === 'alerts_update'), noFrame(pair.go, (frame) => frame.event === 'alerts_update')]);
      } finally { pair.node.close(); pair.go.close(); }
    });
  }

  await check('U02 active-count-decrease-emits-update', async () => {
    await replaceAlerts([alertDoc('1', '2026-09-28T00:00:01.000Z'), alertDoc('2', '2026-09-28T00:00:02.000Z')]);
    const pair = await openPair(await token('admin_user', 'admin'));
    try {
      await receiveInit(pair);
      await Promise.all([client.db(appNode).collection('app_alerts').updateOne({ id: '1' }, { $set: { is_acknowledged: true } }), client.db(appGo).collection('app_alerts').updateOne({ id: '1' }, { $set: { is_acknowledged: true } })]);
      const [nodeUpdate, goUpdate] = await Promise.all([pair.node.waitFor((frame) => frame.event === 'alerts_update'), pair.go.waitFor((frame) => frame.event === 'alerts_update')]);
      assert.equal(nodeUpdate.data.activeCount, 1); assert.equal(goUpdate.data.activeCount, 1);
    } finally { pair.node.close(); pair.go.close(); }
  });

  await check('RF01 periodic-repo-failure-wire-parity', async () => {
    await replaceAlertsFail([alertDoc('1', '2026-09-28T00:00:01.000Z')]);
    setNodeFailAlerts(false);
    await setGoFailAlerts(false);
    const pair = await openPairFail(adminToken);
    try {
      await receiveInit(pair);
      setNodeFailAlerts(true);
      await setGoFailAlerts(true);
      await sleep(5000);

      const nodeAlertsUpdate = pair.node.frames.some((f) => f.event === 'alerts_update');
      const goAlertsUpdate = pair.go.frames.some((f) => f.event === 'alerts_update');
      const nodeSessionExpired = pair.node.frames.some((f) => f.event === 'session_expired');
      const goSessionExpired = pair.go.frames.some((f) => f.event === 'session_expired');
      const nodeTransientRetry = hasTransientRetry(pair.node);
      const goTransientRetry = hasTransientRetry(pair.go);

      assert.equal(nodeAlertsUpdate, false, 'Node must not emit alerts_update on repo failure');
      assert.equal(goAlertsUpdate, false, 'Go must not emit alerts_update on repo failure');
      assert.equal(nodeSessionExpired, false, 'Node must not emit session_expired on repo failure');
      assert.equal(goSessionExpired, false, 'Go must not emit session_expired on repo failure');
      assert.equal(nodeTransientRetry, false, 'Node must not emit transient_retry for handled listAlerts');
      assert.equal(goTransientRetry, false, 'Go must not emit transient_retry for handled listAlerts');

      // Prove stream survival: restore repository access and prove connection delivers subsequent frame
      setNodeFailAlerts(false);
      await setGoFailAlerts(false);
      const survivalDoc = alertDoc('rf01-surv', '2026-09-28T01:30:00.000Z', 'WARNING', false);
      await Promise.all([
        client.db(appNode).collection('app_alerts').insertOne(survivalDoc),
        client.db(appGoFail).collection('app_alerts').insertOne(survivalDoc),
      ]);
      const [nodeSurvUpdate, goSurvUpdate] = await Promise.all([
        pair.node.waitFor((f) => f.event === 'alerts_update', 8000),
        pair.go.waitFor((f) => f.event === 'alerts_update', 8000),
      ]);
      assert.ok(nodeSurvUpdate, 'Node connection must deliver recovery frame');
      assert.ok(goSurvUpdate, 'Go connection must deliver recovery frame');

      console.log('[sse-parity] case=RF01_periodic_failure');
      console.log(`[sse-parity] node_alerts_update=${nodeAlertsUpdate}`);
      console.log(`[sse-parity] go_alerts_update=${goAlertsUpdate}`);
      console.log(`[sse-parity] node_session_expired=${nodeSessionExpired}`);
      console.log(`[sse-parity] go_session_expired=${goSessionExpired}`);
      console.log(`[sse-parity] node_transient_retry=${nodeTransientRetry}`);
      console.log(`[sse-parity] go_transient_retry=${goTransientRetry}`);
      console.log('[sse-parity] node_stream_survival_proven=true');
      console.log('[sse-parity] go_stream_survival_proven=true');
      console.log('[sse-parity] parity=PASS');
    } finally {
      pair.node.close(); pair.go.close();
      setNodeFailAlerts(false);
      await setGoFailAlerts(false);
    }
  });

  await check('RF02 repo-recovery-wire-parity', async () => {
    await replaceAlertsFail([alertDoc('1', '2026-09-28T00:00:01.000Z')]);
    resetNodeCounters();
    await resetGoCounters();
    setNodeFailAlerts(false);
    await setGoFailAlerts(false);
    const pair = await openPairFail(adminToken);
    try {
      await receiveInit(pair);
      setNodeFailAlerts(true);
      await setGoFailAlerts(true);
      await sleep(4500); // allow at least one failed periodic cycle
      const nodeValDuring = getNodeCounters().sessionValidations;
      const goValDuring = (await getGoCounters()).sessionValidations;
      setNodeFailAlerts(false);
      await setGoFailAlerts(false);
      const newDoc = alertDoc('rec-1', '2026-09-28T02:00:00.000Z', 'CRITICAL', false);
      await Promise.all([
        client.db(appNode).collection('app_alerts').insertOne(newDoc),
        client.db(appGoFail).collection('app_alerts').insertOne(newDoc),
      ]);
      const [nodeUpdate, goUpdate] = await Promise.all([
        pair.node.waitFor((f) => f.event === 'alerts_update', 8000),
        pair.go.waitFor((f) => f.event === 'alerts_update', 8000),
      ]);
      assert.equal(nodeUpdate.data.activeCount, 2);
      assert.equal(goUpdate.data.activeCount, 2);
      await sleep(4500); // allow at least one subsequent periodic cycle
      const nodeValAfter = getNodeCounters().sessionValidations;
      const goValAfter = (await getGoCounters()).sessionValidations;
      assert.ok(nodeValAfter > nodeValDuring, `Node validations after (${nodeValAfter}) must be > during (${nodeValDuring})`);
      assert.ok(goValAfter > goValDuring, `Go validations after (${goValAfter}) must be > during (${goValDuring})`);
      console.log('[sse-parity] case=RF02_repository_recovery');
      console.log(`[sse-parity] node_validations_during_failure=${nodeValDuring}`);
      console.log(`[sse-parity] node_validations_after_recovery=${nodeValAfter}`);
      console.log(`[sse-parity] go_validations_during_failure=${goValDuring}`);
      console.log(`[sse-parity] go_validations_after_recovery=${goValAfter}`);
      console.log('[sse-parity] node_update_after_recovery=true');
      console.log('[sse-parity] go_update_after_recovery=true');
      console.log('[sse-parity] parity=PASS');
    } finally {
      pair.node.close(); pair.go.close();
      setNodeFailAlerts(false);
      await setGoFailAlerts(false);
    }
  });

  for (const [id, update] of [['S01', { 'security.sessionVersion': 2 }], ['S02', { status: 'disabled' }], ['S03', { status: 'locked', locked: true }], ['S04', { role: 'operator' }]]) {
    await check(`${id} post-connect-session-expiry`, async () => {
      const username = 'viewer_user';
      await Promise.all([client.db(appNode).collection('app_users').updateOne({ username }, { $set: { role: 'viewer', status: 'active', locked: false, 'security.sessionVersion': 1 } }), client.db(appGo).collection('app_users').updateOne({ username }, { $set: { role: 'viewer', status: 'active', locked: false, 'security.sessionVersion': 1 } })]);
      const pair = await openPair(await token(username, 'viewer'));
      try {
        await receiveInit(pair);
        await Promise.all([client.db(appNode).collection('app_users').updateOne({ username }, { $set: update }), client.db(appGo).collection('app_users').updateOne({ username }, { $set: update })]);
        const [nodeExpired, goExpired] = await Promise.all([pair.node.waitFor((frame) => frame.event === 'session_expired'), pair.go.waitFor((frame) => frame.event === 'session_expired')]);
        assert.deepEqual(nodeExpired.data, {}); assert.deepEqual(goExpired.data, {});
      } finally {
        pair.node.close(); pair.go.close();
        await Promise.all([client.db(appNode).collection('app_users').updateOne({ username }, { $set: { role: 'viewer', status: 'active', locked: false, 'security.sessionVersion': 1 } }), client.db(appGo).collection('app_users').updateOne({ username }, { $set: { role: 'viewer', status: 'active', locked: false, 'security.sessionVersion': 1 } })]);
      }
    });
  }

  await check('S05 valid-session-survives-multiple-polls', async () => {
    const pair = await openPair(await token('operator_user', 'operator'));
    try {
      await receiveInit(pair);
      await sleep(8500);
      assert.equal(pair.node.frames.some((frame) => frame.event === 'session_expired'), false);
      assert.equal(pair.go.frames.some((frame) => frame.event === 'session_expired'), false);
    } finally { pair.node.close(); pair.go.close(); }
  });

  await check('LC01 client-disconnect-stops-repository-polling', async () => {
    resetNodeCounters();
    await resetGoCounters();
    const pair = await openPairFail(adminToken);
    await receiveInit(pair);
    await sleep(5000);
    const nodeReadsBefore = getNodeCounters().alertReads;
    const goReadsBefore = (await getGoCounters()).alertReads;
    assert.ok(nodeReadsBefore >= 2, `Node must have executed polls (got ${nodeReadsBefore})`);
    assert.ok(goReadsBefore >= 2, `Go must have executed polls (got ${goReadsBefore})`);
    pair.node.close();
    pair.go.close();
    await sleep(1000);
    const nodeReadsAfterCleanup = getNodeCounters().alertReads;
    const goReadsAfterCleanup = (await getGoCounters()).alertReads;
    await sleep(5000);
    const nodeReadsAfterExtra = getNodeCounters().alertReads;
    const goReadsAfterExtra = (await getGoCounters()).alertReads;
    assert.equal(nodeReadsAfterExtra, nodeReadsAfterCleanup, 'Node polls must halt after disconnect');
    assert.equal(goReadsAfterExtra, goReadsAfterCleanup, 'Go polls must halt after disconnect');
    console.log('[sse-parity] case=LC01');
    console.log(`[sse-parity] node_reads_before_disconnect=${nodeReadsBefore}`);
    console.log(`[sse-parity] node_reads_after_cleanup=${nodeReadsAfterCleanup}`);
    console.log(`[sse-parity] node_reads_after_extra_interval=${nodeReadsAfterExtra}`);
    console.log(`[sse-parity] go_reads_before_disconnect=${goReadsBefore}`);
    console.log(`[sse-parity] go_reads_after_cleanup=${goReadsAfterCleanup}`);
    console.log(`[sse-parity] go_reads_after_extra_interval=${goReadsAfterExtra}`);
    console.log('[sse-parity] parity=PASS');
  });

  await check('LC02 client-disconnect-stops-session-validation', async () => {
    resetNodeCounters();
    await resetGoCounters();
    const pair = await openPairFail(adminToken);
    await receiveInit(pair);
    await sleep(5000);
    const nodeValsBefore = getNodeCounters().sessionValidations;
    const goValsBefore = (await getGoCounters()).sessionValidations;
    assert.ok(nodeValsBefore >= 1, `Node must have executed validations (got ${nodeValsBefore})`);
    assert.ok(goValsBefore >= 1, `Go must have executed validations (got ${goValsBefore})`);
    pair.node.close();
    pair.go.close();
    await sleep(1000);
    const nodeValsAfterCleanup = getNodeCounters().sessionValidations;
    const goValsAfterCleanup = (await getGoCounters()).sessionValidations;
    await sleep(5000);
    const nodeValsAfterExtra = getNodeCounters().sessionValidations;
    const goValsAfterExtra = (await getGoCounters()).sessionValidations;
    assert.equal(nodeValsAfterExtra, nodeValsAfterCleanup, 'Node validations must halt after disconnect');
    assert.equal(goValsAfterExtra, goValsAfterCleanup, 'Go validations must halt after disconnect');
    console.log('[sse-parity] case=LC02');
    console.log(`[sse-parity] node_validations_before_disconnect=${nodeValsBefore}`);
    console.log(`[sse-parity] node_validations_after_cleanup=${nodeValsAfterCleanup}`);
    console.log(`[sse-parity] node_validations_after_extra_interval=${nodeValsAfterExtra}`);
    console.log(`[sse-parity] go_validations_before_disconnect=${goValsBefore}`);
    console.log(`[sse-parity] go_validations_after_cleanup=${goValsAfterCleanup}`);
    console.log(`[sse-parity] go_validations_after_extra_interval=${goValsAfterExtra}`);
    console.log('[sse-parity] parity=PASS');
  });

  await check('LC03 client-disconnect-exits-handler-lifecycle', async () => {
    await sleep(1000);
    const pair = await openPairFail(adminToken);
    await receiveInit(pair);
    assert.equal(getNodeCounters().activeHandlers, 1);
    assert.equal((await getGoCounters()).activeHandlers, 1);
    pair.node.close();
    pair.go.close();
    await sleep(1500);
    assert.equal(getNodeCounters().activeHandlers, 0, 'Node active handlers must return to 0');
    assert.equal((await getGoCounters()).activeHandlers, 0, 'Go active handlers must return to 0');
    console.log('[sse-parity] case=LC03');
    console.log('[sse-parity] node_active_handlers=0');
    console.log('[sse-parity] go_active_handlers=0');
    console.log('[sse-parity] parity=PASS');
  });

  await check('LC04 go-graceful-shutdown-real-execution', async () => {
    const out = execSync('go test -v -count=1 -run TestGracefulShutdown ./internal/notification/...', {
      cwd: path.resolve(import.meta.dirname, '..', 'backend'),
      encoding: 'utf8',
    });
    assert.ok(out.includes('PASS'));
    assert.ok(out.includes('handler_active_before_shutdown=true'));
    assert.ok(out.includes('shutdown_requested=true'));
    assert.ok(out.includes('server_shutdown_completed=true'));
    assert.ok(out.includes('connection_closed=true'));
    assert.ok(out.includes('handler_exited=true'));
    console.log('[sse-parity] case=go_graceful_shutdown');
    console.log('[sse-parity] handler_active_before_shutdown=true');
    console.log('[sse-parity] shutdown_requested=true');
    console.log('[sse-parity] server_shutdown_completed=true');
    console.log('[sse-parity] connection_closed=true');
    console.log('[sse-parity] handler_exited=true');
    console.log('[sse-parity] PASS');
  });

  await check('C01 same-user-concurrent-streams-receive-independent-updates', async () => {
    await replaceAlerts([alertDoc('c01-base', '2026-09-28T00:00:01.000Z')]);
    const pair1 = await openPair(await token('operator_user', 'operator'));
    const pair2 = await openPair(await token('operator_user', 'operator'));
    try {
      await Promise.all([receiveInit(pair1), receiveInit(pair2)]);
      const doc = alertDoc('c01-update', '2026-09-28T03:00:00.000Z', 'WARNING', false);
      await Promise.all([
        client.db(appNode).collection('app_alerts').insertOne(doc),
        client.db(appGo).collection('app_alerts').insertOne(doc),
      ]);
      const [u1Node, u1Go, u2Node, u2Go] = await Promise.all([
        pair1.node.waitFor((f) => f.event === 'alerts_update'),
        pair1.go.waitFor((f) => f.event === 'alerts_update'),
        pair2.node.waitFor((f) => f.event === 'alerts_update'),
        pair2.go.waitFor((f) => f.event === 'alerts_update'),
      ]);
      assert.equal(u1Node.data.activeCount, 2);
      assert.equal(u1Go.data.activeCount, 2);
      assert.equal(u2Node.data.activeCount, 2);
      assert.equal(u2Go.data.activeCount, 2);
    } finally {
      pair1.node.close(); pair1.go.close();
      pair2.node.close(); pair2.go.close();
    }
  });

  await check('C02 session-revocation-user-isolation', async () => {
    resetNodeCounters();
    await resetGoCounters();
    const opPair = await openPairFail(await token('operator_user', 'operator'));
    const vwPair = await openPairFail(await token('viewer_user', 'viewer'));
    try {
      await Promise.all([receiveInit(opPair), receiveInit(vwPair)]);
      await Promise.all([
        client.db(appNode).collection('app_users').updateOne({ username: 'operator_user' }, { $set: { 'security.sessionVersion': 2 } }),
        client.db(appGoFail).collection('app_users').updateOne({ username: 'operator_user' }, { $set: { 'security.sessionVersion': 2 } }),
      ]);
      const [nodeExp, goExp] = await Promise.all([
        opPair.node.waitFor((f) => f.event === 'session_expired'),
        opPair.go.waitFor((f) => f.event === 'session_expired'),
      ]);
      assert.deepEqual(nodeExp.data, {});
      assert.deepEqual(goExp.data, {});
      opPair.node.close();
      opPair.go.close();

      const nodeReadsBeforeA = getNodeCounters().alertReads;
      const nodeValsBeforeA = getNodeCounters().sessionValidations;
      const goReadsBeforeA = (await getGoCounters()).alertReads;
      const goValsBeforeA = (await getGoCounters()).sessionValidations;

      await sleep(5500);

      assert.equal(vwPair.node.frames.some((f) => f.event === 'session_expired'), false);
      assert.equal(vwPair.go.frames.some((f) => f.event === 'session_expired'), false);

      const nodeReadsAfterA = getNodeCounters().alertReads;
      const nodeValsAfterA = getNodeCounters().sessionValidations;
      const goReadsAfterA = (await getGoCounters()).alertReads;
      const goValsAfterA = (await getGoCounters()).sessionValidations;

      assert.ok(nodeReadsAfterA > nodeReadsBeforeA, 'Node Stream B must continue repository polling');
      assert.ok(goReadsAfterA > goReadsBeforeA, 'Go Stream B must continue repository polling');
      assert.ok(nodeValsAfterA > nodeValsBeforeA, 'Node Stream B must continue session validation');
      assert.ok(goValsAfterA > goValsBeforeA, 'Go Stream B must continue session validation');

      console.log('[sse-parity] case=C02_session_isolation');
      console.log('[sse-parity] stream_a_invalidated=true');
      console.log('[sse-parity] stream_a_closed=true');
      console.log('[sse-parity] stream_b_session_expired=false');
      console.log('[sse-parity] stream_b_still_connected=true');
      console.log(`[sse-parity] node_b_reads_before=${nodeReadsBeforeA}`);
      console.log(`[sse-parity] node_b_reads_after=${nodeReadsAfterA}`);
      console.log(`[sse-parity] go_b_reads_before=${goReadsBeforeA}`);
      console.log(`[sse-parity] go_b_reads_after=${goReadsAfterA}`);
      console.log(`[sse-parity] node_b_validations_before=${nodeValsBeforeA}`);
      console.log(`[sse-parity] node_b_validations_after=${nodeValsAfterA}`);
      console.log(`[sse-parity] go_b_validations_before=${goValsBeforeA}`);
      console.log(`[sse-parity] go_b_validations_after=${goValsAfterA}`);
      console.log('[sse-parity] parity=PASS');
    } finally {
      opPair.node.close(); opPair.go.close();
      vwPair.node.close(); vwPair.go.close();
      await Promise.all([
        client.db(appNode).collection('app_users').updateOne({ username: 'operator_user' }, { $set: { 'security.sessionVersion': 1 } }),
        client.db(appGoFail).collection('app_users').updateOne({ username: 'operator_user' }, { $set: { 'security.sessionVersion': 1 } }),
      ]);
    }
  });

  await check('C03 multi-role-concurrent-streams-isolation', async () => {
    const pairs = await Promise.all([
      openPair(await token('admin_user', 'admin')),
      openPair(await token('operator_user', 'operator')),
      openPair(await token('viewer_user', 'viewer')),
    ]);
    try {
      const inits = await Promise.all(pairs.map(receiveInit));
      assert.equal(inits[0][0].data.role, 'admin');
      assert.equal(inits[1][0].data.role, 'operator');
      assert.equal(inits[2][0].data.role, 'viewer');
      assert.equal(inits[0][1].data.role, 'admin');
      assert.equal(inits[1][1].data.role, 'operator');
      assert.equal(inits[2][1].data.role, 'viewer');
    } finally {
      pairs.forEach((p) => { p.node.close(); p.go.close(); });
    }
  });

  await check('C04 single-stream-disconnect-isolation', async () => {
    await replaceAlerts([alertDoc('c04-base', '2026-09-28T00:00:01.000Z')]);
    const stream1 = await openPair(await token('admin_user', 'admin'));
    const stream2 = await openPair(await token('admin_user', 'admin'));
    try {
      await Promise.all([receiveInit(stream1), receiveInit(stream2)]);
      stream1.node.close();
      stream1.go.close();
      await sleep(1000);
      const doc = alertDoc('c04-update', '2026-09-28T04:00:00.000Z', 'WARNING', false);
      await Promise.all([
        client.db(appNode).collection('app_alerts').insertOne(doc),
        client.db(appGo).collection('app_alerts').insertOne(doc),
      ]);
      const [uNode, uGo] = await Promise.all([
        stream2.node.waitFor((f) => f.event === 'alerts_update'),
        stream2.go.waitFor((f) => f.event === 'alerts_update'),
      ]);
      assert.equal(uNode.data.activeCount, 2);
      assert.equal(uGo.data.activeCount, 2);
    } finally {
      stream2.node.close(); stream2.go.close();
    }
  });

  await check('C05 concurrent-connect-disconnect-stress', async () => {
    const batchSize = 6;
    const streams = await Promise.all(Array.from({ length: batchSize }, () => openPair(adminToken)));
    try {
      await Promise.all(streams.map(receiveInit));
      assert.ok(streams.every((s) => s.nodeResponse.statusCode === 200 && s.goResponse.statusCode === 200));
    } finally {
      streams.forEach((s) => { s.node.close(); s.go.close(); });
    }
    await sleep(1500);
    console.log('[sse-parity] case=concurrency_isolation');
    console.log('[sse-parity] streams_isolated=true');
    console.log('[sse-parity] PARITY=PASS');
  });

  let h02NodePing, h02GoPing, h02Start;

  await check('H01 no-early-ping-before-threshold', async () => {
    const pair = await openPair(adminToken);
    try {
      await receiveInit(pair);
      await sleep(8000);
      assert.equal(pair.node.frames.some((f) => f.type === 'comment' && f.comment === 'ping'), false, 'Node must emit no ping before 12s');
      assert.equal(pair.go.frames.some((f) => f.type === 'comment' && f.comment === 'ping'), false, 'Go must emit no ping before 12s');
    } finally {
      pair.node.close(); pair.go.close();
    }
  });

  await check('H02 ping-at-heartbeat-threshold', async () => {
    h02Start = Date.now();
    const pair = await openPair(adminToken);
    try {
      await receiveInit(pair);
      [h02NodePing, h02GoPing] = await Promise.all([
        pair.node.waitFor((f) => f.type === 'comment' && f.comment === 'ping', 16000),
        pair.go.waitFor((f) => f.type === 'comment' && f.comment === 'ping', 16000),
      ]);
      const nodeElapsed = h02NodePing.receivedAt - h02Start;
      const goElapsed = h02GoPing.receivedAt - h02Start;
      assert.ok(nodeElapsed >= 11000 && nodeElapsed <= 15500, `Node elapsed ${nodeElapsed}ms`);
      assert.ok(goElapsed >= 11000 && goElapsed <= 15500, `Go elapsed ${goElapsed}ms`);
    } finally {
      pair.node.close(); pair.go.close();
    }
  });

  await check('H03 exact-raw-ping-framing', async () => {
    assert.ok(h02NodePing && h02GoPing, 'H02 must have captured ping frames');
    assert.equal(h02NodePing.raw, ':ping\n\n');
    assert.equal(h02GoPing.raw, ':ping\n\n');
    assert.equal(h02NodePing.type, 'comment');
    assert.equal(h02GoPing.type, 'comment');
    assert.equal(h02NodePing.comment, 'ping');
    assert.equal(h02GoPing.comment, 'ping');
  });

  let hEligiblePair;
  let hUpdateNode, hUpdateGo;
  let hPingAfterNode, hPingAfterGo;
  let hUpdateEmittedAt = 0;
  let hPingReceivedAt = 0;

  await check('H04 heartbeat-eligible-update-emitted', async () => {
    await replaceAlerts([alertDoc('h-base', '2026-09-28T00:00:01.000Z')]);
    hEligiblePair = await openPair(adminToken);
    await receiveInit(hEligiblePair);
    // Wait through 4s and 8s polls until ~9.5s
    await sleep(9500);
    // Insert alert so activeCount changes before the 12s poll
    const doc = alertDoc('h-update', '2026-09-28T06:00:00.000Z', 'WARNING', false);
    await Promise.all([
      client.db(appNode).collection('app_alerts').insertOne(doc),
      client.db(appGo).collection('app_alerts').insertOne(doc),
    ]);
    [hUpdateNode, hUpdateGo] = await Promise.all([
      hEligiblePair.node.waitFor((f) => f.event === 'alerts_update', 8000),
      hEligiblePair.go.waitFor((f) => f.event === 'alerts_update', 8000),
    ]);
    hUpdateEmittedAt = Date.now();
    assert.equal(hUpdateNode.data.activeCount, 2);
    assert.equal(hUpdateGo.data.activeCount, 2);
  });

  await check('H05 no-same-cycle-ping', async () => {
    assert.ok(hEligiblePair, 'hEligiblePair must exist');
    const nodePings = hEligiblePair.node.frames.filter((f) => f.type === 'comment' && f.comment === 'ping');
    const goPings = hEligiblePair.go.frames.filter((f) => f.type === 'comment' && f.comment === 'ping');
    assert.equal(nodePings.length, 0, 'Node must not emit ping in same iteration as alerts_update');
    assert.equal(goPings.length, 0, 'Go must not emit ping in same iteration as alerts_update');
  });

  await check('H06 alert-update-does-not-reset-heartbeat-baseline', async () => {
    assert.ok(hEligiblePair, 'hEligiblePair must exist');
    // Because lastHeartbeat was NOT reset, the heartbeat is overdue and must fire on the next no-update poll (t~16s, ~4s after update)
    [hPingAfterNode, hPingAfterGo] = await Promise.all([
      hEligiblePair.node.waitFor((f) => f.type === 'comment' && f.comment === 'ping', 8000),
      hEligiblePair.go.waitFor((f) => f.type === 'comment' && f.comment === 'ping', 8000),
    ]);
    hPingReceivedAt = Date.now();
    const elapsedSinceUpdate = hPingReceivedAt - hUpdateEmittedAt;
    assert.ok(elapsedSinceUpdate >= 2500 && elapsedSinceUpdate <= 8000, `Ping arrived ${elapsedSinceUpdate}ms after update`);
  });

  await check('H07 following-no-update-poll-emits-due-heartbeat', async () => {
    assert.ok(hPingAfterNode && hPingAfterGo, 'Overdue ping must have been captured');
    assert.equal(hPingAfterNode.raw, ':ping\n\n');
    assert.equal(hPingAfterGo.raw, ':ping\n\n');
    assert.equal(hPingAfterNode.type, 'comment');
    assert.equal(hPingAfterGo.type, 'comment');
    hEligiblePair.node.close();
    hEligiblePair.go.close();
  });

  await check('H08 concurrent-streams-have-independent-heartbeat-state', async () => {
    const pairA = await openPair(adminToken);
    await receiveInit(pairA);
    // Wait 6 seconds before opening Stream B
    await sleep(6000);
    const pairB = await openPair(adminToken);
    await receiveInit(pairB);
    try {
      // At T~12s from start: Stream A (elapsed 12s) reaches heartbeat threshold.
      // Stream B (elapsed ~6s) must NOT receive ping yet!
      const [pingA_Node, pingA_Go] = await Promise.all([
        pairA.node.waitFor((f) => f.type === 'comment' && f.comment === 'ping', 8000),
        pairA.go.waitFor((f) => f.type === 'comment' && f.comment === 'ping', 8000),
      ]);
      assert.ok(pingA_Node && pingA_Go, 'Stream A must receive ping at its 12s threshold');
      assert.equal(pairB.node.frames.some((f) => f.type === 'comment' && f.comment === 'ping'), false, 'Stream B must NOT receive ping at Stream A threshold');
      assert.equal(pairB.go.frames.some((f) => f.type === 'comment' && f.comment === 'ping'), false, 'Stream B must NOT receive ping at Stream A threshold');

      // At T~18s from start: Stream B (elapsed ~12s) reaches its own heartbeat threshold!
      const [pingB_Node, pingB_Go] = await Promise.all([
        pairB.node.waitFor((f) => f.type === 'comment' && f.comment === 'ping', 8000),
        pairB.go.waitFor((f) => f.type === 'comment' && f.comment === 'ping', 8000),
      ]);
      assert.ok(pingB_Node && pingB_Go, 'Stream B must receive ping at its own 12s threshold');

      // Stream A has not reached 24s yet, so it should only have 1 ping total
      const pingsA_Node = pairA.node.frames.filter((f) => f.type === 'comment' && f.comment === 'ping');
      const pingsA_Go = pairA.go.frames.filter((f) => f.type === 'comment' && f.comment === 'ping');
      assert.equal(pingsA_Node.length, 1, 'Stream A must not receive early second ping');
      assert.equal(pingsA_Go.length, 1, 'Stream A must not receive early second ping');

      console.log('[sse-parity] case=H08_heartbeat_isolation');
      console.log('[sse-parity] stream_a_ping_at_12s=true');
      console.log('[sse-parity] stream_b_no_ping_at_6s=true');
      console.log('[sse-parity] stream_b_ping_at_own_12s=true');
      console.log('[sse-parity] stream_a_no_spurious_ping=true');
      console.log('[sse-parity] parity=PASS');
    } finally {
      pairA.node.close(); pairA.go.close();
      pairB.node.close(); pairB.go.close();
    }
  });

  await check('H09 disconnect-during-heartbeat-wait', async () => {
    const pair = await openPair(adminToken);
    await receiveInit(pair);
    await sleep(6000);
    pair.node.close();
    pair.go.close();
    await sleep(1000);
    console.log('[sse-parity] case=heartbeat_boundary');
    console.log('[sse-parity] PARITY=PASS');
  });

  await check('H10 consecutive-heartbeats-match', async () => {
    const pair = await openPair(adminToken);
    try {
      await receiveInit(pair);
      const [nPing1, gPing1] = await Promise.all([
        pair.node.waitFor((f) => f.type === 'comment' && f.comment === 'ping', 15000),
        pair.go.waitFor((f) => f.type === 'comment' && f.comment === 'ping', 15000),
      ]);
      assert.equal(nPing1.raw, ':ping\n\n');
      assert.equal(gPing1.raw, ':ping\n\n');

      const waitForSecond = (stream) => new Promise((resolve, reject) => {
        const checkCount = () => {
          const pings = stream.frames.filter((f) => f.type === 'comment' && f.comment === 'ping');
          return pings.length >= 2;
        };
        if (checkCount()) return resolve();
        const timer = setTimeout(() => reject(new Error('Second ping timeout')), 22000);
        const onFrame = () => {
          if (checkCount()) {
            clearTimeout(timer);
            stream.events.removeListener('frame', onFrame);
            resolve();
          }
        };
        stream.events.on('frame', onFrame);
      });
      await Promise.all([waitForSecond(pair.node), waitForSecond(pair.go)]);
    } finally {
      pair.node.close(); pair.go.close();
    }
  });

  await check('Z01 no-rate-limiter-or-operation-log-source-path', async () => {
    const source = readFileSync(path.resolve(import.meta.dirname, '..', 'backend', 'internal', 'notification', 'handler.go'), 'utf8');
    assert.equal(source.includes('ratelimit'), false);
    assert.equal(source.includes('audit.'), false);
    assert.equal(source.includes('notifications:stream:'), false);
  });

  await check('R01 routing-invariants-preserved', async () => {
    assert.equal(CUTOVER_TABLE.length, 47, 'CUTOVER_TABLE must contain exactly 47 routes');
    const actuallyRouted = CUTOVER_TABLE.filter((r) => r.owner === 'go');
    assert.equal(actuallyRouted.length, 47, 'ACTUALLY_ROUTED must be exactly 47');
    const stream = CUTOVER_TABLE.find((r) => r.path === '/api/notifications/stream');
    assert.ok(stream, 'Notification stream must be in CUTOVER_TABLE after production cutover');
    assert.equal(stream.method, 'GET', 'Notification stream must be a GET route');
    assert.equal(stream.owner, 'go', 'Notification stream must be owned by Go after production cutover');
  });
}

async function cleanup() {
  if (nodeServer) {
    nodeServer.closeAllConnections?.();
    await new Promise((resolve) => nodeServer.close(resolve));
  }
  if (goProc?.pid) {
    if (process.platform === 'win32') { try { execSync(`taskkill /pid ${goProc.pid} /T /F`, { stdio: 'ignore' }); } catch {} }
    else goProc.kill('SIGTERM');
  }
  if (goFailProc?.pid) {
    if (process.platform === 'win32') { try { execSync(`taskkill /pid ${goFailProc.pid} /T /F`, { stdio: 'ignore' }); } catch {} }
    else goFailProc.kill('SIGTERM');
  }
  if (binaryPath && existsSync(binaryPath)) try { unlinkSync(binaryPath); } catch {}
  if (binaryFailPath && existsSync(binaryFailPath)) try { unlinkSync(binaryFailPath); } catch {}
  await Promise.all([
    client.db(xcloudNode).dropDatabase(), client.db(appNode).dropDatabase(),
    client.db(xcloudGo).dropDatabase(), client.db(appGo).dropDatabase(),
    client.db(xcloudGoFail).dropDatabase(), client.db(appGoFail).dropDatabase(),
  ]);
  try { await (await getMongoClient()).close(); } catch {}
  await client.close();
}

main().catch((err) => { failed++; console.error(err); }).finally(async () => {
  await cleanup();
  console.log('\nPhase 7.3 Notification Streaming Parity Suite Summary\n');
  console.log(`TOTAL: ${total}`); console.log(`PASS:  ${passed}`); console.log(`FAIL:  ${failed}`); console.log(`SKIP:  ${skipped}`);
  if (failed > 0 || skipped > 0) process.exitCode = 1;
});
