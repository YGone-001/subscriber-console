/**
 * Global SWR Fetcher Utility
 * ------------------------------------------------------------------
 * Replaces inline `fetch(url).then(res => res.json())` used across the app.
 * Automatically handles throwing standard HTTP errors (like 404, 500)
 * so that SWR's `error` state is properly triggered.
 */
export interface FetchError extends Error {
  status?: number;
  info?: unknown;
}

let redirecting = false;
export function handleSessionExpiry(status: number) {
  if (status !== 401 || typeof window === 'undefined' || redirecting || window.location.pathname === '/login') return;
  redirecting = true;
  // Full navigation also discards the in-memory SWR/auth cache. Do not retry a revoked session.
  window.location.replace('/login?reason=session-expired');
}

export const fetcher = async <T = unknown>(url: string): Promise<T> => {
  const res = await fetch(url);

  if (!res.ok) {
    handleSessionExpiry(res.status);
    let errorMsg = 'An error occurred while fetching the data.';
    let errorInfo: unknown = null;
    try {
      errorInfo = await res.json();
      errorMsg = (errorInfo as { error?: string; message?: string })?.error ||
        (errorInfo as { error?: string; message?: string })?.message ||
        errorMsg;
    } catch {
      errorMsg = res.statusText || errorMsg;
    }

    const error = new Error(errorMsg) as FetchError;
    error.status = res.status;
    error.info = errorInfo;
    throw error;
  }

  return res.json();
};
