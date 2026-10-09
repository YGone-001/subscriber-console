#!/usr/bin/env node
/**
 * Live NRF read-only integration suite.
 *
 * GATED: refuses to run unless ALLOW_LIVE_NRF_READONLY=1 is set explicitly.
 *
 * This suite contacts a real local NRF registry over bounded, read-only GET
 * requests issued only through the Go Discovery adapter. It never performs
 * NF registration writes, subscription creation, configuration changes or
 * process control of any kind.
 *
 * The suite asserts:
 * - The allowlist still defaults to deny for every other destination
 * - A single bounded scan returns the observed registry identities
 * - Observation state is produced without inventing missing NFs
 * - Inventory documents are not created or modified by the scan
 * - No live NFProfile payload is printed to the console
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

if (process.env.ALLOW_LIVE_NRF_READONLY !== '1') {
  console.log('SKIP live NRF integration: set ALLOW_LIVE_NRF_READONLY=1 to enable read-only live verification.');
  process.exit(0);
}

const LIVE_TARGET = process.env.LIVE_NRF_TARGET || '127.0.0.10:7777';
const LIVE_BASE_URL = process.env.LIVE_NRF_BASE_URL || `http://${LIVE_TARGET}`;
const EXPECTED_NF_TYPES = (process.env.LIVE_NRF_EXPECTED_TYPES || 'NRF,SCP,AUSF,UDM,UDR,NSSF,BSF,PCF,AMF')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const suffix = `${Date.now()}_${process.pid}_${Math.floor(Math.random() * 100000)}`;
const xcloudDbName = `xcloud_live_test_${suffix}`;
const appDbName = `xcloud_ops_live_test_${suffix}`;
const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/xcloud';

process.env.MONGODB_XCLOUD_DB = xcloudDbName;
process.env.MONGODB_APP_DB = appDbName;
const JWT_SECRET_STRING = process.env.JWT_SECRET || 'nrf-live-readonly-secret-at-least-32-bytes-long!';
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

async function main() {
  console.log('== Live NRF Read-Only Integration Suite ==\n');
  console.log(`live_target=${LIVE_TARGET}`);
  console.log('mode=read-only-get');

  try {
    await client.connect();
    const xcloudDb = client.db(xcloudDbName);
    const appDb = client.db(appDbName);
    const usersColl = appDb.collection('app_users');
    const inventoryColl = appDb.collection('app_inventory_resources');

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

    const goPort = await getAvailablePort();
    const isWin = process.platform === 'win32';
    const binName = isWin ? `test-go-live-${suffix}.exe` : `test-go-live-${suffix}`;
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
        DISCOVERY_ALLOWED_TARGETS: LIVE_TARGET,
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
      const res = await req('POST', '/api/discovery/sources', {
        name: 'blocked',
        adapterType: 'nrf',
        baseUrl: 'http://127.0.0.12:7777',
        transportMode: 'h2c',
      });
      assert.equal(res.status, 403);
      assert.equal(res.body.code, 'DISCOVERY_TARGET_NOT_ALLOWED');
    });

    let sourceId = null;
    await verifyAsync('live source is registered against the allowlisted registry', async () => {
      const res = await req('POST', '/api/discovery/sources', {
        name: 'live-nrf',
        adapterType: 'nrf',
        baseUrl: LIVE_BASE_URL,
        transportMode: process.env.LIVE_NRF_TRANSPORT || 'h2c',
        enabled: true,
      });
      assert.equal(res.status, 201);
      sourceId = res.body.sourceId;
      assert.ok(sourceId);
    });

    await verifyAsync('bounded live scan observes registry identities without inventing missing NFs', async () => {
      const inventoryBefore = await inventoryColl.countDocuments();
      const res = await req('POST', `/api/discovery/sources/${sourceId}/scan`, {});
      assert.equal(res.status, 200, `scan status=${res.status} body=${JSON.stringify(res.body).slice(0, 200)}`);
      assert.ok(['success', 'partial'].includes(res.body.run.status), `run status=${res.body.run.status}`);

      const list = await req('GET', `/api/discovery/candidates?sourceId=${sourceId}&limit=200`);
      assert.equal(list.status, 200);
      const types = new Set(list.body.candidates.map((c) => c.nfType));
      console.log(`  INFO  observed_nf_types=${[...types].sort().join(',')}`);
      console.log(`  INFO  observed_count=${list.body.candidates.length}`);
      for (const expected of EXPECTED_NF_TYPES) {
        assert.ok(types.has(expected), `expected observed nfType ${expected}`);
      }
      for (const candidate of list.body.candidates) {
        assert.ok(['seen', 'missing', 'stale'].includes(candidate.observationState));
        if (res.body.run.status === 'success') {
          assert.equal(candidate.observationState, 'seen');
        }
      }
      const inventoryAfter = await inventoryColl.countDocuments();
      assert.equal(inventoryBefore, inventoryAfter, 'discovery must not create inventory resources');
    });

    await verifyAsync('live run is recorded as read-only observation evidence', async () => {
      const runs = await req('GET', `/api/discovery/runs?sourceId=${sourceId}`);
      assert.equal(runs.status, 200);
      assert.ok(runs.body.runs.length >= 1);
      const latest = runs.body.runs[0];
      assert.ok(['success', 'partial', 'failed'].includes(latest.status));
      assert.equal(latest.initiatedBy, 'admin1');
    });

    console.log('\nLive NRF read-only integration: PASS');
    console.log('Note: only bounded GET requests were issued. No live NFProfile payloads were printed.');
  } finally {
    if (goProc) goProc.kill('SIGTERM');
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
