import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyAuthStatus, getAuthSession, getAuthState } from '../src/auth/auth-client';
import { safeLocalDestination } from '../src/auth/auth-state';

test('classifies Go auth responses fail closed', async () => {
  assert.equal(classifyAuthStatus(200), 'authenticated');
  assert.equal(classifyAuthStatus(401), 'unauthenticated');
  assert.equal(classifyAuthStatus(503), 'unavailable');
  assert.equal(classifyAuthStatus(500), 'unavailable');
  const state = await getAuthState(async () => new Response(null, { status: 503 }));
  assert.equal(state, 'unavailable');
});

test('treats transport failure as unavailable', async () => {
  const state = await getAuthState(async () => Promise.reject(new Error('offline')));
  assert.equal(state, 'unavailable');
});

test('accepts an authenticated user only from the session authority response', async () => {
  const result = await getAuthSession(async () => new Response(JSON.stringify({ username: 'operator-a', role: 'operator', status: 'active' }), { status: 200 }));
  assert.deepEqual(result, { state: 'authenticated', user: { username: 'operator-a', role: 'operator', status: 'active' } });
  const withPerms = await getAuthSession(async () => new Response(JSON.stringify({
    username: 'admin-a',
    role: 'root',
    normalizedRole: 'admin',
    status: 'active',
    permissions: ['users.read', 'subscribers.write']
  }), { status: 200 }));
  assert.deepEqual(withPerms, {
    state: 'authenticated',
    user: {
      username: 'admin-a',
      role: 'admin',
      normalizedRole: 'admin',
      status: 'active',
      permissions: ['users.read', 'subscribers.write']
    }
  });
  const invalid = await getAuthSession(async () => new Response(JSON.stringify({ username: 'operator-a', role: 'unknown', status: 'active' }), { status: 200 }));
  assert.equal(invalid.state, 'unavailable');
});

test('only accepts local destinations after login', () => {
  assert.equal(safeLocalDestination('/users/admin'), '/users/admin');
  assert.equal(safeLocalDestination('//example.test'), '/');
  assert.equal(safeLocalDestination('/\\example.test'), '/');
  assert.equal(safeLocalDestination('https://example.test'), '/');
  assert.equal(safeLocalDestination(null), '/');
});
