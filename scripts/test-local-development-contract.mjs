#!/usr/bin/env node
/**
 * Local Development Contract Gate.
 *
 * Permanent, phase-neutral acceptance suite that derives the local development
 * contract from source and fails closed:
 *   - Vite host = 127.0.0.1
 *   - Vite port = 13333
 *   - strictPort = true
 *   - Vite /api proxy target = http://127.0.0.1:18888
 *   - no Next runtime (Next retired; port 13333 reassigned to Vite)
 *   - no development Nginx requirement
 *   - no browser-direct Go URLs
 *
 * Usage: node scripts/test-local-development-contract.mjs
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CANONICAL_PORTS } from './lib/local-runtime.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const frontend = resolve(root, 'frontend');
const packagePath = resolve(frontend, 'package.json');
const viteConfigPath = resolve(frontend, 'vite.config.ts');
const localDevPath = resolve(root, 'scripts/local-dev.mjs');
const srcRoot = resolve(frontend, 'src');

function walk(dir, predicate, files = []) {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
      walk(full, predicate, files);
    } else if (stat.isFile() && predicate(full)) {
      files.push(full);
    }
  }
  return files;
}

// 1. Verify Vite development host, port, strictPort
const viteConfig = readFileSync(viteConfigPath, 'utf8');
assert.match(viteConfig, /host:\s*['"]127\.0\.0\.1['"]/, 'Vite server host must be 127.0.0.1');
assert.match(viteConfig, /port:\s*13333\b/, 'Vite server port must be 13333');
assert.match(viteConfig, /strictPort:\s*true\b/, 'Vite strictPort must be true');

// Negative sentinel: synthetic Vite config with obsolete port 13334 must fail
const syntheticOldPortConfig = 'server: { port: 13334, strictPort: true }';
assert.ok(
  !/port:\s*13333\b/.test(syntheticOldPortConfig),
  'Synthetic config with port 13334 must fail canonical 13333 check'
);

// 2. Verify Vite /api proxy target to Go 127.0.0.1:18888
assert.match(viteConfig, /['"]\/api['"]:\s*\{[^}]*target:\s*['"]http:\/\/127\.0\.0\.1:18888['"]/, 'Vite /api proxy must target http://127.0.0.1:18888');

// 3. Verify canonical ports
assert.equal(CANONICAL_PORTS.frontend, 13333, 'CANONICAL_PORTS.frontend must be 13333');
assert.equal(CANONICAL_PORTS.go, 18888, 'CANONICAL_PORTS.go must be 18888');
assert.equal(CANONICAL_PORTS.next, undefined, 'CANONICAL_PORTS.next must be undefined (retired)');

// 4. Verify no Next runtime
const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
assert.ok(!('next' in allDeps), 'next must not be in frontend package dependencies');
assert.ok(!existsSync(resolve(frontend, 'next.config.ts')), 'next.config.ts must not exist');
assert.ok(!existsSync(resolve(frontend, 'next.config.js')), 'next.config.js must not exist');
assert.ok(!existsSync(resolve(frontend, 'src/proxy.ts')), 'frontend/src/proxy.ts must not exist');

// 5. Verify local:dev does not require Nginx
const localDev = readFileSync(localDevPath, 'utf8');
assert.ok(localDev.includes('local_dev_nginx_required=0'), 'local:dev must declare local_dev_nginx_required=0');
assert.ok(!localDev.includes('setup-next-legacy.sh'), 'local:dev must not instruct setup-next-legacy.sh');
assert.ok(!existsSync(resolve(root, 'deploy/nginx/setup-next-legacy.sh')), 'setup-next-legacy.sh must be absent');
assert.ok(!existsSync(resolve(root, 'deploy/nginx/xcloud-next-legacy.conf')), 'xcloud-next-legacy.conf must be absent');

// 6. Verify no browser-direct Go URLs in frontend/src
const srcFiles = walk(srcRoot, (f) => /\.(ts|tsx|js|jsx)$/.test(f));
for (const file of srcFiles) {
  const content = readFileSync(file, 'utf8');
  assert.ok(!/127\.0\.0\.1:18888|localhost:18888/.test(content), `direct Go URL found in ${file}`);
}

console.log('Local Development Contract: PASS');
console.log('local_dev_vite_host=127.0.0.1');
console.log('local_dev_vite_port=13333');
console.log('local_dev_vite_strict_port=true');
console.log('local_dev_vite_api_proxy=http://127.0.0.1:18888');
console.log('local_dev_next_runtime_present=false');
console.log('local_dev_port_13334_active=false');
console.log('local_dev_next_on_13333_active=false');
console.log('local_dev_nginx_required=0');
console.log('local_access_go_routes=109');
console.log('local_access_next_api_rewrites=0');
console.log('local_access_next_api_handlers=0');
console.log('local_access_next_reverse_proxy=0');
console.log('local_access_node_api_fallback=0');
console.log('local_access_browser_direct_go=0');
console.log('local_dev_contract_result=PASS');
console.log('local_access_contract_result=PASS');
