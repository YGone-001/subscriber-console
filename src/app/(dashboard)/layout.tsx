"use client";
import "./layout.css";

import { useState, useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import AppHeader from "./components/AppHeader";
import AppSidebar from "./components/AppSidebar";
import NavigationTabBar from "@/components/NavigationTabBar";
import NavigationBreadcrumbs from "@/components/NavigationBreadcrumbs";
import { useI18n } from "@/components/I18nProvider";
import { useAuth } from "@/hooks/useAuth";
import { canAccessNavigationRoute, resolveNavigationRoute } from "@/lib/navigationRoutes";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
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
    const mediaQuery = window.matchMedia("(min-width: 981px)");
    const syncSidebar = (matches: boolean) => setSidebarOpen(matches);
    const animationFrame = window.requestAnimationFrame(() => syncSidebar(mediaQuery.matches));
    const handleChange = (event: MediaQueryListEvent) => syncSidebar(event.matches);
    mediaQuery.addEventListener("change", handleChange);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      mediaQuery.removeEventListener("change", handleChange);
    };
  }, []);

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
        <AppSidebar sidebarOpen={sidebarOpen} setSidebarOpen={setSidebarOpen} />
        <div className="layout-content-area">
          <NavigationTabBar />
          <NavigationBreadcrumbs />
          <main className="layout-main">{children}</main>
        </div>
      </div>
    </div>
  );
}
