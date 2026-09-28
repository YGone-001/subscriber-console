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
const xcloudNode = `xcloud_p73_node_${suffix}`;
const appNode = `xcloud_ops_p73_node_${suffix}`;
const xcloudGo = `xcloud_p73_go_${suffix}`;
const appGo = `xcloud_ops_p73_go_${suffix}`;
const secret = 'notification-stream-parity-secret-32bytes!';

process.env.JWT_SECRET = secret;
process.env.MONGODB_XCLOUD_DB = xcloudNode;
process.env.MONGODB_APP_DB = appNode;
nextEnv.loadEnvConfig(process.cwd());

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  alias: {
    '@': new URL('../frontend/src/', import.meta.url).pathname,
    'next/server': new URL('../frontend/node_modules/next/server.js', import.meta.url).pathname,
  },
});
const { NextRequest } = jiti('next/server');
const { GET: nodeStreamHandler } = jiti('../frontend/src/app/api/notifications/stream/route.ts');
const { validateCurrentAccount, AccountSessionError } = jiti('../frontend/src/lib/accountSession.ts');
const { getMongoClient } = jiti('../frontend/src/lib/mongo.ts');

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
let nodeServer;
let nodePort;
let goProc;
let goPort;
let binaryPath;
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
            const frame = { type: 'comment', comment: lines[0].slice(1), raw };
            frames.push(frame); events.emit('frame', frame);
            continue;
          }
          const event = lines.find((line) => line.startsWith('event: '))?.slice(7);
          const data = lines.find((line) => line.startsWith('data: '))?.slice(6);
          if (event && data !== undefined) {
            const frame = { type: 'event', event, data: JSON.parse(data), raw };
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
  return { connected, frames, waitFor, close: () => request.destroy() };
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
  throw new Error('Go server did not become ready');
}

function normalizedInit(frame) {
  const { timestamp, ...rest } = frame.data;
  assert.match(timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  return rest;
}

async function fingerprint(db, name) {
  const docs = await client.db(db).collection(name).find({}).sort({ _id: 1 }).toArray();
  return JSON.stringify(docs.map(({ _id, ...doc }) => doc));
}

async function main() {
  console.log('Phase 7.3 Notification Streaming Parity Suite');
  await client.connect();
  await seed(xcloudNode, appNode);
  await seed(xcloudGo, appGo);

  nodePort = await getAvailablePort();
  nodeServer = createNodeServer();
  await new Promise((resolve) => nodeServer.listen(nodePort, '127.0.0.1', resolve));
  goPort = await getAvailablePort();
  binaryPath = path.join(os.tmpdir(), `p73-stream-${suffix}${process.platform === 'win32' ? '.exe' : ''}`);
  execSync(`go build -o "${binaryPath}" ./cmd/server`, { cwd: path.resolve(import.meta.dirname, '..', 'backend'), stdio: 'inherit' });
  goProc = spawn(binaryPath, [], {
    env: { ...process.env, HTTP_ADDR: `127.0.0.1:${goPort}`, MONGODB_URI: uri, MONGODB_XCLOUD_DB: xcloudGo, MONGODB_APP_DB: appGo, JWT_SECRET: secret, HTTP_WRITE_TIMEOUT: '2s' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  await waitForReady(`http://127.0.0.1:${goPort}`);

  const nodeBase = `http://127.0.0.1:${nodePort}`;
  const goBase = `http://127.0.0.1:${goPort}`;
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
      [appNode, 'app_profiles'], [appNode, 'app_profile_versions'], [appNode, 'app_audit_logs'], [appNode, 'app_rate_limits'],
      [xcloudGo, 'subscribers'], [xcloudGo, 'ocs_tariff_plans'], [xcloudGo, 'ocs_subscribers'], [xcloudGo, 'ocs_balances'], [xcloudGo, 'ocs_sessions'], [xcloudGo, 'ocs_reservations'], [xcloudGo, 'ocs_usage_records'],
      [appGo, 'app_profiles'], [appGo, 'app_profile_versions'], [appGo, 'app_audit_logs'], [appGo, 'app_rate_limits'],
    ];
    const before = await Promise.all(protectedCollections.map(([db, name]) => fingerprint(db, name)));
    const beforeAlerts = await Promise.all([fingerprint(appNode, 'app_alerts'), fingerprint(appGo, 'app_alerts')]);
    const authToken = await token('admin_user', 'admin');
    const node = openSSE(nodeBase, authToken); const go = openSSE(goBase, authToken);
    await Promise.all([node.connected, go.connected, node.waitFor((f) => f.event === 'init'), go.waitFor((f) => f.event === 'init')]);
    node.close(); go.close();
    const after = await Promise.all(protectedCollections.map(([db, name]) => fingerprint(db, name)));
    assert.deepEqual(after, before);
    assert.deepEqual(await Promise.all([fingerprint(appNode, 'app_alerts'), fingerprint(appGo, 'app_alerts')]), beforeAlerts);
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
  if (binaryPath && existsSync(binaryPath)) try { unlinkSync(binaryPath); } catch {}
  await Promise.all([client.db(xcloudNode).dropDatabase(), client.db(appNode).dropDatabase(), client.db(xcloudGo).dropDatabase(), client.db(appGo).dropDatabase()]);
  try { await (await getMongoClient()).close(); } catch {}
  await client.close();
}

main().catch((err) => { failed++; console.error(err); }).finally(async () => {
  await cleanup();
  console.log('\nPhase 7.3 Notification Streaming Parity Suite Summary\n');
  console.log(`TOTAL: ${total}`); console.log(`PASS:  ${passed}`); console.log(`FAIL:  ${failed}`); console.log(`SKIP:  ${skipped}`);
  if (failed > 0 || skipped > 0) process.exitCode = 1;
});
