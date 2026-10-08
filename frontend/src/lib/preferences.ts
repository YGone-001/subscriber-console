export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';
export type Locale = 'en' | 'zh';
export type DensityPreference = 'comfortable' | 'compact';

export const THEME_PREFERENCE_KEY = 'XCLOUD_THEME_PREFERENCE';
export const LANGUAGE_PREFERENCE_KEY = 'XCLOUD_LANGUAGE_PREFERENCE';
export const DENSITY_PREFERENCE_KEY = 'XCLOUD_DENSITY_PREFERENCE';

export function isThemePreference(value: string | null): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system';
}

export function isDensityPreference(value: string | null): value is DensityPreference {
  return value === 'comfortable' || value === 'compact';
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  if (preference === 'system') return systemDark ? 'dark' : 'light';
  return preference;
}

export function isLocale(value: string | null): value is Locale {
  return value === 'en' || value === 'zh';
}
