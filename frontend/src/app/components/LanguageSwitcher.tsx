import { Languages } from 'lucide-react';
import { useI18n } from '../../providers/I18nProvider';

/** Restored header language control. Uses the current i18n provider authority. */
export function LanguageSwitcher() {
  const { t, locale, setLocale } = useI18n();
  const next = locale === 'en' ? 'zh' : 'en';
  return (
    <button
      type="button"
      id="lang-switcher-btn"
      className="hover-glass lang-switcher"
      onClick={() => setLocale(next)}
      title={`${t('language')}: ${next === 'zh' ? '中文' : 'English'}`}
      aria-label={`${t('language')}: ${next === 'zh' ? '中文' : 'English'}`}
      aria-live="polite"
    >
      <Languages size={15} color="var(--primary)" />
      <span>{locale === 'en' ? 'EN' : '中文'}</span>
    </button>
  );
}
