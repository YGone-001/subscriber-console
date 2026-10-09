#!/usr/bin/env node
/**
 * NF Discovery Integration Suite (deterministic, no live NRF).
 *
 * Runs against real MongoDB and a real Go backend with a local mock NRF that
 * speaks cleartext HTTP/2 (h2c prior knowledge) and speaks only the bounded
 * read-only 3GPP surfaces the adapter is allowed to call.
 *
 * Verifies:
 * - Production index initialization for the three discovery collections
 * - Source create / read / update with CAS revision
 * - Default-deny destination allowlist enforcement
 * - Strict JSON decoding of source create/update bodies
 * - Scan against the mock NRF normalizes both service shapes
 * - Failed scans never mark previously observed candidates missing
 * - Incomplete scans do not infer absence
 * - Link / unlink write discovery metadata only
 * - Viewer is read-only; operator and admin may mutate
 * - No generic fetch or NF control endpoint is exposed
 */

import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import http2 from 'node:http2';
import { execSync, spawn } from 'node:child_process';
import { SignJWT } from 'jose';
import { MongoClient } from 'mongodb';
import bcrypt from 'bcryptjs';
import { loadEnv } from './lib/load-env.mjs';

loadEnv(process.cwd());

const suffix = `${Date.now()}_${process.pid}_${Math.floor(Math.random() * 100000)}`;
const xcloudDbName = `xcloud_disc_test_${suffix}`;
const appDbName = `xcloud_ops_disc_test_${suffix}`;
const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/xcloud';

process.env.MONGODB_XCLOUD_DB = xcloudDbName;
process.env.MONGODB_APP_DB = appDbName;
const JWT_SECRET_STRING = process.env.JWT_SECRET || 'nf-discovery-test-secret-at-least-32-bytes-long!';
process.env.JWT_SECRET = JWT_SECRET_STRING;

const jwtSecretKey = () => new TextEncoder().encode(String(process.env.JWT_SECRET || '').trim());

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

function makeToken(username, role, sv = 1) {
  return new SignJWT({ username, role, sv })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt(Math.floor(Date.now() / 1000))
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(jwtSecretKey());
}

let goProc = null;
let binPath = null;
let mockServer = null;
let passed = 0;
let totalChecks = 0;

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

const AMF_ID = '3301e63a-c3b7-41f1-a512-9f6322e6f4c2';
const UDM_ID = '2fdd9616-c3b7-41f1-9e90-c1bf0278f435';

// Mutable mock mode. The Go client keeps one h2c session open, so rebuilding the
// server on the same port would leave the old handler answering. Switch behavior
// in place instead of replacing the listener.
const mockMode = { failScan: false, emptyScan: false };

async function seedObservations(obsColl, sourceId, idPrefix, now) {
  await obsColl.insertMany([
    {
      _id: `${idPrefix}-1`,
      schemaVersion: 1,
      sourceId,
      adapterType: 'nrf',
      externalNfInstanceId: AMF_ID,
      nfType: 'AMF',
      nfStatus: 'REGISTERED',
      observedEndpoints: [],
      observedServices: [],
      firstSeenAt: now,
      lastSeenAt: now,
      observationState: 'seen',
      linkedResourceId: null,
      revision: 1,
    },
    {
      _id: `${idPrefix}-2`,
      schemaVersion: 1,
      sourceId,
      adapterType: 'nrf',
      externalNfInstanceId: UDM_ID,
      nfType: 'UDM',
      nfStatus: 'REGISTERED',
      observedEndpoints: [],
      observedServices: [],
      firstSeenAt: now,
      lastSeenAt: now,
      observationState: 'seen',
      linkedResourceId: null,
      revision: 1,
    },
  ]);
}

function buildMockNRF(mode) {
  const server = http2.createServer();
  server.on('stream', (stream, headers) => {
    const method = headers[':method'];
    const pathName = headers[':path'];
    const send = (status, payload) => {
      const body = JSON.stringify(payload);
      stream.respond({
        ':status': status,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      });
      stream.end(body);
    };
    if (method !== 'GET') {
      send(405, { error: 'method not allowed' });
      return;
    }
    if (mode.failScan) {
      send(503, { error: 'unavailable' });
      return;
    }
    if (pathName === '/nnrf-nfm/v1/nf-instances') {
      if (mode.emptyScan) {
        send(200, { _links: { self: { href: '/nnrf-nfm/v1/nf-instances' } }, totalItemCount: 0 });
        return;
      }
      send(200, {
        _links: {
          self: { href: '/nnrf-nfm/v1/nf-instances' },
          item: [
            { href: `/nnrf-nfm/v1/nf-instances/${AMF_ID}` },
            { href: `/nnrf-nfm/v1/nf-instances/${UDM_ID}` },
          ],
        },
        totalItemCount: 2,
      });
      return;
    }
    if (pathName === `/nnrf-nfm/v1/nf-instances/${AMF_ID}`) {
      send(200, {
        nfInstanceId: AMF_ID,
        nfType: 'AMF',
        nfStatus: 'REGISTERED',
        heartBeatTimer: 10,
        ipv4Addresses: ['127.0.0.5'],
        nfServiceList: {
          'svc-1': {
            serviceName: 'namf-comm',
            nfServiceStatus: 'REGISTERED',
            scheme: 'http',
            ipEndPoints: [{ ipv4Address: '127.0.0.5', port: 7777 }],
          },
        },
      });
      return;
    }
    if (pathName === `/nnrf-nfm/v1/nf-instances/${UDM_ID}`) {
      send(200, {
        nfInstanceId: UDM_ID,
        nfType: 'UDM',
        nfStatus: 'REGISTERED',
        ipv4Addresses: ['127.0.0.12'],
        nfServices: [
          { serviceInstanceId: 'svc-2', serviceName: 'nudm-ueau', nfServiceStatus: 'REGISTERED', scheme: 'http' },
        ],
      });
      return;
    }
    send(404, { error: 'not found' });
  });
  return server;
}

async function main() {
  console.log('== NF Discovery Integration Suite ==\n');

  try {
    await client.connect();

    const xcloudDb = client.db(xcloudDbName);
    const appDb = client.db(appDbName);
    const usersColl = appDb.collection('app_users');
    const inventoryColl = appDb.collection('app_inventory_resources');
    const sourcesColl = appDb.collection('app_discovery_sources');
    const runsColl = appDb.collection('app_discovery_runs');
    const obsColl = appDb.collection('app_nf_observations');

    const initScriptPath = path.resolve(import.meta.dirname, 'init-mongo-indexes.mjs');
    execSync(`node "${initScriptPath}"`, {
      env: {
        ...process.env,
        MONGODB_URI: uri,
        MONGODB_XCLOUD_DB: xcloudDbName,
        MONGODB_APP_DB: appDbName,
      },
      stdio: 'ignore',
    });

    const now = new Date().toISOString();
    const hash = await bcrypt.hash('CorrectPass123!', 10);
    const userTemplate = (username, role) => ({
      username,
      passwordHash: hash,
      displayName: username,
      email: `${username}@example.com`,
      role,
      status: 'active',
      locked: false,
      failedLoginAttempts: 0,
      sessionVersion: 1,
      security: { sessionVersion: 1 },
      createdAt: now,
      updatedAt: now,
      createdBy: 'bootstrap',
      updatedBy: 'bootstrap',
    });
    await usersColl.insertMany([
      userTemplate('admin1', 'admin'),
      userTemplate('operator1', 'operator'),
      userTemplate('viewer1', 'viewer'),
    ]);

    // Inventory fixtures stay authoritative and are never written by discovery.
    const resourceId = '11111111-2222-4333-8444-000000000001';
    const retiredId = '11111111-2222-4333-8444-000000000002';
    await inventoryColl.insertMany([
      {
        _id: resourceId,
        schemaVersion: 1,
        kind: 'network_function',
        name: 'amf-01',
        nameNormalized: 'amf-01',
        displayName: 'amf-01',
        domain: '5gc',
        role: 'nf',
        lifecycleState: 'active',
        source: { kind: 'manual', system: 'xcloud', authority: 'authoritative' },
        revision: 1,
        createdAt: now,
        createdBy: 'fixture',
        updatedAt: now,
        updatedBy: 'fixture',
      },
      {
        _id: retiredId,
        schemaVersion: 1,
        kind: 'network_function',
        name: 'old-udm',
        nameNormalized: 'old-udm',
        displayName: 'old-udm',
        domain: '5gc',
        role: 'nf',
        lifecycleState: 'retired',
        source: { kind: 'manual', system: 'xcloud', authority: 'authoritative' },
        revision: 1,
        createdAt: now,
        createdBy: 'fixture',
        updatedAt: now,
        updatedBy: 'fixture',
      },
    ]);

    // Mock NRF (h2c)
    const mockPort = await getAvailablePort();
    mockServer = buildMockNRF(mockMode);
    await new Promise((resolve, reject) => {
      mockServer.listen(mockPort, '127.0.0.1', resolve);
      mockServer.on('error', reject);
    });

    // Go backend with default-deny allowlist, then a second boot is not needed:
    // the allowlist is fixed at startup, so it must include the mock destination.
    const goPort = await getAvailablePort();
    const isWin = process.platform === 'win32';
    const binName = isWin ? `test-go-disc-${suffix}.exe` : `test-go-disc-${suffix}`;
    const backendDir = path.resolve(import.meta.dirname, '..', 'backend');
    binPath = path.join(backendDir, binName);
    execSync(`go build -o "${binPath}" ./cmd/server`, { cwd: backendDir, stdio: 'ignore' });

    goProc = spawn(binPath, [], {
      cwd: backendDir,
      env: {
        ...process.env,
        HTTP_ADDR: `127.0.0.1:${goPort}`,
        MONGODB_URI: uri,
        MONGODB_XCLOUD_DB: xcloudDbName,
        MONGODB_APP_DB: appDbName,
        JWT_SECRET: JWT_SECRET_STRING,
        DISCOVERY_ALLOWED_TARGETS: `127.0.0.1:${mockPort},127.0.0.11:${mockPort}`,
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
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    if (!goReady) throw new Error('Go server failed to start on ' + goPort);

    const adminToken = await makeToken('admin1', 'admin');
    const operatorToken = await makeToken('operator1', 'operator');
    const viewerToken = await makeToken('viewer1', 'viewer');

    const req = async (method, p, body, token, rawBody = null) => {
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers['Cookie'] = `auth_token=${token}`;
      const init = { method, headers };
      if (rawBody !== null) init.body = rawBody;
      else if (body !== undefined) init.body = JSON.stringify(body);
      const res = await fetch(`http://127.0.0.1:${goPort}${p}`, init);
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
      return { status: res.status, body: json };
    };

    const baseUrl = `http://127.0.0.1:${mockPort}`;

    // 1. Collections and indexes
    await verifyAsync('three discovery collections live in xcloud_ops only', async () => {
      const opsColls = (await appDb.listCollections().toArray()).map((c) => c.name);
      for (const name of ['app_discovery_sources', 'app_discovery_runs', 'app_nf_observations']) {
        assert.ok(opsColls.includes(name), `${name} must exist in xcloud_ops`);
      }
      const xcloudColls = (await xcloudDb.listCollections().toArray()).map((c) => c.name);
      assert.ok(!xcloudColls.some((c) => c.includes('discovery') || c.includes('nf_obs')), 'no discovery collection may exist in xcloud');
      assert.ok(!opsColls.includes('app_discovery_candidates'), 'candidate store must be app_nf_observations');
    });

    await verifyAsync('observation uniqueness index exists on (sourceId, externalNfInstanceId)', async () => {
      const indexes = await obsColl.indexes();
      const uniq = indexes.find((idx) => idx.name === 'uniq_nf_observation_source_instance');
      assert.ok(uniq, 'uniq_nf_observation_source_instance must exist');
      assert.equal(uniq.unique, true);
    });

    // 2. Meta
    await verifyAsync('meta exposes the neutral adapter vocabulary and bounds', async () => {
      const res = await req('GET', '/api/discovery/meta', undefined, viewerToken);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.adapterTypes, ['nrf']);
      assert.ok(res.body.observationStates.includes('seen'));
      assert.ok(res.body.minScanIntervalSeconds >= 60);
    });

    // 3. Allowlist default deny
    await verifyAsync('source create is rejected when the destination is not allowlisted', async () => {
      const res = await req('POST', '/api/discovery/sources', {
        name: 'blocked',
        adapterType: 'nrf',
        baseUrl: 'http://127.0.0.12:7777',
        transportMode: 'h2c',
      }, adminToken);
      assert.equal(res.status, 403);
      assert.equal(res.body.code, 'DISCOVERY_TARGET_NOT_ALLOWED');
    });

    // 4. Strict JSON
    await verifyAsync('unknown fields and trailing JSON are rejected', async () => {
      const unknown = await req('POST', '/api/discovery/sources', undefined, adminToken,
        JSON.stringify({ name: 'x', adapterType: 'nrf', baseUrl, transportMode: 'h2c', evil: true }));
      assert.equal(unknown.status, 400);
      const trailing = await req('POST', '/api/discovery/sources', undefined, adminToken,
        JSON.stringify({ name: 'x', adapterType: 'nrf', baseUrl, transportMode: 'h2c' }) + '{"a":1}');
      assert.equal(trailing.status, 400);
    });

    // 5. Viewer read-only
    await verifyAsync('viewer cannot create a discovery source', async () => {
      const res = await req('POST', '/api/discovery/sources', {
        name: 'lab-nrf',
        adapterType: 'nrf',
        baseUrl,
        transportMode: 'h2c',
      }, viewerToken);
      assert.equal(res.status, 403);
    });

    // 6. Create source
    let sourceId = null;
    await verifyAsync('operator creates an allowlisted discovery source', async () => {
      const res = await req('POST', '/api/discovery/sources', {
        name: 'lab-nrf',
        adapterType: 'nrf',
        baseUrl,
        transportMode: 'h2c',
        enabled: true,
      }, operatorToken);
      assert.equal(res.status, 201);
      assert.equal(res.body.adapterType, 'nrf');
      assert.equal(res.body.enabled, true);
      assert.equal(res.body.revision, 1);
      sourceId = res.body.sourceId;
      assert.ok(sourceId);
    });

    // 7. CAS update
    await verifyAsync('source update requires expectedRevision and rejects stale revisions', async () => {
      const ok = await req('PUT', `/api/discovery/sources/${sourceId}`, {
        expectedRevision: 1,
        source: { name: 'lab-nrf', baseUrl, transportMode: 'h2c', enabled: true },
      }, operatorToken);
      assert.equal(ok.status, 200);
      assert.equal(ok.body.revision, 2);

      const stale = await req('PUT', `/api/discovery/sources/${sourceId}`, {
        expectedRevision: 1,
        source: { name: 'lab-nrf', baseUrl, transportMode: 'h2c', enabled: true },
      }, operatorToken);
      assert.equal(stale.status, 409);
      assert.equal(stale.body.code, 'DISCOVERY_REVISION_CONFLICT');
    });

    // 8. Successful scan normalizes both service shapes
    await verifyAsync('scan observes candidates from the mock NRF and normalizes both service shapes', async () => {
      const res = await req('POST', `/api/discovery/sources/${sourceId}/scan`, {}, operatorToken);
      assert.equal(res.status, 200);
      assert.equal(res.body.run.status, 'success');
      assert.equal(res.body.run.discoveredCount, 2);

      const list = await req('GET', `/api/discovery/candidates?sourceId=${sourceId}`, undefined, viewerToken);
      assert.equal(list.status, 200);
      assert.equal(list.body.candidates.length, 2);
      const amf = list.body.candidates.find((c) => c.externalNfInstanceId === AMF_ID);
      const udm = list.body.candidates.find((c) => c.externalNfInstanceId === UDM_ID);
      assert.ok(amf && udm);
      assert.equal(amf.observationState, 'seen');
      assert.equal(udm.observationState, 'seen');
      assert.ok(amf.observedServices.some((s) => s.serviceName === 'namf-comm'));
      assert.ok(udm.observedServices.some((s) => s.serviceName === 'nudm-ueau'));
      assert.ok(amf.observedEndpoints.some((e) => e.address === '127.0.0.5' && e.port === 7777));
    });

    // 9. Link metadata only
    await verifyAsync('link writes discovery metadata only and never mutates inventory', async () => {
      const list = await req('GET', `/api/discovery/candidates?sourceId=${sourceId}`, undefined, viewerToken);
      const amf = list.body.candidates.find((c) => c.externalNfInstanceId === AMF_ID);
      const inventoryBefore = await inventoryColl.findOne({ _id: resourceId });

      const linked = await req('POST', `/api/discovery/candidates/${amf.candidateId}/link`, {
        expectedRevision: amf.revision,
        resourceId,
      }, operatorToken);
      assert.equal(linked.status, 200);
      assert.equal(linked.body.linkedResourceId, resourceId);

      const inventoryAfter = await inventoryColl.findOne({ _id: resourceId });
      assert.deepEqual(inventoryBefore, inventoryAfter, 'inventory document must be unchanged');

      const retired = await req('POST', `/api/discovery/candidates/${list.body.candidates.find((c) => c.externalNfInstanceId === UDM_ID).candidateId}/link`, {
        expectedRevision: list.body.candidates.find((c) => c.externalNfInstanceId === UDM_ID).revision,
        resourceId: retiredId,
      }, operatorToken);
      assert.equal(retired.status, 409);
      assert.equal(retired.body.code, 'DISCOVERY_INVENTORY_LINK_CONFLICT');
    });

    await verifyAsync('unlink clears discovery metadata only', async () => {
      const list = await req('GET', `/api/discovery/candidates?sourceId=${sourceId}`, undefined, viewerToken);
      const amf = list.body.candidates.find((c) => c.externalNfInstanceId === AMF_ID);
      const inventoryBefore = await inventoryColl.findOne({ _id: resourceId });
      const unlinked = await req('POST', `/api/discovery/candidates/${amf.candidateId}/unlink`, {
        expectedRevision: amf.revision,
      }, operatorToken);
      assert.equal(unlinked.status, 200);
      assert.equal(unlinked.body.linkedResourceId, null);
      const inventoryAfter = await inventoryColl.findOne({ _id: resourceId });
      assert.deepEqual(inventoryBefore, inventoryAfter);
    });

    // 10. Failed scan retains observations and does not mark missing.
    // Prior observations are seeded directly in the isolated test database so the
    // production per-source scan interval is never bypassed or weakened.
    await verifyAsync('failed scan retains observations and never infers missing', async () => {
      const created = await req('POST', '/api/discovery/sources', {
        name: 'lab-nrf-fail',
        adapterType: 'nrf',
        baseUrl,
        transportMode: 'h2c',
        enabled: true,
      }, operatorToken);
      assert.equal(created.status, 201);
      const failSourceId = created.body.sourceId;

      await seedObservations(obsColl, failSourceId, 'cand-fail', now);

      mockMode.failScan = true;
      try {
        const res = await req('POST', `/api/discovery/sources/${failSourceId}/scan`, {}, operatorToken);
        assert.notEqual(res.status, 200);
        assert.notEqual(res.body.run?.status, 'success');

        const list = await req('GET', `/api/discovery/candidates?sourceId=${failSourceId}`, undefined, viewerToken);
        assert.equal(list.body.candidates.length, 2);
        for (const candidate of list.body.candidates) {
          assert.notEqual(candidate.observationState, 'missing', 'failed scans must not mark missing');
          assert.equal(candidate.observationState, 'seen');
        }
      } finally {
        mockMode.failScan = false;
      }
    });

    // 11. Empty complete scan may mark missing
    await verifyAsync('complete empty scan marks previously seen candidates missing', async () => {
      const created = await req('POST', '/api/discovery/sources', {
        name: 'lab-nrf-missing',
        adapterType: 'nrf',
        baseUrl,
        transportMode: 'h2c',
        enabled: true,
      }, operatorToken);
      assert.equal(created.status, 201);
      const missingSourceId = created.body.sourceId;

      await seedObservations(obsColl, missingSourceId, 'cand-missing', now);

      mockMode.emptyScan = true;
      try {
        const res = await req('POST', `/api/discovery/sources/${missingSourceId}/scan`, {}, operatorToken);
        assert.equal(res.status, 200);
        assert.equal(res.body.run.status, 'success');
        assert.equal(res.body.run.discoveredCount, 0);
        assert.equal(res.body.run.missingCount, 2);

        const list = await req('GET', `/api/discovery/candidates?sourceId=${missingSourceId}`, undefined, viewerToken);
        assert.equal(list.body.candidates.length, 2);
        for (const candidate of list.body.candidates) {
          assert.equal(candidate.observationState, 'missing');
        }

        // Repeat scan on the just-scanned source is rate limited per source.
        const limited = await req('POST', `/api/discovery/sources/${missingSourceId}/scan`, {}, operatorToken);
        assert.equal(limited.status, 429);
        assert.equal(limited.body.code, 'DISCOVERY_SCAN_RATE_LIMITED');
      } finally {
        mockMode.emptyScan = false;
      }
    });

    // 12. No generic execution surface
    await verifyAsync('discovery exposes no generic fetch or NF control endpoint', async () => {
      for (const p of ['/api/discovery/fetch', '/api/discovery/proxy', '/api/discovery/execute']) {
        const res = await req('POST', p, {}, adminToken);
        assert.ok(res.status === 404 || res.status === 405, `${p} must not exist`);
      }
    });

    // 13. Runs history
    await verifyAsync('scan runs are recorded with initiatedBy and status', async () => {
      const runs = await req('GET', '/api/discovery/runs?limit=50', undefined, viewerToken);
      assert.equal(runs.status, 200);
      assert.ok(runs.body.runs.length >= 3, `expected at least 3 runs, got ${runs.body.runs.length}`);
      assert.ok(runs.body.runs.every((r) => r.initiatedBy === 'operator1'));
      const statuses = new Set(runs.body.runs.map((r) => r.status));
      assert.ok(statuses.has('success'), 'successful scans must be recorded');
      assert.ok(statuses.has('failed'), 'failed scans must be recorded');
    });

    console.log(`\nNF Discovery integration: ${passed}/${totalChecks} checks passed`);
    if (passed !== totalChecks) process.exit(1);
  } finally {
    if (goProc) goProc.kill('SIGTERM');
    if (mockServer) mockServer.close();
    await client.close();
    if (binPath) {
      try {
        const fs = await import('node:fs');
        if (fs.existsSync(binPath)) fs.unlinkSync(binPath);
      } catch {
        // best-effort cleanup of the test-owned binary
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
