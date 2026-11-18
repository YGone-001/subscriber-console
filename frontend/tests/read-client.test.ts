import assert from 'node:assert/strict';
import test from 'node:test';
import { ReadApiError } from '../src/lib/api/errors';
import { getBlob, getJson, isAbortError } from '../src/lib/api/read-client';

function response(status: number, body: unknown) { return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }); }

function abortError() {
  return new DOMException('The operation was aborted.', 'AbortError');
}

/* A response whose headers already arrived, but whose body is cancelled while
 * being consumed. `json()` rejects with the same AbortError the fetch signal
 * produces, which must not be mistaken for malformed JSON. */
function cancelledBodyResponse(status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => { throw abortError(); },
    blob: async () => { throw abortError(); },
  } as unknown as Response;
}

test('read client returns parsed GET JSON', async () => {
  const value = await getJson<{ value: number }>('/api/example', async () => response(200, { value: 1 }));
  assert.equal(value.value, 1);
});

test('read client preserves cancellation that happens before response headers', async () => {
  await assert.rejects(
    getJson('/api/example', async () => { throw abortError(); }),
    (error: unknown) => isAbortError(error) && !(error instanceof ReadApiError),
  );
});

test('read client preserves cancellation while the response body is consumed', async () => {
  await assert.rejects(
    getJson('/api/example', async () => cancelledBodyResponse(200)),
    (error: unknown) => isAbortError(error) && !(error instanceof ReadApiError),
  );
  await assert.rejects(
    getJson('/api/example', async () => cancelledBodyResponse(500)),
    (error: unknown) => isAbortError(error) && !(error instanceof ReadApiError),
    'cancellation during an error body must not be rewritten as an HTTP failure',
  );
});

test('read client keeps malformed and HTTP error handling compatible', async () => {
  const malformed = new Response('not-json', { status: 200 });
  assert.equal(await getJson('/api/example', async () => malformed), undefined);

  const malformedError = new Response('not-json', { status: 502 });
  await assert.rejects(
    getJson('/api/example', async () => malformedError),
    (error: unknown) => error instanceof ReadApiError && error.status === 502 && error.body === undefined,
  );
});

test('read client maps HTTP and network failures without success data', async () => {
  for (const status of [401, 403, 404, 429, 500]) {
    await assert.rejects(getJson('/api/example', async () => response(status, { error: `error-${status}` })), (error: unknown) => error instanceof ReadApiError && error.status === status);
  }
  await assert.rejects(getJson('/api/example', async () => Promise.reject(new Error('offline'))), (error: unknown) => error instanceof ReadApiError && error.status === 0 && !isAbortError(error));
});

test('read client still revalidates the session on 401', async () => {
  const originalWindow = (globalThis as { window?: unknown }).window;
  const originalFetch = globalThis.fetch;
  const events: string[] = [];
  const fakeWindow = new EventTarget();
  fakeWindow.addEventListener('xcloud-session-revalidate', () => events.push('revalidate'));
  (globalThis as { window?: unknown }).window = fakeWindow;
  (globalThis as { fetch: typeof fetch }).fetch = (async () => response(401, { error: 'Invalid credentials' })) as typeof fetch;
  try {
    await assert.rejects(getJson('/api/example'), (error: unknown) => error instanceof ReadApiError && error.status === 401);
    assert.deepEqual(events, ['revalidate']);
  } finally {
    (globalThis as { window?: unknown }).window = originalWindow;
    (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
  }
});

test('blob reads preserve cancellation while consuming an error body', async () => {
  const originalFetch = globalThis.fetch;
  (globalThis as { fetch: typeof fetch }).fetch = (async () => cancelledBodyResponse(500)) as typeof fetch;
  try {
    await assert.rejects(
      getBlob('/api/example', new AbortController().signal),
      (error: unknown) => isAbortError(error) && !(error instanceof ReadApiError),
    );
  } finally {
    (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
  }
});