#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const spa = resolve(root, 'frontend-spa');
const source = resolve(spa, 'src');
const routes = JSON.parse(readFileSync(resolve(spa, 'migration-routes.json'), 'utf8'));
const contracts = JSON.parse(readFileSync(resolve(spa, 'read-parity-contracts.json'), 'utf8'));
const walk = (directory, files = []) => { for (const name of readdirSync(directory)) { const file = resolve(directory, name); if (statSync(file).isDirectory()) walk(file, files); else files.push(file); } return files; };
const sourceFiles = walk(source).filter((file) => /\.(ts|tsx)$/.test(file));
const sourceText = sourceFiles.map((file) => readFileSync(file, 'utf8')).join('\n');
const featureFiles = walk(resolve(source, 'features')).filter((file) => /\.(ts|tsx)$/.test(file));
const featureText = featureFiles.map((file) => readFileSync(file, 'utf8')).join('\n');
const count = (status) => routes.filter((route) => route.status === status).length;
const expectedRedirects = {
  '/ocs': '/ocs/tariffs', '/ocs/dashboard': '/ocs/tariffs', '/ocs/sessions': '/ocs/tariffs', '/ocs/usage': '/ocs/tariffs',
  '/ocs/subscribers': '/ocs/contracts', '/rating': '/ocs/tariffs', '/rating/plans': '/ocs/tariffs', '/rating/rules': '/ocs/tariffs', '/roles': '/users',
};
const redirects = readFileSync(resolve(source, 'router/redirects.ts'), 'utf8');

assert.equal(routes.length, 23);
assert.equal(count('foundation'), 1); assert.equal(count('migrated'), 10); assert.equal(count('read-parity'), 11); assert.equal(count('pending'), 1);
assert.equal(routes.find((route) => route.targetRoute === '/login')?.status, 'foundation');
assert.equal(routes.find((route) => route.targetRoute === '/users/create')?.status, 'pending');
for (const [from, to] of Object.entries(expectedRedirects)) { assert.match(redirects, new RegExp(`'${from}': '${to}'`)); }
assert.equal(Object.keys(expectedRedirects).length, 9);
const contractRoutes = new Set(contracts.map((contract) => contract.route));
for (const route of routes.filter((route) => route.status === 'migrated' || route.status === 'read-parity')) assert.ok(contractRoutes.has(route.targetRoute), `missing read contract: ${route.targetRoute}`);
for (const contract of contracts) assert.ok(routes.some((route) => route.targetRoute === contract.route), `contract route absent from inventory: ${contract.route}`);
assert.equal((featureText.match(/\bfetch\s*\(/g) ?? []).length, 0, 'business features must use the read client');
for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal((featureText.match(new RegExp(`method\\s*:\\s*['\"]${method}['\"]`, 'g')) ?? []).length, 0, `business ${method} must be absent`);
const readClient = readFileSync(resolve(source, 'lib/api/read-client.ts'), 'utf8');
assert.match(readClient, /method: 'GET'/);
for (const token of ['postJson', 'putJson', 'patchJson', 'deleteJson']) assert.ok(!readClient.includes(token), `read client exposes mutation helper: ${token}`);
for (const pattern of [/from 'next/, /next\//, /\.\.\/\.\.\/frontend\//, /127\.0\.0\.1:18888/, /localhost:18888/, /document\.cookie/, /auth_token/, /X-User/, /X-Role/, /X-Permissions/, /jose/, /jsonwebtoken/]) assert.ok(!pattern.test(sourceText), `forbidden SPA source pattern: ${pattern}`);
console.log('spa_read_route_total=23');
console.log('spa_read_foundation_routes=1');
console.log('spa_read_migrated_routes=10');
console.log('spa_read_parity_routes=11');
console.log('spa_read_pending_routes=1');
console.log('spa_read_redirect_routes=9');
console.log('spa_read_business_direct_fetch_calls=0');
console.log('spa_read_business_post_calls=0');
console.log('spa_read_business_put_calls=0');
console.log('spa_read_business_patch_calls=0');
console.log('spa_read_business_delete_calls=0');
console.log('spa_read_next_imports=0');
console.log('spa_read_cross_frontend_imports=0');
console.log('spa_read_direct_go_urls=0');
console.log('spa_read_jwt_runtime=0');
console.log('spa_read_auth_cookie_access=0');
console.log('spa_read_trusted_identity_headers=0');
console.log('spa_read_parity_result=PASS');
