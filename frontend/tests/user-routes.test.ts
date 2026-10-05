import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const spaRoot = resolve(import.meta.dirname, '..');
const routes = JSON.parse(readFileSync(resolve(spaRoot, 'route-contract.json'), 'utf8'));
const routerSource = readFileSync(resolve(spaRoot, 'src/router/router.tsx'), 'utf8');
const userCreateSource = readFileSync(resolve(spaRoot, 'src/features/users/UserCreatePage.tsx'), 'utf8');

test('users create route is active in route contract and router', () => {
  const userCreateRoute = routes.find((r: { route: string }) => r.route === '/users/create');
  assert.ok(userCreateRoute, 'users create route must be present in route contract');

  assert.match(routerSource, /'\/users\/create':\s*<UserCreatePage\s*\/>/, 'router must bind /users/create to UserCreatePage');
});

test('users create page enforces password security invariants', () => {
  assert.doesNotMatch(userCreateSource, /localStorage/, 'passwords must never be stored in localStorage');
  assert.doesNotMatch(userCreateSource, /sessionStorage/, 'passwords must never be stored in sessionStorage');
  assert.doesNotMatch(userCreateSource, /document\.cookie/, 'passwords must never be written to document.cookie');
  assert.match(userCreateSource, /postJson\('\/api\/users'/, 'user creation must call canonical POST /api/users');
});
