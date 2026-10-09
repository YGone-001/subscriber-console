#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const frontendRoot = resolve(root, 'frontend');
const distRoot = resolve(frontendRoot, 'dist');

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

const contractPath = resolve(frontendRoot, 'route-contract.json');
const inventory = JSON.parse(readFileSync(contractPath, 'utf8'));
const routesSeen = new Set();

for (const entry of inventory) {
  requireCondition(entry && typeof entry === 'object', 'route entry must be an object');
  requireCondition(typeof entry.route === 'string', 'route must be a string');
  requireCondition(!routesSeen.has(entry.route), `duplicate route entry: ${entry.route}`);
  requireCondition(Array.isArray(entry.dynamicParameters), 'dynamicParameters must be an array');
  routesSeen.add(entry.route);
}

assert.equal(inventory.length, 30, 'canonical route contract must contain exactly 30 routes');

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

console.log('frontend_package_identity=subscriber-console-frontend');
console.log(`frontend_route_count=${inventory.length}`);
console.log('frontend_static_dist_index=true');
console.log(`frontend_static_hashed_js=${hashedJs}`);
console.log(`frontend_static_hashed_css=${hashedCss}`);
console.log(`frontend_static_server_artifacts=${serverArtifacts.length}`);
console.log('frontend_route_contract_result=PASS');
console.log('frontend_runtime_contract_result=PASS');
