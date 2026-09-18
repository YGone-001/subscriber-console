"use client";

import { createElement, useState, useMemo } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import {
  ChevronRight,
  Search,
  Settings,
  ShieldCheck,
  SidebarClose,
  SidebarOpen,
  X,
  Zap,
} from "lucide-react";
import { useI18n } from "@/components/I18nProvider";
import { useAuth } from "@/hooks/useAuth";
import { getAccessibleNavigationRoutes, routeMatchesPath, type NavigationGroup } from "@/lib/navigationRoutes";

type NavItem = {
  key: string;
  path: string;
  match: string;
  icon: React.ReactNode;
  children?: NavItem[];
};

interface AppSidebarProps {
  sidebarOpen: boolean;
  setSidebarOpen: React.Dispatch<React.SetStateAction<boolean>>;
  isMobileShell: boolean;
}

export default function AppSidebar({ sidebarOpen, setSidebarOpen, isMobileShell }: AppSidebarProps) {
  const [ocsNavOpen, setOcsNavOpen] = useState(true);
  const [ratingNavOpen, setRatingNavOpen] = useState(true);
  const [governanceNavOpen, setGovernanceNavOpen] = useState(true);
  const [systemNavOpen, setSystemNavOpen] = useState(true);
  const [filterQuery, setFilterQuery] = useState("");
  const pathname = usePathname();
  const { t } = useI18n();
  const { user } = useAuth();

  const navItems = useMemo<NavItem[]>(() => {
    const routes = getAccessibleNavigationRoutes(user?.role);
    const routeItem = (path: string, size = 20): NavItem => {
      const route = routes.find((candidate) => candidate.path === path)!;
      return { key: route.labelKey, path: route.path, match: route.path, icon: createElement(route.icon, { size }) };
    };
    const groupChildren = (group: NavigationGroup) => routes
      .filter((route) => route.group === group)
      .map((route) => ({ key: route.labelKey, path: route.path, match: route.path, icon: createElement(route.icon, { size: 18 }) }));
    const ocsChildren = groupChildren("ocs");
    const governanceChildren = groupChildren("governance");
    const systemChildren = groupChildren("system");
    const items: NavItem[] = [
      routeItem("/"),
      routeItem("/subscribers"),
      { key: "nav_ocs", path: "/ocs/balances", match: "/ocs", icon: <Zap size={20} />, children: ocsChildren },
      routeItem("/profile"),
      routeItem("/rating"),
      { key: "nav_operations_governance", path: "/approvals", match: "/approvals", icon: <ShieldCheck size={20} />, children: governanceChildren },
      ...(systemChildren.length > 0 ? [{ key: "nav_system_settings", path: "/users", match: "/users", icon: <Settings size={20} />, children: systemChildren }] : []),
      routeItem("/system-health"),
    ];

    return items;
  }, [user?.role]);

  const ratingSubItems: NavItem[] = useMemo(() => getAccessibleNavigationRoutes(user?.role)
    .filter((route) => route.group === "rating")
    .map((route) => ({ key: route.labelKey, path: route.path, match: route.path, icon: createElement(route.icon, { size: 18 }) })), [user?.role]);

  const sidebarWidth = sidebarOpen ? 264 : 72;
  const ocsNavExpanded = ocsNavOpen || pathname.startsWith("/ocs");
  const ratingNavExpanded = ratingNavOpen || pathname.startsWith("/rating");
  const governanceNavExpanded = governanceNavOpen || pathname.startsWith("/approvals") || pathname.startsWith("/audit-logs");
  const systemNavExpanded = systemNavOpen || pathname.startsWith("/users");

  const filteredNavItems = useMemo(() => {
    const q = filterQuery.trim().toLowerCase();
    if (!q) return navItems;

    return navItems
      .map((item) => {
        const itemLabel = t(item.key).toLowerCase();
        const matchesParent = itemLabel.includes(q);

        const subItems = item.key === "nav_rating" ? ratingSubItems : item.children || [];
        const matchingChildren = subItems.filter((child) => t(child.key).toLowerCase().includes(q));

        if (matchesParent || matchingChildren.length > 0) {
          return {
            ...item,
            children: matchingChildren.length > 0 ? matchingChildren : item.children,
          };
        }
        return null;
      })
      .filter(Boolean) as NavItem[];
  }, [navItems, filterQuery, t, ratingSubItems]);

  const handleNavigate = () => {
    if (isMobileShell) setSidebarOpen(false);
  };

  return (
    <aside
      id="xcloud-primary-sidebar"
      className={sidebarOpen ? "app-sidebar expanded" : "app-sidebar collapsed"}
      style={{ width: sidebarWidth }}
      aria-hidden={isMobileShell && !sidebarOpen ? true : undefined}
      inert={isMobileShell && !sidebarOpen ? true : undefined}
    >
      {/* Sidebar Quick Filter Input (when expanded) */}
      {sidebarOpen ? (
        <div className="sidebar-filter-wrap">
          <Search size={14} className="sidebar-filter-icon" />
          <input
            type="text"
            className="sidebar-filter-input"
            placeholder={t("sidebar_filter_ph")}
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
          />
          {filterQuery ? (
            <button
              type="button"
              className="sidebar-filter-clear"
              onClick={() => setFilterQuery("")}
              title={t("common_clear")}
            >
              <X size={12} />
            </button>
          ) : null}
        </div>
      ) : null}

      <nav className="sidebar-nav" aria-label="Primary navigation">
        {filteredNavItems.map((item) => {
          const isRatingParent = item.key === "nav_rating";
          const subItems = isRatingParent ? ratingSubItems : item.children || [];
          const childActive =
            subItems.some((child) => routeMatchesPath(pathname, child.match)) ||
            false;
          const isActive =
            childActive || routeMatchesPath(pathname, item.match);
          const isOcsParent = item.key === "nav_ocs";
          const isGovernanceParent = item.key === "nav_operations_governance";
          const isSystemParent = item.key === "nav_system_settings";
          const isExpandable = isOcsParent || isRatingParent || isGovernanceParent || isSystemParent;
          const parentExpanded = isOcsParent
            ? ocsNavExpanded
            : isRatingParent
            ? ratingNavExpanded
            : isGovernanceParent
            ? governanceNavExpanded
            : systemNavExpanded;

          return (
            <div key={item.key} className="sidebar-item-wrap">
              {isExpandable ? (
                <>
                  <button
                    type="button"
                    className={
                      isActive
                        ? "sidebar-link active sidebar-parent-button"
                        : "sidebar-link sidebar-parent-button"
                    }
                    onClick={() => {
                      if (!sidebarOpen) setSidebarOpen(true);
                      if (isOcsParent) {
                        setOcsNavOpen((open) => !open);
                      } else if (isRatingParent) {
                        setRatingNavOpen((open) => !open);
                      } else if (isGovernanceParent) {
                        setGovernanceNavOpen((open) => !open);
                      } else {
                        setSystemNavOpen((open) => !open);
                      }
                    }}
                    aria-expanded={parentExpanded}
                  >
                    <span className="sidebar-active-bar" />
                    <span className="sidebar-icon">{item.icon}</span>
                    <span className="sidebar-label">{t(item.key)}</span>
                    <span className="sidebar-tooltip" role="tooltip">
                      {t(item.key)}
                    </span>
                    {sidebarOpen ? (
                      <ChevronRight
                        size={16}
                        className={parentExpanded ? "sidebar-chevron open" : "sidebar-chevron"}
                      />
                    ) : null}
                  </button>
                  {sidebarOpen && parentExpanded ? (
                    <div className="sidebar-subnav">
                      {subItems.map((child) => {
                        const isChildActive = routeMatchesPath(pathname, child.match);
                        return (
                          <Link
                            key={child.key}
                            href={child.path}
                            className={`${isChildActive ? "sidebar-link active" : "sidebar-link"} child`}
                            aria-current={isChildActive ? "page" : undefined}
                            onClick={handleNavigate}
                          >
                            <span className="sidebar-active-bar" />
                            <span className="sidebar-icon">{child.icon}</span>
                            <span className="sidebar-label">{t(child.key)}</span>
                            <span className="sidebar-tooltip" role="tooltip">
                              {t(child.key)}
                            </span>
                            {isChildActive ? <ChevronRight size={15} className="sidebar-chevron" /> : null}
                          </Link>
                        );
                      })}
                    </div>
                  ) : null}
                </>
              ) : (
                <Link
                  href={item.path}
                  className={isActive ? "sidebar-link active" : "sidebar-link"}
                  aria-current={isActive ? "page" : undefined}
                  onClick={handleNavigate}
                >
                  <span className="sidebar-active-bar" />
                  <span className="sidebar-icon">{item.icon}</span>
                  <span className="sidebar-label">{t(item.key)}</span>
                  <span className="sidebar-tooltip" role="tooltip">
                    {t(item.key)}
                  </span>
                  {isActive && sidebarOpen ? <ChevronRight size={16} className="sidebar-chevron" /> : null}
                </Link>
              )}
            </div>
          );
        })}
      </nav>

      {/* Sidebar Footer with Collapse Shortcut Toggle */}
      <div className="sidebar-footer-wrap">
        <button
          type="button"
          className="sidebar-toggle-btn"
          onClick={() => setSidebarOpen((prev) => !prev)}
          title={sidebarOpen ? t("sidebar_collapse_hint") : t("sidebar_expand_hint")}
        >
          {sidebarOpen ? <SidebarClose size={16} /> : <SidebarOpen size={16} />}
          {sidebarOpen ? (
            <div className="sidebar-toggle-label">
              <span>{t("sidebar_collapse")}</span>
              <kbd className="sidebar-kbd">Ctrl B</kbd>
            </div>
          ) : null}
        </button>
      </div>
    </aside>
  );
}
