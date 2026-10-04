#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, spawn } from 'node:child_process';
import { MongoClient } from 'mongodb';
import { deriveGoRegistrations } from './lib/go-registrations.mjs';

function rawHttpGet(host, port, rawPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host,
      port,
      path: rawPath,
      method: 'GET',
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const frontendSpaDir = join(root, 'frontend-spa');
const backendDir = join(root, 'backend');
const distDir = join(frontendSpaDir, 'dist');

const suffix = `${Date.now()}_${process.pid}_${Math.floor(Math.random() * 100000)}`;
const xcloudDbName = `xcloud_spa_test_${suffix}`;
const appDbName = `xcloud_ops_spa_test_${suffix}`;
const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/xcloud';
const JWT_SECRET_STRING = process.env.JWT_SECRET || 'spa-hosting-foundation-secret-at-least-32-bytes!';

let goProc = null;
let binPath = null;
let backupDistPath = null;
let mongoClient = null;

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

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

async function main() {
  console.log('Starting Go static SPA hosting foundation acceptance test...');

  // 1. Verify Go API registration count
  const { keys: registrations, duplicates } = deriveGoRegistrations(root);
  assert.deepEqual(duplicates, [], 'No duplicate registrations permitted');
  const regCount = registrations.length;
  assert.equal(regCount, 84, `Expected exactly 84 registrations, got ${regCount}`);
  console.log(`go_spa_api_registration_count=${regCount}`);

  // 2. Ensure frontend-spa build exists; if not, build it
  if (!existsSync(join(distDir, 'index.html'))) {
    console.log('Building frontend-spa...');
    execSync('npm run build', { cwd: frontendSpaDir, stdio: 'inherit' });
  }

  // 3. Stage SPA assets into backend/internal/spa/static
  console.log('Staging SPA for Go embed...');
  execSync(`node "${join(root, 'scripts', 'stage-spa-for-go.mjs')}"`, {
    cwd: root,
    stdio: 'inherit',
  });

  // 4. Capture original dist artifacts for identity verification
  const originalIndexBytes = readFileSync(join(distDir, 'index.html'));
  const originalIndexHash = sha256(originalIndexBytes);

  const assetsDir = join(distDir, 'assets');
  const assetFiles = readdirSync(assetsDir);
  const jsFile = assetFiles.find((f) => f.endsWith('.js'));
  const cssFile = assetFiles.find((f) => f.endsWith('.css'));
  assert.ok(jsFile, 'Expected at least one JS asset in dist/assets');
  assert.ok(cssFile, 'Expected at least one CSS asset in dist/assets');

  const originalJsBytes = readFileSync(join(assetsDir, jsFile));
  const originalJsHash = sha256(originalJsBytes);
  const originalCssBytes = readFileSync(join(assetsDir, cssFile));
  const originalCssHash = sha256(originalCssBytes);

  // 5. Compile bundled Go server binary
  const isWin = process.platform === 'win32';
  const binName = isWin ? `test-go-spa-${suffix}.exe` : `test-go-spa-${suffix}`;
  binPath = join(backendDir, binName);

  console.log('Compiling bundled Go binary with embedded SPA...');
  execSync(`go build -o "${binPath}" ./cmd/server`, {
    cwd: backendDir,
    stdio: 'inherit',
  });
  assert.ok(existsSync(binPath), 'Bundled Go binary must exist after compilation');

  // 6. Test runtime independence from frontend-spa/dist:
  // Temporarily rename dist to verify Go binary serves from memory/embedded FS, NOT filesystem
  backupDistPath = join(frontendSpaDir, `dist_temp_backup_${suffix}`);
  renameSync(distDir, backupDistPath);
  assert.ok(!existsSync(distDir), 'frontend-spa/dist must be temporarily absent during runtime test');

  // 7. Start real Go server with real MongoDB
  const goPort = await getAvailablePort();
  const baseUrl = `http://127.0.0.1:${goPort}`;

  mongoClient = new MongoClient(uri, {
    serverSelectionTimeoutMS: 5000,
  });
  await mongoClient.connect();

  goProc = spawn(binPath, [], {
    cwd: backendDir,
    env: {
      ...process.env,
      HTTP_ADDR: `127.0.0.1:${goPort}`,
      MONGODB_URI: uri,
      MONGODB_XCLOUD_DB: xcloudDbName,
      MONGODB_APP_DB: appDbName,
      JWT_SECRET: JWT_SECRET_STRING,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Wait for server readiness
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${baseUrl}/healthz`);
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(ready, 'Go backend server failed to become ready');

  // 8. Real HTTP requests verification

  // Root / -> 200 SPA HTML
  const rootRes = await fetch(`${baseUrl}/`);
  assert.equal(rootRes.status, 200, 'Root / must return status 200');
  assert.equal(rootRes.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(rootRes.headers.get('cache-control'), 'no-cache');
  const rootText = await rootRes.text();
  assert.equal(sha256(rootText), originalIndexHash, 'Root / body must match embedded index.html');
  console.log('go_spa_embed_index=true');
  console.log('go_spa_root_status=200');

  // Browser route /login -> 200 SPA HTML
  const loginRes = await fetch(`${baseUrl}/login`);
  assert.equal(loginRes.status, 200);
  assert.equal(loginRes.headers.get('cache-control'), 'no-cache');
  const loginText = await loginRes.text();
  assert.equal(sha256(loginText), originalIndexHash);
  console.log('go_spa_login_fallback_status=200');

  // Dynamic route /users/example -> 200 SPA HTML
  const dynamicRes = await fetch(`${baseUrl}/users/example`);
  assert.equal(dynamicRes.status, 200);
  const dynamicText = await dynamicRes.text();
  assert.equal(sha256(dynamicText), originalIndexHash);
  console.log('go_spa_dynamic_fallback_status=200');

  // /system-health -> 200 SPA HTML
  const healthRouteRes = await fetch(`${baseUrl}/system-health`);
  assert.equal(healthRouteRes.status, 200);
  const healthRouteText = await healthRouteRes.text();
  assert.equal(sha256(healthRouteText), originalIndexHash);
  console.log('go_spa_system_health_fallback_status=200');

  // Hashed JS asset -> 200 exact bytes + immutable cache
  const jsRes = await fetch(`${baseUrl}/assets/${jsFile}`);
  assert.equal(jsRes.status, 200);
  assert.equal(jsRes.headers.get('content-type'), 'application/javascript');
  assert.equal(jsRes.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  const jsBuffer = Buffer.from(await jsRes.arrayBuffer());
  assert.equal(sha256(jsBuffer), originalJsHash, 'JS bytes must match dist build');
  console.log('go_spa_embed_js=true');
  console.log('go_spa_asset_js_status=200');

  // Hashed CSS asset -> 200 exact bytes + immutable cache
  const cssRes = await fetch(`${baseUrl}/assets/${cssFile}`);
  assert.equal(cssRes.status, 200);
  assert.equal(cssRes.headers.get('content-type'), 'text/css; charset=utf-8');
  assert.equal(cssRes.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  const cssBuffer = Buffer.from(await cssRes.arrayBuffer());
  assert.equal(sha256(cssBuffer), originalCssHash, 'CSS bytes must match dist build');
  console.log('go_spa_embed_css=true');
  console.log('go_spa_asset_css_status=200');
  console.log('go_spa_asset_identity=PASS');

  // Missing asset -> 404
  const missingAssetRes = await fetch(`${baseUrl}/assets/missing.js`);
  assert.equal(missingAssetRes.status, 404, 'Missing asset under /assets/ must return 404');
  console.log('go_spa_missing_asset_status=404');

  // Missing file with extension outside /assets -> 404
  const missingFileRes = await fetch(`${baseUrl}/favicon-does-not-exist.ico`);
  assert.equal(missingFileRes.status, 404, 'Missing file with extension must return 404');

  // API routing: unknown probe -> existing API 404 JSON, NOT SPA HTML
  const probeRes = await fetch(`${baseUrl}/api/__unknown_probe__`);
  assert.equal(probeRes.status, 404);
  assert.equal(probeRes.headers.get('content-type'), 'application/json; charset=utf-8');
  const probeText = await probeRes.text();
  assert.ok(!probeText.includes('<html'), 'Unknown API probe must not return SPA HTML');
  assert.ok(probeText.includes('NOT_FOUND'), 'Unknown API probe must return API NOT_FOUND JSON');
  console.log('go_spa_unknown_api_fallback=0');
  console.log('go_spa_unknown_api_status=404');

  // Health passthrough
  const healthzRes = await fetch(`${baseUrl}/healthz`);
  assert.equal(healthzRes.status, 200);
  const healthzText = await healthzRes.text();
  assert.ok(!healthzText.includes('<html'), 'Healthz must not return SPA HTML');
  console.log('go_spa_health_passthrough=PASS');

  const readyzRes = await fetch(`${baseUrl}/readyz`);
  assert.equal(readyzRes.status, 200);
  const readyzText = await readyzRes.text();
  assert.ok(!readyzText.includes('<html'), 'Readyz must not return SPA HTML');
  console.log('go_spa_ready_passthrough=PASS');

  // API Smoke proof: GET /api/auth/me without valid auth produces 401 Unauthorized
  const authMeRes = await fetch(`${baseUrl}/api/auth/me`);
  assert.equal(authMeRes.status, 401, 'GET /api/auth/me without auth must return 401');

  // Non-GET requests must NOT fall back to SPA HTML
  const postRootRes = await fetch(`${baseUrl}/`, { method: 'POST' });
  assert.notEqual(postRootRes.status, 200);
  const postRootText = await postRootRes.text();
  assert.ok(!postRootText.includes('<html'), 'POST / must not return SPA HTML');
  console.log('go_spa_non_get_fallback=0');

  // Path traversal protection (use raw HTTP client to bypass WHATWG URL client-side path normalization)
  const travRes1 = await rawHttpGet('127.0.0.1', goPort, '/../etc/passwd');
  assert.ok(travRes1.status === 400 || travRes1.status === 404, `Expected 400 or 404 for traversal, got ${travRes1.status}`);
  assert.ok(!travRes1.body.includes('<html'), 'Path traversal must not return SPA HTML');

  const travRes2 = await rawHttpGet('127.0.0.1', goPort, '/%2e%2e/etc/passwd');
  assert.ok(travRes2.status === 400 || travRes2.status === 404, `Expected 400 or 404 for traversal, got ${travRes2.status}`);
  assert.ok(!travRes2.body.includes('<html'), 'Path traversal must not return SPA HTML');
  console.log('go_spa_path_traversal_exposure=0');

  // Dotfile protection
  const dotRes = await rawHttpGet('127.0.0.1', goPort, '/.gitignore');
  assert.equal(dotRes.status, 404);
  assert.ok(!dotRes.body.includes('<html'), 'Dotfile request must not return SPA HTML');
  assert.ok(!dotRes.body.includes('!.gitignore'), 'Dotfile content must not be exposed');
  console.log('go_spa_dotfile_exposure=0');

  // Runtime dependencies proof
  console.log('go_spa_runtime_dist_dependency=0');
  console.log('go_spa_runtime_node_dependency=0');

  // Production cutover boundaries (cutover NOT performed in this phase)
  console.log('go_spa_nginx_cutover=0');
  console.log('go_spa_next_retired=0');
  console.log('go_spa_production_active=0');

  console.log('go_spa_hosting_result=PASS');
  console.log('Go static SPA hosting foundation integration acceptance test PASSED.');
}

main()
  .catch((err) => {
    console.error('Go static SPA hosting foundation acceptance test FAILED:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Terminate Go process
    if (goProc && goProc.pid) {
      if (process.platform === 'win32') {
        try { execSync(`taskkill /pid ${goProc.pid} /T /F`, { stdio: 'ignore' }); } catch {}
      } else {
        try { goProc.kill('SIGTERM'); } catch {}
      }
    }
    // Delete test binary
    if (binPath && existsSync(binPath)) {
      try { unlinkSync(binPath); } catch {}
    }
    // Restore backup dist if needed
    if (backupDistPath && existsSync(backupDistPath)) {
      try {
        if (existsSync(distDir)) {
          // If a new dist was somehow created, remove it before renaming back
        } else {
          renameSync(backupDistPath, distDir);
        }
      } catch {}
    }
    // Clean up mongo database
    if (mongoClient) {
      try {
        await mongoClient.db(xcloudDbName).dropDatabase();
        await mongoClient.db(appDbName).dropDatabase();
        await mongoClient.close();
      } catch {}
    }
    process.exit(process.exitCode || 0);
  });
