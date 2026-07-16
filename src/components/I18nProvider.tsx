"use client";

import React, { createContext, useContext, useEffect, useSyncExternalStore, useCallback } from "react";
import { LOCALES, Locale } from "@/lib/locales";

const STORAGE_KEY = "XCLOUD_LANGUAGE_PREFERENCE";
const LANGUAGE_CHANGE_EVENT = "xcloud-language-change";

interface I18nContextType {
  lang: Locale;
  setLang: (lang: Locale) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextType | undefined>(undefined);

function isLocale(value: unknown): value is Locale {
  return value === "zh" || value === "en";
}

function readStoredLang(): Locale {
  if (typeof window === "undefined") return "en";
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isLocale(stored) ? stored : "en";
  } catch {
    return "en";
  }
}

function readServerLang(): Locale {
  return "en";
}

function subscribeLang(listener: () => void) {
  if (typeof window === "undefined") return () => {};

  const handleChange = (event: Event) => {
    if (event.type === LANGUAGE_CHANGE_EVENT || (event instanceof StorageEvent && event.key === STORAGE_KEY)) {
      listener();
    }
  };

  window.addEventListener("storage", handleChange);
  window.addEventListener(LANGUAGE_CHANGE_EVENT, handleChange);
  return () => {
    window.removeEventListener("storage", handleChange);
    window.removeEventListener(LANGUAGE_CHANGE_EVENT, handleChange);
  };
}

function applyLanguage(lang: Locale) {
  document.documentElement.setAttribute("lang", lang === "zh" ? "zh-CN" : "en");
}

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
  const lang = useSyncExternalStore(subscribeLang, readStoredLang, readServerLang);

  useEffect(() => {
    applyLanguage(lang);
  }, [lang]);

  const setLang = useCallback((newLang: Locale) => {
    applyLanguage(newLang);
    try {
      localStorage.setItem(STORAGE_KEY, newLang);
      window.dispatchEvent(new Event(LANGUAGE_CHANGE_EVENT));
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
