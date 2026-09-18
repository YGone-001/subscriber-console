"use client";
import "./layout.css";

import { useState, useEffect, useSyncExternalStore } from "react";
import { usePathname, useRouter } from "next/navigation";
import AppHeader from "./components/AppHeader";
import AppSidebar from "./components/AppSidebar";
import NavigationTabBar from "@/components/NavigationTabBar";
import NavigationBreadcrumbs from "@/components/NavigationBreadcrumbs";
import { useI18n } from "@/components/I18nProvider";
import { useAuth } from "@/hooks/useAuth";
import { canAccessNavigationRoute, resolveNavigationRoute } from "@/lib/navigationRoutes";

const DESKTOP_SHELL_QUERY = "(min-width: 981px)";

function subscribeToShellBreakpoint(onStoreChange: () => void) {
  const mediaQuery = window.matchMedia(DESKTOP_SHELL_QUERY);
  mediaQuery.addEventListener("change", onStoreChange);
  return () => mediaQuery.removeEventListener("change", onStoreChange);
}

function getMobileShellSnapshot() {
  return !window.matchMedia(DESKTOP_SHELL_QUERY).matches;
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const isMobileShell = useSyncExternalStore(subscribeToShellBreakpoint, getMobileShellSnapshot, () => false);
  const { t } = useI18n();
  const pathname = usePathname();
  const router = useRouter();
  const { user, isLoading: isAuthLoading } = useAuth();

  useEffect(() => {
    if (isAuthLoading || !user || !pathname) return;
    const route = resolveNavigationRoute(pathname);
    if (route && !canAccessNavigationRoute(route, user.role)) router.replace("/");
  }, [isAuthLoading, pathname, router, user]);

  useEffect(() => {
    const animationFrame = window.requestAnimationFrame(() => setSidebarOpen(!isMobileShell));
    return () => window.cancelAnimationFrame(animationFrame);
  }, [isMobileShell]);

  useEffect(() => {
    if (!isMobileShell || !sidebarOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSidebarOpen(false);
    };
    window.addEventListener("keydown", handleEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleEscape);
    };
  }, [isMobileShell, sidebarOpen]);

  // Global Ctrl+B shortcut to toggle sidebar
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
        const target = e.target as HTMLElement;
        if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
          return;
        }
        e.preventDefault();
        setSidebarOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <div className="layout-root">
      <AppHeader sidebarOpen={sidebarOpen} setSidebarOpen={setSidebarOpen} />
      <div className="layout-body">
        {sidebarOpen ? (
          <button
            type="button"
            className="sidebar-mobile-backdrop"
            onClick={() => setSidebarOpen(false)}
            aria-label={t("sidebar_collapse")}
          />
        ) : null}
        <AppSidebar sidebarOpen={sidebarOpen} setSidebarOpen={setSidebarOpen} isMobileShell={isMobileShell} />
        <div className="layout-content-area">
          <NavigationTabBar />
          <NavigationBreadcrumbs />
          <main className="layout-main">{children}</main>
        </div>
      </div>
    </div>
  );
}
