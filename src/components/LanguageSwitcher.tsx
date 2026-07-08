"use client";

import React, { useSyncExternalStore } from "react";
import { Languages } from "lucide-react";
import { useI18n } from "./I18nProvider";

/**
 * LanguageSwitcher
 * ------------------------------------------------------------------
 * A compact toggle button for the header bar.
 * Cycles between "en" and "zh" on each click.
 * Shows a short locale label (EN / CN) next to the Languages icon.
 */
export default function LanguageSwitcher() {
  const { lang, setLang } = useI18n();
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false
  );

  const toggleLang = () => {
    setLang(lang === "en" ? "zh" : "en");
  };

  // Prevent hydration mismatch: force "en" state during server-side rendering
  const currentLang = mounted ? lang : "en";

  return (
    <button
      onClick={toggleLang}
      title={currentLang === "en" ? "Switch to Chinese" : "Switch to English"}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.35rem",
        background: "var(--surface-hover)",
        border: "1px solid var(--surface-border)",
        borderRadius: "18px",
        padding: "0.3rem 0.7rem",
        color: "var(--text-secondary)",
        cursor: "pointer",
        transition: "all 0.2s ease",
        fontSize: "0.75rem",
        fontWeight: 600,
        letterSpacing: "0.03em",
      }}
      className="hover-glass"
    >
      <Languages size={16} />
      <span>{currentLang === "en" ? "EN" : "CN"}</span>
    </button>
  );
}
