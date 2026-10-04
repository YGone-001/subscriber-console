import assert from 'node:assert/strict';
import test from 'node:test';
import { ReadApiError } from '../src/lib/api/errors';
import { getJson } from '../src/lib/api/read-client';

function response(status: number, body: unknown) { return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }); }

test('read client returns parsed GET JSON', async () => {
  const value = await getJson<{ value: number }>('/api/example', async () => response(200, { value: 1 }));
  assert.equal(value.value, 1);
});

test('read client maps HTTP and network failures without success data', async () => {
  for (const status of [401, 403, 404, 429, 500]) {
    await assert.rejects(getJson('/api/example', async () => response(status, { error: `error-${status}` })), (error: unknown) => error instanceof ReadApiError && error.status === status);
  }
  await assert.rejects(getJson('/api/example', async () => Promise.reject(new Error('offline'))), (error: unknown) => error instanceof ReadApiError && error.status === 0);
});
