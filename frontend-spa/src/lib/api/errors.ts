export class ReadApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly body?: unknown) { super(message); this.name = 'ReadApiError'; }
}

export function readErrorMessage(status: number, body: unknown): string {
  if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') return body.error;
  if (status === 403) return 'You do not have permission to view this resource.';
  if (status === 404) return 'The requested resource was not found.';
  if (status === 429) return 'The read request is rate limited. Please retry shortly.';
  if (status >= 500) return 'The service is currently unavailable.';
  return 'The read request could not be completed.';
}
