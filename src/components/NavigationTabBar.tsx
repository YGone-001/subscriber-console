"use client";

import { useEffect, useState, useMemo, useRef, useCallback, useSyncExternalStore } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import {
  LayoutDashboard,
  Users,
  CreditCard,
  Gauge,
  UserCog,
  ShieldCheck,
  GitBranch,
  History,
  Activity,
  Wallet,
  Radio,
  Receipt,
  X,
  Pin,
  MoreHorizontal,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { useI18n } from "@/components/I18nProvider";

const STORAGE_KEY = "XCLOUD_OPEN_TABS";

interface TabDefinition {
  path: string;
  labelKey: string;
  icon: React.ReactNode;
  isPinned?: boolean;
}

const ROUTE_DEFINITIONS: Record<string, { labelKey: string; icon: React.ReactNode }> = {
  "/": { labelKey: "nav_dashboard", icon: <LayoutDashboard size={14} /> },
  "/subscribers": { labelKey: "nav_subscriber", icon: <Users size={14} /> },
  "/ocs/balances": { labelKey: "nav_ocs_balances", icon: <Wallet size={14} /> },
  "/ocs/sessions": { labelKey: "nav_ocs_sessions", icon: <Radio size={14} /> },
  "/ocs/usage": { labelKey: "nav_ocs_usage", icon: <Receipt size={14} /> },
  "/profile": { labelKey: "nav_profile", icon: <CreditCard size={14} /> },
  "/rating": { labelKey: "nav_rating", icon: <Gauge size={14} /> },
  "/rating/plans": { labelKey: "nav_rating_plans", icon: <Gauge size={14} /> },
  "/rating/rules": { labelKey: "nav_rating_rules", icon: <GitBranch size={14} /> },
  "/users": { labelKey: "nav_system_users", icon: <UserCog size={14} /> },
  "/roles": { labelKey: "nav_roles", icon: <ShieldCheck size={14} /> },
  "/approvals": { labelKey: "nav_approvals", icon: <GitBranch size={14} /> },
  "/audit-logs": { labelKey: "nav_audit_logs", icon: <History size={14} /> },
  "/system-health": { labelKey: "nav_system_health", icon: <Activity size={14} /> },
};

const DEFAULT_TABS: TabDefinition[] = [
  { path: "/", labelKey: "nav_dashboard", icon: <LayoutDashboard size={14} />, isPinned: true },
];

let cachedRawTabs: string | null = null;
let cachedTabs: TabDefinition[] = DEFAULT_TABS;

function getStoredTabsSnapshot(): TabDefinition[] {
  if (typeof window === "undefined") return DEFAULT_TABS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === cachedRawTabs && cachedTabs) {
      return cachedTabs;
    }
    cachedRawTabs = raw;
    if (raw) {
      const parsed: Array<{ path: string; isPinned?: boolean }> = JSON.parse(raw);
      const reconstructed: TabDefinition[] = parsed
        .filter((p) => Boolean(ROUTE_DEFINITIONS[p.path]))
        .map((p) => ({
          path: p.path,
          labelKey: ROUTE_DEFINITIONS[p.path].labelKey,
          icon: ROUTE_DEFINITIONS[p.path].icon,
          isPinned: p.path === "/" ? true : (p.isPinned ?? false),
        }));
      if (!reconstructed.some((t) => t.path === "/")) {
        reconstructed.unshift(DEFAULT_TABS[0]);
      }
      cachedTabs = reconstructed;
      return reconstructed;
    }
  } catch {}
  cachedTabs = DEFAULT_TABS;
  return DEFAULT_TABS;
}

const tabListeners = new Set<() => void>();
function subscribeTabs(onStoreChange: () => void) {
  tabListeners.add(onStoreChange);
  const handleStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) onStoreChange();
  };
  window.addEventListener("storage", handleStorage);
  return () => {
    tabListeners.delete(onStoreChange);
    window.removeEventListener("storage", handleStorage);
  };
}

function writeTabs(newTabs: TabDefinition[]) {
  cachedTabs = newTabs;
  try {
    const serialized = newTabs.map((tab) => ({ path: tab.path, isPinned: tab.isPinned }));
    cachedRawTabs = JSON.stringify(serialized);
    localStorage.setItem(STORAGE_KEY, cachedRawTabs);
  } catch {}
  for (const listener of tabListeners) {
    listener();
  }
}

export default function NavigationTabBar() {
  const pathname = usePathname();
  const router = useRouter();
  const { t } = useI18n();
  const tabsScrollRef = useRef<HTMLDivElement>(null);
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false);

  const tabs = useSyncExternalStore(subscribeTabs, getStoredTabsSnapshot, () => DEFAULT_TABS);

  const saveTabs = useCallback((newTabs: TabDefinition[]) => {
    writeTabs(newTabs);
  }, []);

  // When pathname changes, ensure tab is opened in store
  useEffect(() => {
    if (!pathname) return;

    // Match exact or prefix route from definitions
    const matchedKey = Object.keys(ROUTE_DEFINITIONS).find(
      (route) => route === pathname || (route !== "/" && pathname.startsWith(route))
    );

    if (matchedKey && ROUTE_DEFINITIONS[matchedKey]) {
      const currentTabs = getStoredTabsSnapshot();
      if (!currentTabs.some((tab) => tab.path === matchedKey)) {
        const newTab: TabDefinition = {
          path: matchedKey,
          labelKey: ROUTE_DEFINITIONS[matchedKey].labelKey,
          icon: ROUTE_DEFINITIONS[matchedKey].icon,
          isPinned: matchedKey === "/",
        };
        writeTabs([...currentTabs, newTab]);
      }
    }
  }, [pathname]);

  const activeTabPath = useMemo(() => {
    return (
      Object.keys(ROUTE_DEFINITIONS).find(
        (route) => route === pathname || (route !== "/" && pathname.startsWith(route))
      ) || "/"
    );
  }, [pathname]);

  const handleCloseTab = (e: React.MouseEvent, targetPath: string) => {
    e.preventDefault();
    e.stopPropagation();

    if (targetPath === "/") return; // Don't close pinned home

    const currentIndex = tabs.findIndex((t) => t.path === targetPath);
    const updated = tabs.filter((t) => t.path !== targetPath);
    saveTabs(updated);

    // If closing active tab, navigate to previous or next tab
    if (targetPath === activeTabPath) {
      const nextIndex = Math.max(0, currentIndex - 1);
      const nextPath = updated[nextIndex]?.path || "/";
      router.push(nextPath);
    }
  };

  const handleCloseOthers = () => {
    const retained = tabs.filter((tab) => tab.isPinned || tab.path === activeTabPath);
    saveTabs(retained);
    setActionsMenuOpen(false);
  };

  const handleCloseAll = () => {
    const retained = tabs.filter((tab) => tab.isPinned || tab.path === "/");
    saveTabs(retained);
    setActionsMenuOpen(false);
    if (activeTabPath !== "/") {
      router.push("/");
    }
  };

  const scrollTabs = (direction: "left" | "right") => {
    if (tabsScrollRef.current) {
      const offset = direction === "left" ? -180 : 180;
      tabsScrollRef.current.scrollBy({ left: offset, behavior: "smooth" });
    }
  };

  return (
    <nav className="nav-tab-bar" aria-label={t("nav_tab_workspace")}>
      <button
        type="button"
        className="nav-tab-scroll-btn left"
        onClick={() => scrollTabs("left")}
        title={t("nav_tab_scroll_left")}
        aria-label={t("nav_tab_scroll_left")}
      >
        <ChevronLeft size={14} />
      </button>

      <div className="nav-tab-track" ref={tabsScrollRef}>
        {tabs.map((tab) => {
          const isActive = tab.path === activeTabPath;
          return (
            <div key={tab.path} className={`nav-tab-item ${isActive ? "active" : ""}`}>
              <Link
                href={tab.path}
                className={`nav-tab-link ${tab.isPinned ? "pinned" : ""}`}
                aria-current={isActive ? "page" : undefined}
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
                  onClick={(e) => handleCloseTab(e, tab.path)}
                  title={t("nav_tab_close")}
                  aria-label={`${t("nav_tab_close")}: ${t(tab.labelKey)}`}
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
        onClick={() => scrollTabs("right")}
        title={t("nav_tab_scroll_right")}
        aria-label={t("nav_tab_scroll_right")}
      >
        <ChevronRight size={14} />
      </button>

      <div className="nav-tab-actions-wrap">
        <button
          type="button"
          className="nav-tab-menu-btn"
          onClick={() => setActionsMenuOpen((prev) => !prev)}
          title={t("nav_tab_options")}
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
                <span>{t("nav_tab_close_others")}</span>
              </button>
              <button type="button" className="nav-tab-dropdown-item" role="menuitem" onClick={handleCloseAll}>
                <X size={13} />
                <span>{t("nav_tab_close_all")}</span>
              </button>
            </div>
          </>
        ) : null}
      </div>
    </nav>
  );
}
