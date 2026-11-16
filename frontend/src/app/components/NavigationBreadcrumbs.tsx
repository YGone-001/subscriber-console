/*
 * Breadcrumb bar with the tool cluster.
 *
 * Forward-ported from the historical xCloud UI (reference commit 2c40903):
 * frontend/src/app/components/NavigationBreadcrumbs.tsx
 *
 * Crumbs stay derived from the current route authority (`getBreadcrumbs`), so the
 * presentation cannot diverge from the accepted route set. The right-hand cluster
 * restores the reference quick-jump tools: recent destinations, copy link and a
 * data refresh.
 *
 * Destinations store the normalized real destination pathname, never unresolved
 * parameter templates (e.g. /subscribers/460020000000400 instead of /subscribers/:imsi).
 * Recent destinations are scoped per user to prevent cross-user information leakage.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useSWRConfig } from 'swr';
import { ChevronRight, Home, Clock, Copy, Check, RotateCw, Trash2, ExternalLink } from 'lucide-react';
import {
  getBreadcrumbs,
  isNavigableDestination,
  normalizePathname,
  resolveNavigationRoute,
  UUID_SEGMENT,
} from '../../lib/navigation';
import { copyText } from '../../lib/clipboard';
import { useI18n } from '../../providers/I18nProvider';
import { useAuth } from '../../providers/AuthProvider';
import type { CanonicalRole } from '../../types/auth';

export const RECENT_PAGES_STORAGE_KEY = 'XCLOUD_RECENT_PAGES';

export function getRecentPagesStorageKey(username?: string | null): string {
  return username ? `${RECENT_PAGES_STORAGE_KEY}:${username}` : RECENT_PAGES_STORAGE_KEY;
}

export interface RecentPageItem {
  path: string;
  labelKey: string;
  timestamp: number;
}

interface StoredRecentEntry {
  path?: unknown;
  labelKey?: unknown;
  timestamp?: unknown;
}

const EMPTY_RECENT: RecentPageItem[] = [];
const recentMemoryCache = new Map<string, { raw: string | null; recent: RecentPageItem[] }>();

export function getStoredRecentSnapshot(username?: string | null, role?: CanonicalRole): RecentPageItem[] {
  if (typeof window === 'undefined') return EMPTY_RECENT;
  const key = getRecentPagesStorageKey(username);
  const cached = recentMemoryCache.get(key);
  try {
    let raw = localStorage.getItem(key);
    // Safe legacy migration: if user-scoped key does not exist yet, check for legacy un-scoped key
    if (raw === null && username) {
      const legacyRaw = localStorage.getItem(RECENT_PAGES_STORAGE_KEY);
      if (legacyRaw !== null) {
        raw = legacyRaw;
        try { localStorage.removeItem(RECENT_PAGES_STORAGE_KEY); } catch { /* best-effort cleanup */ }
      }
    }
    if (cached && cached.raw === raw) return cached.recent;
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const reconstructed: RecentPageItem[] = [];
        for (const item of parsed) {
          if (
            typeof item === 'object' &&
            item !== null &&
            typeof (item as StoredRecentEntry).path === 'string' &&
            typeof (item as StoredRecentEntry).timestamp === 'number'
          ) {
            const rawPath = (item as StoredRecentEntry).path as string;
            const normalizedPath = normalizePathname(rawPath);
            if (isNavigableDestination(normalizedPath, role)) {
              const route = resolveNavigationRoute(normalizedPath);
              if (route && !reconstructed.some((r) => r.path === normalizedPath)) {
                reconstructed.push({
                  path: normalizedPath,
                  labelKey: route.labelKey,
                  timestamp: (item as StoredRecentEntry).timestamp as number,
                });
              }
            }
          }
        }
        recentMemoryCache.set(key, { raw, recent: reconstructed });
        return reconstructed;
      }
    }
  } catch {
    /* Unreadable storage: fall back to empty list */
  }
  recentMemoryCache.set(key, { raw: null, recent: EMPTY_RECENT });
  return EMPTY_RECENT;
}

const recentListeners = new Set<() => void>();
function subscribeRecent(onStoreChange: () => void) {
  recentListeners.add(onStoreChange);
  const handleStorage = (event: StorageEvent) => {
    if (event.key && event.key.startsWith(RECENT_PAGES_STORAGE_KEY)) {
      recentMemoryCache.clear();
      onStoreChange();
    }
  };
  window.addEventListener('storage', handleStorage);
  return () => {
    recentListeners.delete(onStoreChange);
    window.removeEventListener('storage', handleStorage);
  };
}

export function writeRecentPages(next: RecentPageItem[], username?: string | null) {
  const key = getRecentPagesStorageKey(username);
  try {
    const raw = JSON.stringify(next);
    recentMemoryCache.set(key, { raw, recent: next });
    localStorage.setItem(key, raw);
  } catch {
    /* Storage is best-effort: a failed write must not break navigation. */
  }
  for (const listener of recentListeners) {
    listener();
  }
}

export function NavigationBreadcrumbs() {
  const { t } = useI18n();
  const { pathname } = useLocation();
  const { user, state } = useAuth();
  const isAuthLoading = state === 'checking';
  const { mutate } = useSWRConfig();

  const [recentDropdownOpen, setRecentDropdownOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const crumbs = getBreadcrumbs(pathname);

  const getSnapshot = useCallback(() => {
    return getStoredRecentSnapshot(user?.username, user?.role);
  }, [user?.username, user?.role]);

  const storedRecentPages = useSyncExternalStore(subscribeRecent, getSnapshot, () => EMPTY_RECENT);
  const recentPages = useMemo(
    () => storedRecentPages.filter((item) => isNavigableDestination(item.path, user?.role)),
    [storedRecentPages, user?.role],
  );

  // Track recent destinations as the operator moves around.
  useEffect(() => {
    if (!pathname || isAuthLoading) return;
    const normalized = normalizePathname(pathname);
    if (isNavigableDestination(normalized, user?.role)) {
      const matchedRoute = resolveNavigationRoute(normalized);
      if (matchedRoute) {
        const current = getStoredRecentSnapshot(user?.username, user?.role);
        const filtered = current.filter((item) => item.path !== normalized);
        writeRecentPages([
          { path: normalized, labelKey: matchedRoute.labelKey, timestamp: Date.now() },
          ...filtered,
        ].slice(0, 8), user?.username);
      }
    }
  }, [pathname, isAuthLoading, user?.username, user?.role]);

  // Drop destinations the current role can no longer reach.
  useEffect(() => {
    if (isAuthLoading || !user) return;
    const current = getStoredRecentSnapshot(user.username, user.role);
    const accessible = current.filter((item) => isNavigableDestination(item.path, user.role));
    if (accessible.length !== current.length) writeRecentPages(accessible, user.username);
  }, [isAuthLoading, user?.username, user?.role]);

  const handleCopyLink = useCallback(async () => {
    if (!(await copyText(window.location.href))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, []);

  const handleRefresh = useCallback(() => {
    setIsRefreshing(true);
    void mutate(() => true);
    setTimeout(() => setIsRefreshing(false), 600);
  }, [mutate]);

  const handleClearRecent = useCallback(() => {
    writeRecentPages([], user?.username);
    setRecentDropdownOpen(false);
  }, [user?.username]);

  return (
    <nav className="nav-breadcrumbs-bar" aria-label={t('breadcrumbs_label')}>
      <div className="nav-breadcrumbs-left">
        <Link to="/" className="nav-breadcrumb-home" aria-label={t('breadcrumbs_home')}>
          <Home size={14} aria-hidden="true" />
        </Link>
        {crumbs.filter((crumb) => crumb.labelKey !== 'breadcrumbs_home').map((crumb, index) => (
          <span className="nav-breadcrumb-segment" key={`${crumb.path ?? 'current'}-${index}`}>
            <ChevronRight size={14} className="nav-breadcrumb-separator" aria-hidden="true" />
            {crumb.current || !crumb.path ? (
              <span className="nav-breadcrumb-current" aria-current="page">{t(crumb.labelKey)}</span>
            ) : (
              <Link to={crumb.path} className="nav-breadcrumb-link">{t(crumb.labelKey)}</Link>
            )}
          </span>
        ))}
      </div>

      <div className="nav-breadcrumbs-right">
        <div className="nav-recent-wrap">
          <button
            type="button"
            className="nav-crumb-tool-btn"
            onClick={() => setRecentDropdownOpen((prev) => !prev)}
            title={t('nav_crumb_recent_title')}
            aria-expanded={recentDropdownOpen}
          >
            <Clock size={13} aria-hidden="true" />
            <span className="nav-crumb-btn-text">{t('nav_crumb_recent_btn')}</span>
          </button>

          {recentDropdownOpen ? (
            <>
              <div className="dropdown-backdrop" onClick={() => setRecentDropdownOpen(false)} />
              <div className="nav-recent-dropdown">
                <div className="nav-recent-header">
                  <strong>{t('nav_crumb_recent_title')}</strong>
                  {recentPages.length > 0 ? (
                    <button
                      type="button"
                      className="nav-recent-clear"
                      onClick={handleClearRecent}
                      title={t('nav_crumb_clear_recent')}
                    >
                      <Trash2 size={12} aria-hidden="true" />
                      <span>{t('nav_crumb_clear_recent')}</span>
                    </button>
                  ) : null}
                </div>

                <div className="nav-recent-list">
                  {recentPages.length === 0 ? (
                    <div className="nav-recent-empty">{t('nav_crumb_no_recent')}</div>
                  ) : (
                    recentPages.map((item) => {
                      const route = resolveNavigationRoute(item.path);
                      const lastSegment = route && route.dynamicParameters.length > 0
                        ? item.path.split('/').filter(Boolean).at(-1)
                        : null;
                      const displayParam = lastSegment && UUID_SEGMENT.test(lastSegment)
                        ? `${lastSegment.slice(0, 8)}...`
                        : lastSegment;
                      const label = displayParam
                        ? `${t(item.labelKey)} (${displayParam})`
                        : t(item.labelKey);

                      return (
                        <Link
                          key={item.path}
                          to={item.path}
                          className={`nav-recent-item ${item.path === pathname ? 'active' : ''}`}
                          onClick={() => setRecentDropdownOpen(false)}
                          title={item.path}
                        >
                          <span className="nav-recent-label">{label}</span>
                          <ExternalLink size={12} className="nav-recent-link-icon" aria-hidden="true" />
                        </Link>
                      );
                    })
                  )}
                </div>
              </div>
            </>
          ) : null}
        </div>

        <button
          type="button"
          className="nav-crumb-tool-btn"
          onClick={handleCopyLink}
          title={copied ? t('nav_crumb_copied') : t('nav_crumb_copy_link')}
        >
          {copied ? <Check size={13} className="text-success" aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
          <span className="nav-crumb-btn-text">
            {copied ? t('nav_crumb_copied') : t('nav_crumb_copy_link')}
          </span>
        </button>

        <button
          type="button"
          className={`nav-crumb-tool-btn icon-only ${isRefreshing ? 'spin' : ''}`}
          onClick={handleRefresh}
          title={t('nav_crumb_refresh')}
          aria-label={t('nav_crumb_refresh')}
        >
          <RotateCw size={13} aria-hidden="true" />
        </button>
      </div>
    </nav>
  );
}

export default NavigationBreadcrumbs;
