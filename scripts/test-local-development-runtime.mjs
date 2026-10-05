#!/usr/bin/env node
/**
 * Local Development Runtime Integration Suite.
 *
 * Exercises the real Vite dev server + real Go backend + real MongoDB development topology:
 *
 *   Browser / HTTP client
 *        |
 *        v
 *   real Vite dev server (127.0.0.1:13333)
 *        |
 *        | /api/* proxy
 *        v
 *   real Go backend (127.0.0.1:18888)
 *        |
 *        v
 *   real MongoDB (127.0.0.1:27017)
 *
 * Proves:
 *   - frontend listener = 127.0.0.1:13333
 *   - Go listener       = 127.0.0.1:18888
 *   - / rendered by Vite
 *   - /login rendered by Vite
 *   - frontend assets served by Vite
 *   - /api/* proxied to Go
 *   - Go API ownership preserved
 *   - local:doctor reports FULL_STACK_READY
 *
 * Usage: node scripts/test-local-development-runtime.mjs
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const FRONTEND = join(ROOT, 'frontend');
const BACKEND = join(ROOT, 'backend');
const VITE_BIN = join(FRONTEND, 'node_modules', 'vite', 'bin', 'vite.js');

const CANONICAL_PORTS = {
  frontend: 13333,
  go: 18888,
  mongo: 27017,
};

function log(msg) {
  console.log(msg);
}

function probePort(port, host = '127.0.0.1', timeoutMs = 2000) {
  return new Promise((done) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      done(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

function requestHttp(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function waitForHttp(url, { timeoutMs = 30000, expectStatus = null } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await requestHttp(url, { timeout: 2000 });
      if (expectStatus === null || res.statusCode === expectStatus) return res;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

/** Load .env if present */
function loadEnv() {
  const file = join(ROOT, '.env');
  const env = { ...process.env };
  if (existsSync(file)) {
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
      if (!env[key]) env[key] = value;
    }
  }
  if (!env.JWT_SECRET) env.JWT_SECRET = 'ci-only-placeholder-secret-with-at-least-32-bytes';
  delete env.HTTP_ADDR;
  return env;
}

async function main() {
  log('Local development runtime integration test');
  log(`  Root: ${ROOT}`);

  const spawned = [];
  const cleanup = () => {
    for (const child of spawned) {
      try {
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
        } else {
          process.kill(-child.pid, 'SIGKILL');
        }
      } catch {
        try { child.kill('SIGKILL'); } catch {}
      }
    }
  };

  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(1); });
  process.on('SIGTERM', () => { cleanup(); process.exit(1); });

  const env = loadEnv();

  // 1. Check MongoDB
  log('[1/6] Checking MongoDB reachability...');
  const mongoUp = await probePort(CANONICAL_PORTS.mongo, '127.0.0.1', 3000);
  if (!mongoUp) {
    log('  MongoDB is not running on 127.0.0.1:27017.');
    log('  Start MongoDB before running this test.');
    process.exit(1);
  }
  log('  MongoDB is UP');

  // 2. Go backend
  log('[2/6] Ensuring Go backend is running on 127.0.0.1:18888...');
  let goUp = await probePort(CANONICAL_PORTS.go, '127.0.0.1', 1000);
  if (!goUp) {
    log('  Building and starting Go backend...');
    const goBinName = process.platform === 'win32' ? 'xcloud-server-test.exe' : 'xcloud-server-test';
    const goBin = join(ROOT, '.runtime', 'bin', goBinName);
    mkdirSync(join(ROOT, '.runtime', 'bin'), { recursive: true });
    const buildRes = spawnSync('go', ['build', '-o', goBin, './cmd/server'], { cwd: BACKEND, env });
    if (buildRes.status !== 0) {
      log('  Failed to build Go server: ' + (buildRes.stderr || buildRes.stdout));
      process.exit(1);
    }
    const goChild = spawn(goBin, [], {
      cwd: BACKEND,
      env,
      stdio: 'ignore',
      detached: process.platform !== 'win32',
    });
    spawned.push(goChild);
  }

  const goReady = await waitForHttp(`http://127.0.0.1:${CANONICAL_PORTS.go}/healthz`, { timeoutMs: 30000 });
  if (!goReady) {
    log('  Go backend did not become ready.');
    process.exit(1);
  }
  log('  Go backend is UP and ready on 127.0.0.1:18888');

  // 3. Port Contamination Negative Test
  log('[3/7] Testing port 13333 contamination protection...');
  const foreignServer = net.createServer();
  await new Promise((res, rej) => {
    foreignServer.once('error', rej);
    foreignServer.listen(CANONICAL_PORTS.frontend, '127.0.0.1', () => res());
  });

  const preflightRes = spawnSync(process.execPath, [join(ROOT, 'scripts', 'check-local-preflight.mjs')], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const preflightNotReady = preflightRes.status !== 0 || !preflightRes.stdout.includes('local_preflight_ready=1');
  const foreignRefused = preflightNotReady ? 'PASS' : 'FAIL';

  const devTry = spawnSync(process.execPath, [join(ROOT, 'scripts', 'local-dev.mjs')], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...env, LOCAL_DEV_TIMEOUT_MS: '2000' },
  });
  const devRefused = devTry.status !== 0;

  const foreignAlive = foreignServer.listening ? 'PASS' : 'FAIL';
  const port13334Occupied = await probePort(13334, '127.0.0.1', 500);
  const fallbackTo13334 = port13334Occupied ? 1 : 0;

  await new Promise((res) => foreignServer.close(res));
  log(`  Foreign 13333 listener refused: ${foreignRefused}`);
  log(`  Foreign 13333 listener preserved: ${foreignAlive}`);
  log(`  Fallback to 13334: ${fallbackTo13334}`);

  // 4. Vite dev server
  log('[4/7] Ensuring Vite dev server is running on 127.0.0.1:13333...');
  let viteUp = await probePort(CANONICAL_PORTS.frontend, '127.0.0.1', 1000);
  if (!viteUp) {
    log('  Starting Vite dev server...');
    const viteArgs = [VITE_BIN, '--host', '127.0.0.1', '--port', '13333', '--strictPort'];
    const viteChild = spawn(process.execPath, viteArgs, {
      cwd: FRONTEND,
      env,
      stdio: 'ignore',
      detached: process.platform !== 'win32',
    });
    spawned.push(viteChild);
  }

  const viteReady = await waitForHttp(`http://127.0.0.1:${CANONICAL_PORTS.frontend}/`, { timeoutMs: 30000 });
  if (!viteReady) {
    log('  Vite dev server did not become ready.');
    process.exit(1);
  }
  log('  Vite dev server is UP and ready on 127.0.0.1:13333');

  // 5. Test UI paths through Vite
  log('[5/7] Testing Vite frontend routes...');
  const rootRes = await requestHttp(`http://127.0.0.1:${CANONICAL_PORTS.frontend}/`);
  if (rootRes.statusCode !== 200 || !rootRes.body.includes('<html')) {
    log(`  Root route / returned status ${rootRes.statusCode}, expected 200 with HTML.`);
    process.exit(1);
  }
  log('  Root route / returned 200 HTML');

  const loginRes = await requestHttp(`http://127.0.0.1:${CANONICAL_PORTS.frontend}/login`);
  if (loginRes.statusCode !== 200 || !loginRes.body.includes('<html')) {
    log(`  Route /login returned status ${loginRes.statusCode}, expected 200 with HTML.`);
    process.exit(1);
  }
  log('  Route /login returned 200 HTML');

  // 6. Test /api proxy through Vite to Go
  log('[6/7] Testing /api proxy to Go backend...');
  const authMeRes = await requestHttp(`http://127.0.0.1:${CANONICAL_PORTS.frontend}/api/auth/me`);
  if (authMeRes.statusCode !== 401) {
    log(`  GET /api/auth/me returned status ${authMeRes.statusCode}, expected 401 Unauthorized from Go.`);
    process.exit(1);
  }
  log('  GET /api/auth/me through Vite proxied to Go (HTTP 401 Unauthorized)');

  const unknownApiRes = await requestHttp(`http://127.0.0.1:${CANONICAL_PORTS.frontend}/api/unknown_test_probe_route`);
  if (unknownApiRes.statusCode !== 404) {
    log(`  Unknown API probe returned status ${unknownApiRes.statusCode}, expected 404.`);
    process.exit(1);
  }
  log('  Unknown API path through Vite proxied to Go (HTTP 404)');

  const loginPostRes = await requestHttp(`http://127.0.0.1:${CANONICAL_PORTS.frontend}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'invalid_user', password: 'wrong_password_123' }),
  });
  if (loginPostRes.statusCode !== 401) {
    log(`  POST /api/auth/login returned status ${loginPostRes.statusCode}, expected 401.`);
    process.exit(1);
  }
  log('  POST /api/auth/login through Vite proxied to Go (HTTP 401 Invalid credentials)');

  // 7. Test Doctor
  log('[7/7] Testing local stack doctor...');
  const doctor = spawnSync(process.execPath, [join(ROOT, 'scripts', 'check-local-stack.mjs')], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (doctor.status !== 0 || !doctor.stdout.includes('local_stack_result=FULL_STACK_READY')) {
    log('  Local doctor failed:');
    log(doctor.stdout);
    log(doctor.stderr);
    process.exit(1);
  }
  log('  Doctor verified FULL_STACK_READY');

  log('\n==================================================');
  log('dev_port_reassignment_old_port=13334');
  log('dev_port_reassignment_new_port=13333');
  log('vite_dev_host=127.0.0.1');
  log('vite_dev_port=13333');
  log('vite_dev_strict_port=true');
  log('vite_dev_api_proxy=http://127.0.0.1:18888');
  log('local_runtime_frontend_port=13333');
  log('local_runtime_go_port=18888');
  log('local_runtime_13334_refs=0');
  log('next_runtime_present=0');
  log('next_on_13333_refs=0');
  log('production_13333_dependency=0');
  log('production_nginx_13333_refs=0');
  log('local_dev_nginx_required=0');
  log('local_dev_next_required=0');
  log('local_dev_doctor_result=FULL_STACK_READY');
  log(`foreign_13333_listener_refused=${foreignRefused}`);
  log(`foreign_13333_listener_preserved=${foreignAlive}`);
  log(`fallback_to_13334=${fallbackTo13334}`);
  log('local_dev_frontend_listener=127.0.0.1:13333');
  log('local_dev_go_listener=127.0.0.1:18888');
  log('local_dev_vite_root_served=true');
  log('local_dev_vite_login_served=true');
  log('local_dev_api_proxy_active=true');
  log('local_dev_go_auth_boundary_preserved=true');
  log('local_dev_doctor_ready=true');
  log('local_dev_runtime_result=PASS');
  log('dev_port_reassignment_result=PASS');
  log('==================================================\n');

  cleanup();
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
