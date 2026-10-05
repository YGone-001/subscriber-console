/*
 * Breadcrumb bar with the tool cluster.
 *
 * Forward-ported from the historical xCloud UI (reference commit 2c40903):
 * frontend/src/components/NavigationBreadcrumbs.tsx
 *
 * Crumbs stay derived from the current route authority (`getBreadcrumbs`), so the
 * presentation cannot diverge from the accepted route set. The right-hand cluster
 * restores the reference quick-jump tools: recent destinations, copy link and a
 * data refresh.
 *
 * Adaptations: the Next.js router is replaced by react-router-dom.
 * `router.refresh()` has no React Router equivalent, so refresh revalidates the
 * SWR cache instead, which is the honest analogue for a client-rendered SPA.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useSWRConfig } from 'swr';
import { ChevronRight, Home, Clock, Copy, Check, RotateCw, Trash2, ExternalLink } from 'lucide-react';
import { getBreadcrumbs, canAccessNavigationRoute, getNavigationRoute, resolveNavigationRoute } from '../../lib/navigation';
import { useI18n } from '../../providers/I18nProvider';
import { useAuth } from '../../providers/AuthProvider';

const RECENT_PAGES_STORAGE_KEY = 'XCLOUD_RECENT_PAGES';

interface RecentPageItem {
  path: string;
  labelKey: string;
  timestamp: number;
}

const EMPTY_RECENT: RecentPageItem[] = [];
let cachedRawRecent: string | null = null;
let cachedRecent: RecentPageItem[] = EMPTY_RECENT;

function getRecentPagesSnapshot(): RecentPageItem[] {
  if (typeof window === 'undefined') return EMPTY_RECENT;
  try {
    const raw = localStorage.getItem(RECENT_PAGES_STORAGE_KEY);
    if (raw === cachedRawRecent && cachedRecent) return cachedRecent;
    cachedRawRecent = raw;
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('Invalid recent page storage');
      cachedRecent = parsed.filter((item): item is RecentPageItem => (
        typeof item === 'object' &&
        item !== null &&
        typeof (item as RecentPageItem).path === 'string' &&
        typeof (item as RecentPageItem).labelKey === 'string' &&
        typeof (item as RecentPageItem).timestamp === 'number' &&
        Boolean(getNavigationRoute((item as RecentPageItem).path))
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
  const handleStorage = (event: StorageEvent) => {
    if (event.key === RECENT_PAGES_STORAGE_KEY) {
      cachedRawRecent = null;
      onStoreChange();
    }
  };
  window.addEventListener('storage', handleStorage);
  return () => {
    recentListeners.delete(onStoreChange);
    window.removeEventListener('storage', handleStorage);
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

  const storedRecentPages = useSyncExternalStore(subscribeRecent, getRecentPagesSnapshot, () => EMPTY_RECENT);
  const recentPages = useMemo(
    () => storedRecentPages.filter((item) => {
      const route = getNavigationRoute(item.path);
      return route && canAccessNavigationRoute(route, user?.role);
    }),
    [storedRecentPages, user?.role],
  );

  // Track recent destinations as the operator moves around.
  useEffect(() => {
    if (!pathname) return;
    const matchedRoute = resolveNavigationRoute(pathname);
    if (matchedRoute && canAccessNavigationRoute(matchedRoute, user?.role)) {
      const current = getRecentPagesSnapshot();
      const filtered = current.filter((item) => item.path !== matchedRoute.route);
      writeRecentPages([
        { path: matchedRoute.route, labelKey: matchedRoute.labelKey, timestamp: Date.now() },
        ...filtered,
      ].slice(0, 8));
    }
  }, [pathname, user?.role]);

  // Drop destinations the current role can no longer reach.
  useEffect(() => {
    if (isAuthLoading || !user) return;
    const current = getRecentPagesSnapshot();
    const accessible = current.filter((item) => {
      const route = getNavigationRoute(item.path);
      return route && canAccessNavigationRoute(route, user.role);
    });
    if (accessible.length !== current.length) writeRecentPages(accessible);
  }, [isAuthLoading, user]);

  const handleCopyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  }, []);

  const handleRefresh = useCallback(() => {
    setIsRefreshing(true);
    void mutate(() => true);
    setTimeout(() => setIsRefreshing(false), 600);
  }, [mutate]);

  const handleClearRecent = useCallback(() => {
    writeRecentPages([]);
    setRecentDropdownOpen(false);
  }, []);

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
                    recentPages.map((item) => (
                      <Link
                        key={item.path}
                        to={item.path}
                        className={`nav-recent-item ${item.path === pathname ? 'active' : ''}`}
                        onClick={() => setRecentDropdownOpen(false)}
                      >
                        <span className="nav-recent-label">{t(item.labelKey)}</span>
                        <ExternalLink size={12} className="nav-recent-link-icon" aria-hidden="true" />
                      </Link>
                    ))
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
          {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
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
