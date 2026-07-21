"use client";

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
    const items: NavItem[] = [
      { key: "nav_dashboard", path: "/", match: "/", icon: <LayoutDashboard size={20} /> },
      { key: "nav_subscriber", path: "/subscribers", match: "/subscribers", icon: <Users size={20} /> },
      { key: "nav_profile", path: "/profile", match: "/profile", icon: <CreditCard size={20} /> },
      { key: "nav_rating", path: "/rating", match: "/rating", icon: <Gauge size={20} /> },
      { key: "nav_system_health", path: "/system-health", match: "/system-health", icon: <Activity size={20} /> },
      { key: "nav_audit_logs", path: "/audit-logs", match: "/audit-logs", icon: <History size={20} /> },
    ];

    if (isRoot) {
      items.splice(4, 0, { key: "nav_users", path: "/users", match: "/users", icon: <UserCog size={20} /> });
    }

    return items;
  }, [isRoot]);

  const displayName = user?.username || "xCloud";
  const roleLabel = user?.role || "viewer";
  const sidebarWidth = sidebarOpen ? 264 : 72;

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
    if (isRoot) {
      router.push("/users");
    }
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
              const isActive = pathname === item.match || (item.match !== "/" && pathname.startsWith(item.match));
              return (
                <Link key={item.key} href={item.path} className={isActive ? "sidebar-link active" : "sidebar-link"} aria-current={isActive ? "page" : undefined}>
                  <span className="sidebar-active-bar" />
                  <span className="sidebar-icon">{item.icon}</span>
                  <span className="sidebar-label">{t(item.key)}</span>
                  <span className="sidebar-tooltip" role="tooltip">{t(item.key)}</span>
                  {isActive && sidebarOpen ? <ChevronRight size={16} className="sidebar-chevron" /> : null}
                </Link>
              );
            })}
          </nav>

        </aside>

        <main style={{ flex: 1, overflowY: "auto", position: "relative", minHeight: "100%", background: "var(--background)" }}>
          {children}
        </main>
      </div>

      <style dangerouslySetInnerHTML={{ __html: layoutStyles }} />
    </div>
  );
}

const layoutStyles = `
  .app-header {
    height: 72px;
    background: var(--surface);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0 1.5rem;
    color: var(--text-main);
    flex-shrink: 0;
    z-index: 50;
    border-bottom: 1px solid var(--surface-border);
    box-shadow: 0 4px 20px rgba(0,0,0,0.03);
  }

  .header-left,
  .header-right,
  .brand-lockup,
  .command-button,
  .avatar-button {
    display: flex;
    align-items: center;
  }

  .header-left {
    gap: 1rem;
    min-width: 0;
  }

  .header-right {
    gap: 1rem;
    flex-shrink: 0;
  }

  .brand-lockup {
    width: 220px;
    gap: 0.75rem;
    overflow: hidden;
    flex-shrink: 0;
  }

  .brand-mark {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 36px;
    border-radius: 8px;
    overflow: hidden;
    flex-shrink: 0;
  }

  .brand-mark img {
    height: 100%;
    width: auto;
    object-fit: contain;
  }

  .brand-lockup h1 {
    margin: 0;
    white-space: nowrap;
    font-size: 1.35rem;
    font-weight: 800;
    letter-spacing: 0;
    background: linear-gradient(135deg, var(--primary) 0%, var(--primary-hover) 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }

  .header-divider {
    width: 1px;
    height: 24px;
    background: var(--surface-border);
    flex-shrink: 0;
  }

  .icon-button,
  .avatar-button,
  .dropdown-item {
    border: none;
    cursor: pointer;
    transition: background 0.2s ease, color 0.2s ease, border-color 0.2s ease, transform 0.2s ease;
  }

  .icon-button {
    background: transparent;
    color: var(--text-secondary);
    padding: 0.5rem;
    border-radius: 8px;
    display: flex;
    align-items: center;
  }

  .icon-button:hover,
  .avatar-button:hover,
  .dropdown-item:hover {
    background: var(--surface-hover);
    color: var(--text-main);
  }

  .command-button {
    gap: 0.5rem;
    min-width: 220px;
    background: var(--surface-hover);
    border: 1px solid var(--surface-border);
    border-radius: 8px;
    padding: 0.4rem 0.75rem 0.4rem 1rem;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 0.85rem;
    transition: all 0.2s ease;
  }

  .command-button:hover {
    border-color: color-mix(in srgb, var(--primary) 42%, var(--surface-border));
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 12%, transparent);
  }

  .command-button span {
    flex: 1;
    text-align: left;
  }

  .command-button kbd {
    font-size: 0.7rem;
    padding: 0.15rem 0.4rem;
    background: var(--surface-border);
    color: var(--text-main);
    border-radius: 4px;
    font-weight: 600;
    border: 1px solid rgba(0,0,0,0.05);
  }

  .user-menu {
    position: relative;
  }

  .approval-menu {
    position: relative;
  }

  .approval-button {
    min-height: 38px;
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    border: 1px solid var(--surface-border);
    border-radius: 999px;
    background: var(--surface-hover);
    color: var(--text-secondary);
    padding: 0.35rem 0.45rem 0.35rem 0.7rem;
    cursor: pointer;
    font-size: 0.8rem;
    font-weight: 800;
    transition: background 0.2s ease, color 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
  }

  .approval-button:hover {
    color: var(--text-main);
    border-color: color-mix(in srgb, var(--primary) 34%, var(--surface-border));
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 10%, transparent);
  }

  .approval-button strong {
    min-width: 22px;
    height: 22px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0 0.35rem;
    border-radius: 999px;
    background: var(--danger);
    color: white;
    font-size: 0.68rem;
    line-height: 1;
  }

  .approval-dropdown {
    position: absolute;
    top: 100%;
    right: 0;
    margin-top: 0.75rem;
    width: min(390px, calc(100vw - 2rem));
    background: var(--surface);
    color: var(--text-main);
    border-radius: 8px;
    border: 1px solid var(--surface-border);
    box-shadow: 0 18px 44px -24px rgba(0,0,0,0.45);
    overflow: hidden;
    z-index: 50;
    animation: dropdownFade 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  }

  .approval-dropdown-head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 0.75rem;
    padding: 0.95rem 1rem;
    border-bottom: 1px solid var(--surface-border);
    background: var(--header-bg);
    color: var(--primary);
  }

  .approval-dropdown-head div {
    min-width: 0;
    display: grid;
    gap: 0.25rem;
  }

  .approval-dropdown-head strong {
    color: var(--text-main);
    font-size: 0.9rem;
  }

  .approval-dropdown-head span {
    color: var(--text-muted);
    font-size: 0.76rem;
    line-height: 1.35;
  }

  .approval-list {
    max-height: 360px;
    overflow-y: auto;
    padding: 0.35rem;
  }

  .approval-row {
    display: grid;
    gap: 0.4rem;
    padding: 0.75rem;
    border-radius: 8px;
  }

  .approval-row + .approval-row {
    border-top: 1px solid var(--surface-border);
    border-radius: 0;
  }

  .approval-row-top,
  .approval-row-meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.6rem;
    min-width: 0;
  }

  .approval-row-top strong {
    color: var(--text-main);
    font-size: 0.82rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .approval-row-summary {
    color: var(--text-secondary);
    font-size: 0.78rem;
    line-height: 1.35;
    overflow-wrap: anywhere;
  }

  .approval-row-error {
    color: var(--danger);
    font-size: 0.75rem;
    line-height: 1.35;
  }

  .approval-row-meta {
    color: var(--text-muted);
    font-size: 0.7rem;
  }

  .approval-row-meta span {
    font-family: monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .approval-status {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 58px;
    padding: 0.18rem 0.45rem;
    border-radius: 999px;
    font-size: 0.68rem;
    font-weight: 800;
  }

  .approval-status.pending {
    background: rgba(245, 158, 11, 0.12);
    color: #d97706;
  }

  .approval-status.success {
    background: rgba(16, 185, 129, 0.1);
    color: var(--success);
  }

  .approval-status.danger {
    background: rgba(239, 68, 68, 0.1);
    color: var(--danger);
  }

  .approval-empty {
    min-height: 118px;
    display: grid;
    place-items: center;
    gap: 0.45rem;
    color: var(--text-muted);
    font-size: 0.82rem;
    text-align: center;
  }

  .approval-footer {
    width: 100%;
    min-height: 42px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.35rem;
    border: none;
    border-top: 1px solid var(--surface-border);
    background: transparent;
    color: var(--primary);
    font-weight: 800;
    cursor: pointer;
  }

  .approval-footer:hover {
    background: var(--surface-hover);
  }

  .avatar-button {
    gap: 0.55rem;
    padding: 0.25rem 0.35rem;
    border-radius: 999px;
    background: transparent;
    color: var(--text-main);
  }

  .avatar-circle {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    background: var(--surface-hover);
    border: 1px solid var(--surface-border);
    color: var(--text-secondary);
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    flex-shrink: 0;
  }

  .avatar-circle.large {
    width: 42px;
    height: 42px;
  }

  .avatar-meta,
  .dropdown-profile div {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .avatar-meta strong,
  .dropdown-profile strong {
    color: var(--text-main);
    font-size: 0.84rem;
    font-weight: 700;
    line-height: 1.2;
  }

  .avatar-meta span,
  .dropdown-profile span {
    color: var(--text-muted);
    font-size: 0.72rem;
    line-height: 1.2;
    text-transform: capitalize;
  }

  .avatar-chevron {
    color: var(--text-muted);
    transform: rotate(90deg);
    transition: transform 0.2s ease;
  }

  .avatar-chevron.open {
    transform: rotate(-90deg);
  }

  .dropdown-backdrop {
    position: fixed;
    inset: 0;
    z-index: 40;
  }

  .user-dropdown {
    position: absolute;
    top: 100%;
    right: 0;
    margin-top: 0.75rem;
    min-width: 230px;
    background: var(--surface);
    color: var(--text-main);
    border-radius: 8px;
    border: 1px solid var(--surface-border);
    box-shadow: 0 18px 44px -24px rgba(0,0,0,0.45);
    overflow: hidden;
    z-index: 50;
    animation: dropdownFade 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  }

  .dropdown-profile {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 1rem;
    border-bottom: 1px solid var(--surface-border);
    background: var(--header-bg);
  }

  .dropdown-actions {
    padding: 0.45rem;
  }

  .dropdown-item {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.65rem 0.75rem;
    background: transparent;
    color: var(--text-secondary);
    text-align: left;
    font-weight: 600;
    font-size: 0.85rem;
    border-radius: 6px;
  }

  .dropdown-item.text-danger:hover {
    background: color-mix(in srgb, var(--danger) 12%, transparent);
    color: var(--danger);
  }

  .dropdown-separator {
    height: 1px;
    background: var(--surface-border);
    margin: 0.45rem;
  }

  .app-sidebar {
    background: var(--surface);
    border-right: 1px solid var(--surface-border);
    color: var(--text-main);
    transition: width 0.24s cubic-bezier(0.2, 0.8, 0.2, 1);
    overflow: visible;
    flex-shrink: 0;
    z-index: 40;
    display: flex;
    flex-direction: column;
  }

  .sidebar-nav {
    flex: 1;
    overflow-y: auto;
    overflow-x: visible;
    padding: 1rem 0.65rem;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .sidebar-link {
    min-height: 44px;
    display: flex;
    align-items: center;
    gap: 0.85rem;
    padding: 0 0.72rem;
    border-radius: 8px;
    color: var(--text-secondary);
    text-decoration: none;
    font-size: 0.92rem;
    font-weight: 600;
    position: relative;
    white-space: nowrap;
    transition: background 0.2s ease, color 0.2s ease, transform 0.2s ease;
  }

  .sidebar-link:hover {
    background: var(--surface-hover);
    color: var(--text-main);
  }

  .sidebar-link.active {
    background: linear-gradient(90deg, color-mix(in srgb, var(--primary) 14%, transparent), transparent);
    color: var(--primary);
  }

  .sidebar-link.active .sidebar-icon {
    background: color-mix(in srgb, var(--primary) 13%, transparent);
    color: var(--primary);
    border-color: color-mix(in srgb, var(--primary) 24%, transparent);
  }

  .sidebar-active-bar {
    position: absolute;
    left: -0.65rem;
    top: 8px;
    bottom: 8px;
    width: 3px;
    border-radius: 0 999px 999px 0;
    background: linear-gradient(180deg, var(--primary), var(--primary-hover));
    opacity: 0;
    transform: scaleY(0.5);
    transition: opacity 0.2s ease, transform 0.2s ease;
  }

  .sidebar-link.active .sidebar-active-bar {
    opacity: 1;
    transform: scaleY(1);
  }

  .sidebar-icon {
    width: 30px;
    height: 30px;
    border: 1px solid transparent;
    border-radius: 7px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: background 0.2s ease, color 0.2s ease, border-color 0.2s ease;
  }

  .sidebar-label {
    overflow: hidden;
    text-overflow: ellipsis;
    transition: opacity 0.18s ease, transform 0.18s ease, width 0.18s ease;
  }

  .sidebar-chevron {
    margin-left: auto;
    opacity: 0.55;
  }

  .app-sidebar.collapsed .sidebar-link {
    justify-content: center;
    padding: 0;
  }

  .app-sidebar.collapsed .sidebar-label,
  .app-sidebar.collapsed .sidebar-chevron {
    width: 0;
    opacity: 0;
    transform: translateX(-6px);
    pointer-events: none;
  }

  .app-sidebar.collapsed .sidebar-active-bar {
    left: -0.65rem;
  }

  .sidebar-tooltip {
    position: absolute;
    left: calc(100% + 0.65rem);
    top: 50%;
    transform: translateY(-50%) translateX(-4px);
    min-height: 30px;
    display: inline-flex;
    align-items: center;
    padding: 0.35rem 0.6rem;
    border-radius: 6px;
    background: var(--surface);
    color: var(--text-main);
    border: 1px solid var(--surface-border);
    box-shadow: 0 14px 30px -18px rgba(0,0,0,0.55);
    font-size: 0.78rem;
    font-weight: 700;
    opacity: 0;
    pointer-events: none;
    white-space: nowrap;
    z-index: 70;
    transition: opacity 0.16s ease, transform 0.16s ease;
  }

  .app-sidebar.collapsed .sidebar-link:hover .sidebar-tooltip {
    opacity: 1;
    transform: translateY(-50%) translateX(0);
  }

  @keyframes dropdownFade {
    0% { opacity: 0; transform: translateY(-8px) scale(0.98); }
    100% { opacity: 1; transform: translateY(0) scale(1); }
  }

  @media (max-width: 980px) {
    .brand-lockup {
      width: auto;
    }

    .command-button {
      min-width: 44px;
      width: 44px;
      justify-content: center;
      padding: 0.5rem;
    }

    .command-button span,
    .command-button kbd,
    .avatar-meta {
      display: none;
    }
  }

  @media (max-width: 720px) {
    .app-header {
      padding: 0 0.85rem;
    }

    .header-divider {
      display: none;
    }

    .app-sidebar.expanded {
      width: 220px !important;
    }

    .app-sidebar.collapsed {
      width: 64px !important;
    }
  }
`;
