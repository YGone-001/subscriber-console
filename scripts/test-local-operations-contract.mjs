#!/usr/bin/env node
/**
 * Local development operations contract.
 *
 * Permanent, phase-neutral gate proving the process-safety properties of the local
 * runtime tooling:
 *
 *   O1  no arbitrary kill behavior
 *   O2  foreign listener is detected and preserved
 *   O3  an owned (registered, verified) process can be stopped
 *   O4  a stale PID record is safe
 *   O5  an identity mismatch is refused (REFUSE_TO_KILL)
 *
 * Synthetic child processes are used deliberately: the canonical production ports are
 * never used for the process-safety scenarios.
 *
 * Usage:
 *   node scripts/test-local-operations-contract.mjs
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CANONICAL_PORTS, RUNTIME_DIR_NAME } from './lib/local-runtime.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const checks = [];
function check(id, ok, detail = '') {
  checks.push({ id, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}${detail ? `  ${detail}` : ''}`);
}

function readFile(rel) {
  return readFileSync(resolve(ROOT, rel), 'utf8');
}

function runNode(args, { env = {}, cwd = ROOT } = {}) {
  const res = spawnSync(process.execPath, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function freePort() {
  return new Promise((res, rej) => {
    const server = net.createServer();
    server.on('error', rej);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => res(port));
    });
  });
}

async function waitUntil(fn, timeoutMs = 8000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

const CHILD_SOURCE = `import net from 'node:net';
const port = Number(process.argv[2] || 0);
if (port) {
  const server = net.createServer();
  server.listen(port, '127.0.0.1');
}
setInterval(() => {}, 1000);
`;

const children = [];
function spawnChild(scriptPath, args = []) {
  const child = spawn(process.execPath, [scriptPath, ...args], {
    stdio: 'ignore',
    windowsHide: true,
  });
  children.push(child);
  return child;
}

function cleanupChildren() {
  for (const child of children) {
    try { child.kill(); } catch { /* already gone */ }
  }
}

// ---------------------------------------------------------------------------
// O1 — no arbitrary kill behavior (static)
// ---------------------------------------------------------------------------

/**
 * Strip comments so the assertion targets executable code. Documentation that names a
 * forbidden pattern is allowed; implementing one is not.
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

function testNoArbitraryKill() {
  const files = [
    'scripts/local-stop.mjs',
    'scripts/local-dev.mjs',
    'scripts/lib/local-runtime.mjs',
    'scripts/check-local-preflight.mjs',
  ];
  const forbidden = [
    { re: /\bpkill\b/, label: 'pkill' },
    { re: /\bkillall\b/, label: 'killall' },
    { re: /taskkill[^\n]*\/IM\b/i, label: 'taskkill by image name' },
    { re: /Stop-Process[^\n]*-Name\b/i, label: 'Stop-Process by name' },
    { re: /netstat[^\n]*\|\s*(?:taskkill|Stop-Process)/i, label: 'netstat piped to kill' },
  ];
  let violations = 0;
  for (const rel of files) {
    const code = stripComments(readFile(rel));
    for (const rule of forbidden) {
      if (rule.re.test(code)) {
        violations += 1;
        console.log(`  forbidden pattern (${rule.label}) in ${rel}`);
      }
    }
  }
  check('O1-no-forbidden-kill-patterns', violations === 0, `violations=${violations}`);

  // local:stop must never resolve a port to a kill target.
  const stop = readFile('scripts/local-stop.mjs');
  check('O1-stop-does-not-resolve-ports', !/inspectPort\(|CANONICAL_PORTS/.test(stop));

  // Termination is gated on proven ownership.
  const lib = readFile('scripts/lib/local-runtime.mjs');
  check(
    'O1-termination-gated-on-ownership',
    /terminateVerifiedProcess/.test(lib) && /ownership\.verdict\s*!==\s*'OWNED'/.test(lib),
  );
  check('O1-stop-uses-verified-termination', /terminateVerifiedProcess/.test(stop) && /verifyOwnership/.test(stop));
}

// ---------------------------------------------------------------------------
// Static capability + architecture assertions
// ---------------------------------------------------------------------------
function testToolPresence() {
  const pkg = JSON.parse(readFile('package.json'));
  const scripts = pkg.scripts || {};
  check('present-preflight', typeof scripts['local:preflight'] === 'string');
  check('present-dev', typeof scripts['local:dev'] === 'string');
  check('present-status', typeof scripts['local:status'] === 'string');
  check('present-doctor', typeof scripts['local:doctor'] === 'string');
  check('present-stop', typeof scripts['local:stop'] === 'string');

  check('canonical-next-port', CANONICAL_PORTS.next === 13333);
  check('canonical-go-port', CANONICAL_PORTS.go === 18888);

  const lib = readFile('scripts/lib/local-runtime.mjs');
  const bypass = /XCLOUD_(?:NEXT|GO)_PORT/.test(lib);
  check('no-canonical-port-bypass', !bypass);

  const nginx = readFile('deploy/nginx/xcloud.conf');
  const activeLines = nginx.split('\n').filter((line) => !line.trim().startsWith('#'));
  const listens = activeLines.map((line) => line.match(/^\s*listen\s+(\d+)/)).filter(Boolean).map((m) => Number(m[1]));
  check('active-http-edge-port-80', listens.includes(80));
  check('https-not-active-by-default', !listens.includes(443));

  const apiLocationRouted = /location\s*=\s*\/api\s*\{[\s\S]*?proxy_pass\s+http:\/\/xcloud_go;/.test(nginx)
    && /upstream\s+xcloud_go\s*\{[\s\S]*?127\.0\.0\.1:18888/.test(nginx);
  check('browser-api-owner-nginx-to-go', apiLocationRouted);

  const proxy = readFile('frontend/src/proxy.ts');
  check(
    'next-auth-authority-direct-loopback',
    proxy.includes('127.0.0.1:18888') && proxy.includes('/api/auth/me'),
  );
}

function testDocumentation() {
  const agents = readFile('AGENTS.md');
  const claude = readFile('CLAUDE.md');
  check('agents-contamination-rule', /Never resolve canonical port contamination by changing 13333\/18888/.test(agents));
  check('agents-preflight-rule', agents.includes('local:preflight'));
  check('agents-no-auto-kill-rule', /Never automatically kill an arbitrary listener/.test(agents));
  check('claude-preflight-rule', claude.includes('local:preflight') && claude.includes('13333/18888'));
}

// ---------------------------------------------------------------------------
// O2 — foreign listener detected and preserved
// ---------------------------------------------------------------------------
async function testForeignProtected() {
  const dir = join(tmpdir(), `local-ops-foreign-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const script = join(dir, 'foreign-listener.mjs');
  writeFileSync(script, CHILD_SOURCE, 'utf8');

  const port = await freePort();
  const child = spawnChild(script, [String(port)]);
  const listening = await waitUntil(() => isAlive(child.pid) && new Promise((res) => {
    const probe = net.connect(port, '127.0.0.1');
    probe.on('connect', () => { probe.destroy(); res(true); });
    probe.on('error', () => res(false));
  }));
  check('O2-foreign-child-listening', listening, `port=${port} pid=${child.pid}`);
  if (!listening) return;

  const registryDir = join(dir, 'empty-registry');
  mkdirSync(registryDir, { recursive: true });

  const preflight = runNode(['scripts/check-local-preflight.mjs'], {
    env: { XCLOUD_PREFLIGHT_EXTRA_PORTS: String(port), XCLOUD_RUNTIME_DIR: registryDir },
  });
  const detectedForeign = preflight.status !== 0
    && preflight.stdout.includes(`local_preflight_extra_${port}=FOREIGN_PROCESS`);
  check('O2-preflight-detects-foreign', detectedForeign, `exit=${preflight.status}`);
  if (!detectedForeign) {
    console.log(`--- preflight stdout ---\n${preflight.stdout}`);
    console.log(`--- preflight stderr ---\n${preflight.stderr}`);
  }

  const stop = runNode(['scripts/local-stop.mjs'], { env: { XCLOUD_RUNTIME_DIR: registryDir } });
  check('O2-stop-does-not-terminate-foreign', isAlive(child.pid), `alive=${isAlive(child.pid)}`);
  check('O2-stop-exit-clean', stop.status === 0, `exit=${stop.status}`);
}

// ---------------------------------------------------------------------------
// O3 — owned process can be stopped
// ---------------------------------------------------------------------------
async function testOwnedStopped() {
  const runtimeDir = resolve(ROOT, RUNTIME_DIR_NAME);
  mkdirSync(runtimeDir, { recursive: true });
  const script = join(runtimeDir, 'ops-owned-child.mjs');
  writeFileSync(script, CHILD_SOURCE, 'utf8');

  const port = await freePort();
  const child = spawnChild(script, [String(port)]);
  const started = await waitUntil(() => isAlive(child.pid));
  check('O3-owned-child-started', started, `pid=${child.pid}`);
  if (!started) return;

  const stateDir = join(runtimeDir, 'ops-state-owned');
  rmSync(stateDir, { recursive: true, force: true });
  mkdirSync(stateDir, { recursive: true });

  const info = JSON.parse(runNode([
    '-e',
    `import('./scripts/lib/local-runtime.mjs').then(async (m) => {
       const p = await m.inspectProcess(${child.pid}, { refresh: true });
       process.stdout.write(JSON.stringify(p));
     });`,
  ]).stdout || 'null');

  const record = {
    pid: child.pid,
    role: 'next',
    startedAt: new Date().toISOString(),
    command: info && info.commandLine ? info.commandLine : null,
    repositoryRoot: ROOT,
    executable: info ? info.executable : null,
    commandLineFingerprint: info ? info.commandLine : null,
    processStartTime: info ? info.startTime : null,
  };
  writeFileSync(join(stateDir, 'next.pid.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');

  const stop = runNode(['scripts/local-stop.mjs'], { env: { XCLOUD_RUNTIME_DIR: stateDir } });
  const stopped = await waitUntil(() => !isAlive(child.pid));
  check('O3-owned-child-stopped', stopped, `alive=${isAlive(child.pid)}`);
  check('O3-stop-reports-stopped', stop.stdout.includes('local_stop_next=STOPPED'), `exit=${stop.status}`);
  check('O3-record-removed', !existsSync(join(stateDir, 'next.pid.json')));
}

// ---------------------------------------------------------------------------
// O4 — stale PID record is safe
// ---------------------------------------------------------------------------
async function testStaleRecord() {
  const dir = join(tmpdir(), `local-ops-stale-${Date.now()}`);
  const stateDir = join(dir, 'state');
  mkdirSync(stateDir, { recursive: true });
  const script = join(dir, 'bystander.mjs');
  writeFileSync(script, CHILD_SOURCE, 'utf8');

  const child = spawnChild(script, []);
  const started = await waitUntil(() => isAlive(child.pid));
  check('O4-bystander-started', started, `pid=${child.pid}`);

  writeFileSync(join(stateDir, 'go.pid.json'), `${JSON.stringify({
    pid: 999999,
    role: 'go',
    startedAt: new Date().toISOString(),
    repositoryRoot: ROOT,
  }, null, 2)}\n`, 'utf8');

  const stop = runNode(['scripts/local-stop.mjs'], { env: { XCLOUD_RUNTIME_DIR: stateDir } });
  check('O4-stale-reported', stop.stdout.includes('local_stop_go=STALE'), `exit=${stop.status}`);
  check('O4-stale-record-removed', !existsSync(join(stateDir, 'go.pid.json')));
  check('O4-bystander-preserved', isAlive(child.pid));
}

// ---------------------------------------------------------------------------
// O5 — identity mismatch is refused
// ---------------------------------------------------------------------------
async function testIdentityMismatch() {
  const runtimeDir = resolve(ROOT, RUNTIME_DIR_NAME);
  mkdirSync(runtimeDir, { recursive: true });
  const script = join(runtimeDir, 'ops-mismatch-child.mjs');
  writeFileSync(script, CHILD_SOURCE, 'utf8');

  const child = spawnChild(script, []);
  const started = await waitUntil(() => isAlive(child.pid));
  check('O5-child-started', started, `pid=${child.pid}`);
  if (!started) return;

  const stateDir = join(runtimeDir, 'ops-state-mismatch');
  rmSync(stateDir, { recursive: true, force: true });
  mkdirSync(stateDir, { recursive: true });

  // Same PID, but the recorded command line does not match the live process.
  writeFileSync(join(stateDir, 'go.pid.json'), `${JSON.stringify({
    pid: child.pid,
    role: 'go',
    startedAt: new Date().toISOString(),
    command: 'some-other-binary --serve',
    commandLineFingerprint: 'some-other-binary --serve',
  }, null, 2)}\n`, 'utf8');

  const stop = runNode(['scripts/local-stop.mjs'], { env: { XCLOUD_RUNTIME_DIR: stateDir } });
  check('O5-refused', stop.stdout.includes('REFUSE_TO_KILL'), `exit=${stop.status}`);
  check('O5-child-preserved', isAlive(child.pid));
  check('O5-record-preserved', existsSync(join(stateDir, 'go.pid.json')));
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------
async function main() {
  console.log('Local development operations contract');
  console.log(`  Repository : ${ROOT}`);
  console.log('');

  console.log('O1 — no arbitrary kill behavior');
  testNoArbitraryKill();
  console.log('');

  console.log('Tool presence and architecture invariants');
  testToolPresence();
  console.log('');

  console.log('Documentation rules');
  testDocumentation();
  console.log('');

  console.log('O2 — foreign listener protection');
  await testForeignProtected();
  console.log('');

  console.log('O3 — owned process can be stopped');
  await testOwnedStopped();
  console.log('');

  console.log('O4 — stale PID record safety');
  await testStaleRecord();
  console.log('');

  console.log('O5 — identity mismatch refusal');
  await testIdentityMismatch();
  console.log('');

  const failures = checks.filter((c) => !c.ok);
  const passed = (id) => checks.some((c) => c.id === id && c.ok);

  console.log('==================================================');
  console.log(`local_ops_preflight_present=${passed('present-preflight')}`);
  console.log(`local_ops_managed_start_present=${passed('present-dev')}`);
  console.log(`local_ops_managed_stop_present=${passed('present-stop')}`);
  console.log(`local_ops_status_present=${passed('present-status')}`);
  console.log('');
  console.log(`local_ops_arbitrary_kill_allowed=${!passed('O1-no-forbidden-kill-patterns')}`);
  console.log(`local_ops_foreign_listener_preserved=${passed('O2-stop-does-not-terminate-foreign')}`);
  console.log(`local_ops_owned_process_stopped=${passed('O3-owned-child-stopped')}`);
  console.log(`local_ops_stale_pid_safe=${passed('O4-stale-record-removed') && passed('O4-bystander-preserved')}`);
  console.log(`local_ops_identity_mismatch_refused=${passed('O5-refused')}`);
  console.log('');
  console.log(`local_ops_canonical_next_port=${CANONICAL_PORTS.next}`);
  console.log(`local_ops_canonical_go_port=${CANONICAL_PORTS.go}`);
  console.log(`local_ops_port_bypass_allowed=${!passed('no-canonical-port-bypass')}`);
  console.log('');
  console.log(`local_ops_browser_api_owner=${passed('browser-api-owner-nginx-to-go') ? 'nginx_to_go' : 'UNKNOWN'}`);
  console.log(`local_ops_next_auth_authority_direct_loopback=${passed('next-auth-authority-direct-loopback')}`);
  console.log('');
  console.log(`local_ops_active_http_edge_port=${passed('active-http-edge-port-80') ? 80 : 'UNKNOWN'}`);
  console.log(`local_ops_https_default_active=${!passed('https-not-active-by-default')}`);
  console.log('');
  console.log(`local_ops_failures=${failures.length}`);
  console.log(`local_ops_result=${failures.length === 0 ? 'PASS' : 'FAIL'}`);
  console.log('==================================================\n');

  if (failures.length > 0) {
    for (const failure of failures) console.log(`FAILED: ${failure.id} ${failure.detail}`);
  }
}

main()
  .catch((err) => {
    check('contract-fatal', false, err && err.message ? err.message : String(err));
  })
  .finally(() => {
    cleanupChildren();
    const failures = checks.filter((c) => !c.ok);
    process.exit(failures.length === 0 ? 0 : 1);
  });
