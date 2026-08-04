"use client";
import "./layout.css";

import { useState, useEffect } from "react";
import AppHeader from "./components/AppHeader";
import AppSidebar from "./components/AppSidebar";
import NavigationTabBar from "@/components/NavigationTabBar";
import NavigationBreadcrumbs from "@/components/NavigationBreadcrumbs";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(true);

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
