import type { ReactNode } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { useI18n } from '../../providers/I18nProvider';
import { useTheme } from '../../providers/ThemeProvider';
import type { ThemePreference } from '../../lib/preferences';

/*
 * Three-state theme control.
 *
 * The header used to expose a single button that cycled light <-> dark, which left the
 * "follow the system" preference reachable only from the command palette. Operators often
 * run terminals that are already pinned to a theme, so following the system is a
 * first-class choice and is offered directly here.
 *
 * The control reports the stored PREFERENCE, not the resolved theme: with "follow system"
 * selected, the highlighted segment stays on "system" even as the resolved theme flips.
 */
export function ThemeSwitcher() {
  const { t } = useI18n();
  const { preference, setPreference } = useTheme();

  const options: { value: ThemePreference; icon: ReactNode; label: string }[] = [
    { value: 'light', icon: <Sun size={16} />, label: t('theme_switch_light') },
    { value: 'dark', icon: <Moon size={16} />, label: t('theme_switch_dark') },
    { value: 'system', icon: <Monitor size={16} />, label: t('theme_switch_system') },
  ];

  return (
    <div className="theme-switcher" role="group" aria-label={t('theme')}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="theme-switcher-btn"
          data-active={preference === option.value || undefined}
          aria-pressed={preference === option.value}
          title={option.label}
          aria-label={option.label}
          onClick={() => setPreference(option.value)}
        >
          {option.icon}
        </button>
      ))}
    </div>
  );
}
