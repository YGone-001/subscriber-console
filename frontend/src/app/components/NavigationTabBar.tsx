/*
 * Workspace tab bar.
 *
 * Forward-ported from the historical xCloud UI (reference commit 2c40903):
 * frontend/src/components/NavigationTabBar.tsx
 *
 * This is the visited-tab model, not a static navigation strip: the tab set is
 * the pages the operator has actually opened, persisted in localStorage with
 * user-level scoping, with a pinned home tab, per-tab close, close-others / close-all,
 * horizontal scrolling and role-based cleanup when a session loses access to a route.
 *
 * Visited paths store the normalized real destination pathname, never unresolved
 * parameter templates (e.g. /subscribers/460020000000400 instead of /subscribers/:imsi).
 */
import { createElement, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { X, Pin, MoreHorizontal, ChevronLeft, ChevronRight } from 'lucide-react';
import { useI18n } from '../../providers/I18nProvider';
import { useAuth } from '../../providers/AuthProvider';
import {
  getNavigationRoute,
  isNavigableDestination,
  normalizePathname,
  resolveNavigationRoute,
  UUID_SEGMENT,
  type NavigationRoute,
} from '../../lib/navigation';
import type { CanonicalRole } from '../../types/auth';

export const STORAGE_KEY = 'XCLOUD_OPEN_TABS';

export function getTabsStorageKey(username?: string | null): string {
  return username ? `${STORAGE_KEY}:${username}` : STORAGE_KEY;
}

export interface TabDefinition {
  path: string;
  labelKey: string;
  icon: React.ReactNode;
  isPinned?: boolean;
}

interface StoredTabEntry {
  path?: unknown;
  isPinned?: boolean;
}

const DEFAULT_TABS: TabDefinition[] = [
  { path: '/', labelKey: 'nav_dashboard', icon: createElement(getNavigationRoute('/')!.icon, { size: 14 }), isPinned: true },
];

const tabsMemoryCache = new Map<string, { raw: string | null; tabs: TabDefinition[] }>();

export function getStoredTabsSnapshot(username?: string | null, role?: CanonicalRole): TabDefinition[] {
  if (typeof window === 'undefined') return DEFAULT_TABS;
  const key = getTabsStorageKey(username);
  const cached = tabsMemoryCache.get(key);
  try {
    let raw = localStorage.getItem(key);
    // Safe legacy migration: if user-scoped key does not exist yet, check for legacy un-scoped key
    if (raw === null && username) {
      const legacyRaw = localStorage.getItem(STORAGE_KEY);
      if (legacyRaw !== null) {
        raw = legacyRaw;
        try { localStorage.removeItem(STORAGE_KEY); } catch { /* best-effort cleanup */ }
      }
    }
    if (cached && cached.raw === raw) {
      return cached.tabs;
    }
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const reconstructed: TabDefinition[] = [];
        for (const entry of parsed) {
          if (
            typeof entry === 'object' &&
            entry !== null &&
            typeof (entry as StoredTabEntry).path === 'string'
          ) {
            const rawPath = (entry as StoredTabEntry).path as string;
            const normalizedPath = normalizePathname(rawPath);
            if (isNavigableDestination(normalizedPath, role)) {
              const route = resolveNavigationRoute(normalizedPath);
              if (route && !reconstructed.some((t) => t.path === normalizedPath)) {
                reconstructed.push({
                  path: normalizedPath,
                  labelKey: route.labelKey,
                  icon: createElement(route.icon, { size: 14 }),
                  isPinned: normalizedPath === '/' ? true : Boolean((entry as StoredTabEntry).isPinned),
                });
              }
            }
          }
        }
        if (!reconstructed.some((tab) => tab.path === '/')) {
          reconstructed.unshift(DEFAULT_TABS[0]);
        }
        tabsMemoryCache.set(key, { raw, tabs: reconstructed });
        return reconstructed;
      }
    }
  } catch {
    /* Unreadable storage: fall back to default */
  }
  tabsMemoryCache.set(key, { raw: null, tabs: DEFAULT_TABS });
  return DEFAULT_TABS;
}

const tabListeners = new Set<() => void>();
function subscribeTabs(onStoreChange: () => void) {
  tabListeners.add(onStoreChange);
  const handleStorage = (event: StorageEvent) => {
    if (event.key && event.key.startsWith(STORAGE_KEY)) {
      tabsMemoryCache.clear();
      onStoreChange();
    }
  };
  window.addEventListener('storage', handleStorage);
  return () => {
    tabListeners.delete(onStoreChange);
    window.removeEventListener('storage', handleStorage);
  };
}

export function writeTabs(newTabs: TabDefinition[], username?: string | null) {
  const key = getTabsStorageKey(username);
  try {
    const serialized = newTabs.map((tab) => ({ path: tab.path, isPinned: tab.isPinned }));
    const raw = JSON.stringify(serialized);
    tabsMemoryCache.set(key, { raw, tabs: newTabs });
    localStorage.setItem(key, raw);
  } catch {
    /* Storage is best-effort: a failed write must not break navigation. */
  }
  for (const listener of tabListeners) {
    listener();
  }
}

export function NavigationTabBar() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { t } = useI18n();
  const { user, state } = useAuth();
  const isAuthLoading = state === 'checking';
  const tabsScrollRef = useRef<HTMLDivElement>(null);
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false);
  const [permissionNotice, setPermissionNotice] = useState('');

  const getSnapshot = useCallback(() => {
    return getStoredTabsSnapshot(user?.username, user?.role);
  }, [user?.username, user?.role]);

  const storedTabs = useSyncExternalStore(subscribeTabs, getSnapshot, () => DEFAULT_TABS);
  const tabs = useMemo(
    () => storedTabs.filter((tab) => isNavigableDestination(tab.path, user?.role)),
    [storedTabs, user?.role],
  );

  const saveTabs = useCallback((newTabs: TabDefinition[]) => {
    writeTabs(newTabs, user?.username);
  }, [user?.username]);

  const normalizedCurrentPath = useMemo(() => {
    return normalizePathname(pathname);
  }, [pathname]);

  const activeTabPath = normalizedCurrentPath;
  const currentRoute: NavigationRoute | undefined = useMemo(
    () => resolveNavigationRoute(normalizedCurrentPath),
    [normalizedCurrentPath],
  );

  // Opening a navigable route adds it to the workspace tabs.
  useEffect(() => {
    if (!pathname || isAuthLoading) return;
    const normalized = normalizePathname(pathname);
    if (isNavigableDestination(normalized, user?.role)) {
      const matchedRoute = resolveNavigationRoute(normalized);
      if (matchedRoute) {
        const currentTabs = getStoredTabsSnapshot(user?.username, user?.role);
        if (!currentTabs.some((tab) => tab.path === normalized)) {
          const newTab: TabDefinition = {
            path: normalized,
            labelKey: matchedRoute.labelKey,
            icon: createElement(matchedRoute.icon, { size: 14 }),
            isPinned: normalized === '/',
          };
          writeTabs([...currentTabs, newTab], user?.username);
        }
      }
    }
  }, [pathname, isAuthLoading, user?.username, user?.role]);

  // Dropping a role removes the tabs it can no longer reach.
  useEffect(() => {
    if (isAuthLoading || !user) return;
    const currentTabs = getStoredTabsSnapshot(user.username, user.role);
    const accessibleTabs = currentTabs.filter((tab) => isNavigableDestination(tab.path, user.role));
    let noticeTimer: number | undefined;
    if (accessibleTabs.length !== currentTabs.length) {
      writeTabs(accessibleTabs, user.username);
      noticeTimer = window.setTimeout(() => setPermissionNotice(t('nav_tab_permissions_cleaned')), 0);
    }
    return () => {
      if (noticeTimer !== undefined) window.clearTimeout(noticeTimer);
    };
  }, [isAuthLoading, t, user?.username, user?.role]);

  const handleCloseTab = (event: React.MouseEvent, targetPath: string) => {
    event.preventDefault();
    event.stopPropagation();

    if (targetPath === '/') return; // The home tab is pinned.

    const currentIndex = tabs.findIndex((tab) => tab.path === targetPath);
    const updated = tabs.filter((tab) => tab.path !== targetPath);
    saveTabs(updated);

    if (targetPath === activeTabPath) {
      const nextIndex = Math.max(0, currentIndex - 1);
      const nextPath = updated[nextIndex]?.path || '/';
      navigate(nextPath);
    }
  };

  const handleCloseOthers = () => {
    const retained = tabs.filter((tab) => tab.isPinned || tab.path === activeTabPath);
    saveTabs(retained);
    setActionsMenuOpen(false);
  };

  const handleCloseAll = () => {
    const retained = tabs.filter((tab) => tab.isPinned || tab.path === '/');
    saveTabs(retained);
    setActionsMenuOpen(false);
    if (activeTabPath !== '/') {
      navigate('/');
    }
  };

  const scrollTabs = (direction: 'left' | 'right') => {
    if (tabsScrollRef.current) {
      const offset = direction === 'left' ? -180 : 180;
      tabsScrollRef.current.scrollBy({ left: offset, behavior: 'smooth' });
    }
  };

  return (
    <nav className="nav-tab-bar" aria-label={t('nav_tab_workspace')}>
      <span className="visually-hidden" role="status" aria-live="polite">
        {permissionNotice}
      </span>
      {currentRoute ? (
        <div className="nav-mobile-current" aria-current="page">
          <span aria-hidden="true">{createElement(currentRoute.icon, { size: 16 })}</span>
          <strong>{t(currentRoute.labelKey)}</strong>
        </div>
      ) : null}
      <button
        type="button"
        className="nav-tab-scroll-btn left"
        onClick={() => scrollTabs('left')}
        title={t('nav_tab_scroll_left')}
        aria-label={t('nav_tab_scroll_left')}
      >
        <ChevronLeft size={14} />
      </button>

      <div className="nav-tab-track" ref={tabsScrollRef} role="list">
        {tabs.map((tab) => {
          const isActive = tab.path === activeTabPath;
          const route = resolveNavigationRoute(tab.path);
          const lastSegment = route && route.dynamicParameters.length > 0 && !tab.isPinned
            ? tab.path.split('/').filter(Boolean).at(-1)
            : null;
          const displayParam = lastSegment && UUID_SEGMENT.test(lastSegment)
            ? `${lastSegment.slice(0, 8)}...`
            : lastSegment;
          const tabLabel = displayParam
            ? `${t(tab.labelKey)} (${displayParam})`
            : t(tab.labelKey);

          return (
            <div key={tab.path} className={`nav-tab-item ${isActive ? 'active' : ''}`} role="listitem">
              <Link
                to={tab.path}
                className={`nav-tab-link ${tab.isPinned ? 'pinned' : ''}`}
                aria-current={isActive ? 'page' : undefined}
                title={tabLabel}
              >
                <span className="nav-tab-icon" aria-hidden="true">{tab.icon}</span>
                <span className="nav-tab-label">{tabLabel}</span>
                {tab.isPinned ? <Pin size={11} className="nav-tab-pin-icon" aria-hidden="true" /> : null}
              </Link>
              {!tab.isPinned ? (
                <button
                  type="button"
                  className="nav-tab-close"
                  onClick={(event) => handleCloseTab(event, tab.path)}
                  title={t('nav_tab_close')}
                  aria-label={`${t('nav_tab_close')}: ${tabLabel}`}
                >
                  <X size={12} />
                </button>
              ) : null}
            </div>
          );
        })}
      </div>

      <button
        type="button"
        className="nav-tab-scroll-btn right"
        onClick={() => scrollTabs('right')}
        title={t('nav_tab_scroll_right')}
        aria-label={t('nav_tab_scroll_right')}
      >
        <ChevronRight size={14} />
      </button>

      <div className="nav-tab-actions-wrap">
        <button
          type="button"
          className="nav-tab-menu-btn"
          onClick={() => setActionsMenuOpen((prev) => !prev)}
          title={t('nav_tab_options')}
          aria-expanded={actionsMenuOpen}
          aria-haspopup="menu"
          aria-controls="workspace-tab-actions"
        >
          <MoreHorizontal size={14} />
        </button>

        {actionsMenuOpen ? (
          <>
            <div className="dropdown-backdrop" onClick={() => setActionsMenuOpen(false)} />
            <div id="workspace-tab-actions" className="nav-tab-dropdown" role="menu">
              <button type="button" className="nav-tab-dropdown-item" role="menuitem" onClick={handleCloseOthers}>
                <X size={13} />
                <span>{t('nav_tab_close_others')}</span>
              </button>
              <button type="button" className="nav-tab-dropdown-item" role="menuitem" onClick={handleCloseAll}>
                <X size={13} />
                <span>{t('nav_tab_close_all')}</span>
              </button>
            </div>
          </>
        ) : null}
      </div>
    </nav>
  );
}

export default NavigationTabBar;
