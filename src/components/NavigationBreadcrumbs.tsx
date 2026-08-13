"use client";

import { useEffect, useState, useMemo, useCallback, useSyncExternalStore } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import {
  ChevronRight,
  Home,
  Clock,
  Copy,
  Check,
  RotateCw,
  Trash2,
  ExternalLink,
} from "lucide-react";
import { useI18n } from "@/components/I18nProvider";
import { useAuth } from "@/hooks/useAuth";
import {
  canAccessNavigationRoute,
  getNavigationRoute,
  resolveNavigationRoute,
} from "@/lib/navigationRoutes";

const RECENT_PAGES_STORAGE_KEY = "XCLOUD_RECENT_PAGES";

interface BreadcrumbCrumb {
  labelKey: string;
  path?: string;
  isCurrent?: boolean;
}

interface RecentPageItem {
  path: string;
  labelKey: string;
  timestamp: number;
}

const EMPTY_RECENT: RecentPageItem[] = [];
let cachedRawRecent: string | null = null;
let cachedRecent: RecentPageItem[] = EMPTY_RECENT;

function getRecentPagesSnapshot(): RecentPageItem[] {
  if (typeof window === "undefined") return EMPTY_RECENT;
  try {
    const raw = localStorage.getItem(RECENT_PAGES_STORAGE_KEY);
    if (raw === cachedRawRecent && cachedRecent) return cachedRecent;
    cachedRawRecent = raw;
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error("Invalid recent page storage");
      cachedRecent = parsed.filter((item): item is RecentPageItem => (
        typeof item === "object" &&
        item !== null &&
        typeof item.path === "string" &&
        typeof item.labelKey === "string" &&
        typeof item.timestamp === "number" &&
        Boolean(getNavigationRoute(item.path))
      ));
      return cachedRecent;
    }
  } catch {}
  cachedRecent = EMPTY_RECENT;
  return EMPTY_RECENT;
}

const recentListeners = new Set<() => void>();
function subscribeRecent(onStoreChange: () => void) {
  recentListeners.add(onStoreChange);
  const handleStorage = (e: StorageEvent) => {
    if (e.key === RECENT_PAGES_STORAGE_KEY) {
      cachedRawRecent = null;
      onStoreChange();
    }
  };
  window.addEventListener("storage", handleStorage);
  return () => {
    recentListeners.delete(onStoreChange);
    window.removeEventListener("storage", handleStorage);
  };
}

function writeRecentPages(next: RecentPageItem[]) {
  cachedRecent = next;
  try {
    cachedRawRecent = JSON.stringify(next);
    localStorage.setItem(RECENT_PAGES_STORAGE_KEY, cachedRawRecent);
  } catch {}
  for (const listener of recentListeners) {
    listener();
  }
}

export default function NavigationBreadcrumbs() {
  const pathname = usePathname();
  const router = useRouter();
  const { t } = useI18n();
  const { user, isLoading: isAuthLoading } = useAuth();

  const [recentDropdownOpen, setRecentDropdownOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const storedRecentPages = useSyncExternalStore(subscribeRecent, getRecentPagesSnapshot, () => EMPTY_RECENT);
  const recentPages = useMemo(
    () => storedRecentPages.filter((item) => {
      const route = getNavigationRoute(item.path);
      return route && canAccessNavigationRoute(route, user?.role);
    }),
    [storedRecentPages, user?.role]
  );

  // Track recent pages when pathname changes
  useEffect(() => {
    if (!pathname) return;

    const matchedRoute = resolveNavigationRoute(pathname);
    if (matchedRoute && canAccessNavigationRoute(matchedRoute, user?.role)) {
      const current = getRecentPagesSnapshot();
      const filtered = current.filter((item) => item.path !== matchedRoute.path);
      const next: RecentPageItem[] = [
        { path: matchedRoute.path, labelKey: matchedRoute.labelKey, timestamp: Date.now() },
        ...filtered,
      ].slice(0, 8);
      writeRecentPages(next);
    }
  }, [pathname, user?.role]);

  useEffect(() => {
    if (isAuthLoading || !user) return;
    const current = getRecentPagesSnapshot();
    const accessible = current.filter((item) => {
      const route = getNavigationRoute(item.path);
      return route && canAccessNavigationRoute(route, user.role);
    });
    if (accessible.length !== current.length) writeRecentPages(accessible);
  }, [isAuthLoading, user]);

  const breadcrumbs = useMemo<BreadcrumbCrumb[]>(() => {
    const matchedRoute = resolveNavigationRoute(pathname);
    if (!matchedRoute || matchedRoute.path === "/") {
      return [{ labelKey: "nav_dashboard", path: "/", isCurrent: true }];
    }

    const crumbs: BreadcrumbCrumb[] = [
      { labelKey: "nav_dashboard", path: "/" },
    ];

    if (matchedRoute.groupLabelKey) {
      crumbs.push({
        labelKey: matchedRoute.groupLabelKey,
        path: matchedRoute.groupPath,
      });
    }

    crumbs.push({
      labelKey: matchedRoute.labelKey,
      path: matchedRoute.path,
      isCurrent: true,
    });

    return crumbs;
  }, [pathname]);

  const handleCopyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  }, []);

  const handleRefresh = useCallback(() => {
    setIsRefreshing(true);
    router.refresh();
    setTimeout(() => setIsRefreshing(false), 600);
  }, [router]);

  const handleClearRecent = useCallback(() => {
    writeRecentPages([]);
    setRecentDropdownOpen(false);
  }, []);

  return (
    <nav className="nav-breadcrumbs-bar" aria-label="Breadcrumb Navigation">
      <div className="nav-breadcrumbs-left">
        <Link href="/" className="nav-breadcrumb-home" title={t("nav_dashboard")}>
          <Home size={14} />
        </Link>

        {breadcrumbs.map((crumb, idx) => {
          const isLast = idx === breadcrumbs.length - 1;
          return (
            <div key={`${crumb.path || crumb.labelKey}-${idx}`} className="nav-breadcrumb-segment">
              <ChevronRight size={13} className="nav-breadcrumb-separator" />
              {isLast ? (
                <span className="nav-breadcrumb-current" aria-current="page">
                  {t(crumb.labelKey)}
                </span>
              ) : (
                <Link href={crumb.path || "/"} className="nav-breadcrumb-link">
                  {t(crumb.labelKey)}
                </Link>
              )}
            </div>
          );
        })}
      </div>

      <div className="nav-breadcrumbs-right">
        {/* Recent History Quick Jump */}
        <div className="nav-recent-wrap">
          <button
            type="button"
            className="nav-crumb-tool-btn"
            onClick={() => setRecentDropdownOpen((prev) => !prev)}
            title={t("nav_crumb_recent_title")}
            aria-expanded={recentDropdownOpen}
          >
            <Clock size={13} />
            <span className="nav-crumb-btn-text">{t("nav_crumb_recent_btn")}</span>
          </button>

          {recentDropdownOpen ? (
            <>
              <div className="dropdown-backdrop" onClick={() => setRecentDropdownOpen(false)} />
              <div className="nav-recent-dropdown">
                <div className="nav-recent-header">
                  <strong>{t("nav_crumb_recent_title")}</strong>
                  {recentPages.length > 0 ? (
                    <button
                      type="button"
                      className="nav-recent-clear"
                      onClick={handleClearRecent}
                      title={t("nav_crumb_clear_recent")}
                    >
                      <Trash2 size={12} />
                      <span>{t("nav_crumb_clear_recent")}</span>
                    </button>
                  ) : null}
                </div>

                <div className="nav-recent-list">
                  {recentPages.length === 0 ? (
                    <div className="nav-recent-empty">{t("nav_crumb_no_recent")}</div>
                  ) : (
                    recentPages.map((item) => (
                      <Link
                        key={item.path}
                        href={item.path}
                        className={`nav-recent-item ${item.path === pathname ? "active" : ""}`}
                        onClick={() => setRecentDropdownOpen(false)}
                      >
                        <span className="nav-recent-label">{t(item.labelKey)}</span>
                        <ExternalLink size={12} className="nav-recent-link-icon" />
                      </Link>
                    ))
                  )}
                </div>
              </div>
            </>
          ) : null}
        </div>

        {/* Copy Link Button */}
        <button
          type="button"
          className="nav-crumb-tool-btn"
          onClick={handleCopyLink}
          title={copied ? t("nav_crumb_copied") : t("nav_crumb_copy_link")}
        >
          {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
          <span className="nav-crumb-btn-text">
            {copied ? t("nav_crumb_copied") : t("nav_crumb_copy_link")}
          </span>
        </button>

        {/* Quick Refresh Button */}
        <button
          type="button"
          className={`nav-crumb-tool-btn icon-only ${isRefreshing ? "spin" : ""}`}
          onClick={handleRefresh}
          title={t("nav_crumb_refresh")}
          aria-label={t("nav_crumb_refresh")}
        >
          <RotateCw size={13} />
        </button>
      </div>
    </nav>
  );
}
