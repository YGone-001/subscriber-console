#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const frontendRoot = resolve(root, 'frontend');
const distRoot = resolve(frontendRoot, 'dist');
const allowedStatuses = new Set(['foundation', 'pending', 'read-parity', 'migrated', 'mutation-parity', 'operational-mutation-parity']);

function walk(dir, predicate, files = []) {
  if (!existsSync(dir)) return files;
  for (const name of readdirSync(dir)) {
    const full = resolve(dir, name);
    if (statSync(full).isDirectory()) walk(full, predicate, files);
    else if (predicate(full)) files.push(full);
  }
  return files;
}

function requireCondition(condition, message) {
  assert.ok(condition, message);
}

const inventoryPath = resolve(frontendRoot, 'migration-routes.json');
const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
const targetRoutes = new Set();
const inventoryBySource = new Map();

for (const entry of inventory) {
  requireCondition(entry && typeof entry === 'object', 'route entry must be an object');
  requireCondition(!inventoryBySource.has(entry.sourceRoute), `duplicate route entry: ${entry.sourceRoute}`);
  requireCondition(!targetRoutes.has(entry.targetRoute), `duplicate target route: ${entry.targetRoute}`);
  requireCondition(allowedStatuses.has(entry.status), `unknown route status: ${entry.status}`);
  inventoryBySource.set(entry.sourceRoute, entry);
  targetRoutes.add(entry.targetRoute);
}

assert.equal(inventory.length, 23, 'canonical inventory must contain exactly 23 routes');

const foundationSources = new Set(['/login']);
for (const entry of inventory) {
  if (entry.status === 'foundation') requireCondition(foundationSources.has(entry.sourceRoute), `business route cannot be foundation: ${entry.sourceRoute}`);
  if (foundationSources.has(entry.sourceRoute)) assert.equal(entry.status, 'foundation', `foundation route required: ${entry.sourceRoute}`);
}

const packageJson = JSON.parse(readFileSync(resolve(frontendRoot, 'package.json'), 'utf8'));
assert.equal(packageJson.name, 'subscriber-console-frontend', 'frontend package name must be subscriber-console-frontend');
const declaredDependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
for (const forbidden of ['next', 'jose', 'jsonwebtoken', 'mongodb', 'mongoose', 'bcrypt', 'bcryptjs', 'express', 'fastify', 'koa']) {
  requireCondition(!(forbidden in declaredDependencies), `forbidden frontend dependency: ${forbidden}`);
}

const sourceFiles = walk(resolve(frontendRoot, 'src'), (file) => /\.(ts|tsx|js|jsx)$/.test(file));
const source = sourceFiles.map((file) => readFileSync(file, 'utf8')).join('\n');
const forbiddenSource = [
  /document\.cookie/,
  /auth_token/,
  /localStorage\.setItem\([^)]*auth/i,
  /sessionStorage\.setItem\([^)]*auth/i,
  /X-User/,
  /X-Role/,
  /X-Permissions/,
  /127\.0\.0\.1:18888/,
  /localhost:18888/,
  /from 'next/,
  /next\//,
  /next\/navigation/,
  /next\/link/,
  /next\/image/,
];
for (const pattern of forbiddenSource) requireCondition(!pattern.test(source), `forbidden frontend source pattern: ${pattern}`);

requireCondition(existsSync(resolve(distRoot, 'index.html')), 'missing static dist/index.html');
requireCondition(existsSync(resolve(distRoot, 'assets')), 'missing static dist/assets');
requireCondition(!existsSync(resolve(distRoot, '_next')), 'static artifact must not contain _next');
const distFiles = walk(distRoot, () => true).map((file) => relative(distRoot, file).replaceAll('\\', '/'));
const hashedJs = distFiles.some((file) => /^assets\/.+-[A-Za-z0-9_-]{8,}\.js$/.test(file));
const hashedCss = distFiles.some((file) => /^assets\/.+-[A-Za-z0-9_-]{8,}\.css$/.test(file));
const serverArtifacts = distFiles.filter((file) => /(^|\/)(server|entry-server)(\.|\/|$)|\.node$/i.test(file));
requireCondition(hashedJs, 'static artifact must include a hashed JavaScript asset');
requireCondition(hashedCss, 'static artifact must include a hashed CSS asset');
requireCondition(serverArtifacts.length === 0, `static artifact contains server runtime files: ${serverArtifacts.join(', ')}`);

const count = (status) => inventory.filter((entry) => entry.status === status).length;
console.log('frontend_package_identity=subscriber-console-frontend');
console.log(`frontend_route_count=${inventory.length}`);
console.log(`spa_route_inventory_count=${inventory.length}`);
console.log(`spa_route_foundation_count=${count('foundation')}`);
console.log(`spa_route_pending_count=${count('pending')}`);
console.log(`spa_route_migrated_count=${count('migrated')}`);
console.log('frontend_static_dist_index=true');
console.log('spa_static_dist_index=true');
console.log(`frontend_static_hashed_js=${hashedJs}`);
console.log(`spa_static_hashed_js=${hashedJs}`);
console.log(`frontend_static_hashed_css=${hashedCss}`);
console.log(`spa_static_hashed_css=${hashedCss}`);
console.log(`frontend_static_server_artifacts=${serverArtifacts.length}`);
console.log(`spa_static_server_artifacts=${serverArtifacts.length}`);
console.log('frontend_runtime_contract_result=PASS');
console.log('spa_route_contract_result=PASS');
