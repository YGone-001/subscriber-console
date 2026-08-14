"use client";

import React, { useSyncExternalStore } from "react";
import { Languages } from "lucide-react";
import { useI18n } from "./I18nProvider";

/**
 * LanguageSwitcher
 * ------------------------------------------------------------------
 * A compact toggle button for the header bar.
 * Cycles between "en" and "zh" on each click.
 * Shows a short locale label (EN / CN) with accessible attributes.
 */
export default function LanguageSwitcher() {
  const { lang, toggleLang, t } = useI18n();
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false
  );

  // Prevent hydration mismatch: force "en" state during server-side rendering
  const currentLang = mounted ? lang : "en";
  const nextLangLabel = currentLang === "en" ? t("lang_zh") : t("lang_en");

  return (
    <button
      id="lang-switcher-btn"
      onClick={toggleLang}
      title={`${t("lang_switch")}: ${nextLangLabel}`}
      aria-label={`${t("lang_switch")}: ${nextLangLabel}`}
      aria-live="polite"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.4rem",
        background: "var(--surface-hover)",
        border: "1px solid var(--surface-border)",
        borderRadius: "var(--ref-radius-pill)",
        padding: "0.3rem 0.75rem",
        color: "var(--text-secondary)",
        cursor: "pointer",
        transition: "all 0.2s cubic-bezier(0.4, 0, 0.2, 1)",
        fontSize: "var(--ref-font-size-label)",
        fontWeight: 600,
        letterSpacing: "0.03em",
      }}
      className="hover-glass"
    >
      <Languages size={15} color="var(--primary)" />
      <span>{currentLang === "en" ? "EN" : "中文"}</span>
    </button>
  );
}
