"use client";
import './layout.css';

import { useState } from "react";
import AppHeader from "./components/AppHeader";
import AppSidebar from "./components/AppSidebar";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(true);

  return (
    <div className="layout-root">
      <AppHeader sidebarOpen={sidebarOpen} setSidebarOpen={setSidebarOpen} />
      <div className="layout-body">
        <AppSidebar sidebarOpen={sidebarOpen} setSidebarOpen={setSidebarOpen} />
        <main className="layout-main">
          {children}
        </main>
      </div>
    </div>
  );
}
