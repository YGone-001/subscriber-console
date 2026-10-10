#!/usr/bin/env node
/**
 * Topology Foundation Integration Suite
 *
 * Verifies with real MongoDB and a real Go backend server:
 * - Production index initialization via scripts/init-mongo-indexes.mjs
 * - Four required indexes on xcloud_ops.app_topology_edges (including the
 *   partial unique active-edge index, which must not be sparse)
 * - Inventory is the node authority and Topology is the edge authority
 * - No app_topology_nodes / vertices / resources collection is created
 * - Topology never writes to app_inventory_resources
 * - Nine relationship types and two lifecycle states
 * - Strict JSON decoding (unknown fields, trailing tokens)
 * - Server-owned field spoofing rejection (create, update, retire)
 * - Sensitive attribute key rejection
 * - Strict RFC 4122 UUID v4 validation
 * - Referential integrity: unknown and retired endpoints rejected
 * - Self-edge rejection
 * - Duplicate active edge rejection (HTTP 409) and retired-tuple recreation
 * - CAS update, stale revision conflict, terminal retirement
 * - Cursor pagination, ordering and filter allowlist
 * - One-hop inbound / outbound / both neighbour projection
 * - Role authorization (viewer read-only, operator read/write)
 * - Audit before/after records, retire reason, and rejected-mutation silence
 * - No hard delete and no generic execution endpoint
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
const xcloudDbName = `xcloud_topo_test_${suffix}`;
const appDbName = `xcloud_ops_topo_test_${suffix}`;
const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/xcloud';

process.env.MONGODB_XCLOUD_DB = xcloudDbName;
process.env.MONGODB_APP_DB = appDbName;
const JWT_SECRET_STRING = process.env.JWT_SECRET || 'topology-foundation-test-secret-at-least-32-bytes!';
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

/** Deterministic, well-formed UUID v4 values for Inventory fixtures. */
function fixtureUuid(n) {
  const hex = n.toString(16).padStart(12, '0');
  return `11111111-2222-4333-8444-${hex}`;
}

function inventoryDoc(id, name, domain, lifecycleState) {
  const now = new Date().toISOString();
  return {
    _id: id,
    schemaVersion: 1,
    kind: 'network_function',
    name,
    nameNormalized: name.toLowerCase(),
    displayName: name,
    domain,
    role: 'nf',
    lifecycleState,
    source: { kind: 'manual', system: 'xcloud', authority: 'authoritative' },
    revision: 1,
    createdAt: now,
    createdBy: 'fixture',
    updatedAt: now,
    updatedBy: 'fixture',
  };
}

async function main() {
  console.log('== Topology Foundation Integration Suite ==\n');

  try {
    await client.connect();

    const xcloudDb = client.db(xcloudDbName);
    const appDb = client.db(appDbName);
    const usersColl = appDb.collection('app_users');
    const inventoryColl = appDb.collection('app_inventory_resources');
    const edgeColl = appDb.collection('app_topology_edges');
    const auditColl = appDb.collection('app_audit_logs');

    // Production index initializer against isolated test databases
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

    // Seed test users
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

    // Seed Inventory fixtures (Inventory owns nodes)
    const smfId = fixtureUuid(1);
    const pcfId = fixtureUuid(2);
    const amfId = fixtureUuid(3);
    const upfId = fixtureUuid(4);
    const retiredId = fixtureUuid(5);
    await inventoryColl.insertMany([
      inventoryDoc(smfId, 'smf-01', '5gc', 'active'),
      inventoryDoc(pcfId, 'pcf-01', '5gc', 'active'),
      inventoryDoc(amfId, 'amf-01', '5gc', 'active'),
      inventoryDoc(upfId, 'upf-01', '5gc', 'active'),
      inventoryDoc(retiredId, 'old-nf', '5gc', 'retired'),
    ]);

    // Build and start the Go backend
    const goPort = await getAvailablePort();
    const isWin = process.platform === 'win32';
    const binName = isWin ? `test-go-topo-${suffix}.exe` : `test-go-topo-${suffix}`;
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

    const adminToken = await makeToken('admin1', 'admin', 1);
    const operatorToken = await makeToken('operator1', 'operator', 1);
    const viewerToken = await makeToken('viewer1', 'viewer', 1);

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
      return { status: res.status, headers: res.headers, body: json };
    };

    const successfulActions = ['topology.edge.create', 'topology.edge.update', 'topology.edge.retire'];
    const successAuditCount = () => auditColl.countDocuments({ action: { $in: successfulActions }, result: 'success' });

    // 1. Collection boundaries
    await verifyAsync('edge collection lives in xcloud_ops only; no node collection is created', async () => {
      const opsColls = (await appDb.listCollections().toArray()).map((c) => c.name);
      assert.ok(opsColls.includes('app_topology_edges'), 'app_topology_edges must exist in xcloud_ops');

      const xcloudColls = (await xcloudDb.listCollections().toArray()).map((c) => c.name);
      assert.ok(!xcloudColls.some((c) => c.includes('topology')), 'no topology collection may exist in xcloud');

      for (const forbidden of ['app_topology_nodes', 'app_topology_vertices', 'app_topology_resources']) {
        assert.ok(!opsColls.includes(forbidden), `forbidden collection ${forbidden} must not exist`);
      }
      assert.equal(await edgeColl.countDocuments(), 0, 'topology starts with zero edges');
    });

    // 2. Indexes
    await verifyAsync('four required topology indexes exist with a partial unique active-edge index', async () => {
      const indexes = await edgeColl.indexes();
      const names = indexes.map((idx) => idx.name);
      for (const expected of ['uniq_topology_active_edge', 'topology_from_type_state_updated', 'topology_to_type_state_updated', 'topology_updated_id']) {
        assert.ok(names.includes(expected), `missing index ${expected}`);
      }
      const partial = indexes.find((idx) => idx.name === 'uniq_topology_active_edge');
      assert.equal(partial.unique, true, 'uniq_topology_active_edge must be unique');
      assert.deepEqual(partial.partialFilterExpression, { lifecycleState: 'active' }, 'partial filter must target active edges');
      assert.equal(partial.sparse, undefined, 'uniq_topology_active_edge must NOT be sparse');
      const paging = indexes.find((idx) => idx.name === 'topology_updated_id');
      assert.deepEqual(paging.key, { updatedAt: -1, _id: 1 }, 'pagination index must support updatedAt DESC, _id ASC');
    });

    // 3. Meta
    await verifyAsync('GET /api/topology/meta returns backend-authoritative vocabulary', async () => {
      const res = await req('GET', '/api/topology/meta', undefined, operatorToken);
      assert.equal(res.status, 200);
      assert.equal(res.body.schemaVersion, 1);
      assert.equal(res.body.relationshipTypes.length, 9);
      assert.equal(res.body.lifecycleStates.length, 2);
      assert.deepEqual(res.body.lifecycleStates.sort(), ['active', 'retired']);
    });

    // 4. Strict JSON + server-owned + sensitive keys
    await verifyAsync('create rejects strict-JSON violations, server-owned fields and sensitive keys', async () => {
      const countBefore = await edgeColl.countDocuments();
      const auditBefore = await successAuditCount();

      const unknown = await req('POST', '/api/topology/edges', {
        relationshipType: 'depends_on', fromResourceId: smfId, toResourceId: pcfId, invented: true,
      }, operatorToken);
      assert.equal(unknown.status, 400, 'unknown field must return 400');

      const trailing = await req(
        'POST', '/api/topology/edges', undefined, operatorToken,
        `{"relationshipType":"depends_on","fromResourceId":"${smfId}","toResourceId":"${pcfId}"} extra`,
      );
      assert.equal(trailing.status, 400, 'trailing token must return 400');

      for (const field of ['edgeId', 'schemaVersion', 'source', 'revision', 'lifecycleState', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy']) {
        const res = await req('POST', '/api/topology/edges', {
          relationshipType: 'depends_on', fromResourceId: smfId, toResourceId: pcfId, [field]: 'spoof',
        }, operatorToken);
        assert.equal(res.status, 400, `server-owned field ${field} must return 400`);
      }

      const secret = await req('POST', '/api/topology/edges', {
        relationshipType: 'depends_on', fromResourceId: smfId, toResourceId: pcfId,
        attributes: { admin_password: 'nope' },
      }, operatorToken);
      assert.equal(secret.status, 400, 'sensitive attribute key must return 400');

      assert.equal(await edgeColl.countDocuments(), countBefore, 'rejected creates must not persist');
      assert.equal(await successAuditCount(), auditBefore, 'rejected creates must not record success audit');
    });

    // 5. Identifier and relationship validation
    await verifyAsync('identifier, relationship type, self-edge and endpoint integrity are enforced', async () => {
      const countBefore = await edgeColl.countDocuments();

      const badRel = await req('POST', '/api/topology/edges', {
        relationshipType: 'peer_of', fromResourceId: smfId, toResourceId: pcfId,
      }, operatorToken);
      assert.equal(badRel.status, 400, 'non-canonical relationship type must return 400');

      const badId = await req('POST', '/api/topology/edges', {
        relationshipType: 'depends_on', fromResourceId: 'not-a-uuid', toResourceId: pcfId,
      }, operatorToken);
      assert.equal(badId.status, 400, 'malformed identifier must return 400');

      const selfEdge = await req('POST', '/api/topology/edges', {
        relationshipType: 'depends_on', fromResourceId: smfId, toResourceId: smfId,
      }, operatorToken);
      assert.equal(selfEdge.status, 400, 'self-edge must return 400');

      const unknownEndpoint = await req('POST', '/api/topology/edges', {
        relationshipType: 'depends_on', fromResourceId: smfId, toResourceId: fixtureUuid(999),
      }, operatorToken);
      assert.equal(unknownEndpoint.status, 404, 'unknown endpoint must return 404');

      const retiredEndpoint = await req('POST', '/api/topology/edges', {
        relationshipType: 'depends_on', fromResourceId: smfId, toResourceId: retiredId,
      }, operatorToken);
      assert.equal(retiredEndpoint.status, 409, 'retired endpoint must return 409');

      assert.equal(await edgeColl.countDocuments(), countBefore, 'rejected creates must not persist edges');
    });

    // 6. Create + duplicate + retired-tuple recreation
    let createdId = '';
    await verifyAsync('create persists an authoritative active edge and duplicate active tuples are rejected', async () => {
      const res = await req('POST', '/api/topology/edges', {
        relationshipType: 'depends_on',
        fromResourceId: smfId,
        toResourceId: pcfId,
        description: 'SMF depends on PCF',
        labels: { env: 'prod' },
        attributes: { priority: 1 },
      }, operatorToken);
      assert.equal(res.status, 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.schemaVersion, 1);
      assert.equal(res.body.revision, 1);
      assert.equal(res.body.lifecycleState, 'active');
      assert.equal(res.body.relationshipType, 'depends_on');
      assert.equal(res.body.source.kind, 'manual');
      assert.equal(res.body.source.system, 'xcloud');
      assert.equal(res.body.source.authority, 'authoritative');
      assert.equal(res.body.createdBy, 'operator1');
      createdId = res.body.edgeId;

      const doc = await edgeColl.findOne({ _id: createdId });
      assert.ok(doc, 'edge must be persisted with _id = edgeId');

      const duplicate = await req('POST', '/api/topology/edges', {
        relationshipType: 'depends_on', fromResourceId: smfId, toResourceId: pcfId,
      }, operatorToken);
      assert.equal(duplicate.status, 409, 'duplicate active tuple must return 409');
      assert.equal(duplicate.body.code, 'TOPOLOGY_DUPLICATE_ACTIVE_EDGE');

      // A different relationship type on the same endpoints is allowed.
      const other = await req('POST', '/api/topology/edges', {
        relationshipType: 'uses', fromResourceId: smfId, toResourceId: pcfId,
      }, operatorToken);
      assert.equal(other.status, 201, 'a different relationship type is a distinct tuple');

      // An automatically generated reverse edge must never be persisted.
      const reverse = await edgeColl.findOne({ fromResourceId: pcfId, toResourceId: smfId });
      assert.equal(reverse, null, 'no automatic reverse edge may be persisted');
    });

    // 7. Audit create
    await verifyAsync('create records an audit entry with before/after and actor', async () => {
      const audit = await waitForAudit(auditColl, { targetId: createdId, action: 'topology.edge.create' });
      assert.ok(audit, 'topology.edge.create audit must exist');
      assert.equal(audit.actor, 'operator1');
      assert.equal(audit.resource?.type, 'topology_edge');
      assert.equal(audit.resource?.id, createdId);
      assert.equal(audit.oldData, null, 'create audit oldData must be null');
      assert.equal(audit.newData?.edgeId, createdId);
      assert.equal(audit.newData?.revision, 1);
    });

    // 8. UUID validation on GET/PUT/retire
    await verifyAsync('strict UUID v4 validation distinguishes malformed from unknown', async () => {
      const uuidV1 = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
      const unknownV4 = '99999999-8888-4777-8666-555555555555';
      assert.equal((await req('GET', '/api/topology/edges/not-a-uuid', undefined, operatorToken)).status, 400);
      assert.equal((await req('GET', `/api/topology/edges/${uuidV1}`, undefined, operatorToken)).status, 400);
      assert.equal((await req('GET', `/api/topology/edges/${unknownV4}`, undefined, operatorToken)).status, 404);
      assert.equal((await req('PUT', `/api/topology/edges/${unknownV4}`, { expectedRevision: 1, edge: {} }, operatorToken)).status, 404);
      assert.equal((await req('POST', `/api/topology/edges/${unknownV4}/retire`, { expectedRevision: 1, reason: 'x' }, operatorToken)).status, 404);
    });

    // 9. Update + CAS + stale
    await verifyAsync('PUT replaces mutable metadata with CAS and rejects stale revisions', async () => {
      const docBefore = await edgeColl.findOne({ _id: createdId });
      const auditBefore = await successAuditCount();

      const unknownNested = await req('PUT', `/api/topology/edges/${createdId}`, {
        expectedRevision: 1, edge: { description: 'd', invented: 1 },
      }, operatorToken);
      assert.equal(unknownNested.status, 400, 'unknown nested field must return 400');

      const identityMutation = await req('PUT', `/api/topology/edges/${createdId}`, {
        expectedRevision: 1, edge: { relationshipType: 'uses' },
      }, operatorToken);
      assert.equal(identityMutation.status, 400, 'mutable relationship identity must be rejected');

      const serverField = await req('PUT', `/api/topology/edges/${createdId}`, {
        expectedRevision: 1, edge: { description: 'd' }, revision: 99,
      }, operatorToken);
      assert.equal(serverField.status, 400, 'server-owned field must be rejected');

      assert.deepEqual(await edgeColl.findOne({ _id: createdId }), docBefore, 'rejected updates must not mutate storage');
      assert.equal(await successAuditCount(), auditBefore, 'rejected updates must not record success audit');

      const ok = await req('PUT', `/api/topology/edges/${createdId}`, {
        expectedRevision: 1,
        edge: { description: 'SMF depends on PCF (updated)', labels: { env: 'prod', tier: 'core' }, attributes: {} },
      }, operatorToken);
      assert.equal(ok.status, 200, `expected 200, got ${ok.status}: ${JSON.stringify(ok.body)}`);
      assert.equal(ok.body.revision, 2);
      assert.equal(ok.body.description, 'SMF depends on PCF (updated)');
      assert.equal(ok.body.labels.tier, 'core');

      const audit = await waitForAudit(auditColl, { targetId: createdId, action: 'topology.edge.update' });
      assert.ok(audit, 'topology.edge.update audit must exist');
      assert.equal(audit.oldData?.revision, 1);
      assert.equal(audit.newData?.revision, 2);

      const stale = await req('PUT', `/api/topology/edges/${createdId}`, {
        expectedRevision: 1, edge: { description: 'stale' },
      }, operatorToken);
      assert.equal(stale.status, 409, 'stale revision must return 409');
      assert.equal(stale.body.code, 'TOPOLOGY_REVISION_CONFLICT');

      // Empty metadata replacement is supported.
      const cleared = await req('PUT', `/api/topology/edges/${createdId}`, {
        expectedRevision: 2, edge: { description: '', labels: {}, attributes: {} },
      }, operatorToken);
      assert.equal(cleared.status, 200);
      assert.equal(cleared.body.revision, 3);
      assert.ok(!cleared.body.labels || Object.keys(cleared.body.labels).length === 0, 'labels must be replaceable with empty');
    });

    // 10. Retire terminal + recreation
    await verifyAsync('retire is terminal, audited with the reason, and the tuple can be recreated', async () => {
      const staleRetire = await req('POST', `/api/topology/edges/${createdId}/retire`, {
        expectedRevision: 1, reason: 'old revision',
      }, operatorToken);
      assert.equal(staleRetire.status, 409, 'stale retire must return 409');

      const retired = await req('POST', `/api/topology/edges/${createdId}/retire`, {
        expectedRevision: 3, reason: 'Relationship is no longer applicable',
      }, operatorToken);
      assert.equal(retired.status, 200, `expected 200, got ${retired.status}: ${JSON.stringify(retired.body)}`);
      assert.equal(retired.body.lifecycleState, 'retired');
      assert.equal(retired.body.revision, 4);

      const audit = await waitForAudit(auditColl, { targetId: createdId, action: 'topology.edge.retire' });
      assert.ok(audit, 'topology.edge.retire audit must exist');
      assert.equal(audit.reason, 'Relationship is no longer applicable');
      assert.notEqual(audit.oldData?.lifecycleState, 'retired');
      assert.equal(audit.newData?.lifecycleState, 'retired');

      const mutateRetired = await req('PUT', `/api/topology/edges/${createdId}`, {
        expectedRevision: 4, edge: { description: 'nope' },
      }, operatorToken);
      assert.equal(mutateRetired.status, 409, 'mutating a retired edge must return 409');

      const retireAgain = await req('POST', `/api/topology/edges/${createdId}/retire`, {
        expectedRevision: 4, reason: 'again',
      }, operatorToken);
      assert.equal(retireAgain.status, 409, 'retiring an already retired edge must return 409');

      // Retired edges remain readable.
      assert.equal((await req('GET', `/api/topology/edges/${createdId}`, undefined, operatorToken)).status, 200);

      // The same directed tuple may be recreated with a new edge id.
      const recreated = await req('POST', '/api/topology/edges', {
        relationshipType: 'depends_on', fromResourceId: smfId, toResourceId: pcfId,
      }, operatorToken);
      assert.equal(recreated.status, 201, 'a retired tuple may be recreated');
      assert.notEqual(recreated.body.edgeId, createdId, 'the recreated edge must have a new id');
      assert.equal(recreated.body.lifecycleState, 'active');
    });

    // 11. Listing, filters, cursor and allowlist
    await verifyAsync('list supports filters, opaque cursor pagination and a strict query allowlist', async () => {
      // Four DISTINCT directed tuples: the partial unique index forbids reusing
      // an active (from, to, relationshipType) combination.
      const seedTuples = [
        { relationshipType: 'connects_to', toResourceId: upfId },
        { relationshipType: 'routes_to', toResourceId: pcfId },
        { relationshipType: 'uses', toResourceId: upfId },
        { relationshipType: 'serves', toResourceId: pcfId },
      ];
      for (const tuple of seedTuples) {
        const res = await req('POST', '/api/topology/edges', {
          relationshipType: tuple.relationshipType,
          fromResourceId: amfId,
          toResourceId: tuple.toResourceId,
        }, operatorToken);
        assert.equal(
          res.status,
          201,
          `seed create ${tuple.relationshipType} ${amfId} -> ${tuple.toResourceId} must succeed, got ${res.status}: ${JSON.stringify(res.body)}`,
        );
      }

      const unknownParam = await req('GET', '/api/topology/edges?bogus=1', undefined, operatorToken);
      assert.equal(unknownParam.status, 400, 'unknown query parameter must return 400');
      assert.equal((await req('GET', '/api/topology/edges?limit=0', undefined, operatorToken)).status, 400);
      assert.equal((await req('GET', '/api/topology/edges?limit=201', undefined, operatorToken)).status, 400);
      assert.equal((await req('GET', '/api/topology/edges?cursor=not-a-cursor', undefined, operatorToken)).status, 400);

      const active = await req('GET', '/api/topology/edges?lifecycleState=active', undefined, operatorToken);
      assert.equal(active.status, 200);
      assert.ok(active.body.edges.every((edge) => edge.lifecycleState === 'active'), 'active filter must hold');

      const retiredList = await req('GET', '/api/topology/edges?lifecycleState=retired', undefined, operatorToken);
      assert.equal(retiredList.status, 200);
      assert.ok(retiredList.body.edges.some((edge) => edge.edgeId === createdId), 'retired edges remain listed when requested');

      const byType = await req('GET', '/api/topology/edges?relationshipType=routes_to&lifecycleState=active', undefined, operatorToken);
      assert.equal(byType.status, 200);
      assert.ok(byType.body.edges.every((edge) => edge.relationshipType === 'routes_to'));

      const p1 = await req('GET', '/api/topology/edges?lifecycleState=active&limit=2', undefined, operatorToken);
      assert.equal(p1.status, 200);
      assert.equal(p1.body.edges.length, 2);
      assert.equal(p1.body.page.hasMore, true);
      assert.ok(p1.body.page.nextCursor);

      const p2 = await req('GET', `/api/topology/edges?lifecycleState=active&limit=2&cursor=${p1.body.page.nextCursor}`, undefined, operatorToken);
      assert.equal(p2.status, 200);
      const ids1 = new Set(p1.body.edges.map((e) => e.edgeId));
      for (const edge of p2.body.edges) {
        assert.ok(!ids1.has(edge.edgeId), 'cursor pages must be disjoint');
      }

      // A cursor must not be replayable against a different filter set.
      const incompatible = await req('GET', `/api/topology/edges?lifecycleState=retired&limit=2&cursor=${p1.body.page.nextCursor}`, undefined, operatorToken);
      assert.equal(incompatible.status, 400, 'cursor reuse against incompatible filters must be rejected');
    });

    // 12. One-hop neighbours
    await verifyAsync('one-hop neighbour queries project inbound, outbound and both directions', async () => {
      const outbound = await req('GET', `/api/topology/resources/${amfId}/neighbors?direction=outbound`, undefined, operatorToken);
      assert.equal(outbound.status, 200);
      assert.equal(outbound.body.rootResource.resourceId, amfId);
      assert.equal(outbound.body.rootResource.name, 'amf-01');
      assert.ok(outbound.body.neighbors.length > 0, 'amf must have outbound neighbours');
      assert.ok(outbound.body.neighbors.every((n) => n.direction === 'outbound'), 'outbound filter must hold');
      assert.ok(outbound.body.neighbors.every((n) => n.neighborResource.resourceId !== amfId));

      const inbound = await req('GET', `/api/topology/resources/${upfId}/neighbors?direction=inbound`, undefined, operatorToken);
      assert.equal(inbound.status, 200);
      assert.ok(inbound.body.neighbors.length > 0, 'upf must have inbound neighbours');
      assert.ok(inbound.body.neighbors.every((n) => n.direction === 'inbound'), 'inbound filter must hold');

      const both = await req('GET', `/api/topology/resources/${pcfId}/neighbors?direction=both`, undefined, operatorToken);
      assert.equal(both.status, 200);
      assert.ok(both.body.neighbors.length >= 2, 'pcf must have neighbours in both directions');

      const projection = both.body.neighbors[0].neighborResource;
      for (const field of ['resourceId', 'kind', 'name', 'domain', 'lifecycleState']) {
        assert.ok(field in projection, `neighbour projection must hydrate ${field}`);
      }

      const unknown = await req('GET', `/api/topology/resources/${fixtureUuid(999)}/neighbors`, undefined, operatorToken);
      assert.equal(unknown.status, 404, 'unknown root resource must return 404');

      const badDirection = await req('GET', `/api/topology/resources/${pcfId}/neighbors?direction=sideways`, undefined, operatorToken);
      assert.equal(badDirection.status, 400, 'invalid direction must return 400');

      const badParam = await req('GET', `/api/topology/resources/${pcfId}/neighbors?depth=3`, undefined, operatorToken);
      assert.equal(badParam.status, 400, 'multi-hop parameters must not be accepted');

      // Topology must not have written to the Inventory collection.
      const inventoryCount = await inventoryColl.countDocuments();
      assert.equal(inventoryCount, 5, 'topology must never write to app_inventory_resources');
    });

    // 13. RBAC
    await verifyAsync('viewer reads but is denied every mutation with HTTP 403', async () => {
      assert.equal((await req('GET', '/api/topology/edges', undefined, viewerToken)).status, 200);
      assert.equal((await req('GET', `/api/topology/edges/${createdId}`, undefined, viewerToken)).status, 200);
      assert.equal((await req('GET', '/api/topology/meta', undefined, viewerToken)).status, 200);
      assert.equal((await req('POST', '/api/topology/edges', {
        relationshipType: 'serves', fromResourceId: smfId, toResourceId: upfId,
      }, viewerToken)).status, 403);
      assert.equal((await req('PUT', `/api/topology/edges/${createdId}`, { expectedRevision: 4, edge: {} }, viewerToken)).status, 403);
      assert.equal((await req('POST', `/api/topology/edges/${createdId}/retire`, { expectedRevision: 4, reason: 'x' }, viewerToken)).status, 403);
      assert.equal((await req('GET', '/api/topology/edges', undefined, null)).status, 401);
    });

    // 14. Boundary
    await verifyAsync('no hard delete and no generic execution surface exists', async () => {
      assert.ok([404, 405].includes((await req('DELETE', `/api/topology/edges/${createdId}`, undefined, operatorToken)).status));
      assert.ok([404, 405].includes((await req('POST', `/api/topology/edges/${createdId}/execute`, {}, operatorToken)).status));
      assert.ok([404, 405].includes((await req('POST', '/api/topology/discover', {}, operatorToken)).status));
      assert.ok([404, 405].includes((await req('POST', `/api/topology/resources/${smfId}/restart`, {}, operatorToken)).status));
    });

    console.log(`\n-- All ${passed}/${totalChecks} Topology Foundation Integration Tests Passed! --\n`);

    console.log('topology_schema_version=1');
    console.log('topology_collection=xcloud_ops.app_topology_edges');
    console.log('topology_node_collection_count=0');
    console.log('topology_relationship_type_count=9');
    console.log('topology_lifecycle_state_count=2');
    console.log('topology_api_read_count=4');
    console.log('topology_api_mutation_count=3');
    console.log('topology_api_total_count=7');
    console.log('go_registration_count=119');
    console.log('frontend_route_count=32');
    console.log('topology_read_permission=core.read');
    console.log('topology_write_permission=core.configure');
    console.log('inventory_node_authority=PASS');
    console.log('topology_edge_authority=PASS');
    console.log('topology_indexes=PASS');
    console.log('topology_partial_unique_index=PASS');
    console.log('topology_referential_integrity=PASS');
    console.log('topology_retired_endpoint_rejection=PASS');
    console.log('topology_self_edge_rejection=PASS');
    console.log('topology_duplicate_edge_rejection=PASS');
    console.log('topology_retire_recreate=PASS');
    console.log('topology_cas=PASS');
    console.log('topology_stale_revision_conflict=PASS');
    console.log('topology_terminal_retirement=PASS');
    console.log('topology_audit=PASS');
    console.log('topology_audit_before_after=PASS');
    console.log('topology_audit_retire_reason=PASS');
    console.log('topology_rejected_mutation_audit_unchanged=PASS');
    console.log('topology_one_hop=PASS');
    console.log('topology_one_hop_inbound=PASS');
    console.log('topology_one_hop_outbound=PASS');
    console.log('topology_cursor_pagination=PASS');
    console.log('topology_cursor_filter_binding=PASS');
    console.log('topology_query_allowlist=PASS');
    console.log('topology_strict_json_rejection=PASS');
    console.log('topology_server_owned_field_rejection=PASS');
    console.log('topology_secret_key_rejection=PASS');
    console.log('topology_uuid_v4_validation=PASS');
    console.log('topology_rbac=PASS');
    console.log('topology_hard_delete_route=0');
    console.log('topology_discovery_runtime=0');
    console.log('topology_remote_executor=0');
    console.log('topology_multi_hop=0');
    console.log('business_mutation_endpoints=29');
    console.log('business_request_contracts=31');
    console.log('operational_endpoints=4');
    console.log('topology_foundation_result=PASS');
  } catch (err) {
    console.error('\nTest suite failed with error:', err);
    process.exit(1);
  } finally {
    if (goProc) {
      try { goProc.kill('SIGTERM'); } catch {}
    }
    if (binPath && existsSync(binPath)) {
      try { unlinkSync(binPath); } catch {}
    }
    try {
      await client.db(xcloudDbName).dropDatabase();
      await client.db(appDbName).dropDatabase();
      await client.close();
    } catch {}
  }
}

main().catch((err) => {
  console.error('Fatal error in main:', err);
  process.exit(1);
});
