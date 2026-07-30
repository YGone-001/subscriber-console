"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { User, ChevronRight, Settings, HelpCircle, LogOut } from "lucide-react";
import { useI18n } from "@/components/I18nProvider";
import { useAuth } from "@/hooks/useAuth";

export default function UserMenu() {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const router = useRouter();
  const { t } = useI18n();
  const { user, isRoot } = useAuth();

  const displayName = user?.username || "xCloud";
  const roleLabel = user?.role || "viewer";

  const handleLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    router.refresh();
    router.push("/login");
  };

  const handleProfileSettings = () => {
    setDropdownOpen(false);
    if (isRoot) {
      router.push("/users");
    } else {
      router.push("/profile");
    }
  };

  const handleHelp = () => {
    setDropdownOpen(false);
    router.push("/system-health");
  };

  return (
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
  );
}
