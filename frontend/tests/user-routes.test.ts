import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const spaRoot = resolve(import.meta.dirname, '..');
const routes = JSON.parse(readFileSync(resolve(spaRoot, 'route-contract.json'), 'utf8'));
const routerSource = readFileSync(resolve(spaRoot, 'src/router/router.tsx'), 'utf8');
const userCreateSource = readFileSync(resolve(spaRoot, 'src/features/users/UserCreatePage.tsx'), 'utf8');
const usersApiSource = readFileSync(resolve(spaRoot, 'src/lib/api/users.ts'), 'utf8');

test('users create route is active in route contract and router', () => {
  const userCreateRoute = routes.find((r: { route: string }) => r.route === '/users/create');
  assert.ok(userCreateRoute, 'users create route must be present in route contract');

  assert.match(routerSource, /'\/users\/create':\s*<UserCreatePage\s*\/>/, 'router must bind /users/create to UserCreatePage');
});

test('users create page enforces password security invariants', () => {
  assert.doesNotMatch(userCreateSource, /localStorage/, 'passwords must never be stored in localStorage');
  assert.doesNotMatch(userCreateSource, /sessionStorage/, 'passwords must never be stored in sessionStorage');
  assert.doesNotMatch(userCreateSource, /document\.cookie/, 'passwords must never be written to document.cookie');

  /* Creation must go through the canonical client, and that client must POST to
   * the canonical endpoint. Asserting the path at its owner keeps the invariant
   * true however the call site is written. */
  assert.match(userCreateSource, /usersApi\.create\(/, 'user creation must go through the canonical user client');
  assert.match(usersApiSource, /const BASE = '\/api\/users'/, 'the user client must own the canonical base path');
  assert.match(usersApiSource, /method:\s*"POST"/, 'user creation must POST');
});
