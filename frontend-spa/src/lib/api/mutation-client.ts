export class MutationApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
    public readonly code?: string,
    public readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'MutationApiError';
  }
}

export function extractErrorMessage(status: number, body: unknown): { message: string; code?: string } {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    const code = typeof record.code === 'string' ? record.code : undefined;
    if (typeof record.error === 'string' && record.error.trim()) {
      return { message: record.error.trim(), code };
    }
    if (typeof record.message === 'string' && record.message.trim()) {
      return { message: record.message.trim(), code };
    }
  }

  if (status === 400) return { message: 'Validation failed.' };
  if (status === 401) return { message: 'Session expired or invalid.' };
  if (status === 403) return { message: 'Permission denied.' };
  if (status === 404) return { message: 'Resource not found.' };
  if (status === 409) return { message: 'Conflict or concurrent modification detected.' };
  if (status === 429) return { message: 'Rate limit exceeded. Please try again later.' };
  if (status >= 500) return { message: 'Service failure occurred.' };
  if (status === 0) return { message: 'Network request failed.' };
  return { message: 'Operation could not be completed.' };
}

function parseRetryAfter(response: Response): number | undefined {
  const header = response.headers.get('Retry-After');
  if (!header) return undefined;
  const parsed = parseInt(header, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function assertSafeApiPath(path: string): void {
  if (typeof path !== 'string' || !path.startsWith('/api/')) {
    throw new MutationApiError(0, 'Mutation path must be a relative /api route.');
  }
}

type MutationMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

async function executeMutation<T>(
  method: MutationMethod,
  path: string,
  body?: unknown,
  requester?: (path: string, init: RequestInit) => Promise<Response>,
): Promise<T> {
  assertSafeApiPath(path);

  const init: RequestInit = {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
  };

  if (body !== undefined) {
    init.headers = {
      'Content-Type': 'application/json',
    };
    init.body = JSON.stringify(body);
  }

  let response: Response;
  const doFetch = requester ?? fetch;
  try {
    response = await doFetch(path, init);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'Network failure';
    throw new MutationApiError(0, message);
  }

  if (response.status === 401 && typeof window !== 'undefined') {
    window.dispatchEvent(new Event('xcloud-session-revalidate'));
  }

  let responseBody: unknown;
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      responseBody = await response.json();
    } catch {
      responseBody = undefined;
    }
  } else {
    try {
      const text = await response.text();
      responseBody = text ? { message: text } : undefined;
    } catch {
      responseBody = undefined;
    }
  }

  if (!response.ok) {
    const { message, code } = extractErrorMessage(response.status, responseBody);
    const retryAfter = parseRetryAfter(response);
    throw new MutationApiError(response.status, message, responseBody, code, retryAfter);
  }

  return responseBody as T;
}

export async function postJson<T = unknown>(
  path: string,
  body?: unknown,
  requester?: (path: string, init: RequestInit) => Promise<Response>,
): Promise<T> {
  return executeMutation<T>('POST', path, body, requester);
}

export async function putJson<T = unknown>(
  path: string,
  body?: unknown,
  requester?: (path: string, init: RequestInit) => Promise<Response>,
): Promise<T> {
  return executeMutation<T>('PUT', path, body, requester);
}

export async function patchJson<T = unknown>(
  path: string,
  body?: unknown,
  requester?: (path: string, init: RequestInit) => Promise<Response>,
): Promise<T> {
  return executeMutation<T>('PATCH', path, body, requester);
}

export async function deleteJson<T = unknown>(
  path: string,
  requester?: (path: string, init: RequestInit) => Promise<Response>,
): Promise<T> {
  return executeMutation<T>('DELETE', path, undefined, requester);
}
