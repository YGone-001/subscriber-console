import { Moon, Sun } from 'lucide-react';
import { useI18n } from '../../providers/I18nProvider';
import { useTheme } from '../../providers/ThemeProvider';

/**
 * Restored header theme control. Cycles the current ThemeProvider preference
 * between light and dark; the system preference remains reachable from the
 * command palette.
 */
export function ThemeSwitcher() {
  const { t } = useI18n();
  const { resolvedTheme, setPreference } = useTheme();
  const next = resolvedTheme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      className="theme-switcher-btn hover-glass"
      onClick={() => setPreference(next)}
      title={`${t('theme')}: ${t(next)}`}
      aria-label={`${t('theme')}: ${t(next)}`}
    >
      {resolvedTheme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  );
}
