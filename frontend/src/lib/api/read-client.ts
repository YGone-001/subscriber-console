import { ReadApiError, readErrorMessage } from './errors';

async function request(path: string, signal?: AbortSignal): Promise<Response> {
  const response = await fetch(path, { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal });
  if (response.status === 401 && typeof window !== 'undefined') window.dispatchEvent(new Event('xcloud-session-revalidate'));
  return response;
}

export async function getJson<T>(path: string, requester: (path: string) => Promise<Response> = request): Promise<T> {
  let response: Response;
  try { response = await requester(path); } catch { throw new ReadApiError(0, 'The service could not be reached.'); }
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) throw new ReadApiError(response.status, readErrorMessage(response.status, body), body);
  return body as T;
}

export async function getJsonWithSignal<T>(path: string, signal: AbortSignal): Promise<T> {
  return getJson<T>(path, (requestPath) => request(requestPath, signal));
}

export async function getBlob(path: string): Promise<Blob> {
  let response: Response;
  try { response = await request(path); } catch { throw new ReadApiError(0, 'The service could not be reached.'); }
  if (!response.ok) { const body: unknown = await response.json().catch(() => undefined); throw new ReadApiError(response.status, readErrorMessage(response.status, body), body); }
  return response.blob();
}
