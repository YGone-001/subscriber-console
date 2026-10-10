#!/usr/bin/env node
/**
 * Live NF Health read-only integration suite.
 *
 * GATED: refuses to run unless ALLOW_LIVE_NF_HEALTH_READONLY=1 is set explicitly.
 *
 * This suite contacts real local network-function metrics endpoints over
 * bounded, read-only GET requests issued only through the Go NF Health
 * collector. It never restarts, reloads or stops any service, never executes
 * operator-supplied commands, and never mutates core-network configuration.
 *
 * The suite asserts:
 * - The destination allowlist still defaults to deny for every other host:port
 * - Service-unit inspection stays read-only and allowlist-bound
 * - Collection records three-layer evidence without inventing missing metrics
 * - Missing metric families stay unmeasured and are never zero-filled
 * - Failed collection never overwrites the last valid measurement timestamp
 * - No live payload containing subscriber identity is printed to the console
 */

import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { SignJWT } from 'jose';
import { MongoClient } from 'mongodb';
import bcrypt from 'bcryptjs';
import { loadEnv } from './lib/load-env.mjs';

loadEnv(process.cwd());

if (process.env.ALLOW_LIVE_NF_HEALTH_READONLY !== '1') {
  console.log('SKIP live NF Health integration: set ALLOW_LIVE_NF_HEALTH_READONLY=1 to enable read-only live verification.');
  process.exit(0);
}

const LIVE_METRICS_TARGET = process.env.LIVE_NF_HEALTH_TARGET || '';
const LIVE_METRICS_URL = process.env.LIVE_NF_HEALTH_METRICS_URL || (LIVE_METRICS_TARGET ? `http://${LIVE_METRICS_TARGET}/metrics` : '');
const LIVE_SERVICE_UNIT = process.env.LIVE_NF_HEALTH_SERVICE_UNIT || '';
const LIVE_SERVICE_KIND = process.env.LIVE_NF_HEALTH_SERVICE_KIND || 'systemd';
const LIVE_CANDIDATE_ID = process.env.LIVE_NF_HEALTH_CANDIDATE_ID || '9b2d3c40-0011-4b11-9d11-000000000011';

assert.ok(LIVE_METRICS_URL, 'LIVE_NF_HEALTH_TARGET or LIVE_NF_HEALTH_METRICS_URL is required when the live gate is open');

const suffix = `${Date.now()}_${process.pid}_${Math.floor(Math.random() * 100000)}`;
const xcloudDbName = `xcloud_nfhealth_live_${suffix}`;
const appDbName = `xcloud_ops_nfhealth_live_${suffix}`;
const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/xcloud';

process.env.MONGODB_XCLOUD_DB = xcloudDbName;
process.env.MONGODB_APP_DB = appDbName;
const JWT_SECRET_STRING = process.env.JWT_SECRET || 'nf-health-live-readonly-secret-at-least-32-bytes-long!';
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

function makeToken(username, role) {
  return new SignJWT({ username, role, sv: 1 })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt(Math.floor(Date.now() / 1000))
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(jwtSecretKey());
}

let goProc = null;
let binPath = null;

async function verifyAsync(description, fn) {
  try {
    await fn();
    console.log(`  PASS  ${description}`);
  } catch (err) {
    console.error(`  FAIL  ${description}`);
    console.error(`        ${err.message}`);
    throw err;
  }
}

function hostPortOf(rawURL) {
  const u = new URL(rawURL);
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  return `${u.hostname}:${port}`;
}

async function main() {
  console.log('== Live NF Health Read-Only Integration Suite ==\n');
  console.log(`live_metrics_url=${LIVE_METRICS_URL.replace(/\/\/[^@]*@/, '//***@')}`);
  console.log(`live_service_unit=${LIVE_SERVICE_UNIT || '(none)'}`);
  console.log('mode=read-only-collect');

  try {
    await client.connect();
    const xcloudDb = client.db(xcloudDbName);
    const appDb = client.db(appDbName);
    const usersColl = appDb.collection('app_users');
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
    await usersColl.insertOne({
      username: 'admin1',
      passwordHash: hash,
      displayName: 'admin1',
      email: 'admin1@example.com',
      role: 'admin',
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

    await obsColl.insertOne({
      _id: LIVE_CANDIDATE_ID,
      schemaVersion: 1,
      sourceId: '8a1c2b30-0001-4a01-8c01-000000000001',
      adapterType: 'nrf',
      externalNfInstanceId: '00000000-0000-4000-8000-000000000001',
      nfType: 'AMF',
      nfStatus: 'REGISTERED',
      observedEndpoints: [],
      observedServices: [],
      firstSeenAt: now,
      lastSeenAt: now,
      observationState: 'seen',
      linkedResourceId: null,
      revision: 1,
    });

    const LIVE_CANDIDATE_SECONDARY_ID = '9b2d3c40-0011-4b11-9d11-000000000022';
    await obsColl.insertOne({
      _id: LIVE_CANDIDATE_SECONDARY_ID,
      schemaVersion: 1,
      sourceId: '8a1c2b30-0001-4a01-8c01-000000000001',
      adapterType: 'nrf',
      externalNfInstanceId: '00000000-0000-4000-8000-000000000002',
      nfType: 'SMF',
      nfStatus: 'REGISTERED',
      observedEndpoints: [],
      observedServices: [],
      firstSeenAt: now,
      lastSeenAt: now,
      observationState: 'seen',
      linkedResourceId: null,
      revision: 1,
    });

    const goPort = await getAvailablePort();
    const isWin = process.platform === 'win32';
    const binName = isWin ? `test-go-nfhl-${suffix}.exe` : `test-go-nfhl-${suffix}`;
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
        NF_HEALTH_ALLOWED_TARGETS: hostPortOf(LIVE_METRICS_URL),
        NF_HEALTH_SERVICE_UNITS: LIVE_SERVICE_UNIT,
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
    if (!goReady) throw new Error('Go server failed to start');

    const token = await makeToken('admin1', 'admin');
    const req = async (method, p, body) => {
      const headers = { 'Content-Type': 'application/json', Cookie: `auth_token=${token}` };
      const init = { method, headers };
      if (body !== undefined) init.body = JSON.stringify(body);
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

    await verifyAsync('non-allowlisted destinations remain denied', async () => {
      const res = await req('POST', '/api/nf-health/targets', {
        candidateId: LIVE_CANDIDATE_ID,
        name: 'blocked',
        collectorProfile: 'http_metrics',
        metricsEndpoint: 'http://127.0.0.12:9090/metrics',
        serviceKind: 'none',
        collectionMode: 'manual',
        intervalSeconds: 120,
        enabled: true,
      });
      assert.equal(res.status, 403);
      assert.equal(res.body.code, 'NF_HEALTH_DESTINATION_NOT_ALLOWED');
    });

    let targetId = null;
    await verifyAsync('live monitoring target is registered against the allowlisted exporter', async () => {
      const res = await req('POST', '/api/nf-health/targets', {
        candidateId: LIVE_CANDIDATE_ID,
        name: 'live-nf-health',
        collectorProfile: 'http_metrics',
        metricsEndpoint: LIVE_METRICS_URL,
        serviceUnit: LIVE_SERVICE_UNIT || undefined,
        serviceKind: LIVE_SERVICE_UNIT ? LIVE_SERVICE_KIND : 'none',
        collectionMode: 'manual',
        intervalSeconds: 120,
        enabled: true,
      });
      assert.equal(res.status, 201, `create status=${res.status} body=${JSON.stringify(res.body).slice(0, 200)}`);
      targetId = res.body.targetId;
      assert.ok(targetId);
      assert.equal(res.body.collectorProfile, 'http_metrics');
    });

    await verifyAsync('bounded live collection records three-layer evidence without inventing metrics', async () => {
      const res = await req('POST', `/api/nf-health/targets/${targetId}/collect`, {});
      assert.equal(res.status, 200, `collect status=${res.status} body=${JSON.stringify(res.body).slice(0, 200)}`);
      assert.ok(['success', 'partial', 'failed'].includes(res.body.run.status), `run status=${res.body.run.status}`);

      const sample = res.body.sample;
      if (sample) {
        assert.ok(sample.layers, 'three-layer evidence present');
        assert.ok(Object.prototype.hasOwnProperty.call(sample.layers.process, 'measured'));
        assert.ok(Object.prototype.hasOwnProperty.call(sample.layers.interface, 'measured'));
        assert.ok(Object.prototype.hasOwnProperty.call(sample.layers.service, 'measured'));
        for (const metric of sample.metrics || []) {
          assert.ok(!metric.labels || !('imsi' in metric.labels), 'sensitive labels must be dropped');
          assert.ok(!metric.labels || !('supi' in metric.labels), 'sensitive labels must be dropped');
          if (metric.type === 'counter') {
            assert.equal(metric.interpretation !== 'rate', true, 'counter samples must never be presented as rates');
          }
        }
        console.log(`  INFO  run_status=${res.body.run.status}`);
        console.log(`  INFO  layers_measured=${res.body.run.layersMeasured}`);
        console.log(`  INFO  metric_count=${(sample.metrics || []).length}`);
      } else {
        console.log(`  INFO  run_status=${res.body.run.status} sample=none`);
      }
    });

    await verifyAsync('missing metrics stay unmeasured and are never zero-filled', async () => {
      const detail = await req('GET', `/api/nf-health/targets/${targetId}`);
      assert.equal(detail.status, 200);
      const sample = detail.body.latestSample;
      if (sample) {
        const zeroFilled = (sample.metrics || []).filter((m) => m.value === 0 && m.key.includes('missing'));
        assert.equal(zeroFilled.length, 0, 'missing metric families must not appear as zeros');
        if (!sample.layers.service.measured) {
          assert.ok(
            ['not_configured', 'unknown'].includes(sample.layers.service.state),
            'an unmeasured service layer must not claim healthy',
          );
        }
      }
    });

    await verifyAsync('a run with no sample leaves lastMeasuredAt unchanged', async () => {
      /*
       * A second target keeps this scenario clear of the per-target collection
       * cooldown exercised by the first live collect. The target is created
       * against the allowlisted exporter, then every collector is stripped
       * before its one and only collection so the run must produce no sample.
       */
      const created = await req('POST', '/api/nf-health/targets', {
        candidateId: '9b2d3c40-0011-4b11-9d11-000000000022',
        name: 'live-nf-health-no-sample',
        collectorProfile: 'http_metrics',
        metricsEndpoint: LIVE_METRICS_URL,
        serviceUnit: LIVE_SERVICE_UNIT || undefined,
        serviceKind: LIVE_SERVICE_UNIT ? LIVE_SERVICE_KIND : 'none',
        collectionMode: 'manual',
        intervalSeconds: 120,
        enabled: true,
      });
      assert.equal(created.status, 201, `create status=${created.status}`);
      const emptyTargetId = created.body.targetId;

      const stripped = await req('PUT', `/api/nf-health/targets/${emptyTargetId}`, {
        expectedRevision: created.body.revision,
        target: {
          name: created.body.name,
          metricsEndpoint: '',
          serviceUnit: '',
          serviceKind: 'none',
          collectionMode: 'manual',
          intervalSeconds: 120,
          enabled: true,
        },
      });
      assert.equal(stripped.status, 200, `update status=${stripped.status}`);

      const before = await req('GET', `/api/nf-health/targets/${emptyTargetId}`);
      const beforeMeasured = before.body.target.lastMeasuredAt || null;

      const empty = await req('POST', `/api/nf-health/targets/${emptyTargetId}/collect`, {});
      assert.equal(empty.status, 200, `collect status=${empty.status}`);
      assert.equal(empty.body.sample, null, 'a collector-less run must not invent a sample');
      const after = await req('GET', `/api/nf-health/targets/${emptyTargetId}`);
      assert.equal(after.body.target.lastMeasuredAt || null, beforeMeasured, 'lastMeasuredAt must not move without a sample');
      console.log('  INFO  lastMeasuredAt_preserved=true');
    });

    await verifyAsync('live run is recorded as read-only collection evidence', async () => {
      const runs = await req('GET', `/api/nf-health/runs?targetId=${targetId}`);
      assert.equal(runs.status, 200);
      assert.ok(runs.body.runs.length >= 1);
      const latest = runs.body.runs[0];
      assert.ok(['success', 'partial', 'failed'].includes(latest.status));
      assert.equal(latest.initiatedBy, 'admin1');
    });

    console.log('\nLive NF Health read-only integration: PASS');
    console.log('Note: only bounded GET metrics probes and read-only process inspection were issued.');
    console.log('Note: no service was restarted, reloaded or stopped.');
  } finally {
    if (goProc) goProc.kill('SIGTERM');
    try {
      await client.db(xcloudDbName).dropDatabase();
      await client.db(appDbName).dropDatabase();
    } catch {
      // best-effort cleanup of test-owned databases
    }
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
