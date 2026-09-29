// Phase 8.1 - Residual API Node<->Go Shadow Parity Suite
//
// Proves the exact 33-operation canonical Node migration remainder end to end:
//   - 22 pre-existing Go shadows (registered, not production-routed)
//   - 11 newly implemented Go shadows (ratings write / policy / traffic
//     adjustments / tariff import / migrate / rule write)
//
// Required invariants for every one of the 33 operations:
//   go_registered=true  cutover=false  runtime_owner=node
//
// Real HTTP topology (no handler mocks):
//   harness --> Node test HTTP server (jiti route handlers) -> isolated Node Mongo test DBs
//   harness --> Go production binary (spawned)               -> isolated Go Mongo test DBs
//
// Node and Go never mutate the same test database. Node is the authoritative
// behavioral contract; every scenario is executed against both engines and the
// status, response contract, and persistent state are compared.
//
// Hard guarantees preserved:
//   CUTOVER_TABLE=47, ACTUALLY_ROUTED=47 (nothing here is added to the table)
//   Node remains the production runtime owner for all 33 operations.

import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { existsSync, unlinkSync, readFileSync } from 'node:fs';
import { execSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SignJWT, jwtVerify } from 'jose';
import { MongoClient, ObjectId } from 'mongodb';
import { createJiti } from 'jiti';
import nextEnv from '@next/env';
import bcrypt from 'bcryptjs';

nextEnv.loadEnvConfig(process.cwd());

// Noise suppression for expected Node route internals during scenario runs.
const originalConsoleError = console.error;
const EXPECTED_NODE_LOG_PREFIXES = [
  'Rate limiter MongoDB error',
  'Error fetching ratings:',
  'Error creating rating:',
  'Error updating rating:',
  'Error deleting rating:',
  'Error fetching tariff plan rules:',
  'Error creating tariff plan rule:',
  'Error updating tariff plan rule:',
  'Error toggling tariff plan rule status:',
  'Error deleting tariff plan rule:',
  'Error importing tariff plan approval:',
  'Error running tariff plan migration dry-run:',
  'Error fetching tariff plan:',
];
console.error = (...args) => {
  if (typeof args[0] === 'string' && EXPECTED_NODE_LOG_PREFIXES.some((p) => args[0].includes(p))) {
    return;
  }
  originalConsoleError(...args);
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const suffix = `${Date.now()}_${process.pid}_${Math.floor(Math.random() * 100000)}`;
const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/xcloud';

// Isolated DB pairs - Node and Go never share a database.
const xcloudDbNode = `xcloud_p81_node_${suffix}`;
const appDbNode = `xcloud_ops_p81_node_${suffix}`;
const xcloudDbGo = `xcloud_p81_go_${suffix}`;
const appDbGo = `xcloud_ops_p81_go_${suffix}`;

const JWT_SECRET_STRING = 'phase-8-1-residual-parity-secret-32b!';
process.env.JWT_SECRET = JWT_SECRET_STRING;

// Node repositories read these at import time - must be set before jiti loads.
process.env.MONGODB_XCLOUD_DB = xcloudDbNode;
process.env.MONGODB_APP_DB = appDbNode;

// ---------------------------------------------------------------------------
// next/server `after()` shim.
//
// Node's best-effort audit evidence (frontend/src/lib/audit.ts) is persisted
// through next/server's `after()`, which throws outside a real Next.js request
// scope. This direct-invocation harness would silently drop every scheduled
// Node audit write, so mirror the Phase 7 parity suites: pre-seed the require
// cache with a runAfter shim and drain pending work before asserting evidence.
// ---------------------------------------------------------------------------
const req = createRequire(import.meta.url);
const pendingAfter = new Set();

function runAfter(fn) {
  if (typeof fn !== 'function') return;
  const promise = Promise.resolve().then(fn).finally(() => pendingAfter.delete(promise));
  pendingAfter.add(promise);
  promise.catch(() => {});
}

async function drainAfter() {
  await Promise.allSettled([...pendingAfter]);
}

try {
  const frontendRoot = path.join(root, 'frontend');
  const resolvedAfter = req.resolve('next/dist/server/after/after', { paths: [frontendRoot] });
  req.cache[resolvedAfter] = {
    id: resolvedAfter,
    filename: resolvedAfter,
    loaded: true,
    exports: { after: runAfter },
  };
  // The index re-exports `after` through live getters; deleting its cache
  // forces a fresh evaluation that picks up the seeded inner module.
  delete req.cache[req.resolve('next/dist/server/after', { paths: [frontendRoot] })];
  delete req.cache[req.resolve('next/server', { paths: [frontendRoot] })];
} catch {
  // Layout differences must not abort the suite; the direct patch below still
  // covers the module instance jiti resolves.
}
try {
  const nextServerPkg = req(req.resolve('next/server', { paths: [path.join(root, 'frontend')] }));
  if (nextServerPkg) nextServerPkg.after = runAfter;
} catch {
  // Non-fatal: the seeded require cache above is the primary shim mechanism.
}

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  alias: {
    '@': new URL('../frontend/src/', import.meta.url).pathname,
    'next/server': new URL('../frontend/node_modules/next/server.js', import.meta.url).pathname,
  },
});
const { NextRequest } = jiti('next/server');

// Node authority route modules (all 26 files backing the 33 operations).
const M = {
  analyticsMetrics: jiti('../frontend/src/app/api/analytics/metrics/route.ts'),
  analyticsSparkline: jiti('../frontend/src/app/api/analytics/sparkline/route.ts'),
  ocsBalances: jiti('../frontend/src/app/api/ocs/balances/route.ts'),
  ocsReservations: jiti('../frontend/src/app/api/ocs/reservations/route.ts'),
  ocsSessions: jiti('../frontend/src/app/api/ocs/sessions/route.ts'),
  ocsUsage: jiti('../frontend/src/app/api/ocs/usage/route.ts'),
  profiles: jiti('../frontend/src/app/api/profiles/route.ts'),
  profileDetail: jiti('../frontend/src/app/api/profiles/[name]/route.ts'),
  profileStats: jiti('../frontend/src/app/api/profiles/[name]/stats/route.ts'),
  profileVersions: jiti('../frontend/src/app/api/profiles/[name]/versions/route.ts'),
  ratings: jiti('../frontend/src/app/api/ratings/route.ts'),
  ratingDetail: jiti('../frontend/src/app/api/ratings/[id]/route.ts'),
  search: jiti('../frontend/src/app/api/search/route.ts'),
  subscribers: jiti('../frontend/src/app/api/subscribers/route.ts'),
  subscriberDetail: jiti('../frontend/src/app/api/subscribers/[imsi]/route.ts'),
  trafficAdjustments: jiti('../frontend/src/app/api/subscribers/[imsi]/traffic-adjustments/route.ts'),
  subscriberPolicy: jiti('../frontend/src/app/api/subscribers/policy/route.ts'),
  batchPrecheck: jiti('../frontend/src/app/api/subscribers/batch/precheck/route.ts'),
  tariffPlans: jiti('../frontend/src/app/api/tariff-plans/route.ts'),
  tariffPlanDetail: jiti('../frontend/src/app/api/tariff-plans/[planId]/route.ts'),
  tariffPlanExport: jiti('../frontend/src/app/api/tariff-plans/[planId]/export/route.ts'),
  tariffPlanMigrate: jiti('../frontend/src/app/api/tariff-plans/[planId]/migrate/route.ts'),
  tariffPlanRules: jiti('../frontend/src/app/api/tariff-plans/[planId]/rules/route.ts'),
  tariffPlanRuleDetail: jiti('../frontend/src/app/api/tariff-plans/[planId]/rules/[ruleId]/route.ts'),
  tariffPlanSubscribers: jiti('../frontend/src/app/api/tariff-plans/[planId]/subscribers/route.ts'),
  tariffPlanImport: jiti('../frontend/src/app/api/tariff-plans/import/route.ts'),
};

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
let goPort = null;
let nodeServer = null;
let nodePort = null;
let binPath = null;
let passed = 0;
let failed = 0;
let totalChecks = 0;

function verify(description, fn) {
  totalChecks++;
  try {
    fn();
    console.log(`  PASS  ${description}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${description}`);
    console.error(err);
    failed++;
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
    console.error(err);
    failed++;
    throw err;
  }
}

function makeToken(username, role, sv, expSeconds = 86400) {
  return new SignJWT({ username, role, sv })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt(Math.floor(Date.now() / 1000))
    .setExpirationTime(Math.floor(Date.now() / 1000) + expSeconds)
    .sign(new TextEncoder().encode(JWT_SECRET_STRING));
}

// ---------------------------------------------------------------------------
// Scenario helpers
// ---------------------------------------------------------------------------

// Negative-then-positive scenarios shared by the 22 pre-existing shadows.
function readScenarios(pathStr) {
  return [
    { name: 'unauth-401', path: pathStr, token: null, expectStatus: 401, expectCode: 'AUTH_INVALID_TOKEN' },
    { name: 'authorized-read', path: pathStr, token: 'admin' },
  ];
}

// Disabled contract identity body: { error: CODE, code: CODE } with HTTP 409.
function disabledBody(code) {
  return { error: code, code };
}

// ---------------------------------------------------------------------------
// Explicit normalization of truly non-deterministic fields only.
//
// Every other field is compared exactly. These helpers validate the structure
// of the non-deterministic values (so parity is still meaningful) and then
// replace them with a stable sentinel before the deep comparison.
// ---------------------------------------------------------------------------

// GET /api/analytics/metrics: `timestamp` is Date.now()/time.Now() on each
// engine and can never match byte-for-byte. Both values must be fresh wall
// clock milliseconds within the same test window.
function normalizeMetricsTimestamp(body) {
  // Non-success payloads (401/403/5xx) carry no metrics timestamp; the deep
  // comparison between engines still decides on those payloads.
  if (!body || typeof body.timestamp !== 'number') return body;
  const now = Date.now();
  assert.ok(
    Math.abs(now - body.timestamp) < 5000,
    `metrics timestamp must be current wall clock (now=${now} got=${body.timestamp})`
  );
  return { ...body, timestamp: '<now-validated>' };
}

// GET /api/analytics/sparkline: `subscribers` and `traffic` are random jitter
// series on both engines (Node Math.random, Go equivalent jitter). Validate the
// frozen structural invariants (24 points, non-negative integers, final point
// equals the current value) and replace the series with sentinels.
function normalizeSparklineTrends(body) {
  // Non-success payloads carry no trend series; the deep comparison between
  // engines still decides on those payloads.
  if (!body || !Array.isArray(body.subscribers) || !Array.isArray(body.traffic)) return body;
  for (const key of ['subscribers', 'traffic']) {
    const series = body[key];
    assert.ok(Array.isArray(series), `sparkline ${key} must be an array`);
    assert.equal(series.length, 24, `sparkline ${key} must contain exactly 24 points`);
    assert.ok(
      series.every((n) => Number.isInteger(n) && n >= 0),
      `sparkline ${key} points must be non-negative integers`
    );
  }
  assert.equal(body.subscribers[23], body.currentSubCount, 'sparkline subscribers final point must equal currentSubCount');
  assert.equal(body.traffic[23], body.currentTraffic, 'sparkline traffic final point must equal currentTraffic');
  return { ...body, subscribers: '<trend:24>', traffic: '<trend:24>' };
}

// GET /api/tariff-plans/{planId}/export: `exported_at` is the request-time wall
// clock (Node new Date().toISOString(), Go time.Now().UTC()) and can never
// match byte-for-byte. Both values must be fresh ISO timestamps within the same
// test window.
function normalizeExportTimestamp(body) {
  if (!body || typeof body.exported_at !== 'string') return body;
  const parsed = Date.parse(body.exported_at);
  assert.ok(Number.isFinite(parsed), `exported_at must be an ISO timestamp, got ${body.exported_at}`);
  assert.ok(
    Math.abs(Date.now() - parsed) < 5000,
    `exported_at must be current wall clock, got ${body.exported_at}`
  );
  return { ...body, exported_at: '<now-validated>' };
}

// Scenarios shared by the new shadow write endpoints. The disabled gates and
// permission boundary precede body parsing, so every authorized attempt
// (including malformed bodies) observes the same stable disabled contract.
function writeScenarios({ pathStr, body, status, code, permission, extras = [] }) {
  const disabled = status === 409 && code !== undefined;
  const base = {
    path: pathStr,
    body,
    token: 'admin',
    expectStatus: status,
    expectCode: code,
    expectBody: disabled ? disabledBody(code) : undefined,
  };
  return [
    { name: 'authorized', ...base },
    ...extras,
    { name: 'viewer-denied', path: pathStr, body, token: 'viewer', expectStatus: 403, expectCode: 'PERMISSION_DENIED', expectPermission: permission },
    { name: 'unauth-401', path: pathStr, body, token: null, expectStatus: 401, expectCode: 'AUTH_INVALID_TOKEN' },
  ];
}

// ---------------------------------------------------------------------------
// The exact 33-operation canonical Node migration remainder
// ---------------------------------------------------------------------------

const OPS = [
  // ----- 22 pre-existing Go shadows -----------------------------------------
  {
    method: 'GET',
    path: '/api/analytics/metrics',
    category: 'existing_shadow',
    file: 'frontend/src/app/api/analytics/metrics/route.ts',
    invoke: (req, params) => M.analyticsMetrics.GET(req, { params: Promise.resolve(params) }),
    scenarios: readScenarios('/api/analytics/metrics'),
    normalizeBody: normalizeMetricsTimestamp,
  },
  {
    method: 'GET',
    path: '/api/analytics/sparkline',
    category: 'existing_shadow',
    file: 'frontend/src/app/api/analytics/sparkline/route.ts',
    invoke: (req, params) => M.analyticsSparkline.GET(req, { params: Promise.resolve(params) }),
    scenarios: readScenarios('/api/analytics/sparkline'),
    normalizeBody: normalizeSparklineTrends,
  },
  {
    method: 'GET',
    path: '/api/ocs/balances',
    category: 'existing_shadow',
    file: 'frontend/src/app/api/ocs/balances/route.ts',
    invoke: (req, params) => M.ocsBalances.GET(req, { params: Promise.resolve(params) }),
    scenarios: readScenarios('/api/ocs/balances'),
  },
  {
    method: 'GET',
    path: '/api/ocs/reservations',
    category: 'existing_shadow',
    file: 'frontend/src/app/api/ocs/reservations/route.ts',
    invoke: (req, params) => M.ocsReservations.GET(req, { params: Promise.resolve(params) }),
    scenarios: readScenarios('/api/ocs/reservations'),
  },
  {
    method: 'GET',
    path: '/api/ocs/sessions',
    category: 'existing_shadow',
    file: 'frontend/src/app/api/ocs/sessions/route.ts',
    invoke: (req, params) => M.ocsSessions.GET(req, { params: Promise.resolve(params) }),
    scenarios: readScenarios('/api/ocs/sessions'),
  },
  {
    method: 'GET',
    path: '/api/ocs/usage',
    category: 'existing_shadow',
    file: 'frontend/src/app/api/ocs/usage/route.ts',
    invoke: (req, params) => M.ocsUsage.GET(req, { params: Promise.resolve(params) }),
    scenarios: readScenarios('/api/ocs/usage'),
  },
  {
    method: 'GET',
    path: '/api/profiles',
    category: 'existing_shadow',
    file: 'frontend/src/app/api/profiles/route.ts',
    invoke: (req, params) => M.profiles.GET(req, { params: Promise.resolve(params) }),
    scenarios: readScenarios('/api/profiles'),
  },
  {
    method: 'GET',
    path: '/api/profiles/{name}',
    category: 'existing_shadow',
    file: 'frontend/src/app/api/profiles/[name]/route.ts',
    invoke: (req, params) => M.profileDetail.GET(req, { params: Promise.resolve(params) }),
    scenarios: readScenarios('/api/profiles/default'),
  },
  {
    method: 'GET',
    path: '/api/profiles/{name}/stats',
    category: 'existing_shadow',
    file: 'frontend/src/app/api/profiles/[name]/stats/route.ts',
    invoke: (req, params) => M.profileStats.GET(req, { params: Promise.resolve(params) }),
    scenarios: readScenarios('/api/profiles/default/stats'),
  },
  {
    method: 'GET',
    path: '/api/profiles/{name}/versions',
    category: 'existing_shadow',
    file: 'frontend/src/app/api/profiles/[name]/versions/route.ts',
    invoke: (req, params) => M.profileVersions.GET(req, { params: Promise.resolve(params) }),
    scenarios: readScenarios('/api/profiles/default/versions'),
  },
  {
    method: 'GET',
    path: '/api/ratings',
    category: 'existing_shadow',
    file: 'frontend/src/app/api/ratings/route.ts',
    invoke: (req, params) => M.ratings.GET(req, { params: Promise.resolve(params) }),
    scenarios: readScenarios('/api/ratings'),
  },
  {
    method: 'GET',
    path: '/api/ratings/{id}',
    category: 'existing_shadow',
    file: 'frontend/src/app/api/ratings/[id]/route.ts',
    invoke: (req, params) => M.ratingDetail.GET(req, { params: Promise.resolve(params) }),
    scenarios: readScenarios('/api/ratings/1001'),
  },
  {
    method: 'GET',
    path: '/api/search',
    category: 'existing_shadow',
    file: 'frontend/src/app/api/search/route.ts',
    invoke: (req, params) => M.search.GET(req, { params: Promise.resolve(params) }),
    scenarios: readScenarios('/api/search?q=def'),
  },
  {
    method: 'GET',
    path: '/api/subscribers',
    category: 'existing_shadow',
    file: 'frontend/src/app/api/subscribers/route.ts',
    invoke: (req, params) => M.subscribers.GET(req, { params: Promise.resolve(params) }),
    scenarios: readScenarios('/api/subscribers'),
  },
  {
    method: 'GET',
    path: '/api/subscribers/{imsi}',
    category: 'existing_shadow',
    file: 'frontend/src/app/api/subscribers/[imsi]/route.ts',
    invoke: (req, params) => M.subscriberDetail.GET(req, { params: Promise.resolve(params) }),
    scenarios: readScenarios('/api/subscribers/001010000000001'),
  },
  {
    method: 'GET',
    path: '/api/tariff-plans',
    category: 'existing_shadow',
    file: 'frontend/src/app/api/tariff-plans/route.ts',
    invoke: (req, params) => M.tariffPlans.GET(req, { params: Promise.resolve(params) }),
    scenarios: readScenarios('/api/tariff-plans'),
  },
  {
    method: 'GET',
    path: '/api/tariff-plans/{planId}',
    category: 'existing_shadow',
    file: 'frontend/src/app/api/tariff-plans/[planId]/route.ts',
    invoke: (req, params) => M.tariffPlanDetail.GET(req, { params: Promise.resolve(params) }),
    scenarios: readScenarios('/api/tariff-plans/default-standard'),
  },
  {
    method: 'GET',
    path: '/api/tariff-plans/{planId}/export',
    category: 'existing_shadow',
    file: 'frontend/src/app/api/tariff-plans/[planId]/export/route.ts',
    invoke: (req, params) => M.tariffPlanExport.GET(req, { params: Promise.resolve(params) }),
    scenarios: readScenarios('/api/tariff-plans/default-standard/export'),
    normalizeBody: normalizeExportTimestamp,
  },
  {
    method: 'GET',
    path: '/api/tariff-plans/{planId}/migrate',
    category: 'existing_shadow',
    file: 'frontend/src/app/api/tariff-plans/[planId]/migrate/route.ts',
    invoke: (req, params) => M.tariffPlanMigrate.GET(req, { params: Promise.resolve(params) }),
    scenarios: readScenarios('/api/tariff-plans/default-standard/migrate?targetPlanId=plan-beta'),
  },
  {
    method: 'GET',
    path: '/api/tariff-plans/{planId}/rules',
    category: 'existing_shadow',
    file: 'frontend/src/app/api/tariff-plans/[planId]/rules/route.ts',
    invoke: (req, params) => M.tariffPlanRules.GET(req, { params: Promise.resolve(params) }),
    scenarios: readScenarios('/api/tariff-plans/default-standard/rules'),
  },
  {
    method: 'GET',
    path: '/api/tariff-plans/{planId}/subscribers',
    category: 'existing_shadow',
    file: 'frontend/src/app/api/tariff-plans/[planId]/subscribers/route.ts',
    invoke: (req, params) => M.tariffPlanSubscribers.GET(req, { params: Promise.resolve(params) }),
    scenarios: readScenarios('/api/tariff-plans/default-standard/subscribers'),
  },
  {
    method: 'POST',
    path: '/api/subscribers/batch/precheck',
    category: 'existing_shadow',
    file: 'frontend/src/app/api/subscribers/batch/precheck/route.ts',
    invoke: (req, params) => M.batchPrecheck.POST(req, { params: Promise.resolve(params) }),
    scenarios: [
      { name: 'unauth-401', path: '/api/subscribers/batch/precheck', body: { startImsi: '001010000000020', count: 2 }, token: null, expectStatus: 401, expectCode: 'AUTH_INVALID_TOKEN' },
      { name: 'authorized-precheck', path: '/api/subscribers/batch/precheck', body: { startImsi: '001010000000020', count: 2 }, token: 'admin' },
    ],
  },

  // ----- 11 newly implemented Go shadows ------------------------------------
  {
    method: 'POST',
    path: '/api/ratings',
    category: 'new_shadow',
    file: 'frontend/src/app/api/ratings/route.ts',
    invoke: (req, params) => M.ratings.POST(req, { params: Promise.resolve(params) }),
    scenarios: writeScenarios({
      pathStr: '/api/ratings',
      body: { rating_group_id: '2002' },
      status: 409,
      code: 'OCS_RATING_CREATE_NOT_SUPPORTED',
      permission: 'ocs.rating.write',
      extras: [
        // The disabled gate precedes body parsing: malformed JSON and missing
        // required fields observe the identical disabled contract on both engines.
        { name: 'authorized-malformed-json', path: '/api/ratings', body: '{invalid', token: 'admin', expectStatus: 409, expectCode: 'OCS_RATING_CREATE_NOT_SUPPORTED', expectBody: disabledBody('OCS_RATING_CREATE_NOT_SUPPORTED') },
        { name: 'authorized-missing-field', path: '/api/ratings', body: {}, token: 'admin', expectStatus: 409, expectCode: 'OCS_RATING_CREATE_NOT_SUPPORTED', expectBody: disabledBody('OCS_RATING_CREATE_NOT_SUPPORTED') },
      ],
    }),
  },
  {
    method: 'PUT',
    path: '/api/ratings/{id}',
    category: 'new_shadow',
    file: 'frontend/src/app/api/ratings/[id]/route.ts',
    invoke: (req, params) => M.ratingDetail.PUT(req, { params: Promise.resolve(params) }),
    scenarios: writeScenarios({
      pathStr: '/api/ratings/2002',
      body: { name: 'updated' },
      status: 409,
      code: 'OCS_RATING_UPDATE_NOT_SUPPORTED',
      permission: 'ocs.rating.write',
      extras: [
        // Unknown rating id still observes the disabled gate (no 404 in Node).
        { name: 'authorized-unknown-id', path: '/api/ratings/999999', body: {}, token: 'admin', expectStatus: 409, expectCode: 'OCS_RATING_UPDATE_NOT_SUPPORTED', expectBody: disabledBody('OCS_RATING_UPDATE_NOT_SUPPORTED') },
      ],
    }),
  },
  {
    method: 'DELETE',
    path: '/api/ratings/{id}',
    category: 'new_shadow',
    file: 'frontend/src/app/api/ratings/[id]/route.ts',
    invoke: (req, params) => M.ratingDetail.DELETE(req, { params: Promise.resolve(params) }),
    scenarios: writeScenarios({
      pathStr: '/api/ratings/2002',
      body: null,
      status: 409,
      code: 'OCS_RATING_DELETE_NOT_SUPPORTED',
      permission: 'ocs.rating.write',
    }),
  },
  {
    method: 'POST',
    path: '/api/subscribers/policy',
    category: 'new_shadow',
    file: 'frontend/src/app/api/subscribers/policy/route.ts',
    invoke: (req, params) => M.subscriberPolicy.POST(req, { params: Promise.resolve(params) }),
    scenarios: writeScenarios({
      pathStr: '/api/subscribers/policy',
      body: { imsi: '001010000000001', policy: 'default' },
      status: 409,
      code: 'OCS_PLAN_ASSIGN_NOT_SUPPORTED',
      permission: 'ocs.plan.assign',
    }),
  },
  {
    method: 'POST',
    path: '/api/subscribers/{imsi}/traffic-adjustments',
    category: 'new_shadow',
    file: 'frontend/src/app/api/subscribers/[imsi]/traffic-adjustments/route.ts',
    invoke: (req, params) => M.trafficAdjustments.POST(req, { params: Promise.resolve(params) }),
    scenarios: writeScenarios({
      pathStr: '/api/subscribers/001010000000001/traffic-adjustments',
      body: {},
      status: 200,
      code: undefined,
      permission: 'ocs.balance.adjust',
      extras: [
        // OCS_BALANCE_ADJUST is DIRECT_GOVERNED (executable): after the Node
        // parity rate limit (`traffic-adjustments:<user>`, 30/60) both engines
        // answer with the routed acknowledgement instead of a disabled conflict.
        { name: 'authorized-allow-body', path: '/api/subscribers/001010000000001/traffic-adjustments', body: {}, token: 'admin', expectStatus: 200, expectBody: { error: 'Routed to Go backend', imsi: '001010000000001' } },
      ],
    }),
  },
  {
    method: 'POST',
    path: '/api/tariff-plans/import',
    category: 'new_shadow',
    file: 'frontend/src/app/api/tariff-plans/import/route.ts',
    invoke: (req, params) => M.tariffPlanImport.POST(req, { params: Promise.resolve(params) }),
    scenarios: writeScenarios({
      pathStr: '/api/tariff-plans/import',
      body: { plan_id: 'import-alpha', name: 'Imported Alpha' },
      status: 409,
      code: 'OCS_TARIFF_CREATE_NOT_SUPPORTED',
      permission: 'ocs.tariff.write',
    }),
  },
  {
    method: 'POST',
    path: '/api/tariff-plans/{planId}/migrate',
    category: 'new_shadow',
    file: 'frontend/src/app/api/tariff-plans/[planId]/migrate/route.ts',
    invoke: (req, params) => M.tariffPlanMigrate.POST(req, { params: Promise.resolve(params) }),
    scenarios: writeScenarios({
      pathStr: '/api/tariff-plans/default-standard/migrate',
      body: { targetPlanId: 'plan-beta' },
      status: 409,
      code: 'OCS_PLAN_MIGRATION_NOT_SUPPORTED',
      permission: 'ocs.plan.assign',
    }),
  },
  {
    method: 'POST',
    path: '/api/tariff-plans/{planId}/rules',
    category: 'new_shadow',
    file: 'frontend/src/app/api/tariff-plans/[planId]/rules/route.ts',
    invoke: (req, params) => M.tariffPlanRules.POST(req, { params: Promise.resolve(params) }),
    scenarios: writeScenarios({
      pathStr: '/api/tariff-plans/default-standard/rules',
      body: { rule_id: 'rule_002', rating_group: 2 },
      status: 409,
      code: 'OCS_TARIFF_RULE_CREATE_NOT_SUPPORTED',
      permission: 'ocs.tariff.write',
    }),
  },
  {
    method: 'PUT',
    path: '/api/tariff-plans/{planId}/rules/{ruleId}',
    category: 'new_shadow',
    file: 'frontend/src/app/api/tariff-plans/[planId]/rules/[ruleId]/route.ts',
    invoke: (req, params) => M.tariffPlanRuleDetail.PUT(req, { params: Promise.resolve(params) }),
    scenarios: writeScenarios({
      pathStr: '/api/tariff-plans/default-standard/rules/rule_001',
      body: { rating_group: 3 },
      status: 409,
      code: 'OCS_TARIFF_RULE_UPDATE_NOT_SUPPORTED',
      permission: 'ocs.tariff.write',
    }),
  },
  {
    method: 'PATCH',
    path: '/api/tariff-plans/{planId}/rules/{ruleId}',
    category: 'new_shadow',
    file: 'frontend/src/app/api/tariff-plans/[planId]/rules/[ruleId]/route.ts',
    invoke: (req, params) => M.tariffPlanRuleDetail.PATCH(req, { params: Promise.resolve(params) }),
    scenarios: writeScenarios({
      pathStr: '/api/tariff-plans/default-standard/rules/rule_001',
      body: null,
      status: 409,
      code: 'OCS_TARIFF_RULE_TOGGLE_NOT_SUPPORTED',
      permission: 'ocs.tariff.write',
    }),
  },
  {
    method: 'DELETE',
    path: '/api/tariff-plans/{planId}/rules/{ruleId}',
    category: 'new_shadow',
    file: 'frontend/src/app/api/tariff-plans/[planId]/rules/[ruleId]/route.ts',
    invoke: (req, params) => M.tariffPlanRuleDetail.DELETE(req, { params: Promise.resolve(params) }),
    scenarios: writeScenarios({
      pathStr: '/api/tariff-plans/default-standard/rules/rule_001',
      body: null,
      status: 409,
      code: 'OCS_TARIFF_RULE_DELETE_NOT_SUPPORTED',
      permission: 'ocs.tariff.write',
    }),
  },
];

// ---------------------------------------------------------------------------
// Node test HTTP server (dynamic {param} aware dispatch)
// ---------------------------------------------------------------------------

function matchRoute(pattern, pathname) {
  const pSeg = pattern.split('/');
  const rSeg = pathname.split('/');
  if (pSeg.length !== rSeg.length) return null;
  const params = {};
  for (let i = 0; i < pSeg.length; i++) {
    const p = pSeg[i];
    if (p.startsWith('{') && p.endsWith('}')) {
      if (rSeg[i] === '') return null;
      params[p.slice(1, -1)] = decodeURIComponent(rSeg[i]);
    } else if (p !== rSeg[i]) {
      return null;
    }
  }
  return params;
}

function createNodeHttpServer() {
  return http.createServer(async (req, res) => {
    try {
      const urlObj = new URL(req.url, `http://127.0.0.1:${nodePort}`);
      let matchedOp = null;
      let matchedParams = null;
      for (const op of OPS) {
        if (op.method !== req.method) continue;
        const params = matchRoute(op.path, urlObj.pathname);
        if (params) {
          matchedOp = op;
          matchedParams = params;
          break;
        }
      }
      if (!matchedOp) {
        res.statusCode = 404;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: 'Not Found' }));
        return;
      }

      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const bodyBuf = Buffer.concat(chunks);
      const bodyStr = bodyBuf.length > 0 ? bodyBuf.toString('utf8') : undefined;

      const nextHeaders = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (Array.isArray(v)) {
          for (const item of v) nextHeaders.append(k, item);
        } else if (v !== undefined) {
          nextHeaders.set(k, v);
        }
      }

      if (!nextHeaders.get('x-user') && req.headers['cookie']) {
        const cookies = req.headers['cookie'].split(';');
        for (const c of cookies) {
          const [cookieKey, ...valParts] = c.trim().split('=');
          if (cookieKey === 'auth_token') {
            const cookieVal = valParts.join('=');
            try {
              const { payload } = await jwtVerify(cookieVal, new TextEncoder().encode(JWT_SECRET_STRING));
              if (payload.username) nextHeaders.set('x-user', payload.username);
              if (payload.role) nextHeaders.set('x-user-role', payload.role);
              if (payload.sv !== undefined) nextHeaders.set('x-user-session-version', String(payload.sv));
            } catch {}
          }
        }
      }

      const nextReq = new NextRequest(urlObj.toString(), {
        method: req.method,
        headers: nextHeaders,
        body: req.method !== 'GET' && req.method !== 'HEAD' && bodyStr !== undefined ? bodyStr : undefined,
      });

      try {
        const response = await matchedOp.invoke(nextReq, matchedParams);
        res.statusCode = response.status;
        for (const [k, v] of response.headers.entries()) res.setHeader(k, v);
        const data = await response.arrayBuffer();
        res.end(Buffer.from(data));
      } catch (err) {
        res.statusCode = 500;
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        res.end('Internal Server Error');
      }
    } catch (serverErr) {
      res.statusCode = 500;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end('Internal Server Error');
    }
  });
}

async function parseHttpResponse(res) {
  const contentType = res.headers.get('content-type') || '';
  const rawText = await res.text();
  const trimmed = rawText.trim();
  let parsedBody = null;
  if (contentType.includes('application/json') || trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      parsedBody = JSON.parse(rawText);
    } catch {
      parsedBody = rawText;
    }
  } else {
    parsedBody = rawText;
  }
  return { status: res.status, headers: res.headers, body: parsedBody, text: rawText };
}

const ROLE_TO_USER = { admin: 'admin_user', operator: 'operator_user', viewer: 'viewer_user' };
const TOKEN_CACHE = new Map();

async function resolveToken(roleKey) {
  if (roleKey === null) return null;
  if (!TOKEN_CACHE.has(roleKey)) {
    TOKEN_CACHE.set(roleKey, await makeToken(ROLE_TO_USER[roleKey], roleKey, 1));
  }
  return TOKEN_CACHE.get(roleKey);
}

async function callNode(pathStr, method, roleKey, body = null) {
  const token = await resolveToken(roleKey);
  const reqHeaders = { 'content-type': 'application/json' };
  if (token) reqHeaders['cookie'] = `auth_token=${token}`;
  const res = await fetch(`http://127.0.0.1:${nodePort}${pathStr}`, {
    method,
    headers: reqHeaders,
    body: body !== null && method !== 'GET' && method !== 'HEAD' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });
  return parseHttpResponse(res);
}

async function callGo(pathStr, method, roleKey, body = null) {
  const token = await resolveToken(roleKey);
  const reqHeaders = { 'content-type': 'application/json' };
  if (token) reqHeaders['cookie'] = `auth_token=${token}`;
  const res = await fetch(`http://127.0.0.1:${goPort}${pathStr}`, {
    method,
    headers: reqHeaders,
    body: body !== null && method !== 'GET' && method !== 'HEAD' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });
  return parseHttpResponse(res);
}

// ---------------------------------------------------------------------------
// Seed data (identical documents in both isolated DB pairs)
// ---------------------------------------------------------------------------

async function seedData(xcloudDbName, appDbName) {
  const xDb = client.db(xcloudDbName);
  const aDb = client.db(appDbName);

  const salt = await bcrypt.genSalt(10);
  const hash = await bcrypt.hash('TestPass123!', salt);
  await aDb.collection('app_users').insertMany([
    { username: 'admin_user', passwordHash: hash, role: 'admin', status: 'active', security: { sessionVersion: 1 }, createdAt: '2026-09-20T10:00:00.000Z' },
    { username: 'operator_user', passwordHash: hash, role: 'operator', status: 'active', security: { sessionVersion: 1 }, createdAt: '2026-09-20T10:00:00.000Z' },
    { username: 'viewer_user', passwordHash: hash, role: 'viewer', status: 'active', security: { sessionVersion: 1 }, createdAt: '2026-09-20T10:00:00.000Z' },
  ]);

  // Tariff plans
  // Explicit deterministic _id values keep both isolated databases byte-equal,
  // so document ids surfaced by either engine are directly comparable.
  await xDb.collection('ocs_tariff_plans').insertMany([
    {
      _id: new ObjectId('650000000000000000000001'),
      plan_id: 'default-standard',
      name: 'Standard Default Tariff Plan',
      description: 'Default plan',
      status: 'active',
      quota_per_grant: 10737418240,
      validity_time: 86400,
      volume_threshold: 0,
      rules: [{ rule_id: 'rule_001', rating_group: 1, status: 'active' }],
      created_at: '2026-09-20T10:00:00.000Z',
      updated_at: '2026-09-20T10:00:00.000Z',
    },
    {
      _id: new ObjectId('650000000000000000000002'),
      plan_id: 'plan-beta',
      name: 'Beta Tariff Plan',
      description: 'Migration target',
      status: 'active',
      quota_per_grant: 5368709120,
      validity_time: 86400,
      volume_threshold: 0,
      rules: [],
      created_at: '2026-09-20T10:00:00.000Z',
      updated_at: '2026-09-20T10:00:00.000Z',
    },
    // The canonical default plan with its complete legacy rule set. Seeding the
    // exact rules Node's attachLegacyRatingRules() expects means the Node read
    // path performs no repair-write, keeping both isolated databases stable.
    {
      _id: new ObjectId('650000000000000000000003'),
      plan_id: 'plan_default_10gb',
      name: 'Default 10GB Data Plan',
      description: '',
      status: 'active',
      quota_per_grant: 10485760,
      validity_time: 300,
      volume_threshold: 8388608,
      unit: 'bytes',
      rules: [
        {
          rule_id: 'internet_rg1001_si1',
          apn: 'internet',
          rating_group: 1001,
          service_identifier: 1,
          charging_type: 'data_volume',
          unit: 'bytes',
          quota_per_grant: 10485760,
          validity_time: 300,
          volume_threshold: 8388608,
          priority: 100,
          status: 'active',
        },
        {
          rule_id: 'ims_default',
          apn: 'ims',
          rating_group: 0,
          service_identifier: 0,
          charging_type: 'free',
          unit: 'bytes',
          quota_per_grant: 0,
          validity_time: 0,
          volume_threshold: 0,
          priority: 200,
          status: 'active',
        },
        {
          rule_id: 'voice_rg3001_si1',
          apn: 'ims',
          rating_group: 3001,
          service_identifier: 1,
          charging_type: 'voice_time',
          unit: 'seconds',
          quota_per_grant: 60,
          validity_time: 300,
          volume_threshold: 0,
          priority: 90,
          status: 'active',
        },
        {
          rule_id: 'sms_rg4001_si1',
          apn: 'ims',
          rating_group: 4001,
          service_identifier: 1,
          charging_type: 'sms_event',
          unit: 'events',
          quota_per_grant: 1,
          validity_time: 0,
          volume_threshold: 0,
          priority: 100,
          status: 'active',
        },
      ],
      created_at: '2026-09-20T10:00:00.000Z',
      updated_at: '2026-09-20T10:00:00.000Z',
    },
  ]);

  // Profiles
  await aDb.collection('app_profiles').insertOne({
    _id: new ObjectId('650000000000000000000011'),
    name: 'default',
    created_at: '2026-09-20T10:00:00.000Z',
  });

  // Subscribers
  await xDb.collection('subscribers').insertOne({
    _id: new ObjectId('650000000000000000000021'),
    imsi: '001010000000001',
    security: {
      k: '465B5CE8B199B49FAA5F0A2EE238A6BC',
      opc: 'E8ED289DEBA952E4283B54E88E6183CA',
    },
    slice: [{ sst: 1 }],
    ambr: { dl: 10000000, ul: 10000000 },
    profile: 'default',
  });

  // OCS Subscribers
  await xDb.collection('ocs_subscribers').insertOne({
    _id: new ObjectId('650000000000000000000031'),
    imsi: '001010000000001',
    plan_id: 'default-standard',
  });

  // OCS Balances
  await xDb.collection('ocs_balances').insertOne({
    _id: new ObjectId('650000000000000000000041'),
    imsi: '001010000000001',
    data_total: 1000000,
    data_used: 200000,
    data_reserved: 100000,
    data_available: 700000,
    voice_total: 1000,
    voice_used: 200,
    voice_reserved: 100,
    voice_available: 700,
    sms_total: 500,
    sms_used: 50,
    sms_available: 450,
  });

  // Sessions
  await xDb.collection('ocs_sessions').insertOne({
    _id: new ObjectId('650000000000000000000051'),
    session_id: 'sess-active-01',
    state: 'active',
  });

  // Reservations
  await xDb.collection('ocs_reservations').insertOne({
    _id: new ObjectId('650000000000000000000061'),
    reservation_id: 'res-active-01',
    session_id: 'sess-active-01',
    imsi: '001010000000001',
    state: 'active',
    reserved_octets: 100000,
  });

  // Audit logs baseline
  await aDb.collection('app_audit_logs').insertOne({
    action: 'system.bootstrap',
    module: 'system',
    timestamp: '2026-09-20T10:00:00.000Z',
  });
}

// ---------------------------------------------------------------------------
// Persistent state helpers
// ---------------------------------------------------------------------------

const MUTATION_COLLECTIONS = [
  'subscribers',
  'ocs_subscribers',
  'ocs_balances',
  'ocs_sessions',
  'ocs_usage_records',
  'ocs_reservations',
  'ocs_tariff_plans',
  'ocs_rating_policies',
];

function normalizeBsonValue(val) {
  if (val === null || val === undefined) return val;
  if (val instanceof Date) return { $date: val.toISOString() };
  if (Array.isArray(val)) return val.map(normalizeBsonValue);
  if (typeof val === 'object') {
    const ctorName = val.constructor ? val.constructor.name : '';
    if (val._bsontype === 'ObjectId' || ctorName === 'ObjectId') return { $oid: val.toHexString() };
    if (val._bsontype === 'Decimal128' || ctorName === 'Decimal128') return { $decimal: String(val) };
    if (val._bsontype === 'Long' || ctorName === 'Long') return { $long: String(val) };
    if (val._bsontype === 'Binary' || ctorName === 'Binary') {
      try {
        return { $binary: Buffer.from(val.buffer).toString('hex') };
      } catch {
        return { $binary: 'unreadable' };
      }
    }
    const sorted = {};
    for (const k of Object.keys(val).sort()) sorted[k] = normalizeBsonValue(val[k]);
    return sorted;
  }
  return val;
}

function stableStringify(value) {
  return JSON.stringify(value);
}

async function snapshotXCloudState(xcloudDbName) {
  const db = client.db(xcloudDbName);
  const out = {};
  for (const c of MUTATION_COLLECTIONS) {
    const docs = await db.collection(c).find({}).sort({ _id: 1 }).toArray();
    out[c] = { count: docs.length, stable: stableStringify(docs.map(normalizeBsonValue)) };
  }
  return out;
}

async function findTrafficRateLimitDocs(appDbName) {
  return client
    .db(appDbName)
    .collection('app_rate_limits')
    .find({ key: { $regex: '^RATELIMIT:traffic-adjustments:admin_user:\\d+$' } })
    .toArray();
}

async function findDenialAuditDocs(appDbName, username, permission) {
  const docs = await client.db(appDbName).collection('app_audit_logs').find({ action: 'authorization.denied' }).toArray();
  return docs.filter((d) => {
    const s = stableStringify(normalizeBsonValue(d));
    return s.includes(username) && s.includes(permission);
  });
}

async function pollUntil(fn, timeoutMs = 10000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    last = await fn();
    if (last && last.length > 0) return last;
    if (Date.now() >= deadline) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// ---------------------------------------------------------------------------
// Routing / registration invariants (exact derivations, nothing hard-coded)
// ---------------------------------------------------------------------------

function loadGoRegistrations() {
  const sources = [
    path.resolve(root, 'backend/cmd/server/main.go'),
    path.resolve(root, 'backend/internal/remediation/handler.go'),
  ].filter(existsSync);
  const regs = new Set();
  for (const file of sources) {
    const content = readFileSync(file, 'utf8');
    const re = /mux\.Handle\("(GET|POST|PUT|PATCH|DELETE)\s+([^"]+)"\s*,/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      regs.add(`${m[1]} ${m[2]}`);
    }
  }
  return regs;
}

async function loadCutoverRouting() {
  const mod = await jiti('../frontend/src/lib/cutover-routing.ts');
  const set = new Set(mod.CUTOVER_TABLE.map((r) => `${r.method} ${r.path}`));
  return { set, resolveRouteOwner: mod.resolveRouteOwner, tableLength: mod.CUTOVER_TABLE.length };
}

function concretePath(canonicalPath) {
  return canonicalPath.replace(/\{[^}]+\}/g, '__p8__');
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

async function cleanup() {
  console.log('\nCleaning up resources...');
  if (nodeServer) {
    try {
      await new Promise((resolve) => nodeServer.close(resolve));
    } catch {}
  }
  if (goProc && goProc.pid) {
    if (process.platform === 'win32') {
      try {
        execSync(`taskkill /pid ${goProc.pid} /T /F`, { stdio: 'ignore' });
      } catch {}
    } else {
      try {
        goProc.kill('SIGTERM');
      } catch {}
    }
  }
  if (binPath && existsSync(binPath)) {
    try {
      unlinkSync(binPath);
    } catch {}
  }
  try {
    await client.db(xcloudDbNode).dropDatabase();
    await client.db(appDbNode).dropDatabase();
    await client.db(xcloudDbGo).dropDatabase();
    await client.db(appDbGo).dropDatabase();
  } catch {}
  try {
    await client.close();
  } catch {}
  process.exit(process.exitCode || 0);
}

// ---------------------------------------------------------------------------
// Machine-readable Phase 8.1 summary
// ---------------------------------------------------------------------------

const machineCounters = {
  expected: 0,
  executed: 0,
  missing: 0,
  duplicate: 0,
  existingExpected: 0,
  newExpected: 0,
  existingExecuted: 0,
  newExecuted: 0,
  goRegistered: 0,
  cutoverCount: 0,
  runtimeNode: 0,
  scenariosExecuted: 0,
  scenariosFailed: 0,
};
let machinePrinted = false;

function printMachineBlock(resultOverride) {
  if (machinePrinted) return;
  machinePrinted = true;
  const c = machineCounters;
  const result =
    resultOverride ||
    (failed === 0 &&
    c.missing === 0 &&
    c.duplicate === 0 &&
    c.executed === c.expected &&
    c.goRegistered === c.expected &&
    c.cutoverCount === 0 &&
    c.runtimeNode === c.expected
      ? 'PASS'
      : 'FAIL');
  console.log('\n-- Phase 8.1 machine-readable summary --');
  console.log(`phase81_residual_expected=${c.expected}`);
  console.log(`phase81_residual_executed=${c.executed}`);
  console.log(`phase81_residual_missing=${c.missing}`);
  console.log(`phase81_residual_duplicate=${c.duplicate}`);
  console.log(`phase81_existing_shadow_expected=${c.existingExpected}`);
  console.log(`phase81_new_shadow_expected=${c.newExpected}`);
  console.log(`phase81_existing_shadow_executed=${c.existingExecuted}`);
  console.log(`phase81_new_shadow_executed=${c.newExecuted}`);
  console.log(`phase81_go_registered=${c.goRegistered}`);
  console.log(`phase81_cutover_count=${c.cutoverCount}`);
  console.log(`phase81_runtime_node=${c.runtimeNode}`);
  console.log(`phase81_scenarios_executed=${c.scenariosExecuted}`);
  console.log(`phase81_scenarios_failed=${c.scenariosFailed}`);
  console.log(`phase81_result=${result}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('===============================================================');
  console.log('Phase 8.1 - Residual API Node<->Go Shadow Parity Suite');
  console.log('===============================================================');

  await client.connect();
  console.log('Connected to MongoDB at', uri);

  console.log('Seeding Node test databases:', xcloudDbNode, appDbNode);
  await seedData(xcloudDbNode, appDbNode);
  console.log('Seeding Go test databases:', xcloudDbGo, appDbGo);
  await seedData(xcloudDbGo, appDbGo);

  // ---- Build + start Go production binary --------------------------------
  goPort = await getAvailablePort();
  console.log('Building Go production backend binary...');
  const isWin = process.platform === 'win32';
  const binName = isWin ? `test-p81-parity-${suffix}.exe` : `test-p81-parity-${suffix}`;
  const backendDir = path.resolve(root, 'backend');
  binPath = path.join(os.tmpdir(), binName);

  execSync(`go build -o "${binPath}" ./cmd/server`, { cwd: backendDir, stdio: 'ignore' });
  assert.ok(existsSync(binPath), 'compiled Go production binary must exist');
  console.log('Go production binary compiled successfully:', binPath);

  console.log(`Starting Go production backend on 127.0.0.1:${goPort}...`);
  goProc = spawn(binPath, [], {
    cwd: backendDir,
    env: {
      ...process.env,
      HTTP_ADDR: `127.0.0.1:${goPort}`,
      MONGODB_URI: uri,
      MONGODB_XCLOUD_DB: xcloudDbGo,
      MONGODB_APP_DB: appDbGo,
      JWT_SECRET: JWT_SECRET_STRING,
    },
    stdio: ['ignore', 'ignore', 'inherit'],
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
  assert.ok(goReady, 'timeout waiting for Go server to become ready');
  console.log('Go production server ready on port', goPort);

  // ---- Start Node test HTTP server ---------------------------------------
  nodePort = await getAvailablePort();
  nodeServer = createNodeHttpServer();
  await new Promise((resolve) => {
    nodeServer.listen(nodePort, '127.0.0.1', () => {
      console.log(`Node HTTP test server listening on 127.0.0.1:${nodePort}`);
      resolve();
    });
  });

  // ---- 1. Inventory integrity --------------------------------------------
  console.log('\n--- 1. Residual inventory integrity (33 operations) ---');
  const expectedKeys = OPS.map((o) => `${o.method} ${o.path}`);
  const expectedSet = new Set(expectedKeys);
  const duplicates = expectedKeys.filter((k, i) => expectedKeys.indexOf(k) !== i);
  machineCounters.expected = expectedSet.size;
  machineCounters.duplicate = duplicates.length;
  machineCounters.existingExpected = OPS.filter((o) => o.category === 'existing_shadow').length;
  machineCounters.newExpected = OPS.filter((o) => o.category === 'new_shadow').length;

  verify('residual inventory has exactly 33 unique operations', () => {
    assert.equal(machineCounters.expected, 33, `expected 33 operations, got ${machineCounters.expected}`);
    assert.equal(duplicates.length, 0, `duplicate operations: ${duplicates.join(', ')}`);
    assert.equal(machineCounters.existingExpected, 22, 'expected 22 pre-existing shadows');
    assert.equal(machineCounters.newExpected, 11, 'expected 11 newly implemented shadows');
  });

  // ---- 2. Routing / registration invariants ------------------------------
  console.log('\n--- 2. Routing / registration invariants (go_registered/cutover/runtime) ---');
  const goRegs = loadGoRegistrations();
  const cutover = await loadCutoverRouting();
  verify('CUTOVER_TABLE integrity unchanged at 47', () => {
    assert.equal(cutover.tableLength, 47, `CUTOVER_TABLE must remain 47, got ${cutover.tableLength}`);
  });

  let goRegistered = 0;
  let cutoverContained = 0;
  let runtimeNode = 0;

  for (const op of OPS) {
    const key = `${op.method} ${op.path}`;
    const isRegistered = goRegs.has(key);
    const isCutover = cutover.set.has(key);
    let runtime = 'unknown';
    try {
      const routed = cutover.resolveRouteOwner(op.method, concretePath(op.path));
      runtime = routed === 'go' ? 'go' : routed === 'node' ? 'node' : 'unknown';
    } catch {}
    const nodeFileExists = existsSync(path.resolve(root, op.file));

    if (isRegistered) goRegistered++;
    if (isCutover) cutoverContained++;
    if (runtime === 'node' && !isCutover) runtimeNode++;

    op.evidence = { key, isRegistered, isCutover, runtime, nodeFileExists };

    verify(`${key} go_registered=true cutover=false runtime_owner=node`, () => {
      assert.ok(isRegistered, `${key} must be registered by the production Go source`);
      assert.ok(!isCutover, `${key} must NOT be in CUTOVER_TABLE`);
      assert.equal(runtime, 'node', `${key} runtime owner must be node, got ${runtime}`);
      assert.ok(nodeFileExists, `${key} backing Node route file must exist: ${op.file}`);
    });
  }

  machineCounters.goRegistered = goRegistered;
  machineCounters.cutoverCount = cutoverContained;
  machineCounters.runtimeNode = runtimeNode;

  // ---- 3. Per-operation real HTTP parity scenarios -----------------------
  console.log('\n--- 3. Real HTTP parity scenarios (Node vs Go, isolated DBs) ---');
  const xcloudStateBeforeNode = await snapshotXCloudState(xcloudDbNode);
  const xcloudStateBeforeGo = await snapshotXCloudState(xcloudDbGo);

  for (const op of OPS) {
    console.log(`\n  [${op.category}] ${op.method} ${op.path}`);
    for (const sc of op.scenarios) {
      await verifyAsync(`parity ${op.method} ${op.path} [${sc.name}]`, async () => {
        const nodeRes = await callNode(sc.path, op.method, sc.token ?? null, sc.body ?? null);
        const goRes = await callGo(sc.path, op.method, sc.token ?? null, sc.body ?? null);

        assert.equal(
          nodeRes.status,
          goRes.status,
          `status parity: node=${nodeRes.status} go=${goRes.status} (node body: ${nodeRes.text.slice(0, 200)})`
        );

        if (sc.expectStatus !== undefined) {
          assert.equal(nodeRes.status, sc.expectStatus, `Node authority status must be ${sc.expectStatus}, got ${nodeRes.status} (${nodeRes.text.slice(0, 200)})`);
          assert.equal(goRes.status, sc.expectStatus, `Go status must be ${sc.expectStatus}, got ${goRes.status} (${goRes.text.slice(0, 200)})`);
        }
        if (sc.expectCode !== undefined) {
          assert.equal(nodeRes.body?.code, sc.expectCode, `Node code must be ${sc.expectCode}, got ${JSON.stringify(nodeRes.body)}`);
          assert.equal(goRes.body?.code, sc.expectCode, `Go code must be ${sc.expectCode}, got ${JSON.stringify(goRes.body)}`);
        }
        if (sc.expectPermission !== undefined) {
          assert.equal(nodeRes.body?.permission, sc.expectPermission, `Node permission must be ${sc.expectPermission}`);
          assert.equal(goRes.body?.permission, sc.expectPermission, `Go permission must be ${sc.expectPermission}`);
        }
        if (sc.expectBody !== undefined) {
          assert.deepStrictEqual(nodeRes.body, sc.expectBody, `Node body must equal the frozen contract; got ${JSON.stringify(nodeRes.body)}`);
          assert.deepStrictEqual(goRes.body, sc.expectBody, `Go body must equal the frozen contract; got ${JSON.stringify(goRes.body)}`);
        }

        // Full JSON contract parity on the actual payloads. Only truly
        // non-deterministic fields are explicitly normalized (validated then
        // sentinel-replaced); everything else must match exactly.
        const normalize = op.normalizeBody || ((b) => b);
        const nodeBody = normalize(nodeRes.body);
        const goBody = normalize(goRes.body);
        assert.deepStrictEqual(goBody, nodeBody, `body parity: node=${JSON.stringify(nodeBody)?.slice(0, 300)} go=${JSON.stringify(goBody)?.slice(0, 300)}`);

        // JSON content type on both sides.
        assert.ok((nodeRes.headers.get('content-type') || '').includes('application/json'), 'Node response must be JSON');
        assert.ok((goRes.headers.get('content-type') || '').includes('application/json'), 'Go response must be JSON');

        // Authorized reads must not surface a 5xx on either engine.
        if (sc.name === 'authorized-read') {
          assert.ok(nodeRes.status < 500, `Node authorized read returned ${nodeRes.status}`);
          assert.ok(goRes.status < 500, `Go authorized read returned ${goRes.status}`);
        }

        machineCounters.scenariosExecuted++;
        op.executed = true;
        op.scenarioCount = (op.scenarioCount || 0) + 1;
      }).catch((err) => {
        machineCounters.scenariosFailed++;
        throw err;
      });
    }
  }

  machineCounters.executed = OPS.filter((o) => o.executed).length;
  machineCounters.missing = machineCounters.expected - machineCounters.executed;
  machineCounters.existingExecuted = OPS.filter((o) => o.category === 'existing_shadow' && o.executed).length;
  machineCounters.newExecuted = OPS.filter((o) => o.category === 'new_shadow' && o.executed).length;

  console.log('\n--- 4. Coverage accounting ---');
  verify('all 33 residual operations executed at least one scenario', () => {
    assert.equal(machineCounters.missing, 0, `missing executions: ${OPS.filter((o) => !o.executed).map((o) => `${o.method} ${o.path}`).join(', ')}`);
    assert.equal(machineCounters.existingExecuted, 22, 'all 22 pre-existing shadows must execute');
    assert.equal(machineCounters.newExecuted, 11, 'all 11 new shadows must execute');
  });

  // ---- 5. Persistent-state parity / no unexpected mutation ---------------
  console.log('\n--- 5. Persistent-state parity (no unexpected mutation) ---');
  const xcloudStateAfterNode = await snapshotXCloudState(xcloudDbNode);
  const xcloudStateAfterGo = await snapshotXCloudState(xcloudDbGo);

  verify('Node test DB xcloud collections unchanged by shadow scenarios', () => {
    assert.deepStrictEqual(xcloudStateAfterNode, xcloudStateBeforeNode, 'Node xcloud state must be byte-stable across scenarios');
  });
  verify('Go test DB xcloud collections unchanged by shadow scenarios', () => {
    assert.deepStrictEqual(xcloudStateAfterGo, xcloudStateBeforeGo, 'Go xcloud state must be byte-stable across scenarios');
  });
  verify('cross-engine document counts identical for all mutation collections', () => {
    for (const c of MUTATION_COLLECTIONS) {
      assert.equal(
        xcloudStateAfterGo[c].count,
        xcloudStateAfterNode[c].count,
        `collection ${c}: node=${xcloudStateAfterNode[c].count} go=${xcloudStateAfterGo[c].count}`
      );
    }
  });

  // Traffic adjustments consume the Node-parity rate limit identifier on both
  // engines. Both authorized attempts (the base scenario and the allow-body
  // extra) pass through the shared `traffic-adjustments:<user>` limiter.
  await verifyAsync('traffic-adjustments consumes RATELIMIT:traffic-adjustments:admin_user on both engines', async () => {
    const nodeDocs = await findTrafficRateLimitDocs(appDbNode);
    const goDocs = await findTrafficRateLimitDocs(appDbGo);
    assert.equal(nodeDocs.length, 1, `Node app_rate_limits must contain exactly one matching doc, got ${nodeDocs.length}`);
    assert.equal(goDocs.length, 1, `Go app_rate_limits must contain exactly one matching doc, got ${goDocs.length}`);
    assert.equal(nodeDocs[0].count, 2, `Node rate limit count must be 2, got ${nodeDocs[0].count}`);
    assert.equal(goDocs[0].count, 2, `Go rate limit count must be 2, got ${goDocs[0].count}`);
  });

  // Authorization denial evidence for the viewer-denied scenario (POST /api/ratings).
  await verifyAsync('authorization.denied audit evidence written by both engines (viewer, ocs.rating.write)', async () => {
    // Flush Node's scheduled best-effort audit writes before asserting.
    await drainAfter();
    const nodeDocs = await pollUntil(() => findDenialAuditDocs(appDbNode, 'viewer_user', 'ocs.rating.write'));
    const goDocs = await pollUntil(() => findDenialAuditDocs(appDbGo, 'viewer_user', 'ocs.rating.write'));
    assert.ok(nodeDocs.length > 0, 'Node must record authorization.denied evidence for the viewer denial');
    assert.ok(goDocs.length > 0, 'Go must record authorization.denied evidence for the viewer denial');
  });

  // ---- 6. Evidence matrix -------------------------------------------------
  console.log('\n--- 6. Per-operation evidence matrix ---');
  for (const op of OPS) {
    const e = op.evidence;
    console.log(
      `phase81_op: ${e.key} category=${op.category} go_registered=${e.isRegistered} cutover=${e.isCutover} runtime_owner=${e.runtime} scenarios=${op.scenarioCount}`
    );
  }

  console.log('\n===============================================================');
  console.log('Phase 8.1 Residual Parity Suite Summary');
  console.log('===============================================================');
  console.log(`TOTAL: ${totalChecks}`);
  console.log(`PASS:  ${passed}`);
  console.log(`FAIL:  ${failed}`);
  console.log('===============================================================');
}

main()
  .then(async () => {
    printMachineBlock();
    if (failed > 0) {
      process.exitCode = 1;
    }
    await cleanup();
  })
  .catch(async (err) => {
    console.error('Test suite failed:', err);
    process.exitCode = 1;
    printMachineBlock('FAIL');
    await cleanup();
  });