#!/usr/bin/env node
/**
 * Frontend Runtime Boundary Acceptance Suite.
 *
 * Permanent, phase-neutral gate proving that:
 *   - Next framework dependency = 0
 *   - Next framework imports = 0
 *   - frontend server API = 0 (no server routes, no backend tree)
 *   - frontend MongoDB runtime = 0
 *   - frontend JWT authority = 0
 *   - no direct Go API URLs in frontend source
 *   - Go router registration site remains the authoritative production API surface (119)
 *
 * Usage: node scripts/test-frontend-runtime-boundary.mjs
 */

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveGoRegistrations } from './lib/go-registrations.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const frontendRoot = resolve(root, 'frontend');
const srcRoot = resolve(frontendRoot, 'src');
const packagePath = resolve(frontendRoot, 'package.json');

const EXPECTED_GO_REGISTRATIONS = 119;

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

// 1. Next framework dependency = 0
const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
const declaredDeps = { ...(packageJson.dependencies || {}), ...(packageJson.devDependencies || {}) };
const nextDeps = Object.keys(declaredDeps).filter((dep) => dep === 'next' || dep.startsWith('@next/'));
assert.equal(nextDeps.length, 0, `Next dependencies declared: ${nextDeps.join(', ')}`);

// Also check backend dependencies in frontend
const bannedDeps = ['jose', 'jsonwebtoken', 'mongodb', 'mongoose', 'bcrypt', 'bcryptjs', 'jiti'];
const presentBanned = bannedDeps.filter((dep) => dep in declaredDeps);
assert.equal(presentBanned.length, 0, `Banned dependencies declared: ${presentBanned.join(', ')}`);

// 2. Next framework imports = 0 & Banned imports = 0
const sourceFiles = walk(srcRoot, (f) => /\.(ts|tsx|js|jsx)$/.test(f));
let nextImports = 0;
let mongoClientHits = 0;
let jwtHits = 0;
let directGoHits = 0;
let cookieHits = 0;

for (const file of sourceFiles) {
  const content = readFileSync(file, 'utf8');
  if (/from\s+['"](?:@next\/|next(?:\/|['"]))/m.test(content) || /require\(['"](?:@next\/|next(?:\/|['"]))/m.test(content)) {
    nextImports += 1;
  }
  if (/\bMongoClient\b|\bmongoose\b/m.test(content)) {
    mongoClientHits += 1;
  }
  if (/\bjose\b|\bjsonwebtoken\b|\bjwtVerify\b/m.test(content)) {
    jwtHits += 1;
  }
  if (/127\.0\.0\.1:18888|localhost:18888/m.test(content)) {
    directGoHits += 1;
  }
  if (/document\.cookie|\bauth_token\b/m.test(content)) {
    cookieHits += 1;
  }
}

assert.equal(nextImports, 0, 'Next.js framework imports must be 0');
assert.equal(mongoClientHits, 0, 'MongoDB client references in frontend must be 0');
assert.equal(jwtHits, 0, 'JWT verification references in frontend must be 0');
assert.equal(directGoHits, 0, 'Browser-direct Go URLs in frontend must be 0');
assert.equal(cookieHits, 0, 'Direct cookie/auth_token access in frontend must be 0');

// 3. Frontend server API = 0
const apiRoot = resolve(frontendRoot, 'src/app/api');
const serverRoot = resolve(frontendRoot, 'src/server');
const proxyPath = resolve(frontendRoot, 'src/proxy.ts');
assert.ok(!existsSync(apiRoot), 'frontend/src/app/api must not exist');
assert.ok(!existsSync(serverRoot), 'frontend/src/server must not exist');
assert.ok(!existsSync(proxyPath), 'legacy navigation guard frontend/src/proxy.ts must not exist');

// 4. Go router registration site remains authoritative (119)
const goRegistrations = deriveGoRegistrations(root);
assert.equal(goRegistrations.keys.length, EXPECTED_GO_REGISTRATIONS, `Go registrations must be ${EXPECTED_GO_REGISTRATIONS}`);

console.log('Frontend Runtime Boundary: PASS');
console.log('frontend_next_framework_dependency=0');
console.log('frontend_next_framework_imports=0');
console.log('frontend_server_api_count=0');
console.log('frontend_business_mongo_readers=0');
console.log('frontend_business_mongo_writers=0');
console.log('frontend_jwt_verifiers=0');
console.log('frontend_direct_go_urls=0');
console.log('next_api_route_files=0');
console.log('next_api_operations=0');
console.log('next_server_tree_present=false');
console.log('next_business_mongo_readers=0');
console.log('next_business_mongo_writers=0');
console.log('next_business_jwt_verifiers=0');
console.log('active_server_imports=0');
console.log('frontend_runtime_boundary_result=PASS');
