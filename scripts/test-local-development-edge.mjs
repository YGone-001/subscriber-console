#!/usr/bin/env node
/**
 * Local development edge runtime acceptance suite.
 *
 * Proves the DEVELOPMENT topology is real, not just configured:
 *
 *   Browser/HTTP client
 *        |
 *        v
 *   real Nginx edge
 *      |        |
 *      | /api/* | /*
 *      v        v
 *   real Go   real `next dev` (webpack)
 *
 * Responsibilities:
 *   - dev HTTP transport through the edge: `/`, `/login`, `/_next/*` dev assets;
 *   - dev HMR/WebSocket transport through the edge (`/_next/hmr` upgrade -> 101);
 *   - `local:doctor` FULL_STACK_READY proof against the running full topology;
 *   - `local:doctor` EDGE_REQUIRED negative proof (Next + Go alive, edge down);
 *   - an API ownership sample proving /api traffic never reaches the Next.js dev server.
 *
 * This suite deliberately does NOT use `next build` / `next start`; the production
 * deployment boundary is owned by `scripts/test-deployment-boundary.mjs`.
 *
 * Phase-neutral, permanent. Usage:
 *   node scripts/test-local-development-edge.mjs
 *
 * Environment:
 *   MONGODB_URI             MongoDB used by Go (default mongodb://127.0.0.1:27017)
 *   LOCAL_DEV_EDGE_PORT     Nginx edge port for the sandbox (default 18080)
 *   LOCAL_DEV_NGINX_BIN     Nginx executable (fallback: DEPLOYMENT_NGINX_BIN, nginx)
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';

import { deriveGoRegistrations } from './lib/go-registrations.mjs';
import { classifyDirectNextApi } from './check-local-stack.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FRONTEND = join(ROOT, 'frontend');
const BACKEND = join(ROOT, 'backend');

const EXPECTED_GO_REGISTRATIONS = 84;

// The doctor probes the canonical internal ports, so the development topology under
// test must use exactly those ports. Only the edge port is sandboxed.
const NEXT_PORT = 13333;
const GO_PORT = 18888;
const EDGE_PORT = Number(process.env.LOCAL_DEV_EDGE_PORT || 18080);
const EDGE_URL = `http://127.0.0.1:${EDGE_PORT}`;

const NGINX_BIN = process.env.LOCAL_DEV_NGINX_BIN || process.env.DEPLOYMENT_NGINX_BIN || 'nginx';
const MONGO_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const JWT_SECRET = process.env.JWT_SECRET || 'local-development-edge-acceptance-secret-0123456789';

const RELAY_PORT = 27109;
const UNKNOWN_API = '/api/__routing_unknown_probe__';
const HMR_PATH = '/_next/hmr';

const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

// ---------------------------------------------------------------------------
// Invariant bookkeeping
// ---------------------------------------------------------------------------

const invariants = [];
function check(id, ok, detail) {
  invariants.push({ id, ok: Boolean(ok), detail });
  return Boolean(ok);
}

const log = (message) => console.log(message);

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const TMP_ROOT = join(os.tmpdir(), `local-dev-edge-${process.pid}-${Date.now()}`);
const NGINX_PREFIX = join(TMP_ROOT, 'nginx');
const ACCESS_LOG = join(NGINX_PREFIX, 'logs', 'access.log');
const GO_BIN = join(TMP_ROOT, process.platform === 'win32' ? 'xcloud-api.exe' : 'xcloud-api');

const nginxPath = (p) => p.replaceAll('\\', '/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const runSync = (command, args, options = {}) => spawnSync(command, args, { encoding: 'utf8', ...options });
const readIfExists = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);

/** Send one HTTP request and collect status/headers/body. Redirects are not followed. */
function httpRequest({ port, host = '127.0.0.1', method = 'GET', requestPath = '/', headers = {}, body = null, timeoutMs = 20000 }) {
  return new Promise((resolvePromise) => {
    const payload = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(body);
    const finalHeaders = { ...headers };
    if (payload) finalHeaders['content-length'] = String(payload.length);
    finalHeaders.connection = 'close';
    const req = http.request({ host, port, method, path: requestPath, headers: finalHeaders }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolvePromise({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', (err) => resolvePromise({ status: 0, headers: {}, body: Buffer.alloc(0), error: err.message }));
    req.setTimeout(timeoutMs, () => req.destroy(new Error('client-timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

/** Follow up to `maxHops` same-origin redirects, mirroring a browser document load. */
async function httpRequestFollow({ port, requestPath, maxHops = 5, timeoutMs = 20000 }) {
  let current = requestPath;
  const hops = [];
  for (let i = 0; i <= maxHops; i += 1) {
    // eslint-disable-next-line no-await-in-loop -- sequential by definition
    const res = await httpRequest({ port, requestPath: current, timeoutMs });
    hops.push({ path: current, status: res.status });
    const location = res.headers.location;
    if (res.status >= 300 && res.status < 400 && location) {
      current = new URL(location, `http://127.0.0.1:${port}`).pathname + new URL(location, `http://127.0.0.1:${port}`).search;
      continue;
    }
    return { ...res, hops, finalPath: current };
  }
  return { status: 0, headers: {}, body: Buffer.alloc(0), hops, finalPath: current };
}

/** Wait until a TCP port accepts connections. */
async function waitForPort(port, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop -- polling by definition
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

async function waitForPortClosed(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop -- polling by definition
    if (!(await isPortOpen(port))) return true;
    await sleep(200);
  }
  return false;
}

/**
 * Poll an HTTP endpoint until it answers with the wanted status. The development server
 * compiles routes on first demand, so a single attempt may legitimately take tens of
 * seconds; every attempt gets a generous timeout and the loop retries until the deadline.
 */
async function waitForHttp({ port, requestPath, status, timeoutMs = 240000, attemptTimeoutMs = 45000 }) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop -- polling by definition
    const res = await httpRequest({ port, requestPath, timeoutMs: attemptTimeoutMs });
    last = res.status;
    if (res.status === status) return { ok: true, status: res.status, res };
    await sleep(500);
  }
  return { ok: false, status: last };
}

// ---------------------------------------------------------------------------
// Process lifecycle
// ---------------------------------------------------------------------------

const processes = [];
const trackProcess = (child, label) => {
  processes.push({ child, label });
  return child;
};

function captureOutput(child, buffer) {
  const sink = (chunk) => {
    buffer.push(chunk.toString());
    if (buffer.length > 120) buffer.shift();
  };
  if (child.stdout) child.stdout.on('data', sink);
  if (child.stderr) child.stderr.on('data', sink);
}

const outputTail = (buffer) => buffer.join('').trim().split('\n').slice(-4).join(' / ');

function stopTracked(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    runSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    child.kill('SIGTERM');
  } catch {
    /* best effort */
  }
}

let activeRelay = null;
let nginxConfPath = null;

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

/** Stop only the Nginx edge, keeping Go and Next alive for the negative scenario. */
function stopNginx() {
  if (!nginxConfPath) return;
  runSync(NGINX_BIN, ['-p', nginxPath(NGINX_PREFIX), '-c', nginxPath(nginxConfPath), '-s', 'stop'], { encoding: 'utf8' });
}

// ---------------------------------------------------------------------------
// MongoDB relay (keeps Go's startup contract intact while the topology runs)
// ---------------------------------------------------------------------------

class MongoRelay {
  constructor(targetPort, listenPort) {
    this.targetPort = targetPort;
    this.listenPort = listenPort;
    this.sockets = new Set();
    this.server = null;
  }

  async start() {
    this.server = net.createServer((client) => {
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
// Edge access-log attribution
// ---------------------------------------------------------------------------

let markerSeq = 0;
const nextMarker = () => `devedge-${(markerSeq += 1)}`;

const resetAccessLog = () => writeFileSync(ACCESS_LOG, '');
const readAccessLog = () => (existsSync(ACCESS_LOG) ? readFileSync(ACCESS_LOG, 'utf8') : '');

async function logEntryForMarker(marker, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  const needle = `${marker}|`;
  while (Date.now() < deadline) {
    for (const line of readAccessLog().split('\n')) {
      if (!line.startsWith(needle)) continue;
      const parts = line.split('|');
      return { upstreamAddr: parts[1] || '', upstreamStatus: parts[2] || '-', status: Number(parts[3] || 0) };
    }
    await sleep(50);
  }
  return null;
}

const classifyUpstream = (upstreamAddr) => {
  if (!upstreamAddr) return 'edge';
  if (upstreamAddr.includes(`127.0.0.1:${GO_PORT}`)) return 'go';
  if (upstreamAddr.includes(`127.0.0.1:${NEXT_PORT}`)) return 'next';
  return 'other';
};

/** Send one request through the real edge and attribute it via the edge access log. */
async function edgeRequest({ method = 'GET', requestPath = '/', headers = {}, body = null, timeoutMs = 20000, follow = false }) {
  const marker = nextMarker();
  const res = follow
    ? await httpRequestFollow({ port: EDGE_PORT, requestPath, timeoutMs })
    : await httpRequest({ port: EDGE_PORT, method, requestPath, headers: { ...headers, 'x-local-dev-marker': marker }, body, timeoutMs });
  const entry = follow ? null : await logEntryForMarker(marker);
  const upstreamAddr = entry ? entry.upstreamAddr : null;
  return { ...res, marker, upstreamAddr, upstream: follow ? 'next' : classifyUpstream(upstreamAddr) };
}

// ---------------------------------------------------------------------------
// Raw WebSocket upgrade client (RFC 6455 handshake over the edge)
// ---------------------------------------------------------------------------

/**
 * Perform a real WebSocket upgrade handshake and verify the server's
 * `Sec-WebSocket-Accept` token. A matching token proves the real Next.js development
 * HMR server completed the handshake (not an intermediary that merely echoed a status).
 */
function websocketUpgrade({ port, requestPath, hostHeader, origin, timeoutMs = 15000 }) {
  return new Promise((resolvePromise) => {
    const key = crypto.randomBytes(16).toString('base64');
    const expectedAccept = crypto
      .createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    const headers = {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': key,
      Host: hostHeader,
    };
    if (origin) headers.Origin = origin;

    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };

    const req = http.request({ host: '127.0.0.1', port, path: requestPath, headers });
    req.on('upgrade', (res, socket) => {
      const accept = Array.isArray(res.headers['sec-websocket-accept'])
        ? res.headers['sec-websocket-accept'][0]
        : res.headers['sec-websocket-accept'];
      const result = { status: res.statusCode, accept, expectedAccept, upgrade: res.headers.upgrade || null };
      // Prove bidirectional frame transport with an RFC 6455 ping, then close.
      const frame = Buffer.concat([Buffer.from([0x89, 0x80]), crypto.randomBytes(4)]);
      let pong = null;
      socket.once('data', (chunk) => {
        if (chunk.length >= 2 && (chunk[0] & 0x0f) === 0x0a) pong = true;
        socket.destroy();
        done({ ...result, pong });
      });
      socket.once('error', () => {
        socket.destroy();
        done({ ...result, pong });
      });
      try {
        socket.write(frame);
      } catch {
        socket.destroy();
        done({ ...result, pong: null });
      }
      req.setTimeout(0);
    });
    req.on('response', (res) => {
      res.resume();
      done({ status: res.statusCode, accept: null, expectedAccept, upgrade: null });
    });
    req.on('error', (err) => done({ status: 0, accept: null, expectedAccept, error: err.message }));
    req.setTimeout(timeoutMs, () => req.destroy(new Error('upgrade-timeout')));
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Doctor invocation
// ---------------------------------------------------------------------------

// The doctor is invoked through its published command, `npm run local:doctor`, so the
// runtime proof exercises exactly the command an operator runs (LDE-02 asserts the npm
// script still maps to `node scripts/check-local-stack.mjs`).
const NPM_BIN = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function runDoctor(env = {}) {
  const res = runSync(NPM_BIN, ['run', '--silent', 'local:doctor'], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    env: { ...process.env, XCLOUD_EDGE_URL: EDGE_URL, ...env },
  });
  const stdout = res.stdout || '';
  const key = (name) => {
    const m = stdout.match(new RegExp(`^${name}=(.*)$`, 'm'));
    return m ? m[1].trim() : null;
  };
  return {
    exit: res.status,
    stdout,
    stderr: res.stderr || '',
    next: key('local_stack_next'),
    go: key('local_stack_go'),
    edge: key('local_stack_edge'),
    edgeApi: key('local_stack_edge_api'),
    directNextApi: key('local_stack_direct_next_api'),
    result: key('local_stack_result'),
  };
}

// ---------------------------------------------------------------------------
// Static source scanners (ownership surface)
// ---------------------------------------------------------------------------

const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function walk(dir, filter, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, filter, out);
    else if (filter(full)) out.push(full);
  }
  return out;
}

function countNextApiRoutes() {
  return walk(join(FRONTEND, 'src', 'app', 'api'), (p) => /route\.(ts|js)$/.test(p)).length;
}

function countNextApiRewrites() {
  const config = readIfExists(join(FRONTEND, 'next.config.ts'));
  if (!config) return 0;
  const code = stripComments(config);
  const rewrites = (code.match(/rewrites\s*\(/g) || []).length;
  return rewrites > 0 && /\/api/.test(code) ? rewrites : 0;
}

const REVERSE_PROXY_RES = [
  /\bforwardToGo\s*\(/,
  /\bproxyToBackend\b/,
  /\bNextResponse\.rewrite\s*\(/,
  /\bcreateProxyHandler\s*\(/,
];

function countNextApiReverseProxy() {
  const sources = walk(join(FRONTEND, 'src'), (p) => CODE_EXT.test(p)).map((p) => stripComments(readIfExists(p) || ''));
  let hits = 0;
  for (const code of sources) {
    for (const re of REVERSE_PROXY_RES) if (re.test(code)) hits += 1;
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const machine = {
  local_dev_edge_ui_ready: 'false',
  local_dev_edge_api_owner: 'unknown',
  local_dev_edge_next_api_hits: 'unknown',
  local_dev_hmr_transport: 'websocket',
  local_dev_hmr_upgrade: 'false',
  local_dev_doctor_ready_result: 'unknown',
  local_dev_doctor_ready_exit: 'unknown',
  local_dev_doctor_missing_edge_result: 'unknown',
  local_dev_doctor_missing_edge_exit_nonzero: 'false',
  local_dev_go_routes: '0',
  local_dev_next_api_routes: '0',
  local_dev_next_api_rewrites: '0',
  local_dev_next_api_reverse_proxy: '0',
  local_dev_edge_failures: 'unknown',
  local_dev_edge_result: 'FAIL',
};

function report() {
  const failures = invariants.filter((i) => !i.ok);
  machine.local_dev_edge_failures = String(failures.length);
  machine.local_dev_edge_result = failures.length === 0 ? 'PASS' : 'FAIL';
  console.log('\n==================================================');
  for (const [k, v] of Object.entries(machine)) console.log(`${k}=${v}`);
  console.log('==================================================\n');
}

function printInvariants() {
  if (invariants.length === 0) return;
  console.log('Invariants:');
  for (const inv of invariants) console.log(`  ${inv.ok ? 'PASS' : 'FAIL'}  ${inv.id} ${inv.detail}`);
}

async function main() {
  log('== Local development edge runtime acceptance ==\n');

  // -- Static ownership surface -------------------------------------------
  const { keys: goKeys, duplicates: goDuplicates } = deriveGoRegistrations();
  const nextApiRoutes = countNextApiRoutes();
  const nextApiRewrites = countNextApiRewrites();
  const nextApiReverseProxy = countNextApiReverseProxy();
  machine.local_dev_go_routes = String(goKeys.length);
  machine.local_dev_next_api_routes = String(nextApiRoutes);
  machine.local_dev_next_api_rewrites = String(nextApiRewrites);
  machine.local_dev_next_api_reverse_proxy = String(nextApiReverseProxy);

  check('LDE-00', goKeys.length === EXPECTED_GO_REGISTRATIONS && goDuplicates.length === 0,
    `go_registrations=${goKeys.length} duplicates=${goDuplicates.length}`);
  check('LDE-01', nextApiRoutes === 0 && nextApiRewrites === 0 && nextApiReverseProxy === 0,
    `next_api_routes=${nextApiRoutes} next_api_rewrites=${nextApiRewrites} next_api_reverse_proxy=${nextApiReverseProxy}`);

  // The doctor is `node scripts/check-local-stack.mjs`; invoking node directly below is
  // provably the same command as `npm run local:doctor`.
  const rootPkg = JSON.parse(readIfExists(join(ROOT, 'package.json')) || '{"scripts":{}}');
  const doctorScript = rootPkg.scripts?.['local:doctor'];
  check('LDE-02', doctorScript === 'node scripts/check-local-stack.mjs',
    `local_doctor_npm_script=${doctorScript}`);

  // -- Direct-Next API interpretation sentinels ---------------------------
  const sentinelHtml404 = classifyDirectNextApi({ reachable: true, status: 404, contentType: 'text/html; charset=utf-8' });
  const sentinelJson401 = classifyDirectNextApi({ reachable: true, status: 401, contentType: 'application/json' });
  const sentinelJson200 = classifyDirectNextApi({ reachable: true, status: 200, contentType: 'application/json; charset=utf-8' });
  const sentinelDown = classifyDirectNextApi({ reachable: false });
  check(
    'LDE-03',
    sentinelHtml404 === 'UNSUPPORTED_BY_DESIGN' && sentinelJson401 === 'ARCHITECTURE_VIOLATION' &&
      sentinelJson200 === 'ARCHITECTURE_VIOLATION' && sentinelDown === 'UNREACHABLE',
    `sentinel_html404=${sentinelHtml404} sentinel_json401=${sentinelJson401} sentinel_json200=${sentinelJson200} sentinel_down=${sentinelDown}`,
  );

  if (invariants.some((i) => !i.ok)) {
    log('\nStatic ownership assertions failed; aborting before runtime bring-up.\n');
    printInvariants();
    report();
    return;
  }

  // -- Runtime bring-up ----------------------------------------------------
  mkdirSync(TMP_ROOT, { recursive: true });
  mkdirSync(join(NGINX_PREFIX, 'logs'), { recursive: true });
  mkdirSync(join(NGINX_PREFIX, 'temp'), { recursive: true });
  mkdirSync(join(NGINX_PREFIX, 'conf'), { recursive: true });
  writeFileSync(ACCESS_LOG, '');

  const mongoPort = Number((MONGO_URI.match(/:(\d+)/) || [])[1] || 27017);
  const mongoReachable = await waitForPort(mongoPort, 5000);
  check('LDE-R00', mongoReachable, `mongo_reachable=${mongoReachable} port=${mongoPort}`);
  if (!mongoReachable) {
    printInvariants();
    report();
    return;
  }

  // A listener the suite did not start would answer as if it were the component under
  // test. Refuse to measure a foreign process.
  const occupied = [];
  for (const [id, port, role] of [['LDE-R00A', GO_PORT, 'go'], ['LDE-R00B', NEXT_PORT, 'next'], ['LDE-R00C', EDGE_PORT, 'edge'], ['LDE-R00D', RELAY_PORT, 'mongo_relay']]) {
    // eslint-disable-next-line no-await-in-loop -- sequential probes keep the diagnostic stable
    const busy = await isPortOpen(port);
    check(id, !busy, `port_free_${role}=${!busy} port=${port}`);
    if (busy) occupied.push(`${role}:${port}`);
  }
  if (occupied.length > 0) {
    log(`\nRefusing to run: these ports are already held by another process -> ${occupied.join(', ')}`);
    printInvariants();
    report();
    return;
  }

  log('-- Runtime bring-up --');
  const relay = new MongoRelay(mongoPort, RELAY_PORT);
  activeRelay = relay;
  await relay.start();
  check('LDE-R01', await waitForPort(RELAY_PORT, 5000), `mongo_relay_listening=${RELAY_PORT}`);

  const goBuild = runSync('go', ['build', '-o', GO_BIN, './cmd/server'], { cwd: BACKEND, stdio: 'inherit' });
  check('LDE-R02', goBuild.status === 0 && existsSync(GO_BIN), `go_build_status=${goBuild.status}`);
  if (goBuild.status !== 0) {
    printInvariants();
    report();
    await stopAll();
    return;
  }

  // Go runs through its production startup contract: HTTP_ADDR is not injected, so the
  // production loopback default (127.0.0.1:18888) is what the edge actually reaches.
  const goEnv = { ...process.env, MONGODB_URI: `mongodb://127.0.0.1:${RELAY_PORT}/?serverSelectionTimeoutMS=2000`, JWT_SECRET };
  delete goEnv.HTTP_ADDR;
  const goOutput = [];
  const goProc = trackProcess(spawn(GO_BIN, [], { cwd: BACKEND, env: goEnv, stdio: ['ignore', 'pipe', 'pipe'] }), 'go');
  captureOutput(goProc, goOutput);
  const goUp = await waitForPort(GO_PORT, 60000);
  check('LDE-R03', goUp && goProc.exitCode === null,
    `go_listening=${goUp} go_process_alive=${goProc.exitCode === null} port=${GO_PORT} output=${outputTail(goOutput)}`);
  if (!goUp) {
    printInvariants();
    report();
    await stopAll();
    return;
  }

  // Next.js development server, exactly the documented `npm run dev` command.
  const nextBin = join(FRONTEND, 'node_modules', 'next', 'dist', 'bin', 'next');
  const nextOutput = [];
  const nextProc = trackProcess(
    spawn(process.execPath, [nextBin, 'dev', '--webpack', '-H', '127.0.0.1', '-p', String(NEXT_PORT)], {
      cwd: FRONTEND,
      env: { ...process.env, GO_BACKEND_URL: `http://127.0.0.1:${GO_PORT}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
    'next-dev',
  );
  captureOutput(nextProc, nextOutput);
  const nextUp = await waitForPort(NEXT_PORT, 180000);
  check('LDE-R04', nextUp, `next_dev_listening=${nextUp} port=${NEXT_PORT} output=${outputTail(nextOutput)}`);
  if (!nextUp) {
    printInvariants();
    report();
    await stopAll();
    return;
  }

  // Real Nginx with the repository edge configuration.
  const repoConf = readFileSync(join(ROOT, 'deploy', 'nginx', 'xcloud.conf'), 'utf8');
  const effectiveConf = [
    'worker_processes 1;',
    `error_log ${nginxPath(join(NGINX_PREFIX, 'logs', 'error.log'))} warn;`,
    `pid ${nginxPath(join(NGINX_PREFIX, 'logs', 'nginx.pid'))};`,
    'events { worker_connections 1024; }',
    'http {',
    "  log_format localdev '$http_x_local_dev_marker|$upstream_addr|$upstream_status|$status|$request_method|$request_uri|$content_type';",
    `  access_log ${nginxPath(ACCESS_LOG)} localdev;`,
    `  client_body_temp_path ${nginxPath(join(NGINX_PREFIX, 'temp', 'client_body'))};`,
    `  proxy_temp_path ${nginxPath(join(NGINX_PREFIX, 'temp', 'proxy'))};`,
    "  include " + nginxPath(join(NGINX_PREFIX, 'conf', 'mime.types')) + ';',
    repoConf.replace(/^    listen 80;/m, `    listen ${EDGE_PORT};`),
    '}',
  ].join('\n');
  writeFileSync(join(NGINX_PREFIX, 'conf', 'mime.types'), 'types { text/html html; text/css css; application/javascript js; }\n');
  nginxConfPath = join(NGINX_PREFIX, 'conf', 'local-development-edge.conf');
  writeFileSync(nginxConfPath, effectiveConf);

  const nginxTest = runSync(NGINX_BIN, ['-t', '-p', nginxPath(NGINX_PREFIX), '-c', nginxPath(nginxConfPath)]);
  const nginxDetail = (nginxTest.stderr || nginxTest.stdout || '').trim().split('\n').slice(-1)[0] || '';
  check('LDE-R05', nginxTest.status === 0,
    `nginx_syntax=${nginxTest.status === 0} nginx_bin=${NGINX_BIN} spawn_error=${nginxTest.error ? nginxTest.error.message : 'none'} ${nginxDetail}`);
  if (nginxTest.status !== 0) {
    log(nginxTest.stderr || nginxTest.stdout || nginxTest.error?.message || '');
    printInvariants();
    report();
    await stopAll();
    return;
  }

  const nginxProc = trackProcess(spawn(NGINX_BIN, ['-p', nginxPath(NGINX_PREFIX), '-c', nginxPath(nginxConfPath)], { stdio: 'ignore', detached: true }), 'nginx');
  nginxProc.unref();
  const edgeUp = await waitForPort(EDGE_PORT, 30000);
  check('LDE-R06', edgeUp, `edge_listening=${edgeUp} port=${EDGE_PORT}`);
  if (!edgeUp) {
    printInvariants();
    report();
    await stopAll();
    return;
  }

  log('-- Development HTTP transport through the edge --');

  // Warm the dev compiler through the edge (first hit compiles on demand).
  const loginWarm = await waitForHttp({ port: EDGE_PORT, requestPath: '/login', status: 200, timeoutMs: 180000 });
  check('LDE-D01', loginWarm.ok, `dev_edge_login_status=${loginWarm.status}`);

  const rootFollow = await edgeRequest({ requestPath: '/', follow: true, timeoutMs: 30000 });
  check('LDE-D02', rootFollow.status === 200,
    `dev_edge_ui_status=${rootFollow.status} redirect_chain=${rootFollow.hops.map((h) => h.status).join('->')}`);

  // Development assets must be served by Next dev through the same edge.
  const loginHtml = (await httpRequest({ port: EDGE_PORT, requestPath: '/login', timeoutMs: 30000 })).body.toString('utf8');
  // Attribute values are HTML-escaped in the document (a query string arrives as
  // `&amp;`), so decode entities exactly as a browser does before re-requesting them.
  const decodeEntities = (value) => value.replace(/&amp;/g, '&').replace(/&#x2F;/gi, '/');
  const assetPaths = [...new Set([...loginHtml.matchAll(/(?:src|href)="(\/_next\/[^"]+)"/g)].map((m) => decodeEntities(m[1])))].slice(0, 8);
  const assetResults = [];
  for (const assetPath of assetPaths) {
    // eslint-disable-next-line no-await-in-loop -- sequential keeps the dev compiler calm
    const res = await httpRequest({ port: EDGE_PORT, requestPath: assetPath, timeoutMs: 30000 });
    assetResults.push({ path: assetPath, status: res.status });
  }
  const failedAssets = assetResults.filter((a) => a.status !== 200);
  const assetsOk = assetPaths.length > 0 && failedAssets.length === 0;
  check('LDE-D03', assetsOk,
    `dev_asset_count=${assetPaths.length} dev_asset_requests_success=${assetsOk} ` +
    `detail=${assetResults.map((a) => `${a.path}:${a.status}`).join(' ')}`);

  machine.local_dev_edge_ui_ready = String(loginWarm.ok && rootFollow.status === 200 && assetsOk);

  log('-- API ownership through the development edge --');

  resetAccessLog();
  const apiProbes = [
    { method: 'GET', requestPath: '/api' },
    { method: 'GET', requestPath: '/api/auth/me' },
    { method: 'GET', requestPath: UNKNOWN_API },
    { method: 'POST', requestPath: '/api/auth/login', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'localdev_probe', password: 'not-a-real-password' }) },
  ];
  const apiResults = [];
  for (const probe of apiProbes) {
    // eslint-disable-next-line no-await-in-loop -- edge rate limit needs spacing
    const res = await edgeRequest(probe);
    apiResults.push({ requestPath: probe.requestPath, status: res.status, upstream: res.upstream });
    await sleep(150);
  }
  const nextApiHits = apiResults.filter((r) => r.upstream === 'next').length;
  const goApiHits = apiResults.filter((r) => r.upstream === 'go').length;
  machine.local_dev_edge_next_api_hits = String(nextApiHits);
  machine.local_dev_edge_api_owner = nextApiHits === 0 && goApiHits === apiResults.length ? 'go' : 'unknown';
  check('LDE-D04', apiResults.length === goApiHits && nextApiHits === 0,
    `api_probes=${apiResults.length} go_hits=${goApiHits} next_hits=${nextApiHits} detail=${apiResults.map((r) => `${r.requestPath}:${r.status}:${r.upstream}`).join(' ')}`);

  log('-- Development HMR / WebSocket transport through the edge --');

  const hmr = await websocketUpgrade({
    port: EDGE_PORT,
    requestPath: `${HMR_PATH}?id=localdev-check`,
    hostHeader: `localhost:${EDGE_PORT}`,
    origin: 'http://localhost',
    timeoutMs: 20000,
  });
  const hmrUpgraded = hmr.status === 101 && hmr.accept === hmr.expectedAccept;
  machine.local_dev_hmr_upgrade = String(hmrUpgraded);
  check('LDE-D05', hmrUpgraded,
    `hmr_path=${HMR_PATH} hmr_status=${hmr.status} hmr_upgrade_header=${hmr.upgrade} accept_valid=${hmr.accept === hmr.expectedAccept} pong=${hmr.pong === true}`);

  log('-- local:doctor FULL_STACK_READY proof --');

  const doctorReady = runDoctor();
  machine.local_dev_doctor_ready_result = doctorReady.result || 'unknown';
  machine.local_dev_doctor_ready_exit = String(doctorReady.exit);
  check('LDE-D06',
    doctorReady.next === 'READY' && doctorReady.go === 'READY' && doctorReady.edge === 'READY' &&
      doctorReady.edgeApi === 'READY' && doctorReady.result === 'FULL_STACK_READY' && doctorReady.exit === 0,
    `next=${doctorReady.next} go=${doctorReady.go} edge=${doctorReady.edge} edge_api=${doctorReady.edgeApi} result=${doctorReady.result} exit=${doctorReady.exit} direct_next_api=${doctorReady.directNextApi}`);

  log('-- local:doctor EDGE_REQUIRED negative proof --');

  stopNginx();
  const edgeClosed = await waitForPortClosed(EDGE_PORT, 20000);
  check('LDE-D07', edgeClosed, `edge_port_closed_after_stop=${edgeClosed} port=${EDGE_PORT}`);

  const doctorMissingEdge = runDoctor();
  const missingEdgeNonZero = typeof doctorMissingEdge.exit === 'number' && doctorMissingEdge.exit !== 0;
  machine.local_dev_doctor_missing_edge_result = doctorMissingEdge.result || 'unknown';
  machine.local_dev_doctor_missing_edge_exit_nonzero = String(missingEdgeNonZero);
  check('LDE-D08',
    doctorMissingEdge.next === 'READY' && doctorMissingEdge.go === 'READY' &&
      doctorMissingEdge.edge === 'UNAVAILABLE' && doctorMissingEdge.edgeApi === 'UNAVAILABLE' &&
      doctorMissingEdge.result === 'EDGE_REQUIRED' && missingEdgeNonZero,
    `next=${doctorMissingEdge.next} go=${doctorMissingEdge.go} edge=${doctorMissingEdge.edge} edge_api=${doctorMissingEdge.edgeApi} result=${doctorMissingEdge.result} exit=${doctorMissingEdge.exit}`);

  printInvariants();
  report();
}

main()
  .catch((err) => {
    console.error(`Local development edge suite failed: ${err.stack || err.message}`);
    check('LDE-FATAL', false, `unexpected_error=${err.message}`);
    printInvariants();
    report();
  })
  .finally(async () => {
    stopNginx();
    await stopAll();
    const failures = invariants.filter((i) => !i.ok);
    process.exit(failures.length === 0 ? 0 : 1);
  });
