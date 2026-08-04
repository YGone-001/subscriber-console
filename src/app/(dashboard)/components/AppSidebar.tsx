"use client";

import { useState, useMemo } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import {
  Activity,
  ChevronRight,
  CreditCard,
  Gauge,
  GitBranch,
  History,
  LayoutDashboard,
  Radio,
  Receipt,
  Search,
  ShieldCheck,
  SidebarClose,
  SidebarOpen,
  UserCog,
  Users,
  Wallet,
  X,
  Zap,
} from "lucide-react";
import { useI18n } from "@/components/I18nProvider";
import { useAuth } from "@/hooks/useAuth";

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
}

export default function AppSidebar({ sidebarOpen, setSidebarOpen }: AppSidebarProps) {
  const [ocsNavOpen, setOcsNavOpen] = useState(true);
  const [ratingNavOpen, setRatingNavOpen] = useState(true);
  const [identityNavOpen, setIdentityNavOpen] = useState(true);
  const [filterQuery, setFilterQuery] = useState("");
  const pathname = usePathname();
  const { t } = useI18n();
  const { isRoot } = useAuth();

  const navItems = useMemo<NavItem[]>(() => {
    const ocsChildren: NavItem[] = [
      { key: "nav_ocs_balances", path: "/ocs/balances", match: "/ocs/balances", icon: <Wallet size={18} /> },
      { key: "nav_ocs_sessions", path: "/ocs/sessions", match: "/ocs/sessions", icon: <Radio size={18} /> },
      { key: "nav_ocs_usage", path: "/ocs/usage", match: "/ocs/usage", icon: <Receipt size={18} /> },
    ];
    const identityChildren: NavItem[] = [
      ...(isRoot
        ? [
            { key: "nav_system_users", path: "/users", match: "/users", icon: <UserCog size={18} /> },
            { key: "nav_roles", path: "/roles", match: "/roles", icon: <ShieldCheck size={18} /> },
          ]
        : []),
      { key: "nav_approvals", path: "/approvals", match: "/approvals", icon: <GitBranch size={18} /> },
      { key: "nav_audit_logs", path: "/audit-logs", match: "/audit-logs", icon: <History size={18} /> },
    ];
    const items: NavItem[] = [
      { key: "nav_dashboard", path: "/", match: "/", icon: <LayoutDashboard size={20} /> },
      { key: "nav_subscriber", path: "/subscribers", match: "/subscribers", icon: <Users size={20} /> },
      { key: "nav_ocs", path: "/ocs/balances", match: "/ocs", icon: <Zap size={20} />, children: ocsChildren },
      { key: "nav_profile", path: "/profile", match: "/profile", icon: <CreditCard size={20} /> },
      { key: "nav_rating", path: "/rating", match: "/rating", icon: <Gauge size={20} /> },
      {
        key: "nav_user_permissions",
        path: "/users",
        match: "/users",
        icon: <UserCog size={20} />,
        children: identityChildren,
      },
      { key: "nav_system_health", path: "/system-health", match: "/system-health", icon: <Activity size={20} /> },
    ];

    return items;
  }, [isRoot]);

  const ratingSubItems: NavItem[] = useMemo(() => [
    { key: "nav_rating_plans", path: "/rating/plans", match: "/rating/plans", icon: <Gauge size={18} /> },
    { key: "nav_rating_rules", path: "/rating/rules", match: "/rating/rules", icon: <GitBranch size={18} /> },
  ], []);

  const sidebarWidth = sidebarOpen ? 264 : 72;
  const ocsNavExpanded = ocsNavOpen || pathname.startsWith("/ocs");
  const ratingNavExpanded = ratingNavOpen || pathname.startsWith("/rating");
  const identityNavExpanded =
    identityNavOpen ||
    pathname.startsWith("/users") ||
    pathname.startsWith("/roles") ||
    pathname.startsWith("/approvals") ||
    pathname.startsWith("/audit-logs");

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

  return (
    <aside
      className={sidebarOpen ? "app-sidebar expanded" : "app-sidebar collapsed"}
      style={{ width: sidebarWidth }}
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
            subItems.some((child) => pathname === child.match || pathname.startsWith(child.match)) ||
            false;
          const isActive =
            childActive || pathname === item.match || (item.match !== "/" && pathname.startsWith(item.match));
          const isOcsParent = item.key === "nav_ocs";
          const isIdentityParent = item.key === "nav_user_permissions";
          const isExpandable = isOcsParent || isRatingParent || isIdentityParent;
          const parentExpanded = isOcsParent
            ? ocsNavExpanded
            : isRatingParent
            ? ratingNavExpanded
            : identityNavExpanded;

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
                      } else {
                        setIdentityNavOpen((open) => !open);
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
                        const isChildActive = pathname === child.match || pathname.startsWith(child.match);
                        return (
                          <Link
                            key={child.key}
                            href={child.path}
                            className={`${isChildActive ? "sidebar-link active" : "sidebar-link"} child`}
                            aria-current={isChildActive ? "page" : undefined}
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
