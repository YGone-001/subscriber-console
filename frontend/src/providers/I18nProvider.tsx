/*
 * Internationalisation provider.
 *
 * Forward-ported from the historical xCloud UI (reference commit 2c40903):
 * frontend/src/components/I18nProvider.tsx
 *
 * Restored behaviour: the locale falls back to the browser language rather than a
 * hard-coded `en`, and the provider exposes the reference formatting helpers
 * (absolute and relative time), which the business surfaces need for timestamps.
 *
 * The earlier local API (`locale` / `setLocale`) is preserved alongside the
 * reference naming (`lang` / `setLang` / `toggleLang`) so existing call sites keep
 * working unchanged.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { DEFAULT_LOCALE, LOCALES, SUPPORTED_LOCALES } from '../lib/locales';
import { isLocale, LANGUAGE_PREFERENCE_KEY, type Locale } from '../lib/preferences';

type I18nContextValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  lang: Locale;
  setLang: (locale: Locale) => void;
  toggleLang: () => void;
  t: (key: string, values?: Record<string, string | number>) => string;
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
  formatDateTime: (value: Date | string | number, options?: Intl.DateTimeFormatOptions) => string;
  formatRelativeTime: (value: Date | string | number) => string;
  isZh: boolean;
  isEn: boolean;
  dir: 'ltr';
};

const I18nContext = createContext<I18nContextValue | null>(null);

const INTL_LOCALE: Record<Locale, string> = {
  en: SUPPORTED_LOCALES.find((meta) => meta.code === 'en')?.intlLocale ?? 'en-US',
  zh: SUPPORTED_LOCALES.find((meta) => meta.code === 'zh')?.intlLocale ?? 'zh-CN',
};

/**
 * Stored preference wins; otherwise follow the browser language so a zh-CN
 * operator lands on the Chinese surface, matching the reference behaviour.
 */
function initialLocale(): Locale {
  try {
    const stored = localStorage.getItem(LANGUAGE_PREFERENCE_KEY);
    if (isLocale(stored)) return stored;
    const browserLang = window.navigator?.language?.toLowerCase() ?? '';
    if (browserLang.startsWith('zh')) return 'zh';
    return DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  useEffect(() => { document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en'; }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    try { localStorage.setItem(LANGUAGE_PREFERENCE_KEY, next); } catch { /* Preference persistence is optional. */ }
    setLocaleState(next);
  }, []);

  const value = useMemo<I18nContextValue>(() => {
    const intlLocale = INTL_LOCALE[locale];

    const t = (key: string, values?: Record<string, string | number>) => {
      let text = LOCALES[locale][key] ?? LOCALES.en[key] ?? key;
      for (const [name, value] of Object.entries(values ?? {})) text = text.replace(`{${name}}`, String(value));
      return text;
    };

    const formatNumber = (input: number, options?: Intl.NumberFormatOptions) => {
      if (typeof input !== 'number' || Number.isNaN(input)) return '0';
      try { return new Intl.NumberFormat(intlLocale, options).format(input); } catch { return String(input); }
    };

    const formatDateTime = (input: Date | string | number, options?: Intl.DateTimeFormatOptions) => {
      if (!input) return '—';
      const date = input instanceof Date ? input : new Date(input);
      if (Number.isNaN(date.getTime())) return '—';
      try {
        return new Intl.DateTimeFormat(intlLocale, options ?? {
          year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
        }).format(date);
      } catch {
        return date.toLocaleString();
      }
    };

    const formatRelativeTime = (input: Date | string | number) => {
      if (!input) return '—';
      const date = input instanceof Date ? input : new Date(input);
      if (Number.isNaN(date.getTime())) return '—';

      const diffSecs = Math.floor((Date.now() - date.getTime()) / 1000);
      const diffMins = Math.floor(diffSecs / 60);
      const diffHours = Math.floor(diffMins / 60);
      const diffDays = Math.floor(diffHours / 24);

      if (diffSecs < 45) return t('time_just_now');
      if (diffMins < 60) return t('time_mins_ago', { count: diffMins });
      if (diffHours < 24) return t('time_hours_ago', { count: diffHours });
      if (diffDays === 1) return t('time_yesterday');
      if (diffDays < 30) return t('time_days_ago', { count: diffDays });
      return formatDateTime(date, { year: 'numeric', month: 'short', day: 'numeric' });
    };

    return {
      locale,
      setLocale,
      lang: locale,
      setLang: setLocale,
      toggleLang: () => setLocale(locale === 'en' ? 'zh' : 'en'),
      t,
      formatNumber,
      formatDateTime,
      formatRelativeTime,
      isZh: locale === 'zh',
      isEn: locale === 'en',
      dir: 'ltr' as const,
    };
  }, [locale, setLocale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n must be used within I18nProvider');
  return value;
}
