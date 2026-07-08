"use client";

import React, { createContext, useContext, useEffect, useState, useCallback } from "react";
import { LOCALES, Locale } from "@/lib/locales";

const STORAGE_KEY = "XCLOUD_LANGUAGE_PREFERENCE";

interface I18nContextType {
  lang: Locale;
  setLang: (lang: Locale) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextType | undefined>(undefined);

/**
 * I18nProvider
 * ------------------------------------------------------------------
 * Global context provider for managing the active locale (zh | en).
 * - Reads initial preference from localStorage on mount.
 * - Persists changes back to localStorage.
 * - Sets the `lang` attribute on <html> for accessibility / SEO.
 * - Exposes `t(key)` helper that returns the translated string.
 */
export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Locale>(() => {
    if (typeof window === "undefined") return "en";
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY) as Locale | null;
      return stored === "zh" || stored === "en" ? stored : "en";
    } catch {
      return "en";
    }
  });

  useEffect(() => {
    document.documentElement.setAttribute("lang", lang === "zh" ? "zh-CN" : "en");
  }, [lang]);

  const setLang = useCallback((newLang: Locale) => {
    setLangState(newLang);
    document.documentElement.setAttribute("lang", newLang === "zh" ? "zh-CN" : "en");
    try {
      localStorage.setItem(STORAGE_KEY, newLang);
    } catch {
      // Silently ignore write failures
    }
  }, []);

  const t = useCallback(
    (key: string, params?: Record<string, string | number>): string => {
      let str = LOCALES[lang]?.[key] ?? LOCALES["en"]?.[key] ?? key;
      if (params) {
        Object.keys(params).forEach(k => {
          str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(params[k]));
        });
      }
      return str;
    },
    [lang]
  );

  return (
    <I18nContext.Provider value={{ lang, setLang, t }}>
      {children}
    </I18nContext.Provider>
  );
}

/**
 * useI18n hook
 * Returns { lang, setLang, t } from the nearest I18nProvider.
 */
export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error("useI18n must be used within an I18nProvider");
  }
  return context;
}
