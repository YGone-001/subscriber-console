import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyAuthStatus, getAuthState } from '../src/auth/auth-client';
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

test('only accepts local destinations after login', () => {
  assert.equal(safeLocalDestination('/users/admin'), '/users/admin');
  assert.equal(safeLocalDestination('//example.test'), '/');
  assert.equal(safeLocalDestination('/\\example.test'), '/');
  assert.equal(safeLocalDestination('https://example.test'), '/');
  assert.equal(safeLocalDestination(null), '/');
});
