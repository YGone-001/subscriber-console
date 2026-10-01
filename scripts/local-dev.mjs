#!/usr/bin/env node
/**
 * Managed local development startup.
 *
 * Responsibility: manage ONLY the project-owned local Go + Next development
 * processes, and record their ownership so `local:stop` can later verify them.
 *
 * It never installs, starts, or enables MongoDB or Nginx. If the Nginx edge is
 * absent it reports FULL_STACK_NOT_READY / EDGE_REQUIRED and prints the manual
 * instruction; it never fabricates a Node proxy to stand in for the edge.
 *
 * The Go child is started with the PRODUCTION default listen address. HTTP_ADDR is
 * explicitly removed from the child environment so the managed path genuinely
 * exercises 127.0.0.1:18888.
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
  DEFAULT_EDGE_URL,
  PORT_OUTCOMES,
  buildRecord,
  inspectPort,
  inspectProcess,
  probeHttp,
  probeTopology,
  readRecord,
  resolveEdgeUrl,
  runtimeDir,
  verifyOwnership,
  waitForHttpReady,
  waitForPort,
  writeRecord,
} from './lib/local-runtime.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const NODE_BIN = process.execPath;
const NEXT_BIN = join(ROOT, 'frontend', 'node_modules', 'next', 'dist', 'bin', 'next');
const GO_BIN_NAME = process.platform === 'win32' ? 'xcloud-server.exe' : 'xcloud-server';
const GO_BIN = join(runtimeDir(ROOT), 'bin', GO_BIN_NAME);

const GO_READY_TIMEOUT_MS = Number(process.env.LOCAL_DEV_TIMEOUT_MS || 90000);
const NEXT_READY_TIMEOUT_MS = Number(process.env.LOCAL_DEV_NEXT_TIMEOUT_MS || 180000);

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

async function alreadyManaged(root) {
  const existing = [];
  for (const role of ['go', 'next']) {
    const record = readRecord(root, role);
    if (!record) continue;
    const info = await inspectProcess(record.pid);
    const ownership = verifyOwnership(record, info);
    if (ownership.verdict === 'OWNED') existing.push({ role, record, ownership });
  }
  return existing;
}

async function main() {
  const edgeUrl = resolveEdgeUrl();
  log('Local managed development startup');
  log(`  Repository : ${ROOT}`);
  log(`  Edge URL   : ${edgeUrl}`);
  log('');

  // 1. Preflight (read-only port/ownership inspection).
  log('[1/9] Preflight');
  const preflight = runSync(NODE_BIN, [join('scripts', 'check-local-preflight.mjs')], { cwd: ROOT });
  process.stdout.write(preflight.stdout || '');
  if (preflight.status !== 0) {
    log('');
    log('FULL_STACK_NOT_READY');
    log('Preflight found canonical port contamination. Resolve the owner above; do not change the port.');
    log('See docs/operations/deployment.md (Local troubleshooting matrix).');
    process.exit(1);
  }

  // 0. Refuse to double-start.
  const managed = await alreadyManaged(ROOT);
  if (managed.length > 0) {
    log('');
    log(`Already managed: ${managed.map((m) => `${m.role} (pid ${m.record.pid})`).join(', ')}`);
    log('Run `npm run local:stop` first if you want a clean restart.');
    process.exit(1);
  }

  // 2. MongoDB reachability.
  log('[2/9] MongoDB');
  const mongoOpen = await waitForPort(CANONICAL_PORTS.mongo, { timeoutMs: 5000 });
  if (!mongoOpen) {
    log(`  MongoDB is not reachable on 127.0.0.1:${CANONICAL_PORTS.mongo}.`);
    log('  Start MongoDB yourself; this command never starts it.');
    log('');
    log('FULL_STACK_NOT_READY');
    process.exit(1);
  }
  log(`  reachable on 127.0.0.1:${CANONICAL_PORTS.mongo}`);

  // 3. Nginx edge presence (not managed here).
  log('[3/9] Nginx edge');
  const edgeProbe = await probeHttp(`${edgeUrl}/`);
  const edgeReady = edgeProbe.reachable;
  if (edgeReady) log(`  edge answered at ${edgeUrl}/`);
  else log(`  edge is NOT available at ${edgeUrl}/ (FULL_STACK_NOT_READY until it is)`);

  // 4/5. Canonical internal ports must be free before this command creates them.
  log('[4/9] Canonical internal ports');
  for (const [role, port] of [['next', CANONICAL_PORTS.next], ['go', CANONICAL_PORTS.go]]) {
    const result = await inspectPort(port, { role, repoRoot: ROOT });
    if (result.outcome !== PORT_OUTCOMES.PORT_FREE) {
      log(`  ${role} port ${port} is ${result.outcome} (${result.reason}).`);
      log('  Refusing to start. Diagnose the owner; do not change the port.');
      process.exit(1);
    }
    log(`  ${role} port ${port} is free`);
  }

  const env = childEnv();
  if (!env.JWT_SECRET) {
    log('');
    log('JWT_SECRET is not set. The Go backend fails closed without it.');
    log('Set JWT_SECRET (>= 32 bytes), for example in a local .env file, then retry.');
    process.exit(1);
  }

  mkdirSync(runtimeDir(ROOT), { recursive: true });
  mkdirSync(join(runtimeDir(ROOT), 'bin'), { recursive: true });

  // 6. Go: build, then run with the production default listen address.
  log('[5/9] Go backend');
  const build = runSync('go', ['build', '-o', GO_BIN, './cmd/server'], { cwd: join(ROOT, 'backend'), env });
  if (build.error || build.status !== 0) {
    log('  go build failed.');
    log(tail(build.stderr || build.stdout || (build.error && build.error.message)));
    process.exit(1);
  }
  const goLog = join(runtimeDir(ROOT), 'go.log');
  const goChild = startDetached(GO_BIN, [], { cwd: join(ROOT, 'backend'), env, logFile: goLog });
  const goReady = await waitForHttpReady(`http://127.0.0.1:${CANONICAL_PORTS.go}/healthz`, { timeoutMs: GO_READY_TIMEOUT_MS });
  if (!goReady || !goReady.reachable) {
    log(`  Go did not become reachable on 127.0.0.1:${CANONICAL_PORTS.go}/healthz.`);
    log(`  Log: ${goLog}`);
    if (existsSync(goLog)) log(tail(readFileSync(goLog, 'utf8')));
    process.exit(1);
  }
  log(`  ready on 127.0.0.1:${CANONICAL_PORTS.go} (pid ${goChild.pid})`);

  // 7. Next: the documented `npm run dev` contract.
  log('[6/9] Next.js UI');
  if (!existsSync(NEXT_BIN)) {
    log(`  Next binary not found at ${NEXT_BIN}. Run \`npm ci\` in frontend/.`);
    process.exit(1);
  }
  const nextLog = join(runtimeDir(ROOT), 'next.log');
  const nextChild = startDetached(
    NODE_BIN,
    [NEXT_BIN, 'dev', '--webpack', '-H', '127.0.0.1', '-p', String(CANONICAL_PORTS.next)],
    { cwd: join(ROOT, 'frontend'), env, logFile: nextLog },
  );
  const nextReady = await waitForHttpReady(`http://127.0.0.1:${CANONICAL_PORTS.next}/`, { timeoutMs: NEXT_READY_TIMEOUT_MS });
  if (!nextReady || !nextReady.reachable) {
    log(`  Next did not become reachable on 127.0.0.1:${CANONICAL_PORTS.next}.`);
    log(`  Log: ${nextLog}`);
    if (existsSync(nextLog)) log(tail(readFileSync(nextLog, 'utf8')));
    process.exit(1);
  }
  log(`  ready on 127.0.0.1:${CANONICAL_PORTS.next} (pid ${nextChild.pid})`);

  // 8. Ownership records (written only for processes this command launched).
  log('[7/9] Ownership records');
  for (const [role, child, command] of [
    ['go', goChild, GO_BIN],
    ['next', nextChild, `${NODE_BIN} ${NEXT_BIN} dev --webpack -H 127.0.0.1 -p ${CANONICAL_PORTS.next}`],
  ]) {
    const info = await inspectProcess(child.pid, { refresh: true });
    const record = buildRecord({ role, pid: child.pid, command, repoRoot: ROOT, processInfo: info });
    writeRecord(ROOT, role, record);
    log(`  ${role}.pid.json -> pid ${record.pid}`);
  }

  // 9. Readiness via the doctor; never claim full readiness on our own.
  log('[8/9] Topology');
  const topology = await probeTopology({ edgeUrl });
  log(`  ${topology.result}`);

  log('[9/9] Doctor');
  const doctor = runSync(NODE_BIN, [join('scripts', 'check-local-stack.mjs')], {
    cwd: ROOT,
    env: { ...process.env, XCLOUD_EDGE_URL: edgeUrl },
  });
  process.stdout.write(doctor.stdout || '');
  const doctorReady = /^local_stack_result=FULL_STACK_READY$/m.test(doctor.stdout || '');

  log('');
  log('==================================================');
  if (doctorReady) {
    log('FULL_STACK_READY');
    log(`Open: ${edgeUrl || DEFAULT_EDGE_URL}`);
    log(`local_dev_result=FULL_STACK_READY`);
  } else {
    log('FULL_STACK_NOT_READY');
    if (!edgeReady) {
      log('EDGE_REQUIRED');
      log('Go and Next are running, but the Nginx edge is missing.');
      log('Start the edge, then re-check with `npm run local:doctor`:');
      log('  sudo ./deploy/nginx/setup.sh');
    }
    log(`local_dev_result=${topology.result}`);
    if (existsSync(join(runtimeDir(ROOT), 'go.log'))) log(`Go log  : ${join(runtimeDir(ROOT), 'go.log')}`);
    log(`Next log: ${join(runtimeDir(ROOT), 'next.log')}`);
  }
  log('==================================================\n');

  // Do not leave a half-started stack unmanaged silently: the records exist, so
  // `npm run local:stop` can clean up either outcome.
  process.exit(doctorReady ? 0 : 1);
}

main().catch(async (err) => {
  console.error(`local:dev failed: ${err && err.message ? err.message : err}`);
  process.exit(2);
});
