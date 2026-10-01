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
      className="hover-glass lang-switcher"
    >
      <Languages size={15} color="var(--primary)" />
      <span>{currentLang === "en" ? "EN" : "中文"}</span>
    </button>
  );
}
