#!/usr/bin/env node
/**
 * Shared local runtime inspection library.
 *
 * One authoritative implementation of the local topology primitives so that
 * `local:preflight`, `local:dev`, `local:stop`, `local:status` and the doctor do not
 * grow divergent detection logic:
 *
 *   - canonical port constants
 *   - HTTP reachability probes
 *   - listener discovery (Windows / Linux)
 *   - process identity inspection
 *   - port ownership classification
 *   - the ignored runtime PID registry and its ownership verification
 *   - topology classification
 *
 * Read-only primitives never terminate anything. The single termination entry point
 * is `terminateVerifiedProcess`, which refuses to act unless ownership is proven.
 *
 * Canonical component ports are deliberately NOT environment-overridable: a
 * contaminated canonical port must be diagnosed, never bypassed.
 */

import http from 'node:http';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Canonical constants
// ---------------------------------------------------------------------------

/** Canonical component ports. Not overridable: contamination is diagnosed. */
export const CANONICAL_PORTS = Object.freeze({
  edge: 80,
  next: 13333,
  go: 18888,
  mongo: 27017,
});

/** Inspection order and human-readable role labels. */
export const PORT_ROLES = Object.freeze(['edge', 'next', 'go', 'mongo']);

export const PORT_ROLE_LABELS = Object.freeze({
  edge: 'Nginx edge',
  next: 'Next.js internal listener',
  go: 'Go internal listener',
  mongo: 'MongoDB',
});

/** Internal ports that must be project-managed, not merely occupied. */
export const INTERNAL_PORT_ROLES = Object.freeze(['next', 'go']);

export const LISTENER_STATES = Object.freeze({
  FREE: 'FREE',
  EXPECTED_SERVICE: 'EXPECTED_SERVICE',
  FOREIGN_LISTENER: 'FOREIGN_LISTENER',
  UNKNOWN_LISTENER: 'UNKNOWN_LISTENER',
  PERMISSION_LIMITED: 'PERMISSION_LIMITED',
});

export const PORT_OUTCOMES = Object.freeze({
  PORT_FREE: 'PORT_FREE',
  EXPECTED_SERVICE: 'EXPECTED_SERVICE',
  PROJECT_MANAGED_PROCESS: 'PROJECT_MANAGED_PROCESS',
  FOREIGN_PROCESS: 'FOREIGN_PROCESS',
  STALE_PROJECT_PROCESS: 'STALE_PROJECT_PROCESS',
  INSUFFICIENT_PERMISSION: 'INSUFFICIENT_PERMISSION',
});

export const TOPOLOGY_STATES = Object.freeze({
  FULL_STACK_READY: 'FULL_STACK_READY',
  EDGE_REQUIRED: 'EDGE_REQUIRED',
  GO_DOWN: 'GO_DOWN',
  NEXT_DOWN: 'NEXT_DOWN',
  EDGE_API_MISROUTED: 'EDGE_API_MISROUTED',
  EDGE_UI_MISROUTED: 'EDGE_UI_MISROUTED',
  ARCHITECTURE_VIOLATION: 'ARCHITECTURE_VIOLATION',
  PORT_CONTAMINATION: 'PORT_CONTAMINATION',
});

export const DEFAULT_EDGE_URL = 'http://127.0.0.1';

export const GO_HEALTHZ = `http://127.0.0.1:${CANONICAL_PORTS.go}/healthz`;
export const GO_READYZ = `http://127.0.0.1:${CANONICAL_PORTS.go}/readyz`;
export const NEXT_ROOT = `http://127.0.0.1:${CANONICAL_PORTS.next}/`;
export const NEXT_DIRECT_API = `http://127.0.0.1:${CANONICAL_PORTS.next}/api/auth/me`;

export const PROBE_TIMEOUT_MS = 4000;
export const MAX_BODY_BYTES = 8192;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function resolveEdgeUrl(env = process.env) {
  return (env.XCLOUD_EDGE_URL || DEFAULT_EDGE_URL).replace(/\/+$/, '');
}

export function edgePortFromUrl(edgeUrl) {
  try {
    const parsed = new URL(edgeUrl);
    if (parsed.port) return Number(parsed.port);
    return parsed.protocol === 'https:' ? 443 : 80;
  } catch {
    return CANONICAL_PORTS.edge;
  }
}

/** Normalize a filesystem path or command line fragment for comparison. */
export function normalizePath(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
}

function asArray(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

// ---------------------------------------------------------------------------
// HTTP / TCP probes
// ---------------------------------------------------------------------------

/**
 * Probe a URL. Resolves with a status when the server answers (any status code is a
 * reachability success) and with a transport error otherwise. No credentials, no
 * cookies, no request body: this is a topology check, not an authentication check.
 */
export function probeHttp(url, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let req;
    try {
      req = http.get(url, { timeout: timeoutMs }, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          if (size >= MAX_BODY_BYTES) return;
          size += chunk.length;
          chunks.push(chunk);
        });
        res.on('end', () => done({
          reachable: true,
          status: res.statusCode,
          contentType: String(res.headers['content-type'] || ''),
          body: Buffer.concat(chunks).subarray(0, MAX_BODY_BYTES).toString('utf8'),
        }));
        res.on('error', (err) => done({ reachable: false, error: err.message }));
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', (err) => done({ reachable: false, error: err.message }));
    } catch (err) {
      done({ reachable: false, error: err.message });
    }
  });
}

/**
 * Interpret a direct `GET http://127.0.0.1:13333/api/auth/me` probe.
 *
 * The Next.js listener owns no /api route, so the only acceptable answer is a
 * non-JSON framework page (typically a 404 HTML document). A JSON answer on an
 * authentication status code (200 or 401) means the Next.js listener is behaving as
 * the authentication API authority: that is an architecture violation, never a
 * topology quirk.
 */
export function classifyDirectNextApi(result) {
  if (!result || !result.reachable) return 'UNREACHABLE';
  const contentType = String(result.contentType || '');
  const isJson = /application\/json/i.test(contentType);
  const isAuthBoundaryStatus = result.status === 401 || result.status === 200;
  if (isJson && isAuthBoundaryStatus) return 'ARCHITECTURE_VIOLATION';
  return 'UNSUPPORTED_BY_DESIGN';
}

/** Plain TCP reachability check (no application protocol). */
export function isPortOpen(port, host = '127.0.0.1', timeoutMs = 1200) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    try {
      socket.connect(port, host);
    } catch {
      done(false);
    }
  });
}

export async function waitForPort(port, { host = '127.0.0.1', timeoutMs = 60000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortOpen(port, host)) return true;
    await sleep(intervalMs);
  }
  return false;
}

export async function waitForHttpReady(url, { timeoutMs = 90000, intervalMs = 700, accept = (r) => r.reachable && r.status < 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await probeHttp(url);
    if (accept(last)) return last;
    await sleep(intervalMs);
  }
  return last;
}

// ---------------------------------------------------------------------------
// Listener / process discovery
// ---------------------------------------------------------------------------

let listenerCache = null;

/**
 * Enumerate TCP listening sockets with best-effort owner metadata.
 * Returns `[{ address, port, processId, name, executable, commandLine, startTime }]`.
 * Never throws: a discovery failure yields an empty list plus a `discoveryError`.
 */
export async function listListeners({ refresh = false } = {}) {
  if (listenerCache && !refresh) return listenerCache;
  let records = [];
  let discoveryError = null;
  try {
    if (process.platform === 'win32') records = listListenersWindows();
    else records = listListenersLinux();
  } catch (err) {
    discoveryError = err.message;
  }
  listenerCache = records;
  listenerCache.discoveryError = discoveryError;
  return listenerCache;
}

function listListenersWindows() {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$rows = @()
$conns = Get-NetTCPConnection -State Listen
if (-not $conns) { $conns = @() }
$procMap = @{}
foreach ($p in (Get-CimInstance Win32_Process)) { $procMap[[int]$p.ProcessId] = $p }
foreach ($c in $conns) {
  $opid = [int]$c.OwningProcess
  $p = $procMap[$opid]
  $nm = $null; $exe = $null; $cmd = $null; $st = $null
  if ($p) {
    $nm = [string]$p.Name
    $exe = [string]$p.ExecutablePath
    $cmd = [string]$p.CommandLine
    if ($p.CreationDate) { $st = $p.CreationDate.ToUniversalTime().ToString('o') }
  }
  $rows += [pscustomobject]@{
    address = [string]$c.LocalAddress
    port = [int]$c.LocalPort
    processId = $opid
    name = $nm
    executable = $exe
    commandLine = $cmd
    startTime = $st
  }
}
ConvertTo-Json -InputObject @($rows) -Depth 4 -Compress
`;
  const res = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]);
  if (res.error) throw res.error;
  const stdout = (res.stdout || '').trim();
  if (!stdout) return [];
  const parsed = JSON.parse(stdout);
  return asArray(parsed).map((row) => ({
    address: row.address ?? null,
    port: Number(row.port),
    processId: row.processId === null || row.processId === undefined ? null : Number(row.processId),
    name: row.name || null,
    executable: row.executable || null,
    commandLine: row.commandLine || null,
    startTime: row.startTime || null,
  }));
}

function listListenersLinux() {
  const ss = run('ss', ['-ltnpH']);
  if (!ss.error && ss.status === 0 && (ss.stdout || '').trim()) {
    const rows = parseSsOutput(ss.stdout);
    if (rows.length > 0) return rows;
  }
  const netstat = run('netstat', ['-ltnp']);
  if (!netstat.error && netstat.status === 0 && (netstat.stdout || '').trim()) {
    const rows = parseNetstatOutput(netstat.stdout);
    if (rows.length > 0) return rows;
  }
  // Fail closed: when neither tool yields a usable listing, read the kernel tables
  // directly so a bound port is never mistaken for a free one. Listening sockets are
  // known even when the owning PID cannot be resolved.
  return parseProcNetListeners();
}

/**
 * Parse `/proc/net/tcp` and `/proc/net/tcp6` LISTEN sockets and best-effort resolve the
 * owning PID through the socket inode index. A resolved listener with no PID is reported
 * as-is; classification then fails closed instead of assuming the port is free.
 */
function parseProcNetListeners() {
  const rows = [];
  let inodeToPid = null;
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text = '';
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n').slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 10) continue;
      if (parts[3] !== '0A') continue; // TCP_LISTEN
      const { address, port } = splitProcNetAddress(parts[1]);
      if (port === null) continue;
      if (!inodeToPid) inodeToPid = buildInodePidIndex();
      const inode = Number.parseInt(parts[9], 10);
      const processId = inodeToPid.get(inode) || null;
      rows.push({ address, port, processId, name: null, executable: null, commandLine: null, startTime: null });
    }
  }
  return rows;
}

function splitProcNetAddress(value) {
  const [hexIp, hexPort] = String(value || '').split(':');
  const port = Number.parseInt(hexPort, 16);
  if (!Number.isFinite(port)) return { address: null, port: null };
  let address = null;
  if (hexIp && hexIp.length === 8) {
    const bytes = hexIp.match(/../g) || [];
    address = bytes.reverse().map((byte) => Number.parseInt(byte, 16)).join('.');
  }
  return { address, port };
}

function buildInodePidIndex() {
  const index = new Map();
  let entries = [];
  try {
    entries = readdirSync('/proc');
  } catch {
    return index;
  }
  for (const entry of entries) {
    const pid = Number.parseInt(entry, 10);
    if (!Number.isFinite(pid)) continue;
    let fds = [];
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      let target = '';
      try {
        target = readlinkSync(`/proc/${pid}/fd/${fd}`);
      } catch {
        continue;
      }
      const match = target.match(/^socket:\[(\d+)\]$/);
      if (match) index.set(Number.parseInt(match[1], 10), pid);
    }
  }
  return index;
}

function parseSsOutput(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // `ss -ltnpH` columns: State Recv-Q Send-Q Local:Port Peer:Port [Process]
    const parts = trimmed.split(/\s+/);
    if (parts.length < 5) continue;
    if (parts[0] !== 'LISTEN' && parts[0] !== 'UNCONN') continue;
    const { address, port } = splitHostPort(parts[3]);
    if (port === null) continue;
    let name = null;
    let processId = null;
    const proc = parts.slice(5).join(' ');
    const m = proc.match(/\(\s*"([^"]+)"\s*,\s*pid=(\d+)/);
    if (m) {
      name = m[1];
      processId = Number(m[2]);
    }
    rows.push({ address, port, processId, name, executable: null, commandLine: null, startTime: null });
  }
  return rows;
}

function parseNetstatOutput(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('tcp')) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 7) continue;
    const local = parts[3];
    const state = parts[5];
    const pidPart = parts[6];
    if (state !== 'LISTEN') continue;
    const { address, port } = splitHostPort(local);
    if (port === null) continue;
    const pid = Number(String(pidPart).split('/')[0]);
    rows.push({ address, port, processId: Number.isFinite(pid) ? pid : null, name: null, executable: null, commandLine: null, startTime: null });
  }
  return rows;
}

function splitHostPort(value) {
  const text = String(value || '');
  const idx = text.lastIndexOf(':');
  if (idx === -1) return { address: text, port: null };
  const port = Number(text.slice(idx + 1));
  return { address: text.slice(0, idx), port: Number.isFinite(port) ? port : null };
}

/** Find the listening record bound to a port (any address), if present. */
export async function findListener(port, { refresh = false } = {}) {
  const listeners = await listListeners({ refresh });
  return listeners.find((row) => row.port === Number(port)) || null;
}

// ---------------------------------------------------------------------------
// Process identity
// ---------------------------------------------------------------------------

let processCache = new Map();

export async function inspectProcess(pid, { refresh = false } = {}) {
  const key = Number(pid);
  if (!Number.isFinite(key) || key <= 0) return null;
  if (processCache.has(key) && !refresh) return processCache.get(key);
  let info = null;
  try {
    if (process.platform === 'win32') info = inspectProcessWindows(key);
    else info = inspectProcessLinux(key);
  } catch {
    info = null;
  }
  processCache.set(key, info);
  return info;
}

function inspectProcessWindows(pid) {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"
if (-not $p) { exit 3 }
$nm = [string]$p.Name
$exe = [string]$p.ExecutablePath
$cmd = [string]$p.CommandLine
$st = $null
if ($p.CreationDate) { $st = $p.CreationDate.ToUniversalTime().ToString('o') }
$ownerUser = $null
try {
  $owner = Invoke-CimMethod -InputObject $p -MethodName GetOwner
  if ($owner -and $owner.User) { $ownerUser = [string]$owner.User }
} catch {}
[pscustomobject]@{
  processId = [int]$p.ProcessId
  parentProcessId = [int]$p.ParentProcessId
  name = $nm
  executable = $exe
  commandLine = $cmd
  startTime = $st
  user = $ownerUser
} | ConvertTo-Json -Depth 4 -Compress
`;
  const res = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]);
  if (res.error) return null;
  if (res.status !== 0) return null;
  const stdout = (res.stdout || '').trim();
  if (!stdout) return null;
  const parsed = JSON.parse(stdout);
  return normalizeProcess(parsed);
}

function inspectProcessLinux(pid) {
  const base = `/proc/${pid}`;
  if (!existsSync(base)) return null;
  let commandLine = null;
  let executable = null;
  let name = null;
  let startTime = null;
  let user = null;
  let parentProcessId = null;
  let state = null;
  try {
    commandLine = readFileSync(join(base, 'cmdline'), 'utf8').replace(/\0/g, ' ').trim() || null;
  } catch { /* permission or race */ }
  try {
    executable = readlinkSync(join(base, 'exe'));
  } catch { /* permission */ }
  try {
    const status = readFileSync(join(base, 'status'), 'utf8');
    const nameMatch = status.match(/^Name:\s*(.+)$/m);
    if (nameMatch) name = nameMatch[1].trim();
  } catch { /* permission */ }
  try {
    const stat = readFileSync(join(base, 'stat'), 'utf8');
    const close = stat.lastIndexOf(')');
    const fields = stat.slice(close + 2).split(' ');
    state = fields[0] || null;
    const ppid = Number(fields[1]);
    if (Number.isFinite(ppid)) parentProcessId = ppid;
    const startTicks = Number(fields[19]);
    if (Number.isFinite(startTicks)) {
      const uptimeText = readFileSync('/proc/uptime', 'utf8').split(' ')[0];
      const uptime = Number(uptimeText);
      const hz = 100;
      const epoch = Date.now() / 1000 - uptime + startTicks / hz;
      startTime = new Date(epoch * 1000).toISOString();
    }
  } catch { /* permission */ }
  // A terminated process keeps its /proc entry until the parent reaps it. While it is a
  // zombie (or dead) it has already exited and must not be reported as a live process,
  // otherwise "confirm the process is gone" would block until an unrelated parent reaps.
  if (state === 'Z' || state === 'X' || state === 'x') return null;
  if (!commandLine && !executable && !name) return null;
  return { processId: Number(pid), parentProcessId, name, executable, commandLine, startTime, user };
}

function normalizeProcess(value) {
  if (!value || value.processId === null || value.processId === undefined) return null;
  const parent = value.parentProcessId === null || value.parentProcessId === undefined
    ? null
    : Number(value.parentProcessId);
  return {
    processId: Number(value.processId),
    parentProcessId: Number.isFinite(parent) ? parent : null,
    name: value.name || null,
    executable: value.executable || null,
    commandLine: value.commandLine || null,
    startTime: value.startTime || null,
    user: value.user || null,
  };
}

/** True when the process command line / executable points inside this repository. */
export function commandReferencesRoot(processInfo, repoRoot) {
  const root = normalizePath(repoRoot);
  if (!root) return false;
  const haystack = normalizePath(`${processInfo?.commandLine || ''} ${processInfo?.executable || ''}`);
  if (!haystack.replace(/ /g, '')) return false;
  return haystack.includes(root);
}

// ---------------------------------------------------------------------------
// Port classification
// ---------------------------------------------------------------------------

/**
 * Classify one port.
 *
 * @param {object} input
 * @param {number} input.port
 * @param {string} input.role                 one of PORT_ROLES
 * @param {object|null} input.listener        listener record (null when free)
 * @param {object|null} [input.processInfo]   inspected owner process
 * @param {object|null} [input.registryRecord] ownership record for this role
 * @param {string} [input.repoRoot]
 * @param {boolean|null} [input.serviceReachable] live service identity probe
 * @param {number|null} [input.edgeApiStatus]  `GET /api/auth/me` status observed on an
 *        `edge` listener
 * @param {boolean} [input.managedByRecord]  listener is a proven descendant of a
 *        verified managed process (a supervisor may own the socket for a child)
 * @returns {{port:number, role:string, state:string, outcome:string, reason:string,
 *            listener:object|null, processInfo:object|null, ownership:object|null}}
 */
export function classifyPort(input) {
  const {
    port,
    role,
    listener,
    processInfo = null,
    registryRecord = null,
    repoRoot = null,
    serviceReachable = null,
    edgeApiStatus = null,
    managedByRecord = false,
  } = input || {};

  if (!listener) {
    return {
      port, role,
      state: LISTENER_STATES.FREE,
      outcome: PORT_OUTCOMES.PORT_FREE,
      reason: 'no listener bound to this port',
      listener: null, processInfo: null, ownership: null,
    };
  }

  const ownership = registryRecord ? verifyOwnership(registryRecord, processInfo) : null;
  if (managedByRecord || (ownership && ownership.verdict === 'OWNED')) {
    return {
      port, role,
      state: LISTENER_STATES.EXPECTED_SERVICE,
      outcome: PORT_OUTCOMES.PROJECT_MANAGED_PROCESS,
      reason: managedByRecord
        ? 'listener is a descendant of a verified managed process'
        : 'matches a managed runtime ownership record',
      listener, processInfo, ownership,
    };
  }

  const ownerKnown = Boolean(processInfo && (processInfo.name || processInfo.executable || processInfo.commandLine));
  if (!ownerKnown) {
    return {
      port, role,
      state: LISTENER_STATES.PERMISSION_LIMITED,
      outcome: PORT_OUTCOMES.INSUFFICIENT_PERMISSION,
      reason: 'the listener owner could not be inspected',
      listener, processInfo, ownership,
    };
  }

  // Long-lived infrastructure is allowed to already be running.
  if (role === 'edge') {
    // The edge contract is a runtime property, not a process name. An arbitrary HTTP
    // server that answers `/` is not the xCloud edge: the root must answer AND `/api`
    // must be routed to the Go authority (401 without credentials, or 502/503 while the
    // Go upstream is not yet up).
    const apiRoutedToGo = edgeApiStatus === 401 || edgeApiStatus === 502 || edgeApiStatus === 503;
    const looksLikeEdge = serviceReachable === true && apiRoutedToGo;
    if (looksLikeEdge) {
      return {
        port, role,
        state: LISTENER_STATES.EXPECTED_SERVICE,
        outcome: PORT_OUTCOMES.EXPECTED_SERVICE,
        reason: 'expected edge service (root reachable and /api routed to the Go authority)',
        listener, processInfo, ownership,
      };
    }
  }
  if (role === 'mongo') {
    const looksLikeMongo = serviceReachable === true || /mongo/i.test(processInfo.name || '');
    if (looksLikeMongo) {
      return {
        port, role,
        state: LISTENER_STATES.EXPECTED_SERVICE,
        outcome: PORT_OUTCOMES.EXPECTED_SERVICE,
        reason: 'expected MongoDB service',
        listener, processInfo, ownership,
      };
    }
  }

  if (repoRoot && commandReferencesRoot(processInfo, repoRoot)) {
    return {
      port, role,
      state: LISTENER_STATES.FOREIGN_LISTENER,
      outcome: PORT_OUTCOMES.STALE_PROJECT_PROCESS,
      reason: 'project artifact that is not a registered managed process',
      listener, processInfo, ownership,
    };
  }

  return {
    port, role,
    state: LISTENER_STATES.FOREIGN_LISTENER,
    outcome: PORT_OUTCOMES.FOREIGN_PROCESS,
    reason: 'unexpected process owns this canonical port',
    listener, processInfo, ownership,
  };
}

/**
 * Prove that a listener is managed by a recorded process even when the recorded PID
 * is a supervisor that does not own the socket itself (Next.js `next dev` starts a
 * child server that binds the port).
 *
 * The recorded process must itself verify, then the listener's ancestor chain must
 * lead back to it. Unknown or unverifiable chains prove nothing.
 */
export async function isManagedDescendant(record, listenerPid, { maxDepth = 8 } = {}) {
  if (!record || !record.pid || !listenerPid) return false;
  if (Number(listenerPid) === Number(record.pid)) return true;
  const recordedInfo = await inspectProcess(record.pid);
  if (verifyOwnership(record, recordedInfo).verdict !== 'OWNED') return false;
  let current = Number(listenerPid);
  for (let depth = 0; depth < maxDepth && current; depth += 1) {
    const info = await inspectProcess(current);
    if (!info || !info.parentProcessId) return false;
    if (Number(info.parentProcessId) === Number(record.pid)) return true;
    current = Number(info.parentProcessId);
  }
  return false;
}

/** Inspect a single port end to end (read-only). */
export async function inspectPort(port, { role = 'custom', repoRoot = null, registryRecord = null, refresh = false } = {}) {
  const listener = await findListener(port, { refresh });
  let processInfo = null;
  if (listener && listener.processId) processInfo = await inspectProcess(listener.processId, { refresh });
  let managedByRecord = false;
  if (registryRecord && listener && listener.processId) {
    managedByRecord = await isManagedDescendant(registryRecord, listener.processId);
  }
  let serviceReachable = null;
  let edgeApiStatus = null;
  if (listener) {
    if (role === 'mongo') serviceReachable = await isPortOpen(port);
    else if (role === 'edge') {
      // The edge is proven by behaviour: the UI root answers AND `/api` reaches the Go
      // authentication boundary. Probe both so an unrelated HTTP server that merely
      // answers `/` is never accepted as this project's edge.
      const [rootProbe, apiProbe] = await Promise.all([
        probeHttp(`http://127.0.0.1:${port}/`),
        probeHttp(`http://127.0.0.1:${port}/api/auth/me`),
      ]);
      serviceReachable = rootProbe.reachable;
      edgeApiStatus = apiProbe.reachable ? apiProbe.status : null;
    }
  }
  return classifyPort({ port, role, listener, processInfo, registryRecord, repoRoot, serviceReachable, edgeApiStatus, managedByRecord });
}

// ---------------------------------------------------------------------------
// Runtime PID registry
// ---------------------------------------------------------------------------

export const RUNTIME_DIR_NAME = '.runtime/local';
export const REGISTRY_ROLES = Object.freeze(['go', 'next']);

/** Registry directory. Honors XCLOUD_RUNTIME_DIR for isolated test runs. */
export function runtimeDir(repoRoot, env = process.env) {
  if (env.XCLOUD_RUNTIME_DIR) return env.XCLOUD_RUNTIME_DIR;
  return join(repoRoot, RUNTIME_DIR_NAME);
}

export function recordPath(repoRoot, role, env = process.env) {
  return join(runtimeDir(repoRoot, env), `${role}.pid.json`);
}

export function readRecord(repoRoot, role, env = process.env) {
  const file = recordPath(repoRoot, role, env);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function readRegistry(repoRoot, env = process.env) {
  const registry = {};
  for (const role of REGISTRY_ROLES) registry[role] = readRecord(repoRoot, role, env);
  return registry;
}

export function writeRecord(repoRoot, role, record, env = process.env) {
  const dir = runtimeDir(repoRoot, env);
  mkdirSync(dir, { recursive: true });
  const payload = { role, ...record };
  writeFileSync(recordPath(repoRoot, role, env), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

export function removeRecord(repoRoot, role, env = process.env) {
  const file = recordPath(repoRoot, role, env);
  if (!existsSync(file)) return false;
  rmSync(file, { force: true });
  return true;
}

/** Build an ownership record from a live process inspection. */
export function buildRecord({ role, pid, command, repoRoot, processInfo, startedAt = new Date().toISOString() }) {
  return {
    pid: Number(pid),
    role,
    startedAt,
    command: command || processInfo?.commandLine || null,
    repositoryRoot: repoRoot || null,
    executable: processInfo?.executable || null,
    commandLineFingerprint: processInfo?.commandLine || null,
    processStartTime: processInfo?.startTime || null,
  };
}

/**
 * Verify that a recorded PID still corresponds to the recorded process.
 *
 * @returns {{verdict:'OWNED'|'STALE'|'REFUSE_TO_KILL'|'NOT_FOUND',
 *            pid:(number|null), matched:string[], conflicts:string[], reasons:string[]}}
 */
export function verifyOwnership(record, processInfo) {
  const matched = [];
  const conflicts = [];
  const reasons = [];

  if (!record || typeof record !== 'object' || !record.pid) {
    return { verdict: 'NOT_FOUND', pid: null, matched, conflicts, reasons: ['no ownership record'] };
  }
  const pid = Number(record.pid);
  if (!processInfo || !processInfo.processId) {
    return { verdict: 'STALE', pid, matched, conflicts, reasons: ['the recorded process is no longer running'] };
  }
  if (Number(processInfo.processId) !== pid) {
    conflicts.push('pid');
    return { verdict: 'REFUSE_TO_KILL', pid, matched, conflicts, reasons: ['the live process id differs from the record'] };
  }
  matched.push('pid');

  const root = normalizePath(record.repositoryRoot);
  const live = normalizePath(`${processInfo.commandLine || ''} ${processInfo.executable || ''}`);
  if (root) {
    if (!live.replace(/ /g, '')) reasons.push('live process command line unavailable');
    else if (live.includes(root)) matched.push('repositoryRoot');
    else conflicts.push('repositoryRoot');
  }

  const recordedFingerprint = normalizePath(record.commandLineFingerprint);
  const liveCommandLine = normalizePath(processInfo.commandLine);
  if (recordedFingerprint && liveCommandLine) {
    if (recordedFingerprint === liveCommandLine) matched.push('commandLine');
    else conflicts.push('commandLine');
  }

  const recordedStart = Date.parse(record.processStartTime || record.startedAt || '');
  const liveStart = Date.parse(processInfo.startTime || '');
  if (Number.isFinite(recordedStart) && Number.isFinite(liveStart)) {
    if (Math.abs(recordedStart - liveStart) <= 180000) matched.push('startTime');
    else conflicts.push('startTime');
  }

  if (conflicts.length > 0) {
    return { verdict: 'REFUSE_TO_KILL', pid, matched, conflicts, reasons: [...reasons, `identity conflict: ${conflicts.join(', ')}`] };
  }
  if (matched.length >= 2) {
    return { verdict: 'OWNED', pid, matched, conflicts, reasons: reasons.length ? reasons : ['ownership verified'] };
  }
  return { verdict: 'REFUSE_TO_KILL', pid, matched, conflicts, reasons: [...reasons, 'insufficient identity evidence'] };
}

/**
 * The only termination entry point in this repository.
 *
 * Refuses unless ownership is proven by `verifyOwnership`. Never kills by port, by
 * image name, or by wildcard. Reports INSUFFICIENT_PERMISSION instead of elevating.
 */
export function terminateVerifiedProcess(record, processInfo) {
  const ownership = verifyOwnership(record, processInfo);
  if (ownership.verdict !== 'OWNED') {
    return { ok: false, refusal: ownership.verdict, ownership, pid: ownership.pid };
  }
  const pid = ownership.pid;
  try {
    if (process.platform === 'win32') {
      const res = run('taskkill', ['/PID', String(pid), '/T', '/F']);
      if (res.error) throw res.error;
      if (res.status !== 0) {
        const stderr = `${res.stderr || ''} ${res.stdout || ''}`;
        if (/access is denied|拒绝访问/i.test(stderr)) {
          return { ok: false, refusal: 'INSUFFICIENT_PERMISSION', ownership, pid, detail: stderr.trim() };
        }
        return { ok: false, refusal: 'KILL_FAILED', ownership, pid, detail: stderr.trim() };
      }
      return { ok: true, pid, ownership };
    }
    process.kill(pid, 'SIGTERM');
    return { ok: true, pid, ownership };
  } catch (err) {
    if (err && (err.code === 'EPERM' || err.code === 'EACCES')) {
      return { ok: false, refusal: 'INSUFFICIENT_PERMISSION', ownership, pid, detail: err.message };
    }
    return { ok: false, refusal: 'KILL_FAILED', ownership, pid, detail: err.message };
  }
}

// ---------------------------------------------------------------------------
// Topology
// ---------------------------------------------------------------------------

/**
 * Classify the observed edge UI owner based on HTML content.
 * Next.js dev server serves HTML with `/_next/` asset paths or `__NEXT_DATA__`.
 * Go bundled SPA serves HTML with `/assets/` or `id="root"` and no `/_next/`.
 */
export function classifyEdgeUiOwner({ edge, edgeLogin } = {}) {
  const probe = (edgeLogin && edgeLogin.reachable && edgeLogin.status === 200) ? edgeLogin : edge;
  if (!probe || !probe.reachable) return 'unknown';
  const body = String(probe.body || '');
  const hasNext = body.includes('/_next/') || body.includes('__NEXT_DATA__');
  const hasGoSpa = body.includes('/assets/') || body.includes('id="root"');
  if (hasNext && !hasGoSpa) return 'next';
  if (hasGoSpa && !hasNext) return 'go';
  if (hasNext) return 'next';
  if (hasGoSpa) return 'go';
  return 'unknown';
}

/**
 * Probe the full local topology over HTTP. Pure reachability + ownership
 * interpretation; no process management.
 */
export async function probeTopology({ edgeUrl = resolveEdgeUrl() } = {}) {
  const edgeRootUrl = `${edgeUrl}/`;
  const edgeLoginUrl = `${edgeUrl}/login`;
  const edgeApiUrl = `${edgeUrl}/api/auth/me`;
  const [go, next, edge, edgeLogin, edgeApi, nextApi] = await Promise.all([
    probeHttp(GO_HEALTHZ),
    probeHttp(NEXT_ROOT),
    probeHttp(edgeRootUrl),
    probeHttp(edgeLoginUrl),
    probeHttp(edgeApiUrl),
    probeHttp(NEXT_DIRECT_API),
  ]);

  const goReady = go.reachable;
  const nextReady = next.reachable;
  const edgeReady = edge.reachable;
  const edgeApiRouted = edgeApi.reachable && edgeApi.status === 401;
  const directNextApi = classifyDirectNextApi(nextApi);
  const edgeUiOwner = classifyEdgeUiOwner({ edge, edgeLogin });

  let result;
  // An architecture violation outranks every topology state: a Next.js listener that
  // answers the authentication API is a contract breach, not a "Next is up" reading.
  if (directNextApi === 'ARCHITECTURE_VIOLATION') result = TOPOLOGY_STATES.ARCHITECTURE_VIOLATION;
  else if (!goReady) result = TOPOLOGY_STATES.GO_DOWN;
  else if (!nextReady) result = TOPOLOGY_STATES.NEXT_DOWN;
  else if (!edgeReady) result = TOPOLOGY_STATES.EDGE_REQUIRED;
  else if (!edgeApiRouted) result = TOPOLOGY_STATES.EDGE_API_MISROUTED;
  else if (edgeUiOwner !== 'next') result = TOPOLOGY_STATES.EDGE_UI_MISROUTED;
  else result = TOPOLOGY_STATES.FULL_STACK_READY;

  return {
    edgeUrl, edgeRootUrl, edgeLoginUrl, edgeApiUrl,
    go, next, edge, edgeLogin, edgeApi, nextApi,
    goReady, nextReady, edgeReady, edgeApiRouted, directNextApi, edgeUiOwner, result,
  };
}

/** True when a classification represents canonical-port contamination. */
export function isContaminated(portResult) {
  if (!portResult) return false;
  return portResult.state === LISTENER_STATES.FOREIGN_LISTENER
    || portResult.state === LISTENER_STATES.UNKNOWN_LISTENER
    || portResult.state === LISTENER_STATES.PERMISSION_LIMITED;
}

export function describeListener(listener) {
  if (!listener) return 'none';
  const parts = [`pid=${listener.processId ?? 'unknown'}`];
  if (listener.name) parts.push(`process=${listener.name}`);
  if (listener.address) parts.push(`address=${listener.address}`);
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Managed process lifecycle
// ---------------------------------------------------------------------------
//
// Two rules are implemented here once so the start and stop tools cannot diverge:
//
//   A. a spawned managed child obtains a durable ownership record before its readiness
//      poll can fail, so no failure path leaves a live process without a record;
//   B. an ownership record is discarded only after the process is confirmed gone, so a
//      stop timeout never loses the record the operator still needs.
//
// `terminateVerifiedProcess` above remains the only termination entry point.

export const DEFAULT_STOP_TIMEOUT_MS = 8000;

/** Stop timeout. Honors XCLOUD_STOP_TIMEOUT_MS for isolated test runs. */
export function stopTimeoutMs(env = process.env) {
  const raw = env.XCLOUD_STOP_TIMEOUT_MS;
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_STOP_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_STOP_TIMEOUT_MS;
  return value;
}

export const STOP_STATUSES = Object.freeze({
  ABSENT: 'ABSENT',
  STALE: 'STALE',
  REFUSED: 'REFUSED',
  STOPPED: 'STOPPED',
  STOP_TIMEOUT: 'STOP_TIMEOUT',
  INSUFFICIENT_PERMISSION: 'INSUFFICIENT_PERMISSION',
  FAILED: 'FAILED',
});

/** Statuses that mean "the stop did not achieve its goal". */
const STOP_FAILURE_STATUSES = Object.freeze([
  STOP_STATUSES.STOP_TIMEOUT,
  STOP_STATUSES.INSUFFICIENT_PERMISSION,
  STOP_STATUSES.FAILED,
]);

const REGISTRATION_INSPECT_ATTEMPTS = 10;
const REGISTRATION_INSPECT_INTERVAL_MS = 150;
const RELEASE_UNREGISTERED_TIMEOUT_MS = 5000;

/**
 * Take durable ownership of a process this command has just spawned.
 *
 * The record is written only when the live process itself proves the record under the
 * same `verifyOwnership` gate that `local:stop` later applies, so a written record can
 * never describe a process this command does not own.
 *
 * @returns {{ok:boolean, reason:string, pid:(number|null), record:(object|null),
 *            ownership:(object|null)}}
 */
export async function registerManagedProcess({
  repoRoot,
  role,
  pid,
  command,
  env = process.env,
  startedAt = new Date().toISOString(),
}) {
  const targetPid = Number(pid);
  if (!Number.isFinite(targetPid) || targetPid <= 0) {
    return { ok: false, reason: 'spawn did not yield a process id', pid: null, record: null, ownership: null };
  }

  let info = null;
  for (let attempt = 0; attempt < REGISTRATION_INSPECT_ATTEMPTS; attempt += 1) {
    info = await inspectProcess(targetPid, { refresh: true });
    if (info) break;
    await sleep(REGISTRATION_INSPECT_INTERVAL_MS);
  }
  if (!info) {
    return { ok: false, reason: 'the spawned process could not be inspected', pid: targetPid, record: null, ownership: null };
  }

  const record = buildRecord({ role, pid: targetPid, command, repoRoot, processInfo: info, startedAt });
  const ownership = verifyOwnership(record, info);
  if (ownership.verdict !== 'OWNED') {
    return { ok: false, reason: `ownership could not be proven (${ownership.verdict})`, pid: targetPid, record, ownership };
  }

  const written = writeRecord(repoRoot, role, record, env);
  return { ok: true, reason: 'registered', pid: targetPid, record: written, ownership };
}

/**
 * Wait until a process actually disappears.
 *
 * A requested termination is not a completed stop. Only this confirmation may precede
 * removal of the ownership record. `timeoutMs` of 0 performs a single check.
 */
export async function confirmProcessExit(pid, { timeoutMs = DEFAULT_STOP_TIMEOUT_MS, pollMs = 250 } = {}) {
  const targetPid = Number(pid);
  if (!Number.isFinite(targetPid) || targetPid <= 0) return true;
  const budget = Number.isFinite(Number(timeoutMs)) ? Math.max(0, Number(timeoutMs)) : DEFAULT_STOP_TIMEOUT_MS;
  const deadline = Date.now() + budget;
  for (;;) {
    const info = await inspectProcess(targetPid, { refresh: true });
    if (!info) return true;
    if (Date.now() >= deadline) return false;
    await sleep(pollMs);
  }
}

/**
 * Stop one managed process.
 *
 * Ownership is verified first and termination is requested only through the verified
 * entry point. The ownership record is removed ONLY after the process is confirmed gone.
 * A process that outlives the stop timeout keeps its record and is reported as
 * `STOP_TIMEOUT`, so the operator can retry `npm run local:stop`.
 */
export async function stopManagedProcess({
  repoRoot,
  role,
  env = process.env,
  timeoutMs = stopTimeoutMs(env),
  record = null,
  processInfo = null,
  terminateFn = terminateVerifiedProcess,
  confirmExitFn = confirmProcessExit,
} = {}) {
  const existing = record || readRecord(repoRoot, role, env);
  if (!existing) {
    return {
      role, status: STOP_STATUSES.ABSENT, pid: null,
      recordRemoved: false, recordPresent: false, ownership: null, processInfo: null, detail: null,
    };
  }

  const info = processInfo || (await inspectProcess(existing.pid, { refresh: true }));
  const ownership = verifyOwnership(existing, info);

  if (ownership.verdict === 'STALE') {
    removeRecord(repoRoot, role, env);
    return {
      role, status: STOP_STATUSES.STALE, pid: existing.pid,
      recordRemoved: true, recordPresent: false, ownership, processInfo: info, detail: null,
    };
  }
  if (ownership.verdict === 'NOT_FOUND') {
    removeRecord(repoRoot, role, env);
    return {
      role, status: STOP_STATUSES.ABSENT, pid: existing.pid,
      recordRemoved: true, recordPresent: false, ownership, processInfo: info, detail: null,
    };
  }
  if (ownership.verdict !== 'OWNED') {
    return {
      role, status: STOP_STATUSES.REFUSED, pid: existing.pid,
      recordRemoved: false, recordPresent: true, ownership, processInfo: info, detail: null,
    };
  }

  const termination = terminateFn(existing, info);
  if (!termination || !termination.ok) {
    const status = termination && termination.refusal === 'INSUFFICIENT_PERMISSION'
      ? STOP_STATUSES.INSUFFICIENT_PERMISSION
      : STOP_STATUSES.FAILED;
    return {
      role, status, pid: existing.pid,
      recordRemoved: false, recordPresent: true, ownership, processInfo: info,
      detail: termination && termination.detail ? termination.detail : null,
    };
  }

  const exited = await confirmExitFn(existing.pid, { timeoutMs });
  if (!exited) {
    return {
      role, status: STOP_STATUSES.STOP_TIMEOUT, pid: existing.pid,
      recordRemoved: false, recordPresent: true, ownership, processInfo: info, detail: null,
    };
  }

  removeRecord(repoRoot, role, env);
  return {
    role, status: STOP_STATUSES.STOPPED, pid: existing.pid,
    recordRemoved: true, recordPresent: false, ownership, processInfo: info, detail: null,
  };
}

/**
 * Stop every registered role and summarize the outcome.
 *
 * Shared so the command and the contract test cannot diverge on the failure mapping:
 * a timeout, an unmanageable process or a failed termination is always
 * `NEEDS_ATTENTION` with a non-zero exit code.
 */
export async function stopManagedProcesses({
  repoRoot,
  roles = REGISTRY_ROLES,
  env = process.env,
  timeoutMs = stopTimeoutMs(env),
  stopFn = stopManagedProcess,
} = {}) {
  const outcomes = [];
  for (const role of roles) {
    outcomes.push(await stopFn({ repoRoot, role, env, timeoutMs }));
  }

  const refusals = outcomes.filter((outcome) => outcome.status === STOP_STATUSES.REFUSED).length;
  const failures = outcomes.filter((outcome) => STOP_FAILURE_STATUSES.includes(outcome.status)).length;
  const timedOut = outcomes.filter((outcome) => outcome.status === STOP_STATUSES.STOP_TIMEOUT);
  const recordPreservedOnTimeout = timedOut.length === 0
    ? null
    : timedOut.every((outcome) => existsSync(recordPath(repoRoot, outcome.role, env)));
  const result = failures === 0 && refusals === 0 ? 'PASS' : 'NEEDS_ATTENTION';

  return { outcomes, refusals, failures, recordPreservedOnTimeout, result, exitCode: result === 'PASS' ? 0 : 1 };
}

class StartupFailure extends Error {}

/**
 * Spawn, take ownership of, and await readiness for a sequence of managed children.
 *
 * Each child is registered durably BEFORE its readiness poll can fail, and any failure
 * rolls the already-registered children back in reverse order through the same verified
 * stop path `local:stop` uses. No arbitrary PID kill shortcut exists.
 *
 * `onEvent` receives `spawned`, `registered`, `ready-start`, `ready-ok`, `ready-fail`,
 * `ready-error`, `register-failed`, `register-released`, `register-release-failed`,
 * `rollback-start`, `rollback-stop` and `rollback-done`.
 *
 * A child whose ownership record could not be written is released through the exact
 * ChildProcess handle; if that release cannot confirm the child is gone the result is
 * surfaced as `cleanupFailure` so the caller can never report a clean unmanaged count.
 */
export async function startManagedProcesses({
  repoRoot,
  entries = [],
  env = process.env,
  timeoutMs = stopTimeoutMs(env),
  onEvent = () => {},
  releaseFn = releaseUnregisteredChild,
} = {}) {
  const registered = [];
  let cleanupFailure = null;
  try {
    for (const entry of entries) {
      const { role } = entry;
      const child = entry.spawn();
      onEvent({ type: 'spawned', role, pid: child && child.pid });
      if (!child || !Number.isFinite(Number(child.pid)) || Number(child.pid) <= 0) {
        throw new StartupFailure(`${role}: spawn did not yield a process id`);
      }

      const registration = await registerManagedProcess({ repoRoot, role, pid: child.pid, command: entry.command, env });
      if (!registration.ok) {
        onEvent({ type: 'register-failed', role, reason: registration.reason });
        const release = await releaseFn(child);
        if (release.ok) {
          onEvent({ type: 'register-released', role, pid: release.pid, escalated: release.escalated, reason: release.reason });
        } else {
          cleanupFailure = { role, pid: release.pid, escalated: release.escalated, reason: release.reason };
          onEvent({ type: 'register-release-failed', role, pid: release.pid, reason: release.reason });
        }
        throw new StartupFailure(`${role}: ownership could not be recorded (${registration.reason})`);
      }
      registered.push({ role, pid: registration.record.pid, record: registration.record });
      onEvent({ type: 'registered', role, pid: registration.record.pid });

      onEvent({ type: 'ready-start', role, pid: registration.record.pid });
      let ready = false;
      try {
        ready = Boolean(await entry.waitForReady());
      } catch (err) {
        onEvent({ type: 'ready-error', role, message: err && err.message ? err.message : String(err) });
      }
      if (!ready) {
        onEvent({ type: 'ready-fail', role });
        throw new StartupFailure(`${role}: readiness failed`);
      }
      onEvent({ type: 'ready-ok', role });
    }
    return { ok: true, registered, stopped: [], error: null, cleanupFailure };
  } catch (error) {
    onEvent({ type: 'rollback-start', message: error && error.message ? error.message : String(error) });
    const stopped = [];
    for (const item of [...registered].reverse()) {
      const outcome = await stopManagedProcess({ repoRoot, role: item.role, env, timeoutMs });
      stopped.push(outcome);
      onEvent({ type: 'rollback-stop', role: item.role, status: outcome.status });
    }
    onEvent({ type: 'rollback-done', stopped: stopped.map((outcome) => `${outcome.role}:${outcome.status}`) });
    return { ok: false, registered, stopped, error, cleanupFailure };
  }
}

/**
 * Terminate the exact handle this command just spawned when ownership could not be
 * recorded.
 *
 * This is not a PID lookup, not a port lookup and not an image-name match: it acts only
 * on the live ChildProcess handle in hand, so no unregistered detached process is left
 * behind by a failed registration. The result is enforced, never discarded: a release
 * that cannot confirm the child is gone is reported as a failure.
 *
 * Because no durable ownership record exists yet for this child, one narrowly scoped
 * escalation is permitted after a graceful termination fails: a final `SIGKILL` sent
 * through the same exact handle. It is still never a name/port/PID wildcard search, and
 * it is confirmed with the same exit check before the release may be called a success.
 */
async function releaseUnregisteredChild(child, { timeoutMs = RELEASE_UNREGISTERED_TIMEOUT_MS } = {}) {
  const pid = Number(child && child.pid);
  if (!Number.isFinite(pid) || pid <= 0) {
    return { ok: true, pid: null, escalated: false, reason: 'no spawned process to release' };
  }

  const signalExactChild = (signal) => {
    try {
      child.kill(signal);
      return true;
    } catch {
      // The handle is already gone or cannot be signalled; the exit check below decides.
      return false;
    }
  };

  signalExactChild('SIGTERM');
  if (await confirmProcessExit(pid, { timeoutMs })) {
    return { ok: true, pid, escalated: false, reason: 'the exact spawned child exited after termination' };
  }

  const escalated = signalExactChild('SIGKILL');
  if (await confirmProcessExit(pid, { timeoutMs })) {
    return { ok: true, pid, escalated, reason: 'the exact spawned child exited after the exact-child escalation' };
  }

  return { ok: false, pid, escalated, reason: 'the exact spawned child is still alive after release' };
}

/**
 * Count canonical internal ports owned by a project artifact that has no valid managed
 * ownership record.
 *
 * That is precisely the forbidden state: a live project process with no durable
 * ownership record. Foreign processes are reported by `local:preflight` instead.
 */
export async function countUnmanagedLiveProcesses({ repoRoot, env = process.env } = {}) {
  const offenders = [];
  for (const role of INTERNAL_PORT_ROLES) {
    const record = readRecord(repoRoot, role, env);
    const result = await inspectPort(CANONICAL_PORTS[role], {
      role, repoRoot, registryRecord: record, refresh: true,
    });
    if (result.outcome === PORT_OUTCOMES.STALE_PROJECT_PROCESS) offenders.push(result);
  }
  return offenders;
}
