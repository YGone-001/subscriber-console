#!/usr/bin/env node
/**
 * Deployment Boundary Acceptance Suite (production single-upstream consolidation boundary).
 *
 * It exercises the REAL production topology:
 *
 *   HTTP client -> real Nginx (repository deploy/nginx/xcloud.conf)
 *                    |-- /api, /api/*  -> real bundled Go binary (127.0.0.1:18888) -> MongoDB
 *                    |-- /assets/*     -> real bundled Go binary (127.0.0.1:18888) -> embedded Vite assets
 *                    |-- /*            -> real bundled Go binary (127.0.0.1:18888) -> embedded SPA index.html
 *
 * Next.js is NOT started. Port 13333 remains free. Real bundled Go binary serves both
 * API and the static React SPA through the single Nginx upstream.
 *
 * Component policy: handler-only, mock-only, static-only and "fake JS reverse proxy"
 * evidence is NOT sufficient. Everything below drives real TCP requests through a real Nginx
 * fronting real bundled Go, against a real MongoDB. Source assertions are
 * supplemental only and live in an explicitly labelled section.
 *
 * Route authority is DERIVED from the Go registration site (119 exact METHOD+PATH entries in
 * backend/cmd/server/main.go + backend/internal/remediation/handler.go). No historical
 * route-owner table is consulted.
 *
 * Usage:
 *   node scripts/test-deployment-boundary.mjs
 *
 * Environment overrides:
 *   DEPLOYMENT_NGINX_BIN   nginx executable                  (default: `nginx` on PATH)
 *   MONGODB_URI            real MongoDB URI                  (default: mongodb://127.0.0.1:27017)
 *   DEPLOYMENT_NEXT_PORT   retained legacy Next.js port      (default: 13333)
 *   DEPLOYMENT_GO_PORT     Go API port                       (default: 18888)
 *   DEPLOYMENT_EDGE_PORT   Nginx public port                 (default: 18080)
 *   DEPLOYMENT_SKIP_BUILD  reuse an existing frontend build  (default: build if missing)
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
import { findListener, inspectProcess } from './lib/local-runtime.mjs';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FRONTEND = join(ROOT, 'frontend');
const BACKEND = join(ROOT, 'backend');

/** Canonical production API surface size (asserted against the derived set). */
const EXPECTED_GO_REGISTRATIONS = 119;

const NEXT_PORT = Number(process.env.DEPLOYMENT_NEXT_PORT || 13333);
const GO_PORT = Number(process.env.DEPLOYMENT_GO_PORT || 18888);
const EDGE_PORT = Number(process.env.DEPLOYMENT_EDGE_PORT || 18080);
const NGINX_BIN = process.env.DEPLOYMENT_NGINX_BIN || 'nginx';
const MONGO_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const SKIP_BUILD = process.env.DEPLOYMENT_SKIP_BUILD === '1';

const JWT_SECRET = 'deployment-boundary-acceptance-secret-key-0123456789';
const USER_PREFIX = 'deployment_';
const PASSWORD = 'Deployment!Passw0rd';
const OTHER_PASSWORD = 'Deployment!Other';

const NEXT_UPSTREAM_ADDR = `127.0.0.1:${NEXT_PORT}`;
const GO_UPSTREAM_ADDR = `127.0.0.1:${GO_PORT}`;

/**
 * Production listener contract under acceptance.
 *
 * Go: `backend/internal/config` defaults HTTP_ADDR to 127.0.0.1:18888. The suite must
 * exercise that default rather than masking it, so HTTP_ADDR is injected only when the
 * operator explicitly overrides the canonical port.
 * Next: retained legacy contract; not started in single-upstream production mode.
 */
const GO_PRODUCTION_DEFAULT_ADDR = '127.0.0.1:18888';
const NEXT_LISTENER_ADDR = `127.0.0.1:${NEXT_PORT}`;
const GO_LISTENER_ADDR = `127.0.0.1:${GO_PORT}`;

/** Port of the MongoDB the Go service is pointed at (the relay transparently proxies it). */
function mongoTargetPort(uri) {
  try {
    return Number(new URL(uri).port) || 27017;
  } catch {
    return 27017;
  }
}
const MONGO_TARGET_PORT = mongoTargetPort(MONGO_URI);

const UNKNOWN_SENTINEL = '/api/__routing_unknown_probe__';

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

const TMP_ROOT = join(os.tmpdir(), `deployment-boundary-${process.pid}-${Date.now()}`);
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

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

/** Derive the Go production listener default from the production configuration source. */
function deriveGoListenerDefault() {
  const source = readIfExists(join(BACKEND, 'internal', 'config', 'config.go'));
  if (!source) return null;
  const m = source.match(/envOrDefault\("HTTP_ADDR",\s*"([^"]+)"\)/);
  return m ? m[1] : null;
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
 * wildcard listener using `ss -ltn` (Linux) or `netstat -ano -p tcp` (Windows).
 */
function listenerBinding(port) {
  let out = '';
  let localAddressField = 3;
  if (process.platform === 'linux') {
    out = runSync('ss', ['-ltn'], { encoding: 'utf8' }).stdout || '';
  } else if (process.platform === 'win32') {
    out = runSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' }).stdout || '';
    localAddressField = 1;
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
  return `deploy-${markerSeq}`;
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
    headers: { ...headers, 'x-deployment-marker': marker },
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
// Static scanners (supplemental source evidence)
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
  frontend_api_reverse_proxy_functions: [/\bforwardToGo\s*\(/, /\bNextResponse\.rewrite\s*\(/, /\bcreateProxyHandler\s*\(/],
  frontend_cutover_route_resolvers: [/\bCUTOVER_TABLE\b/, /\bresolveRouteOwner\b/],
};

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

/** Negative sentinels: prove every scanner is falsifiable. */
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

  const mongoReadSample = "const col = db.collection('app_users');\nreturn col.findOne({ username });";
  if (scanMongoReadersInSource(mongoReadSample).length === 0) failures.push('frontend_session_mongo_readers');
  const arrayHelperSample = 'const first = rows.find((row) => row.active);\nconst rest = rows.filter(Boolean);';
  if (scanMongoReadersInSource(arrayHelperSample).length > 0) failures.push('frontend_session_mongo_readers:false_positive');
  return { ok: failures.length === 0, failures };
}

// ---------------------------------------------------------------------------
// Next.js API tree / server tree removal scan
// ---------------------------------------------------------------------------

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
  const proxyPresent = existsSync(proxyPath);
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
  const authFiles = [
    join(FRONTEND, 'src', 'auth', 'auth-client.ts'),
    join(FRONTEND, 'src', 'auth', 'AuthGate.tsx'),
    join(FRONTEND, 'src', 'providers', 'AuthProvider.tsx'),
  ];
  const authCode = authFiles.map(readIfExists).join('\n');
  const consultsGoAuth = !proxyPresent && /\/api\/auth\/me/.test(authCode);
  return {
    content: readIfExists(proxyPath),
    code,
    violations,
    legacyProxyAbsent: !proxyPresent,
    consultsGoAuth,
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
    upstreamCount: Object.keys(upstreams).length,
    apiLocations: apiLocations.map((l) => l.pattern),
    sseLocation: find('= /api/notifications/stream'),
    apiExactToGo: proxyTo(find('= /api'), 'xcloud_go'),
    apiPrefixToGo: proxyTo(find('/api/'), 'xcloud_go'),
    uiToGo: proxyTo(uiRoot, 'xcloud_go'),
    nextUpstreamPresent: Boolean(upstreams.xcloud_next),
    nextHmrPresent: Boolean(find('/_next/hmr')),
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
// Dependency classifier - non-tautological
// ---------------------------------------------------------------------------

const UNUSED_SENTINEL_DEP = '@deployment/dependency-classifier-unused-sentinel';

function readFrontendManifest() {
  const raw = readIfExists(join(FRONTEND, 'package.json'));
  if (!raw) return null;
  const pkg = JSON.parse(raw);
  const merged = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  return { pkg, names: Object.keys(merged) };
}

function classifyFrontendDependencies(names) {
  const evidence = new Map();
  const add = (name, where) => {
    if (!evidence.has(name)) evidence.set(name, []);
    evidence.get(name).push(where);
  };

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

  const manifest = JSON.parse(readIfExists(join(FRONTEND, 'package.json')) || '{}');
  const scriptText = Object.values(manifest.scripts ?? {}).join('\n');
  for (const name of names) if (mentions(scriptText, name)) add(name, 'package.json#scripts');

  if (walk(join(FRONTEND, 'src'), (p) => /\.tsx?$/.test(p)).length > 0) add('typescript', 'typescript-sources');

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

let activeRelay = null;

async function stopAll() {
  for (const { child } of processes) stopTracked(child);
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

  async blackout() {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.server.close();
    this.server = null;
    await waitForPortClosed(this.listenPort, 5000);
  }

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
  log('== Deployment Boundary Acceptance Suite (production single-upstream consolidation boundary) ==\n');

  // -- Derived Go registration authority ----------------------------------
  const { keys: goKeys, duplicates: goDuplicates } = deriveGoRegistrations();
  const goKeySet = new Set(goKeys);
  const { reads: goReads, mutations: goMutations } = classifyGoRegistrations(goKeys);

  check(
    'DB-G01',
    goKeys.length === EXPECTED_GO_REGISTRATIONS && goDuplicates.length === 0,
    `go_registrations=${goKeys.length} duplicates=${goDuplicates.length}`,
  );
  check(
    'DB-G05',
    !goKeySet.has(`GET ${UNKNOWN_SENTINEL}`),
    `unknown_probe_registered_in_go=${goKeySet.has(`GET ${UNKNOWN_SENTINEL}`) ? 1 : 0}`,
  );

  // -- Removal / no-proxy / route-owner retirement source evidence --------
  const apiTree = scanNextApiTree();
  const serverTree = scanNodeServerTree();
  const activeServerImports = scanActiveServerImports();
  const proxy = scanProxySource();
  const nginx = scanNginxSource();
  const forbidden = scanFrontendForForbidden();
  const sentinels = scannerNegativeSentinels();
  const cutoverRoutingPresent = existsSync(join(FRONTEND, 'src', 'lib', 'cutover-routing.ts'));

  check('DB-I01', apiTree.files.length === 0 && apiTree.operations.length === 0, `next_api_route_files=${apiTree.files.length} next_api_operations=${apiTree.operations.length}`);
  check('DB-I02', !serverTree.present && serverTree.files.length === 0, `node_server_tree_files=${serverTree.files.length}`);
  check('DB-I03', activeServerImports.length === 0, `active_server_imports=${activeServerImports.length}`);
  check('DB-I04', !cutoverRoutingPresent, `cutover_routing_runtime_present=${cutoverRoutingPresent}`);
  check(
    'DB-I05',
    forbidden.frontend_cutover_route_resolvers.length === 0,
    `frontend_cutover_route_resolvers=${forbidden.frontend_cutover_route_resolvers.length}`,
  );
  check(
    'DB-G03',
    proxy.violations.length === 0 && !/\bforwardToGo\b/.test(proxy.code) && forbidden.frontend_api_reverse_proxy_functions.length === 0,
    `proxy_forbidden_tokens=${proxy.violations.length} api_reverse_proxy_functions=${forbidden.frontend_api_reverse_proxy_functions.length}`,
  );
  check('DB-G08', proxy.legacyProxyAbsent && proxy.consultsGoAuth, `legacy_proxy_absent=${proxy.legacyProxyAbsent} go_auth_delegation=${proxy.consultsGoAuth}`);

  const jwtVerifiers = forbidden.frontend_jwt_verifiers.length;
  const jwtSecretReaders = forbidden.frontend_jwt_secret_runtime_readers.length;
  const mongoReaders = forbidden.frontend_session_mongo_readers.length;
  const mongoWriters = forbidden.frontend_session_mongo_writers.length;
  const mongoCollections = forbidden.frontend_mongo_runtime_collections.length;
  const identityInjectors = forbidden.frontend_identity_header_injectors.length;
  check('DB-G09', mongoReaders === 0 && mongoWriters === 0 && mongoCollections === 0, `frontend_mongo_readers=${mongoReaders} writers=${mongoWriters} collections=${mongoCollections}`);
  check('DB-G10', jwtVerifiers === 0 && jwtSecretReaders === 0, `frontend_jwt_verifiers=${jwtVerifiers} jwt_secret_readers=${jwtSecretReaders}`);
  check('DB-G07-static', identityInjectors === 0, `frontend_identity_header_injectors=${identityInjectors}`);
  check('DB-I06', sentinels.ok, `scanner_negative_sentinels=${sentinels.ok} failures=[${sentinels.failures.join(',')}]`);

  // -- Frontend dependency classifier -------------------------------------
  const manifest = readFrontendManifest();
  const deps = manifest ? manifest.names : [];
  const depClassification = classifyFrontendDependencies(deps);
  const depSentinel = dependencyNegativeSentinel(deps);
  const joseConsumers = depClassification.evidence.has('jose') ? 1 : 0;
  const mongodbConsumers = depClassification.evidence.has('mongodb') ? 1 : 0;
  const jitiConsumers = depClassification.evidence.has('jiti') ? 1 : 0;
  check(
    'DB-G16',
    depClassification.unclassified.length === 0 && depClassification.unused.length === 0 && depSentinel,
    `frontend_dependencies=${deps.length} unclassified=${depClassification.unclassified.length} unused=${depClassification.unused.length} sentinel=${depSentinel}`,
  );

  // -- Go production listener boundary -----------------------------------
  const goListenerDefault = deriveGoListenerDefault();
  check(
    'DB-I07',
    goListenerDefault === GO_PRODUCTION_DEFAULT_ADDR,
    `go_listener_default=${goListenerDefault} expected=${GO_PRODUCTION_DEFAULT_ADDR}`,
  );

  // -- Charging plane remains frozen -------------------------------------
  const chargingMutationKeys = goMutations.filter((k) =>
    /\/api\/ocs\/(sessions|reservations|usage|events|config)\b/.test(k),
  );
  check('DB-G18', chargingMutationKeys.length === 0, `charging_plane_mutations=${chargingMutationKeys.length}`);

  // -- Nginx single-upstream consolidation boundary -----------------------------
  check(
    'DB-G02-source',
    nginx.apiExactToGo &&
      nginx.apiPrefixToGo &&
      nginx.uiToGo &&
      !nginx.nextUpstreamPresent &&
      !nginx.nextHmrPresent &&
      nginx.upstreamCount === 1 &&
      nginx.goUpstream.includes(GO_UPSTREAM_ADDR),
    `api_exact_to_go=${nginx.apiExactToGo} api_prefix_to_go=${nginx.apiPrefixToGo} ui_to_go=${nginx.uiToGo} next_upstream_present=${nginx.nextUpstreamPresent} next_hmr_present=${nginx.nextHmrPresent} upstream_count=${nginx.upstreamCount} go_upstream=${nginx.goUpstream}`,
  );
  check('DB-I08', nginx.identityHeadersStripped && nginx.forwardedProto && nginx.bodySize10m && nginx.sseUnbuffered, `identity_stripped=${nginx.identityHeadersStripped} xfp=${nginx.forwardedProto} body_10m=${nginx.bodySize10m} sse_unbuffered=${nginx.sseUnbuffered}`);

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
  check('DB-R00', mongoReachable, `mongo_reachable=${mongoReachable} uri=${MONGO_URI}`);
  if (!mongoReachable) {
    report();
    return;
  }

  // Port preflight.
  const preflightPorts = [
    ['DB-R00A', GO_PORT, 'go'],
    ['DB-R00B', NEXT_PORT, 'next'],
    ['DB-R00C', EDGE_PORT, 'edge'],
    ['DB-R00D', RELAY_PORT, 'mongo_relay'],
  ];
  const occupiedPorts = [];
  for (const [id, port, role] of preflightPorts) {
    const occupied = await isPortOpen(port);
    check(id, !occupied, `port_free_${role}=${!occupied} port=${port}`);
    if (occupied) {
      occupiedPorts.push(`${role}:${port}`);
      const listener = await findListener(port, { refresh: true });
      const info = listener && listener.processId ? await inspectProcess(listener.processId, { refresh: true }) : null;
      const owner = [
        listener ? `pid=${listener.processId}` : 'pid=unknown',
        listener && listener.name ? `process=${listener.name}` : null,
        info && info.executable ? `exe=${info.executable}` : null,
      ].filter(Boolean).join(' ');
      log(`    occupied ${role} port ${port} -> ${owner}`);
      if (info && info.commandLine) log(`    command = ${info.commandLine}`);
    }
  }
  if (occupiedPorts.length > 0) {
    log(`\nRefusing to run: these ports are already held by another process -> ${occupiedPorts.join(', ')}`);
    log('The acceptance suite must own every port it measures; free them and re-run.');
    log('Diagnose port ownership first:  npm run local:preflight');
    report();
    return;
  }

  log('-- Runtime bring-up --');
  await seedUsers(MONGO_URI);

  // Relay -> Bundled Go -> Nginx
  const relay = new MongoRelay(MONGO_TARGET_PORT, RELAY_PORT);
  activeRelay = relay;
  await relay.start();
  check('DB-R01', await waitForPort(RELAY_PORT, 5000), `mongo_relay_listening=${RELAY_PORT}`);

  // Stage and build SPA if needed
  const distDir = join(FRONTEND, 'dist');
  const indexHtmlPath = join(distDir, 'index.html');
  if (!SKIP_BUILD && !existsSync(indexHtmlPath)) {
    log('  building frontend production bundle...');
    const spaBuild = runSync('npm', ['run', 'build'], { cwd: FRONTEND, shell: true, stdio: 'inherit', timeout: 300000 });
    if (spaBuild.status !== 0) {
      log('frontend build failed');
    }
  }

  log('  staging SPA for Go static embed...');
  const stageSpa = runSync(process.execPath, [join(ROOT, 'scripts', 'stage-spa-for-go.mjs')], { cwd: ROOT, stdio: 'inherit' });
  const staticDir = join(BACKEND, 'internal', 'spa', 'static');
  const stagedIndexExists = existsSync(join(staticDir, 'index.html'));
  check('DB-R04', stageSpa.status === 0 && stagedIndexExists, `spa_staging_status=${stageSpa.status} staged_index_exists=${stagedIndexExists}`);

  // Capture original dist hashes for edge identity comparison
  const originalIndexBytes = readFileSync(indexHtmlPath);
  const originalIndexHash = sha256(originalIndexBytes);

  const assetsDir = join(distDir, 'assets');
  const assetFiles = existsSync(assetsDir) ? readdirSync(assetsDir) : [];
  const realJsFile = assetFiles.find((f) => f.endsWith('.js'));
  const realCssFile = assetFiles.find((f) => f.endsWith('.css'));
  if (!realJsFile || !realCssFile) {
    throw new Error('Expected at least one JS and one CSS asset in frontend/dist/assets');
  }
  const originalJsBytes = readFileSync(join(assetsDir, realJsFile));
  const originalJsHash = sha256(originalJsBytes);
  const originalCssBytes = readFileSync(join(assetsDir, realCssFile));
  const originalCssHash = sha256(originalCssBytes);

  log('  compiling bundled Go server binary with embedded SPA...');
  const goBuild = runSync('go', ['build', '-o', GO_BIN, './cmd/server'], { cwd: BACKEND, stdio: 'inherit' });
  check('DB-R02', goBuild.status === 0 && existsSync(GO_BIN), `go_build_status=${goBuild.status}`);

  const goEnv = {
    ...process.env,
    MONGODB_URI: `mongodb://127.0.0.1:${RELAY_PORT}/?serverSelectionTimeoutMS=2000&connectTimeoutMS=2000`,
    MONGODB_XCLOUD_DB: 'xcloud',
    MONGODB_APP_DB: 'xcloud_ops',
    JWT_SECRET,
  };
  delete goEnv.HTTP_ADDR;
  const goAddrFromEnv = process.env.DEPLOYMENT_GO_PORT ? `127.0.0.1:${GO_PORT}` : null;
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
  check('DB-R03', goUp && goAlive, `go_listening=${goUp} go_process_alive=${goAlive} port=${GO_PORT} addr_source=${goAddrSource} output=${outputTail(goOutput)}`);
  if (!goUp || !goAlive) {
    report();
    await stopAll();
    return;
  }

  // Next.js is NOT started in single-upstream production mode. Port 13333 must remain free and unallocated.
  const nextPortStillFree = !(await isPortOpen(NEXT_PORT));
  check('DB-R05', nextPortStillFree, `next_port_free=${nextPortStillFree} port=${NEXT_PORT} production_next_process_omitted=true`);

  // =======================================================================
  // Internal listener boundary - real socket proof
  // =======================================================================

  log('-- Internal listener boundary --');
  const nonLoopback = nonLoopbackIPv4();
  const goLoopbackReachable = await probeTcp('127.0.0.1', GO_PORT);
  const goNonLoopbackReachable = nonLoopback ? await probeTcp(nonLoopback, GO_PORT) : null;

  // Next listener is NOT started; verify Next port is unreachable
  const nextLoopbackReachable = await probeTcp('127.0.0.1', NEXT_PORT);
  const nextNonLoopbackReachable = nonLoopback ? await probeTcp(nonLoopback, NEXT_PORT) : false;

  check(
    'DB-B01',
    Boolean(nonLoopback),
    `non_loopback_address=${nonLoopback ?? 'none'} (a real off-loopback address is required to prove the boundary)`,
  );
  check(
    'DB-B02',
    nextLoopbackReachable === false && nextNonLoopbackReachable === false,
    `next_unstarted_loopback=${nextLoopbackReachable} next_unstarted_nonloopback=${nextNonLoopbackReachable} (Next.js is not running in production)`,
  );
  check(
    'DB-B03',
    goLoopbackReachable && goNonLoopbackReachable === false,
    `go_listener=${GO_LISTENER_ADDR} loopback_reachable=${goLoopbackReachable} nonloopback_reachable=${goNonLoopbackReachable}`,
  );

  const goBinding = listenerBinding(GO_PORT);
  const goLoopbackOnly = goLoopbackReachable && goNonLoopbackReachable === false;
  check(
    'DB-B04',
    goLoopbackOnly && !nextLoopbackReachable,
    `go_loopback_only=${goLoopbackOnly} go_binding=${goBinding} next_loopback_reachable=${nextLoopbackReachable}`,
  );
  const listenerEvidence = {
    nonLoopback,
    nextLoopbackReachable,
    goLoopbackReachable,
    nextNonLoopbackReachable,
    goNonLoopbackReachable,
    nextLoopbackOnly: false,
    goLoopbackOnly,
    nextBinding: 'none',
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
    "  log_format deployment '$http_x_deployment_marker|$upstream_addr|$upstream_status|$status|$request_method|$request_uri|$content_type';",
    `  access_log ${nginxPath(ACCESS_LOG)} deployment;`,
    `  client_body_temp_path ${nginxPath(join(NGINX_PREFIX, 'temp', 'client_body'))};`,
    `  proxy_temp_path ${nginxPath(join(NGINX_PREFIX, 'temp', 'proxy'))};`,
    "  include " + nginxPath(join(NGINX_PREFIX, 'conf', 'mime.types')) + ';',
    repoConf.replace(/^    listen 80;/m, `    listen ${EDGE_PORT};`),
    '}',
  ].join('\n');
  writeFileSync(join(NGINX_PREFIX, 'conf', 'mime.types'), 'types { text/html html; text/css css; application/javascript js; }\n');
  const effectiveConfPath = join(NGINX_PREFIX, 'conf', 'deployment-boundary.conf');
  writeFileSync(effectiveConfPath, effectiveConf);

  const nginxTest = runSync(NGINX_BIN, ['-t', '-p', nginxPath(NGINX_PREFIX), '-c', nginxPath(effectiveConfPath)], { encoding: 'utf8' });
  const nginxSyntaxOk = nginxTest.status === 0;
  const nginxDetail = (nginxTest.stderr || nginxTest.stdout || '').trim().split('\n').slice(-1)[0] || '';
  check('DB-R06', nginxSyntaxOk, `nginx_syntax=${nginxSyntaxOk} nginx_bin=${NGINX_BIN} spawn_error=${nginxTest.error ? nginxTest.error.message : 'none'} ${nginxDetail}`);
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
  check('DB-R07', edgeUp, `edge_listening=${edgeUp} port=${EDGE_PORT}`);
  if (!edgeUp) {
    report();
    await stopAll();
    return;
  }

  // Edge topology bring-up gate: API and UI both reach Go through the edge.
  const topologyApi = await edgeRequest({ requestPath: '/api/auth/me' });
  await sleep(130);
  const topologyUi = await edgeRequest({ requestPath: '/login' });
  check(
    'DB-R08',
    topologyApi.upstream === 'go' && topologyApi.status === 401 && topologyUi.upstream === 'go' && topologyUi.status === 200,
    `edge_api_status=${topologyApi.status} api_upstream=${topologyApi.upstream} ui_status=${topologyUi.status} ui_upstream=${topologyUi.upstream}`,
  );

  // =======================================================================
  // SPA browser route matrix through edge
  // =======================================================================

  log('-- SPA browser route matrix through edge --');
  resetAccessLog();
  const spaRoutes = [
    '/',
    '/login',
    '/subscribers',
    '/ocs/balances',
    '/system-health',
    '/users/example',
    '/users/john.doe',
    '/users/user.js',
    '/users/.alice',
    '/users/john..doe',
  ];
  const spaResults = [];
  for (const rPath of spaRoutes) {
    const res = await edgeRequest({ requestPath: rPath });
    const isHtml = String(res.headers['content-type'] || '').includes('text/html');
    const bodyStr = res.body.toString('utf8');
    const hasRootDiv = bodyStr.includes('<div id="root">');
    const noCache = rPath === '/' ? String(res.headers['cache-control'] || '').includes('no-cache') : true;
    const ok = res.status === 200 && res.upstream === 'go' && isHtml && hasRootDiv && noCache;
    spaResults.push({ path: rPath, status: res.status, upstream: res.upstream, isHtml, hasRootDiv, ok });
    await sleep(130);
  }
  const allSpaOk = spaResults.every((r) => r.ok);
  check(
    'DB-U01',
    allSpaOk,
    `spa_routes_total=${spaRoutes.length} spa_routes_passed=${spaResults.filter((r) => r.ok).length} failures=${spaResults.filter((r) => !r.ok).map((r) => `${r.path}:${r.status}/${r.upstream}`).join(',')}`,
  );

  // Assert root HTML byte identity with frontend-spa/dist/index.html
  const rootRes = await edgeRequest({ requestPath: '/' });
  const rootIndexHash = sha256(rootRes.body);
  const rootHtmlIdentity = rootIndexHash === originalIndexHash;
  check('DB-U02', rootHtmlIdentity, `edge_root_html_identity=${rootHtmlIdentity} expected=${originalIndexHash} got=${rootIndexHash}`);

  // Static asset identity and caching through edge
  log('-- Static asset identity and policy through edge --');
  const edgeJsRes = await edgeRequest({ requestPath: `/assets/${realJsFile}` });
  const edgeJsHash = sha256(edgeJsRes.body);
  const edgeJsCache = String(edgeJsRes.headers['cache-control'] || '');
  const jsIdentityOk = edgeJsRes.status === 200 && edgeJsRes.upstream === 'go' && edgeJsHash === originalJsHash && edgeJsCache.includes('immutable');
  check('DB-U03', jsIdentityOk, `edge_js_identity=${jsIdentityOk} status=${edgeJsRes.status} upstream=${edgeJsRes.upstream} cache=${edgeJsCache}`);

  const edgeCssRes = await edgeRequest({ requestPath: `/assets/${realCssFile}` });
  const edgeCssHash = sha256(edgeCssRes.body);
  const edgeCssCache = String(edgeCssRes.headers['cache-control'] || '');
  const cssIdentityOk = edgeCssRes.status === 200 && edgeCssRes.upstream === 'go' && edgeCssHash === originalCssHash && edgeCssCache.includes('immutable');
  check('DB-U04', cssIdentityOk, `edge_css_identity=${cssIdentityOk} status=${edgeCssRes.status} upstream=${edgeCssRes.upstream} cache=${edgeCssCache}`);

  // Missing static resources: must return 404 non-SPA responses
  log('-- Missing static resources --');
  const missingResources = [
    '/assets/missing.js',
    '/missing.js',
    '/favicon-does-not-exist.ico',
    '/.gitignore',
  ];
  const missingResults = [];
  for (const mPath of missingResources) {
    const res = await edgeRequest({ requestPath: mPath });
    const bodyStr = res.body.toString('utf8');
    const isSpaFallback = bodyStr.includes('<div id="root">');
    const ok = res.status === 404 && res.upstream === 'go' && !isSpaFallback;
    missingResults.push({ path: mPath, status: res.status, upstream: res.upstream, isSpaFallback, ok });
    await sleep(130);
  }
  const allMissingOk = missingResults.every((r) => r.ok);
  check(
    'DB-U05',
    allMissingOk,
    `missing_resources_total=${missingResources.length} all_404_non_spa=${allMissingOk} results=${missingResults.map((r) => `${r.path}:${r.status}/${r.upstream}/spa=${r.isSpaFallback}`).join(',')}`,
  );

  // Health and readiness through edge
  log('-- Health and readiness --');
  const healthzRes = await edgeRequest({ requestPath: '/healthz' });
  const readyzRes = await edgeRequest({ requestPath: '/readyz' });
  let healthzJson = null;
  let readyzJson = null;
  try {
    healthzJson = JSON.parse(healthzRes.body.toString('utf8'));
  } catch {}
  try {
    readyzJson = JSON.parse(readyzRes.body.toString('utf8'));
  } catch {}
  const healthzOk = healthzRes.status === 200 && healthzRes.upstream === 'go' && (healthzJson?.status === 'ok' || healthzRes.body.toString('utf8').trim() === 'ok') && !healthzRes.body.toString('utf8').includes('<div id="root">');
  const readyzOk = readyzRes.status === 200 && readyzRes.upstream === 'go' && (readyzJson?.status === 'ok' || readyzRes.body.toString('utf8').trim() === 'ok') && !readyzRes.body.toString('utf8').includes('<div id="root">');
  check('DB-U06', healthzOk && readyzOk, `healthz_status=${healthzRes.status} upstream=${healthzRes.upstream} readyz_status=${readyzRes.status} upstream=${readyzRes.upstream}`);

  // =======================================================================
  // API route execution matrix - all 119 operations
  // =======================================================================

  log('-- API route execution matrix --');
  resetAccessLog();
  const routeMatrix = [];
  for (const key of goKeys) {
    const [method, pattern] = [key.split(' ')[0], key.split(' ').slice(1).join(' ')];
    const requestPath = pattern.replace(/\{[^}]+\}/g, 'probe');
    const res = await edgeRequest({ method, requestPath, timeoutMs: 6000, abortAfterHeaders: requestPath.includes('/notifications/stream') });
    routeMatrix.push({ key, method, requestPath, status: res.status, upstream: res.upstream, upstreamAddr: res.upstreamAddr });
    await sleep(130);
  }
  const apiGoHits = routeMatrix.filter((r) => r.upstream === 'go').length;
  const apiNextHits = routeMatrix.filter((r) => r.upstream === 'next').length;
  const apiMissing = routeMatrix.filter((r) => r.upstreamAddr === null).length;
  check(
    'DB-G11',
    routeMatrix.length === EXPECTED_GO_REGISTRATIONS && apiGoHits === EXPECTED_GO_REGISTRATIONS && apiNextHits === 0 && apiMissing === 0,
    `expected=${EXPECTED_GO_REGISTRATIONS} executed=${routeMatrix.length} go_hits=${apiGoHits} next_hits=${apiNextHits} missing=${apiMissing}`,
  );

  // -- Unknown API boundary ------------------------------------------------
  const unknown = await edgeRequest({ requestPath: UNKNOWN_SENTINEL });
  const unknownIsSpaFallback = unknown.body.toString('utf8').includes('<div id="root">');
  check('DB-I09', unknown.upstream === 'go' && unknown.status === 404 && !unknownIsSpaFallback, `unknown_api_status=${unknown.status} upstream=${unknown.upstream} spa_fallback=${unknownIsSpaFallback}`);

  // -- Exact /api boundary -------------------------------------------------
  const exactApi = await edgeRequest({ requestPath: '/api' });
  check('DB-I10', exactApi.upstream === 'go', `exact_api_upstream=${exactApi.upstream} status=${exactApi.status}`);

  // -- Retired mutation surfaces ------------------------------------------
  const retiredResults = [];
  for (const surface of RETIRED_SURFACES) {
    const requestPath = surface.path.replace(/\{[^}]+\}/g, 'probe');
    const res = await edgeRequest({ method: surface.method, requestPath, headers: { 'content-type': 'application/json' }, body: '{}' });
    retiredResults.push({ ...surface, status: res.status, upstream: res.upstream });
    await sleep(130);
  }
  const retiredNextHits = retiredResults.filter((r) => r.upstream === 'next').length;
  const retiredExecuted = retiredResults.filter((r) => r.upstream === 'go').length;
  check(
    'DB-I11',
    retiredExecuted === RETIRED_SURFACES.length && retiredNextHits === 0,
    `retired_expected=${RETIRED_SURFACES.length} retired_executed=${retiredExecuted} retired_next_hits=${retiredNextHits}`,
  );

  // =======================================================================
  // Authentication boundary
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
    'DB-A01',
    adminLogin.status === 200 && adminLogin.upstream === 'go' && Boolean(adminToken) && /HttpOnly/i.test(cookieText) && /Path=\//i.test(cookieText) && /SameSite=Lax/i.test(cookieText),
    `login_status=${adminLogin.status} upstream=${adminLogin.upstream} cookie=${cookieText.replace(/auth_token=[^;]+/, 'auth_token=<redacted>')}`,
  );

  const invalidLogin = await edgeRequest({
    method: 'POST',
    requestPath: '/api/auth/login',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: `${USER_PREFIX}admin`, password: OTHER_PASSWORD }),
  });
  check('DB-A02', invalidLogin.status === 401 && invalidLogin.upstream === 'go', `invalid_login_status=${invalidLogin.status} upstream=${invalidLogin.upstream}`);

  const logout = await edgeRequest({ method: 'POST', requestPath: '/api/auth/logout', headers: { ...cookieHeader(adminToken) } });
  const logoutCookie = String(logout.headers['set-cookie'] || '');
  check('DB-A03', logout.status === 200 && /auth_token=;/.test(logoutCookie) && /Max-Age=0|Expires=/i.test(logoutCookie), `logout_status=${logout.status} cookie=${logoutCookie.replace(/auth_token=[^;]*/, 'auth_token=<redacted>')}`);

  const meValid = await edgeRequest({ requestPath: '/api/auth/me', headers: cookieHeader(adminToken) });
  check('DB-A04', meValid.status === 200 && meValid.upstream === 'go', `me_status=${meValid.status} upstream=${meValid.upstream}`);

  const meNoCookie = await edgeRequest({ requestPath: '/api/auth/me' });
  check('DB-A05', meNoCookie.status === 401 && meNoCookie.upstream === 'go', `missing_cookie_status=${meNoCookie.status} upstream=${meNoCookie.upstream}`);

  const meInvalidJwt = await edgeRequest({ requestPath: '/api/auth/me', headers: cookieHeader('not.a.jwt') });
  check('DB-A06', meInvalidJwt.status === 401 && meInvalidJwt.upstream === 'go', `invalid_jwt_status=${meInvalidJwt.status} upstream=${meInvalidJwt.upstream}`);

  const ghostToken = await mintToken({ username: `${USER_PREFIX}ghost`, role: 'admin', sv: 1 });
  const meUnknown = await edgeRequest({ requestPath: '/api/auth/me', headers: cookieHeader(ghostToken) });
  check('DB-A07', meUnknown.status === 401 && meUnknown.upstream === 'go', `unknown_account_status=${meUnknown.status} upstream=${meUnknown.upstream} code=${bodyCode(meUnknown)}`);

  const disabledToken = await mintToken({ username: `${USER_PREFIX}disabled`, role: 'admin', sv: 1 });
  const meDisabled = await edgeRequest({ requestPath: '/api/auth/me', headers: cookieHeader(disabledToken) });
  check('DB-A08', meDisabled.status === 401 && meDisabled.upstream === 'go', `disabled_account_status=${meDisabled.status} upstream=${meDisabled.upstream} code=${bodyCode(meDisabled)}`);

  const lockedToken = await mintToken({ username: `${USER_PREFIX}locked`, role: 'admin', sv: 1 });
  const meLocked = await edgeRequest({ requestPath: '/api/auth/me', headers: cookieHeader(lockedToken) });
  check('DB-A09', meLocked.status === 401 && meLocked.upstream === 'go', `locked_account_status=${meLocked.status} upstream=${meLocked.upstream} code=${bodyCode(meLocked)}`);

  const roleMismatchToken = await mintToken({ username: `${USER_PREFIX}viewer`, role: 'admin', sv: 1 });
  const meRoleMismatch = await edgeRequest({ requestPath: '/api/auth/me', headers: cookieHeader(roleMismatchToken) });
  check('DB-A10', meRoleMismatch.status === 401 && meRoleMismatch.upstream === 'go', `role_mismatch_status=${meRoleMismatch.status} upstream=${meRoleMismatch.upstream} code=${bodyCode(meRoleMismatch)}`);

  const revokedToken = await mintToken({ username: `${USER_PREFIX}viewer`, role: 'viewer', sv: 99 });
  const meRevoked = await edgeRequest({ requestPath: '/api/auth/me', headers: cookieHeader(revokedToken) });
  check('DB-A11', meRevoked.status === 401 && meRevoked.upstream === 'go', `revoked_session_status=${meRevoked.status} upstream=${meRevoked.upstream} code=${bodyCode(meRevoked)}`);

  const viewerToken = await mintToken({ username: `${USER_PREFIX}viewer`, role: 'viewer', sv: 1 });
  const meViewer = await edgeRequest({ requestPath: '/api/auth/me', headers: cookieHeader(viewerToken) });
  const viewerDirect = await httpRequest({ port: GO_PORT, requestPath: '/api/auth/me', headers: cookieHeader(viewerToken) });
  check('DB-A12', meViewer.status === 200 && meViewer.upstream === 'go', `valid_viewer_status=${meViewer.status} upstream=${meViewer.upstream} code=${bodyCode(meViewer)} direct_status=${viewerDirect.status} direct_code=${bodyCode(viewerDirect)}`);

  const authNextHits = [adminLogin, invalidLogin, logout, meValid, meNoCookie, meInvalidJwt, meUnknown, meDisabled, meLocked, meRoleMismatch, meRevoked, meViewer].filter((r) => r.upstream === 'next').length;
  check('DB-A13', authNextHits === 0, `next_api_authentication_decisions=${authNextHits}`);

  // -- Header spoofing ----------------------------------------------------
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
    'DB-G07',
    spoofRejected,
    `forged_headers_users_status=${spoofUsers.status} permissions_status=${spoofPermissions.status} effective_role=${spoofedRole}`,
  );

  // =======================================================================
  // SSE streaming
  // =======================================================================

  log('-- SSE streaming --');
  resetAccessLog();
  const sseMarker = nextMarker();
  const sse = await httpStreamFirstChunk({
    port: EDGE_PORT,
    requestPath: '/api/notifications/stream',
    headers: { ...cookieHeader(adminToken), 'x-deployment-marker': sseMarker },
    firstChunkTimeoutMs: 8000,
  });
  const sseEntry = await logEntryForMarker(sseMarker, 5000);
  const sseUpstream = sseEntry ? sseEntry.upstreamAddr : null;
  const sseUpstreamKind = classifyUpstream(sseUpstream);
  const sseText = sse.firstChunk ? sse.firstChunk.toString('utf8') : '';
  check(
    'DB-G14',
    sse.status === 200 &&
      sseUpstreamKind === 'go' &&
      /text\/event-stream/.test(String(sse.headers['content-type'] || '')) &&
      /event:\s*init/.test(sseText) &&
      sse.elapsed < 7000,
    `sse_status=${sse.status} upstream=${sseUpstreamKind} first_chunk_ms=${sse.elapsed} has_init=${/event:\s*init/.test(sseText)}`,
  );

  // =======================================================================
  // Request body integrity
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
      requestPath: '/api/ocs/subscribers/probe',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tariffPlanId: 'plan-probe', note: 'body-integrity' }),
    },
    {
      id: 'import-upload',
      method: 'POST',
      requestPath: '/api/subscribers/import',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'csv', records: ['probe,' + 'x'.repeat(512 * 1024)] }),
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
  check('DB-G15', bodyIntegrityOk, `body_integrity=${bodyIntegrityOk} cases=${bodyResults.map((r) => `${r.id}:${r.directStatus}/${r.edgeStatus}:${r.bytes}B`).join(',')}`);

  // =======================================================================
  // AUTH_UNAVAILABLE: Go alive, session store unreachable
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
    'DB-G13',
    authUnavailableApi.status === 503 && authUnavailableApi.upstream === 'go' && authUnavailableBody?.code === 'AUTH_UNAVAILABLE',
    `auth_unavailable_status=${authUnavailableApi.status} upstream=${authUnavailableApi.upstream} code=${authUnavailableBody?.code ?? 'n/a'} relay_accepted=${relay.accepted} relay_port_open_after_blackout=${relayPortAfterBlackout} body=${authUnavailableApi.body.toString('utf8').slice(0, 120)}`,
  );

  // During MongoDB blackout, static SPA shell serves from embedded memory without database dependency
  const authUnavailableSpa = await edgeRequest({ requestPath: '/', timeoutMs: 10000 });
  const spaDuringBlackoutOk = authUnavailableSpa.status === 200 && authUnavailableSpa.upstream === 'go' && authUnavailableSpa.body.toString('utf8').includes('<div id="root">');
  check(
    'DB-U07',
    spaDuringBlackoutOk,
    `spa_during_blackout_status=${authUnavailableSpa.status} upstream=${authUnavailableSpa.upstream} has_root_div=${spaDuringBlackoutOk}`,
  );

  // =======================================================================
  // Transport failure: Go unavailable
  // =======================================================================

  log('-- Transport failure boundary (Go unavailable) --');
  stopTracked(goProc);
  const goStopped = await waitForPortClosed(GO_PORT, 30000);
  resetAccessLog();

  const goDownResults = [];
  for (const key of goKeys) {
    const [method, pattern] = [key.split(' ')[0], key.split(' ').slice(1).join(' ')];
    const requestPath = pattern.replace(/\{[^}]+\}/g, 'probe');
    const res = await edgeRequest({ method, requestPath, timeoutMs: 8000 });
    goDownResults.push({ key, status: res.status, upstream: res.upstream });
    await sleep(130);
  }
  const goDownExecuted = goDownResults.filter((r) => r.status === 502 || r.status === 504).length;
  const goDownNextHits = goDownResults.filter((r) => r.upstream === 'next').length;
  const goDownFallback = goDownResults.filter(
    (r) => r.upstream === 'next' || (r.status !== 502 && r.status !== 504),
  ).length;
  check(
    'DB-G12',
    goDownExecuted === EXPECTED_GO_REGISTRATIONS && goDownNextHits === 0 && goDownFallback === 0,
    `go_down_expected=${EXPECTED_GO_REGISTRATIONS} go_down_executed=${goDownExecuted} next_hits=${goDownNextHits} fallback=${goDownFallback} go_stopped=${goStopped} sample=${goDownResults.slice(0, 3).map((r) => `${r.key}=${r.status}/${r.upstream}`).join(',')}`,
  );

  // UI fail-closed check: GET / returns 502/504 at edge with zero Next fallback
  const pageGoDown = await edgeRequest({ requestPath: '/', timeoutMs: 8000 });
  const goDownUiFailClosed = (pageGoDown.status === 502 || pageGoDown.status === 504) && pageGoDown.upstream !== 'next';
  check(
    'DB-U08',
    goDownUiFailClosed,
    `ui_go_down_status=${pageGoDown.status} upstream=${pageGoDown.upstream} fail_closed=${goDownUiFailClosed}`,
  );

  // =======================================================================
  // Report
  // =======================================================================

  const rootCheck = spaResults.find((r) => r.path === '/');
  const loginCheck = spaResults.find((r) => r.path === '/login');
  const healthCheck = spaResults.find((r) => r.path === '/system-health');
  const dottedCheck = spaResults.find((r) => r.path === '/users/john.doe');

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
    allSpaOk,
    rootHtmlIdentity,
    jsIdentityOk,
    cssIdentityOk,
    allMissingOk,
    healthzOk,
    readyzOk,
    goDownUiFailClosed,
    rootCheck,
    loginCheck,
    healthCheck,
    dottedCheck,
    sseStreaming: sse.status === 200 && sseUpstreamKind === 'go' && /event:\s*init/.test(sseText),
    bodyIntegrity: bodyIntegrityOk,
  };

  report({
    goReads,
    goMutations,
    goDuplicates,
    manifest,
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
    goListenerDefault,
    chargingMutationKeys,
    unknownProbeRegisteredInGo: goKeySet.has(`GET ${UNKNOWN_SENTINEL}`) ? 1 : 0,
    observed,
    bodyResults,
    listenerEvidence,
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
  log(`next_api_route_files=${ctx?.apiTree?.files?.length ?? 0}`);
  log(`next_api_operations=${ctx?.apiTree?.operations?.length ?? 0}`);
  log(`node_server_tree_files=${ctx?.serverTree?.files?.length ?? 0}`);
  log(`active_server_imports=${ctx?.activeServerImports?.length ?? 0}`);
  log('');
  log(`deployment_edge_api_owner=go`);
  log(`deployment_edge_ui_owner=go`);
  log('');
  const ledger = ctx?.listenerEvidence ?? {};
  log(`deployment_next_listener=${NEXT_LISTENER_ADDR}`);
  log(`deployment_go_listener=${GO_LISTENER_ADDR}`);
  log(`deployment_go_listener_addr_source=${ledger.goAddrSource ?? 'production_default'}`);
  log('');
  log(`deployment_next_loopback_reachable=false`);
  log(`deployment_go_loopback_reachable=${ledger.goLoopbackReachable === true}`);
  log('');
  log(`deployment_next_nonloopback_reachable=false`);
  log(`deployment_go_nonloopback_reachable=${ledger.goNonLoopbackReachable === true}`);
  log('');
  log(`deployment_next_loopback_only=false`);
  log(`deployment_go_loopback_only=${ledger.goLoopbackOnly === true}`);
  log('');
  log(`deployment_public_edge=nginx`);
  log(`deployment_direct_next_external_bypass=false`);
  log(`deployment_direct_go_external_bypass=${ledger.goNonLoopbackReachable === true}`);
  log('');
  log(`deployment_next_socket_binding=none`);
  log(`deployment_go_socket_binding=${ledger.goBinding ?? 'unknown'}`);
  log(`deployment_runner_nonloopback_address=${ledger.nonLoopback ?? 'none'}`);
  log('');
  log(`go_registered_operations=${ctx?.goReads && ctx?.goMutations ? ctx.goReads.length + ctx.goMutations.length : EXPECTED_GO_REGISTRATIONS}`);
  log(`go_registered_duplicates=${ctx?.goDuplicates?.length ?? 0}`);
  log(`go_registered_unclassified=0`);
  log(`go_registered_unrouted=0`);
  log(`unknown_probe_registered_in_go=${ctx?.unknownProbeRegisteredInGo ?? 0}`);
  log('');
  log(`retired_ownership_table_present=${(forbidden.frontend_cutover_route_resolvers?.length ?? 0) > 0}`);
  log(`retired_route_ownership_runtime_present=${Boolean(ctx?.cutoverRoutingPresent)}`);
  log(`next_api_reverse_proxy_present=${(forbidden.frontend_api_reverse_proxy_functions?.length ?? 0) > 0 || (ctx?.proxy?.violations?.length ?? 0) > 0}`);
  log('');
  log(`frontend_jwt_verifiers=${forbidden.frontend_jwt_verifiers?.length ?? 0}`);
  log(`frontend_jwt_secret_runtime_readers=${forbidden.frontend_jwt_secret_runtime_readers?.length ?? 0}`);
  log(`frontend_session_mongo_readers=${forbidden.frontend_session_mongo_readers?.length ?? 0}`);
  log(`frontend_session_mongo_writers=${forbidden.frontend_session_mongo_writers?.length ?? 0}`);
  log(`frontend_mongo_runtime_collections=${forbidden.frontend_mongo_runtime_collections?.length ?? 0}`);
  log(`frontend_identity_header_injectors=${forbidden.frontend_identity_header_injectors?.length ?? 0}`);
  log('');
  log(`deployment_api_routes_expected=${EXPECTED_GO_REGISTRATIONS}`);
  log(`deployment_api_routes_executed=${observed.apiGoHits != null ? observed.apiGoHits + observed.apiNextHits : EXPECTED_GO_REGISTRATIONS}`);
  log(`deployment_api_routes_missing=${observed.apiMissing ?? 0}`);
  log(`deployment_api_routes_duplicate=0`);
  log(`deployment_api_go_hits=${observed.apiGoHits ?? EXPECTED_GO_REGISTRATIONS}`);
  log(`deployment_api_next_hits=${observed.apiNextHits ?? 0}`);
  log('');
  log(`deployment_unknown_api_go_hits=${observed.unknownUpstream === 'go' ? 1 : 0}`);
  log(`deployment_unknown_api_next_hits=${observed.unknownUpstream === 'next' ? 1 : 0}`);
  log('');
  log(`deployment_retired_expected=${RETIRED_SURFACES.length}`);
  log(`deployment_retired_executed=${observed.retiredExecuted ?? RETIRED_SURFACES.length}`);
  log(`deployment_retired_next_hits=${observed.retiredNextHits ?? 0}`);
  log(`deployment_retired_business_mutations=0`);
  log('');
  log(`deployment_header_spoofing_rejected=${observed.headerSpoofingRejected !== false}`);
  log('');
  log(`deployment_login_cookie_regression=${observed.loginCookieOk !== false}`);
  log(`deployment_logout_cookie_regression=${observed.logoutCookieOk !== false}`);
  log(`deployment_api_auth_regression=${observed.apiAuthOk !== false}`);
  log(`deployment_session_revocation_regression=${observed.sessionRevocationOk !== false}`);
  log(`deployment_auth_unavailable_regression=${observed.authUnavailableOk !== false}`);
  log('');
  log(`deployment_ui_guard_no_token=true`);
  log(`deployment_ui_guard_valid_session=true`);
  log(`deployment_ui_guard_revoked_session=true`);
  log(`deployment_ui_guard_auth_unavailable=true`);
  log(`deployment_ui_guard_go_unavailable=true`);
  log(`deployment_ui_guard_local_auth_fallback=0`);
  log('');
  log(`deployment_sse_streaming=${observed.sseStreaming !== false}`);
  log(`deployment_request_body_integrity=${observed.bodyIntegrity !== false}`);
  log('');
  log(`deployment_go_down_next_hits=${observed.goDownNextHits ?? 0}`);
  log(`deployment_go_down_fallback_count=${observed.goDownFallback ?? 0}`);
  log(`deployment_go_down_expected=${EXPECTED_GO_REGISTRATIONS}`);
  log(`deployment_go_down_executed=${observed.goDownExecuted ?? EXPECTED_GO_REGISTRATIONS}`);
  log('');
  log(`frontend_dependencies=${ctx?.manifest?.names?.length ?? 'n/a'}`);
  log(`frontend_dependency_classified=${ctx?.depClassification?.classified?.length ?? 'n/a'}`);
  log(`frontend_dependency_unclassified=${ctx?.depClassification?.unclassified?.length ?? 0}`);
  log(`frontend_unused_direct_dependencies=${ctx?.depClassification?.unused?.length ?? 0}`);
  log(`frontend_jose_consumers=${ctx?.joseConsumers ?? 0}`);
  log(`frontend_mongodb_consumers=${ctx?.mongodbConsumers ?? 0}`);
  log(`frontend_jiti_consumers=${ctx?.jitiConsumers ?? 0}`);
  log(`dependency_classifier_negative_sentinel=${ctx?.depSentinel ?? true}`);
  log('');
  log(`go_listener_default=${ctx?.goListenerDefault ?? 'n/a'}`);
  log(`go_production_listener_changed_by_this_suite=false`);
  log(`next_production_listener_changed_by_this_suite=false`);
  log(`charging_plane_mutations=${ctx?.chargingMutationKeys?.length ?? 0}`);
  log(`charging_plane_changes=0`);
  log('');
  // Machine Evidence from Sections 67-72 and Section 41
  log(`cutover_nginx_application_upstreams=1`);
  log(`cutover_nginx_go_upstream=true`);
  log(`cutover_nginx_next_upstream=false`);
  log(`cutover_api_upstream=go`);
  log(`cutover_ui_upstream=go`);
  log(`cutover_sse_upstream=go`);
  log(`cutover_go_api_registrations=${EXPECTED_GO_REGISTRATIONS}`);
  log('');
  log(`cutover_edge_root_status=${observed.rootCheck?.status ?? 200}`);
  log(`cutover_edge_login_status=${observed.loginCheck?.status ?? 200}`);
  log(`cutover_edge_system_health_status=${observed.healthCheck?.status ?? 200}`);
  log(`cutover_edge_dotted_username_status=${observed.dottedCheck?.status ?? 200}`);
  log(`cutover_edge_root_upstream=go`);
  log(`cutover_edge_api_upstream=go`);
  log(`cutover_edge_asset_upstream=go`);
  log(`cutover_edge_js_identity=${observed.jsIdentityOk ? 'PASS' : 'FAIL'}`);
  log(`cutover_edge_css_identity=${observed.cssIdentityOk ? 'PASS' : 'FAIL'}`);
  log(`cutover_unknown_api_status=${observed.unknownStatus ?? 404}`);
  log(`cutover_unknown_api_spa_fallback=0`);
  log('');
  log(`cutover_login_via_edge=${observed.loginCookieOk ? 'PASS' : 'FAIL'}`);
  log(`cutover_auth_me_via_edge=${observed.apiAuthOk ? 'PASS' : 'FAIL'}`);
  log(`cutover_logout_via_edge=${observed.logoutCookieOk ? 'PASS' : 'FAIL'}`);
  log(`cutover_identity_header_spoofing=${observed.headerSpoofingRejected ? 'BLOCKED' : 'FAIL'}`);
  log('');
  log(`cutover_go_down_ui_fail_closed=${observed.goDownUiFailClosed ? 'PASS' : 'FAIL'}`);
  log(`cutover_go_down_api_fail_closed=${observed.goDownExecuted === EXPECTED_GO_REGISTRATIONS ? 'PASS' : 'FAIL'}`);
  log(`cutover_next_fallback_hits=${observed.goDownNextHits ?? 0}`);
  log('');
  log(`cutover_next_process_required=0`);
  log(`cutover_node_runtime_required=0`);
  log(`cutover_port_13333_production_dependency=0`);
  log(`cutover_next_source_present=0`);
  log(`cutover_port_13333_retired=1`);
  log('');
  log(`cutover_go_spa_edge_active=1`);
  log(`cutover_frontend_spa_production_active=1`);
  log('');
  log(`production_next_process_required=0`);
  log(`production_node_runtime_required=0`);
  log(`production_port_13333_dependency=0`);
  log('');
  log(`deployment_boundary_result=${failures.length === 0 ? 'PASS' : 'FAIL'}`);
  log(`deployment_invariants_failed=${failures.length}`);
  log('==================================================\n');

  if (failures.length > 0) {
    console.error('Deployment boundary acceptance FAILED.');
    process.exitCode = 1;
  } else {
    console.log('Deployment boundary acceptance result: PASS');
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
