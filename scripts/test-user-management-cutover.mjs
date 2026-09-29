#!/usr/bin/env node
/**
 * User Management Controlled Cutover Suite
 *
 * Verifies:
 * 1. All six canonical User Management routes resolve to owner=go
 * 2. No duplicate METHOD+PATH entries in CUTOVER_TABLE
 * 3. CUTOVER_TABLE = 36, ACTUALLY_ROUTED = 36
 * 4. Frontend API client uses dedicated canonical endpoints
 * 5. Go backend registers all six canonical routes
 * 6. No frontend owner-specific branching
 * 7. Legacy /api/auth/users not consumed by Phase 6.1-C UI
 * 8. Go unavailable returns 502 GO_BACKEND_UNREACHABLE (proxy contract)
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createJiti } from 'jiti';

const root = resolve(import.meta.dirname, '..');
const jiti = createJiti(import.meta.url);

console.log('── User Management Controlled Cutover Suite ──\n');

let passed = 0;
function verify(description, fn) {
  try {
    fn();
    console.log(`  PASS  ${description}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${description}`);
    console.error(`        ${err.message}`);
    process.exit(1);
  }
}

// ── 1. Cutover table routing ─────────────────────────────────────────────────
console.log('1. Cutover Table Routing');

const { CUTOVER_TABLE, resolveRouteOwner } = jiti(join(root, 'frontend/src/lib/cutover-routing.ts'));

const userMgmtRoutes = [
  { method: 'GET', path: '/api/users', expectedOwner: 'go' },
  { method: 'POST', path: '/api/users', expectedOwner: 'go' },
  { method: 'GET', path: '/api/users/{username}', expectedOwner: 'go' },
  { method: 'PATCH', path: '/api/users/{username}', expectedOwner: 'go' },
  { method: 'POST', path: '/api/users/{username}/disable', expectedOwner: 'go' },
  { method: 'POST', path: '/api/users/{username}/password-reset', expectedOwner: 'go' },
];

for (const route of userMgmtRoutes) {
  verify(`${route.method} ${route.path} owner=${route.expectedOwner}`, () => {
    const entry = CUTOVER_TABLE.find((r) => r.method === route.method && r.path === route.path);
    assert.ok(entry, `route not found in CUTOVER_TABLE: ${route.method} ${route.path}`);
    assert.equal(entry.owner, route.expectedOwner);
  });
}

verify('CUTOVER_TABLE = 36', () => {
  assert.equal(CUTOVER_TABLE.length, 36, `found ${CUTOVER_TABLE.length}`);
});

verify('ACTUALLY_ROUTED = 36', () => {
  const goRoutes = CUTOVER_TABLE.filter((r) => r.owner === 'go');
  assert.equal(goRoutes.length, 36, `found ${goRoutes.length}`);
});

verify('no duplicate METHOD+PATH entries', () => {
  const seen = new Set();
  for (const route of CUTOVER_TABLE) {
    const key = `${route.method} ${route.path}`;
    assert.equal(seen.has(key), false, `duplicate: ${key}`);
    seen.add(key);
  }
});

// ── 2. Runtime owner resolution ─────────────────────────────────────────────
console.log('\n2. Runtime Owner Resolution');

const resolveCases = [
  { method: 'GET', pathname: '/api/users', expected: 'go' },
  { method: 'POST', pathname: '/api/users', expected: 'go' },
  { method: 'GET', pathname: '/api/users/alice', expected: 'go' },
  { method: 'PATCH', pathname: '/api/users/alice', expected: 'go' },
  { method: 'POST', pathname: '/api/users/alice/disable', expected: 'go' },
  { method: 'POST', pathname: '/api/users/alice/password-reset', expected: 'go' },
  { method: 'GET', pathname: '/api/users', expected: 'go' },
  { method: 'POST', pathname: '/api/auth/users', expected: 'node' },
  { method: 'GET', pathname: '/api/auth/me', expected: 'go' },
  { method: 'POST', pathname: '/api/auth/login', expected: 'go' },
];

for (const tc of resolveCases) {
  verify(`resolveRouteOwner(${tc.method}, ${tc.pathname}) = ${tc.expected}`, () => {
    const owner = resolveRouteOwner(tc.method, tc.pathname);
    assert.equal(owner, tc.expected);
  });
}

// ── 3. Frontend API client contract ─────────────────────────────────────────
console.log('\n3. Frontend API Client Contract');

const usersApiSource = readFileSync(join(root, 'frontend/src/lib/api/users.ts'), 'utf8');

verify('create uses POST /api/users', () => {
  assert.match(usersApiSource, /method:\s*"POST"/);
  assert.match(usersApiSource, /fetch\(BASE,/);
});

verify('update uses PATCH /api/users/{username}', () => {
  assert.match(usersApiSource, /method:\s*"PATCH"/);
  assert.match(usersApiSource, /encodeURIComponent\(username\)/);
});

verify('disable uses POST /api/users/{username}/disable', () => {
  assert.match(usersApiSource, /\/disable`/);
  assert.match(usersApiSource, /method:\s*"POST"/);
});

verify('resetPassword uses POST /api/users/{username}/password-reset', () => {
  assert.match(usersApiSource, /\/password-reset`/);
});

verify('no disable emulation via PATCH {status:disabled}', () => {
  assert.doesNotMatch(usersApiSource, /disable.*PATCH.*status.*disabled/s);
});

verify('no password-reset emulation via PATCH {password}', () => {
  const disableBlock = usersApiSource.slice(usersApiSource.indexOf('resetPassword'));
  assert.doesNotMatch(disableBlock, /method:\s*"PATCH"/);
});

verify('no backend-specific branching (backend === "go")', () => {
  const frontendSrc = readdirSync(join(root, 'frontend/src'), { recursive: true })
    .filter((f) => typeof f === 'string' && /\.(ts|tsx)$/.test(f))
    .map((f) => readFileSync(join(root, 'frontend/src', f), 'utf8'))
    .join('\n');
  assert.doesNotMatch(frontendSrc, /backend\s*===\s*["']go["']/);
  assert.doesNotMatch(frontendSrc, /owner\s*===\s*["']go["']\s*\?/);
});

// ── 4. Go backend route registration ────────────────────────────────────────
console.log('\n4. Go Backend Route Registration');

const goMain = readFileSync(join(root, 'backend/cmd/server/main.go'), 'utf8');

const goRoutes = [
  'GET /api/users',
  'POST /api/users',
  'GET /api/users/{username}',
  'PATCH /api/users/{username}',
  'POST /api/users/{username}/disable',
  'POST /api/users/{username}/password-reset',
];

for (const route of goRoutes) {
  verify(`Go registers: ${route}`, () => {
    assert.ok(goMain.includes(`"${route}"`), `missing in main.go: ${route}`);
  });
}

// ── 5. Go unavailable contract ──────────────────────────────────────────────
console.log('\n5. Go Unavailable Contract');

const proxySource = readFileSync(join(root, 'frontend/src/proxy.ts'), 'utf8');

verify('proxy returns 502 GO_BACKEND_UNREACHABLE on Go failure', () => {
  assert.match(proxySource, /GO_BACKEND_UNREACHABLE/);
  assert.match(proxySource, /status:\s*502/);
});

verify('proxy does NOT fall back to Node on Go failure', () => {
  // The forwardToGo catch block must return 502, not NextResponse.next()
  const catchBlock = proxySource.slice(proxySource.indexOf('Go backend unreachable'));
  assert.match(catchBlock, /GO_BACKEND_UNREACHABLE/);
  assert.doesNotMatch(catchBlock.slice(0, 500), /NextResponse\.next/);
});

verify('proxy emits cutover_forward log for Go-owned routes', () => {
  assert.match(proxySource, /cutover_forward/);
});

// ── 6. Legacy compatibility ─────────────────────────────────────────────────
console.log('\n6. Legacy /api/auth/users Compatibility');

function sourceFiles(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory()
      ? sourceFiles(path)
      : /\.(?:ts|tsx)$/.test(name) ? [path] : [];
  });
}

const usersPageSrc = sourceFiles(join(root, 'frontend/src/app/(dashboard)/users'))
  .map((p) => readFileSync(p, 'utf8'))
  .join('\n');

verify('Phase 6.1-C UI does not call /api/auth/users', () => {
  assert.doesNotMatch(usersPageSrc, /\/api\/auth\/users/);
});

verify('API client does not call /api/auth/users', () => {
  assert.doesNotMatch(usersApiSource, /\/api\/auth\/users/);
});

// ── 7. Password hash non-exposure ───────────────────────────────────────────
console.log('\n7. Security Invariants');

verify('Go SafeUser excludes passwordHash', () => {
  const modelSrc = readFileSync(join(root, 'backend/internal/user/model.go'), 'utf8');
  const safeUserBlock = modelSrc.slice(modelSrc.indexOf('type SafeUser struct'));
  const endBrace = safeUserBlock.indexOf('\n}');
  assert.doesNotMatch(safeUserBlock.slice(0, endBrace), /passwordHash/);
});

verify('frontend API client never exposes passwordHash', () => {
  assert.doesNotMatch(usersApiSource, /passwordHash/);
});

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\nAll ${passed} cutover checks passed.`);
console.log('CUTOVER_TABLE=36 ACTUALLY_ROUTED=36');
