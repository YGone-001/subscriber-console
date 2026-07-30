"use client";
import './layout.css';

import { useEffect, useMemo, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import Image from "next/image";
import useSWR from "swr";
import {
  Activity,
  AlertTriangle,
  Bell,
  ChevronRight,
  Command,
  CreditCard,
  Gauge,
  GitBranch,
  HelpCircle,
  History,
  LayoutDashboard,
  LogOut,
  Menu,
  Settings,
  ShieldCheck,
  User,
  UserCog,
  Users,
} from "lucide-react";
import Link from "next/link";
import NocSentinel from "@/components/NocSentinel";
import CommandPalette from "@/components/CommandPalette";
import ThemeSwitcher from "@/components/ThemeSwitcher";
import LanguageSwitcher from "@/components/LanguageSwitcher";
import { useI18n } from "@/components/I18nProvider";
import { useAuth } from "@/hooks/useAuth";
import { fetcher } from "@/lib/fetcher";

type NavItem = {
  key: string;
  path: string;
  match: string;
  icon: React.ReactNode;
  children?: NavItem[];
};

type ApprovalStatus = "pending" | "approved" | "rejected" | "executed" | "failed";

type ApprovalDigest = {
  id: string;
  action: string;
  status: ApprovalStatus;
  requester: string;
  targetId: string;
  summary: string;
  createdAt: string;
  updatedAt?: string;
  error?: string;
};

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { user, isRoot } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [cmdPaletteOpen, setCmdPaletteOpen] = useState(false);
  const [ratingNavOpen, setRatingNavOpen] = useState(true);
  const [identityNavOpen, setIdentityNavOpen] = useState(true);
  const router = useRouter();
  const pathname = usePathname();
  const { t } = useI18n();
  const approvalUrl = user ? `/api/approvals?limit=5&status=${isRoot ? "pending" : "all"}` : null;
  const { data: approvalDigestData } = useSWR<{ approvals: ApprovalDigest[]; pending: number }>(approvalUrl, fetcher, {
    refreshInterval: 30000,
    revalidateOnFocus: true,
  });
  const approvalDigests = approvalDigestData?.approvals || [];
  const approvalPendingCount = approvalDigestData?.pending || 0;
  const approvalAttentionCount = isRoot
    ? approvalPendingCount
    : approvalDigests.filter((approval) => approval.status === "pending" || approval.status === "failed").length;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        setCmdPaletteOpen((prev) => !prev);
      }
      if (e.key === "Escape") {
        setDropdownOpen(false);
        setApprovalOpen(false);
        setCmdPaletteOpen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

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

  const displayName = user?.username || "xCloud";
  const roleLabel = user?.role || "viewer";
  const sidebarWidth = sidebarOpen ? 264 : 72;
  const ratingNavExpanded = ratingNavOpen || pathname.startsWith("/rating");
  const identityNavExpanded = identityNavOpen || pathname.startsWith("/users") || pathname.startsWith("/roles") || pathname.startsWith("/approvals") || pathname.startsWith("/audit-logs");

  const handleLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    router.refresh();
    router.push("/login");
  };

  const handleProfileSettings = () => {
    setDropdownOpen(false);
    setApprovalOpen(false);
    if (isRoot) {
      router.push("/users");
    }
  };

  const handleHelp = () => {
    setDropdownOpen(false);
    setApprovalOpen(false);
    router.push("/system-health");
  };

  const handleApprovalCenter = () => {
    setApprovalOpen(false);
    router.push("/approvals");
  };

  const renderApprovalStatus = (status: ApprovalStatus) => {
    const className = status === "pending" ? "pending" : status === "failed" || status === "rejected" ? "danger" : "success";
    return <span className={`approval-status ${className}`}>{t(`approval_status_${status}`)}</span>;
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden", background: "var(--background)" }}>
      <CommandPalette isOpen={cmdPaletteOpen} onClose={() => setCmdPaletteOpen(false)} />

      <header className="app-header">
        <div className="header-left">
          <div className="brand-lockup">
            <div className="brand-mark">
              <Image src="/images/xCloud_picture.png" alt="xCloud Trademark" width={1254} height={1254} />
            </div>
            <h1>xCloud</h1>
          </div>

          <div className="header-divider" />

          <button className="icon-button" onClick={() => setSidebarOpen((open) => !open)} title={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}>
            <Menu size={22} />
          </button>

          <button className="command-button" onClick={() => setCmdPaletteOpen(true)} title={t("cmd_palette_title")}>
            <Command size={14} />
            <span>{t("search_placeholder")}</span>
            <kbd>Ctrl K</kbd>
          </button>
        </div>

        <div className="header-right">
          <NocSentinel />
          <div className="approval-menu">
            <button className="approval-button" onClick={() => setApprovalOpen((open) => !open)} aria-expanded={approvalOpen} title={t("approval_digest_title")}>
              <Bell size={17} />
              <span>{isRoot ? t("approval_digest_root") : t("approval_digest_mine")}</span>
              {approvalAttentionCount > 0 ? <strong>{approvalAttentionCount > 99 ? "99+" : approvalAttentionCount}</strong> : null}
            </button>

            {approvalOpen && (
              <>
                <div className="dropdown-backdrop" onClick={() => setApprovalOpen(false)} />
                <div className="approval-dropdown">
                  <div className="approval-dropdown-head">
                    <div>
                      <strong>{t("approval_digest_title")}</strong>
                      <span>{isRoot ? t("approval_digest_root_desc", { count: approvalPendingCount }) : t("approval_digest_mine_desc", { count: approvalPendingCount })}</span>
                    </div>
                    <GitBranch size={18} />
                  </div>

                  <div className="approval-list">
                    {approvalDigests.length === 0 ? (
                      <div className="approval-empty">
                        <AlertTriangle size={18} />
                        {t("approval_digest_empty")}
                      </div>
                    ) : approvalDigests.map((approval) => (
                      <div key={approval.id} className="approval-row">
                        <div className="approval-row-top">
                          <strong>{t(`approval_action_${approval.action}`)}</strong>
                          {renderApprovalStatus(approval.status)}
                        </div>
                        <span className="approval-row-summary">{approval.summary}</span>
                        {approval.error ? <span className="approval-row-error">{approval.error}</span> : null}
                        <div className="approval-row-meta">
                          <span>{approval.targetId}</span>
                          <time>{new Date(approval.updatedAt || approval.createdAt).toLocaleString()}</time>
                        </div>
                      </div>
                    ))}
                  </div>

                  {isRoot ? (
                    <button className="approval-footer" onClick={handleApprovalCenter}>
                      {t("approval_digest_open_center")}
                      <ChevronRight size={15} />
                    </button>
                  ) : null}
                </div>
              </>
            )}
          </div>
          <LanguageSwitcher />
          <ThemeSwitcher />
          <div className="header-divider" />

          <div className="user-menu">
            <button className="avatar-button" onClick={() => setDropdownOpen((open) => !open)} aria-expanded={dropdownOpen}>
              <div className="avatar-circle">
                <User size={20} />
              </div>
              <div className="avatar-meta">
                <strong>{displayName}</strong>
                <span>{roleLabel}</span>
              </div>
              <ChevronRight size={16} className={dropdownOpen ? "avatar-chevron open" : "avatar-chevron"} />
            </button>

            {dropdownOpen && (
              <>
                <div className="dropdown-backdrop" onClick={() => setDropdownOpen(false)} />
                <div className="user-dropdown">
                  <div className="dropdown-profile">
                    <div className="avatar-circle large">
                      <User size={22} />
                    </div>
                    <div>
                      <strong>{displayName}</strong>
                      <span>{roleLabel}</span>
                    </div>
                  </div>

                  <div className="dropdown-actions">
                    <button className="dropdown-item" onClick={handleProfileSettings}>
                      <Settings size={16} />
                      {t("profile_settings")}
                    </button>
                    <button className="dropdown-item" onClick={handleHelp}>
                      <HelpCircle size={16} />
                      {t("help_support")}
                    </button>
                    <div className="dropdown-separator" />
                    <button className="dropdown-item text-danger" onClick={handleLogout}>
                      <LogOut size={16} />
                      {t("logout")}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      <div style={{ display: "flex", flex: 1, minHeight: 0, overflow: "hidden" }}>
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

        <main style={{ flex: 1, overflowY: "auto", position: "relative", minHeight: "100%", background: "var(--background)" }}>
          {children}
        </main>
      </div>

      
    </div>
  );
}

