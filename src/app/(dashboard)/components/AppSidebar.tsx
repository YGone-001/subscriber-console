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
  ShieldCheck,
  UserCog,
  Users,
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
  const [ratingNavOpen, setRatingNavOpen] = useState(true);
  const [identityNavOpen, setIdentityNavOpen] = useState(true);
  const pathname = usePathname();
  const { t } = useI18n();
  const { isRoot } = useAuth();

  const navItems = useMemo<NavItem[]>(() => {
    const identityChildren: NavItem[] = [
      ...(isRoot ? [
        { key: "nav_system_users", path: "/users", match: "/users", icon: <UserCog size={18} /> },
        { key: "nav_roles", path: "/roles", match: "/roles", icon: <ShieldCheck size={18} /> },
      ] : []),
      { key: "nav_approvals", path: "/approvals", match: "/approvals", icon: <GitBranch size={18} /> },
      { key: "nav_audit_logs", path: "/audit-logs", match: "/audit-logs", icon: <History size={18} /> },
    ];
    const items: NavItem[] = [
      { key: "nav_dashboard", path: "/", match: "/", icon: <LayoutDashboard size={20} /> },
      { key: "nav_subscriber", path: "/subscribers", match: "/subscribers", icon: <Users size={20} /> },
      { key: "nav_profile", path: "/profile", match: "/profile", icon: <CreditCard size={20} /> },
      { key: "nav_rating", path: "/rating", match: "/rating", icon: <Gauge size={20} /> },
      { key: "nav_user_permissions", path: "/users", match: "/users", icon: <UserCog size={20} />, children: identityChildren },
      { key: "nav_system_health", path: "/system-health", match: "/system-health", icon: <Activity size={20} /> },
    ];

    return items;
  }, [isRoot]);

  const ratingSubItems: NavItem[] = [
    { key: "nav_rating_plans", path: "/rating/plans", match: "/rating/plans", icon: <Gauge size={18} /> },
    { key: "nav_rating_rules", path: "/rating/rules", match: "/rating/rules", icon: <GitBranch size={18} /> },
  ];

  const sidebarWidth = sidebarOpen ? 264 : 72;
  const ratingNavExpanded = ratingNavOpen || pathname.startsWith("/rating");
  const identityNavExpanded = identityNavOpen || pathname.startsWith("/users") || pathname.startsWith("/roles") || pathname.startsWith("/approvals") || pathname.startsWith("/audit-logs");

  return (
    <aside className={sidebarOpen ? "app-sidebar expanded" : "app-sidebar collapsed"} style={{ width: sidebarWidth }}>
      <nav className="sidebar-nav" aria-label="Primary navigation">
        {navItems.map((item) => {
          const childActive = item.children?.some((child) => pathname === child.match || pathname.startsWith(child.match)) || false;
          const isActive = childActive || pathname === item.match || (item.match !== "/" && pathname.startsWith(item.match));
          const isRatingParent = item.key === "nav_rating";
          const isIdentityParent = item.key === "nav_user_permissions";
          const parentExpanded = isRatingParent ? ratingNavExpanded : identityNavExpanded;
          return (
            <div key={item.key} className="sidebar-item-wrap">
              {isRatingParent || isIdentityParent ? (
                <>
                  <button
                    type="button"
                    className={isActive ? "sidebar-link active sidebar-parent-button" : "sidebar-link sidebar-parent-button"}
                    onClick={() => {
                      if (!sidebarOpen) setSidebarOpen(true);
                      if (isRatingParent) {
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
                    <span className="sidebar-tooltip" role="tooltip">{t(item.key)}</span>
                    {sidebarOpen ? <ChevronRight size={16} className={parentExpanded ? "sidebar-chevron open" : "sidebar-chevron"} /> : null}
                  </button>
                  {sidebarOpen && parentExpanded ? (
                    <div className="sidebar-subnav">
                      {(isRatingParent ? ratingSubItems : item.children || []).map((child) => {
                        const childActive = pathname === child.match || pathname.startsWith(child.match);
                        return (
                          <Link key={child.key} href={child.path} className={`${childActive ? "sidebar-link active" : "sidebar-link"} child`} aria-current={childActive ? "page" : undefined}>
                            <span className="sidebar-active-bar" />
                            <span className="sidebar-icon">{child.icon}</span>
                            <span className="sidebar-label">{t(child.key)}</span>
                            <span className="sidebar-tooltip" role="tooltip">{t(child.key)}</span>
                            {childActive ? <ChevronRight size={15} className="sidebar-chevron" /> : null}
                          </Link>
                        );
                      })}
                    </div>
                  ) : null}
                </>
              ) : (
                <Link href={item.path} className={isActive ? "sidebar-link active" : "sidebar-link"} aria-current={isActive ? "page" : undefined}>
                  <span className="sidebar-active-bar" />
                  <span className="sidebar-icon">{item.icon}</span>
                  <span className="sidebar-label">{t(item.key)}</span>
                  <span className="sidebar-tooltip" role="tooltip">{t(item.key)}</span>
                  {isActive && sidebarOpen ? <ChevronRight size={16} className="sidebar-chevron" /> : null}
                </Link>
              )}
            </div>
          );
        })}
      </nav>
    </aside>
  );
}
