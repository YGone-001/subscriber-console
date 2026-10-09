#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveGoRegistrations } from './lib/go-registrations.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

console.log('Testing Go static SPA hosting contract...');

// 1. Verify embed package exists
const spaDir = join(root, 'backend', 'internal', 'spa');
assert.ok(existsSync(join(spaDir, 'assets.go')), 'backend/internal/spa/assets.go must exist');
const assetsGoSource = readFileSync(join(spaDir, 'assets.go'), 'utf8');
assert.ok(assetsGoSource.includes('//go:embed all:static'), 'assets.go must embed all:static');
assert.ok(assetsGoSource.includes('func EmbeddedFS()'), 'assets.go must export EmbeddedFS()');

// 2. Verify handler exists and exports NewHandler
assert.ok(existsSync(join(spaDir, 'handler.go')), 'backend/internal/spa/handler.go must exist');
const handlerGoSource = readFileSync(join(spaDir, 'handler.go'), 'utf8');
assert.ok(handlerGoSource.includes('func NewHandler('), 'handler.go must export NewHandler');
assert.ok(handlerGoSource.includes('func isApplicationRoute('), 'handler.go must implement isApplicationRoute classifier');
assert.ok(handlerGoSource.includes('func hasPathTraversal('), 'handler.go must implement hasPathTraversal check');

// 3. Verify handler tests exist
assert.ok(existsSync(join(spaDir, 'handler_test.go')), 'backend/internal/spa/handler_test.go must exist');
const handlerTestGoSource = readFileSync(join(spaDir, 'handler_test.go'), 'utf8');
assert.ok(handlerTestGoSource.includes('TestSPAHandler_DottedUsernameRoutes'), 'handler_test.go must include TestSPAHandler_DottedUsernameRoutes');
assert.ok(handlerTestGoSource.includes('TestSPAHandler_StaticVsBrowserCollision'), 'handler_test.go must include TestSPAHandler_StaticVsBrowserCollision');

// 4. Verify static staging path and .gitignore exist
const staticDir = join(spaDir, 'static');
assert.ok(existsSync(staticDir), 'backend/internal/spa/static must exist');
const staticGitignorePath = join(staticDir, '.gitignore');
assert.ok(existsSync(staticGitignorePath), 'backend/internal/spa/static/.gitignore must exist');
const staticGitignore = readFileSync(staticGitignorePath, 'utf8');
assert.ok(staticGitignore.includes('*\n!.gitignore'), 'static/.gitignore must ignore all except .gitignore');

// 5. Verify root .gitignore ignores staged artifacts
const rootGitignore = readFileSync(join(root, '.gitignore'), 'utf8');
assert.ok(rootGitignore.includes('backend/internal/spa/static/*'), 'root .gitignore must ignore backend/internal/spa/static/*');

// 6. Verify staging script exists
assert.ok(existsSync(join(root, 'scripts', 'stage-spa-for-go.mjs')), 'scripts/stage-spa-for-go.mjs must exist');

// 7. Verify Go API registrations remain exactly 97
const { keys: registrations, duplicates } = deriveGoRegistrations(root);
assert.deepEqual(duplicates, [], 'No duplicate Go registrations permitted');
assert.equal(registrations.length, 97, `Expected exactly 97 Go registrations, got ${registrations.length}`);

// 8. Verify no runtime dist-path or Node dependency in backend Go source
function collectGoFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== 'vendor' && entry !== 'bin') {
        results.push(...collectGoFiles(full));
      }
    } else if (entry.endsWith('.go')) {
      results.push(full);
    }
  }
  return results;
}

const goFiles = collectGoFiles(join(root, 'backend'));
for (const file of goFiles) {
  const content = readFileSync(file, 'utf8');
  assert.ok(!content.includes('frontend-spa/dist'), `Backend source ${file} must not reference frontend-spa/dist at runtime`);
  assert.ok(!content.includes('os/exec') || !content.includes('"node"'), `Backend source ${file} must not invoke node at runtime`);
}

// 9. Verify Nginx configuration (single upstream xcloud_go for edge, legacy Next retained in xcloud-next-legacy.conf)
const nginxConfPath = join(root, 'deploy', 'nginx', 'xcloud.conf');
assert.ok(existsSync(nginxConfPath), 'deploy/nginx/xcloud.conf must exist');
const nginxConf = readFileSync(nginxConfPath, 'utf8');
assert.ok(nginxConf.includes('proxy_pass http://xcloud_go;'), 'Nginx must proxy to Go :18888');
const legacyConfPath = join(root, 'deploy', 'nginx', 'xcloud-next-legacy.conf');
if (existsSync(legacyConfPath)) {
  const legacyConf = readFileSync(legacyConfPath, 'utf8');
  assert.ok(legacyConf.includes('proxy_pass http://xcloud_next;'), 'Legacy Nginx config must retain Next :13333 proxy');
}

// 10. Verify Next production UI contract remains unchanged
assert.ok(!existsSync(join(root, 'frontend', 'src', 'app', 'api')), 'Next.js business API tree must remain absent');

console.log('Go static SPA hosting contract: PASS');
