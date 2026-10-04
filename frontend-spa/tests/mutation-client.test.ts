import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MutationApiError,
  deleteJson,
  patchJson,
  postJson,
  putJson,
} from '../src/lib/api/mutation-client';

test('serializes POST request body and uses same-origin credentials', async () => {
  let capturedPath = '';
  let capturedInit: RequestInit | undefined;

  const mockRequester = async (path: string, init: RequestInit): Promise<Response> => {
    capturedPath = path;
    capturedInit = init;
    return new Response(JSON.stringify({ success: true, imsi: '001010000000001' }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const payload = { imsi: '001010000000001', planId: 'default' };
  const result = await postJson<{ success: boolean; imsi: string }>(
    '/api/subscribers',
    payload,
    mockRequester,
  );

  assert.equal(capturedPath, '/api/subscribers');
  assert.equal(capturedInit?.method, 'POST');
  assert.equal(capturedInit?.credentials, 'same-origin');
  assert.equal(capturedInit?.body, JSON.stringify(payload));
  assert.equal(result.imsi, '001010000000001');
});

test('serializes PUT request body', async () => {
  let capturedInit: RequestInit | undefined;
  const mockRequester = async (_path: string, init: RequestInit): Promise<Response> => {
    capturedInit = init;
    return new Response(JSON.stringify({ updated: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const payload = { title: 'Updated' };
  await putJson('/api/profiles/test_profile', payload, mockRequester);

  assert.equal(capturedInit?.method, 'PUT');
  assert.equal(capturedInit?.credentials, 'same-origin');
  assert.equal(capturedInit?.body, JSON.stringify(payload));
});

test('serializes PATCH request body', async () => {
  let capturedInit: RequestInit | undefined;
  const mockRequester = async (_path: string, init: RequestInit): Promise<Response> => {
    capturedInit = init;
    return new Response(JSON.stringify({ updated: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const payload = { plan_id: 'plan_b' };
  await patchJson('/api/ocs/subscribers/001010000000001', payload, mockRequester);

  assert.equal(capturedInit?.method, 'PATCH');
  assert.equal(capturedInit?.credentials, 'same-origin');
  assert.equal(capturedInit?.body, JSON.stringify(payload));
});

test('executes DELETE request without body', async () => {
  let capturedInit: RequestInit | undefined;
  const mockRequester = async (_path: string, init: RequestInit): Promise<Response> => {
    capturedInit = init;
    return new Response(JSON.stringify({ deleted: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  await deleteJson('/api/subscribers/001010000000001', mockRequester);

  assert.equal(capturedInit?.method, 'DELETE');
  assert.equal(capturedInit?.credentials, 'same-origin');
  assert.equal(capturedInit?.body, undefined);
});

test('propagates structured error on 400 validation failure', async () => {
  const mockRequester = async (): Promise<Response> => {
    return new Response(JSON.stringify({ error: 'Invalid IMSI format', code: 'INVALID_IMSI' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  await assert.rejects(
    async () => postJson('/api/subscribers', { imsi: 'bad' }, mockRequester),
    (err: unknown) => {
      assert.ok(err instanceof MutationApiError);
      assert.equal(err.status, 400);
      assert.equal(err.message, 'Invalid IMSI format');
      assert.equal(err.code, 'INVALID_IMSI');
      return true;
    },
  );
});

test('dispatches xcloud-session-revalidate on 401 and propagates error', async () => {
  let revalidated = false;
  const originalWindow = (globalThis as unknown as { window?: EventTarget }).window;
  const customTarget = new EventTarget();
  customTarget.addEventListener('xcloud-session-revalidate', () => {
    revalidated = true;
  });
  (globalThis as unknown as { window: EventTarget }).window = customTarget;

  try {
    const mockRequester = async (): Promise<Response> => {
      return new Response(JSON.stringify({ error: 'Session expired', code: 'AUTH_INVALID_TOKEN' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    await assert.rejects(
      async () => postJson('/api/users', {}, mockRequester),
      (err: unknown) => {
        assert.ok(err instanceof MutationApiError);
        assert.equal(err.status, 401);
        assert.equal(err.message, 'Session expired');
        return true;
      },
    );
    assert.equal(revalidated, true);
  } finally {
    (globalThis as unknown as { window?: EventTarget }).window = originalWindow;
  }
});

test('preserves 403 as authorization denial without redirecting', async () => {
  const mockRequester = async (): Promise<Response> => {
    return new Response(JSON.stringify({ error: 'Permission denied', code: 'PERMISSION_DENIED' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  await assert.rejects(
    async () => postJson('/api/users', {}, mockRequester),
    (err: unknown) => {
      assert.ok(err instanceof MutationApiError);
      assert.equal(err.status, 403);
      assert.equal(err.message, 'Permission denied');
      assert.equal(err.code, 'PERMISSION_DENIED');
      return true;
    },
  );
});

test('preserves 409 conflict and CAS state errors', async () => {
  const mockRequester = async (): Promise<Response> => {
    return new Response(
      JSON.stringify({ error: 'Balance precondition changed', code: 'BALANCE_PRECONDITION_CHANGED' }),
      {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  };

  await assert.rejects(
    async () => postJson('/api/ocs/balances/001010000000001/adjust', {}, mockRequester),
    (err: unknown) => {
      assert.ok(err instanceof MutationApiError);
      assert.equal(err.status, 409);
      assert.equal(err.message, 'Balance precondition changed');
      assert.equal(err.code, 'BALANCE_PRECONDITION_CHANGED');
      return true;
    },
  );
});

test('preserves 429 rate limit with parsed Retry-After header', async () => {
  const mockRequester = async (): Promise<Response> => {
    return new Response(JSON.stringify({ error: 'Too many requests' }), {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': '30',
      },
    });
  };

  await assert.rejects(
    async () => postJson('/api/users', {}, mockRequester),
    (err: unknown) => {
      assert.ok(err instanceof MutationApiError);
      assert.equal(err.status, 429);
      assert.equal(err.retryAfter, 30);
      return true;
    },
  );
});

test('handles network failure with status 0', async () => {
  const mockRequester = async (): Promise<Response> => {
    throw new Error('Connection refused');
  };

  await assert.rejects(
    async () => postJson('/api/subscribers', {}, mockRequester),
    (err: unknown) => {
      assert.ok(err instanceof MutationApiError);
      assert.equal(err.status, 0);
      assert.equal(err.message, 'Connection refused');
      return true;
    },
  );
});

test('does NOT automatically retry failed mutations', async () => {
  let callCount = 0;
  const mockRequester = async (): Promise<Response> => {
    callCount += 1;
    return new Response(JSON.stringify({ error: 'Service Unavailable' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  await assert.rejects(
    async () => postJson('/api/subscribers', {}, mockRequester),
    (err: unknown) => {
      assert.ok(err instanceof MutationApiError);
      assert.equal(err.status, 503);
      return true;
    },
  );

  assert.equal(callCount, 1, 'must never automatically retry a mutation');
});

test('rejects non-relative or non-api mutation paths', async () => {
  await assert.rejects(
    async () => postJson('http://127.0.0.1:18888/api/subscribers', {}),
    (err: unknown) => {
      assert.ok(err instanceof MutationApiError);
      assert.match(err.message, /relative \/api/);
      return true;
    },
  );

  await assert.rejects(
    async () => postJson('/not-api/subscribers', {}),
    (err: unknown) => {
      assert.ok(err instanceof MutationApiError);
      assert.match(err.message, /relative \/api/);
      return true;
    },
  );
});
