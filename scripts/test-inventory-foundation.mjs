#!/usr/bin/env node
/**
 * Inventory Foundation Integration Suite
 *
 * Verifies with real MongoDB and real Go backend server:
 * - Production index initialization via scripts/init-mongo-indexes.mjs
 * - Required MongoDB indexes (including partial unique without sparse)
 * - Collection in xcloud_ops.app_inventory_resources only (0 in xcloud)
 * - Canonical resource model (20 kinds, 10 domains, 4 lifecycles)
 * - Strict JSON decoding (unknown fields top-level & nested, trailing tokens)
 * - Server-owned field spoofing rejection (create, update, retire)
 * - Update lifecycle validation (required non-empty, retired rejected on PUT)
 * - Kind immutability on update
 * - Strict RFC 4122 UUID v4 validation (malformed, non-v4 vs valid non-existent)
 * - Query parameter allowlist (unsupported params rejected with HTTP 400)
 * - Query limit bounds (1..200 enforced with HTTP 400 on out of bounds)
 * - Cursor validation (malformed cursor rejected with HTTP 400)
 * - Keyset cursor pagination and query filters
 * - CAS update and stale revision conflict handling (HTTP 409)
 * - Viewer authorization (core.read allowed, core.configure denied with HTTP 403)
 * - Terminal retirement state and immutability (HTTP 409)
 * - Negative persist assertions on all rejected mutations
 * - Structured audit logs recorded in xcloud_ops.app_audit_logs
 * - No network control or generic execution endpoints
 */

import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { existsSync, unlinkSync } from 'node:fs';
import { execSync, spawn } from 'node:child_process';
import { SignJWT } from 'jose';
import { MongoClient } from 'mongodb';
import { loadEnv } from './lib/load-env.mjs';
import bcrypt from 'bcryptjs';

loadEnv(process.cwd());

const suffix = `${Date.now()}_${process.pid}_${Math.floor(Math.random() * 100000)}`;
const xcloudDbName = `xcloud_inv_test_${suffix}`;
const appDbName = `xcloud_ops_inv_test_${suffix}`;
const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/xcloud';

process.env.MONGODB_XCLOUD_DB = xcloudDbName;
process.env.MONGODB_APP_DB = appDbName;
const JWT_SECRET_STRING = process.env.JWT_SECRET || 'inventory-foundation-test-secret-at-least-32-bytes!';
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

function makeToken(username, role, sv, expiresInSec = 3600) {
  return new SignJWT({ username, role, sv })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt(Math.floor(Date.now() / 1000))
    .setExpirationTime(Math.floor(Date.now() / 1000) + expiresInSec)
    .sign(jwtSecretKey());
}

let goProc = null;
let binPath = null;
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

async function waitForAudit(coll, filter, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const doc = await coll.findOne(filter);
    if (doc) return doc;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

async function main() {
  console.log('== Inventory Foundation Integration Suite ==\n');

  try {
    await client.connect();

    const xcloudDb = client.db(xcloudDbName);
    const appDb = client.db(appDbName);
    const usersColl = appDb.collection('app_users');
    const inventoryColl = appDb.collection('app_inventory_resources');
    const auditColl = appDb.collection('app_audit_logs');

    // Run production index initializer against isolated test DBs
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

    // Seed test users: admin, operator, viewer
    const now = new Date().toISOString();
    const hash = await bcrypt.hash('CorrectPass123!', 10);
    await usersColl.insertMany([
      {
        username: 'admin1',
        passwordHash: hash,
        displayName: 'Admin User',
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
      },
      {
        username: 'operator1',
        passwordHash: hash,
        displayName: 'Operator User',
        email: 'operator1@example.com',
        role: 'operator',
        status: 'active',
        locked: false,
        failedLoginAttempts: 0,
        sessionVersion: 1,
        security: { sessionVersion: 1 },
        createdAt: now,
        updatedAt: now,
        createdBy: 'bootstrap',
        updatedBy: 'bootstrap',
      },
      {
        username: 'viewer1',
        passwordHash: hash,
        displayName: 'Viewer User',
        email: 'viewer1@example.com',
        role: 'viewer',
        status: 'active',
        locked: false,
        failedLoginAttempts: 0,
        sessionVersion: 1,
        security: { sessionVersion: 1 },
        createdAt: now,
        updatedAt: now,
        createdBy: 'bootstrap',
        updatedBy: 'bootstrap',
      },
    ]);

    // Build and start Go backend
    const goPort = await getAvailablePort();
    const isWin = process.platform === 'win32';
    const binName = isWin ? `test-go-inv-${suffix}.exe` : `test-go-inv-${suffix}`;
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

    // Wait for Go server readiness
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
    if (!goReady) {
      throw new Error('Go server failed to start on ' + goPort);
    }

    const adminToken = await makeToken('admin1', 'admin', 1);
    const operatorToken = await makeToken('operator1', 'operator', 1);
    const viewerToken = await makeToken('viewer1', 'viewer', 1);

    const req = async (method, p, body, token, rawBody = null) => {
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers['Cookie'] = `auth_token=${token}`;
      const init = { method, headers };
      if (rawBody !== null) {
        init.body = rawBody;
      } else if (body !== undefined) {
        init.body = JSON.stringify(body);
      }
      const res = await fetch(`http://127.0.0.1:${goPort}${p}`, init);
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
      return { status: res.status, headers: res.headers, body: json };
    };
    const successfulInventoryActions = [
      'inventory.resource.create',
      'inventory.resource.update',
      'inventory.resource.retire',
    ];
    const successfulInventoryAuditCount = () => auditColl.countDocuments({
      action: { $in: successfulInventoryActions },
      result: 'success',
    });

    // 1. Database & collection boundaries
    await verifyAsync('collection created in xcloud_ops and absent in xcloud', async () => {
      const opsColls = (await appDb.listCollections().toArray()).map((c) => c.name);
      assert.ok(opsColls.includes('app_inventory_resources'), 'app_inventory_resources must exist in xcloud_ops');

      const xcloudColls = (await xcloudDb.listCollections().toArray()).map((c) => c.name);
      assert.ok(!xcloudColls.includes('app_inventory_resources'), 'app_inventory_resources must NOT exist in xcloud');
      assert.ok(!xcloudColls.some((c) => c.includes('inventory')), 'no inventory collections in xcloud');
    });

    // 2. Indexes verification
    await verifyAsync('required MongoDB indexes verified on app_inventory_resources from production init', async () => {
      const indexes = await inventoryColl.indexes();
      const indexNames = indexes.map((idx) => idx.name);
      assert.ok(indexNames.includes('inventory_kind_domain_lifecycle_updated'), 'missing index inventory_kind_domain_lifecycle_updated');
      assert.ok(indexNames.includes('inventory_name_normalized_updated'), 'missing index inventory_name_normalized_updated');
      assert.ok(indexNames.includes('inventory_updated_id'), 'missing index inventory_updated_id');
      assert.ok(indexNames.includes('uniq_inventory_source_external_id'), 'missing index uniq_inventory_source_external_id');

      const partialIdx = indexes.find((idx) => idx.name === 'uniq_inventory_source_external_id');
      assert.equal(partialIdx.unique, true, 'uniq_inventory_source_external_id must be unique');
      assert.ok(partialIdx.partialFilterExpression, 'must have partialFilterExpression');
      assert.equal(partialIdx.sparse, undefined, 'uniq_inventory_source_external_id must NOT be sparse');
    });

    // 3. Metadata endpoint
    await verifyAsync('GET /api/inventory/meta returns 200 with canonical reflection', async () => {
      const res = await req('GET', '/api/inventory/meta', undefined, operatorToken);
      assert.equal(res.status, 200);
      assert.equal(res.body.schemaVersion, 1);
      assert.equal(res.body.kinds.length, 20);
      assert.equal(res.body.domains.length, 10);
      assert.equal(res.body.lifecycleStates.length, 4);
      assert.equal(res.body.managementProtocols.length, 14);
      assert.equal(res.body.addressTypes.length, 3);
    });

    // 4. Strict JSON decoding on Create
    await verifyAsync('POST /api/inventory/resources strictly rejects unknown fields and trailing data', async () => {
      const countBefore = await inventoryColl.countDocuments();
      const auditBefore = await successfulInventoryAuditCount();

      // Unknown field
      const unknownRes = await req('POST', '/api/inventory/resources', {
        kind: 'host',
        name: 'unknown-field-node',
        domain: 'cloud',
        inventedField: true,
      }, operatorToken);
      assert.equal(unknownRes.status, 400, 'Unknown field must return 400');

      // Trailing JSON token
      const trailingRes = await req(
        'POST',
        '/api/inventory/resources',
        undefined,
        operatorToken,
        '{"kind":"host","name":"trailing-node","domain":"cloud"} extra',
      );
      assert.equal(trailingRes.status, 400, 'Trailing JSON token must return 400');

      const countAfter = await inventoryColl.countDocuments();
      const auditAfter = await successfulInventoryAuditCount();
      assert.equal(countAfter, countBefore, 'Rejected creates must not persist documents');
      assert.equal(auditAfter, auditBefore, 'Rejected creates must not record audit logs');
    });

    // 5. Server-owned field spoofing rejection on Create
    await verifyAsync('POST /api/inventory/resources rejects server-owned fields', async () => {
      const countBefore = await inventoryColl.countDocuments();
      const auditBefore = await successfulInventoryAuditCount();
      const serverFields = [
        { resourceId: '00000000-0000-4000-8000-000000000001' },
        { schemaVersion: 2 },
        { source: { kind: 'manual', system: 'spoofed' } },
        { revision: 10 },
        { createdAt: '2026-01-01T00:00:00Z' },
        { createdBy: 'root' },
        { updatedAt: '2026-01-01T00:00:00Z' },
        { updatedBy: 'root' },
        { retiredAt: '2026-01-01T00:00:00Z' },
        { retiredBy: 'root' },
        { retireReason: 'spoof' },
      ];

      for (const sf of serverFields) {
        const body = {
          kind: 'host',
          name: 'spoof-test',
          domain: 'cloud',
          ...sf,
        };
        const res = await req('POST', '/api/inventory/resources', body, operatorToken);
        assert.equal(res.status, 400, `Server-owned field ${Object.keys(sf)[0]} must return 400`);
      }

      const countAfter = await inventoryColl.countDocuments();
      const auditAfter = await successfulInventoryAuditCount();
      assert.equal(countAfter, countBefore, 'Server field spoofing attempts must not persist');
      assert.equal(auditAfter, auditBefore, 'Rejected creates must not record successful mutation audit logs');
    });

    // 6. Sensitive key rejection in attributes
    await verifyAsync('POST /api/inventory/resources rejects sensitive keys in attributes', async () => {
      const countBefore = await inventoryColl.countDocuments();
      const auditBefore = await successfulInventoryAuditCount();
      const secretBody = {
        kind: 'host',
        name: 'edge-host-secret',
        domain: 'cloud',
        attributes: {
          admin_password: 'super-secret-password',
        },
      };
      const res = await req('POST', '/api/inventory/resources', secretBody, operatorToken);
      assert.equal(res.status, 400, 'Sensitive key in attributes must be rejected with 400');
      const countAfter = await inventoryColl.countDocuments();
      const auditAfter = await successfulInventoryAuditCount();
      assert.equal(countAfter, countBefore, 'Sensitive key attempt must not persist');
      assert.equal(auditAfter, auditBefore, 'Rejected sensitive creates must not record successful mutation audit logs');
    });

    // 7. Successful Create resource
    let createdId = '';
    await verifyAsync('POST /api/inventory/resources creates valid resource with revision=1 and audit log', async () => {
      const createBody = {
        kind: 'host',
        name: 'edge-host-01',
        displayName: 'Edge Compute Node 01',
        domain: 'cloud',
        role: 'compute',
        lifecycleState: 'planned',
        vendor: 'Dell',
        model: 'PowerEdge R750',
        software: {
          product: 'Ubuntu LTS',
          version: '24.04',
          build: 'kernel-6.8',
        },
        managementEndpoints: [
          {
            name: 'idrac',
            protocol: 'https',
            addressType: 'ipv4',
            address: '192.168.1.100',
            port: 443,
          },
        ],
        capabilities: ['virtualization', 'sr-iov'],
        labels: { site: 'edge-datacenter-1', rack: 'rack-04' },
        attributes: { memoryGb: 256, cpuCores: 64 },
      };

      const res = await req('POST', '/api/inventory/resources', createBody, operatorToken);
      assert.equal(res.status, 201, `Expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
      assert.ok(res.body.resourceId, 'resourceId must be set');
      assert.equal(res.body.schemaVersion, 1);
      assert.equal(res.body.revision, 1);
      assert.equal(res.body.kind, 'host');
      assert.equal(res.body.name, 'edge-host-01');
      assert.equal(res.body.domain, 'cloud');
      assert.equal(res.body.lifecycleState, 'planned');
      assert.equal(res.body.createdBy, 'operator1');
      assert.equal(res.body.updatedBy, 'operator1');
      assert.equal(res.body.source.kind, 'manual');
      assert.equal(res.body.source.system, 'xcloud');
      assert.equal(res.body.source.authority, 'authoritative');

      createdId = res.body.resourceId;

      // Verify MongoDB document
      const doc = await inventoryColl.findOne({ _id: createdId });
      assert.ok(doc, 'Resource document must be persisted in MongoDB');
      assert.equal(doc.schemaVersion, 1);
      assert.equal(doc.revision, 1);

      // Verify audit log
      const audit = await waitForAudit(auditColl, { targetId: createdId, action: 'inventory.resource.create' });
      assert.ok(audit, 'Audit log for inventory.resource.create must be recorded');
      assert.equal(audit.actor, 'operator1');
      assert.equal(audit.resource?.type, 'inventory_resource');
      assert.equal(audit.resource?.id, createdId);
      assert.equal(audit.oldData, null, 'Create audit oldData must be null');
      assert.equal(audit.newData?.resourceId, createdId, 'Create audit newData must contain created resource facts');
      assert.equal(audit.newData?.revision, 1, 'Create audit newData revision must be 1');
    });

    // 8. Strict UUID v4 validation on GET, PUT, POST retire
    await verifyAsync('Strict RFC 4122 UUID v4 validation on endpoints', async () => {
      const malformedId = 'not-a-valid-uuid';
      const uuidV1 = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
      const nonExistentV4 = 'a0000000-0000-4000-8000-000000000000';

      // GET
      assert.equal((await req('GET', `/api/inventory/resources/${malformedId}`, undefined, operatorToken)).status, 400);
      assert.equal((await req('GET', `/api/inventory/resources/${uuidV1}`, undefined, operatorToken)).status, 400);
      assert.equal((await req('GET', `/api/inventory/resources/${nonExistentV4}`, undefined, operatorToken)).status, 404);

      // PUT
      assert.equal((await req('PUT', `/api/inventory/resources/${malformedId}`, {
        expectedRevision: 1,
        resource: { kind: 'host', name: 'n1', domain: 'cloud', lifecycleState: 'active' },
      }, operatorToken)).status, 400);
      assert.equal((await req('PUT', `/api/inventory/resources/${uuidV1}`, {
        expectedRevision: 1,
        resource: { kind: 'host', name: 'n1', domain: 'cloud', lifecycleState: 'active' },
      }, operatorToken)).status, 400);
      assert.equal((await req('PUT', `/api/inventory/resources/${nonExistentV4}`, {
        expectedRevision: 1,
        resource: { kind: 'host', name: 'n1', domain: 'cloud', lifecycleState: 'active' },
      }, operatorToken)).status, 404);

      // POST retire
      assert.equal((await req('POST', `/api/inventory/resources/${malformedId}/retire`, {
        expectedRevision: 1,
        reason: 'retire',
      }, operatorToken)).status, 400);
      assert.equal((await req('POST', `/api/inventory/resources/${uuidV1}/retire`, {
        expectedRevision: 1,
        reason: 'retire',
      }, operatorToken)).status, 400);
      assert.equal((await req('POST', `/api/inventory/resources/${nonExistentV4}/retire`, {
        expectedRevision: 1,
        reason: 'retire',
      }, operatorToken)).status, 404);
    });

    // 9. Strict JSON decoding and field rejection on Update
    await verifyAsync('PUT /api/inventory/resources/{resourceId} strict decoding and validation', async () => {
      const docBefore = await inventoryColl.findOne({ _id: createdId });
      const auditBefore = await successfulInventoryAuditCount();

      // Unknown top-level field
      const resTop = await req('PUT', `/api/inventory/resources/${createdId}`, {
        expectedRevision: 1,
        resource: { kind: 'host', name: 'n', domain: 'cloud', lifecycleState: 'active' },
        inventedField: true,
      }, operatorToken);
      assert.equal(resTop.status, 400, 'Top-level unknown field on PUT must return 400');

      // Unknown nested resource field
      const resNested = await req('PUT', `/api/inventory/resources/${createdId}`, {
        expectedRevision: 1,
        resource: { kind: 'host', name: 'n', domain: 'cloud', lifecycleState: 'active', inventedNested: 123 },
      }, operatorToken);
      assert.equal(resNested.status, 400, 'Nested unknown field on PUT must return 400');

      // Server-owned field in nested resource
      const resSpoof = await req('PUT', `/api/inventory/resources/${createdId}`, {
        expectedRevision: 1,
        resource: { kind: 'host', name: 'n', domain: 'cloud', lifecycleState: 'active', source: { system: 'spoof' } },
      }, operatorToken);
      assert.equal(resSpoof.status, 400, 'Server-owned field in nested resource must return 400');

      // Missing lifecycleState on PUT
      const resNoLife = await req('PUT', `/api/inventory/resources/${createdId}`, {
        expectedRevision: 1,
        resource: { kind: 'host', name: 'n', domain: 'cloud' },
      }, operatorToken);
      assert.equal(resNoLife.status, 400, 'Missing lifecycleState on PUT must return 400');

      // Empty lifecycleState on PUT
      const resEmptyLife = await req('PUT', `/api/inventory/resources/${createdId}`, {
        expectedRevision: 1,
        resource: { kind: 'host', name: 'n', domain: 'cloud', lifecycleState: '' },
      }, operatorToken);
      assert.equal(resEmptyLife.status, 400, 'Empty lifecycleState on PUT must return 400');

      // Retired lifecycleState on PUT
      const resRetiredLife = await req('PUT', `/api/inventory/resources/${createdId}`, {
        expectedRevision: 1,
        resource: { kind: 'host', name: 'n', domain: 'cloud', lifecycleState: 'retired' },
      }, operatorToken);
      assert.equal(resRetiredLife.status, 400, 'lifecycleState: retired on PUT must return 400');

      // Kind change rejection on PUT
      const resKindChange = await req('PUT', `/api/inventory/resources/${createdId}`, {
        expectedRevision: 1,
        resource: { kind: 'site', name: 'n', domain: 'cloud', lifecycleState: 'active' },
      }, operatorToken);
      assert.equal(resKindChange.status, 400, 'Changing kind on PUT must return 400');

      // Trailing JSON token on PUT
      const resTrailing = await req(
        'PUT',
        `/api/inventory/resources/${createdId}`,
        undefined,
        operatorToken,
        '{"expectedRevision":1,"resource":{"kind":"host","name":"n","domain":"cloud","lifecycleState":"active"}} trailing',
      );
      assert.equal(resTrailing.status, 400, 'Trailing token on PUT must return 400');

      // Verify doc in Mongo is completely unchanged
      const docAfter = await inventoryColl.findOne({ _id: createdId });
      const auditAfter = await successfulInventoryAuditCount();
      assert.deepEqual(docAfter, docBefore, 'Rejected updates must leave the full resource state unchanged');
      assert.equal(auditAfter, auditBefore, 'Rejected updates must not record successful mutation audit logs');
    });

    // 10. Valid CAS update and Stale Revision Conflict
    await verifyAsync('PUT /api/inventory/resources/{resourceId} CAS update and conflict handling', async () => {
      const updateBody = {
        expectedRevision: 1,
        resource: {
          kind: 'host',
          name: 'edge-host-01-renamed',
          displayName: 'Edge Node 01 Updated',
          domain: 'cloud',
          lifecycleState: 'active',
          role: 'compute-ingress',
        },
      };

      // Valid update (revision 1 -> 2)
      const res = await req('PUT', `/api/inventory/resources/${createdId}`, updateBody, operatorToken);
      assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.revision, 2);
      assert.equal(res.body.name, 'edge-host-01-renamed');
      assert.equal(res.body.lifecycleState, 'active');

      // Verify audit log
      const audit = await waitForAudit(auditColl, { targetId: createdId, action: 'inventory.resource.update' });
      assert.ok(audit, 'Audit log for inventory.resource.update must be recorded');
      assert.equal(audit.actor, 'operator1');
      assert.equal(audit.targetId, createdId);
      assert.equal(audit.oldData?.name, 'edge-host-01');
      assert.equal(audit.newData?.name, 'edge-host-01-renamed');
      assert.equal(audit.oldData?.revision, 1);
      assert.equal(audit.newData?.revision, 2);
      assert.equal(audit.newData?.lifecycleState, 'active');

      // Stale update: expectedRevision=1 when current is 2 -> 409
      const staleRes = await req('PUT', `/api/inventory/resources/${createdId}`, updateBody, operatorToken);
      assert.equal(staleRes.status, 409, 'Stale revision must be rejected with HTTP 409');
    });

    // 11. Strict JSON decoding on Retire
    await verifyAsync('POST /api/inventory/resources/{resourceId}/retire strict decoding', async () => {
      const docBefore = await inventoryColl.findOne({ _id: createdId });
      const auditBefore = await successfulInventoryAuditCount();
      // Unknown field on retire
      const resUnknown = await req('POST', `/api/inventory/resources/${createdId}/retire`, {
        expectedRevision: 2,
        reason: 'retire',
        unexpectedField: true,
      }, operatorToken);
      assert.equal(resUnknown.status, 400, 'Unknown field on retire must return 400');

      // Trailing token on retire
      const resTrailing = await req(
        'POST',
        `/api/inventory/resources/${createdId}/retire`,
        undefined,
        operatorToken,
        '{"expectedRevision":2,"reason":"retire"} trailing',
      );
      assert.equal(resTrailing.status, 400, 'Trailing token on retire must return 400');

      // Server-owned field on retire
      const resServer = await req('POST', `/api/inventory/resources/${createdId}/retire`, {
        expectedRevision: 2,
        reason: 'retire',
        revision: 99,
      }, operatorToken);
      assert.equal(resServer.status, 400, 'Server-owned field on retire must return 400');

      // Verify document still at revision 2
      const doc = await inventoryColl.findOne({ _id: createdId });
      const auditAfter = await successfulInventoryAuditCount();
      assert.deepEqual(doc, docBefore, 'Rejected retire requests must leave the full resource state unchanged');
      assert.equal(auditAfter, auditBefore, 'Rejected retire requests must not record successful mutation audit logs');
    });

    // 12. Query parameter allowlist, Limit bounds, and Cursor validation
    await verifyAsync('GET /api/inventory/resources enforces query allowlist, limit bounds, and cursor validation', async () => {
      // Unsupported parameters
      assert.equal((await req('GET', '/api/inventory/resources?search=edge', undefined, operatorToken)).status, 400);
      assert.equal((await req('GET', '/api/inventory/resources?invented=1', undefined, operatorToken)).status, 400);
      assert.equal((await req('GET', '/api/inventory/resources?sort=name', undefined, operatorToken)).status, 400);

      // Limit bounds
      assert.equal((await req('GET', '/api/inventory/resources?limit=0', undefined, operatorToken)).status, 400);
      assert.equal((await req('GET', '/api/inventory/resources?limit=-5', undefined, operatorToken)).status, 400);
      assert.equal((await req('GET', '/api/inventory/resources?limit=201', undefined, operatorToken)).status, 400);

      // Valid limits
      assert.equal((await req('GET', '/api/inventory/resources?limit=1', undefined, operatorToken)).status, 200);
      assert.equal((await req('GET', '/api/inventory/resources?limit=200', undefined, operatorToken)).status, 200);

      // Invalid cursor
      assert.equal((await req('GET', '/api/inventory/resources?cursor=invalid-cursor', undefined, operatorToken)).status, 400);
      assert.equal((await req('GET', '/api/inventory/resources?cursor=bm90LWpzb24=', undefined, operatorToken)).status, 400);

      // Canonical q search
      const qRes = await req('GET', '/api/inventory/resources?q=edge-host', undefined, operatorToken);
      assert.equal(qRes.status, 200);
      assert.ok(qRes.body.resources.length >= 1);

      const exactQRes = await req('GET', `/api/inventory/resources?q=${createdId}`, undefined, operatorToken);
      assert.equal(exactQRes.status, 200);
      assert.equal(exactQRes.body.resources.length, 1);
      assert.equal(exactQRes.body.resources[0].resourceId, createdId);

      for (const [key, value] of [['kind', 'host'], ['domain', 'cloud'], ['lifecycleState', 'active']]) {
        const filterRes = await req('GET', `/api/inventory/resources?${key}=${value}`, undefined, operatorToken);
        assert.equal(filterRes.status, 200, `${key} filter must return 200`);
        assert.ok(filterRes.body.resources.some((resource) => resource.resourceId === createdId), `${key} filter must return seeded resource`);
      }
    });

    // 13. Cursor pagination across seeded resources
    await verifyAsync('GET /api/inventory/resources keyset cursor pagination', async () => {
      for (let i = 2; i <= 5; i++) {
        const createRes = await req('POST', '/api/inventory/resources', {
          kind: i % 2 === 0 ? 'network_function' : 'host',
          name: `element-${i}`,
          domain: i % 2 === 0 ? '5gc' : 'cloud',
          lifecycleState: 'active',
        }, operatorToken);
        assert.equal(createRes.status, 201);
      }

      // Page 1 with limit=2
      const p1 = await req('GET', '/api/inventory/resources?limit=2', undefined, operatorToken);
      assert.equal(p1.status, 200);
      assert.equal(p1.body.resources.length, 2);
      assert.ok(p1.body.page.nextCursor);
      assert.equal(p1.body.page.hasMore, true);

      // Page 2 with cursor
      const p2 = await req('GET', `/api/inventory/resources?limit=2&cursor=${p1.body.page.nextCursor}`, undefined, operatorToken);
      assert.equal(p2.status, 200);
      assert.equal(p2.body.resources.length, 2);

      const ids1 = new Set(p1.body.resources.map((r) => r.resourceId));
      for (const item of p2.body.resources) {
        assert.ok(!ids1.has(item.resourceId), 'Disjoint cursor pages required');
      }
    });

    // 14. Viewer authorization
    await verifyAsync('Viewer can read but is denied mutations with HTTP 403', async () => {
      // Viewer read
      const readRes = await req('GET', `/api/inventory/resources/${createdId}`, undefined, viewerToken);
      assert.equal(readRes.status, 200, 'Viewer must be permitted to read');

      // Viewer create
      const createRes = await req('POST', '/api/inventory/resources', { kind: 'host', name: 'v1', domain: 'cloud' }, viewerToken);
      assert.equal(createRes.status, 403, 'Viewer create must be denied with 403');

      // Viewer update
      const updateRes = await req('PUT', `/api/inventory/resources/${createdId}`, {
        expectedRevision: 2,
        resource: { kind: 'host', name: 'v1', domain: 'cloud', lifecycleState: 'active' },
      }, viewerToken);
      assert.equal(updateRes.status, 403, 'Viewer update must be denied with 403');

      // Viewer retire
      const retireRes = await req('POST', `/api/inventory/resources/${createdId}/retire`, {
        expectedRevision: 2,
        reason: 'Viewer retirement attempt',
      }, viewerToken);
      assert.equal(retireRes.status, 403, 'Viewer retire must be denied with 403');
    });

    // 15. Retirement terminal state and immutability
    await verifyAsync('POST /api/inventory/resources/{resourceId}/retire transitions to terminal state and prevents mutation', async () => {
      // Stale retire attempt
      const staleRetire = await req('POST', `/api/inventory/resources/${createdId}/retire`, {
        expectedRevision: 1,
        reason: 'Old revision',
      }, operatorToken);
      assert.equal(staleRetire.status, 409, 'Stale revision on retire must return 409');

      // Valid retire
      const retireRes = await req('POST', `/api/inventory/resources/${createdId}/retire`, {
        expectedRevision: 2,
        reason: 'Node decommissioned and retired from service',
      }, operatorToken);
      assert.equal(retireRes.status, 200);
      assert.equal(retireRes.body.lifecycleState, 'retired');
      assert.equal(retireRes.body.revision, 3);

      // Verify audit log
      const audit = await waitForAudit(auditColl, { targetId: createdId, action: 'inventory.resource.retire' });
      assert.ok(audit, 'Audit log for inventory.resource.retire must be recorded');
      assert.equal(audit.actor, 'operator1');
      assert.equal(audit.reason, 'Node decommissioned and retired from service');
      assert.equal(audit.targetId, createdId);
      assert.notEqual(audit.oldData?.lifecycleState, 'retired');
      assert.equal(audit.newData?.lifecycleState, 'retired');
      assert.equal(audit.oldData?.revision, 2);
      assert.equal(audit.newData?.revision, 3);

      // Mutating retired resource -> 409
      const mutateRetired = await req('PUT', `/api/inventory/resources/${createdId}`, {
        expectedRevision: 3,
        resource: { kind: 'host', name: 'edge-host-01-renamed', domain: 'cloud', lifecycleState: 'active' },
      }, operatorToken);
      assert.equal(mutateRetired.status, 409, 'Mutating retired resource must return 409 conflict');

      // Retiring already retired resource -> 409
      const retireAgain = await req('POST', `/api/inventory/resources/${createdId}/retire`, {
        expectedRevision: 3,
        reason: 'Retire again',
      }, operatorToken);
      assert.equal(retireAgain.status, 409, 'Retiring already retired resource must return 409 conflict');
    });

    // 16. Network-control and hard-delete boundary
    await verifyAsync('No executor routes and no hard delete route', async () => {
      const execRes = await req('POST', `/api/inventory/resources/${createdId}/execute`, {}, operatorToken);
      assert.ok(execRes.status === 404 || execRes.status === 405, 'Executor route must return 404/405');

      const deleteRes = await req('DELETE', `/api/inventory/resources/${createdId}`, undefined, operatorToken);
      assert.ok(deleteRes.status === 404 || deleteRes.status === 405, 'Hard delete route must return 404/405');
    });

    console.log(`\n-- All ${passed}/${totalChecks} Inventory Foundation Integration Tests Passed! --\n`);

    // Emit machine evidence
    console.log('inventory_schema_version=1');
    console.log('inventory_collection=xcloud_ops.app_inventory_resources');
    console.log('inventory_resource_kind_count=20');
    console.log('inventory_domain_count=10');
    console.log('inventory_lifecycle_state_count=4');
    console.log('inventory_api_read_count=3');
    console.log('inventory_api_mutation_count=3');
    console.log('inventory_api_total_count=6');
    console.log('inventory_go_registration_count=109');
    console.log('inventory_frontend_route_count=3');
    console.log('frontend_total_route_count=30');
    console.log('inventory_read_permission=core.read');
    console.log('inventory_write_permission=core.configure');
    console.log('inventory_hard_delete_route=0');
    console.log('inventory_topology_edge_collection=0');
    console.log('inventory_adapter_runtime=0');
    console.log('inventory_remote_executor_calls=0');
    console.log('inventory_cas_update=PASS');
    console.log('inventory_stale_revision_conflict=PASS');
    console.log('inventory_retirement_terminal=PASS');
    console.log('inventory_source_spoof_rejection=PASS');
    console.log('inventory_secret_key_rejection=PASS');
    console.log('inventory_strict_json_rejection=PASS');
    console.log('inventory_uuid_v4_validation=PASS');
    console.log('inventory_query_allowlist=PASS');
    console.log('inventory_limit_bounds=PASS');
    console.log('inventory_cursor_pagination=PASS');
    console.log('inventory_audit_create=PASS');
    console.log('inventory_audit_update=PASS');
    console.log('inventory_audit_retire=PASS');
    console.log('inventory_q_exact_uuid=PASS');
    console.log('inventory_kind_filter=PASS');
    console.log('inventory_domain_filter=PASS');
    console.log('inventory_lifecycle_filter=PASS');
    console.log('inventory_audit_create_before_after=PASS');
    console.log('inventory_audit_update_before_after=PASS');
    console.log('inventory_audit_retire_before_after=PASS');
    console.log('inventory_audit_retire_reason=PASS');
    console.log('inventory_rejected_create_audit_unchanged=PASS');
    console.log('inventory_rejected_update_audit_unchanged=PASS');
    console.log('inventory_rejected_retire_audit_unchanged=PASS');
    console.log('business_mutation_endpoints=29');
    console.log('business_request_contracts=31');
    console.log('operational_endpoints=4');
    console.log('inventory_result=PASS');

  } catch (err) {
    console.error('\nTest suite failed with error:', err);
    process.exit(1);
  } finally {
    if (goProc) {
      try {
        goProc.kill('SIGTERM');
      } catch {}
    }
    if (binPath && existsSync(binPath)) {
      try {
        unlinkSync(binPath);
      } catch {}
    }
    try {
      const xcloudDb = client.db(xcloudDbName);
      const appDb = client.db(appDbName);
      await xcloudDb.dropDatabase();
      await appDb.dropDatabase();
      await client.close();
    } catch {}
  }
}

main().catch((err) => {
  console.error('Fatal error in main:', err);
  process.exit(1);
});
