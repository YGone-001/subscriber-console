import { Languages } from 'lucide-react';
import { useI18n } from '../../providers/I18nProvider';
import { SUPPORTED_LOCALES } from '../../lib/locales';

/** Restored header language control. Uses the current i18n provider authority. */
export function LanguageSwitcher() {
  const { t, locale, setLocale } = useI18n();
  const next = locale === 'en' ? 'zh' : 'en';
  const nextLocale = SUPPORTED_LOCALES.find((item) => item.code === next)!;
  const currentLocale = SUPPORTED_LOCALES.find((item) => item.code === locale)!;
  return (
    <button
      type="button"
      id="lang-switcher-btn"
      className="hover-glass lang-switcher"
      onClick={() => setLocale(next)}
      title={`${t('language')}: ${nextLocale.nativeName}`}
      aria-label={`${t('language')}: ${nextLocale.nativeName}`}
      aria-live="polite"
    >
      <Languages size={15} color="var(--primary)" />
      <span>{currentLocale.code === 'en' ? 'EN' : currentLocale.nativeName}</span>
    </button>
  );
}
