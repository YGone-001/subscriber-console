import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { isThemePreference, resolveTheme, THEME_PREFERENCE_KEY, type ResolvedTheme, type ThemePreference } from '../lib/preferences';

type ThemeContextValue = { preference: ThemePreference; resolvedTheme: ResolvedTheme; setPreference: (preference: ThemePreference) => void };
const ThemeContext = createContext<ThemeContextValue | null>(null);

function systemDark() { return window.matchMedia('(prefers-color-scheme: dark)').matches; }
function initialPreference(): ThemePreference {
  try { const value = localStorage.getItem(THEME_PREFERENCE_KEY); return isThemePreference(value) ? value : 'system'; } catch { return 'system'; }
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [preference, setPreference] = useState<ThemePreference>(initialPreference);
  const [dark, setDark] = useState(() => systemDark());
  const resolvedTheme = resolveTheme(preference, dark);
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const change = () => setDark(query.matches);
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  useEffect(() => { document.documentElement.dataset.theme = resolvedTheme; }, [resolvedTheme]);
  const value = useMemo<ThemeContextValue>(() => ({
    preference, resolvedTheme,
    setPreference(next) { try { localStorage.setItem(THEME_PREFERENCE_KEY, next); } catch { /* Preference persistence is optional. */ } setPreference(next); },
  }), [preference, resolvedTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() { const value = useContext(ThemeContext); if (!value) throw new Error('useTheme must be used within ThemeProvider'); return value; }
