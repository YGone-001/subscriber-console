import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { matchRoutes } from 'react-router-dom';
import { appRoutes } from '../src/router/routes';

const spaRoot = resolve(import.meta.dirname, '..');
const routes = JSON.parse(readFileSync(resolve(spaRoot, 'route-contract.json'), 'utf8'));
const userCreateSource = readFileSync(resolve(spaRoot, 'src/features/users/UserCreatePage.tsx'), 'utf8');
const usersApiSource = readFileSync(resolve(spaRoot, 'src/lib/api/users.ts'), 'utf8');

test('users create route is active in route contract and router', () => {
  const userCreateRoute = routes.find((r: { route: string }) => r.route === '/users/create');
  assert.ok(userCreateRoute, 'users create route must be present in route contract');

  /*
   * Resolve the real route table instead of matching an import pattern: the
   * page is lazy now, and what matters is that the literal path wins over the
   * `/users/:username` sibling and reaches a lazy module rather than an eager
   * element.
   */
  const matches = matchRoutes(appRoutes, '/users/create');
  assert.ok(matches && matches.length > 0, 'the router must resolve /users/create');
  const leaf = matches[matches.length - 1];
  assert.equal(leaf.route.path, '/users/create', 'the create path must not be swallowed by /users/:username');
  assert.equal(typeof leaf.route.lazy, 'function', '/users/create must load its page module lazily');
  assert.equal(leaf.route.element, undefined, '/users/create must not declare an eager element');

  const detail = matchRoutes(appRoutes, '/users/operator-one');
  assert.ok(detail && detail.length > 0, 'the router must resolve a user detail path');
  assert.equal(detail[detail.length - 1].route.path, '/users/:username', 'other usernames must resolve to the detail route');
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
