"use client";

import { useState, useEffect } from "react";
import Image from "next/image";
import { Menu, Command } from "lucide-react";
import { useI18n } from "@/components/I18nProvider";
import NocSentinel from "@/components/NocSentinel";
import CommandPalette from "@/components/CommandPalette";
import ThemeSwitcher from "@/components/ThemeSwitcher";
import LanguageSwitcher from "@/components/LanguageSwitcher";
import ApprovalMenu from "./ApprovalMenu";
import NotificationCenter from "./NotificationCenter";
import UserMenu from "./UserMenu";

interface AppHeaderProps {
  sidebarOpen: boolean;
  setSidebarOpen: React.Dispatch<React.SetStateAction<boolean>>;
}

export default function AppHeader({ sidebarOpen, setSidebarOpen }: AppHeaderProps) {
  const { t } = useI18n();
  const [cmdPaletteOpen, setCmdPaletteOpen] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        setCmdPaletteOpen((prev) => !prev);
      }
      if (e.key === "Escape") {
        setCmdPaletteOpen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return (
    <>
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

          <button
            type="button"
            className="icon-button"
            onClick={() => setSidebarOpen((open) => !open)}
            title={sidebarOpen ? t("sidebar_collapse_hint") : t("sidebar_expand_hint")}
            aria-label={sidebarOpen ? t("sidebar_collapse") : t("sidebar_expand_hint")}
            aria-controls="xcloud-primary-sidebar"
            aria-expanded={sidebarOpen}
          >
            <Menu size={22} />
          </button>

          <button type="button" className="command-button" onClick={() => setCmdPaletteOpen(true)} title={t("cmd_palette_title")}>
            <Command size={14} />
            <span>{t("search_placeholder")}</span>
            <kbd>Ctrl K</kbd>
          </button>
        </div>

        <div className="header-right">
          <NocSentinel />
          <ApprovalMenu />
          <NotificationCenter />
          <LanguageSwitcher />
          <ThemeSwitcher />
          <div className="header-divider" />
          <UserMenu />
        </div>
      </header>
    </>
  );
}
