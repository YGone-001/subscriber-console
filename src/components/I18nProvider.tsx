"use client";

import React, { createContext, useContext, useEffect, useSyncExternalStore, useCallback, useMemo } from "react";
import { LOCALES, Locale, DEFAULT_LOCALE, SUPPORTED_LOCALES } from "@/lib/locales";

const STORAGE_KEY = "XCLOUD_LANGUAGE_PREFERENCE";
const LANGUAGE_CHANGE_EVENT = "xcloud-language-change";

export interface I18nContextType {
  lang: Locale;
  setLang: (lang: Locale) => void;
  toggleLang: () => void;
  t: (key: string, params?: Record<string, string | number>, count?: number) => string;
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
  formatDateTime: (value: Date | string | number, options?: Intl.DateTimeFormatOptions) => string;
  formatRelativeTime: (value: Date | string | number) => string;
  formatCurrency: (amount: number, currency?: string) => string;
  formatBytes: (bytes: number) => string;
  isZh: boolean;
  isEn: boolean;
  dir: "ltr";
}

const I18nContext = createContext<I18nContextType | undefined>(undefined);

function isLocale(value: unknown): value is Locale {
  return value === "zh" || value === "en";
}

function readStoredLang(): Locale {
  if (typeof window === "undefined") return DEFAULT_LOCALE;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (isLocale(stored)) return stored;
    // Auto-detect browser language preference
    const browserLang = window.navigator?.language?.toLowerCase() || "";
    if (browserLang.startsWith("zh")) return "zh";
    return DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

function readServerLang(): Locale {
  return DEFAULT_LOCALE;
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
  const meta = SUPPORTED_LOCALES.find(m => m.code === lang);
  document.documentElement.setAttribute("lang", meta ? meta.htmlLang : (lang === "zh" ? "zh-CN" : "en"));
}

/**
 * I18nProvider
 * ------------------------------------------------------------------
 * Global context provider for managing active locale (zh | en).
 * - Reads preference from localStorage or auto-detects browser locale.
 * - Sets the `lang` attribute on <html> for accessibility & SEO.
 * - Provides translation function `t(key, params, count)` with pluralization and interpolation.
 * - Provides localized formatters: `formatNumber`, `formatDateTime`, `formatRelativeTime`, `formatBytes`.
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

  const toggleLang = useCallback(() => {
    setLang(lang === "en" ? "zh" : "en");
  }, [lang, setLang]);

  const t = useCallback(
    (key: string, params?: Record<string, string | number>, count?: number): string => {
      let resolvedKey = key;
      const combinedParams = { ...(params || {}) };

      // Handle pluralization if count is provided
      if (typeof count === "number") {
        combinedParams.count = count;
        const pluralSuffix = count === 0 ? "_zero" : count === 1 ? "_one" : "_other";
        const candidateKey = `${key}${pluralSuffix}`;
        if (LOCALES[lang]?.[candidateKey] || LOCALES["en"]?.[candidateKey]) {
          resolvedKey = candidateKey;
        }
      }

      let str = LOCALES[lang]?.[resolvedKey] ?? LOCALES["en"]?.[resolvedKey] ?? resolvedKey;
      if (combinedParams) {
        Object.keys(combinedParams).forEach(k => {
          str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(combinedParams[k]));
        });
      }
      return str;
    },
    [lang]
  );

  const intlLocale = useMemo(() => (lang === "zh" ? "zh-CN" : "en-US"), [lang]);

  const formatNumber = useCallback(
    (value: number, options?: Intl.NumberFormatOptions): string => {
      if (typeof value !== "number" || isNaN(value)) return "0";
      try {
        return new Intl.NumberFormat(intlLocale, options).format(value);
      } catch {
        return String(value);
      }
    },
    [intlLocale]
  );

  const formatDateTime = useCallback(
    (value: Date | string | number, options?: Intl.DateTimeFormatOptions): string => {
      if (!value) return "—";
      const date = value instanceof Date ? value : new Date(value);
      if (isNaN(date.getTime())) return "—";
      try {
        const defaultOptions: Intl.DateTimeFormatOptions = options || {
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        };
        return new Intl.DateTimeFormat(intlLocale, defaultOptions).format(date);
      } catch {
        return date.toLocaleString();
      }
    },
    [intlLocale]
  );

  const formatRelativeTime = useCallback(
    (value: Date | string | number): string => {
      if (!value) return "—";
      const date = value instanceof Date ? value : new Date(value);
      if (isNaN(date.getTime())) return "—";
      
      const now = Date.now();
      const diffMs = now - date.getTime();
      const diffSecs = Math.floor(diffMs / 1000);
      const diffMins = Math.floor(diffSecs / 60);
      const diffHours = Math.floor(diffMins / 60);
      const diffDays = Math.floor(diffHours / 24);

      if (diffSecs < 45) {
        return t("time_just_now");
      }
      if (diffMins < 60) {
        return t("time_mins_ago", { count: diffMins });
      }
      if (diffHours < 24) {
        return t("time_hours_ago", { count: diffHours });
      }
      if (diffDays === 1) {
        return t("time_yesterday");
      }
      if (diffDays < 30) {
        return t("time_days_ago", { count: diffDays });
      }
      return formatDateTime(date, { year: "numeric", month: "short", day: "numeric" });
    },
    [t, formatDateTime]
  );

  const formatCurrency = useCallback(
    (amount: number, currency = "USD"): string => {
      return formatNumber(amount, {
        style: "currency",
        currency,
        maximumFractionDigits: 2,
      });
    },
    [formatNumber]
  );

  const formatBytes = useCallback(
    (bytes: number): string => {
      if (!bytes || bytes === 0) return "0 B";
      const k = 1024;
      const sizes = ["B", "KB", "MB", "GB", "TB"];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      if (i === 0) return `${bytes} B`;
      const val = parseFloat((bytes / Math.pow(k, i)).toFixed(2));
      return `${formatNumber(val)} ${sizes[i]}`;
    },
    [formatNumber]
  );

  const isZh = lang === "zh";
  const isEn = lang === "en";

  const contextValue = useMemo<I18nContextType>(
    () => ({
      lang,
      setLang,
      toggleLang,
      t,
      formatNumber,
      formatDateTime,
      formatRelativeTime,
      formatCurrency,
      formatBytes,
      isZh,
      isEn,
      dir: "ltr",
    }),
    [lang, setLang, toggleLang, t, formatNumber, formatDateTime, formatRelativeTime, formatCurrency, formatBytes, isZh, isEn]
  );

  return (
    <I18nContext.Provider value={contextValue}>
      {children}
    </I18nContext.Provider>
  );
}

/**
 * useI18n hook
 * Returns { lang, setLang, toggleLang, t, formatNumber, formatDateTime, formatRelativeTime, formatCurrency, formatBytes, isZh, isEn }
 */
export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error("useI18n must be used within an I18nProvider");
  }
  return context;
}
