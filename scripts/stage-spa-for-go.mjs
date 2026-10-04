#!/usr/bin/env node
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(root, 'frontend-spa', 'dist');
const staticDir = join(root, 'backend', 'internal', 'spa', 'static');

// 1. Validate frontend-spa/dist/index.html exists and is non-empty
const indexHtmlPath = join(distDir, 'index.html');
assert.ok(existsSync(indexHtmlPath), 'frontend-spa/dist/index.html must exist');
assert.ok(statSync(indexHtmlPath).size > 0, 'frontend-spa/dist/index.html must not be empty');

// 2. Validate assets directory exists
const assetsDir = join(distDir, 'assets');
assert.ok(existsSync(assetsDir) && statSync(assetsDir).isDirectory(), 'frontend-spa/dist/assets must exist and be a directory');

const assetFiles = readdirSync(assetsDir);

// 3. At least one hashed JavaScript asset exists
const jsAssets = assetFiles.filter((f) => f.endsWith('.js'));
assert.ok(jsAssets.length > 0, 'At least one JavaScript asset must exist in frontend-spa/dist/assets');
const hashedJs = jsAssets.some((f) => /^.+-[A-Za-z0-9_-]+\.js$/.test(f) || /index.*\.js$/.test(f));
assert.ok(hashedJs, 'At least one hashed JavaScript asset must exist in frontend-spa/dist/assets');

// 4. Hashed CSS exists when emitted
const cssAssets = assetFiles.filter((f) => f.endsWith('.css'));
if (cssAssets.length > 0) {
  const hashedCss = cssAssets.some((f) => /^.+-[A-Za-z0-9_-]+\.css$/.test(f) || /index.*\.css$/.test(f));
  assert.ok(hashedCss, 'Emitted CSS assets must be hashed');
}

// 5. _next is absent
function assertNoForbiddenTree(dir, forbiddenName) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    assert.notEqual(entry, forbiddenName, `Forbidden directory/file '${forbiddenName}' found in ${dir}`);
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      assertNoForbiddenTree(full, forbiddenName);
    }
  }
}
assertNoForbiddenTree(distDir, '_next');

// 6. Server / SSR artifacts are absent
assertNoForbiddenTree(distDir, 'node_modules');
assertNoForbiddenTree(distDir, 'server');
assertNoForbiddenTree(distDir, '.next');

// 7. Ensure staticDir exists
if (!existsSync(staticDir)) {
  mkdirSync(staticDir, { recursive: true });
}

// 8. Clean previous staged generated assets, preserving .gitignore
for (const entry of readdirSync(staticDir)) {
  if (entry === '.gitignore') continue;
  const full = join(staticDir, entry);
  rmSync(full, { recursive: true, force: true });
}

// 9. Preserve/ensure committed static/.gitignore
const gitignorePath = join(staticDir, '.gitignore');
writeFileSync(gitignorePath, '*\n!.gitignore\n', 'utf8');

// 10. Copy current dist exactly into staticDir
for (const entry of readdirSync(distDir)) {
  const src = join(distDir, entry);
  const dest = join(staticDir, entry);
  cpSync(src, dest, { recursive: true });
}

// Re-ensure .gitignore is preserved
writeFileSync(gitignorePath, '*\n!.gitignore\n', 'utf8');

// 11. Verify staged output
assert.ok(existsSync(join(staticDir, 'index.html')), 'Staged static/index.html must exist');
assert.ok(existsSync(join(staticDir, 'assets')), 'Staged static/assets must exist');

console.log('SPA staged for Go static embed successfully.');
