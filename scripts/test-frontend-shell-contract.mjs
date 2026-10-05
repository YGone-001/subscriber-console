#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const frontend = resolve(root, 'frontend');
const source = resolve(frontend, 'src');
const routes = JSON.parse(readFileSync(resolve(frontend, 'route-contract.json'), 'utf8'));

const walk = (directory, files = []) => {
  for (const name of readdirSync(directory)) {
    const file = resolve(directory, name);
    if (statSync(file).isDirectory()) walk(file, files);
    else files.push(file);
  }
  return files;
};

const sourceText = walk(source).filter((file) => /\.(ts|tsx)$/.test(file)).map((file) => readFileSync(file, 'utf8')).join('\n');
const routerSource = readFileSync(resolve(source, 'router/router.tsx'), 'utf8');
const navigationSource = readFileSync(resolve(source, 'lib/navigation.ts'), 'utf8');

assert.equal(routes.length, 26, 'route contract must contain every current page route');
assert.match(routerSource, /APP_ROUTES\.filter/);
assert.ok(!routerSource.includes('MigrationPendingPage'), 'router must not render MigrationPendingPage');
assert.ok(!navigationSource.includes('migration-routes.json'), 'navigation source must not import migration-routes.json');

for (const route of routes) {
  assert.ok(
    route.route === '/' || route.route === '/login' || navigationSource.includes(`'${route.route}'`) || route.route.includes(':'),
    `route is not represented in shell metadata: ${route.route}`
  );
  for (const parameter of route.dynamicParameters) {
    assert.ok(route.route.includes(`:${parameter}`), `route parameter missing: ${route.route}`);
  }
}

for (const pattern of [/from 'next/, /next\//, /127\.0\.0\.1:18888/, /localhost:18888/, /document\.cookie/, /auth_token/, /X-User/, /X-Role/, /X-Permissions/]) {
  assert.ok(!pattern.test(sourceText), `forbidden frontend source pattern: ${pattern}`);
}

const typesSource = readFileSync(resolve(source, 'types/auth.ts'), 'utf8');
assert.match(typesSource, /'admin' \| 'operator' \| 'viewer'/);
assert.ok(existsSync(resolve(source, 'providers/AppProviders.tsx')));
assert.match(sourceText, /XCLOUD_THEME_PREFERENCE/);
assert.match(sourceText, /XCLOUD_LANGUAGE_PREFERENCE/);

console.log('frontend_shell_route_count=26');
console.log('frontend_shell_routes=26');
console.log('frontend_shell_next_imports=0');
console.log('frontend_shell_direct_go_urls=0');
console.log('frontend_shell_jwt_runtime=0');
console.log('frontend_shell_cookie_auth_reads=0');
console.log('frontend_shell_trusted_identity_headers=0');
console.log('frontend_shell_result=PASS');
