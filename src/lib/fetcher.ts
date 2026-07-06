/**
 * Global SWR Fetcher Utility
 * ------------------------------------------------------------------
 * Replaces inline `fetch(url).then(res => res.json())` used across the app.
 * Automatically handles throwing standard HTTP errors (like 404, 500)
 * so that SWR's `error` state is properly triggered.
 */
export const fetcher = async (url: string) => {
  const res = await fetch(url);

  if (!res.ok) {
    // Attempt to extract server error message if present
    let errorMsg = 'An error occurred while fetching the data.';
    try {
      const errorData = await res.json();
      errorMsg = errorData.error || errorMsg;
    } catch {
      // Fallback to HTTP status text
      errorMsg = res.statusText || errorMsg;
    }

    const error = new Error(errorMsg) as Error & { status: number };
    error.status = res.status;
    throw error;
  }

  return res.json();
};
