"use client";

import { SWRConfig } from "swr";
import React from "react";

export function SWRProvider({ children }: { children: React.ReactNode }) {
  return (
    <SWRConfig
      value={{
        revalidateOnFocus: false,
        revalidateOnReconnect: true,
        errorRetryCount: 3,
        onErrorRetry: (error, key, config, revalidate, { retryCount }) => {
          // Never retry on 404 (Not Found)
          if (error.status === 404) return;

          // Never retry on 401 Unauthorized or 403 Forbidden
          if (error.status === 401 || error.status === 403) return;

          // Only retry up to 3 times
          if (retryCount >= 3) return;

          // Retry with exponential backoff (1s, 2s, 4s...)
          setTimeout(() => revalidate({ retryCount }), Math.min(1000 * 2 ** retryCount, 10000));
        }
      }}
    >
      {children}
    </SWRConfig>
  );
}
