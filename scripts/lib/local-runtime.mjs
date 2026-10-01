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
import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
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
    return parseSsOutput(ss.stdout);
  }
  const netstat = run('netstat', ['-ltnp']);
  if (!netstat.error && netstat.status === 0 && (netstat.stdout || '').trim()) {
    return parseNetstatOutput(netstat.stdout);
  }
  return [];
}

function parseSsOutput(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^(LISTEN|UNCONN)\s+\S+\s+\S+\s+(\S+)\s+users:\(\("([^"]+)",pid=(\d+)/);
    if (!m) continue;
    const [, , local, name, pid] = m;
    const { address, port } = splitHostPort(local);
    if (port === null) continue;
    rows.push({ address, port, processId: Number(pid), name, executable: null, commandLine: null, startTime: null });
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
    const looksLikeEdge = serviceReachable === true || /nginx/i.test(processInfo.name || '');
    if (looksLikeEdge) {
      return {
        port, role,
        state: LISTENER_STATES.EXPECTED_SERVICE,
        outcome: PORT_OUTCOMES.EXPECTED_SERVICE,
        reason: 'expected edge service',
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
  if (listener) {
    if (role === 'mongo') serviceReachable = await isPortOpen(port);
    else if (role === 'edge') {
      const probe = await probeHttp(`http://127.0.0.1:${port}/`);
      serviceReachable = probe.reachable;
    }
  }
  return classifyPort({ port, role, listener, processInfo, registryRecord, repoRoot, serviceReachable, managedByRecord });
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
 * Probe the full local topology over HTTP. Pure reachability + ownership
 * interpretation; no process management.
 */
export async function probeTopology({ edgeUrl = resolveEdgeUrl() } = {}) {
  const edgeRootUrl = `${edgeUrl}/`;
  const edgeApiUrl = `${edgeUrl}/api/auth/me`;
  const [go, next, edge, edgeApi, nextApi] = await Promise.all([
    probeHttp(GO_HEALTHZ),
    probeHttp(NEXT_ROOT),
    probeHttp(edgeRootUrl),
    probeHttp(edgeApiUrl),
    probeHttp(NEXT_DIRECT_API),
  ]);

  const goReady = go.reachable;
  const nextReady = next.reachable;
  const edgeReady = edge.reachable;
  const edgeApiRouted = edgeApi.reachable && edgeApi.status === 401;
  const directNextApi = classifyDirectNextApi(nextApi);

  let result;
  // An architecture violation outranks every topology state: a Next.js listener that
  // answers the authentication API is a contract breach, not a "Next is up" reading.
  if (directNextApi === 'ARCHITECTURE_VIOLATION') result = TOPOLOGY_STATES.ARCHITECTURE_VIOLATION;
  else if (!goReady) result = TOPOLOGY_STATES.GO_DOWN;
  else if (!nextReady) result = TOPOLOGY_STATES.NEXT_DOWN;
  else if (!edgeReady) result = TOPOLOGY_STATES.EDGE_REQUIRED;
  else if (!edgeApiRouted) result = TOPOLOGY_STATES.EDGE_API_MISROUTED;
  else result = TOPOLOGY_STATES.FULL_STACK_READY;

  return {
    edgeUrl, edgeRootUrl, edgeApiUrl,
    go, next, edge, edgeApi, nextApi,
    goReady, nextReady, edgeReady, edgeApiRouted, directNextApi, result,
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
