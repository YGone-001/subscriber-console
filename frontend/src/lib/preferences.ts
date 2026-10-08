export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';
export type Locale = 'en' | 'zh';

export const THEME_PREFERENCE_KEY = 'XCLOUD_THEME_PREFERENCE';
export const LANGUAGE_PREFERENCE_KEY = 'XCLOUD_LANGUAGE_PREFERENCE';

export function isThemePreference(value: string | null): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system';
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  if (preference === 'system') return systemDark ? 'dark' : 'light';
  return preference;
}

export function isLocale(value: string | null): value is Locale {
  return value === 'en' || value === 'zh';
}
