import { preload } from "swr";
import { fetcher } from "@/lib/fetcher";

/**
 * First-screen SWR keys for the primary dashboard routes.
 *
 * Keep this list deliberately small: navigation intent should warm only the
 * request that gates the destination's main content, not drawers, details, or
 * every secondary KPI request on that page.
 */
const NAVIGATION_DATA_KEYS: Readonly<Record<string, readonly string[]>> = {
  "/": ["/api/analytics/metrics"],
  "/subscribers": [
    "/api/subscribers?detail=true&page=1&limit=10&sortField=imsi&sortDirection=asc",
    "/api/profiles",
  ],
  "/ocs/tariffs": ["/api/tariff-plans"],
  "/ocs/contracts": [
    "/api/ocs/subscribers?page=1&limit=20&imsi=&status=&sortField=updated_at&sortOrder=desc",
  ],
  "/ocs/balances": ["/api/ocs/balances?page=1&limit=20&imsi=&status="],
  "/profile": ["/api/profiles"],
  "/approvals": ["/api/approvals?page=1&pageSize=20"],
  "/audit-logs": ["/api/audit?page=1&pageSize=20"],
  "/users": ["/api/users?page=1&pageSize=10&sort=createdAt&order=desc"],
  "/system-health": ["/api/system/health"],
};

export function getNavigationDataKeys(path: string): readonly string[] {
  const pathname = path.split(/[?#]/, 1)[0] || "/";
  return NAVIGATION_DATA_KEYS[pathname] || [];
}

export function prefetchNavigationData(path: string) {
  for (const key of getNavigationDataKeys(path)) {
    // Navigation must never fail because an optional warm-up request failed.
    // The destination SWR hook remains responsible for its normal error UI.
    void preload(key, fetcher).catch(() => undefined);
  }
}
