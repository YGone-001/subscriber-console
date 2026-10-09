#!/usr/bin/env node
/**
 * User Management Runtime Integration Suite
 *
 * Verifies:
 * 1. All six canonical User Management routes present in the Go registration site
 * 2. Six retired compatibility mutation methods absent
 * 3. Exactly 97 Go registrations with zero duplicates
 * 4. Frontend API client uses dedicated canonical endpoints
 * 5. Go backend registers all six canonical routes
 * 6. No frontend owner-specific branching
 * 7. Legacy /api/auth/users not consumed by the User Management UI
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { deriveGoRegistrations } from './lib/go-registrations.mjs';

const root = resolve(import.meta.dirname, '..');

console.log('-- User Management Runtime Integration Suite --\n');

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

// -- 1. Go registration authority ---------------------------------------------
console.log('1. Go Registration Authority');

const { keys: goRegistrations, duplicates: goDuplicates } = deriveGoRegistrations(root);

const userMgmtRoutes = [
  'GET /api/users',
  'POST /api/users',
  'GET /api/users/{username}',
  'PATCH /api/users/{username}',
  'POST /api/users/{username}/disable',
  'POST /api/users/{username}/password-reset',
];

for (const route of userMgmtRoutes) {
  verify(`Go registers: ${route}`, () => {
    assert.ok(goRegistrations.includes(route), `missing registration: ${route}`);
  });
}

const retiredMutations = [
  'POST /api/auth/users',
  'PUT /api/auth/users/{username}',
  'PATCH /api/auth/users/{username}',
  'DELETE /api/auth/users/{username}',
  'PUT /api/users/{username}',
  'DELETE /api/users/{username}',
];

for (const route of retiredMutations) {
  verify(`retired mutation absent: ${route}`, () => {
    assert.equal(goRegistrations.includes(route), false, `unexpected registration: ${route}`);
  });
}

verify('Go registrations = 97', () => {
  assert.equal(goRegistrations.length, 97, `found ${goRegistrations.length}`);
});

verify('no duplicate METHOD+PATH registrations', () => {
  assert.deepEqual(goDuplicates, [], `duplicates: ${goDuplicates.join(', ')}`);
});

// -- 2. Frontend API client contract -----------------------------------------
console.log('\n2. Frontend API Client Contract');

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

// -- 3. Go backend route registration ----------------------------------------
console.log('\n3. Go Backend Route Registration');

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

// -- 4. Legacy compatibility -------------------------------------------------
console.log('\n4. Legacy /api/auth/users Compatibility');

function sourceFiles(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory()
      ? sourceFiles(path)
      : /\.(?:ts|tsx)$/.test(name) ? [path] : [];
  });
}

const usersPageDir = existsSync(join(root, 'frontend/src/features/users'))
  ? join(root, 'frontend/src/features/users')
  : join(root, 'frontend/src/app/(dashboard)/users');

const usersPageSrc = sourceFiles(usersPageDir)
  .map((p) => readFileSync(p, 'utf8'))
  .join('\n');

verify('User Management UI does not call /api/auth/users', () => {
  assert.doesNotMatch(usersPageSrc, /\/api\/auth\/users/);
});

verify('API client does not call /api/auth/users', () => {
  assert.doesNotMatch(usersApiSource, /\/api\/auth\/users/);
});

// -- 5. Password hash non-exposure -------------------------------------------
console.log('\n5. Security Invariants');

verify('Go SafeUser excludes passwordHash', () => {
  const modelSrc = readFileSync(join(root, 'backend/internal/user/model.go'), 'utf8');
  const safeUserBlock = modelSrc.slice(modelSrc.indexOf('type SafeUser struct'));
  const endBrace = safeUserBlock.indexOf('\n}');
  assert.doesNotMatch(safeUserBlock.slice(0, endBrace), /passwordHash/);
});

verify('frontend API client never exposes passwordHash', () => {
  assert.doesNotMatch(usersApiSource, /passwordHash/);
});

// -- Summary -----------------------------------------------------------------
console.log(`\nAll ${passed} user management integration checks passed.`);
console.log('GoRegistered=97 duplicates=0');
