import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { dictionaries } from '../lib/locales';
import { isLocale, LANGUAGE_PREFERENCE_KEY, type Locale } from '../lib/preferences';

type I18nContextValue = { locale: Locale; setLocale: (locale: Locale) => void; t: (key: string, values?: Record<string, string | number>) => string };
const I18nContext = createContext<I18nContextValue | null>(null);
function initialLocale(): Locale { try { const value = localStorage.getItem(LANGUAGE_PREFERENCE_KEY); return isLocale(value) ? value : 'en'; } catch { return 'en'; } }

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  useEffect(() => { document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en'; }, [locale]);
  const value = useMemo<I18nContextValue>(() => ({
    locale,
    setLocale(next) { try { localStorage.setItem(LANGUAGE_PREFERENCE_KEY, next); } catch { /* Preference persistence is optional. */ } setLocaleState(next); },
    t(key, values) {
      let text = dictionaries[locale][key] ?? dictionaries.en[key] ?? key;
      for (const [name, value] of Object.entries(values ?? {})) text = text.replace(`{${name}}`, String(value));
      return text;
    },
  }), [locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
export function useI18n() { const value = useContext(I18nContext); if (!value) throw new Error('useI18n must be used within I18nProvider'); return value; }
