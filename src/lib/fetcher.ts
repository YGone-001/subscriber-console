/**
 * Global SWR Fetcher Utility
 * ------------------------------------------------------------------
 * Replaces inline `fetch(url).then(res => res.json())` used across the app.
 * Automatically handles throwing standard HTTP errors (like 404, 500)
 * so that SWR's `error` state is properly triggered.
 */
export interface FetchError extends Error {
  status?: number;
  info?: any;
}

export const fetcher = async (url: string): Promise<any> => {
  const res = await fetch(url);

  if (!res.ok) {
    let errorMsg = 'An error occurred while fetching the data.';
    let errorInfo: any = null;
    try {
      errorInfo = await res.json();
      errorMsg = errorInfo.error || errorInfo.message || errorMsg;
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
