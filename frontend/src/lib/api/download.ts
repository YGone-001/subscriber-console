/*
 * Attachment download.
 *
 * Export endpoints answer with a file body plus `Content-Disposition`, so they
 * cannot travel through the JSON read client (it would parse the body and lose
 * the header). This helper owns the one raw `fetch` the console needs for a file,
 * which also keeps business feature code free of direct network calls.
 *
 * The request is same-origin and credentialed, matching every other console read.
 * The object URL is revoked on the next tick so repeated exports do not leak.
 */
export class AttachmentError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'AttachmentError';
  }
}

const FILENAME_PATTERN = /filename="?([^";]+)"?/i;

/** Server-provided attachment name, or the caller's documented fallback. */
export function attachmentFileName(disposition: string | null, fallback: string): string {
  const match = disposition ? FILENAME_PATTERN.exec(disposition) : null;
  return match ? match[1] : fallback;
}

export async function downloadAttachment(path: string, fallbackFileName: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(path, { method: 'GET', credentials: 'same-origin', cache: 'no-store' });
  } catch {
    throw new AttachmentError(0, 'The download request could not be completed.');
  }

  if (response.status === 401 && typeof window !== 'undefined') {
    window.dispatchEvent(new Event('xcloud-session-revalidate'));
  }

  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined);
    const message = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
      ? body.error
      : `The download request failed with status ${response.status}.`;
    throw new AttachmentError(response.status, message);
  }

  const blob = await response.blob();
  const fileName = attachmentFileName(response.headers.get('Content-Disposition'), fallbackFileName);
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  return fileName;
}
