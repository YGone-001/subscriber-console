#!/usr/bin/env node
/**
 * Managed local development startup.
 *
 * Responsibility: manage ONLY the project-owned local Go + Vite frontend development
 * processes, and record their ownership so `local:stop` can later verify them.
 *
 * It never installs, starts, or enables MongoDB or Nginx. Normal local development
 * uses the Vite dev server at 0.0.0.0:13333 which proxies /api requests directly
 * to Go at 127.0.0.1:18888. Nginx is not required for local development. The Vite
 * bind is deliberately 0.0.0.0 so a same-subnet client can open the host LAN
 * address; Go remains loopback-only and is still never a browser entry point.
 *
 * The Go child is started with the PRODUCTION default listen address. HTTP_ADDR is
 * explicitly removed from the child environment so the managed path genuinely
 * exercises 127.0.0.1:18888.
 *
 * Lifecycle safety: each managed child obtains a durable ownership record
 * immediately after spawn and process inspection, BEFORE any readiness polling can
 * fail. A later startup failure rolls the already-registered children back in reverse
 * order through the same verified ownership mechanism `local:stop` uses, so no exit
 * path can leave a live process without a record. Every exit path reports
 * `local_dev_unmanaged_live_processes`.
 *
 * Usage:
 *   npm run local:dev
 */

import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CANONICAL_PORTS,
  FRONTEND_ROOT,
  PORT_OUTCOMES,
  countUnmanagedLiveProcesses,
  inspectPort,
  inspectProcess,
  probeTopology,
  readRecord,
  runtimeDir,
  startManagedProcesses,
  verifyOwnership,
  waitForHttpReady,
  waitForPort,
} from './lib/local-runtime.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const NODE_BIN = process.execPath;
const VITE_BIN = join(ROOT, 'frontend', 'node_modules', 'vite', 'bin', 'vite.js');
const GO_BIN_NAME = process.platform === 'win32' ? 'xcloud-server.exe' : 'xcloud-server';
const GO_BIN = join(runtimeDir(ROOT), 'bin', GO_BIN_NAME);
const FRONTEND_ARGS = ['--host', '0.0.0.0', '--port', String(CANONICAL_PORTS.frontend), '--strictPort'];
const FRONTEND_COMMAND = `${NODE_BIN} ${VITE_BIN} ${FRONTEND_ARGS.join(' ')}`;

const GO_READY_TIMEOUT_MS = Number(process.env.LOCAL_DEV_TIMEOUT_MS || 90000);
const FRONTEND_READY_TIMEOUT_MS = Number(process.env.LOCAL_DEV_FRONTEND_TIMEOUT_MS || 90000);

/** Minimal `.env` reader. Existing process environment always wins. */
function loadEnvFile(root) {
  const file = join(root, '.env');
  if (!existsSync(file)) return {};
  const out = {};
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

function childEnv() {
  const merged = { ...loadEnvFile(ROOT), ...process.env };
  // Exercise the production Go default. The managed path must bind 127.0.0.1:18888.
  delete merged.HTTP_ADDR;
  return merged;
}

/**
 * Derive the MongoDB endpoint this command should probe for reachability.
 *
 * local:dev never starts or owns MongoDB; it only verifies that the database the Go
 * child is about to connect to answers. The probe therefore follows MONGODB_URI
 * instead of assuming a loopback database, so a remote MongoDB (for example
 * 10.10.0.139:27017) is accepted. It falls back to the canonical loopback port when
 * the URI is absent or cannot be parsed.
 */
function mongoProbeTarget(env) {
  const fallback = { host: '127.0.0.1', port: CANONICAL_PORTS.mongo };
  if (!env.MONGODB_URI) return fallback;
  try {
    const parsed = new URL(env.MONGODB_URI);
    const host = parsed.hostname || fallback.host;
    const port = Number(parsed.port) || fallback.port;
    return { host, port };
  } catch {
    return fallback;
  }
}

function runSync(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024, ...options });
}

function tail(text, lines = 12) {
  const parts = String(text || '').trim().split('\n');
  return parts.slice(Math.max(0, parts.length - lines)).join('\n');
}

function log(message = '') {
  console.log(message);
}

function startDetached(command, args, { cwd, env, logFile }) {
  const fd = openSync(logFile, 'a');
  const child = spawn(command, args, {
    cwd,
    env,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', fd, fd],
  });
  child.unref();
  closeSync(fd);
  return child;
}

function logStartupEvent(event) {
  switch (event.type) {
    case 'spawned':
      log(`  ${event.role}: spawned (pid ${event.pid})`);
      break;
    case 'registered':
      log(`  ${event.role}: ownership recorded -> ${event.role}.pid.json (pid ${event.pid})`);
      break;
    case 'ready-start':
      log(`  ${event.role}: waiting for readiness`);
      break;
    case 'ready-ok':
      log(`  ${event.role}: ready`);
      break;
    case 'ready-fail':
      log(`  ${event.role}: readiness FAILED`);
      break;
    case 'ready-error':
      log(`  ${event.role}: readiness probe error (${event.message})`);
      break;
    case 'register-failed':
      log(`  ${event.role}: ownership record FAILED (${event.reason})`);
      break;
    case 'register-released':
      log(`  ${event.role}: unregistered child released (pid ${event.pid}, escalation ${event.escalated ? 'used' : 'not needed'})`);
      break;
    case 'register-release-failed':
      log(`  ${event.role}: UNREGISTERED CHILD COULD NOT BE RELEASED (pid ${event.pid}): ${event.reason}`);
      break;
    case 'rollback-start':
      log(`  rolling back registered processes: ${event.message}`);
      break;
    case 'rollback-stop':
      log(`  ${event.role}: rolled back (${event.status})`);
      break;
    default:
      break;
  }
}

async function alreadyManaged(root) {
  const existing = [];
  for (const role of ['go', 'frontend']) {
    const record = readRecord(root, role);
    if (!record) continue;
    const info = await inspectProcess(record.pid);
    const ownership = verifyOwnership(record, info);
    if (ownership.verdict === 'OWNED') existing.push({ role, record, ownership });
  }
  return existing;
}

/** Run the startup sequence and return the exit report. Never exits by itself. */
async function run() {
  log('Local managed development startup');
  log(`  Repository   : ${ROOT}`);
  log(`  Frontend URL : ${FRONTEND_ROOT}`);
  log('');

  const bail = (result = 'FULL_STACK_NOT_READY') => ({
    exitCode: 1, result, doctorReady: false, reachedTopology: false,
  });

  // 1. Preflight (read-only port/ownership inspection).
  log('[1/8] Preflight');
  const preflight = runSync(NODE_BIN, [join('scripts', 'check-local-preflight.mjs')], { cwd: ROOT });
  process.stdout.write(preflight.stdout || '');
  if (preflight.status !== 0) {
    log('');
    log('FULL_STACK_NOT_READY');
    log('Preflight found canonical port contamination. Resolve the owner above; do not change the port.');
    log('See docs/operations/deployment.md (Local troubleshooting matrix).');
    return bail();
  }

  // Refuse to double-start.
  const managed = await alreadyManaged(ROOT);
  if (managed.length > 0) {
    log('');
    log(`Already managed: ${managed.map((m) => `${m.role} (pid ${m.record.pid})`).join(', ')}`);
    log('Run `npm run local:stop` first if you want a clean restart.');
    return bail();
  }

  const env = childEnv();

  // 2. MongoDB reachability. The probe follows MONGODB_URI: this command never owns
  //    MongoDB, so it verifies whichever database the Go child will actually use
  //    (loopback by default, or a remote host such as 10.10.0.139:27017).
  log('[2/8] MongoDB');
  const mongo = mongoProbeTarget(env);
  const mongoOpen = await waitForPort(mongo.port, { host: mongo.host, timeoutMs: 5000 });
  if (!mongoOpen) {
    log(`  MongoDB is not reachable on ${mongo.host}:${mongo.port}.`);
    log('  Start MongoDB yourself; this command never starts it.');
    log('');
    log('FULL_STACK_NOT_READY');
    return bail();
  }
  log(`  reachable on ${mongo.host}:${mongo.port}`);

  // 3. Canonical internal ports must be free before this command creates them.
  log('[3/8] Canonical internal ports');
  for (const [role, port] of [['frontend', CANONICAL_PORTS.frontend], ['go', CANONICAL_PORTS.go]]) {
    const result = await inspectPort(port, { role, repoRoot: ROOT });
    if (result.outcome !== PORT_OUTCOMES.PORT_FREE) {
      log(`  ${role} port ${port} is ${result.outcome} (${result.reason}).`);
      log('  Refusing to start. Diagnose the owner; do not change the port.');
      return bail();
    }
    log(`  ${role} port ${port} is free`);
  }

  if (!env.JWT_SECRET) {
    log('');
    log('JWT_SECRET is not set. The Go backend fails closed without it.');
    log('Set JWT_SECRET (>= 32 bytes), for example in a local .env file, then retry.');
    return bail();
  }

  mkdirSync(runtimeDir(ROOT), { recursive: true });
  mkdirSync(join(runtimeDir(ROOT), 'bin'), { recursive: true });
  const goLog = join(runtimeDir(ROOT), 'go.log');
  const frontendLog = join(runtimeDir(ROOT), 'frontend.log');

  // 4. Go build. Performed before the transaction so a build failure cannot orphan a
  //    process: nothing has been spawned yet.
  log('[4/8] Go backend build');
  const build = runSync('go', ['build', '-o', GO_BIN, './cmd/server'], { cwd: join(ROOT, 'backend'), env });
  if (build.error || build.status !== 0) {
    log('  go build failed.');
    log(tail(build.stderr || build.stdout || (build.error && build.error.message)));
    return bail();
  }
  log(`  built ${GO_BIN}`);

  // 5. Frontend binary presence. Also checked before the transaction for the same reason.
  log('[5/8] Frontend Vite binary');
  if (!existsSync(VITE_BIN)) {
    log(`  Vite binary not found at ${VITE_BIN}. Run \`npm ci\` in frontend/.`);
    return bail();
  }
  log(`  found ${VITE_BIN}`);

  // 6. Atomic managed startup: spawn -> inspect -> write record -> THEN readiness.
  //    Any failure rolls the registered children back in reverse order.
  log('[6/8] Managed startup (atomic ownership)');
  const startup = await startManagedProcesses({
    repoRoot: ROOT,
    env,
    entries: [
      {
        role: 'go',
        command: GO_BIN,
        spawn: () => startDetached(GO_BIN, [], { cwd: join(ROOT, 'backend'), env, logFile: goLog }),
        waitForReady: async () => {
          const ready = await waitForHttpReady(`http://127.0.0.1:${CANONICAL_PORTS.go}/healthz`, { timeoutMs: GO_READY_TIMEOUT_MS });
          return Boolean(ready && ready.reachable);
        },
      },
      {
        role: 'frontend',
        command: FRONTEND_COMMAND,
        spawn: () => startDetached(NODE_BIN, [VITE_BIN, ...FRONTEND_ARGS], { cwd: join(ROOT, 'frontend'), env, logFile: frontendLog }),
        waitForReady: async () => {
          const ready = await waitForHttpReady(FRONTEND_ROOT, { timeoutMs: FRONTEND_READY_TIMEOUT_MS });
          return Boolean(ready && ready.reachable);
        },
      },
    ],
    onEvent: logStartupEvent,
  });

  if (!startup.ok) {
    log('');
    log('FULL_STACK_NOT_READY');
    log(`Managed startup failed: ${startup.error && startup.error.message ? startup.error.message : startup.error}`);
    log('Rollback ran through the verified ownership mechanism; records were removed only');
    log('after each process was confirmed gone.');
    if (existsSync(goLog)) log(tail(readFileSync(goLog, 'utf8')));
    if (existsSync(frontendLog)) log(tail(readFileSync(frontendLog, 'utf8')));
    return {
      exitCode: 1, result: 'FULL_STACK_NOT_READY', doctorReady: false,
      reachedTopology: false, goLog, frontendLog, cleanupFailure: startup.cleanupFailure,
    };
  }
  for (const item of startup.registered) log(`  ${item.role}.pid.json -> pid ${item.pid}`);
  log(`  Go       ready on 127.0.0.1:${CANONICAL_PORTS.go}`);
  log(`  Frontend ready on 0.0.0.0:${CANONICAL_PORTS.frontend}`);

  // 7. Readiness via the doctor; never claim full readiness on our own.
  log('[7/8] Topology');
  const topology = await probeTopology();
  log(`  ${topology.result}`);

  log('[8/8] Doctor');
  const doctor = runSync(NODE_BIN, [join('scripts', 'check-local-stack.mjs')], { cwd: ROOT, env: process.env });
  process.stdout.write(doctor.stdout || '');
  const doctorReady = /^local_stack_result=FULL_STACK_READY$/m.test(doctor.stdout || '');

  return {
    exitCode: doctorReady ? 0 : 1,
    result: doctorReady ? 'FULL_STACK_READY' : topology.result,
    doctorReady,
    reachedTopology: true,
    goLog,
    frontendLog,
  };
}

async function main() {
  let report;
  try {
    report = await run();
  } catch (err) {
    log('');
    log(`local:dev failed: ${err && err.message ? err.message : err}`);
    report = {
      exitCode: 2, result: 'FULL_STACK_NOT_READY', doctorReady: false, reachedTopology: false,
    };
  }

  // Required startup-failure invariant: no live project process may be left without a
  // durable ownership record on any exit path.
  let unmanaged = [];
  try {
    unmanaged = await countUnmanagedLiveProcesses({ repoRoot: ROOT });
  } catch {
    /* best effort: the count is a safety report, not a gate on shutdown */
  }

  const cleanupFailure = report.cleanupFailure || null;
  if (cleanupFailure) {
    log('');
    log('FATAL_UNMANAGED_CHILD_CLEANUP_FAILED');
    log(`  ${cleanupFailure.role}: the exact child spawned by this run (pid ${cleanupFailure.pid})`);
    log(`  could not be confirmed gone: ${cleanupFailure.reason}.`);
    log('  A project process is alive without a durable ownership record.');
    log('  Inspect it with `npm run local:preflight`; terminate it manually only after');
    log('  confirming its executable and command line.');
  }

  log('');
  log('==================================================');
  if (cleanupFailure) log('local_dev_unmanaged_child_cleanup=FAILED');
  if (report.doctorReady) {
    log('FULL_STACK_READY');
    log(`Open: ${FRONTEND_ROOT}`);
    log('local_dev_result=FULL_STACK_READY');
  } else {
    log('FULL_STACK_NOT_READY');
    log(`local_dev_result=${report.result}`);
    if (report.goLog && existsSync(report.goLog)) log(`Go log       : ${report.goLog}`);
    if (report.frontendLog) log(`Frontend log : ${report.frontendLog}`);
  }
  log('local_dev_nginx_required=0');
  log('local_dev_next_required=0');
  log('local_dev_vite_required=1');
  log(`local_dev_unmanaged_live_processes=${cleanupFailure ? 'UNKNOWN' : unmanaged.length}`);
  for (const result of unmanaged) {
    log(`  unmanaged canonical port ${result.port} (${result.role}) -> ${result.outcome}: ${result.reason}`);
    log('  A project process is live without a valid ownership record.');
    log('  Diagnose with `npm run local:preflight`, then stop it with `npm run local:stop`.');
  }
  log('==================================================\n');

  process.exit(report.exitCode);
}

main().catch((err) => {
  console.error(`local:dev failed: ${err && err.message ? err.message : err}`);
  process.exit(2);
});
