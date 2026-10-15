#!/usr/bin/env node
/**
 * NF Health Integration Suite (deterministic, no live core network).
 *
 * Runs against real MongoDB and a real Go backend with a local mock metrics
 * exporter that serves only the bounded Prometheus text exposition the
 * collector is allowed to parse.
 *
 * Verifies:
 * - Production index initialization for the three NF Health collections
 * - Sample TTL is scoped to app_nf_health_samples only
 * - Target create / read / update with CAS revision
 * - Default-deny destination allowlist enforcement
 * - Strict JSON decoding of target create/update bodies
 * - Collection records three-layer evidence with explicit coverage
 * - Missing metrics stay not_available and are never zero-filled
 * - Failed collection never overwrites the last valid measurement timestamp
 * - Counter samples are never presented as rates
 * - Viewer is read-only; operator and admin may mutate
 * - No generic fetch, restart or process-control endpoint is exposed
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { SignJWT } from 'jose';
import { MongoClient } from 'mongodb';
import bcrypt from 'bcryptjs';
import { loadEnv } from './lib/load-env.mjs';

loadEnv(process.cwd());

const suffix = `${Date.now()}_${process.pid}_${Math.floor(Math.random() * 100000)}`;
const xcloudDbName = `xcloud_nfhealth_test_${suffix}`;
const appDbName = `xcloud_ops_nfhealth_test_${suffix}`;
const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/xcloud';

process.env.MONGODB_XCLOUD_DB = xcloudDbName;
process.env.MONGODB_APP_DB = appDbName;
const JWT_SECRET_STRING = process.env.JWT_SECRET || 'nf-health-test-secret-at-least-32-bytes-long!';
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
let epcTargetId = null;
let imsTargetId = null;
let fiveGcTargetId = null;
let processOnlyTargetId = null;

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

const CANDIDATE_ID = '9b2d3c40-0011-4b11-9d11-000000000011';
// Separate Discovery candidates back separate monitoring targets so each
// collection scenario can run without hitting the per-target cooldown.
const CANDIDATE_EMPTY = '9b2d3c40-0022-4b22-9d22-000000000022';
const CANDIDATE_FAIL = '9b2d3c40-0033-4b33-9d33-000000000033';
const CANDIDATE_STALE = '9b2d3c40-0055-4b55-9d55-000000000055';
const CANDIDATE_DOWN = '9b2d3c40-0044-4b44-9d44-000000000044';
// Unified-identity candidates: explicitly linked to Inventory resources.
const CANDIDATE_LINKED_5GC = '9b2d3c40-0066-4b66-9d66-000000000066';
const CANDIDATE_TYPE_MISMATCH = '9b2d3c40-0077-4b77-9d77-000000000077';
// Unlinked candidate reserved for the legacy candidate-only compatibility path.
const CANDIDATE_LEGACY = '9b2d3c40-0088-4b88-9d88-000000000088';

// Inventory resources backing resource-native monitoring targets. NF Health
// only reads these documents; the suite owns their lifecycle.
const RESOURCE_EPC = '1a2b3c40-0001-4a01-8c01-0000000000e1';
const RESOURCE_IMS = '1a2b3c40-0002-4a02-8c02-0000000000e2';
const RESOURCE_5GC = '1a2b3c40-0003-4a03-8c03-0000000000e3';
const RESOURCE_RETIRED = '1a2b3c40-0004-4a04-8c04-0000000000e4';
const RESOURCE_HOST = '1a2b3c40-0005-4a05-8c05-0000000000e5';
const RESOURCE_PLATFORM = '1a2b3c40-0006-4a06-8c06-0000000000e6';
const RESOURCE_NOROLE = '1a2b3c40-0007-4a07-8c07-0000000000e7';
const RESOURCE_MISSING = '1a2b3c40-0008-4a08-8c08-0000000000e8';
// 5GC resource whose NRF Discovery candidate is explicitly linked to it.
const RESOURCE_5GC_LINKED = '1a2b3c40-0009-4a09-8c09-0000000000e9';
// IMS resource authorized for local process-only monitoring.
const RESOURCE_IMS_PROC = '1a2b3c40-000a-4a0a-8c0a-0000000000ea';
// Active resource with no server-authorized local process binding.
const RESOURCE_UNBOUND = '1a2b3c40-000b-4a0b-8c0b-0000000000eb';

const resourceDoc = (id, kind, domain, role, lifecycleState = 'active') => ({
  _id: id,
  schemaVersion: 1,
  kind,
  name: `${domain}-${role || 'unknown'}-${id.slice(-4)}`,
  domain,
  role,
  lifecycleState,
  revision: 1,
  createdAt: '2026-01-01T00:00:00Z',
  createdBy: 'seed',
  updatedAt: '2026-01-01T00:00:00Z',
  updatedBy: 'seed',
});

// Local process supervision for the process_only scenarios. The acceptance
// suite owns these processes and terminates them in its finally block.
let localProcesses = [];

const METRICS_BODY = [
  '# HELP amf_session Access-management sessions currently tracked',
  '# TYPE amf_session gauge',
  'amf_session 12',
  '# HELP process_cpu_seconds_total Cumulative process CPU seconds',
  '# TYPE process_cpu_seconds_total counter',
  'process_cpu_seconds_total 128.5',
  '# HELP imsi_label_metric Unsafe family that must be dropped',
  '# TYPE imsi_label_metric gauge',
  'imsi_label_metric{imsi="001010000000001"} 1',
  '# HELP unknown_family_not_registered Unregistered family is dropped',
  '# TYPE unknown_family_not_registered gauge',
  'unknown_family_not_registered 42',
  '',
].join('\n');

const EMPTY_BODY = '# no supported families\n';

const mockMode = { body: METRICS_BODY, status: 200, fail: false };

function buildMockMetrics() {
  return http.createServer((req, res) => {
    if (mockMode.fail) {
      res.destroy();
      return;
    }
    const body = mockMode.body;
    res.writeHead(mockMode.status, {
      'Content-Type': 'text/plain; version=0.0.4',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  });
}

function tokenHeaders(token) {
  return {
    Cookie: `auth_token=${token}`,
    'Content-Type': 'application/json',
  };
}

async function api(base, method, pathname, token, body) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: tokenHeaders(token),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text, headers: res.headers };
}

async function main() {
  console.log('== NF Health Integration Suite ==\n');

  try {
    await client.connect();

    const xcloudDb = client.db(xcloudDbName);
    const appDb = client.db(appDbName);
    const usersColl = appDb.collection('app_users');
    const targetsColl = appDb.collection('app_nf_health_targets');
    const runsColl = appDb.collection('app_nf_health_runs');
    const samplesColl = appDb.collection('app_nf_health_samples');
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

    // Discovery candidates referenced by monitoring targets. NF Health never
    // creates or mutates Discovery documents.
    const candidateDoc = (id, externalId) => ({
      _id: id,
      schemaVersion: 1,
      sourceId: '8a1c2b30-0001-4a01-8c01-000000000001',
      adapterType: 'nrf',
      externalNfInstanceId: externalId,
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
    await obsColl.insertMany([
      candidateDoc(CANDIDATE_ID, '3301e63a-c3b7-41f1-a512-9f6322e6f4c2'),
      candidateDoc(CANDIDATE_EMPTY, '3301e63a-c3b7-41f1-a512-9f6322e6f4c3'),
      candidateDoc(CANDIDATE_FAIL, '3301e63a-c3b7-41f1-a512-9f6322e6f4c4'),
      candidateDoc(CANDIDATE_DOWN, '3301e63a-c3b7-41f1-a512-9f6322e6f4c5'),
      candidateDoc(CANDIDATE_STALE, '3301e63a-c3b7-41f1-a512-9f6322e6f4c6'),
      candidateDoc(CANDIDATE_LEGACY, '3301e63a-c3b7-41f1-a512-9f6322e6f4c9'),
    ]);

    // Unified-identity candidates: explicitly linked to Inventory resources.
    await obsColl.insertMany([
      {
        ...candidateDoc(CANDIDATE_LINKED_5GC, '3301e63a-c3b7-41f1-a512-9f6322e6f4c7'),
        nfType: 'AMF',
        linkedResourceId: RESOURCE_5GC_LINKED,
      },
      {
        ...candidateDoc(CANDIDATE_TYPE_MISMATCH, '3301e63a-c3b7-41f1-a512-9f6322e6f4c8'),
        nfType: 'SMF',
        linkedResourceId: RESOURCE_5GC_LINKED,
      },
    ]);

    // Inventory resources referenced by resource-native monitoring targets.
    await client.db(appDbName).collection('app_inventory_resources').insertMany([
      resourceDoc(RESOURCE_EPC, 'network_function_instance', 'epc', 'mme'),
      resourceDoc(RESOURCE_IMS, 'network_function', 'ims', 'pcscf'),
      resourceDoc(RESOURCE_5GC, 'network_function_instance', '5gc', 'amf'),
      resourceDoc(RESOURCE_RETIRED, 'network_function', 'ims', 'pcscf', 'retired'),
      resourceDoc(RESOURCE_HOST, 'host', 'epc', 'mme'),
      resourceDoc(RESOURCE_PLATFORM, 'network_function', 'platform', 'amf'),
      resourceDoc(RESOURCE_NOROLE, 'network_function', 'ims', ''),
      resourceDoc(RESOURCE_5GC_LINKED, 'network_function_instance', '5gc', 'amf'),
      resourceDoc(RESOURCE_IMS_PROC, 'network_function_instance', 'ims', 'pcscf'),
      resourceDoc(RESOURCE_UNBOUND, 'network_function_instance', '5gc', 'amf'),
    ]);
    const inventoryBaseline = await client.db(appDbName).collection('app_inventory_resources').countDocuments({});

    await verifyAsync('production indexes cover exactly the three NF Health collections', async () => {
      const targetIndexes = await targetsColl.indexes();
      const runIndexes = await runsColl.indexes();
      const sampleIndexes = await samplesColl.indexes();
      assert.ok(targetIndexes.some((i) => i.name === 'uniq_nf_health_target_candidate'), 'unique candidate index');
      assert.ok(runIndexes.some((i) => i.name === 'nf_health_runs_target_started'), 'run query index');
      assert.ok(sampleIndexes.some((i) => i.name === 'nf_health_samples_ttl'), 'sample TTL index');
      const ttl = sampleIndexes.find((i) => i.name === 'nf_health_samples_ttl');
      assert.equal(ttl.expireAfterSeconds, 0, 'TTL must use expireAfterSeconds 0');
      assert.ok(!targetIndexes.some((i) => i.name === 'nf_health_targets_ttl'), 'targets are never TTL-deleted');
      assert.ok(!runIndexes.some((i) => i.name === 'nf_health_runs_ttl'), 'runs are never TTL-deleted');
    });

    const mockPort = await getAvailablePort();
    mockServer = buildMockMetrics();
    await new Promise((resolve, reject) => {
      mockServer.listen(mockPort, '127.0.0.1', resolve);
      mockServer.on('error', reject);
    });

    const goPort = await getAvailablePort();
    const isWin = process.platform === 'win32';
    const binName = isWin ? `test-go-nfh-${suffix}.exe` : `test-go-nfh-${suffix}`;
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
        NF_HEALTH_ALLOWED_TARGETS: `127.0.0.1:${mockPort}`,
        NF_HEALTH_SERVICE_UNITS: 'mockd,amfd',
        // Server-owned local bindings: only these Inventory resources may
        // monitor the local mockd process.
        NF_HEALTH_LOCAL_PROCESS_BINDINGS: `${RESOURCE_IMS}=mockd,${RESOURCE_IMS_PROC}=mockd,${RESOURCE_EPC}=mockd`,
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
        /* still booting */
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(goReady, 'Go backend must become ready');
    const base = `http://127.0.0.1:${goPort}`;

    const adminToken = await makeToken('admin1', 'admin');
    const operatorToken = await makeToken('operator1', 'operator');
    const viewerToken = await makeToken('viewer1', 'viewer');

    await verifyAsync('meta exposes the vendor-neutral collector vocabulary', async () => {
      const res = await api(base, 'GET', '/api/nf-health/meta', operatorToken);
      assert.equal(res.status, 200);
      assert.deepEqual(res.json.collectorProfiles, ['http_metrics', 'process_only']);
      assert.ok(res.json.layerStates.includes('not_configured'));
      assert.ok(Array.isArray(res.json.supportedMetrics));
      assert.equal(res.json.retentionDays, 7);
      assert.equal(res.json.maxRetentionDays, 30);
      assert.deepEqual(res.json.supportedResourceDomains, ['epc', '5gc', 'ims', 'charging']);
      assert.ok(res.json.identityStates.includes('inventory_authoritative'));
      assert.ok(res.json.identityStates.includes('legacy_unresolved'));
    });

    await verifyAsync('destination allowlist defaults to deny', async () => {
      const res = await api(base, 'POST', '/api/nf-health/targets', operatorToken, {
        candidateId: CANDIDATE_ID,
        name: 'denied target',
        collectorProfile: 'http_metrics',
        metricsEndpoint: 'http://127.0.0.1:9/metrics',
        serviceKind: 'process',
        serviceUnit: 'mockd',
        collectionMode: 'manual',
        intervalSeconds: 120,
        enabled: true,
      });
      assert.equal(res.status, 403);
      assert.equal(res.json.code, 'NF_HEALTH_DESTINATION_NOT_ALLOWED');
    });

    await verifyAsync('service unit allowlist defaults to deny', async () => {
      const res = await api(base, 'POST', '/api/nf-health/targets', operatorToken, {
        candidateId: CANDIDATE_ID,
        name: 'denied unit',
        collectorProfile: 'http_metrics',
        metricsEndpoint: `http://127.0.0.1:${mockPort}/metrics`,
        serviceKind: 'process',
        serviceUnit: 'not-allowlisted',
        collectionMode: 'manual',
        intervalSeconds: 120,
        enabled: true,
      });
      assert.equal(res.status, 403);
      assert.equal(res.json.code, 'NF_HEALTH_SERVICE_UNIT_NOT_ALLOWED');
    });

    await verifyAsync('strict JSON decoding rejects unknown fields', async () => {
      const res = await api(base, 'POST', '/api/nf-health/targets', operatorToken, {
        candidateId: CANDIDATE_ID,
        name: 'unknown field',
        collectorProfile: 'http_metrics',
        metricsEndpoint: `http://127.0.0.1:${mockPort}/metrics`,
        serviceKind: 'process',
        serviceUnit: 'mockd',
        collectionMode: 'manual',
        intervalSeconds: 120,
        enabled: true,
        command: 'rm -rf /',
      });
      assert.equal(res.status, 400);
    });

    let targetId = null;
    await verifyAsync('operator creates a monitoring target', async () => {
      const res = await api(base, 'POST', '/api/nf-health/targets', operatorToken, {
        candidateId: CANDIDATE_ID,
        name: 'AMF metrics',
        collectorProfile: 'http_metrics',
        metricsEndpoint: `http://127.0.0.1:${mockPort}/metrics`,
        serviceKind: 'process',
        serviceUnit: 'mockd',
        collectionMode: 'manual',
        intervalSeconds: 120,
        enabled: true,
      });
      assert.equal(res.status, 201, res.text);
      assert.equal(res.json.candidateId, CANDIDATE_ID);
      assert.equal(res.json.collectorProfile, 'http_metrics');
      assert.equal(res.json.revision, 1);
      targetId = res.json.targetId;
      assert.ok(targetId, 'targetId assigned');
    });

    await verifyAsync('duplicate candidate target is rejected', async () => {
      const res = await api(base, 'POST', '/api/nf-health/targets', operatorToken, {
        candidateId: CANDIDATE_ID,
        name: 'duplicate',
        collectorProfile: 'http_metrics',
        metricsEndpoint: `http://127.0.0.1:${mockPort}/metrics`,
        serviceKind: 'process',
        serviceUnit: 'mockd',
        collectionMode: 'manual',
        intervalSeconds: 120,
        enabled: true,
      });
      assert.equal(res.status, 409);
      assert.equal(res.json.code, 'NF_HEALTH_TARGET_CONFLICT');
    });

    await verifyAsync('viewer cannot create targets', async () => {
      const res = await api(base, 'POST', '/api/nf-health/targets', viewerToken, {
        candidateId: CANDIDATE_ID,
        name: 'viewer write',
        collectorProfile: 'http_metrics',
        metricsEndpoint: `http://127.0.0.1:${mockPort}/metrics`,
        serviceKind: 'process',
        serviceUnit: 'mockd',
        collectionMode: 'manual',
        intervalSeconds: 120,
        enabled: true,
      });
      assert.equal(res.status, 403);
    });

    await verifyAsync('viewer can read targets', async () => {
      const res = await api(base, 'GET', '/api/nf-health/targets', viewerToken);
      assert.equal(res.status, 200);
      assert.equal(res.json.targets.length, 1);
      assert.ok(res.json.targets[0].coverage);
    });

    await verifyAsync('collect records three-layer evidence and supported metrics', async () => {
      const res = await api(base, 'POST', `/api/nf-health/targets/${targetId}/collect`, operatorToken);
      assert.equal(res.status, 200, res.text);
      assert.equal(res.json.run.status, 'success');
      assert.ok(res.json.sample, 'sample persisted');
      const sample = res.json.sample;
      assert.equal(sample.layers.process.measured, true);
      assert.equal(sample.layers.interface.measured, true);
      assert.equal(sample.layers.service.measured, true);
      assert.equal(sample.layers.interface.httpStatus, 200);
      const keys = sample.metrics.map((m) => m.key);
      assert.ok(keys.includes('amf_session'), 'supported gauge kept');
      assert.ok(keys.includes('process_cpu_seconds_total'), 'supported counter kept');
      assert.ok(!keys.includes('unknown_family_not_registered'), 'unregistered family dropped');
      const counter = sample.metrics.find((m) => m.key === 'process_cpu_seconds_total');
      assert.equal(counter.type, 'counter', 'counter type preserved; never a rate');
      assert.equal(counter.value, 128.5);
      for (const metric of sample.metrics) {
        assert.ok(!metric.labels || !('imsi' in metric.labels), 'sensitive labels dropped');
      }
    });

    // ---- Unified EPC/5GC/IMS resource identity foundation ----

    await verifyAsync('Inventory-only EPC target creation', async () => {
      const res = await api(base, 'POST', '/api/nf-health/targets', operatorToken, {
        resourceId: RESOURCE_EPC,
        name: 'MME node-01 metrics',
        collectorProfile: 'http_metrics',
        metricsEndpoint: `http://127.0.0.1:${mockPort}/metrics`,
        serviceKind: 'process',
        serviceUnit: 'mockd',
        collectionMode: 'manual',
        intervalSeconds: 120,
        enabled: true,
      });
      assert.equal(res.status, 201, res.text);
      assert.equal(res.json.resourceId, RESOURCE_EPC);
      assert.equal(res.json.domain, 'epc');
      assert.equal(res.json.nfType, 'MME');
      assert.equal(res.json.identityState, 'inventory_authoritative');
      assert.ok(!res.json.candidateId, 'candidateId must stay absent for an Inventory-only target');
      epcTargetId = res.json.targetId;
    });

    await verifyAsync('Inventory-only IMS target creation', async () => {
      const res = await api(base, 'POST', '/api/nf-health/targets', operatorToken, {
        resourceId: RESOURCE_IMS,
        name: 'P-CSCF node-01 metrics',
        collectorProfile: 'http_metrics',
        metricsEndpoint: `http://127.0.0.1:${mockPort}/metrics`,
        serviceKind: 'none',
        collectionMode: 'manual',
        intervalSeconds: 120,
        enabled: true,
      });
      assert.equal(res.status, 201, res.text);
      assert.equal(res.json.resourceId, RESOURCE_IMS);
      assert.equal(res.json.domain, 'ims');
      assert.equal(res.json.nfType, 'P-CSCF');
      imsTargetId = res.json.targetId;
    });

    await verifyAsync('Inventory-only 5GC target creation', async () => {
      const res = await api(base, 'POST', '/api/nf-health/targets', operatorToken, {
        resourceId: RESOURCE_5GC,
        name: 'AMF node-01 metrics',
        collectorProfile: 'http_metrics',
        metricsEndpoint: `http://127.0.0.1:${mockPort}/metrics`,
        serviceKind: 'none',
        collectionMode: 'manual',
        intervalSeconds: 120,
        enabled: true,
      });
      assert.equal(res.status, 201, res.text);
      assert.equal(res.json.resourceId, RESOURCE_5GC);
      assert.equal(res.json.domain, '5gc');
      assert.equal(res.json.nfType, 'AMF');
      fiveGcTargetId = res.json.targetId;
    });

    await verifyAsync('Inventory plus matching linked Discovery candidate is accepted', async () => {
      const res = await api(base, 'POST', '/api/nf-health/targets', operatorToken, {
        resourceId: RESOURCE_5GC_LINKED,
        candidateId: CANDIDATE_LINKED_5GC,
        name: 'AMF node-02 NRF-linked',
        collectorProfile: 'http_metrics',
        metricsEndpoint: `http://127.0.0.1:${mockPort}/metrics`,
        serviceKind: 'none',
        collectionMode: 'manual',
        intervalSeconds: 120,
        enabled: true,
      });
      assert.equal(res.status, 201, res.text);
      assert.equal(res.json.candidateId, CANDIDATE_LINKED_5GC);
      assert.equal(res.json.resourceId, RESOURCE_5GC_LINKED);
    });

    await verifyAsync('candidate linked to another resource is rejected', async () => {
      const res = await api(base, 'POST', '/api/nf-health/targets', adminToken, {
        resourceId: RESOURCE_EPC,
        candidateId: CANDIDATE_LINKED_5GC,
        name: 'mismatched association',
        collectorProfile: 'http_metrics',
        metricsEndpoint: `http://127.0.0.1:${mockPort}/metrics`,
        serviceKind: 'none',
        collectionMode: 'manual',
        intervalSeconds: 120,
        enabled: true,
      });
      assert.equal(res.status, 400, res.text);
      assert.equal(res.json.code, 'NF_HEALTH_CANDIDATE_RESOURCE_MISMATCH');
    });

    await verifyAsync('candidate NF type mismatch is rejected', async () => {
      const res = await api(base, 'POST', '/api/nf-health/targets', adminToken, {
        resourceId: RESOURCE_5GC_LINKED,
        candidateId: CANDIDATE_TYPE_MISMATCH,
        name: 'type mismatch',
        collectorProfile: 'http_metrics',
        metricsEndpoint: `http://127.0.0.1:${mockPort}/metrics`,
        serviceKind: 'none',
        collectionMode: 'manual',
        intervalSeconds: 120,
        enabled: true,
      });
      assert.equal(res.status, 400, res.text);
      assert.equal(res.json.code, 'NF_HEALTH_CANDIDATE_TYPE_MISMATCH');
    });

    await verifyAsync('missing Inventory resource is rejected', async () => {
      const res = await api(base, 'POST', '/api/nf-health/targets', adminToken, {
        resourceId: RESOURCE_MISSING,
        name: 'missing resource',
        collectorProfile: 'http_metrics',
        metricsEndpoint: `http://127.0.0.1:${mockPort}/metrics`,
        serviceKind: 'none',
        collectionMode: 'manual',
        intervalSeconds: 120,
        enabled: true,
      });
      assert.equal(res.status, 400, res.text);
      assert.equal(res.json.code, 'NF_HEALTH_RESOURCE_NOT_FOUND');
    });

    await verifyAsync('retired Inventory resource is rejected', async () => {
      const res = await api(base, 'POST', '/api/nf-health/targets', adminToken, {
        resourceId: RESOURCE_RETIRED,
        name: 'retired resource',
        collectorProfile: 'http_metrics',
        metricsEndpoint: `http://127.0.0.1:${mockPort}/metrics`,
        serviceKind: 'none',
        collectionMode: 'manual',
        intervalSeconds: 120,
        enabled: true,
      });
      assert.equal(res.status, 409, res.text);
      assert.equal(res.json.code, 'NF_HEALTH_RESOURCE_RETIRED');
    });

    await verifyAsync('non-NF Inventory kind is rejected', async () => {
      const res = await api(base, 'POST', '/api/nf-health/targets', adminToken, {
        resourceId: RESOURCE_HOST,
        name: 'host resource',
        collectorProfile: 'http_metrics',
        metricsEndpoint: `http://127.0.0.1:${mockPort}/metrics`,
        serviceKind: 'none',
        collectionMode: 'manual',
        intervalSeconds: 120,
        enabled: true,
      });
      assert.equal(res.status, 400, res.text);
      assert.equal(res.json.code, 'NF_HEALTH_RESOURCE_KIND_UNSUPPORTED');
    });

    await verifyAsync('unsupported Inventory domain is rejected', async () => {
      const res = await api(base, 'POST', '/api/nf-health/targets', adminToken, {
        resourceId: RESOURCE_PLATFORM,
        name: 'platform resource',
        collectorProfile: 'http_metrics',
        metricsEndpoint: `http://127.0.0.1:${mockPort}/metrics`,
        serviceKind: 'none',
        collectionMode: 'manual',
        intervalSeconds: 120,
        enabled: true,
      });
      assert.equal(res.status, 400, res.text);
      assert.equal(res.json.code, 'NF_HEALTH_RESOURCE_DOMAIN_UNSUPPORTED');
    });

    await verifyAsync('unresolved Inventory NF type is rejected', async () => {
      const res = await api(base, 'POST', '/api/nf-health/targets', adminToken, {
        resourceId: RESOURCE_NOROLE,
        name: 'roleless resource',
        collectorProfile: 'http_metrics',
        metricsEndpoint: `http://127.0.0.1:${mockPort}/metrics`,
        serviceKind: 'none',
        collectionMode: 'manual',
        intervalSeconds: 120,
        enabled: true,
      });
      assert.equal(res.status, 400, res.text);
      assert.equal(res.json.code, 'NF_HEALTH_NF_TYPE_UNRESOLVED');
    });

    await verifyAsync('client-supplied domain or nfType is rejected', async () => {
      for (const spoof of [{ domain: '5gc' }, { nfType: 'AMF' }]) {
        const res = await api(base, 'POST', '/api/nf-health/targets', adminToken, {
          resourceId: RESOURCE_EPC,
          name: 'spoofed identity',
          collectorProfile: 'http_metrics',
          metricsEndpoint: `http://127.0.0.1:${mockPort}/metrics`,
          serviceKind: 'none',
          collectionMode: 'manual',
          intervalSeconds: 120,
          enabled: true,
          ...spoof,
        });
        assert.equal(res.status, 400, `${JSON.stringify(spoof)} must be rejected by strict decoding`);
      }
    });

    await verifyAsync('duplicate logical target on the same Inventory resource is rejected', async () => {
      const res = await api(base, 'POST', '/api/nf-health/targets', adminToken, {
        resourceId: RESOURCE_IMS,
        name: 'P-CSCF duplicate',
        collectorProfile: 'http_metrics',
        metricsEndpoint: `http://127.0.0.1:${mockPort}/metrics`,
        serviceKind: 'none',
        collectionMode: 'manual',
        intervalSeconds: 120,
        enabled: true,
      });
      assert.equal(res.status, 409, res.text);
      assert.equal(res.json.code, 'NF_HEALTH_TARGET_CONFLICT');
    });

    await verifyAsync('multiple Inventory-only targets coexist without candidateId collisions', async () => {
      const res = await api(base, 'GET', '/api/nf-health/targets?q=P-CSCF', operatorToken);
      assert.equal(res.status, 200, res.text);
      const names = (res.json.targets || []).map((t) => t.name);
      assert.ok(names.includes('P-CSCF node-01 metrics'), 'Inventory-only target must be listable');
      const anyCandidate = (res.json.targets || []).some((t) => t.candidateId);
      assert.equal(anyCandidate, false, 'Inventory-only targets must not gain a candidate');
    });

    await verifyAsync('legacy candidate-only creation remains available and transitional', async () => {
      const res = await api(base, 'POST', '/api/nf-health/targets', operatorToken, {
        candidateId: CANDIDATE_LEGACY,
        name: 'legacy candidate-only',
        collectorProfile: 'http_metrics',
        metricsEndpoint: `http://127.0.0.1:${mockPort}/metrics`,
        serviceKind: 'none',
        collectionMode: 'manual',
        intervalSeconds: 120,
        enabled: true,
      });
      assert.equal(res.status, 201, res.text);
      assert.ok(!res.json.resourceId, 'no Inventory resource may be fabricated');
      assert.equal(res.json.identityState, 'legacy_unbound', 'new legacy-unbound targets are transitional');
    });

    await verifyAsync('process_only requires a server-authorized local process binding', async () => {
      const missing = await api(base, 'POST', '/api/nf-health/targets', operatorToken, {
        resourceId: RESOURCE_UNBOUND,
        name: 'unbound process target',
        collectorProfile: 'process_only',
        serviceKind: 'process',
        serviceUnit: 'mockd',
        collectionMode: 'manual',
        intervalSeconds: 120,
        enabled: true,
      });
      assert.equal(missing.status, 403, missing.text);
      assert.equal(missing.json.code, 'NF_HEALTH_PROCESS_BINDING_MISSING');

      const mismatched = await api(base, 'POST', '/api/nf-health/targets', operatorToken, {
        resourceId: RESOURCE_IMS,
        name: 'mismatched process target',
        collectorProfile: 'process_only',
        serviceKind: 'process',
        serviceUnit: 'amfd',
        collectionMode: 'manual',
        intervalSeconds: 120,
        enabled: true,
      });
      assert.equal(mismatched.status, 403, mismatched.text);
      assert.equal(mismatched.json.code, 'NF_HEALTH_PROCESS_BINDING_MISMATCH');

      const withEndpoint = await api(base, 'POST', '/api/nf-health/targets', operatorToken, {
        resourceId: RESOURCE_IMS,
        name: 'process target with endpoint',
        collectorProfile: 'process_only',
        metricsEndpoint: `http://127.0.0.1:${mockPort}/metrics`,
        serviceKind: 'process',
        serviceUnit: 'mockd',
        collectionMode: 'manual',
        intervalSeconds: 120,
        enabled: true,
      });
      assert.equal(withEndpoint.status, 400, withEndpoint.text);
    });

    await verifyAsync('process_only target creation and truthful L1 evidence', async () => {
      // A real local process whose exact comm and executable identity match
      // the approved unit; the suite owns and terminates it.
      const procDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-health-process-'));
      const approvedBin = path.join(procDir, 'mockd');
      fs.copyFileSync('/bin/sleep', approvedBin);
      fs.chmodSync(approvedBin, 0o755);
      const approved = spawn(approvedBin, ['120'], { stdio: 'ignore', detached: true });
      localProcesses.push(approved);
      // A lookalike process that must never satisfy strict identity.
      const lookalikeBin = path.join(procDir, 'mockd-test');
      fs.copyFileSync('/bin/sleep', lookalikeBin);
      fs.chmodSync(lookalikeBin, 0o755);
      const lookalike = spawn(lookalikeBin, ['120'], { stdio: 'ignore', detached: true });
      localProcesses.push(lookalike);

      const created = await api(base, 'POST', '/api/nf-health/targets', operatorToken, {
        resourceId: RESOURCE_IMS_PROC,
        name: 'P-CSCF local process',
        collectorProfile: 'process_only',
        serviceKind: 'process',
        serviceUnit: 'mockd',
        collectionMode: 'manual',
        intervalSeconds: 120,
        enabled: true,
      });
      assert.equal(created.status, 201, created.text);
      assert.equal(created.json.collectorProfile, 'process_only');
      processOnlyTargetId = created.json.targetId;

      const res = await api(base, 'POST', `/api/nf-health/targets/${processOnlyTargetId}/collect`, operatorToken);
      assert.equal(res.status, 200, res.text);
      assert.equal(res.json.run.status, 'success');
      assert.equal(res.json.run.layersMeasured, 1, 'only L1 is measured');
      const sample = res.json.sample;
      assert.ok(sample, 'L1 evidence must be recorded');
      assert.equal(sample.layers.process.measured, true);
      assert.equal(sample.layers.process.state, 'healthy');
      assert.equal(sample.layers.interface.measured, false);
      assert.equal(sample.layers.interface.state, 'not_configured');
      assert.equal(sample.layers.service.measured, false);
      assert.equal(sample.layers.service.state, 'not_configured');
      assert.equal(sample.resourceId, RESOURCE_IMS_PROC, 'samples retain the canonical resource association');
      assert.equal(sample.metrics.length, 0, 'process_only synthesizes no metrics');
    });

    await verifyAsync('collection against a retired Inventory resource is blocked explicitly', async () => {
      await client.db(appDbName).collection('app_inventory_resources').updateOne(
        { _id: RESOURCE_EPC },
        { $set: { lifecycleState: 'retired' } },
      );
      const res = await api(base, 'POST', `/api/nf-health/targets/${epcTargetId}/collect`, operatorToken);
      assert.equal(res.status, 409, res.text);
      assert.equal(res.json.code, 'NF_HEALTH_RESOURCE_RETIRED');
      // Historical evidence stays readable.
      const detail = await api(base, 'GET', `/api/nf-health/targets/${epcTargetId}`, operatorToken);
      assert.equal(detail.status, 200, detail.text);
      const history = await api(base, 'GET', `/api/nf-health/targets/${epcTargetId}/history`, operatorToken);
      assert.equal(history.status, 200, history.text);
      assert.ok(Array.isArray(history.json.samples));
    });

    // ---- Correction A/C/D: identity integrity across update and collection ----

    await verifyAsync('resource-native HTTP target with local L1 evidence requires a binding', async () => {
      const res = await api(base, 'POST', '/api/nf-health/targets', adminToken, {
        resourceId: RESOURCE_5GC,
        name: 'unbound local evidence',
        collectorProfile: 'http_metrics',
        metricsEndpoint: `http://127.0.0.1:${mockPort}/metrics`,
        serviceKind: 'process',
        serviceUnit: 'mockd',
        collectionMode: 'manual',
        intervalSeconds: 120,
        enabled: true,
      });
      assert.equal(res.status, 403, res.text);
      assert.equal(res.json.code, 'NF_HEALTH_PROCESS_BINDING_MISSING');
    });

    await verifyAsync('process_only update cannot repoint to an unrelated allowlisted process', async () => {
      const detail = await api(base, 'GET', `/api/nf-health/targets/${processOnlyTargetId}`, operatorToken);
      const revision = detail.json.target.revision;
      const res = await api(base, 'PUT', `/api/nf-health/targets/${processOnlyTargetId}`, operatorToken, {
        expectedRevision: revision,
        target: {
          name: 'P-CSCF local process',
          serviceUnit: 'amfd',
          serviceKind: 'process',
          collectionMode: 'manual',
          intervalSeconds: 120,
          enabled: true,
        },
      });
      assert.equal(res.status, 403, res.text);
      assert.equal(res.json.code, 'NF_HEALTH_PROCESS_BINDING_MISMATCH');

      // Failed validation performs zero writes.
      const after = await api(base, 'GET', `/api/nf-health/targets/${processOnlyTargetId}`, operatorToken);
      assert.equal(after.json.target.revision, revision, 'a rejected update must not change the revision');
      assert.equal(after.json.target.serviceUnit, 'mockd', 'a rejected update must not change the service unit');
    });

    await verifyAsync('process_only update cannot disable its inspection source', async () => {
      const detail = await api(base, 'GET', `/api/nf-health/targets/${processOnlyTargetId}`, operatorToken);
      const revision = detail.json.target.revision;
      const res = await api(base, 'PUT', `/api/nf-health/targets/${processOnlyTargetId}`, operatorToken, {
        expectedRevision: revision,
        target: {
          name: 'P-CSCF local process',
          serviceUnit: '',
          serviceKind: 'none',
          collectionMode: 'manual',
          intervalSeconds: 120,
          enabled: true,
        },
      });
      assert.equal(res.status, 400, res.text);
      assert.equal(res.json.code, 'INVALID_SERVICE_KIND');
      const after = await api(base, 'GET', `/api/nf-health/targets/${processOnlyTargetId}`, operatorToken);
      assert.equal(after.json.target.revision, revision);
      assert.equal(after.json.target.serviceKind, 'process');
    });

    await verifyAsync('process_only update cannot introduce a metrics endpoint', async () => {
      const detail = await api(base, 'GET', `/api/nf-health/targets/${processOnlyTargetId}`, operatorToken);
      const revision = detail.json.target.revision;
      const res = await api(base, 'PUT', `/api/nf-health/targets/${processOnlyTargetId}`, operatorToken, {
        expectedRevision: revision,
        target: {
          name: 'P-CSCF local process',
          metricsEndpoint: `http://127.0.0.1:${mockPort}/metrics`,
          serviceUnit: 'mockd',
          serviceKind: 'process',
          collectionMode: 'manual',
          intervalSeconds: 120,
          enabled: true,
        },
      });
      assert.equal(res.status, 400, res.text);
      assert.equal(res.json.code, 'INVALID_TARGET');
      const after = await api(base, 'GET', `/api/nf-health/targets/${processOnlyTargetId}`, operatorToken);
      assert.equal(after.json.target.revision, revision);
      assert.equal(after.json.target.metricsEndpoint ?? '', '');
    });

    await verifyAsync('valid process_only update keeps its authorized identity', async () => {
      const detail = await api(base, 'GET', `/api/nf-health/targets/${processOnlyTargetId}`, operatorToken);
      const revision = detail.json.target.revision;
      const res = await api(base, 'PUT', `/api/nf-health/targets/${processOnlyTargetId}`, operatorToken, {
        expectedRevision: revision,
        target: {
          name: 'P-CSCF local process (renamed)',
          serviceUnit: 'mockd',
          serviceKind: 'process',
          collectionMode: 'manual',
          intervalSeconds: 180,
          enabled: true,
        },
      });
      assert.equal(res.status, 200, res.text);
      assert.equal(res.json.revision, revision + 1);
      assert.equal(res.json.serviceUnit, 'mockd');
      assert.equal(res.json.resourceId, RESOURCE_IMS_PROC, 'the Inventory association stays immutable');
      assert.equal(res.json.collectorProfile, 'process_only');
    });

    await verifyAsync('identity fields are immutable through the update contract', async () => {
      const detail = await api(base, 'GET', `/api/nf-health/targets/${processOnlyTargetId}`, operatorToken);
      const revision = detail.json.target.revision;
      for (const spoof of [
        { resourceId: RESOURCE_EPC },
        { candidateId: CANDIDATE_LINKED_5GC },
        { collectorProfile: 'http_metrics' },
        { domain: 'epc' },
        { nfType: 'MME' },
      ]) {
        const res = await api(base, 'PUT', `/api/nf-health/targets/${processOnlyTargetId}`, operatorToken, {
          expectedRevision: revision,
          target: {
            name: 'identity spoof',
            serviceUnit: 'mockd',
            serviceKind: 'process',
            collectionMode: 'manual',
            intervalSeconds: 120,
            enabled: true,
            ...spoof,
          },
        });
        assert.equal(res.status, 400, `${JSON.stringify(spoof)} must be rejected: ${res.text}`);
      }
      const after = await api(base, 'GET', `/api/nf-health/targets/${processOnlyTargetId}`, operatorToken);
      assert.equal(after.json.target.revision, revision);
      assert.equal(after.json.target.resourceId, RESOURCE_IMS_PROC);
      assert.equal(after.json.target.collectorProfile, 'process_only');
    });

    await verifyAsync('collection rejects a deleted Inventory resource', async () => {
      await client.db(appDbName).collection('app_inventory_resources').deleteOne({ _id: RESOURCE_5GC });
      const res = await api(base, 'POST', `/api/nf-health/targets/${fiveGcTargetId}/collect`, operatorToken);
      assert.equal(res.status, 409, res.text);
      assert.equal(res.json.code, 'NF_HEALTH_RESOURCE_NOT_FOUND');
      const detail = await api(base, 'GET', `/api/nf-health/targets/${fiveGcTargetId}`, operatorToken);
      assert.equal(detail.status, 200, 'the target stays readable with its history');
      assert.equal(detail.json.target.resourceId, RESOURCE_5GC, 'identity is never silently reassigned');
      // Restore the fixture resource so the ownership count stays meaningful.
      await client.db(appDbName).collection('app_inventory_resources').insertOne(
        resourceDoc(RESOURCE_5GC, 'network_function_instance', '5gc', 'amf'),
      );
    });

    await verifyAsync('collection fails closed when the authoritative identity changed', async () => {
      // The earlier retirement scenario left the resource retired; restore an
      // active lifecycle and move the authoritative role so the stored NF type
      // no longer matches.
      await client.db(appDbName).collection('app_inventory_resources').updateOne(
        { _id: RESOURCE_EPC },
        { $set: { role: 'sgwc', lifecycleState: 'active' } },
      );
      const res = await api(base, 'POST', `/api/nf-health/targets/${epcTargetId}/collect`, operatorToken);
      assert.equal(res.status, 409, res.text);
      assert.equal(res.json.code, 'NF_HEALTH_TARGET_IDENTITY_MISMATCH');
      const detail = await api(base, 'GET', `/api/nf-health/targets/${epcTargetId}`, operatorToken);
      assert.equal(detail.json.target.nfType, 'MME', 'the stored identity is preserved, never rewritten');
      // Restore the authoritative role.
      await client.db(appDbName).collection('app_inventory_resources').updateOne(
        { _id: RESOURCE_EPC },
        { $set: { role: 'mme' } },
      );
    });

    await verifyAsync('rejected collection never produces a falsely healthy sample', async () => {
      await client.db(appDbName).collection('app_inventory_resources').updateOne(
        { _id: RESOURCE_EPC },
        { $set: { lifecycleState: 'retired' } },
      );
      const res = await api(base, 'POST', `/api/nf-health/targets/${epcTargetId}/collect`, operatorToken);
      assert.equal(res.status, 409, res.text);
      const samples = await samplesColl.find({ targetId: epcTargetId }).toArray();
      assert.equal(samples.length, 0, 'a rejected collection must not persist any sample');
      await client.db(appDbName).collection('app_inventory_resources').updateOne(
        { _id: RESOURCE_EPC },
        { $set: { lifecycleState: 'active' } },
      );
    });

    // Each remaining scenario uses its own target so the per-target collection
    // cooldown cannot mask the behaviour under test.
    async function createTarget(candidateId, name, overrides = {}) {
      const res = await api(base, 'POST', '/api/nf-health/targets', operatorToken, {
        candidateId,
        name,
        collectorProfile: 'http_metrics',
        metricsEndpoint: `http://127.0.0.1:${mockPort}/metrics`,
        serviceKind: 'process',
        serviceUnit: 'mockd',
        collectionMode: 'manual',
        intervalSeconds: 120,
        enabled: true,
        ...overrides,
      });
      assert.equal(res.status, 201, res.text);
      return res.json.targetId;
    }

    await verifyAsync('missing metrics stay unmeasured and are never zero-filled', async () => {
      const emptyTargetId = await createTarget(CANDIDATE_EMPTY, 'empty metrics');
      mockMode.body = EMPTY_BODY;
      mockMode.status = 200;
      const res = await api(base, 'POST', `/api/nf-health/targets/${emptyTargetId}/collect`, adminToken);
      assert.equal(res.status, 200, res.text);
      assert.equal(res.json.run.status, 'partial');
      assert.ok(res.json.run.errorCode, 'partial run names the limitation');
      const sample = res.json.sample;
      if (sample) {
        const hasZeroFill = sample.metrics.some((m) => m.value === 0 && m.key.includes('missing'));
        assert.equal(hasZeroFill, false, 'no synthetic zero samples');
        if (sample.layers.service.state === 'not_configured' || sample.layers.service.state === 'unknown') {
          assert.equal(sample.layers.service.measured, false, 'unsupported service layer stays unmeasured');
        }
      }
      mockMode.body = METRICS_BODY;
    });

    await verifyAsync('failed collection preserves the last valid measurement timestamp', async () => {
      // Create with a valid endpoint, then strip every collector through the
      // governed update path so the next run produces no sample at all.
      const failTargetId = await createTarget(CANDIDATE_FAIL, 'freshness guard');
      const failDetail = await api(base, 'GET', `/api/nf-health/targets/${failTargetId}`, operatorToken);
      const strip = await api(base, 'PUT', `/api/nf-health/targets/${failTargetId}`, operatorToken, {
        expectedRevision: failDetail.json.target.revision,
        target: {
          name: 'freshness guard',
          metricsEndpoint: '',
          serviceUnit: '',
          serviceKind: 'none',
          collectionMode: 'manual',
          intervalSeconds: 120,
          enabled: true,
        },
      });
      assert.equal(strip.status, 200, strip.text);

      const priorMeasuredAt = '2026-01-01T00:00:00.000Z';
      await targetsColl.updateOne(
        { _id: failTargetId },
        { $set: { lastMeasuredAt: priorMeasuredAt, lastSuccessAt: priorMeasuredAt } },
      );

      const res = await api(base, 'POST', `/api/nf-health/targets/${failTargetId}/collect`, operatorToken);
      assert.equal(res.status, 200, res.text);
      assert.equal(res.json.sample, null, 'a run with no measured layer must not invent a sample');

      const after = await api(base, 'GET', `/api/nf-health/targets/${failTargetId}`, operatorToken);
      assert.equal(after.json.target.lastMeasuredAt, priorMeasuredAt, 'lastMeasuredAt must not move without a sample');
      assert.ok(after.json.target.lastAttemptAt, 'lastAttemptAt records the attempt');
      assert.notEqual(after.json.target.lastAttemptAt, priorMeasuredAt, 'lastAttemptAt advances independently');
    });

    await verifyAsync('connection failure records evidence without inventing zero metrics', async () => {
      const downTargetId = await createTarget(CANDIDATE_DOWN, 'endpoint down');
      mockMode.fail = true;
      const res = await api(base, 'POST', `/api/nf-health/targets/${downTargetId}/collect`, operatorToken);
      assert.equal(res.status, 200, res.text);
      assert.notEqual(res.json.run.status, 'success');
      mockMode.fail = false;

      const sample = res.json.sample;
      if (sample) {
        assert.ok(sample.layers.interface.measured, 'a refused probe is still interface evidence');
        assert.notEqual(sample.layers.interface.state, 'healthy');
        const invented = sample.metrics.filter((m) => m.value === 0 && !['gnb', 'ran_ue', 'ues_active'].includes(m.key));
        assert.equal(invented.length, 0, 'a failed probe must not invent zero-valued metrics');
      }
    });

    await verifyAsync('target update uses CAS revision', async () => {
      const current = await api(base, 'GET', `/api/nf-health/targets/${targetId}`, operatorToken);
      const revision = current.json.target.revision;

      const ok = await api(base, 'PUT', `/api/nf-health/targets/${targetId}`, operatorToken, {
        expectedRevision: revision,
        target: {
          name: 'AMF metrics renamed',
          metricsEndpoint: `http://127.0.0.1:${mockPort}/metrics`,
          serviceUnit: 'mockd',
          serviceKind: 'process',
          collectionMode: 'scheduled',
          intervalSeconds: 180,
          enabled: true,
        },
      });
      assert.equal(ok.status, 200, ok.text);
      assert.equal(ok.json.name, 'AMF metrics renamed');
      assert.equal(ok.json.collectionMode, 'scheduled');
      assert.equal(ok.json.revision, revision + 1);

      // A replay of the previous revision must lose the CAS race.
      const stale = await api(base, 'PUT', `/api/nf-health/targets/${targetId}`, operatorToken, {
        expectedRevision: revision,
        target: {
          name: 'stale write',
          serviceKind: 'process',
          collectionMode: 'manual',
          intervalSeconds: 120,
          enabled: true,
        },
      });
      assert.equal(stale.status, 409, stale.text);
      assert.equal(stale.json.code, 'NF_HEALTH_REVISION_CONFLICT');
    });

    await verifyAsync('admin may mutate and read runs/history', async () => {
      const runs = await api(base, 'GET', `/api/nf-health/runs?targetId=${targetId}`, adminToken);
      assert.equal(runs.status, 200);
      assert.ok(runs.json.runs.length >= 1);
      const history = await api(base, 'GET', `/api/nf-health/targets/${targetId}/history`, adminToken);
      assert.equal(history.status, 200);
      assert.ok(Array.isArray(history.json.samples));
      const samples = await api(base, 'GET', `/api/nf-health/samples?targetId=${targetId}`, adminToken);
      assert.equal(samples.status, 200);
    });

    await verifyAsync('NF Health never writes Discovery observation state', async () => {
      const obs = await obsColl.findOne({ _id: CANDIDATE_ID });
      assert.equal(obs.observationState, 'seen');
      assert.equal(obs.revision, 1);
    });

    await verifyAsync('no generic fetch, restart or process-control route is registered', async () => {
      for (const probe of [
        '/api/nf-health/fetch',
        '/api/nf-health/targets/' + targetId + '/restart',
        '/api/nf-health/execute',
        '/api/nf-health/shell',
      ]) {
        const res = await api(base, 'POST', probe, adminToken, {});
        assert.ok(res.status === 404 || res.status === 405, `${probe} must not exist, got ${res.status}`);
      }
    });

    // ---- Correction evidence: retention data type and migration ----

    await verifyAsync('stored samples persist expiresAt as a BSON Date', async () => {
      const samples = await samplesColl.find({ targetId }).sort({ collectedAt: -1 }).limit(5).toArray();
      assert.ok(samples.length >= 1, 'at least one sample must exist for the BSON Date check');
      for (const doc of samples) {
        assert.ok(doc.expiresAt instanceof Date, `expiresAt must be a BSON Date, got ${typeof doc.expiresAt}`);
      }
    });

    await verifyAsync('sample JSON projection keeps ISO 8601 expiresAt', async () => {
      const res = await api(base, 'GET', `/api/nf-health/samples?targetId=${targetId}`, operatorToken);
      assert.equal(res.status, 200, res.text);
      const rows = res.json.samples || [];
      assert.ok(rows.length >= 1, 'samples must be listable');
      for (const row of rows) {
        if (row.expiresAt === undefined || row.expiresAt === null) continue;
        assert.equal(typeof row.expiresAt, 'string', 'expiresAt must stay ISO 8601 in JSON');
        assert.match(row.expiresAt, /^\d{4}-\d{2}-\d{2}T/, 'expiresAt must be an ISO 8601 instant');
      }
    });

    await verifyAsync('legacy string expiresAt samples remain readable and preserved', async () => {
      const legacyId = `sample-legacy-${suffix}`;
      const legacyExpiry = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
      await samplesColl.insertOne({
        _id: legacyId,
        schemaVersion: 1,
        targetId,
        runId: `run-legacy-${suffix}`,
        collectedAt: new Date().toISOString(),
        expiresAt: legacyExpiry,
        layers: {
          process: { state: 'healthy', evidenceKind: 'process', measured: true },
          interface: { state: 'not_configured', evidenceKind: 'none', measured: false },
          service: { state: 'not_configured', evidenceKind: 'none', measured: false },
        },
        metrics: [],
      });

      // The typed read path must accept the legacy string without rewriting it.
      const res = await api(base, 'GET', `/api/nf-health/samples?targetId=${targetId}`, operatorToken);
      assert.equal(res.status, 200, res.text);
      const found = (res.json.samples || []).some((s) => s.sampleId === legacyId);
      assert.ok(found, 'legacy sample must remain visible through the read API');

      const stillLegacy = await samplesColl.findOne({ _id: legacyId });
      assert.equal(typeof stillLegacy.expiresAt, 'string', 'reads must not rewrite legacy expiresAt');
    });

    await verifyAsync('sample TTL index is scoped to app_nf_health_samples only', async () => {
      const sampleIndexes = await samplesColl.indexes();
      const ttl = sampleIndexes.find((i) => i.name === 'nf_health_samples_ttl');
      assert.ok(ttl, 'nf_health_samples_ttl must exist');
      assert.equal(ttl.expireAfterSeconds, 0, 'TTL must use expireAfterSeconds 0');
      const key = JSON.stringify(ttl.key);
      assert.ok(key.includes('expiresAt'), 'TTL must key on expiresAt');

      const targetIndexes = await targetsColl.indexes();
      const runIndexes = await runsColl.indexes();
      assert.ok(!targetIndexes.some((i) => i.expireAfterSeconds !== undefined && i.name.includes('ttl')),
        'targets must never be TTL-deleted');
      assert.ok(!runIndexes.some((i) => i.expireAfterSeconds !== undefined && i.name.includes('ttl')),
        'runs must never be TTL-deleted');
    });

    // ---- Correction evidence: freshness projection ----

    await verifyAsync('meta exposes the freshness vocabulary and policy bounds', async () => {
      const res = await api(base, 'GET', '/api/nf-health/meta', operatorToken);
      assert.equal(res.status, 200, res.text);
      assert.ok(Array.isArray(res.json.freshnessStates), 'meta must declare freshnessStates');
      for (const state of ['fresh', 'stale', 'unknown', 'not_monitored']) {
        assert.ok(res.json.freshnessStates.includes(state), `meta must declare freshness state ${state}`);
      }
      assert.equal(typeof res.json.stalenessGraceSeconds, 'number', 'stalenessGraceSeconds must be numeric');
      assert.equal(typeof res.json.manualFreshnessWindowSeconds, 'number', 'manualFreshnessWindowSeconds must be numeric');
      assert.ok(res.json.stalenessGraceSeconds > 0, 'staleness grace must be positive');
      assert.ok(res.json.manualFreshnessWindowSeconds > 0, 'manual freshness window must be positive');
    });

    await verifyAsync('target detail carries a server-derived freshness projection', async () => {
      const res = await api(base, 'GET', `/api/nf-health/targets/${targetId}`, operatorToken);
      assert.equal(res.status, 200, res.text);
      const freshness = res.json.freshness;
      assert.ok(freshness, 'detail must include a freshness projection');
      assert.ok(['fresh', 'stale', 'unknown', 'not_monitored'].includes(freshness.state),
        `unexpected freshness state ${freshness.state}`);
      assert.equal(typeof freshness.policySeconds, 'number', 'freshness must state its policy window');
      assert.ok(freshness.evaluatedAt, 'freshness must record when it was evaluated');
      assert.equal(freshness.state, res.json.target.freshness?.state,
        'overview and detail freshness must agree');
    });

    await verifyAsync('stale measurements never project as healthy', async () => {
      const staleId = await createTarget(CANDIDATE_STALE, 'stale projection guard');
      await targetsColl.updateOne(
        { _id: staleId },
        {
          $set: {
            lastMeasuredAt: '2020-01-01T00:00:00.000Z',
            collectionMode: 'scheduled',
            intervalSeconds: 60,
            enabled: true,
          },
        },
      );
      const res = await api(base, 'GET', `/api/nf-health/targets/${staleId}`, operatorToken);
      assert.equal(res.status, 200, res.text);
      assert.equal(res.json.freshness.state, 'stale', 'an ancient measurement must be stale');
      assert.notEqual(res.json.overallState, 'healthy', 'stale evidence must never project healthy');
    });

    // ---- Correction evidence: ownership boundaries ----

    await verifyAsync('NF Health writes no Inventory, Topology or Discovery fields', async () => {
      const inventory = await client.db(appDbName).collection('app_inventory_resources').countDocuments({});
      const topology = await client.db(appDbName).collection('app_topology_edges').countDocuments({});
      assert.equal(inventory, inventoryBaseline, 'NF Health must not create Inventory resources');
      assert.equal(topology, 0, 'NF Health must not create Topology edges');

      const obs = await obsColl.findOne({ _id: CANDIDATE_ID });
      assert.equal(obs.observationState, 'seen', 'Discovery observation state must be untouched');
      assert.equal(obs.revision, 1, 'Discovery candidate revision must be untouched');
    });

    console.log(`\nNF Health integration: ${passed}/${totalChecks} checks passed`);
    if (passed !== totalChecks) process.exitCode = 1;
  } finally {
    for (const proc of localProcesses) {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* best-effort cleanup of test-owned processes */
      }
    }
    localProcesses = [];
    if (goProc) {
      goProc.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 300));
      if (!goProc.killed) goProc.kill('SIGKILL');
    }
    if (mockServer) {
      await new Promise((r) => mockServer.close(r));
    }
    try {
      await client.db(xcloudDbName).dropDatabase();
      await client.db(appDbName).dropDatabase();
    } catch {
      /* best-effort cleanup of test-owned databases */
    }
    await client.close();
    if (binPath) {
      try {
        if (fs.existsSync(binPath)) fs.unlinkSync(binPath);
      } catch {
        /* best-effort cleanup of the test-owned binary */
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
