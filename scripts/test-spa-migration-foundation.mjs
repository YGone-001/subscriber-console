#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appRoot = resolve(root, 'frontend/src/app');
const spaRoot = resolve(root, 'frontend-spa');
const distRoot = resolve(spaRoot, 'dist');
const allowedStatuses = new Set(['foundation', 'pending', 'read-parity', 'migrated']);

function walk(dir, predicate, files = []) {
  if (!existsSync(dir)) return files;
  for (const name of readdirSync(dir)) {
    const full = resolve(dir, name);
    if (statSync(full).isDirectory()) walk(full, predicate, files);
    else if (predicate(full)) files.push(full);
  }
  return files;
}

function routeFromPage(file) {
  const segments = relative(appRoot, file)
    .replaceAll('\\', '/')
    .replace(/\/page\.tsx$/, '')
    .split('/')
    .filter((segment) => segment && !/^\(.*\)$/.test(segment));
  const sourceRoute = `/${segments.join('/')}`.replace(/\/$/, '') || '/';
  const dynamicParameters = segments
    .map((segment) => /^\[([A-Za-z][A-Za-z0-9_]*)\]$/.exec(segment)?.[1])
    .filter(Boolean);
  const targetRoute = sourceRoute.replace(/\[([A-Za-z][A-Za-z0-9_]*)\]/g, ':$1');
  return { sourceRoute, targetRoute, dynamicParameters };
}

function requireCondition(condition, message) {
  assert.ok(condition, message);
}

const pageFiles = walk(appRoot, (file) => file.endsWith('/page.tsx') || file.endsWith('\\page.tsx'));
const currentRoutes = pageFiles.map(routeFromPage).sort((a, b) => a.sourceRoute.localeCompare(b.sourceRoute));
const inventoryPath = resolve(spaRoot, 'migration-routes.json');
const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
const currentBySource = new Map(currentRoutes.map((route) => [route.sourceRoute, route]));
const inventoryBySource = new Map();
const targetRoutes = new Set();

for (const entry of inventory) {
  requireCondition(entry && typeof entry === 'object', 'migration entry must be an object');
  requireCondition(currentBySource.has(entry.sourceRoute), `unknown migration source route: ${entry.sourceRoute}`);
  requireCondition(!inventoryBySource.has(entry.sourceRoute), `duplicate migration source route: ${entry.sourceRoute}`);
  requireCondition(!targetRoutes.has(entry.targetRoute), `duplicate migration target route: ${entry.targetRoute}`);
  requireCondition(allowedStatuses.has(entry.status), `unknown migration status: ${entry.status}`);
  const expected = currentBySource.get(entry.sourceRoute);
  assert.equal(entry.targetRoute, expected.targetRoute, `target route mismatch: ${entry.sourceRoute}`);
  assert.deepEqual(entry.dynamicParameters, expected.dynamicParameters, `dynamic parameter mismatch: ${entry.sourceRoute}`);
  inventoryBySource.set(entry.sourceRoute, entry);
  targetRoutes.add(entry.targetRoute);
}

for (const current of currentRoutes) {
  requireCondition(inventoryBySource.has(current.sourceRoute), `missing migration entry: ${current.sourceRoute}`);
}

const foundationSources = new Set(['/login']);
for (const entry of inventory) {
  if (entry.status === 'foundation') requireCondition(foundationSources.has(entry.sourceRoute), `business route cannot be foundation: ${entry.sourceRoute}`);
  if (foundationSources.has(entry.sourceRoute)) assert.equal(entry.status, 'foundation', `foundation route required: ${entry.sourceRoute}`);
}

const migrated = inventory.filter((entry) => entry.status === 'migrated');

const packageJson = JSON.parse(readFileSync(resolve(spaRoot, 'package.json'), 'utf8'));
const declaredDependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
for (const forbidden of ['next', 'jose', 'jsonwebtoken', 'mongodb', 'mongoose', 'bcrypt', 'bcryptjs', 'express', 'fastify', 'koa']) {
  requireCondition(!(forbidden in declaredDependencies), `forbidden SPA dependency: ${forbidden}`);
}

const sourceFiles = walk(resolve(spaRoot, 'src'), (file) => /\.(ts|tsx|js|jsx)$/.test(file));
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
  /next\//,
  /next\/navigation/,
  /next\/link/,
  /next\/image/,
];
for (const pattern of forbiddenSource) requireCondition(!pattern.test(source), `forbidden SPA source pattern: ${pattern}`);

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
console.log(`spa_route_current_count=${currentRoutes.length}`);
console.log(`spa_route_inventory_count=${inventory.length}`);
console.log(`spa_route_foundation_count=${count('foundation')}`);
console.log(`spa_route_pending_count=${count('pending')}`);
console.log(`spa_route_migrated_count=${count('migrated')}`);
console.log('spa_static_dist_index=true');
console.log(`spa_static_hashed_js=${hashedJs}`);
console.log(`spa_static_hashed_css=${hashedCss}`);
console.log(`spa_static_server_artifacts=${serverArtifacts.length}`);
console.log('spa_route_contract_result=PASS');
