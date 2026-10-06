/*
 * Workspace tab bar.
 *
 * Forward-ported from the historical xCloud UI (reference commit 2c40903):
 * frontend/src/components/NavigationTabBar.tsx
 *
 * This is the visited-tab model, not a static navigation strip: the tab set is
 * the pages the operator has actually opened, persisted in localStorage, with a
 * pinned home tab, per-tab close, close-others / close-all, horizontal scrolling
 * and role-based cleanup when a session loses access to a route.
 *
 * Adaptations: the Next.js router and Link components are replaced by
 * react-router-dom; the retired `prefetchNavigationData` helper is not restored
 * (the current read client already caches per request key).
 */
import { createElement, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { X, Pin, MoreHorizontal, ChevronLeft, ChevronRight } from 'lucide-react';
import { useI18n } from '../../providers/I18nProvider';
import { useAuth } from '../../providers/AuthProvider';
import {
  canAccessNavigationRoute,
  getNavigationRoute,
  resolveNavigationRoute,
  type NavigationRoute,
} from '../../lib/navigation';

const STORAGE_KEY = 'XCLOUD_OPEN_TABS';

interface TabDefinition {
  path: string;
  labelKey: string;
  icon: React.ReactNode;
  isPinned?: boolean;
}

const DEFAULT_TABS: TabDefinition[] = [
  { path: '/', labelKey: 'nav_dashboard', icon: createElement(getNavigationRoute('/')!.icon, { size: 14 }), isPinned: true },
];

let cachedRawTabs: string | null = null;
let cachedTabs: TabDefinition[] = DEFAULT_TABS;

function getStoredTabsSnapshot(): TabDefinition[] {
  if (typeof window === 'undefined') return DEFAULT_TABS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === cachedRawTabs && cachedTabs) {
      return cachedTabs;
    }
    cachedRawTabs = raw;
    if (raw) {
      const parsed: Array<{ path: string; isPinned?: boolean }> = JSON.parse(raw);
      const reconstructed: TabDefinition[] = parsed
        .filter((entry) => Boolean(getNavigationRoute(entry.path)))
        .map((entry) => ({
          path: entry.path,
          labelKey: getNavigationRoute(entry.path)!.labelKey,
          icon: createElement(getNavigationRoute(entry.path)!.icon, { size: 14 }),
          isPinned: entry.path === '/' ? true : (entry.isPinned ?? false),
        }));
      if (!reconstructed.some((tab) => tab.path === '/')) {
        reconstructed.unshift(DEFAULT_TABS[0]);
      }
      cachedTabs = reconstructed;
      return reconstructed;
    }
  } catch {
    /* Unreadable storage: fall back to the default tab set. */
  }
  cachedTabs = DEFAULT_TABS;
  return DEFAULT_TABS;
}

const tabListeners = new Set<() => void>();
function subscribeTabs(onStoreChange: () => void) {
  tabListeners.add(onStoreChange);
  const handleStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) {
      cachedRawTabs = null;
      onStoreChange();
    }
  };
  window.addEventListener('storage', handleStorage);
  return () => {
    tabListeners.delete(onStoreChange);
    window.removeEventListener('storage', handleStorage);
  };
}

function writeTabs(newTabs: TabDefinition[]) {
  cachedTabs = newTabs;
  try {
    const serialized = newTabs.map((tab) => ({ path: tab.path, isPinned: tab.isPinned }));
    cachedRawTabs = JSON.stringify(serialized);
    localStorage.setItem(STORAGE_KEY, cachedRawTabs);
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

  const storedTabs = useSyncExternalStore(subscribeTabs, getStoredTabsSnapshot, () => DEFAULT_TABS);
  const tabs = useMemo(
    () => storedTabs.filter((tab) => {
      const route = getNavigationRoute(tab.path);
      return route && canAccessNavigationRoute(route, user?.role);
    }),
    [storedTabs, user?.role],
  );

  const saveTabs = useCallback((newTabs: TabDefinition[]) => {
    writeTabs(newTabs);
  }, []);

  // Opening a route adds it to the workspace.
  useEffect(() => {
    if (!pathname) return;
    const matchedRoute = resolveNavigationRoute(pathname);
    if (matchedRoute && canAccessNavigationRoute(matchedRoute, user?.role)) {
      const currentTabs = getStoredTabsSnapshot();
      if (!currentTabs.some((tab) => tab.path === matchedRoute.route)) {
        const newTab: TabDefinition = {
          path: matchedRoute.route,
          labelKey: matchedRoute.labelKey,
          icon: createElement(matchedRoute.icon, { size: 14 }),
          isPinned: matchedRoute.route === '/',
        };
        writeTabs([...currentTabs, newTab]);
      }
    }
  }, [pathname, user?.role]);

  // Dropping a role removes the tabs it can no longer reach.
  useEffect(() => {
    if (isAuthLoading || !user) return;
    const currentTabs = getStoredTabsSnapshot();
    const accessibleTabs = currentTabs.filter((tab) => {
      const route = getNavigationRoute(tab.path);
      return route && canAccessNavigationRoute(route, user.role);
    });
    let noticeTimer: number | undefined;
    if (accessibleTabs.length !== currentTabs.length) {
      writeTabs(accessibleTabs);
      noticeTimer = window.setTimeout(() => setPermissionNotice(t('nav_tab_permissions_cleaned')), 0);
    }
    return () => {
      if (noticeTimer !== undefined) window.clearTimeout(noticeTimer);
    };
  }, [isAuthLoading, t, user]);

  const activeTabPath = useMemo(() => resolveNavigationRoute(pathname)?.route || '/', [pathname]);
  const currentRoute: NavigationRoute | undefined = useMemo(() => resolveNavigationRoute(pathname), [pathname]);

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
          return (
            <div key={tab.path} className={`nav-tab-item ${isActive ? 'active' : ''}`} role="listitem">
              <Link
                to={tab.path}
                className={`nav-tab-link ${tab.isPinned ? 'pinned' : ''}`}
                aria-current={isActive ? 'page' : undefined}
                title={t(tab.labelKey)}
              >
                <span className="nav-tab-icon" aria-hidden="true">{tab.icon}</span>
                <span className="nav-tab-label">{t(tab.labelKey)}</span>
                {tab.isPinned ? <Pin size={11} className="nav-tab-pin-icon" aria-hidden="true" /> : null}
              </Link>
              {!tab.isPinned ? (
                <button
                  type="button"
                  className="nav-tab-close"
                  onClick={(event) => handleCloseTab(event, tab.path)}
                  title={t('nav_tab_close')}
                  aria-label={`${t('nav_tab_close')}: ${t(tab.labelKey)}`}
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
