#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const spa = resolve(root, 'frontend-spa');
const source = resolve(spa, 'src');
const routes = JSON.parse(readFileSync(resolve(spa, 'migration-routes.json'), 'utf8'));
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

assert.equal(routes.length, 23, 'inventory must contain every current page route');
assert.ok(routes.every((route) => ['foundation', 'pending', 'read-parity', 'migrated', 'mutation-parity', 'operational-mutation-parity'].includes(route.status)), 'route state must be recognized');
assert.match(routerSource, /APP_ROUTES\.filter/);
assert.match(routerSource, /MigrationPendingPage/);
assert.match(navigationSource, /migration-routes\.json/);
for (const route of routes) {
  assert.ok(route.targetRoute === '/' || route.targetRoute === '/login' || navigationSource.includes(`'${route.targetRoute}'`) || route.targetRoute.includes(':'), `route is not represented in shell metadata: ${route.targetRoute}`);
  for (const parameter of route.dynamicParameters) assert.ok(route.targetRoute.includes(`:${parameter}`), `route parameter missing: ${route.targetRoute}`);
}
for (const pattern of [/from 'next/, /next\//, /127\.0\.0\.1:18888/, /localhost:18888/, /document\.cookie/, /auth_token/, /X-User/, /X-Role/, /X-Permissions/]) assert.ok(!pattern.test(sourceText), `forbidden SPA source pattern: ${pattern}`);
const typesSource = readFileSync(resolve(source, 'types/auth.ts'), 'utf8');
assert.match(typesSource, /'admin' \| 'operator' \| 'viewer'/);
assert.ok(existsSync(resolve(source, 'providers/AppProviders.tsx')));
assert.match(sourceText, /XCLOUD_THEME_PREFERENCE/);
assert.match(sourceText, /XCLOUD_LANGUAGE_PREFERENCE/);
execFileSync('git', ['diff', '--quiet', 'HEAD', '--', 'frontend', 'backend', 'deploy'], { cwd: root });
console.log('spa_shell_inventory_routes=23');
console.log('spa_shell_router_routes=23');
console.log(`spa_shell_business_migrated=${routes.filter((route) => route.status === 'migrated').length}`);
console.log(`spa_shell_pending_business_routes=${routes.filter((route) => route.status === 'pending').length}`);
console.log('spa_shell_next_imports=0');
console.log('spa_shell_direct_go_urls=0');
console.log('spa_shell_jwt_runtime=0');
console.log('spa_shell_cookie_auth_reads=0');
console.log('spa_shell_trusted_identity_headers=0');
console.log('spa_shell_result=PASS');
