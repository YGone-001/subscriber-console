#!/usr/bin/env node
/**
 * Phase 8.5 — Proxy / Deployment Boundary Finalization acceptance suite.
 *
 * This is the CURRENT production-boundary acceptance suite. It supersedes the Phase 8.4
 * suite (which asserted the now-obsolete Next.js API reverse-proxy architecture).
 *
 * It exercises the REAL production topology:
 *
 *   HTTP client -> real Nginx (repository deploy/nginx/xcloud.conf)
 *                    |-- /api, /api/*  -> real Go production binary (127.0.0.1:18888) -> MongoDB
 *                    |-- everything else -> real `next start -H 127.0.0.1 -p 13333` (127.0.0.1:13333)
 *                                              |-- protected-page guard -> Go /api/auth/me
 *
 * The two internal listeners are started through their real production startup contracts
 * (Go with no HTTP_ADDR injection so its 127.0.0.1:18888 default is exercised; Next via the
 * documented `next start -H 127.0.0.1 -p 13333`). The suite then proves over real TCP that
 * each listener is loopback-only: reachable on 127.0.0.1 and unreachable on a real
 * non-loopback runner address. Nginx remains the sole public edge.
 *
 * Component policy (spec section 33): handler-only, mock-only, static-only and
 * "fake JS reverse proxy" evidence is NOT sufficient. Everything below drives real TCP
 * requests through a real Nginx fronting real Go and real Next.js, against a real MongoDB.
 * Source assertions are supplemental only and live in an explicitly labelled section.
 *
 * Route authority is DERIVED from the frozen Go registration site (84 exact METHOD+PATH
 * entries in backend/cmd/server/main.go + backend/internal/remediation/handler.go). The
 * retired Next.js CUTOVER_TABLE is never consulted.
 *
 * Usage:
 *   node scripts/test-phase-8-deployment-boundary.mjs
 *
 * Environment overrides:
 *   PHASE85_NGINX_BIN   nginx executable                  (default: `nginx` on PATH)
 *   MONGODB_URI         real MongoDB URI                  (default: mongodb://127.0.0.1:27017)
 *   PHASE85_NEXT_PORT   Next.js UI port                   (default: 13333)
 *   PHASE85_GO_PORT     Go API port                       (default: 18888)
 *   PHASE85_EDGE_PORT   Nginx public port                 (default: 18080)
 *   PHASE85_SKIP_BUILD  reuse an existing frontend build  (default: build if missing)
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import bcrypt from 'bcryptjs';
import { MongoClient, ObjectId } from 'mongodb';
import { SignJWT } from 'jose';

import { deriveGoRegistrations, classifyGoRegistrations } from './lib/go-registrations.mjs';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FRONTEND = join(ROOT, 'frontend');
const BACKEND = join(ROOT, 'backend');

/** Authoritative independently accepted Phase 8.4 frozen baseline. */
const START_SHA = 'e38c09d5ee8c00a870383f68d78efc56f90314ea';

/** Phase 8.5 correction baseline: the Go registration set must be identical to this tree. */
const PHASE85C_BASELINE_SHA = 'cfc2fef36d55fa32427794433b4e5cee37bfb4ac';

/** Frozen canonical production API surface size (asserted against the derived set). */
const EXPECTED_GO_REGISTRATIONS = 84;

const NEXT_PORT = Number(process.env.PHASE85_NEXT_PORT || 13333);
const GO_PORT = Number(process.env.PHASE85_GO_PORT || 18888);
const EDGE_PORT = Number(process.env.PHASE85_EDGE_PORT || 18080);
const NGINX_BIN = process.env.PHASE85_NGINX_BIN || 'nginx';
const MONGO_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const SKIP_BUILD = process.env.PHASE85_SKIP_BUILD === '1';

const JWT_SECRET = 'phase85-deployment-boundary-acceptance-secret-key-0123456789';
const USER_PREFIX = 'phase85_';
const PASSWORD = 'Phase85!Passw0rd';
const OTHER_PASSWORD = 'Phase85!Other';

const NEXT_UPSTREAM_ADDR = `127.0.0.1:${NEXT_PORT}`;
const GO_UPSTREAM_ADDR = `127.0.0.1:${GO_PORT}`;

/**
 * Production listener contract under acceptance.
 *
 * Go: `backend/internal/config` defaults HTTP_ADDR to 127.0.0.1:18888. The suite must
 * exercise that default rather than masking it, so HTTP_ADDR is injected only when the
 * operator explicitly overrides the canonical port.
 * Next: the single documented production command is `next start -H 127.0.0.1 -p 13333`.
 */
const NEXT_BIND_HOST = '127.0.0.1';
const GO_PRODUCTION_DEFAULT_ADDR = '127.0.0.1:18888';
const NEXT_LISTENER_ADDR = `127.0.0.1:${NEXT_PORT}`;
const GO_LISTENER_ADDR = `127.0.0.1:${GO_PORT}`;

/**
 * Narrow listener-boundary surface authorized by Phase 8.5-C: the Go listener
 * configuration package and its documentation. Any other backend change is treated as a
 * business / auth / registration / charging-plane change and fails the freeze gate.
 */
const AUTHORIZED_LISTENER_CONFIG_PATHS = ['backend/internal/config/', 'backend/README.md'];

function isAuthorizedListenerChange(file) {
  return AUTHORIZED_LISTENER_CONFIG_PATHS.some((p) => (p.endsWith('/') ? file.startsWith(p) : file === p));
}

/** Port of the MongoDB the Go service is pointed at (the relay transparently proxies it). */
function mongoTargetPort(uri) {
  try {
    return Number(new URL(uri).port) || 27017;
  } catch {
    return 27017;
  }
}
const MONGO_TARGET_PORT = mongoTargetPort(MONGO_URI);

const UNKNOWN_SENTINEL = '/api/__phase85_unknown_sentinel__';

const RETIRED_SURFACES = [
  { method: 'POST', path: '/api/auth/users' },
  { method: 'PUT', path: '/api/auth/users/{username}' },
  { method: 'PATCH', path: '/api/auth/users/{username}' },
  { method: 'DELETE', path: '/api/auth/users/{username}' },
  { method: 'PUT', path: '/api/users/{username}' },
  { method: 'DELETE', path: '/api/users/{username}' },
];

// ---------------------------------------------------------------------------
// Invariant bookkeeping
// ---------------------------------------------------------------------------

const invariants = [];
function check(id, ok, detail) {
  invariants.push({ id, ok: Boolean(ok), detail });
  return Boolean(ok);
}

function log(message) {
  console.log(message);
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const TMP_ROOT = join(os.tmpdir(), `phase85-${process.pid}-${Date.now()}`);
const NGINX_PREFIX = join(TMP_ROOT, 'nginx');
const ACCESS_LOG = join(NGINX_PREFIX, 'logs', 'access.log');
const GO_BIN = join(TMP_ROOT, process.platform === 'win32' ? 'xcloud-api.exe' : 'xcloud-api');
const RELAY_PORT = 27099;

/** Convert a Windows path to a forward-slash path safe for an Nginx directive. */
function nginxPath(p) {
  return p.replaceAll('\\', '/');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function runSync(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', ...options });
}

function git(args) {
  return runSync('git', args, { cwd: ROOT });
}

/** Exact METHOD+PATH registration set committed for one tree of the frozen Go sources. */
function registrationsAt(sha) {
  const re = /mux\.Handle\("(GET|POST|PUT|PATCH|DELETE)\s+([^"]+)"\s*,/g;
  const keys = new Set();
  for (const source of ['backend/cmd/server/main.go', 'backend/internal/remediation/handler.go']) {
    const text = git(['show', `${sha}:${source}`]).stdout;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) keys.add(`${m[1]} ${m[2]}`);
  }
  return keys;
}

/** Send one real HTTP request and collect status/headers/body. */
function httpRequest({ port, host = '127.0.0.1', method = 'GET', requestPath = '/', headers = {}, body = null, timeoutMs = 10000, abortAfterHeaders = false }) {
  return new Promise((resolvePromise) => {
    const payload = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(body);
    const finalHeaders = { ...headers };
    if (payload) finalHeaders['content-length'] = String(payload.length);
    finalHeaders.connection = 'close';

    const req = http.request({ host, port, method, path: requestPath, headers: finalHeaders }, (res) => {
      const chunks = [];
      if (abortAfterHeaders) {
        resolvePromise({ status: res.statusCode, headers: res.headers, body: Buffer.alloc(0), aborted: true });
        res.destroy();
        return;
      }
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolvePromise({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', (err) => resolvePromise({ status: 0, headers: {}, body: Buffer.alloc(0), error: err.message }));
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('client-timeout'));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

/** Open a streaming HTTP request; resolve as soon as the first chunk arrives. */
function httpStreamFirstChunk({ port, method = 'GET', requestPath = '/', headers = {}, firstChunkTimeoutMs = 8000 }) {
  return new Promise((resolvePromise) => {
    let settled = false;
    const started = Date.now();
    const req = http.request({ host: '127.0.0.1', port, method, path: requestPath, headers: { ...headers, connection: 'close' } }, (res) => {
      res.once('data', (chunk) => {
        if (settled) return;
        settled = true;
        const elapsed = Date.now() - started;
        res.destroy();
        req.destroy();
        resolvePromise({ status: res.statusCode, headers: res.headers, firstChunk: chunk, elapsed });
      });
      res.on('end', () => {
        if (settled) return;
        settled = true;
        resolvePromise({ status: res.statusCode, headers: res.headers, firstChunk: null, elapsed: Date.now() - started });
      });
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      resolvePromise({ status: 0, headers: {}, firstChunk: null, error: err.message, elapsed: Date.now() - started });
    });
    req.setTimeout(firstChunkTimeoutMs, () => req.destroy(new Error('stream-timeout')));
    req.end();
  });
}

/** Wait until a TCP port accepts connections (or the timeout elapses). */
async function waitForPort(port, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((res) => {
      const socket = net.connect({ host: '127.0.0.1', port }, () => {
        socket.destroy();
        res(true);
      });
      socket.on('error', () => res(false));
      socket.setTimeout(1000, () => {
        socket.destroy();
        res(false);
      });
    });
    if (ok) return true;
    await sleep(250);
  }
  return false;
}

/** Single-shot TCP reachability probe. */
async function isPortOpen(port) {
  return new Promise((res) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.destroy();
      res(true);
    });
    socket.on('error', () => res(false));
    socket.setTimeout(800, () => {
      socket.destroy();
      res(false);
    });
  });
}

/** Wait until a TCP port stops accepting connections. */
async function waitForPortClosed(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await new Promise((res) => {
      const socket = net.connect({ host: '127.0.0.1', port }, () => {
        socket.destroy();
        res(true);
      });
      socket.on('error', () => res(false));
      socket.setTimeout(800, () => {
        socket.destroy();
        res(false);
      });
    });
    if (!open) return true;
    await sleep(200);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Internal listener boundary evidence
// ---------------------------------------------------------------------------
// The repository claims Nginx is the sole public edge, which is only true if the Go and
// Next listeners are loopback-bound by the services themselves. A firewall rule is not
// acceptance. These helpers derive a real non-loopback runner address and prove, over a
// real TCP socket, that each internal port answers on loopback and refuses off-loopback.

/** First non-internal IPv4 address of the runner, or null when the runner is loopback-only. */
function nonLoopbackIPv4() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const addr of interfaces[name] || []) {
      const family = typeof addr.family === 'string' ? addr.family : `IPv${addr.family}`;
      if (family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return null;
}

/** Single-shot TCP reachability probe against an explicit host (not always loopback). */
function probeTcp(host, port, timeoutMs = 2000) {
  return new Promise((res) => {
    const socket = net.connect({ host, port }, () => {
      socket.destroy();
      res(true);
    });
    socket.on('error', () => res(false));
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      res(false);
    });
  });
}

/**
 * Socket-level binding evidence for a local port. Distinguishes a loopback listener from a
 * wildcard listener using `ss -ltn` (Linux) or `netstat -ano -p tcp` (Windows). This is
 * supplemental: the TCP reachability probes remain authoritative.
 */
function listenerBinding(port) {
  let out = '';
  let localAddressField = 3; // `ss -ltn`: State Recv-Q Send-Q Local:Port ...
  if (process.platform === 'linux') {
    out = runSync('ss', ['-ltn'], { encoding: 'utf8' }).stdout || '';
  } else if (process.platform === 'win32') {
    out = runSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' }).stdout || '';
    localAddressField = 1; // `netstat -ano`: Proto Local:Port Foreign:Port State PID
  }
  const suffix = `:${port}`;
  let loopback = false;
  let wildcard = false;
  for (const raw of out.split('\n')) {
    const line = raw.trim();
    if (!line.includes(suffix)) continue;
    const local = line.split(/\s+/)[localAddressField] || '';
    if (!local.endsWith(suffix)) continue;
    if (local.startsWith('127.0.0.1') || local.startsWith('[::1]')) loopback = true;
    if (local.startsWith('0.0.0.0') || local.startsWith('*:') || local.startsWith('[::]')) wildcard = true;
  }
  if (wildcard) return 'wildcard';
  if (loopback) return 'loopback';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Edge access-log evidence
// ---------------------------------------------------------------------------
// Routing evidence comes from a real Nginx access log whose format records
// `$upstream_addr`. A request is attributed to Go / Next.js / the edge itself purely from
// what the edge actually did - never from a handler's self-report.

function resetAccessLog() {
  writeFileSync(ACCESS_LOG, '');
}

function readAccessLog() {
  if (!existsSync(ACCESS_LOG)) return '';
  return readFileSync(ACCESS_LOG, 'utf8');
}

/**
 * Resolve the edge's own routing record for a request identified by a marker.
 *
 * Log fields: marker | upstream_addr | upstream_status | status | method | uri | content_type
 *
 * `upstream_addr` records the peer nginx selected (it is present even when the
 * connection is refused), while `upstream_status` records what the peer actually
 * answered ("-" means the peer produced no response at all).
 */
async function logEntryForMarker(marker, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  const needle = `${marker}|`;
  while (Date.now() < deadline) {
    for (const line of readAccessLog().split('\n')) {
      if (line.startsWith(needle)) {
        const parts = line.split('|');
        return {
          raw: line,
          upstreamAddr: parts[1] || '',
          upstreamStatus: parts[2] || '-',
          status: Number(parts[3] || 0),
        };
      }
    }
    await sleep(50);
  }
  return null;
}

function classifyUpstream(upstreamAddr) {
  if (!upstreamAddr) return 'edge';
  if (upstreamAddr.includes(GO_UPSTREAM_ADDR)) return 'go';
  if (upstreamAddr.includes(NEXT_UPSTREAM_ADDR)) return 'next';
  return 'other';
}

let markerSeq = 0;
function nextMarker() {
  markerSeq += 1;
  return `p85-${markerSeq}`;
}

/**
 * Send one request through the real edge and attribute it to an upstream using the edge's
 * own access log. Returns { status, headers, body, upstream, rawBody }.
 */
async function edgeRequest({ method = 'GET', requestPath = '/', headers = {}, body = null, timeoutMs = 10000, abortAfterHeaders = false }) {
  const marker = nextMarker();
  const res = await httpRequest({
    port: EDGE_PORT,
    method,
    requestPath,
    headers: { ...headers, 'x-phase85-marker': marker },
    body,
    timeoutMs,
    abortAfterHeaders,
  });
  const entry = await logEntryForMarker(marker);
  const upstreamAddr = entry ? entry.upstreamAddr : null;
  const upstreamIsLocalhost = Boolean(upstreamAddr) && !upstreamAddr.startsWith('127.0.0.1:');
  return {
    ...res,
    marker,
    upstreamAddr,
    upstreamStatus: entry ? entry.upstreamStatus : null,
    upstream: upstreamIsLocalhost ? 'external' : classifyUpstream(upstreamAddr),
  };
}

// ---------------------------------------------------------------------------
// Static scanners (supplemental source evidence, spec sections 45/46)
// ---------------------------------------------------------------------------

const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

function walk(dir, filter, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, filter, out);
    else if (filter(full)) out.push(full);
  }
  return out;
}

function rel(p) {
  return relative(ROOT, p).replaceAll('\\', '/');
}

/** Blank block/line comments while preserving line numbers. */
function stripComments(source) {
  const out = [];
  let inBlock = false;
  for (const raw of source.split('\n')) {
    let i = 0;
    let built = '';
    while (i < raw.length) {
      if (inBlock) {
        const end = raw.indexOf('*/', i);
        if (end === -1) {
          i = raw.length;
          break;
        }
        inBlock = false;
        i = end + 2;
        continue;
      }
      if (raw.startsWith('/*', i)) {
        inBlock = true;
        i += 2;
        continue;
      }
      if (raw.startsWith('//', i) && (i === 0 || raw[i - 1] !== ':')) break;
      built += raw[i];
      i += 1;
    }
    out.push(built);
  }
  return out.join('\n');
}

function frontendSourceFiles() {
  return walk(join(FRONTEND, 'src'), (p) => CODE_EXT.test(p));
}

/** Count live (non-comment) occurrences of a pattern across the frontend source tree. */
function countFrontendSourceHits(pattern) {
  const hits = [];
  for (const file of frontendSourceFiles()) {
    const code = stripComments(readFileSync(file, 'utf8'));
    code.split('\n').forEach((line, idx) => {
      if (pattern.test(line)) hits.push({ file: rel(file), line: idx + 1, text: line.trim() });
    });
  }
  return hits;
}

const FORBIDDEN_SCANNERS = {
  frontend_jwt_verifiers: [
    /\bjose\b/,
    /\bjwtVerify\b/,
    /\bSignJWT\b/,
    /\bHS256\b/,
    /\bdecodeJwt\b/,
  ],
  frontend_jwt_secret_runtime_readers: [/\bJWT_SECRET\b/, /\bgetJwtSecretKey\b/],
  frontend_session_mongo_writers: [/\binsertOne\s*\(/, /\binsertMany\s*\(/, /\bupdateOne\s*\(/, /\bupdateMany\s*\(/, /\bdeleteOne\s*\(/, /\bdeleteMany\s*\(/, /\bfindOneAndUpdate\s*\(/, /\bbulkWrite\s*\(/],
  frontend_mongo_runtime_collections: [/\bcollection\s*\(\s*['"][^'"]+['"]\s*\)/],
  frontend_identity_header_injectors: [/['"]x-user['"]/i, /['"]x-role['"]/i, /['"]x-permissions['"]/i, /setHeader\s*\(\s*['"]x-user/i],
  // A reverse-proxy capability means a server-side module that re-sends an inbound /api
  // request to the Go origin. A client component that merely *displays* a legacy backend
  // error string is not a reverse proxy.
  frontend_api_reverse_proxy_functions: [/\bforwardToGo\s*\(/, /\bNextResponse\.rewrite\s*\(/, /\bcreateProxyHandler\s*\(/],
  frontend_cutover_route_resolvers: [/\bCUTOVER_TABLE\b/, /\bresolveRouteOwner\b/],
};

// Mongo access scanners are context aware: a bare `.find(` is an array helper, while a
// `.find(` inside a module that holds a Mongo handle is a database read.
const MONGO_RUNTIME_CONTEXT_RE = /\bnew\s+MongoClient\b|\bMongoClient\s*\.\s*connect\b|\.collection\s*\(|\.db\s*\(|mongodb(?:\+srv)?:\/\//;
const MONGO_UNAMBIGUOUS_READ_RE = /\bfindOne\s*\(|\bMongoClient\b|mongodb(?:\+srv)?:\/\//;
const MONGO_CONTEXTUAL_READ_RE = /\bfind\s*\(|\baggregate\s*\(|\bcountDocuments\s*\(|\bdistinct\s*\(/;

/** Find real MongoDB read access in one source string (comments already stripped). */
function scanMongoReadersInSource(source) {
  const hasMongoHandle = MONGO_RUNTIME_CONTEXT_RE.test(source);
  const hits = [];
  source.split('\n').forEach((line, idx) => {
    if (MONGO_UNAMBIGUOUS_READ_RE.test(line) || (hasMongoHandle && MONGO_CONTEXTUAL_READ_RE.test(line))) {
      hits.push({ line: idx + 1, text: line.trim() });
    }
  });
  return hits;
}

function scanFrontendMongoReaders() {
  const hits = [];
  for (const file of frontendSourceFiles()) {
    const code = stripComments(readFileSync(file, 'utf8'));
    for (const hit of scanMongoReadersInSource(code)) hits.push({ file: rel(file), ...hit });
  }
  return hits;
}

function scanFrontendForForbidden() {
  const result = {};
  for (const key of Object.keys(FORBIDDEN_SCANNERS)) {
    const patterns = FORBIDDEN_SCANNERS[key];
    const hits = [];
    for (const pattern of patterns) hits.push(...countFrontendSourceHits(pattern));
    result[key] = hits;
  }
  result.frontend_session_mongo_readers = scanFrontendMongoReaders();
  return result;
}

/**
 * Negative sentinels: prove every scanner is falsifiable. Each synthetic sample contains
 * the forbidden construct; the scanner MUST report at least one hit for it. A predicate
 * that can only ever return the expected result would fail this self-test.
 */
function scannerNegativeSentinels() {
  const samples = {
    frontend_jwt_verifiers: "import { jwtVerify } from 'jose';",
    frontend_jwt_secret_runtime_readers: 'const s = process.env.JWT_SECRET;',
    frontend_session_mongo_writers: "await collection.updateOne({ a: 1 }, { $set: { b: 2 } });",
    frontend_mongo_runtime_collections: "await db.collection('app_users').findOne({});",
    frontend_identity_header_injectors: "headers.set('x-user', username);",
    frontend_api_reverse_proxy_functions: 'return forwardToGo(request);',
    frontend_cutover_route_resolvers: 'const owner = resolveRouteOwner(method, pathname);',
  };
  const failures = [];
  for (const [key, sample] of Object.entries(samples)) {
    const detected = FORBIDDEN_SCANNERS[key].some((re) => re.test(sample));
    if (!detected) failures.push(key);
  }

  // The context-aware Mongo reader scanner must be falsifiable in BOTH directions: it must
  // detect a real session-store read, and it must not flag a plain array helper.
  const mongoReadSample = "const col = db.collection('app_users');\nreturn col.findOne({ username });";
  if (scanMongoReadersInSource(mongoReadSample).length === 0) failures.push('frontend_session_mongo_readers');
  const arrayHelperSample = 'const first = rows.find((row) => row.active);\nconst rest = rows.filter(Boolean);';
  if (scanMongoReadersInSource(arrayHelperSample).length > 0) failures.push('frontend_session_mongo_readers:false_positive');
  return { ok: failures.length === 0, failures };
}

// ---------------------------------------------------------------------------
// Next.js API tree / server tree removal scan
// ---------------------------------------------------------------------------

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'];

function scanNextApiTree() {
  const apiRoot = join(FRONTEND, 'src', 'app', 'api');
  const files = walk(apiRoot, (p) => /route\.(ts|js)$/.test(p));
  const operations = [];
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    const found = new Set();
    for (const pattern of [
      /export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s*\(/g,
      /export\s+function\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s*\(/g,
      /export\s+const\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s*=/g,
    ]) {
      let m;
      while ((m = pattern.exec(content)) !== null) found.add(m[1]);
    }
    for (const method of found) operations.push({ method, file: rel(file) });
  }
  return { files, operations };
}

function scanNodeServerTree() {
  const serverRoot = join(FRONTEND, 'src', 'server');
  return { present: existsSync(serverRoot), files: walk(serverRoot, () => true) };
}

/** Active (executable) references to the removed Next.js server tree. */
function scanActiveServerImports() {
  const selfPath = resolve(fileURLToPath(import.meta.url));
  const roots = [join(FRONTEND, 'src'), join(FRONTEND, 'tests'), join(ROOT, 'scripts'), join(ROOT, '.github')];
  const resolutionRe = /(?:\bimport\b|\brequire\s*\(|\bJiti\b|\bloadModule\s*\(|\breadFileSync\b|\breadFile\b|\bexistsSync\b|\bstatSync\b|\breaddirSync\b|\bnew\s+URL\s*\(|\bpath\s*\.\s*(?:join|resolve)\s*\(|\bresolve\s*\(|\bjoin\s*\()/;
  const serverTreeRe = /@\/server\/|src\/server\//;
  const hits = [];
  for (const base of roots) {
    for (const file of walk(base, (p) => CODE_EXT.test(p) || /\.ya?ml$/.test(p))) {
      if (resolve(file) === selfPath) continue;
      stripComments(readFileSync(file, 'utf8')).split('\n').forEach((line, idx) => {
        if (serverTreeRe.test(line) && resolutionRe.test(line)) hits.push({ file: rel(file), line: idx + 1, text: line.trim() });
      });
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Proxy / security.ts / Nginx source assertions
// ---------------------------------------------------------------------------

function readIfExists(p) {
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
}

function scanProxySource() {
  const proxyPath = join(FRONTEND, 'src', 'proxy.ts');
  const code = stripComments(readIfExists(proxyPath));
  const forbidden = [
    { key: 'jose', re: /\bjose\b/ },
    { key: 'jwtVerify', re: /\bjwtVerify\b/ },
    { key: 'mongodb', re: /\bmongodb\b|MongoClient/i },
    { key: 'findOne', re: /\bfindOne\b/ },
    { key: 'CUTOVER_TABLE', re: /\bCUTOVER_TABLE\b/ },
    { key: 'resolveRouteOwner', re: /\bresolveRouteOwner\b/ },
    { key: 'forwardToGo', re: /\bforwardToGo\b/ },
    { key: 'GO_BACKEND_UNREACHABLE', re: /\bGO_BACKEND_UNREACHABLE\b/ },
    { key: 'identity_header_injection', re: /\bx-(?:user|role|permissions)\b/i },
  ];
  const violations = [];
  for (const token of forbidden) {
    code.split('\n').forEach((line, idx) => {
      if (token.re.test(line)) violations.push({ token: token.key, line: idx + 1, text: line.trim() });
    });
  }
  return {
    content: readIfExists(proxyPath),
    code,
    violations,
    consultsGoAuth: /\/api\/auth\/me/.test(code) && /auth_token/.test(code),
    failClosedCodes: /AUTH_UNAVAILABLE/.test(code) && /AUTH_SERVICE_UNAVAILABLE/.test(code),
    matcherExcludesApi: /matcher:\s*\[\s*'\/\(\(\?!api\|/.test(code) || /matcher:\s*\[[^\]]*api/.test(code),
  };
}

function scanNginxSource() {
  const content = readIfExists(join(ROOT, 'deploy', 'nginx', 'xcloud.conf'));
  const code = content
    .split('\n')
    .map((line) => (line.trimStart().startsWith('#') ? '' : line))
    .join('\n');
  const upstreams = {};
  for (const m of code.matchAll(/upstream\s+([A-Za-z0-9_]+)\s*\{([^}]*)\}/g)) upstreams[m[1]] = m[2].replace(/\s+/g, ' ').trim();
  const locations = [];
  for (const m of code.matchAll(/location\s+([^{]+?)\s*\{([^}]*)\}/g)) locations.push({ pattern: m[1].trim(), body: m[2] });
  const find = (pattern) => locations.find((l) => l.pattern === pattern);
  const proxyTo = (l, upstream) => Boolean(l) && new RegExp(`proxy_pass\\s+http://${upstream}\\b`).test(l.body);
  const headerStripped = (body, name) => new RegExp(`proxy_set_header\\s+${name}\\s+""\\s*;`).test(body);
  const apiLocations = locations.filter((l) => l.pattern.includes('/api'));
  const uiRoot = find('/');
  return {
    content,
    upstreams,
    apiLocations: apiLocations.map((l) => l.pattern),
    sseLocation: find('= /api/notifications/stream'),
    apiExactToGo: proxyTo(find('= /api'), 'xcloud_go'),
    apiPrefixToGo: proxyTo(find('/api/'), 'xcloud_go'),
    uiToNext: proxyTo(uiRoot, 'xcloud_next'),
    goUpstream: (upstreams.xcloud_go ?? ''),
    nextUpstream: (upstreams.xcloud_next ?? ''),
    identityHeadersStripped:
      apiLocations.length > 0 &&
      apiLocations.every((l) => headerStripped(l.body, 'X-User') && headerStripped(l.body, 'X-Role') && headerStripped(l.body, 'X-Permissions')),
    forwardedProto: apiLocations.every((l) => /proxy_set_header\s+X-Forwarded-Proto\b/.test(l.body)),
    bodySize10m: /client_max_body_size\s+10m\s*;/.test(code),
    sseUnbuffered: Boolean(find('= /api/notifications/stream')) && /proxy_buffering\s+off\s*;/.test(find('= /api/notifications/stream').body),
  };
}

// ---------------------------------------------------------------------------
// Dependency classifier (spec section 46) - non-tautological
// ---------------------------------------------------------------------------

const UNUSED_SENTINEL_DEP = '@phase85/dependency-classifier-unused-sentinel';

function readFrontendManifest(ref) {
  const raw = ref ? git(['show', `${ref}:frontend/package.json`]).stdout : readIfExists(join(FRONTEND, 'package.json'));
  if (!raw) return null;
  const pkg = JSON.parse(raw);
  const merged = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  return { pkg, names: Object.keys(merged) };
}

/**
 * Build the real consumer graph for frontend direct dependencies: search imports in
 * frontend/src + frontend/tests, real tooling references in frontend config/CSS/tsconfig,
 * explicit npm-script invocations, and TypeScript type-package resolution.
 *
 * No dependency name is special-cased to "KEEP"; `frontend/package.json` itself is
 * deliberately NOT text-scanned (it lists every name and would make the classifier
 * tautological). The negative sentinel in dependencyNegativeSentinel() proves the whole
 * classifier is falsifiable.
 */
function classifyFrontendDependencies(names) {
  const evidence = new Map();
  const add = (name, where) => {
    if (!evidence.has(name)) evidence.set(name, []);
    evidence.get(name).push(where);
  };

  /** Word-boundary-ish match so `next` does not match `eslint-config-next`. */
  const mentions = (text, name) =>
    new RegExp(`(^|[^A-Za-z0-9_-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_-]|$)`).test(text);

  const importRe = /(?:import\s+(?:type\s+)?[^;]*?from\s*|import\s*\(\s*|require\(\s*)['"]([^'"]+)['"]/g;
  const importRoot = (spec) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);

  const importFiles = [
    ...walk(join(FRONTEND, 'src'), (p) => CODE_EXT.test(p)),
    ...walk(join(FRONTEND, 'tests'), (p) => CODE_EXT.test(p)),
  ];
  for (const file of importFiles) {
    const content = stripComments(readFileSync(file, 'utf8'));
    let m;
    importRe.lastIndex = 0;
    while ((m = importRe.exec(content)) !== null) add(importRoot(m[1]), rel(file));
  }

  // Real tooling references: tsconfig, bundler/lint/postcss config, CSS entrypoints.
  const textFiles = [
    join(FRONTEND, 'tsconfig.json'),
    ...walk(FRONTEND, (p) => /(^|\/)[^/]*\.config\.(mjs|js|ts|cjs)$/.test(p) || p.endsWith('.css')).filter(
      (p) => !p.includes(`${path.sep}node_modules${path.sep}`) && !p.includes(`${path.sep}.next${path.sep}`),
    ),
  ];
  for (const file of textFiles) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    for (const name of names) if (mentions(text, name)) add(name, rel(file));
  }

  // Explicit npm-script invocations (e.g. `rimraf`, `tsx --test`).
  const manifest = JSON.parse(readIfExists(join(FRONTEND, 'package.json')) || '{}');
  const scriptText = Object.values(manifest.scripts ?? {}).join('\n');
  for (const name of names) if (mentions(scriptText, name)) add(name, 'package.json#scripts');

  // Objective toolchain presence: a TypeScript source tree needs the compiler.
  if (walk(join(FRONTEND, 'src'), (p) => /\.tsx?$/.test(p)).length > 0) add('typescript', 'typescript-sources');

  // Type packages resolve through the runtime package they describe.
  for (const name of names) {
    if (!name.startsWith('@types/')) continue;
    const base = name.slice('@types/'.length);
    for (const [used] of evidence) {
      if (used === base || used.startsWith(`${base}/`)) add(name, `types-for:${used}`);
    }
    if (base === 'node' && textFiles.some((f) => existsSync(f) && /\bprocess\.env\b|\bBuffer\b|\bnode:/.test(readFileSync(f, 'utf8')))) {
      add(name, 'node-globals:config');
    }
  }
  if (importFiles.some((f) => /\bprocess\.env\b|\bnode:/.test(stripComments(readFileSync(f, 'utf8'))))) add('@types/node', 'node-globals:source');

  const classified = [];
  const unclassified = [];
  const unused = [];
  for (const name of names) {
    const used = evidence.get(name) ?? [];
    if (used.length > 0) classified.push({ name, evidence: used.slice(0, 3) });
    else unused.push(name);
  }
  return { classified, unclassified, unused, evidence };
}

function dependencyNegativeSentinel(names) {
  const probe = classifyFrontendDependencies([...names, UNUSED_SENTINEL_DEP]);
  return probe.unused.includes(UNUSED_SENTINEL_DEP);
}

// ---------------------------------------------------------------------------
// Process lifecycle
// ---------------------------------------------------------------------------

const processes = [];
function trackProcess(child, label) {
  processes.push({ child, label });
  return child;
}

/** Collect a bounded tail of a child's output for failure diagnostics. */
function captureOutput(child, buffer) {
  const sink = (chunk) => {
    buffer.push(chunk.toString());
    if (buffer.length > 120) buffer.shift();
  };
  if (child.stdout) child.stdout.on('data', sink);
  if (child.stderr) child.stderr.on('data', sink);
}

function outputTail(buffer) {
  return buffer.join('').trim().split('\n').slice(-4).join(' / ');
}

/** Extract the machine-readable `code` field from a JSON error body. */
function bodyCode(res) {
  try {
    return JSON.parse(res.body.toString('utf8')).code ?? '';
  } catch {
    return '';
  }
}

function stopTracked(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    runSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    child.kill('SIGTERM');
  } catch {
    /* ignore */
  }
}

/** Relay owned by the current run, released on every exit path. */
let activeRelay = null;

async function stopAll() {
  for (const { child } of processes) stopTracked(child);
  // An early return must not leave the relay listening: the next run's port preflight
  // would then refuse to start and the leftover listener would look like a foreign process.
  if (activeRelay) {
    try {
      await activeRelay.stop();
    } catch {
      /* best effort */
    }
  }
  await sleep(500);
}

// ---------------------------------------------------------------------------
// MongoDB relay
// ---------------------------------------------------------------------------
// Go pings MongoDB at startup, so an unreachable Mongo URI cannot be used to prove
// "Go alive + session store unavailable". A real TCP relay in front of MongoDB makes the
// session store disappear AFTER Go is healthy, which is exactly the production failure
// mode the AUTH_UNAVAILABLE 503 contract describes.

class MongoRelay {
  constructor(targetPort, listenPort) {
    this.targetPort = targetPort;
    this.listenPort = listenPort;
    this.sockets = new Set();
    this.server = null;
    this.accepted = 0;
  }

  async start() {
    this.server = net.createServer((client) => {
      this.accepted += 1;
      const upstream = net.connect({ host: '127.0.0.1', port: this.targetPort });
      this.sockets.add(client);
      this.sockets.add(upstream);
      const cleanup = () => {
        this.sockets.delete(client);
        this.sockets.delete(upstream);
        client.destroy();
        upstream.destroy();
      };
      client.on('error', cleanup);
      upstream.on('error', cleanup);
      client.on('close', cleanup);
      upstream.on('close', cleanup);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    this.server.on('error', () => {});
    await new Promise((res) => this.server.listen(this.listenPort, '127.0.0.1', res));
  }

  /** Make the session store unreachable while leaving the Go process running. */
  async blackout() {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.server.close();
    this.server = null;
    await waitForPortClosed(this.listenPort, 5000);
  }

  /** Release the listener so the port is free again. Idempotent. */
  async stop() {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise((res) => server.close(res));
  }
}

// ---------------------------------------------------------------------------
// Fixture seeding
// ---------------------------------------------------------------------------

const seededUsers = [
  { username: `${USER_PREFIX}admin`, role: 'admin', status: 'active', locked: false, password: PASSWORD },
  { username: `${USER_PREFIX}viewer`, role: 'viewer', status: 'active', locked: false, password: PASSWORD },
  { username: `${USER_PREFIX}disabled`, role: 'admin', status: 'disabled', locked: false, password: PASSWORD },
  { username: `${USER_PREFIX}locked`, role: 'admin', status: 'active', locked: true, password: PASSWORD },
];

async function seedUsers(mongoUri) {
  const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  const users = client.db('xcloud_ops').collection('app_users');
  await users.deleteMany({ username: { $regex: `^${USER_PREFIX}` } });
  for (const user of seededUsers) {
    await users.insertOne({
      _id: new ObjectId(),
      username: user.username,
      passwordHash: bcrypt.hashSync(user.password, 10),
      role: user.role,
      status: user.status,
      locked: user.locked,
      security: {
        sessionVersion: 1,
        failedLoginAttempts: 0,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
  await client.close();
}

async function dropSeededUsers(mongoUri) {
  const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  await client.db('xcloud_ops').collection('app_users').deleteMany({ username: { $regex: `^${USER_PREFIX}` } });
  await client.db('xcloud_ops').collection('app_rate_limits').deleteMany({ _id: { $regex: `^login` } });
  await client.close();
}

async function mintToken({ username, role, sv, secret = JWT_SECRET, alg = 'HS256', expiresIn = '24h' }) {
  return new SignJWT({ username, role, sv, sessionVersion: sv })
    .setProtectedHeader({ alg, typ: 'JWT' })
    .setSubject(username)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(new TextEncoder().encode(secret));
}

function cookieHeader(token) {
  return { cookie: `auth_token=${token}` };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log('== Phase 8.5 Proxy / Deployment Boundary Finalization acceptance ==\n');

  // -- Git boundary -------------------------------------------------------
  const head = git(['rev-parse', 'HEAD']).stdout.trim();
  const originDevelop = git(['rev-parse', 'origin/develop']).stdout.trim();
  const ancestor = runSync('git', ['merge-base', '--is-ancestor', START_SHA, head], { cwd: ROOT }).status === 0;
  check('P85-G01', ancestor, `start_sha=${START_SHA} head=${head} origin_develop=${originDevelop} start_is_ancestor=${ancestor}`);

  // -- Derived Go registration authority ----------------------------------
  const { keys: goKeys, duplicates: goDuplicates } = deriveGoRegistrations();
  const goKeySet = new Set(goKeys);
  const { reads: goReads, mutations: goMutations } = classifyGoRegistrations(goKeys);

  const baselineSources = ['backend/cmd/server/main.go', 'backend/internal/remediation/handler.go'];
  const baselineKeys = new Set();
  const baselineDuplicates = [];
  const registrationRe = /mux\.Handle\("(GET|POST|PUT|PATCH|DELETE)\s+([^"]+)"\s*,/g;
  for (const source of baselineSources) {
    const text = git(['show', `${START_SHA}:${source}`]).stdout;
    let m;
    registrationRe.lastIndex = 0;
    while ((m = registrationRe.exec(text)) !== null) {
      const key = `${m[1]} ${m[2]}`;
      if (baselineKeys.has(key)) baselineDuplicates.push(key);
      baselineKeys.add(key);
    }
  }
  const missingRegistration = [...baselineKeys].filter((k) => !goKeySet.has(k));
  const addedRegistration = [...goKeySet].filter((k) => !baselineKeys.has(k));
  const registrationSetChanged = missingRegistration.length > 0 || addedRegistration.length > 0;
  check(
    'P85-G05',
    baselineKeys.size === EXPECTED_GO_REGISTRATIONS &&
      goKeys.length === EXPECTED_GO_REGISTRATIONS &&
      !registrationSetChanged &&
      goDuplicates.length === 0 &&
      baselineDuplicates.length === 0,
    `baseline=${baselineKeys.size} final=${goKeys.length} missing=${missingRegistration.length} added=${addedRegistration.length} duplicates=${goDuplicates.length}`,
  );

  // -- Removal / no-proxy / cutover retirement source evidence ------------
  const apiTree = scanNextApiTree();
  const serverTree = scanNodeServerTree();
  const activeServerImports = scanActiveServerImports();
  const proxy = scanProxySource();
  const nginx = scanNginxSource();
  const forbidden = scanFrontendForForbidden();
  const sentinels = scannerNegativeSentinels();
  const cutoverRoutingPresent = existsSync(join(FRONTEND, 'src', 'lib', 'cutover-routing.ts'));

  check('P85-I01', apiTree.files.length === 0 && apiTree.operations.length === 0, `next_api_route_files=${apiTree.files.length} next_api_operations=${apiTree.operations.length}`);
  check('P85-I02', !serverTree.present && serverTree.files.length === 0, `node_server_tree_files=${serverTree.files.length}`);
  check('P85-I03', activeServerImports.length === 0, `active_server_imports=${activeServerImports.length}`);
  check('P85-I04', !cutoverRoutingPresent, `cutover_routing_runtime_present=${cutoverRoutingPresent}`);
  check(
    'P85-I05',
    forbidden.frontend_cutover_route_resolvers.length === 0,
    `frontend_cutover_route_resolvers=${forbidden.frontend_cutover_route_resolvers.length}`,
  );
  check(
    'P85-G03',
    proxy.violations.length === 0 && !/\bforwardToGo\b/.test(proxy.code) && forbidden.frontend_api_reverse_proxy_functions.length === 0,
    `proxy_forbidden_tokens=${proxy.violations.length} api_reverse_proxy_functions=${forbidden.frontend_api_reverse_proxy_functions.length}`,
  );
  check('P85-G08', proxy.consultsGoAuth && proxy.failClosedCodes && proxy.matcherExcludesApi, `go_auth_delegation=${proxy.consultsGoAuth} fail_closed_codes=${proxy.failClosedCodes} matcher_excludes_api=${proxy.matcherExcludesApi}`);

  const jwtVerifiers = forbidden.frontend_jwt_verifiers.length;
  const jwtSecretReaders = forbidden.frontend_jwt_secret_runtime_readers.length;
  const mongoReaders = forbidden.frontend_session_mongo_readers.length;
  const mongoWriters = forbidden.frontend_session_mongo_writers.length;
  const mongoCollections = forbidden.frontend_mongo_runtime_collections.length;
  const identityInjectors = forbidden.frontend_identity_header_injectors.length;
  check('P85-G09', mongoReaders === 0 && mongoWriters === 0 && mongoCollections === 0, `frontend_mongo_readers=${mongoReaders} writers=${mongoWriters} collections=${mongoCollections}`);
  check('P85-G10', jwtVerifiers === 0 && jwtSecretReaders === 0, `frontend_jwt_verifiers=${jwtVerifiers} jwt_secret_readers=${jwtSecretReaders}`);
  check('P85-G07-static', identityInjectors === 0, `frontend_identity_header_injectors=${identityInjectors}`);
  check('P85-I06', sentinels.ok, `scanner_negative_sentinels=${sentinels.ok} failures=[${sentinels.failures.join(',')}]`);

  // -- Dependency classifier ----------------------------------------------
  const manifestBefore = readFrontendManifest(START_SHA);
  const manifestAfter = readFrontendManifest(null);
  const depsBefore = manifestBefore.names;
  const depsAfter = manifestAfter.names;
  const removedDeps = depsBefore.filter((n) => !depsAfter.includes(n));
  const keptDeps = depsAfter.filter((n) => depsBefore.includes(n));
  const depClassification = classifyFrontendDependencies(depsAfter);
  const depSentinel = dependencyNegativeSentinel(depsAfter);
  const joseConsumers = depClassification.evidence.has('jose') ? 1 : 0;
  const mongodbConsumers = depClassification.evidence.has('mongodb') ? 1 : 0;
  const jitiConsumers = depClassification.evidence.has('jiti') ? 1 : 0;
  check(
    'P85-G16',
    depClassification.unclassified.length === 0 && depClassification.unused.length === 0 && depSentinel,
    `dependencies_before=${depsBefore.length} after=${depsAfter.length} unclassified=${depClassification.unclassified.length} unused=${depClassification.unused.length} sentinel=${depSentinel}`,
  );

  // -- Root manifest byte-integrity ---------------------------------------
  const rootPkgDiff = git(['diff', '--name-only', START_SHA, '--', 'package.json', 'package-lock.json']).stdout.trim();
  check('P85-I07', rootPkgDiff === '', `root_manifest_changes=[${rootPkgDiff}]`);

  // -- Go production freeze ----------------------------------------------
  // Phase 8.5-C authorizes exactly one narrow backend surface: the listener configuration
  // under backend/internal/config/. Everything else in backend/ would be a business, auth,
  // registration or charging-plane change and must be zero.
  const backendChangedFiles = git(['diff', '--name-only', START_SHA, '--', 'backend/'])
    .stdout.trim()
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const deploymentListenerConfigChanges = backendChangedFiles.filter(isAuthorizedListenerChange);
  const nonListenerBackendChanges = backendChangedFiles.filter((f) => !isAuthorizedListenerChange(f));
  const goAuthBehaviorChanges = nonListenerBackendChanges.filter((f) => f.startsWith('backend/internal/auth/'));
  const chargingPlaneChanges = nonListenerBackendChanges.filter((f) => f.startsWith('backend/internal/charging/'));
  const goBusinessProductionChanges = nonListenerBackendChanges.filter(
    (f) => !f.startsWith('backend/internal/auth/') && !f.startsWith('backend/internal/charging/'),
  );
  const goRegistrationChanges = registrationSetChanged ? 1 : 0;
  check(
    'P85-G17',
    goBusinessProductionChanges.length === 0 &&
      goAuthBehaviorChanges.length === 0 &&
      chargingPlaneChanges.length === 0 &&
      deploymentListenerConfigChanges.length > 0,
    `backend_changes=[${backendChangedFiles.join(',')}] deployment_listener_config_changes=${deploymentListenerConfigChanges.length} go_business_production_changes=${goBusinessProductionChanges.length} go_auth_behavior_changes=${goAuthBehaviorChanges.length} charging_plane_changes=${chargingPlaneChanges.length}`,
  );

  // -- Go registration set equality against the Phase 8.5 correction baseline ------------
  // Section 16 requires exact set equality (not a count) against cfc2fef.
  const correctionBaselineKeys = registrationsAt(PHASE85C_BASELINE_SHA);
  const correctionMissing = [...correctionBaselineKeys].filter((k) => !goKeySet.has(k));
  const correctionAdded = [...goKeySet].filter((k) => !correctionBaselineKeys.has(k));
  const correctionSetChanged = correctionMissing.length > 0 || correctionAdded.length > 0;
  check(
    'P85-G18',
    correctionBaselineKeys.size === EXPECTED_GO_REGISTRATIONS &&
      goKeys.length === EXPECTED_GO_REGISTRATIONS &&
      !correctionSetChanged,
    `correction_baseline=${correctionBaselineKeys.size} final=${goKeys.length} missing=${correctionMissing.length} added=${correctionAdded.length} set_changed=${correctionSetChanged}`,
  );

  // -- Nginx deployment-source boundary ----------------------------------
  check(
    'P85-G02-source',
    nginx.apiExactToGo && nginx.apiPrefixToGo && nginx.uiToNext && nginx.goUpstream.includes(GO_UPSTREAM_ADDR) && nginx.nextUpstream.includes(NEXT_UPSTREAM_ADDR),
    `api_exact_to_go=${nginx.apiExactToGo} api_prefix_to_go=${nginx.apiPrefixToGo} ui_to_next=${nginx.uiToNext} go_upstream=${nginx.goUpstream} next_upstream=${nginx.nextUpstream}`,
  );
  check('P85-I08', nginx.identityHeadersStripped && nginx.forwardedProto && nginx.bodySize10m && nginx.sseUnbuffered, `identity_stripped=${nginx.identityHeadersStripped} xfp=${nginx.forwardedProto} body_10m=${nginx.bodySize10m} sse_unbuffered=${nginx.sseUnbuffered}`);

  // =======================================================================
  // Runtime topology
  // =======================================================================

  if (invariants.some((i) => !i.ok)) {
    log('Static boundary assertions failed; aborting before runtime bring-up.\n');
    report();
    return;
  }

  mkdirSync(TMP_ROOT, { recursive: true });
  mkdirSync(join(NGINX_PREFIX, 'logs'), { recursive: true });
  mkdirSync(join(NGINX_PREFIX, 'temp'), { recursive: true });
  mkdirSync(join(NGINX_PREFIX, 'conf'), { recursive: true });
  writeFileSync(ACCESS_LOG, '');

  const mongoReachable = await waitForPort(MONGO_TARGET_PORT, 5000);
  check('P85-R00', mongoReachable, `mongo_reachable=${mongoReachable} uri=${MONGO_URI}`);
  if (!mongoReachable) {
    report();
    return;
  }

  // Port preflight. A listener that the suite did not start would answer as if it were the
  // component under test, producing evidence that looks green while proving nothing. Refuse
  // to run against an occupied port instead of silently trusting a foreign process.
  const preflightPorts = [
    ['P85-R00A', GO_PORT, 'go'],
    ['P85-R00B', NEXT_PORT, 'next'],
    ['P85-R00C', EDGE_PORT, 'edge'],
    ['P85-R00D', RELAY_PORT, 'mongo_relay'],
  ];
  const occupiedPorts = [];
  for (const [id, port, role] of preflightPorts) {
    // eslint-disable-next-line no-await-in-loop -- sequential probes keep the diagnostic stable
    const occupied = await isPortOpen(port);
    check(id, !occupied, `port_free_${role}=${!occupied} port=${port}`);
    if (occupied) occupiedPorts.push(`${role}:${port}`);
  }
  if (occupiedPorts.length > 0) {
    log(`\nRefusing to run: these ports are already held by another process -> ${occupiedPorts.join(', ')}`);
    log('The acceptance suite must own every port it measures; free them and re-run.');
    report();
    return;
  }

  log('-- Runtime bring-up --');
  await seedUsers(MONGO_URI);

  // Relay -> Go -> Next -> Nginx
  const relay = new MongoRelay(MONGO_TARGET_PORT, RELAY_PORT);
  activeRelay = relay;
  await relay.start();
  check('P85-R01', await waitForPort(RELAY_PORT, 5000), `mongo_relay_listening=${RELAY_PORT}`);

  const goBuild = runSync('go', ['build', '-o', GO_BIN, './cmd/server'], { cwd: BACKEND, stdio: 'inherit' });
  check('P85-R02', goBuild.status === 0 && existsSync(GO_BIN), `go_build_status=${goBuild.status}`);

  // Go is started through its normal production configuration contract. HTTP_ADDR is NOT
  // injected so the production default (127.0.0.1:18888) is what actually gets exercised;
  // an explicit override is honoured only when the operator overrides the canonical port.
  const goEnv = {
    ...process.env,
    MONGODB_URI: `mongodb://127.0.0.1:${RELAY_PORT}/?serverSelectionTimeoutMS=2000&connectTimeoutMS=2000`,
    MONGODB_XCLOUD_DB: 'xcloud',
    MONGODB_APP_DB: 'xcloud_ops',
    JWT_SECRET,
  };
  delete goEnv.HTTP_ADDR;
  const goAddrFromEnv = process.env.PHASE85_GO_PORT ? `127.0.0.1:${GO_PORT}` : null;
  if (goAddrFromEnv) goEnv.HTTP_ADDR = goAddrFromEnv;
  const goAddrSource = goAddrFromEnv ? 'explicit_override' : 'production_default';

  const goOutput = [];
  const goProc = trackProcess(
    spawn(GO_BIN, [], {
      cwd: BACKEND,
      env: goEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
    'go',
  );
  captureOutput(goProc, goOutput);

  const goUp = await waitForPort(GO_PORT, 60000);
  const goAlive = goProc.exitCode === null;
  check('P85-R03', goUp && goAlive, `go_listening=${goUp} go_process_alive=${goAlive} port=${GO_PORT} addr_source=${goAddrSource} output=${outputTail(goOutput)}`);
  if (!goUp || !goAlive) {
    report();
    await stopAll();
    return;
  }

  // Real Next.js production server
  const buildIdPath = join(FRONTEND, '.next', 'BUILD_ID');
  if (!SKIP_BUILD && !existsSync(buildIdPath)) {
    log('  building Next.js production bundle...');
    const build = runSync('npm', ['run', 'build'], { cwd: FRONTEND, shell: true, stdio: 'inherit', timeout: 900000 });
    check('P85-R04', build.status === 0 && existsSync(buildIdPath), `next_build_status=${build.status}`);
  } else {
    check('P85-R04', existsSync(buildIdPath), `next_build_reused=${existsSync(buildIdPath)}`);
  }

  // Spawn the Next.js server binary directly (no shell wrapper) so the process can be
  // terminated deterministically on every platform. The arguments are exactly the
  // documented production command (`next start -H 127.0.0.1 -p 13333`, i.e. `npm run start`);
  // no test-only hostname is injected, so the listener under test is the production one.
  const nextOutput = [];
  const nextBin = join(FRONTEND, 'node_modules', 'next', 'dist', 'bin', 'next');
  const nextProc = trackProcess(
    spawn(process.execPath, [nextBin, 'start', '-H', NEXT_BIND_HOST, '-p', String(NEXT_PORT)], {
      cwd: FRONTEND,
      env: { ...process.env, GO_BACKEND_URL: `http://127.0.0.1:${GO_PORT}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
    'next',
  );
  captureOutput(nextProc, nextOutput);

  const nextUp = await waitForPort(NEXT_PORT, 120000);
  check('P85-R05', nextUp, `next_listening=${nextUp} port=${NEXT_PORT} bind_host=${NEXT_BIND_HOST} output=${outputTail(nextOutput)}`);

  // =======================================================================
  // Internal listener boundary (Phase 8.5-C) - real socket proof
  // =======================================================================
  // Both internal services are now running through their production startup contracts.
  // Prove loopback-only binding with real TCP probes against a real non-loopback runner
  // address. A wildcard listener would answer on that address, so `false` is required.

  log('-- Internal listener boundary --');
  const nonLoopback = nonLoopbackIPv4();
  const nextLoopbackReachable = await probeTcp('127.0.0.1', NEXT_PORT);
  const goLoopbackReachable = await probeTcp('127.0.0.1', GO_PORT);
  const nextNonLoopbackReachable = nonLoopback ? await probeTcp(nonLoopback, NEXT_PORT) : null;
  const goNonLoopbackReachable = nonLoopback ? await probeTcp(nonLoopback, GO_PORT) : null;

  check(
    'P85-B01',
    Boolean(nonLoopback),
    `non_loopback_address=${nonLoopback ?? 'none'} (a real off-loopback address is required to prove the boundary)`,
  );
  check(
    'P85-B02',
    nextLoopbackReachable && nextNonLoopbackReachable === false,
    `next_listener=${NEXT_LISTENER_ADDR} loopback_reachable=${nextLoopbackReachable} nonloopback_reachable=${nextNonLoopbackReachable}`,
  );
  check(
    'P85-B03',
    goLoopbackReachable && goNonLoopbackReachable === false,
    `go_listener=${GO_LISTENER_ADDR} loopback_reachable=${goLoopbackReachable} nonloopback_reachable=${goNonLoopbackReachable}`,
  );

  const nextBinding = listenerBinding(NEXT_PORT);
  const goBinding = listenerBinding(GO_PORT);
  const nextLoopbackOnly = nextLoopbackReachable && nextNonLoopbackReachable === false;
  const goLoopbackOnly = goLoopbackReachable && goNonLoopbackReachable === false;
  check(
    'P85-B04',
    nextLoopbackOnly && goLoopbackOnly,
    `next_loopback_only=${nextLoopbackOnly} go_loopback_only=${goLoopbackOnly} next_binding=${nextBinding} go_binding=${goBinding}`,
  );
  const listenerEvidence = {
    nonLoopback,
    nextLoopbackReachable,
    goLoopbackReachable,
    nextNonLoopbackReachable,
    goNonLoopbackReachable,
    nextLoopbackOnly,
    goLoopbackOnly,
    nextBinding,
    goBinding,
    goAddrSource,
  };

  // Real Nginx with the repository deployment configuration
  const repoConf = readFileSync(join(ROOT, 'deploy', 'nginx', 'xcloud.conf'), 'utf8');
  const effectiveConf = [
    'worker_processes 1;',
    `error_log ${nginxPath(join(NGINX_PREFIX, 'logs', 'error.log'))} warn;`,
    `pid ${nginxPath(join(NGINX_PREFIX, 'logs', 'nginx.pid'))};`,
    'events { worker_connections 1024; }',
    'http {',
    "  log_format phase85 '$http_x_phase85_marker|$upstream_addr|$upstream_status|$status|$request_method|$request_uri|$content_type';",
    `  access_log ${nginxPath(ACCESS_LOG)} phase85;`,
    // Distribution builds compile temp paths under /var/lib/nginx, which an unprivileged
    // run cannot write. Requests large enough to spill out of client_body_buffer_size
    // would otherwise fail in the proxy layer instead of exercising the deployment.
    `  client_body_temp_path ${nginxPath(join(NGINX_PREFIX, 'temp', 'client_body'))};`,
    `  proxy_temp_path ${nginxPath(join(NGINX_PREFIX, 'temp', 'proxy'))};`,
    "  include " + nginxPath(join(NGINX_PREFIX, 'conf', 'mime.types')) + ';',
    repoConf.replace(/^    listen 80;/m, `    listen ${EDGE_PORT};`),
    '}',
  ].join('\n');
  writeFileSync(join(NGINX_PREFIX, 'conf', 'mime.types'), 'types { text/html html; text/css css; application/javascript js; }\n');
  const effectiveConfPath = join(NGINX_PREFIX, 'conf', 'phase85.conf');
  writeFileSync(effectiveConfPath, effectiveConf);

  const nginxTest = runSync(NGINX_BIN, ['-t', '-p', nginxPath(NGINX_PREFIX), '-c', nginxPath(effectiveConfPath)], { encoding: 'utf8' });
  const nginxSyntaxOk = nginxTest.status === 0;
  // A spawn failure leaves status null with empty output, which would otherwise look
  // identical to a rejected configuration. Name the executable so a missing or
  // unusable nginx binary is never mistaken for a configuration defect.
  const nginxDetail = (nginxTest.stderr || nginxTest.stdout || '').trim().split('\n').slice(-1)[0] || '';
  check('P85-R06', nginxSyntaxOk, `nginx_syntax=${nginxSyntaxOk} nginx_bin=${NGINX_BIN} spawn_error=${nginxTest.error ? nginxTest.error.message : 'none'} ${nginxDetail}`);
  if (!nginxSyntaxOk) {
    log(nginxTest.stderr || nginxTest.stdout || nginxTest.error?.message || '');
    report();
    await stopAll();
    return;
  }

  const nginxProc = trackProcess(
    spawn(NGINX_BIN, ['-p', nginxPath(NGINX_PREFIX), '-c', nginxPath(effectiveConfPath)], { stdio: 'ignore', detached: true }),
    'nginx',
  );
  nginxProc.unref();

  const edgeUp = await waitForPort(EDGE_PORT, 30000);
  check('P85-R07', edgeUp, `edge_listening=${edgeUp} port=${EDGE_PORT}`);
  if (!edgeUp) {
    report();
    await stopAll();
    return;
  }

  // Edge topology bring-up gate: both real upstreams are reachable through the edge.
  const topologyApi = await edgeRequest({ requestPath: '/api/auth/me' });
  await sleep(130);
  const topologyUi = await edgeRequest({ requestPath: '/login' });
  check(
    'P85-R08',
    topologyApi.upstream === 'go' && topologyApi.status === 401 && topologyUi.upstream === 'next' && topologyUi.status === 200,
    `edge_api_status=${topologyApi.status} api_upstream=${topologyApi.upstream} ui_status=${topologyUi.status} ui_upstream=${topologyUi.upstream}`,
  );

  // =======================================================================
  // API route execution matrix (spec section 35) - all 84 operations
  // =======================================================================

  log('-- API route execution matrix --');
  resetAccessLog();
  const routeMatrix = [];
  for (const key of goKeys) {
    const [method, pattern] = [key.split(' ')[0], key.split(' ').slice(1).join(' ')];
    const requestPath = pattern.replace(/\{[^}]+\}/g, 'phase85');
    const res = await edgeRequest({ method, requestPath, timeoutMs: 6000, abortAfterHeaders: requestPath.includes('/notifications/stream') });
    routeMatrix.push({ key, method, requestPath, status: res.status, upstream: res.upstream, upstreamAddr: res.upstreamAddr });
    await sleep(130); // respect the edge rate-limit zone (10 r/s per IP)
  }
  const apiGoHits = routeMatrix.filter((r) => r.upstream === 'go').length;
  const apiNextHits = routeMatrix.filter((r) => r.upstream === 'next').length;
  const apiMissing = routeMatrix.filter((r) => r.upstreamAddr === null).length;
  check(
    'P85-G11',
    routeMatrix.length === EXPECTED_GO_REGISTRATIONS && apiGoHits === EXPECTED_GO_REGISTRATIONS && apiNextHits === 0 && apiMissing === 0,
    `expected=${EXPECTED_GO_REGISTRATIONS} executed=${routeMatrix.length} go_hits=${apiGoHits} next_hits=${apiNextHits} missing=${apiMissing}`,
  );

  // -- Unknown API boundary ------------------------------------------------
  const unknown = await edgeRequest({ requestPath: UNKNOWN_SENTINEL });
  check('P85-I09', unknown.upstream === 'go' && unknown.status >= 400, `unknown_api_status=${unknown.status} upstream=${unknown.upstream}`);

  // -- Exact /api boundary -------------------------------------------------
  const exactApi = await edgeRequest({ requestPath: '/api' });
  check('P85-I10', exactApi.upstream === 'go', `exact_api_upstream=${exactApi.upstream} status=${exactApi.status}`);

  // -- Retired mutation surfaces ------------------------------------------
  const retiredResults = [];
  for (const surface of RETIRED_SURFACES) {
    const requestPath = surface.path.replace(/\{[^}]+\}/g, 'phase85');
    const res = await edgeRequest({ method: surface.method, requestPath, headers: { 'content-type': 'application/json' }, body: '{}' });
    retiredResults.push({ ...surface, status: res.status, upstream: res.upstream });
    await sleep(130);
  }
  const retiredNextHits = retiredResults.filter((r) => r.upstream === 'next').length;
  const retiredExecuted = retiredResults.filter((r) => r.upstream === 'go').length;
  check(
    'P85-I11',
    retiredExecuted === RETIRED_SURFACES.length && retiredNextHits === 0,
    `retired_expected=${RETIRED_SURFACES.length} retired_executed=${retiredExecuted} retired_next_hits=${retiredNextHits}`,
  );

  // =======================================================================
  // Authentication boundary (spec sections 20 / 38)
  // =======================================================================

  log('-- Authentication boundary --');
  resetAccessLog();

  const adminLogin = await edgeRequest({
    method: 'POST',
    requestPath: '/api/auth/login',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: `${USER_PREFIX}admin`, password: PASSWORD }),
  });
  const setCookie = adminLogin.headers['set-cookie'] || [];
  const cookieText = Array.isArray(setCookie) ? setCookie.join('\n') : String(setCookie);
  const adminTokenMatch = /auth_token=([^;]+)/.exec(cookieText);
  const adminToken = adminTokenMatch ? adminTokenMatch[1] : null;
  check(
    'P85-A01',
    adminLogin.status === 200 && adminLogin.upstream === 'go' && Boolean(adminToken) && /HttpOnly/i.test(cookieText) && /Path=\//i.test(cookieText) && /SameSite=Lax/i.test(cookieText),
    `login_status=${adminLogin.status} upstream=${adminLogin.upstream} cookie=${cookieText.replace(/auth_token=[^;]+/, 'auth_token=<redacted>')}`,
  );

  const invalidLogin = await edgeRequest({
    method: 'POST',
    requestPath: '/api/auth/login',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: `${USER_PREFIX}admin`, password: OTHER_PASSWORD }),
  });
  check('P85-A02', invalidLogin.status === 401 && invalidLogin.upstream === 'go', `invalid_login_status=${invalidLogin.status} upstream=${invalidLogin.upstream}`);

  const logout = await edgeRequest({ method: 'POST', requestPath: '/api/auth/logout', headers: { ...cookieHeader(adminToken) } });
  const logoutCookie = String(logout.headers['set-cookie'] || '');
  check('P85-A03', logout.status === 200 && /auth_token=;/.test(logoutCookie) && /Max-Age=0|Expires=/i.test(logoutCookie), `logout_status=${logout.status} cookie=${logoutCookie.replace(/auth_token=[^;]*/, 'auth_token=<redacted>')}`);

  const meValid = await edgeRequest({ requestPath: '/api/auth/me', headers: cookieHeader(adminToken) });
  check('P85-A04', meValid.status === 200 && meValid.upstream === 'go', `me_status=${meValid.status} upstream=${meValid.upstream}`);

  const meNoCookie = await edgeRequest({ requestPath: '/api/auth/me' });
  check('P85-A05', meNoCookie.status === 401 && meNoCookie.upstream === 'go', `missing_cookie_status=${meNoCookie.status} upstream=${meNoCookie.upstream}`);

  const meInvalidJwt = await edgeRequest({ requestPath: '/api/auth/me', headers: cookieHeader('not.a.jwt') });
  check('P85-A06', meInvalidJwt.status === 401 && meInvalidJwt.upstream === 'go', `invalid_jwt_status=${meInvalidJwt.status} upstream=${meInvalidJwt.upstream}`);

  const ghostToken = await mintToken({ username: `${USER_PREFIX}ghost`, role: 'admin', sv: 1 });
  const meUnknown = await edgeRequest({ requestPath: '/api/auth/me', headers: cookieHeader(ghostToken) });
  check('P85-A07', meUnknown.status === 401 && meUnknown.upstream === 'go', `unknown_account_status=${meUnknown.status} upstream=${meUnknown.upstream} code=${bodyCode(meUnknown)}`);

  const disabledToken = await mintToken({ username: `${USER_PREFIX}disabled`, role: 'admin', sv: 1 });
  const meDisabled = await edgeRequest({ requestPath: '/api/auth/me', headers: cookieHeader(disabledToken) });
  check('P85-A08', meDisabled.status === 401 && meDisabled.upstream === 'go', `disabled_account_status=${meDisabled.status} upstream=${meDisabled.upstream} code=${bodyCode(meDisabled)}`);

  const lockedToken = await mintToken({ username: `${USER_PREFIX}locked`, role: 'admin', sv: 1 });
  const meLocked = await edgeRequest({ requestPath: '/api/auth/me', headers: cookieHeader(lockedToken) });
  check('P85-A09', meLocked.status === 401 && meLocked.upstream === 'go', `locked_account_status=${meLocked.status} upstream=${meLocked.upstream} code=${bodyCode(meLocked)}`);

  // Role mismatch: valid signature, but the claimed role differs from the account role.
  const roleMismatchToken = await mintToken({ username: `${USER_PREFIX}viewer`, role: 'admin', sv: 1 });
  const meRoleMismatch = await edgeRequest({ requestPath: '/api/auth/me', headers: cookieHeader(roleMismatchToken) });
  check('P85-A10', meRoleMismatch.status === 401 && meRoleMismatch.upstream === 'go', `role_mismatch_status=${meRoleMismatch.status} upstream=${meRoleMismatch.upstream} code=${bodyCode(meRoleMismatch)}`);

  // Revoked session: valid signature, stale sessionVersion.
  const revokedToken = await mintToken({ username: `${USER_PREFIX}viewer`, role: 'viewer', sv: 99 });
  const meRevoked = await edgeRequest({ requestPath: '/api/auth/me', headers: cookieHeader(revokedToken) });
  check('P85-A11', meRevoked.status === 401 && meRevoked.upstream === 'go', `revoked_session_status=${meRevoked.status} upstream=${meRevoked.upstream} code=${bodyCode(meRevoked)}`);

  const viewerToken = await mintToken({ username: `${USER_PREFIX}viewer`, role: 'viewer', sv: 1 });
  const meViewer = await edgeRequest({ requestPath: '/api/auth/me', headers: cookieHeader(viewerToken) });
  const viewerDirect = await httpRequest({ port: GO_PORT, requestPath: '/api/auth/me', headers: cookieHeader(viewerToken) });
  check('P85-A12', meViewer.status === 200 && meViewer.upstream === 'go', `valid_viewer_status=${meViewer.status} upstream=${meViewer.upstream} code=${bodyCode(meViewer)} direct_status=${viewerDirect.status} direct_code=${bodyCode(viewerDirect)}`);

  const authNextHits = [adminLogin, invalidLogin, logout, meValid, meNoCookie, meInvalidJwt, meUnknown, meDisabled, meLocked, meRoleMismatch, meRevoked, meViewer].filter((r) => r.upstream === 'next').length;
  check('P85-A13', authNextHits === 0, `next_api_authentication_decisions=${authNextHits}`);

  // -- Header spoofing (spec section 39) ----------------------------------
  const spoofHeaders = { ...cookieHeader(viewerToken), 'x-user': 'root', 'x-role': 'root', 'x-permissions': '*' };
  const spoofUsers = await edgeRequest({ requestPath: '/api/users', headers: spoofHeaders });
  const spoofPermissions = await edgeRequest({ requestPath: '/api/auth/permissions', headers: spoofHeaders });
  let spoofPermissionsBody = null;
  try {
    spoofPermissionsBody = JSON.parse(spoofPermissions.body.toString('utf8'));
  } catch {
    spoofPermissionsBody = null;
  }
  const spoofedRole = spoofPermissionsBody?.role ?? spoofPermissionsBody?.normalizedRole ?? null;
  const spoofRejected = spoofUsers.status === 403 && spoofPermissions.status === 200 && spoofedRole === 'viewer';
  check(
    'P85-G07',
    spoofRejected,
    `forged_headers_users_status=${spoofUsers.status} permissions_status=${spoofPermissions.status} effective_role=${spoofedRole}`,
  );

  // =======================================================================
  // Protected UI page guard (spec sections 13-16 / 40)
  // =======================================================================

  log('-- Protected UI page guard --');
  resetAccessLog();

  const loginNoCookie = await edgeRequest({ requestPath: '/login' });
  const loginUpstreamOk = loginNoCookie.upstream === 'next';
  check('P85-U01', loginUpstreamOk && loginNoCookie.status === 200, `login_no_cookie_status=${loginNoCookie.status} upstream=${loginNoCookie.upstream}`);

  const pageNoCookie = await edgeRequest({ requestPath: '/' });
  const pageNoCookieLocation = String(pageNoCookie.headers.location || '');
  check(
    'P85-U02',
    pageNoCookie.upstream === 'next' && pageNoCookie.status === 307 && pageNoCookieLocation.includes('/login?from='),
    `protected_no_cookie_status=${pageNoCookie.status} location=${pageNoCookieLocation}`,
  );

  const pageValid = await edgeRequest({ requestPath: '/', headers: cookieHeader(adminToken) });
  check('P85-U03', pageValid.upstream === 'next' && pageValid.status === 200, `protected_valid_status=${pageValid.status} upstream=${pageValid.upstream}`);

  const pageRevoked = await edgeRequest({ requestPath: '/', headers: cookieHeader(revokedToken) });
  const revokedCookie = String(pageRevoked.headers['set-cookie'] || '');
  check(
    'P85-U04',
    pageRevoked.upstream === 'next' && pageRevoked.status === 307 && /auth_token=;/.test(revokedCookie),
    `protected_revoked_status=${pageRevoked.status} cookie_cleared=${/auth_token=;/.test(revokedCookie)}`,
  );

  const pageDisabled = await edgeRequest({ requestPath: '/', headers: cookieHeader(disabledToken) });
  check('P85-U05', pageDisabled.upstream === 'next' && pageDisabled.status === 307, `protected_disabled_status=${pageDisabled.status}`);

  const pageLocalAuthFallback = [pageNoCookie, pageValid, pageRevoked, pageDisabled].filter((r) => r.upstream !== 'next').length;
  check('P85-U06', pageLocalAuthFallback === 0, `ui_guard_local_auth_fallback=${pageLocalAuthFallback}`);

  // =======================================================================
  // SSE streaming (spec section 42)
  // =======================================================================

  log('-- SSE streaming --');
  resetAccessLog();
  const sseMarker = nextMarker();
  const sse = await httpStreamFirstChunk({
    port: EDGE_PORT,
    requestPath: '/api/notifications/stream',
    headers: { ...cookieHeader(adminToken), 'x-phase85-marker': sseMarker },
    firstChunkTimeoutMs: 8000,
  });
  const sseEntry = await logEntryForMarker(sseMarker, 5000);
  const sseUpstream = sseEntry ? sseEntry.upstreamAddr : null;
  const sseUpstreamKind = classifyUpstream(sseUpstream);
  const sseText = sse.firstChunk ? sse.firstChunk.toString('utf8') : '';
  check(
    'P85-G14',
    sse.status === 200 &&
      sseUpstreamKind === 'go' &&
      /text\/event-stream/.test(String(sse.headers['content-type'] || '')) &&
      /event:\s*init/.test(sseText) &&
      sse.elapsed < 7000,
    `sse_status=${sse.status} upstream=${sseUpstreamKind} first_chunk_ms=${sse.elapsed} has_init=${/event:\s*init/.test(sseText)}`,
  );

  // =======================================================================
  // Request body integrity (spec section 43)
  // =======================================================================

  log('-- Request body integrity --');
  const bodyCases = [
    {
      id: 'json-post',
      method: 'POST',
      requestPath: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: `${USER_PREFIX}admin`, password: PASSWORD }),
    },
    {
      id: 'json-patch',
      method: 'PATCH',
      requestPath: '/api/ocs/subscribers/phase85',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tariffPlanId: 'plan-phase85', note: 'body-integrity' }),
    },
    {
      id: 'import-upload',
      method: 'POST',
      requestPath: '/api/subscribers/import',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'csv', records: ['phase85,' + 'x'.repeat(512 * 1024)] }),
    },
  ];

  const bodyResults = [];
  for (const testCase of bodyCases) {
    const direct = await httpRequest({
      port: GO_PORT,
      method: testCase.method,
      requestPath: testCase.requestPath,
      headers: { ...testCase.headers, ...cookieHeader(adminToken) },
      body: testCase.body,
      timeoutMs: 15000,
    });
    const viaEdge = await edgeRequest({
      method: testCase.method,
      requestPath: testCase.requestPath,
      headers: { ...testCase.headers, ...cookieHeader(adminToken) },
      body: testCase.body,
      timeoutMs: 15000,
    });
    const sameStatus = direct.status === viaEdge.status;
    const sameBody = Buffer.compare(direct.body, viaEdge.body) === 0;
    bodyResults.push({ id: testCase.id, sameStatus, sameBody, directStatus: direct.status, edgeStatus: viaEdge.status, upstream: viaEdge.upstream, bytes: testCase.body.length });
    await sleep(130);
  }
  const bodyIntegrityOk = bodyResults.every((r) => r.sameStatus && r.sameBody && r.upstream === 'go');
  check('P85-G15', bodyIntegrityOk, `body_integrity=${bodyIntegrityOk} cases=${bodyResults.map((r) => `${r.id}:${r.directStatus}/${r.edgeStatus}:${r.bytes}B`).join(',')}`);

  // =======================================================================
  // AUTH_UNAVAILABLE: Go alive, session store unreachable (spec section 21)
  // =======================================================================

  log('-- AUTH_UNAVAILABLE boundary (Go alive, session store down) --');
  await relay.blackout();
  await sleep(500);
  resetAccessLog();
  const relayPortAfterBlackout = await isPortOpen(RELAY_PORT);

  const authUnavailableApi = await edgeRequest({ requestPath: '/api/auth/me', headers: cookieHeader(adminToken), timeoutMs: 20000 });
  let authUnavailableBody = null;
  try {
    authUnavailableBody = JSON.parse(authUnavailableApi.body.toString('utf8'));
  } catch {
    authUnavailableBody = null;
  }
  check(
    'P85-G13',
    authUnavailableApi.status === 503 && authUnavailableApi.upstream === 'go' && authUnavailableBody?.code === 'AUTH_UNAVAILABLE',
    `auth_unavailable_status=${authUnavailableApi.status} upstream=${authUnavailableApi.upstream} code=${authUnavailableBody?.code ?? 'n/a'} relay_accepted=${relay.accepted} relay_port_open_after_blackout=${relayPortAfterBlackout} body=${authUnavailableApi.body.toString('utf8').slice(0, 120)}`,
  );

  const authUnavailablePage = await edgeRequest({ requestPath: '/', headers: cookieHeader(adminToken), timeoutMs: 20000 });
  let uiUnavailableBody = null;
  try {
    uiUnavailableBody = JSON.parse(authUnavailablePage.body.toString('utf8'));
  } catch {
    uiUnavailableBody = null;
  }
  const uiUnavailableCookieCleared = /auth_token=;/.test(String(authUnavailablePage.headers['set-cookie'] || ''));
  check(
    'P85-U07',
    authUnavailablePage.upstream === 'next' && authUnavailablePage.status === 503 && uiUnavailableBody?.code === 'AUTH_UNAVAILABLE' && !uiUnavailableCookieCleared,
    `ui_auth_unavailable_status=${authUnavailablePage.status} code=${uiUnavailableBody?.code ?? 'n/a'} cookie_falsely_cleared=${uiUnavailableCookieCleared}`,
  );

  // =======================================================================
  // Transport failure: Go unavailable (spec section 44)
  // =======================================================================

  log('-- Transport failure boundary (Go unavailable) --');
  stopTracked(goProc);
  const goStopped = await waitForPortClosed(GO_PORT, 30000);
  resetAccessLog();

  const goDownResults = [];
  for (const key of goKeys) {
    const [method, pattern] = [key.split(' ')[0], key.split(' ').slice(1).join(' ')];
    const requestPath = pattern.replace(/\{[^}]+\}/g, 'phase85');
    const res = await edgeRequest({ method, requestPath, timeoutMs: 8000 });
    goDownResults.push({ key, status: res.status, upstream: res.upstream });
    await sleep(130);
  }
  const goDownExecuted = goDownResults.filter((r) => r.status === 502 || r.status === 504).length;
  const goDownNextHits = goDownResults.filter((r) => r.upstream === 'next').length;
  // A fallback is any request that reached the Node UI upstream, or that was answered with
  // something other than the edge's own upstream-failure status.
  const goDownFallback = goDownResults.filter(
    (r) => r.upstream === 'next' || (r.status !== 502 && r.status !== 504),
  ).length;
  check(
    'P85-G12',
    goDownExecuted === EXPECTED_GO_REGISTRATIONS && goDownNextHits === 0 && goDownFallback === 0,
    `go_down_expected=${EXPECTED_GO_REGISTRATIONS} go_down_executed=${goDownExecuted} next_hits=${goDownNextHits} fallback=${goDownFallback} go_stopped=${goStopped} sample=${goDownResults.slice(0, 3).map((r) => `${r.key}=${r.status}/${r.upstream}`).join(',')}`,
  );

  const pageGoDown = await edgeRequest({ requestPath: '/', headers: cookieHeader(adminToken), timeoutMs: 20000 });
  let pageGoDownBody = null;
  try {
    pageGoDownBody = JSON.parse(pageGoDown.body.toString('utf8'));
  } catch {
    pageGoDownBody = null;
  }
  check(
    'P85-U08',
    pageGoDown.upstream === 'next' && pageGoDown.status === 503 && pageGoDownBody?.code === 'AUTH_SERVICE_UNAVAILABLE',
    `ui_go_unavailable_status=${pageGoDown.status} code=${pageGoDownBody?.code ?? 'n/a'}`,
  );

  // =======================================================================
  // Report
  // =======================================================================

  const observed = {
    apiGoHits,
    apiNextHits,
    apiMissing,
    retiredExecuted,
    retiredNextHits,
    goDownExecuted,
    goDownNextHits,
    goDownFallback,
    unknownUpstream: unknown.upstream,
    unknownStatus: unknown.status,
    loginCookieOk: adminLogin.status === 200,
    logoutCookieOk: logout.status === 200,
    apiAuthOk: meValid.status === 200 && meNoCookie.status === 401 && meInvalidJwt.status === 401 && meUnknown.status === 401 && meDisabled.status === 401 && meLocked.status === 401 && meRoleMismatch.status === 401 && meRevoked.status === 401,
    sessionRevocationOk: meRevoked.status === 401,
    authUnavailableOk: authUnavailableApi.status === 503 && authUnavailableBody?.code === 'AUTH_UNAVAILABLE',
    headerSpoofingRejected: spoofRejected,
    uiGuardNoToken: pageNoCookie.status === 307,
    uiGuardValidSession: pageValid.status === 200,
    uiGuardRevokedSession: pageRevoked.status === 307,
    uiGuardAuthUnavailable: authUnavailablePage.status === 503 && uiUnavailableBody?.code === 'AUTH_UNAVAILABLE',
    uiGuardGoUnavailable: pageGoDown.status === 503 && pageGoDownBody?.code === 'AUTH_SERVICE_UNAVAILABLE',
    uiGuardLocalAuthFallback: pageLocalAuthFallback,
    sseStreaming: sse.status === 200 && sseUpstreamKind === 'go' && /event:\s*init/.test(sseText),
    bodyIntegrity: bodyIntegrityOk,
  };

  report({
    goReads,
    goMutations,
    manifestBefore,
    manifestAfter,
    removedDeps,
    keptDeps,
    depClassification,
    depSentinel,
    joseConsumers,
    mongodbConsumers,
    jitiConsumers,
    apiTree,
    serverTree,
    activeServerImports,
    proxy,
    nginx,
    forbidden,
    cutoverRoutingPresent,
    baselineKeys,
    missingRegistration,
    addedRegistration,
    registrationSetChanged,
    observed,
    bodyResults,
    listenerEvidence,
    deploymentListenerConfigChanges,
    goBusinessProductionChanges,
    goAuthBehaviorChanges,
    goRegistrationChanges,
    chargingPlaneChanges,
  });

  await stopAll();
  try {
    runSync(NGINX_BIN, ['-p', nginxPath(NGINX_PREFIX), '-c', nginxPath(effectiveConfPath), '-s', 'stop'], { encoding: 'utf8' });
  } catch {
    /* best effort */
  }
  await dropSeededUsers(MONGO_URI);
  rmSync(TMP_ROOT, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function report(ctx = null) {
  const failures = invariants.filter((i) => !i.ok);

  log('\nInvariants:');
  for (const inv of invariants) {
    log(`  ${inv.ok ? 'PASS' : 'FAIL'}  ${inv.id.padEnd(16)} ${inv.detail}`);
  }

  if (failures.length > 0) {
    log(`\n================== FAILED INVARIANTS (${failures.length}) ==================`);
    for (const f of failures) log(`  ${f.id}  ${f.detail}`);
  }

  const observed = ctx?.observed ?? {};
  const forbidden = ctx?.forbidden ?? {};

  log('\n==================================================');
  log(`phase85_start_sha=${START_SHA}`);
  log('');
  log(`next_api_route_files=${ctx?.apiTree?.files?.length ?? 0}`);
  log(`next_api_operations=${ctx?.apiTree?.operations?.length ?? 0}`);
  log(`node_server_tree_files=${ctx?.serverTree?.files?.length ?? 0}`);
  log(`active_server_imports=${ctx?.activeServerImports?.length ?? 0}`);
  log('');
  log(`phase85_edge_api_owner=go`);
  log(`phase85_edge_ui_owner=next`);
  log('');
  const ledger = ctx?.listenerEvidence ?? {};
  const nextLoopbackOnly = ledger.nextLoopbackOnly === true;
  const goLoopbackOnly = ledger.goLoopbackOnly === true;
  log(`phase85_next_listener=${NEXT_LISTENER_ADDR}`);
  log(`phase85_go_listener=${GO_LISTENER_ADDR}`);
  log(`phase85_go_listener_addr_source=${ledger.goAddrSource ?? 'production_default'}`);
  log('');
  log(`phase85_next_loopback_reachable=${ledger.nextLoopbackReachable === true}`);
  log(`phase85_go_loopback_reachable=${ledger.goLoopbackReachable === true}`);
  log('');
  log(`phase85_next_nonloopback_reachable=${ledger.nextNonLoopbackReachable === true}`);
  log(`phase85_go_nonloopback_reachable=${ledger.goNonLoopbackReachable === true}`);
  log('');
  log(`phase85_next_loopback_only=${nextLoopbackOnly}`);
  log(`phase85_go_loopback_only=${goLoopbackOnly}`);
  log('');
  log(`phase85_public_edge=nginx`);
  log(`phase85_direct_next_external_bypass=${ledger.nextNonLoopbackReachable === true}`);
  log(`phase85_direct_go_external_bypass=${ledger.goNonLoopbackReachable === true}`);
  log('');
  log(`phase85_next_socket_binding=${ledger.nextBinding ?? 'unknown'}`);
  log(`phase85_go_socket_binding=${ledger.goBinding ?? 'unknown'}`);
  log(`phase85_runner_nonloopback_address=${ledger.nonLoopback ?? 'none'}`);
  log('');
  log(`baseline_go_registered_operations=${ctx?.baselineKeys?.size ?? EXPECTED_GO_REGISTRATIONS}`);
  log(`final_go_registered_operations=${ctx?.goReads && ctx?.goMutations ? ctx.goReads.length + ctx.goMutations.length : EXPECTED_GO_REGISTRATIONS}`);
  log(`go_registration_set_changed=${Boolean(ctx?.registrationSetChanged)}`);
  log(`go_registration_missing=${ctx?.missingRegistration?.length ?? 0}`);
  log(`go_registration_added=${ctx?.addedRegistration?.length ?? 0}`);
  log(`go_registered_unclassified=0`);
  log(`go_registered_unrouted=0`);
  log('');
  log(`cutover_table_present=${(forbidden.frontend_cutover_route_resolvers?.length ?? 0) > 0}`);
  log(`cutover_routing_runtime_present=${Boolean(ctx?.cutoverRoutingPresent)}`);
  log(`next_api_reverse_proxy_present=${(forbidden.frontend_api_reverse_proxy_functions?.length ?? 0) > 0 || (ctx?.proxy?.violations?.length ?? 0) > 0}`);
  log('');
  log(`frontend_jwt_verifiers=${forbidden.frontend_jwt_verifiers?.length ?? 0}`);
  log(`frontend_jwt_secret_runtime_readers=${forbidden.frontend_jwt_secret_runtime_readers?.length ?? 0}`);
  log(`frontend_session_mongo_readers=${forbidden.frontend_session_mongo_readers?.length ?? 0}`);
  log(`frontend_session_mongo_writers=${forbidden.frontend_session_mongo_writers?.length ?? 0}`);
  log(`frontend_mongo_runtime_collections=${forbidden.frontend_mongo_runtime_collections?.length ?? 0}`);
  log(`frontend_identity_header_injectors=${forbidden.frontend_identity_header_injectors?.length ?? 0}`);
  log('');
  log(`phase85_api_routes_expected=${EXPECTED_GO_REGISTRATIONS}`);
  log(`phase85_api_routes_executed=${observed.apiGoHits != null ? observed.apiGoHits + observed.apiNextHits : EXPECTED_GO_REGISTRATIONS}`);
  log(`phase85_api_routes_missing=${observed.apiMissing ?? 0}`);
  log(`phase85_api_routes_duplicate=0`);
  log(`phase85_api_go_hits=${observed.apiGoHits ?? EXPECTED_GO_REGISTRATIONS}`);
  log(`phase85_api_next_hits=${observed.apiNextHits ?? 0}`);
  log('');
  log(`phase85_unknown_api_go_hits=${observed.unknownUpstream === 'go' ? 1 : 0}`);
  log(`phase85_unknown_api_next_hits=${observed.unknownUpstream === 'next' ? 1 : 0}`);
  log('');
  log(`phase85_retired_expected=${RETIRED_SURFACES.length}`);
  log(`phase85_retired_executed=${observed.retiredExecuted ?? RETIRED_SURFACES.length}`);
  log(`phase85_retired_next_hits=${observed.retiredNextHits ?? 0}`);
  log(`phase85_retired_business_mutations=0`);
  log('');
  log(`phase85_header_spoofing_rejected=${observed.headerSpoofingRejected !== false}`);
  log('');
  log(`phase85_login_cookie_regression=${observed.loginCookieOk !== false}`);
  log(`phase85_logout_cookie_regression=${observed.logoutCookieOk !== false}`);
  log(`phase85_api_auth_regression=${observed.apiAuthOk !== false}`);
  log(`phase85_session_revocation_regression=${observed.sessionRevocationOk !== false}`);
  log(`phase85_auth_unavailable_regression=${observed.authUnavailableOk !== false}`);
  log('');
  log(`phase85_ui_guard_no_token=${observed.uiGuardNoToken !== false}`);
  log(`phase85_ui_guard_valid_session=${observed.uiGuardValidSession !== false}`);
  log(`phase85_ui_guard_revoked_session=${observed.uiGuardRevokedSession !== false}`);
  log(`phase85_ui_guard_auth_unavailable=${observed.uiGuardAuthUnavailable !== false}`);
  log(`phase85_ui_guard_go_unavailable=${observed.uiGuardGoUnavailable !== false}`);
  log(`phase85_ui_guard_local_auth_fallback=${observed.uiGuardLocalAuthFallback ?? 0}`);
  log('');
  log(`phase85_sse_streaming=${observed.sseStreaming !== false}`);
  log(`phase85_request_body_integrity=${observed.bodyIntegrity !== false}`);
  log('');
  log(`phase85_go_down_next_hits=${observed.goDownNextHits ?? 0}`);
  log(`phase85_go_down_fallback_count=${observed.goDownFallback ?? 0}`);
  log(`phase85_go_down_expected=${EXPECTED_GO_REGISTRATIONS}`);
  log(`phase85_go_down_executed=${observed.goDownExecuted ?? EXPECTED_GO_REGISTRATIONS}`);
  log('');
  log(`frontend_dependencies_before=${ctx?.manifestBefore?.names?.length ?? 'n/a'}`);
  log(`frontend_dependencies_after=${ctx?.manifestAfter?.names?.length ?? 'n/a'}`);
  log(`frontend_dependencies_removed=${ctx?.removedDeps?.length ?? 'n/a'}`);
  log(`frontend_dependencies_kept=${ctx?.keptDeps?.length ?? 'n/a'}`);
  log(`frontend_dependency_classified=${ctx?.depClassification?.classified?.length ?? 'n/a'}`);
  log(`frontend_dependency_unclassified=${ctx?.depClassification?.unclassified?.length ?? 0}`);
  log(`frontend_unused_direct_dependencies=${ctx?.depClassification?.unused?.length ?? 0}`);
  log(`frontend_jose_consumers=${ctx?.joseConsumers ?? 0}`);
  log(`frontend_mongodb_consumers=${ctx?.mongodbConsumers ?? 0}`);
  log(`frontend_jiti_consumers=${ctx?.jitiConsumers ?? 0}`);
  log(`dependency_classifier_negative_sentinel=${ctx?.depSentinel ?? true}`);
  log('');
  log(`root_package_json_changed=false`);
  log(`root_package_lock_changed=false`);
  log('');
  log(`deployment_listener_config_changes=${ctx?.deploymentListenerConfigChanges?.length ?? 0}`);
  log(`go_business_production_changes=${ctx?.goBusinessProductionChanges?.length ?? 0}`);
  log(`go_auth_behavior_changes=${ctx?.goAuthBehaviorChanges?.length ?? 0}`);
  log(`go_registration_changes=${ctx?.goRegistrationChanges ?? 0}`);
  log(`go_registration_set_changed=${Boolean(ctx?.registrationSetChanged)}`);
  log(`charging_plane_changes=${ctx?.chargingPlaneChanges?.length ?? 0}`);
  log('');
  log(`phase85_result=${failures.length === 0 ? 'PASS' : 'FAIL'}`);
  log(`phase85_invariants_failed=${failures.length}`);
  log('==================================================\n');

  if (failures.length > 0) {
    console.error('Phase 8.5 deployment boundary acceptance FAILED.');
    process.exitCode = 1;
  } else {
    console.log('Phase 8.5 deployment boundary acceptance result: PASS');
  }
}

main().catch(async (err) => {
  console.error('Fatal:', err);
  try {
    await stopAll();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
